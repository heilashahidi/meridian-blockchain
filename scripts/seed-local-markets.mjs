#!/usr/bin/env node
//
// seed-local-markets.mjs — populate a LOCAL validator with the MAG7 markets and
// resting (non-crossing) bid/ask liquidity, so the frontend dashboard/markets
// render with varied, real implied probabilities (like the reference UI).
//
// For each ticker it: creates a strike market (skips if it already exists),
// mints a Yes/No pair to the admin, then rests an ask above and a bid below a
// target mid (in µUSDC per Yes, where 500_000 = $0.50). The book mid drives the
// frontend's implied-probability bar.
//
// Usage: node seed-local-markets.mjs [--rpc http://127.0.0.1:8899] [--keypair ~/.config/solana/id.json]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

const BN = anchor.BN ?? anchor.default?.BN;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const IDL_PATH = path.join(REPO_ROOT, "target", "idl", "meridian.json");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.replace(/^--/, "");
    out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}
const args = parseArgs(process.argv);
const RPC_URL = args.rpc ?? "http://127.0.0.1:8899";
const KEYPAIR_PATH = (args.keypair ?? path.join(os.homedir(), ".config/solana/id.json")).replace(/^~/, os.homedir());

// ticker → { strike $, target Yes prob }. Strikes near current MAG7 spots; the
// target probability is what the resting bid/ask straddle produces.
const SEED = [
  { ticker: "AAPL", strike: 310, prob: 0.64 },
  { ticker: "MSFT", strike: 500, prob: 0.37 },
  { ticker: "GOOGL", strike: 380, prob: 0.43 },
  { ticker: "AMZN", strike: 270, prob: 0.65 },
  { ticker: "NVDA", strike: 210, prob: 0.52 },
  { ticker: "TSLA", strike: 435, prob: 0.41 },
  { ticker: "META", strike: 620, prob: 0.58 },
];

const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);
const STRIP = new Set(["Book"]);
if (Array.isArray(idl.accounts)) idl.accounts = idl.accounts.filter((a) => !STRIP.has(a.name));
if (Array.isArray(idl.types)) idl.types = idl.types.filter((t) => !STRIP.has(t.name));

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))));
const connection = new Connection(RPC_URL, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

const enc = (s) => Buffer.from(s, "utf8");
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const configPda = () => pda([enc("config")]);
function tickerBytes(t) {
  const b = Buffer.alloc(8, 0);
  Buffer.from(t, "ascii").copy(b, 0, 0, Math.min(8, t.length));
  return b;
}
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; };
const i64le = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n), 0); return b; };
const marketPda = (t, s, e) => pda([enc("market"), tickerBytes(t), u64le(s), i64le(e)]);
const subPdas = (m) => ({
  book: pda([enc("book"), m.toBuffer()]),
  yesMint: pda([enc("yes_mint"), m.toBuffer()]),
  noMint: pda([enc("no_mint"), m.toBuffer()]),
  mintAuthority: pda([enc("mint_auth"), m.toBuffer()]),
  usdcEscrow: pda([enc("usdc_escrow"), m.toBuffer()]),
  yesEscrow: pda([enc("yes_escrow"), m.toBuffer()]),
});

const QTY = 25; // Yes units per side (small — only the mid matters for the bar)
const SPREAD = 40_000; // ±$0.04 around the target mid

async function seedOne(cfg, usdcMint, userUsdc, { ticker, strike, prob }, expiryUnix) {
  const strikeMicro = Math.round(strike * 1_000_000);
  const market = marketPda(ticker, strikeMicro, expiryUnix);
  const P = subPdas(market);
  const pythFeedId = Array.from(Buffer.from("01".repeat(32), "hex"));

  // 1) create market (skip if it already exists)
  try {
    await program.methods
      .createStrikeMarket({ ticker: Array.from(tickerBytes(ticker)), strikePrice: new BN(strikeMicro), expiryUnix: new BN(expiryUnix), pythFeedId })
      .accounts({
        admin: payer.publicKey, config: configPda(), market, book: P.book, yesMint: P.yesMint, noMint: P.noMint,
        mintAuthority: P.mintAuthority, usdcEscrow: P.usdcEscrow, yesEscrow: P.yesEscrow, usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  } catch (e) {
    if (!String(e?.message ?? e).match(/already in use|AccountAlreadyInitialized/i)) throw e;
  }

  const userYes = (await getOrCreateAssociatedTokenAccount(connection, payer, P.yesMint, payer.publicKey)).address;
  const userNo = (await getOrCreateAssociatedTokenAccount(connection, payer, P.noMint, payer.publicKey)).address;

  // 2) mint a pair so we hold Yes inventory + the book has collateral
  await program.methods
    .mintPair(new BN(QTY))
    .accounts({ user: payer.publicKey, config: configPda(), market, userUsdc, usdcEscrow: P.usdcEscrow, yesMint: P.yesMint, noMint: P.noMint, userYes, userNo, mintAuthority: P.mintAuthority, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();

  const mid = Math.round(prob * 1_000_000);
  const askPrice = mid + SPREAD;
  const bidPrice = mid - SPREAD;

  // 3) resting ask (sell Yes) above the mid — escrows Yes
  await program.methods
    .placeLimitOrder({ side: 1, price: new BN(askPrice), qty: new BN(QTY) })
    .accounts({ user: payer.publicKey, config: configPda(), market, book: P.book, usdcEscrow: P.usdcEscrow, yesEscrow: P.yesEscrow, yesMint: P.yesMint, userUsdc, userYes, mintAuthority: P.mintAuthority, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();

  // 4) resting bid (buy Yes) below the mid — escrows USDC, does NOT cross
  await program.methods
    .placeLimitOrder({ side: 0, price: new BN(bidPrice), qty: new BN(QTY) })
    .accounts({ user: payer.publicKey, config: configPda(), market, book: P.book, usdcEscrow: P.usdcEscrow, yesEscrow: P.yesEscrow, yesMint: P.yesMint, userUsdc, userYes, mintAuthority: P.mintAuthority, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();

  console.log(`  ✓ ${ticker} @ $${strike} — mid ${(mid / 1e6).toFixed(2)} (Yes ~${Math.round(prob * 100)}%) ${market.toBase58()}`);
}

async function main() {
  console.log(`Seeding local markets on ${RPC_URL}`);
  const cfg = await program.account.config.fetch(configPda());
  const usdcMint = cfg.usdcMint;
  console.log(`  Config USDC mint ${usdcMint.toBase58()}`);

  // Fund the admin with plenty of test USDC for the resting bids (admin is the mint authority).
  const userUsdc = (await getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, payer.publicKey)).address;
  await mintTo(connection, payer, usdcMint, userUsdc, payer, 2_000_000_000n); // $2,000

  // Deterministic expiry = the next UTC midnight. Stable for the whole UTC day,
  // so re-running the seed reuses the SAME market PDA (create skips) instead of
  // creating a duplicate market per ticker each run.
  const nowSec = Math.floor(Date.now() / 1000);
  const expiryUnix = (Math.floor(nowSec / 86400) + 1) * 86400;
  for (const s of SEED) {
    try {
      await seedOne(cfg, usdcMint, userUsdc, s, expiryUnix);
    } catch (e) {
      console.error(`  ✗ ${s.ticker} failed: ${(e?.message ?? e).toString().slice(0, 140)}`);
    }
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error("seed failed:", e?.message ?? e);
  process.exit(1);
});
