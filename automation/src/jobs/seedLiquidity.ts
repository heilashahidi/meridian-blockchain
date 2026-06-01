// seed-liquidity job — demo companion to create-strikes.
//
// The PRD create-strikes job creates *bare* markets (no orders); real traders
// make the market. For a demo deployment we want the board to show implied odds
// the moment it regenerates, so this job rests a small non-crossing bid+ask on
// every fresh market for the current trading day, exactly like
// scripts/seed-local-markets.mjs. Gated by SEED_LIQUIDITY=true so production
// stays PRD-pure unless explicitly opted in.
//
// Idempotent: skips any market that already has a two-sided book, so a re-run
// (or the scheduler firing twice) never piles on duplicate depth.

import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

import { BN, buildClient, configPda, marketPdas } from "../client.js";
import {
  loadAdminKeypair,
  loadConfig,
  TICKERS,
  type AutomationConfig,
  type Ticker,
} from "../config.js";
import { settlementExpiryUnix } from "../tradingCalendar.js";
import { alert, log } from "../log.js";

const QTY = 25; // Yes units per side — only the mid drives the implied-prob bar.
const SPREAD = 40_000; // ±$0.04 around the target mid (µUSDC).
const BIDS_LEN_OFF = 8 + 32; // Book: [8 disc][32 market][bids BookSide<32>]…
const ASKS_LEN_OFF = BIDS_LEN_OFF + 1800; // …[asks BookSide<32>]

/** Yes price ≈ implied P(close ≥ strike): linear in %-distance from the prev
 *  close, clamped to [0.10, 0.90] so every book stays two-sided. Mirrors the
 *  seed script + the create-strikes ladder semantics. */
function probForStrike(strike: number, prevClose: number): number {
  const pct = strike / prevClose - 1;
  return Math.min(0.9, Math.max(0.1, 0.5 - pct * 3.3));
}

function decodeTicker(bytes: number[]): string {
  return String.fromCharCode(...bytes)
    .split("")
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7e)
    .join("")
    .trim();
}

export interface SeedLiquidityReport {
  seeded: number;
  skipped: number;
  failed: number;
}

export async function runSeedLiquidityJob(
  cfg: AutomationConfig = loadConfig(),
): Promise<SeedLiquidityReport> {
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const admin = loadAdminKeypair(cfg);
  const { program, wallet } = buildClient(connection, admin);
  const config = configPda();
  const cfgAcct = await program.account.config.fetch(config);
  const usdcMint = cfgAcct.usdcMint as PublicKey;
  const expiry = settlementExpiryUnix();

  // Reference prices per ticker (Hermes) for the implied-prob math. Lazy import
  // to match create-strikes' handling of the jito-ts ESM chain.
  const { makeHermesClient, fetchLatestPriceUpdate } = await import("../pyth.js");
  const hermes = makeHermesClient(cfg.hermesUrl);
  const refs: Partial<Record<Ticker, number>> = {};
  for (const t of cfg.tickers) {
    try {
      const u = await fetchLatestPriceUpdate(hermes, TICKERS[t].feedId);
      if (u.parsed.priceFloat > 0) refs[t] = u.parsed.priceFloat;
    } catch (e) {
      log.warn("seed-liquidity: reference price unavailable", { ticker: t });
    }
  }

  // Today's markets for our tickers.
  const all = await program.account.market.all();
  const targets = all
    .map((m) => ({
      pk: m.publicKey,
      ticker: decodeTicker(m.account.ticker as number[]) as Ticker,
      strike: Number(m.account.strikePrice) / 1e6,
      expiry: Number(m.account.expiryUnix),
    }))
    .filter((m) => m.expiry === expiry && cfg.tickers.includes(m.ticker));

  if (targets.length === 0) {
    log.info("seed-liquidity: no markets for today's expiry", { expiry });
    return { seeded: 0, skipped: 0, failed: 0 };
  }

  // Fund the admin with test USDC for the mint-pairs ($50/market headroom; admin
  // is the mint authority, so this is free test USDC).
  const userUsdc = (
    await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, wallet.publicKey)
  ).address;
  await mintTo(
    connection,
    admin,
    usdcMint,
    userUsdc,
    admin,
    BigInt(targets.length) * 50n * 1_000_000n,
  );

  let seeded = 0,
    skipped = 0,
    failed = 0;
  for (const m of targets) {
    try {
      const P = marketPdas(m.pk);
      // Idempotency: skip a market that already has a two-sided book.
      const info = await connection.getAccountInfo(P.book);
      if (
        info &&
        info.data.length >= ASKS_LEN_OFF + 8 &&
        Number(info.data.readBigUInt64LE(BIDS_LEN_OFF)) > 0 &&
        Number(info.data.readBigUInt64LE(ASKS_LEN_OFF)) > 0
      ) {
        skipped++;
        continue;
      }
      const ref = refs[m.ticker];
      if (!ref) {
        skipped++;
        continue;
      }
      await seedOne(program, connection, admin, wallet.publicKey, config, userUsdc, m.pk, m.strike, ref);
      seeded++;
      log.info("seed-liquidity: market seeded", { ticker: m.ticker, strike: m.strike });
    } catch (e) {
      failed++;
      log.warn("seed-liquidity: market failed", {
        ticker: m.ticker,
        strike: m.strike,
        err: String((e as Error)?.message ?? e).slice(0, 140),
      });
    }
  }

  const report = { seeded, skipped, failed };
  log.info("seed-liquidity report", { ...report, expiry });
  if (seeded === 0 && failed > 0) {
    alert("seed-liquidity placed no liquidity (all markets failed)", report);
  }
  return report;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Program = any;

async function seedOne(
  program: Program,
  connection: Connection,
  admin: import("@solana/web3.js").Keypair,
  user: PublicKey,
  config: PublicKey,
  userUsdc: PublicKey,
  market: PublicKey,
  strike: number,
  reference: number,
): Promise<void> {
  const P = marketPdas(market);
  const userYes = (await getOrCreateAssociatedTokenAccount(connection, admin, P.yesMint, user)).address;
  const userNo = (await getOrCreateAssociatedTokenAccount(connection, admin, P.noMint, user)).address;

  // mint a pair so the book has collateral + the admin holds Yes inventory.
  await program.methods
    .mintPair(new BN(QTY))
    .accounts({
      user, config, market, userUsdc, usdcEscrow: P.usdcEscrow,
      yesMint: P.yesMint, noMint: P.noMint, userYes, userNo,
      mintAuthority: P.mintAuthority, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const mid = Math.round(probForStrike(strike, reference) * 1_000_000);
  const ask = mid + SPREAD;
  const bid = mid - SPREAD;

  // resting ask (sell Yes) above mid — escrows Yes.
  await program.methods
    .placeLimitOrder({ side: 1, price: new BN(ask), qty: new BN(QTY) })
    .accounts({
      user, config, market, book: P.book, usdcEscrow: P.usdcEscrow, yesEscrow: P.yesEscrow,
      yesMint: P.yesMint, userUsdc, userYes, mintAuthority: P.mintAuthority, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  // resting bid (buy Yes) below mid — escrows USDC, does NOT cross.
  await program.methods
    .placeLimitOrder({ side: 0, price: new BN(bid), qty: new BN(QTY) })
    .accounts({
      user, config, market, book: P.book, usdcEscrow: P.usdcEscrow, yesEscrow: P.yesEscrow,
      yesMint: P.yesMint, userUsdc, userYes, mintAuthority: P.mintAuthority, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}
