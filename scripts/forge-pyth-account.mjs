#!/usr/bin/env node
//
// forge-pyth-account.mjs — build a byte-exact Pyth `PriceUpdateV2` account and
// write it as a `solana-test-validator --account` genesis fixture JSON.
//
// This lets settle_market run on a vanilla localnet, which has no real Pyth
// Receiver program. The injected account carries an arbitrary `owner` (set to
// the operator's pyth_receiver, exactly what settle_market's manual owner
// check requires) and our forged price data. The byte layout mirrors the
// vendored type in programs/meridian/src/state/pyth.rs:
//
//   [0..8]    Anchor discriminator = sha256("account:PriceUpdateV2")[0..8]
//   [8..40]   write_authority: Pubkey            (we zero it; unused by settle)
//   [40]      verification_level: Borsh enum tag (1 = Full → single byte)
//   price_message: PriceFeedMessage
//     feed_id: [u8;32]
//     price: i64  conf: u64  exponent: i32
//     publish_time: i64  prev_publish_time: i64
//     ema_price: i64  ema_conf: u64
//   posted_slot: u64
//
// Usage:
//   node forge-pyth-account.mjs \
//     --owner <pyth_receiver pubkey> \
//     [--dollars 700] [--expo -8] [--conf 1000] \
//     [--feed-id <64 hex>] [--publish-time <unix>] \
//     --out /tmp/pyth-oracle.json \
//     --keypair-out /tmp/pyth-oracle-keypair.json
//
// Prints the oracle account address to stdout (last line) for the caller.

import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";

import { Keypair, PublicKey } from "@solana/web3.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.replace(/^--/, "");
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = val;
  }
  return out;
}
const args = parseArgs(process.argv);

const OWNER = args.owner;
if (!OWNER) {
  console.error("error: --owner <pyth_receiver pubkey> is required");
  process.exit(2);
}
const OUT = args.out;
if (!OUT) {
  console.error("error: --out <path> is required");
  process.exit(2);
}
const KEYPAIR_OUT = args["keypair-out"];

const DOLLARS = args.dollars != null ? Number(args.dollars) : 700;
const EXPO = args.expo != null ? Number(args.expo) : -8;
const CONF = BigInt(args.conf ?? "1000");
const FEED_HEX = args["feed-id"] ?? "01".repeat(32);
// publish_time defaults to "now". The validator clock must be >= this at
// settle time and within MAX_AGE_SECONDS (60). Caller should boot + settle
// promptly after forging.
const PUBLISH_TIME = BigInt(args["publish-time"] ?? Math.floor(Date.now() / 1000));

// price = dollars * 10^(-EXPO). For EXPO=-8, $700 -> 70_000_000_000.
const PRICE = BigInt(DOLLARS) * 10n ** BigInt(-EXPO);

const feedId = Buffer.from(FEED_HEX, "hex");
if (feedId.length !== 32) {
  console.error(`error: --feed-id must be 32 bytes (64 hex), got ${feedId.length}`);
  process.exit(2);
}

// Anchor account discriminator: first 8 bytes of sha256("account:<Name>").
const disc = crypto.createHash("sha256").update("account:PriceUpdateV2").digest().subarray(0, 8);

// ─── serialize ───────────────────────────────────────────────────────────

function i64(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}
function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}
function i32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(Number(n), 0);
  return b;
}

const writeAuthority = Buffer.alloc(32, 0); // unused by settle_market
const verificationLevel = Buffer.from([1]); // 1 = Full (single Borsh tag byte)

const priceMessage = Buffer.concat([
  feedId, // feed_id
  i64(PRICE), // price
  u64(CONF), // conf
  i32(EXPO), // exponent
  i64(PUBLISH_TIME), // publish_time
  i64(PUBLISH_TIME), // prev_publish_time (same is fine)
  i64(PRICE), // ema_price
  u64(CONF), // ema_conf
]);
const postedSlot = u64(0);

const data = Buffer.concat([disc, writeAuthority, verificationLevel, priceMessage, postedSlot]);

// ─── oracle account address ────────────────────────────────────────────────

let oracle;
if (KEYPAIR_OUT && fs.existsSync(KEYPAIR_OUT)) {
  oracle = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_OUT, "utf8"))));
} else {
  oracle = Keypair.generate();
  if (KEYPAIR_OUT) fs.writeFileSync(KEYPAIR_OUT, JSON.stringify(Array.from(oracle.secretKey)));
}

// ─── genesis fixture JSON (solana account --output json shape) ──────────────

const fixture = {
  pubkey: oracle.publicKey.toBase58(),
  account: {
    lamports: 2_000_000, // > rent-exempt for ~133 bytes
    data: [data.toString("base64"), "base64"],
    owner: new PublicKey(OWNER).toBase58(),
    executable: false,
    rentEpoch: 0,
    space: data.length,
  },
};
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2));

console.error(`forged PriceUpdateV2 (${data.length} bytes)`);
console.error(`  owner          ${fixture.account.owner}`);
console.error(`  feed_id        ${FEED_HEX}`);
console.error(`  price/expo     ${PRICE} / ${EXPO}  (~$${DOLLARS})`);
console.error(`  conf           ${CONF}`);
console.error(`  publish_time   ${PUBLISH_TIME}`);
console.error(`  discriminator  ${disc.toString("hex")}`);
console.error(`  fixture        ${OUT}`);
// Last stdout line = the address, for shell capture.
console.log(oracle.publicKey.toBase58());
