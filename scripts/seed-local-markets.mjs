#!/usr/bin/env node
//
// seed-local-markets.mjs — populate a LOCAL validator with the MAG7 markets and
// resting (non-crossing) bid/ask liquidity, so the frontend dashboard/markets
// render with varied implied probabilities (like the reference UI).
//
// Strike levels are derived from REAL oracle prices: it reads each ticker's
// latest price from Pyth Hermes (the same off-chain source the morning
// create-strikes job uses — allowed per PRD §292) and builds the PRD strike
// ladder (±3/6/9%, rounded to $10, deduped) around it. Off-hours Hermes returns
// the last published price (the previous close), which is exactly what the PRD
// wants for morning strike generation. Pass --no-oracle to use the offline
// fallback reference prices instead (no network).
//
// For each ticker it: creates a strike market (skips if it already exists),
// mints a Yes/No pair to the admin, then rests an ask above and a bid below a
// target mid (in µUSDC per Yes, where 500_000 = $0.50). The book mid drives the
// frontend's implied-probability bar.
//
// Usage: node seed-local-markets.mjs [--rpc http://127.0.0.1:8899]
//          [--keypair ~/.config/solana/id.json] [--no-oracle]
//          [--hermes https://hermes.pyth.network]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { HermesClient } from "@pythnetwork/hermes-client";

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
const HERMES_URL = args.hermes ?? "https://hermes.pyth.network";
const USE_ORACLE = args["no-oracle"] !== "true";

// ticker → { Pyth feed id, offline fallback reference $ }. Feed IDs are kept in
// sync with automation/src/config.ts (RAW_TICKERS). The fallback is used only
// when --no-oracle is set or Hermes is unreachable for that ticker, so a fresh
// `make dev` still produces a sensible board with no network.
const SEED = [
  { ticker: "AAPL", feedId: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688", fallback: 310 },
  { ticker: "MSFT", feedId: "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1", fallback: 500 },
  { ticker: "GOOGL", feedId: "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6", fallback: 380 },
  { ticker: "AMZN", feedId: "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a", fallback: 270 },
  { ticker: "NVDA", feedId: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593", fallback: 210 },
  { ticker: "TSLA", feedId: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1", fallback: 435 },
  { ticker: "META", feedId: "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe", fallback: 680 },
];

// Unix seconds for the upcoming 4:00 PM ET (today if still ahead, else the next
// day) — the PRD's settlement time. Uses the America/New_York tz offset so it's
// correct under EST and EDT, and is deterministic within an ET day (idempotent
// re-seeds reuse the same market PDAs).
function next4pmEtUnix() {
  const TZ = "America/New_York";
  const partsOf = (d) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      }).formatToParts(d).map((p) => [p.type, p.value]),
    );
  // The unix seconds at which the ET wall clock reads y-mo-d 16:00:00.
  const etWallToUnix = (y, mo, d) => {
    const guessMs = Date.UTC(y, mo - 1, d, 16, 0, 0); // pretend ET wall = UTC
    const p = partsOf(new Date(guessMs));
    const asIfUtcMs = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    const offsetMs = asIfUtcMs - guessMs; // how far ET is ahead of UTC
    return Math.floor((guessMs - offsetMs) / 1000);
  };
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const p = partsOf(now);
  let t = etWallToUnix(+p.year, +p.month, +p.day);
  if (t <= nowSec) {
    const tom = partsOf(new Date(now.getTime() + 86_400_000));
    t = etWallToUnix(+tom.year, +tom.month, +tom.day);
  }
  return t;
}

// Read the latest price for each feed from Pyth Hermes in one batch. Returns a
// Map<feedId(no 0x), { price, ageHours }>. Throws only on total failure; the
// caller falls back per-ticker for any feed Hermes omits.
async function fetchOraclePrices(feedIds) {
  const hermes = new HermesClient(HERMES_URL, {});
  const norm = (f) => (f.startsWith("0x") ? f.slice(2) : f);
  const resp = await hermes.getLatestPriceUpdates(feedIds.map(norm), { encoding: "base64", parsed: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const out = new Map();
  for (const e of resp.parsed ?? []) {
    const price = Number(e.price.price) * 10 ** e.price.expo;
    out.set(norm(e.id), { price, ageHours: (nowSec - e.price.publish_time) / 3600 });
  }
  return out;
}

// PRD "Strike Generation" (§ Automated Market Creation): generate strikes at
// ±3%, ±6%, ±9% from the previous close, round to the nearest $10, and
// deduplicate. This produces 6 strikes per stock (3 above, 3 below), collapsing
// to fewer for low-priced stocks where adjacent offsets round together (e.g.
// AAPL −3%/−6% both → $220). Mirrors automation/src/jobs/createStrikes.ts so
// the seeded book matches what the morning automation job would create.
const STRIKE_OFFSETS_PCT = [-9, -6, -3, 3, 6, 9];

function strikesForPrevClose(prevClose) {
  const seen = new Set();
  const out = [];
  for (const pct of STRIKE_OFFSETS_PCT) {
    const strike = Math.round((prevClose * (1 + pct / 100)) / 10) * 10;
    if (seen.has(strike)) continue;
    seen.add(strike);
    out.push(strike);
  }
  return out.sort((a, b) => a - b);
}

// Yes price ≈ the market-implied probability the stock closes AT/ABOVE the
// strike (PRD § "What Is a Meridian Contract?"). Strikes below the prev close
// are more likely to be exceeded (higher Yes prob); strikes above are less
// likely. Linear in the % distance from the prev close, clamped to [0.10, 0.90]
// so every book stays two-sided.
function probForStrike(strike, prevClose) {
  const pct = strike / prevClose - 1; // ≈ [-0.09, +0.09]
  return Math.min(0.9, Math.max(0.1, 0.5 - pct * 3.3));
}

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

  // Read real reference prices from the oracle (Pyth Hermes). One batch call;
  // per-ticker fallback if a feed is missing. --no-oracle skips the network.
  let oracle = new Map();
  if (USE_ORACLE) {
    try {
      oracle = await fetchOraclePrices(SEED.map((s) => s.feedId));
      console.log(`  oracle: read ${oracle.size}/${SEED.length} feeds from Hermes (${HERMES_URL})`);
    } catch (e) {
      console.warn(`  ⚠ oracle read failed (${(e?.message ?? e).toString().slice(0, 80)}) — using fallback prices`);
    }
  } else {
    console.log("  oracle: skipped (--no-oracle) — using fallback prices");
  }

  // Expand each ticker's reference price into the PRD strike ladder, computing a
  // target Yes prob per strike. Flat list of one job per (ticker, strike).
  const jobs = [];
  for (const { ticker, feedId, fallback } of SEED) {
    const hit = oracle.get(feedId);
    const reference = hit ? hit.price : fallback;
    const src = hit ? `oracle $${hit.price.toFixed(2)}${hit.ageHours > 1 ? ` (${hit.ageHours.toFixed(0)}h old — prev close)` : ""}` : `fallback $${fallback}`;
    const strikes = strikesForPrevClose(reference);
    console.log(`  ${ticker} (${src}) → ${strikes.length} strikes: ${strikes.map((s) => "$" + s).join(", ")}`);
    for (const strike of strikes) {
      jobs.push({ ticker, strike, prob: probForStrike(strike, reference) });
    }
  }
  console.log(`  ${jobs.length} markets across ${SEED.length} tickers`);

  // Fund the admin with enough test USDC for every market: mint-pair costs
  // $QTY (=$25) of collateral + a resting bid of ~QTY × <$1. $50/market is
  // generous headroom; admin is the mint authority so this is free test USDC.
  const userUsdc = (await getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, payer.publicKey)).address;
  const fundUsdc = BigInt(jobs.length) * 50n * 1_000_000n; // jobs × $50, in µUSDC
  await mintTo(connection, payer, usdcMint, userUsdc, payer, fundUsdc);

  // Expiry = the next 4:00 PM ET close (the PRD settlement time). Deterministic
  // within an ET trading window, so re-running the seed reuses the SAME market
  // PDA (create skips) instead of duplicating markets. Computed via the ET tz
  // offset so it's correct under both EST and EDT.
  const expiryUnix = next4pmEtUnix();
  for (const job of jobs) {
    try {
      await seedOne(cfg, usdcMint, userUsdc, job, expiryUnix);
    } catch (e) {
      console.error(`  ✗ ${job.ticker} @ $${job.strike} failed: ${(e?.message ?? e).toString().slice(0, 140)}`);
    }
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error("seed failed:", e?.message ?? e);
  process.exit(1);
});
