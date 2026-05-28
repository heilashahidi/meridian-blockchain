#!/usr/bin/env node
//
// lifecycle-demo.mjs — exercise the Meridian CLOB trading lifecycle against a
// running cluster (localnet by default). Proves the matching engine, escrow
// flow, and token mechanics end-to-end on a live validator.
//
// What it does (all on a fresh demo market it creates itself):
//   1. Read the global Config (for usdc_mint) — must already exist
//      (run bootstrap-devnet.mjs / initialize_config first).
//   2. Create a fresh strike market so each run starts with an empty book.
//   3. Set up two parties — TAKER (the local keypair / fee payer) and MAKER
//      (an ephemeral keypair, no SOL needed; the payer covers all fees +
//      ATA rent). Create USDC/Yes/No ATAs for both, mint test USDC to each.
//   4. mint_pair      — MAKER deposits USDC, receives equal Yes + No.
//   5. place + match  — MAKER rests an ask; TAKER crosses it with a bid,
//      paying the maker from escrow and pocketing a price-improvement refund.
//   6. burn_pair      — MAKER recombines a Yes+No pair back into USDC.
//   7. cancel_order   — MAKER rests an ask, then cancels it; escrowed Yes
//      is refunded. (Order seq is parsed from the program logs.)
//
// settle_market + redeem are intentionally NOT exercised here: they require a
// real Pyth PriceUpdateV2 account that localnet doesn't have. That path is
// covered by the LiteSVM suite (tests/litesvm/tests/u7_settle_redeem.rs).
//
// Units note: amounts are raw base units. Yes/No mints are 6-decimal like
// USDC; redeem is 1:1 (burn N winning base units -> N USDC microunits). The
// program is a generic CLOB and does NOT constrain `price` to the $1 payout —
// `price` is USDC microunits per Yes base unit. We use small round integers
// (same convention as the u8_lifecycle test) to make the escrow math legible.
//
// Usage:
//   cd scripts && npm install
//   node lifecycle-demo.mjs [--rpc http://127.0.0.1:8899]
//                           [--keypair ~/.config/solana/id.json]
//                           [--ticker DEMO] [--strike-dollars 680]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount as getSplAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

// @coral-xyz/anchor is CJS; BN isn't hoisted onto the ESM namespace (see
// bootstrap-devnet.mjs for the full explanation). Resolve via default.
const BN = anchor.BN ?? anchor.default?.BN;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const IDL_PATH = path.join(REPO_ROOT, "target", "idl", "meridian.json");

// ─── args ──────────────────────────────────────────────────────────────────

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
const RPC_URL = args.rpc ?? "http://127.0.0.1:8899";
const KEYPAIR_PATH = (args.keypair ?? path.join(os.homedir(), ".config/solana/id.json")).replace(
  /^~/,
  os.homedir(),
);
const TICKER = (args.ticker ?? "DEMO").toUpperCase();
const STRIKE_DOLLARS = Number(args["strike-dollars"] ?? 680);

// ─── IDL + program ───────────────────────────────────────────────────────────

if (!fs.existsSync(IDL_PATH)) {
  console.error(`error: IDL not found at ${IDL_PATH} — run 'anchor build' first`);
  process.exit(2);
}
const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);

// Strip Book — the Anchor TS coder (<=0.32.1) can't resolve the BookSide<32>
// const-generic field; we never decode Book here. Same dance as the bootstrap.
const STRIP = new Set(["Book"]);
if (Array.isArray(idl.accounts)) idl.accounts = idl.accounts.filter((a) => !STRIP.has(a.name));
if (Array.isArray(idl.types)) idl.types = idl.types.filter((t) => !STRIP.has(t.name));

if (!fs.existsSync(KEYPAIR_PATH)) {
  console.error(`error: keypair not found at ${KEYPAIR_PATH}`);
  process.exit(2);
}
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))));

const connection = new Connection(RPC_URL, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
  commitment: "confirmed",
});
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

// ─── PDA derivations ─────────────────────────────────────────────────────────

const enc = (s) => Buffer.from(s, "utf8");
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

const configPda = () => pda([enc("config")]);

function tickerBytes(t) {
  const buf = Buffer.alloc(8, 0);
  Buffer.from(t, "ascii").copy(buf, 0, 0, Math.min(8, t.length));
  return buf;
}
function u64le(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n), 0);
  return buf;
}
function i64le(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(n), 0);
  return buf;
}

const marketPda = (ticker, strikeMicro, expiryUnix) =>
  pda([enc("market"), tickerBytes(ticker), u64le(strikeMicro), i64le(expiryUnix)]);

// All per-market sub-accounts derive from the market key alone.
const subPdas = (market) => ({
  book: pda([enc("book"), market.toBuffer()]),
  yesMint: pda([enc("yes_mint"), market.toBuffer()]),
  noMint: pda([enc("no_mint"), market.toBuffer()]),
  mintAuthority: pda([enc("mint_auth"), market.toBuffer()]),
  usdcEscrow: pda([enc("usdc_escrow"), market.toBuffer()]),
  yesEscrow: pda([enc("yes_escrow"), market.toBuffer()]),
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const line = "─".repeat(74);
const header = (s) => console.log(`\n${line}\n  ${s}\n${line}`);
const kv = (k, v) => console.log(`  ${String(k).padEnd(26)} ${v}`);

async function bal(ata) {
  try {
    return (await getSplAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n; // not yet created / empty
  }
}

// Parse "place_*: posted residual price=P seq=S qty=Q" out of a tx's program
// logs so we can later cancel the resting order by its (price, seq) key.
async function seqFromTx(sig) {
  const tx = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = tx?.meta?.logMessages ?? [];
  for (const l of logs) {
    const m = l.match(/posted residual price=(\d+) seq=(\d+) qty=(\d+)/);
    if (m) return { price: Number(m[1]), seq: Number(m[2]), qty: Number(m[3]) };
  }
  return null;
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  header("Meridian CLOB lifecycle demo");
  kv("RPC", RPC_URL);
  kv("Program ID", PROGRAM_ID.toBase58());

  const config = configPda();
  let cfg;
  try {
    cfg = await program.account.config.fetch(config);
  } catch {
    console.error(
      `\nerror: Config not found at ${config.toBase58()}.\n` +
        "       Run bootstrap-devnet.mjs (or initialize_config) on this cluster first.",
    );
    process.exit(3);
  }
  const USDC_MINT = cfg.usdcMint;
  kv("Config", config.toBase58());
  kv("USDC mint (from config)", USDC_MINT.toBase58());
  kv("Payer / TAKER", payer.publicKey.toBase58());

  const payerSol = await connection.getBalance(payer.publicKey);
  kv("Payer SOL", `${(payerSol / 1e9).toFixed(4)} SOL`);
  if (payerSol < 0.2e9) {
    console.warn("  ⚠ payer SOL low — create_strike_market + ATAs may fail.");
  }

  // ─── 1) fresh demo market ──────────────────────────────────────────────
  header("1) create fresh demo market");
  const strikeMicro = Math.round(STRIKE_DOLLARS * 1_000_000);
  const expiryUnix = Math.floor(Date.now() / 1000) + 2 * 3600; // +2h, comfortably unexpired
  const market = marketPda(TICKER, strikeMicro, expiryUnix);
  const P = subPdas(market);
  const pythFeedId = Array.from(Buffer.from("01".repeat(32), "hex"));

  kv("Ticker / strike", `"${TICKER}" / $${STRIKE_DOLLARS}`);
  kv("Expiry", `${new Date(expiryUnix * 1000).toISOString()}`);
  kv("Market PDA", market.toBase58());

  await program.methods
    .createStrikeMarket({
      ticker: Array.from(tickerBytes(TICKER)),
      strikePrice: new BN(strikeMicro),
      expiryUnix: new BN(expiryUnix),
      pythFeedId,
    })
    .accounts({
      admin: payer.publicKey,
      config,
      market,
      book: P.book,
      yesMint: P.yesMint,
      noMint: P.noMint,
      mintAuthority: P.mintAuthority,
      usdcEscrow: P.usdcEscrow,
      yesEscrow: P.yesEscrow,
      usdcMint: USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log("  ✓ market + book + Yes/No mints + escrows created");

  // ─── 2) parties + funding ──────────────────────────────────────────────
  header("2) set up TAKER + MAKER (ATAs, test USDC)");
  const maker = Keypair.generate();
  kv("MAKER (ephemeral)", maker.publicKey.toBase58());

  // ATAs. payer funds creation + rent for both parties' accounts.
  const ata = async (mint, owner) =>
    (await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner)).address;

  const takerUsdc = await ata(USDC_MINT, payer.publicKey);
  const takerYes = await ata(P.yesMint, payer.publicKey);
  const takerNo = await ata(P.noMint, payer.publicKey);
  const makerUsdc = await ata(USDC_MINT, maker.publicKey);
  const makerYes = await ata(P.yesMint, maker.publicKey);
  const makerNo = await ata(P.noMint, maker.publicKey);

  // Mint test USDC to both (we are the mint authority of the local USDC mint).
  const SEED_USDC = 5_000_000n; // base units each
  await mintTo(connection, payer, USDC_MINT, takerUsdc, payer, SEED_USDC);
  await mintTo(connection, payer, USDC_MINT, makerUsdc, payer, SEED_USDC);
  kv("TAKER USDC", (await bal(takerUsdc)).toString());
  kv("MAKER USDC", (await bal(makerUsdc)).toString());

  // ─── 3) mint_pair (MAKER) ──────────────────────────────────────────────
  header("3) mint_pair — MAKER deposits 1000 USDC -> 1000 Yes + 1000 No");
  const MINT_AMT = 1000;
  await program.methods
    .mintPair(new BN(MINT_AMT))
    .accounts({
      user: maker.publicKey,
      config,
      market,
      userUsdc: makerUsdc,
      usdcEscrow: P.usdcEscrow,
      yesMint: P.yesMint,
      noMint: P.noMint,
      userYes: makerYes,
      userNo: makerNo,
      mintAuthority: P.mintAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([maker])
    .rpc();
  kv("MAKER USDC", (await bal(makerUsdc)).toString());
  kv("MAKER Yes", (await bal(makerYes)).toString());
  kv("MAKER No", (await bal(makerNo)).toString());
  kv("USDC escrow", (await bal(P.usdcEscrow)).toString());

  // ─── 4) place + match ──────────────────────────────────────────────────
  header("4) place + match — MAKER asks 500 Yes @ 40; TAKER bids 500 @ 50");
  // MAKER resting ask: sell 500 Yes at price 40. Escrows 500 Yes.
  await program.methods
    .placeLimitOrder({ side: 1, price: new BN(40), qty: new BN(500) })
    .accounts({
      user: maker.publicKey,
      config,
      market,
      book: P.book,
      usdcEscrow: P.usdcEscrow,
      yesEscrow: P.yesEscrow,
      yesMint: P.yesMint,
      userUsdc: makerUsdc,
      userYes: makerYes,
      mintAuthority: P.mintAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([maker])
    .rpc();
  console.log("  ✓ MAKER ask rested (500 Yes escrowed)");
  kv("  MAKER Yes (post-ask)", (await bal(makerYes)).toString());
  kv("  Yes escrow", (await bal(P.yesEscrow)).toString());

  const takerUsdcPre = await bal(takerUsdc);
  const makerUsdcPre = await bal(makerUsdc);

  // TAKER crossing bid: buy 500 Yes at price 50 (above ask -> price improvement).
  // Fill happens at the maker's 40, so taker is refunded (50-40)*500 = 5000.
  await program.methods
    .placeLimitOrder({ side: 0, price: new BN(50), qty: new BN(500) })
    .accounts({
      user: payer.publicKey,
      config,
      market,
      book: P.book,
      usdcEscrow: P.usdcEscrow,
      yesEscrow: P.yesEscrow,
      yesMint: P.yesMint,
      userUsdc: takerUsdc,
      userYes: takerYes,
      mintAuthority: P.mintAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: makerUsdc, isWritable: true, isSigner: false }, // maker USDC (paid)
      { pubkey: makerYes, isWritable: true, isSigner: false }, // maker Yes (validated)
    ])
    .rpc();
  console.log("  ✓ TAKER bid matched the resting ask");
  kv("  TAKER Yes (received)", (await bal(takerYes)).toString());
  kv("  TAKER USDC spent", (takerUsdcPre - (await bal(takerUsdc))).toString() + "  (= 500*40 = 20000; 5000 refunded)");
  kv("  MAKER USDC gained", ((await bal(makerUsdc)) - makerUsdcPre).toString() + "  (= 500*40 = 20000)");

  // ─── 5) cancel_order (MAKER) ───────────────────────────────────────────
  // Run before burn_pair, while MAKER still holds 500 Yes to escrow.
  header("5) cancel_order — MAKER rests ask (200 Yes @ 45), then cancels");
  const yesPreCancel = await bal(makerYes);
  const sig = await program.methods
    .placeLimitOrder({ side: 1, price: new BN(45), qty: new BN(200) })
    .accounts({
      user: maker.publicKey,
      config,
      market,
      book: P.book,
      usdcEscrow: P.usdcEscrow,
      yesEscrow: P.yesEscrow,
      yesMint: P.yesMint,
      userUsdc: makerUsdc,
      userYes: makerYes,
      mintAuthority: P.mintAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([maker])
    .rpc();
  const order = await seqFromTx(sig);
  if (!order) {
    console.error("  error: could not parse posted order seq from logs; cannot cancel");
    process.exit(4);
  }
  kv("  rested order", `price=${order.price} seq=${order.seq} qty=${order.qty}`);
  kv("  MAKER Yes (post-ask)", (await bal(makerYes)).toString());

  await program.methods
    .cancelOrder({ side: 1, price: new BN(order.price), seq: new BN(order.seq) })
    .accounts({
      user: maker.publicKey,
      config,
      market,
      book: P.book,
      usdcEscrow: P.usdcEscrow,
      yesEscrow: P.yesEscrow,
      yesMint: P.yesMint,
      userUsdc: makerUsdc,
      userYes: makerYes,
      mintAuthority: P.mintAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([maker])
    .rpc();
  console.log("  ✓ order cancelled — escrowed Yes refunded");
  kv("  MAKER Yes (post-cancel)", (await bal(makerYes)).toString());
  kv("  back to pre-ask balance?", (await bal(makerYes)) === yesPreCancel ? "yes ✓" : "NO ✗");

  // ─── 6) burn_pair (MAKER) ──────────────────────────────────────────────
  header("6) burn_pair — MAKER recombines 500 Yes + 500 No -> 500 USDC");
  // MAKER holds 500 Yes (1000 minted - 500 sold) + 1000 No after the cancel.
  await program.methods
    .burnPair(new BN(500))
    .accounts({
      user: maker.publicKey,
      config,
      market,
      userUsdc: makerUsdc,
      usdcEscrow: P.usdcEscrow,
      yesMint: P.yesMint,
      noMint: P.noMint,
      userYes: makerYes,
      userNo: makerNo,
      mintAuthority: P.mintAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([maker])
    .rpc();
  kv("MAKER Yes", (await bal(makerYes)).toString());
  kv("MAKER No", (await bal(makerNo)).toString());
  kv("MAKER USDC", (await bal(makerUsdc)).toString());
  kv("USDC escrow", (await bal(P.usdcEscrow)).toString());

  // ─── summary ───────────────────────────────────────────────────────────
  header("Summary — full trading lifecycle exercised on live cluster");
  kv("Market", market.toBase58());
  kv("mint_pair", "✓");
  kv("place_limit_order + match", "✓ (with price-improvement refund)");
  kv("burn_pair", "✓");
  kv("cancel_order", "✓ (escrow refunded)");
  console.log(
    "\nNot exercised here (needs real Pyth oracle, covered by LiteSVM u7):\n" +
      "  settle_market, redeem\n",
  );
}

main().catch((e) => {
  console.error("\nlifecycle demo failed:", e?.message ?? e);
  if (e?.logs) {
    console.error("\nprogram logs:");
    for (const l of e.logs) console.error(`  ${l}`);
  }
  process.exit(1);
});
