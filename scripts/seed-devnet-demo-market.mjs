#!/usr/bin/env node
//
// seed-devnet-demo-market.mjs — stand up a fresh, fully-tradeable strike ladder
// on the (post-1e6-fix) devnet program and rest a two-sided book on each strike,
// so a connecting wallet can exercise all four trade paths (Buy/Sell Yes/No) on
// the live frontend immediately.
//
// Why this script exists: create_strike_market is idempotent by
// (ticker, strike, expiry) PDA, and the markets already on devnet were created
// under the OLD collateral math (escrow == supply, 1 µUSDC/token). They can't be
// recreated for today's expiry, and seeding onto them would mix old + new
// collateral. So we mint a clean ladder under a UNIQUE expiry (now + WINDOW_H h),
// which guarantees every (ticker, strike, expiry) PDA is brand new and
// collateralized under the fixed $1/token math.
//
// Maker = the admin/payer wallet (persistent), so resting orders + their canonical
// payout ATAs survive after this script exits and a frontend taker can fill them.
//
// Usage:
//   node seed-devnet-demo-market.mjs [--rpc https://api.devnet.solana.com]
//                                    [--keypair ~/.config/solana/id.json]
//                                    [--ticker AAPL] [--window-hours 8]

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const IDL_PATH = path.join(REPO_ROOT, "target", "idl", "meridian.json");
// @coral-xyz/anchor is CJS; BN isn't hoisted onto the ESM namespace, so the
// `import * as anchor` namespace can't be destructured for it — use property
// access (mirrors scripts/lifecycle-demo.mjs).
const BN = anchor.BN ?? anchor.default?.BN;

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
const KEYPAIR_PATH = (args.keypair ?? "~/.config/solana/id.json").replace(/^~/, os.homedir());
const TICKER = args.ticker ?? "AAPL";
const WINDOW_H = Number(args["window-hours"] ?? 8);

// ── IDL + program ────────────────────────────────────────────────────────────
if (!fs.existsSync(IDL_PATH)) {
  console.error(`error: IDL not found at ${IDL_PATH} — run 'anchor build' first`);
  process.exit(2);
}
const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);
// Strip Book — the Anchor TS coder can't resolve BookSide<32>; we never decode it.
const STRIP = new Set(["Book"]);
if (Array.isArray(idl.accounts)) idl.accounts = idl.accounts.filter((a) => !STRIP.has(a.name));
if (Array.isArray(idl.types)) idl.types = idl.types.filter((t) => !STRIP.has(t.name));

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))));
const connection = new Connection(RPC_URL, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

// ── PDA derivations ──────────────────────────────────────────────────────────
const enc = (s) => Buffer.from(s, "utf8");
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const configPda = () => pda([enc("config")]);
function tickerBytes(t) {
  const buf = Buffer.alloc(8, 0);
  Buffer.from(t, "ascii").copy(buf, 0, 0, Math.min(8, t.length));
  return buf;
}
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64le = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const marketPda = (ticker, strikeMicro, expiryUnix) =>
  pda([enc("market"), tickerBytes(ticker), u64le(strikeMicro), i64le(expiryUnix)]);
const subPdas = (market) => ({
  book: pda([enc("book"), market.toBuffer()]),
  yesMint: pda([enc("yes_mint"), market.toBuffer()]),
  noMint: pda([enc("no_mint"), market.toBuffer()]),
  mintAuthority: pda([enc("mint_auth"), market.toBuffer()]),
  usdcEscrow: pda([enc("usdc_escrow"), market.toBuffer()]),
  yesEscrow: pda([enc("yes_escrow"), market.toBuffer()]),
});

const line = "─".repeat(74);
const header = (s) => console.log(`\n${line}\n  ${s}\n${line}`);
const kv = (k, v) => console.log(`  ${String(k).padEnd(28)} ${v}`);
const bal = async (ata) => {
  try { return (await getSplAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID)).amount; }
  catch { return 0n; }
};

// One whole token of collateral, in µUSDC (matches on-chain ONE_USDC).
const ONE_USDC = 1_000_000;
const QTY = 50;          // contracts per resting order (base units = shares)
const SPREAD = 40_000;   // ±$0.04 around the mid (µUSDC)

// A small ATM ladder. Each entry: strike (whole $) + a hand-set Yes mid (¢ of $1)
// so the demo book shows sensible implied odds without a live-price dependency.
const LADDER = [
  { strikeDollars: 220, midUsd: 0.65 }, // in-the-money → Yes rich
  { strikeDollars: 230, midUsd: 0.50 }, // ~at-the-money
  { strikeDollars: 240, midUsd: 0.35 }, // out-of-the-money → Yes cheap
];

async function main() {
  const config = configPda();
  const cfgAcct = await program.account.config.fetch(config);
  const USDC_MINT = cfgAcct.usdcMint;
  const expiryUnix = Math.floor(Date.now() / 1000) + WINDOW_H * 3600;

  header("seed devnet demo ladder (new $1/token program)");
  kv("RPC", RPC_URL);
  kv("Program", PROGRAM_ID.toBase58());
  kv("USDC mint (from config)", USDC_MINT.toBase58());
  kv("Maker / admin", payer.publicKey.toBase58());
  kv("Ticker", TICKER);
  kv("Shared expiry", `${new Date(expiryUnix * 1000).toISOString()}  (+${WINDOW_H}h)`);
  kv("Strikes", LADDER.map((l) => `$${l.strikeDollars}`).join(", "));

  // Fund the maker with test USDC (admin is the mint authority — free test USDC).
  // Per market: mint QTY ($QTY) + a resting bid lock (QTY * bid µUSDC < $QTY).
  // $300/market is comfortable headroom.
  const makerUsdc = (await getOrCreateAssociatedTokenAccount(connection, payer, USDC_MINT, payer.publicKey)).address;
  await mintTo(connection, payer, USDC_MINT, makerUsdc, payer, BigInt(LADDER.length) * 300n * BigInt(ONE_USDC));
  kv("Maker USDC funded", `$${LADDER.length * 300}`);

  let ok = 0;
  for (const { strikeDollars, midUsd } of LADDER) {
    const strikeMicro = Math.round(strikeDollars * ONE_USDC);
    const market = marketPda(TICKER, strikeMicro, expiryUnix);
    const P = subPdas(market);
    header(`${TICKER} > $${strikeDollars}  (Yes mid ~$${midUsd.toFixed(2)})`);
    kv("Market PDA", market.toBase58());

    try {
      // 1) create the market (fresh PDA under the unique expiry).
      await program.methods
        .createStrikeMarket({
          ticker: Array.from(tickerBytes(TICKER)),
          strikePrice: new BN(strikeMicro),
          expiryUnix: new BN(expiryUnix),
          pythFeedId: Array.from(Buffer.from("01".repeat(32), "hex")),
        })
        .accounts({
          admin: payer.publicKey, config, market, book: P.book,
          yesMint: P.yesMint, noMint: P.noMint, mintAuthority: P.mintAuthority,
          usdcEscrow: P.usdcEscrow, yesEscrow: P.yesEscrow, usdcMint: USDC_MINT,
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const makerYes = (await getOrCreateAssociatedTokenAccount(connection, payer, P.yesMint, payer.publicKey)).address;
      const makerNo = (await getOrCreateAssociatedTokenAccount(connection, payer, P.noMint, payer.publicKey)).address;

      // 2) mint a pair → maker holds QTY Yes inventory + collateral in escrow.
      const usdcBefore = await bal(makerUsdc);
      await program.methods.mintPair(new BN(QTY))
        .accounts({
          user: payer.publicKey, config, market, userUsdc: makerUsdc, usdcEscrow: P.usdcEscrow,
          yesMint: P.yesMint, noMint: P.noMint, userYes: makerYes, userNo: makerNo,
          mintAuthority: P.mintAuthority, tokenProgram: TOKEN_PROGRAM_ID,
        }).rpc();
      const minted = usdcBefore - (await bal(makerUsdc));
      kv("mint_pair cost", `$${Number(minted) / ONE_USDC}  (QTY=${QTY} → $1.00/token ✓)`);

      // 3) two-sided non-crossing book.
      const mid = Math.round(midUsd * ONE_USDC);
      const ask = mid + SPREAD, bid = mid - SPREAD;
      // resting ask (sell Yes) above mid — escrows Yes (enables user Buy Yes / Sell No).
      await program.methods.placeLimitOrder({ side: 1, price: new BN(ask), qty: new BN(QTY) })
        .accounts({
          user: payer.publicKey, config, market, book: P.book, usdcEscrow: P.usdcEscrow, yesEscrow: P.yesEscrow,
          yesMint: P.yesMint, userUsdc: makerUsdc, userYes: makerYes, mintAuthority: P.mintAuthority, tokenProgram: TOKEN_PROGRAM_ID,
        }).rpc();
      // resting bid (buy Yes) below mid — escrows USDC (enables user Sell Yes / Buy No).
      await program.methods.placeLimitOrder({ side: 0, price: new BN(bid), qty: new BN(QTY) })
        .accounts({
          user: payer.publicKey, config, market, book: P.book, usdcEscrow: P.usdcEscrow, yesEscrow: P.yesEscrow,
          yesMint: P.yesMint, userUsdc: makerUsdc, userYes: makerYes, mintAuthority: P.mintAuthority, tokenProgram: TOKEN_PROGRAM_ID,
        }).rpc();
      kv("book", `bid $${(bid / ONE_USDC).toFixed(2)}  /  ask $${(ask / ONE_USDC).toFixed(2)}  (qty ${QTY} each) ✓`);
      ok++;
    } catch (e) {
      kv("FAILED", String(e?.message ?? e).slice(0, 160));
    }
  }

  header("done");
  kv("Markets seeded", `${ok}/${LADDER.length}`);
  kv("Shared expiry (unix)", String(expiryUnix));
  console.log(
    `\n  → On the frontend, connect a wallet and open ${TICKER}. The strikes above` +
    `\n    show a two-sided book; Buy/Sell Yes and Buy/Sell No are all live.\n`,
  );
  if (ok === 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
