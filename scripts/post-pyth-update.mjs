#!/usr/bin/env node
//
// post-pyth-update.mjs — REAL Pyth pull-oracle settlement on devnet (U2).
//
// Unlike forge-pyth-account.mjs / settle-redeem-demo.mjs (which inject a FORGED
// PriceUpdateV2 at localnet genesis), this script does the real thing:
//
//   1. Fetch the latest price update for a market's `pyth_feed_id` from Hermes
//      (`@pythnetwork/hermes-client`).
//   2. Post it on-chain through the canonical Pyth Solana receiver
//      (`@pythnetwork/pyth-solana-receiver`), which creates a receiver-owned
//      `PriceUpdateV2` account.
//   3. Call `settle_market` referencing that account → the program reads the
//      Wormhole-verified price, checks freshness against the widened
//      `[expiry, expiry + SETTLE_WINDOW_SECONDS]` window (SETTLE_WINDOW_SECONDS
//      = 900s / 15min, see programs/meridian/src/instructions/settle_market.rs),
//      and stamps the outcome.
//
// This mirrors the shared helper at automation/src/pyth.ts
// (fetchLatestPriceUpdate / postPriceUpdate / fetchAndPostLatest) but as a
// focused, dependency-light .mjs script that matches the repo's scripts/
// convention.
//
// ── MARKET HOURS ────────────────────────────────────────────────────────────
// Pyth equity feeds (Equity.US.<TICKER>/USD) are only FRESH during US regular
// trading hours (9:30AM–4PM ET, weekdays). Off-hours the latest Hermes update
// is stale: its publish_time is the last RTH tick, which will be far outside
// the post-expiry settlement window → settle_market rejects with OracleStale.
// When that happens, this script prints a clear message and exits non-zero so
// the operator falls back to the admin-override path:
//
//     admin_settle_market  (after the 24h emergency grace; admin-signed; the
//                            operator supplies the settlement outcome)
//
// admin_settle_market is UNCHANGED by U2 — it remains the documented fallback
// (PRD §"Admin Settle (Override)"). See docs/DEVNET-RUNBOOK.md.
//
// ── PRECONDITIONS ─────────────────────────────────────────────────────────
//   * program deployed to devnet; Config initialized with the canonical
//     devnet receiver in pyth_receiver
//     (rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ).
//   * the target market already exists and is PAST its expiry, with a
//     pyth_feed_id matching a real Hermes equity feed.
//   * the local keypair has devnet SOL to pay for posting the update.
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//   cd scripts && npm install
//   node post-pyth-update.mjs \
//     --ticker META --strike-dollars 680 --expiry-unix <unix> \
//     --feed-id 78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe \
//     [--rpc https://api.devnet.solana.com] \
//     [--keypair ~/.config/solana/id.json] \
//     [--hermes-url https://hermes.pyth.network] [--hermes-token <key>] \
//     [--no-settle]   # post the update only, skip settle_market
//
// NOTE: this script could not be exercised in CI for U2 — no funded devnet
// wallet and no deployed program were available. It is verified by inspection
// against automation/src/pyth.ts (the shared helper this mirrors) and the
// settle flow in settle-redeem-demo.mjs. The contract-side window change it
// depends on IS proven by the LiteSVM suite
// (tests/litesvm/tests/u7_settle_redeem.rs).
//
// RUNTIME NOTE: @pythnetwork/pyth-solana-receiver pulls in `jito-ts`, whose
// dist uses extensionless ESM imports that Node's strict ESM resolver rejects
// (ERR_MODULE_NOT_FOUND on .../jito-ts/dist/...). This is repo-wide (the
// automation service hits it too) and is worked around by running under the
// `tsx` loader, which patches module resolution. Run this script the same way:
//
//     node --import tsx post-pyth-update.mjs --ticker META ...
//
// (plain `node post-pyth-update.mjs` works for everything EXCEPT the receiver
// import; the Hermes fetch + on-chain settle logic itself is unaffected.)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";

const BN = anchor.BN ?? anchor.default?.BN;
const AnchorProvider = anchor.AnchorProvider ?? anchor.default?.AnchorProvider;
const Wallet = anchor.Wallet ?? anchor.default?.Wallet;
const Program = anchor.Program ?? anchor.default?.Program;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const IDL_PATH = path.join(REPO_ROOT, "target", "idl", "meridian.json");

// Canonical Pyth receiver on devnet/mainnet (matches Config.pyth_receiver).
const DEFAULT_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

// ── arg parsing ───────────────────────────────────────────────────────────
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

const RPC_URL = args.rpc ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH = (args.keypair ?? path.join(os.homedir(), ".config/solana/id.json")).replace(
  /^~/,
  os.homedir(),
);
const TICKER = (args.ticker ?? "META").toUpperCase();
const STRIKE_DOLLARS = Number(args["strike-dollars"] ?? 680);
const EXPIRY_UNIX = args["expiry-unix"] != null ? Number(args["expiry-unix"]) : null;
const FEED_HEX = normalizeFeedId(args["feed-id"] ?? "");
const HERMES_URL = args["hermes-url"] ?? "https://hermes.pyth.network";
const HERMES_TOKEN = args["hermes-token"]; // optional access token (Hermes is moving to keys)
const RECEIVER_STR = args.receiver ?? DEFAULT_RECEIVER;
const SKIP_SETTLE = args["no-settle"] === "true";

if (!FEED_HEX) {
  console.error("error: --feed-id <64 hex> is required (the market's pyth_feed_id)");
  process.exit(2);
}
if (FEED_HEX.length !== 64) {
  console.error(`error: --feed-id must be 64 hex chars (32 bytes), got ${FEED_HEX.length}`);
  process.exit(2);
}
if (EXPIRY_UNIX == null) {
  console.error("error: --expiry-unix <unix seconds> is required (the market's expiry)");
  process.exit(2);
}

// Mirror automation/src/pyth.ts: bare 64-hex, no 0x.
function normalizeFeedId(id) {
  return id.startsWith("0x") ? id.slice(2) : id;
}

// ── on-chain plumbing (mirrors settle-redeem-demo.mjs) ──────────────────────
const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);
// The in-memory IDL patch: the Book account is zero-copy and not Anchor-
// fetchable through the JS client, so strip it (same as the other scripts).
const STRIP = new Set(["Book"]);
if (Array.isArray(idl.accounts)) idl.accounts = idl.accounts.filter((a) => !STRIP.has(a.name));
if (Array.isArray(idl.types)) idl.types = idl.types.filter((t) => !STRIP.has(t.name));

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))));
const connection = new Connection(RPC_URL, "confirmed");
const wallet = new Wallet(payer);
const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new Program(idl, provider);

const enc = (s) => Buffer.from(s, "utf8");
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const configPda = () => pda([enc("config")]);
function tickerBytes(t) {
  const b = Buffer.alloc(8, 0);
  Buffer.from(t, "ascii").copy(b, 0, 0, Math.min(8, t.length));
  return b;
}
function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}
function i64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}
const marketPda = (t, s, e) => pda([enc("market"), tickerBytes(t), u64le(s), i64le(e)]);

const line = "─".repeat(74);
const header = (s) => console.log(`\n${line}\n  ${s}\n${line}`);
const kv = (k, v) => console.log(`  ${String(k).padEnd(26)} ${v}`);

// ── Hermes fetch (mirrors automation/src/pyth.ts fetchLatestPriceUpdate) ────
async function fetchLatestPriceUpdate(hermes, feedId) {
  const id = normalizeFeedId(feedId);
  const resp = await hermes.getLatestPriceUpdates([id], { encoding: "base64", parsed: true });
  const updateData = resp.binary.data;
  const entry = resp.parsed?.find((p) => normalizeFeedId(p.id) === id);
  if (!entry) throw new Error(`Hermes returned no parsed price for feed ${id}`);
  const price = BigInt(entry.price.price);
  const expo = entry.price.expo;
  return {
    updateData,
    parsed: {
      feedId: normalizeFeedId(entry.id),
      price,
      conf: BigInt(entry.price.conf),
      expo,
      publishTime: entry.price.publish_time,
      priceFloat: Number(price) * 10 ** expo,
    },
  };
}

// ── receiver post (mirrors automation/src/pyth.ts postPriceUpdate) ──────────
async function postPriceUpdate(update, receiverProgramId) {
  const receiver = new PythSolanaReceiver({ connection, wallet, receiverProgramId });
  // keepAccount: the PriceUpdateV2 must survive until settle_market reads it.
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates(update.updateData);
  const priceUpdateAccount = builder.getPriceUpdateAccount(normalizeFeedId(update.parsed.feedId));
  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
    tightComputeBudget: true,
  });
  const signatures = await provider.sendAll(txs);
  return { priceUpdateAccount, signatures };
}

async function main() {
  header("Meridian REAL Pyth settlement (devnet pull oracle)");
  kv("RPC", RPC_URL);
  kv("Program ID", PROGRAM_ID.toBase58());
  kv("Hermes", HERMES_URL);
  kv("Feed ID", FEED_HEX);

  const config = configPda();
  const cfg = await program.account.config.fetch(config);
  kv("Config", config.toBase58());
  kv("pyth_receiver (config)", cfg.pythReceiver.toBase58());

  const receiverProgramId = new PublicKey(RECEIVER_STR);
  if (!receiverProgramId.equals(cfg.pythReceiver)) {
    console.error(
      `error: --receiver (${receiverProgramId.toBase58()}) != config.pyth_receiver ` +
        `(${cfg.pythReceiver.toBase58()}) — settle would fail InvalidOracleOwner`,
    );
    process.exit(3);
  }

  const strikeMicro = Math.round(STRIKE_DOLLARS * 1_000_000);
  const market = marketPda(TICKER, strikeMicro, EXPIRY_UNIX);
  kv("Market PDA", market.toBase58());
  kv("Strike / expiry", `$${STRIKE_DOLLARS} / ${new Date(EXPIRY_UNIX * 1000).toISOString()}`);

  // ── 1) fetch latest update from Hermes ────────────────────────────────────
  header("1) fetch latest price update from Hermes");
  const hermes = new HermesClient(HERMES_URL, HERMES_TOKEN ? { accessToken: HERMES_TOKEN } : {});
  const update = await fetchLatestPriceUpdate(hermes, FEED_HEX);
  kv("price (~$)", update.parsed.priceFloat.toFixed(2));
  kv("publish_time", `${update.parsed.publishTime} (${new Date(update.parsed.publishTime * 1000).toISOString()})`);

  // Off-hours pre-check: if the latest update is already older than the
  // post-expiry window relative to the market's expiry, settle_market will
  // reject it (OracleStale). Surface this clearly and point at the override.
  const SETTLE_WINDOW_SECONDS = 900; // mirror programs/.../settle_market.rs
  const windowEnd = EXPIRY_UNIX + SETTLE_WINDOW_SECONDS;
  if (update.parsed.publishTime < EXPIRY_UNIX || update.parsed.publishTime > windowEnd) {
    console.error(
      `\nThe latest Hermes update (publish_time=${update.parsed.publishTime}) is OUTSIDE the\n` +
        `settlement window [${EXPIRY_UNIX}, ${windowEnd}] for this market. This is expected\n` +
        `off US market hours (equity feeds stop updating after 4PM ET). settle_market would\n` +
        `reject with OracleStale.\n\n` +
        `FALLBACK: settle via the admin override after the 24h emergency grace:\n` +
        `    anchor run admin-settle   (or call admin_settle_market directly)\n` +
        `See docs/DEVNET-RUNBOOK.md.`,
    );
    process.exit(4);
  }

  // ── 2) post the update on-chain (creates the PriceUpdateV2 account) ───────
  header("2) post update via Pyth receiver → PriceUpdateV2 account");
  const { priceUpdateAccount, signatures } = await postPriceUpdate(update, receiverProgramId);
  kv("PriceUpdateV2", priceUpdateAccount.toBase58());
  kv("post tx(s)", signatures.join(", "));

  // Sanity: the posted account must be owned by config.pyth_receiver, which is
  // exactly what settle_market's manual owner check enforces.
  const info = await connection.getAccountInfo(priceUpdateAccount);
  if (!info) {
    console.error("error: posted PriceUpdateV2 not found after post — aborting before settle");
    process.exit(5);
  }
  kv("PriceUpdateV2 owner", info.owner.toBase58());
  if (!info.owner.equals(cfg.pythReceiver)) {
    console.error("error: posted account owner != config.pyth_receiver — settle would fail");
    process.exit(5);
  }

  if (SKIP_SETTLE) {
    header("Done (--no-settle): update posted, settle_market skipped");
    kv("PriceUpdateV2", priceUpdateAccount.toBase58());
    return;
  }

  // ── 3) settle_market against the posted account ───────────────────────────
  header("3) settle_market — read posted PriceUpdateV2, stamp outcome");
  let m = await program.account.market.fetch(market);
  kv("settled (pre)", String(m.settled));
  if (m.settled) {
    console.error("note: market already settled — nothing to do");
    return;
  }
  await program.methods
    .settleMarket()
    .accounts({ caller: payer.publicKey, config, market, priceUpdate: priceUpdateAccount })
    .rpc();
  m = await program.account.market.fetch(market);
  const outcome = m.outcome ? Object.keys(m.outcome)[0] : "none";
  kv("settled (post)", String(m.settled));
  kv("outcome", outcome);

  header("Summary — settled from a real Pyth equity price");
  kv("PriceUpdateV2", priceUpdateAccount.toBase58());
  kv("settle_market", `✓ outcome=${outcome}`);
  console.log("");
}

main().catch((e) => {
  console.error("\npost-pyth-update failed:", e?.message ?? e);
  if (e?.logs) {
    console.error("\nprogram logs:");
    for (const l of e.logs) console.error(`  ${l}`);
  }
  // OracleStale at settle time (despite the pre-check) most often means the
  // feed went stale between fetch and settle, or market hours just ended.
  if (String(e?.message ?? e).includes("OracleStale")) {
    console.error(
      "\nhint: the price went stale before settle landed — retry during market hours, " +
        "or fall back to admin_settle_market (see docs/DEVNET-RUNBOOK.md).",
    );
  }
  process.exit(1);
});
