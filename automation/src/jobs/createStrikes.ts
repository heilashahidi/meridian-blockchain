// jobs/createStrikes.ts — the morning "create-strikes" job (U4).
//
// For each configured MAG7 ticker:
//   1. read a reference price off-chain from Hermes (allowed per PRD §292),
//   2. compute a strike ladder (config.computeStrikes),
//   3. derive each per-strike Market PDA and SKIP the ones that already exist
//      (idempotent — never crashes with AccountAlreadyInitialized),
//   4. create_strike_market for the rest, with retry + exponential backoff.
//
// Design for testability: the core pipeline (plan → diff → create) takes its
// cluster + oracle effects through an injected `Deps` object, so unit tests
// drive the whole job with mocked deps and no live cluster. Per-ticker errors
// are isolated: one ticker failing (Hermes read or create) logs + alerts and
// the job moves on to the others. The job exits non-zero only if EVERY ticker
// it attempted ended in failure (so cron/CI surfaces a total outage), while a
// partial failure is reported but does not abort.

// `@coral-xyz/anchor` re-exports BN dynamically from bn.js; under Node ESM the
// named value export isn't statically resolvable (`import { BN }` throws at
// runtime — the same quirk handled in scripts/bootstrap-devnet.mjs). So we take
// the TYPE via a type-only import and the runtime VALUE from the namespace
// (`anchor.BN ?? anchor.default?.BN`).
import * as anchor from "@coral-xyz/anchor";
import type { BN as BNType } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import {
  buildClient,
  configPda,
  marketPda,
  marketPdas,
  tickerBytes,
  type MeridianProgram,
} from "../client.js";
import {
  computeStrikes,
  loadAdminKeypair,
  loadConfig,
  validateTicker,
  type AutomationConfig,
  type Ticker,
} from "../config.js";
import { alert, log } from "../log.js";

// Runtime BN constructor (see the import note above).
const BN: typeof BNType = (anchor.BN ??
  (anchor as { default?: { BN?: typeof BNType } }).default?.BN) as typeof BNType;

// NOTE: `../pyth.js` (and its `@pythnetwork/pyth-solana-receiver` →
// `@pythnetwork/solana-utils` → `jito-ts` chain) is imported LAZILY inside
// `makeLiveDeps` only. Importing it at module top pulls that heavy ESM chain
// into every unit test that touches this module — and `jito-ts`'s broken ESM
// export map fails to resolve under vitest. The unit-testable core
// (plan/diff/create with injected deps) needs none of it.

// ─── plan types ─────────────────────────────────────────────────────────────

/** A single market the job intends to ensure exists. */
export interface MarketPlan {
  ticker: Ticker;
  /** 32-byte Pyth feed id (numeric array) for create_strike_market. */
  pythFeedId: number[];
  /** Strike price in USDC microunits. */
  strikeMicro: bigint;
  /** Strike in whole/decimal dollars (logging only). */
  strikeDollars: number;
  /** Expiry as a unix timestamp (seconds). */
  expiryUnix: number;
  /** Derived Market PDA. */
  market: PublicKey;
}

/** The strikes the job will try to ensure for one ticker. */
export interface TickerPlan {
  ticker: Ticker;
  referencePrice: number;
  spacingDollars: number;
  markets: MarketPlan[];
}

// ─── injectable effects (mocked in unit tests) ────────────────────────────────

export interface CreateStrikesDeps {
  /** Read the reference (latest/previous-close) price for a ticker, in dollars. */
  fetchReferencePrice(ticker: Ticker): Promise<number>;
  /** True if an account already exists on-chain at `address`. */
  accountExists(address: PublicKey): Promise<boolean>;
  /** Send a create_strike_market tx for `plan`; resolves to the signature. */
  createMarket(plan: MarketPlan): Promise<string>;
}

export interface RunOptions {
  /** Plan + diff but don't create (no on-chain writes). */
  dryRun?: boolean;
  /** Max attempts per create (incl. the first). Default 4. */
  maxAttempts?: number;
  /** Base backoff in ms; attempt n waits baseBackoffMs * 2^(n-1). Default 500. */
  baseBackoffMs?: number;
  /** Injected sleep, for fast tests. Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

// ─── per-ticker result accounting ─────────────────────────────────────────────

export interface TickerResult {
  ticker: Ticker;
  /** Strikes that already existed and were skipped. */
  skipped: number;
  /** Strikes newly created this run. */
  created: number;
  /** Strikes whose create failed after all retries. */
  failed: number;
  /** Ticker fully failed before any per-strike work (e.g. price read threw). */
  errored: boolean;
  error?: string;
}

export interface CreateStrikesReport {
  results: TickerResult[];
  totalCreated: number;
  totalSkipped: number;
  totalFailed: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ─── planning (pure given a price source) ─────────────────────────────────────

/**
 * Build the strike plan for one ticker: validate it has a feed, fetch the
 * reference price, compute the ladder, and derive each Market PDA. No on-chain
 * IO beyond the (injected) price read — diffing/creating happens separately.
 */
export async function planTicker(
  ticker: Ticker,
  cfg: AutomationConfig,
  deps: CreateStrikesDeps,
  expiryUnix: number,
): Promise<TickerPlan> {
  const tcfg = validateTicker(ticker); // throws on missing/bad feed id
  const referencePrice = await deps.fetchReferencePrice(ticker);
  const ladder = computeStrikes(referencePrice, cfg.strikesPerSide);

  const pythFeedId = Array.from(Buffer.from(tcfg.feedId, "hex"));
  if (pythFeedId.length !== 32) {
    throw new Error(
      `ticker "${ticker}" feed id is not 32 bytes (got ${pythFeedId.length})`,
    );
  }

  const markets: MarketPlan[] = ladder.strikesMicro.map((strikeMicro, i) => ({
    ticker,
    pythFeedId,
    strikeMicro,
    strikeDollars: ladder.strikesDollars[i],
    expiryUnix,
    market: marketPda(ticker, strikeMicro, expiryUnix),
  }));

  return {
    ticker,
    referencePrice,
    spacingDollars: ladder.spacingDollars,
    markets,
  };
}

// ─── create with retry/backoff ────────────────────────────────────────────────

/**
 * Attempt `deps.createMarket(plan)` up to `maxAttempts` times with exponential
 * backoff. Resolves with the signature on success; rejects with the last error
 * if every attempt failed. Used per-strike so one bad strike doesn't sink the
 * whole ticker.
 */
export async function createWithRetry(
  plan: MarketPlan,
  deps: CreateStrikesDeps,
  opts: Required<Pick<RunOptions, "maxAttempts" | "baseBackoffMs" | "sleep">>,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await deps.createMarket(plan);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < opts.maxAttempts) {
        const wait = opts.baseBackoffMs * 2 ** (attempt - 1);
        log.warn("create_strike_market attempt failed; retrying", {
          ticker: plan.ticker,
          strike: plan.strikeDollars,
          attempt,
          maxAttempts: opts.maxAttempts,
          backoffMs: wait,
          error: msg,
        });
        await opts.sleep(wait);
      } else {
        log.error("create_strike_market failed after all attempts", {
          ticker: plan.ticker,
          strike: plan.strikeDollars,
          attempts: opts.maxAttempts,
          error: msg,
        });
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ─── per-ticker orchestration (diff existing → create missing) ────────────────

/**
 * Ensure all strikes for one ticker exist. Plans the ladder, skips markets that
 * already exist (idempotent), and creates the rest with retry. Never throws for
 * a single strike's failure — those are counted in `failed`. Throws only if the
 * planning step itself fails (caught by the caller, which records `errored`).
 */
export async function ensureTicker(
  ticker: Ticker,
  cfg: AutomationConfig,
  deps: CreateStrikesDeps,
  expiryUnix: number,
  opts: Required<Pick<RunOptions, "maxAttempts" | "baseBackoffMs" | "sleep">> & {
    dryRun: boolean;
  },
): Promise<TickerResult> {
  const plan = await planTicker(ticker, cfg, deps, expiryUnix);
  log.info("planned strikes", {
    ticker,
    referencePrice: plan.referencePrice,
    spacingDollars: plan.spacingDollars,
    strikes: plan.markets.map((m) => m.strikeDollars),
    expiryUnix,
  });

  const result: TickerResult = {
    ticker,
    skipped: 0,
    created: 0,
    failed: 0,
    errored: false,
  };

  for (const m of plan.markets) {
    // Idempotency: a pre-existing Market PDA means this (ticker, strike,
    // expiry) was already created — skip it. Without this, create would fail
    // with AccountAlreadyInitialized.
    if (await deps.accountExists(m.market)) {
      result.skipped++;
      log.debug("market exists — skipping", {
        ticker,
        strike: m.strikeDollars,
        market: m.market.toBase58(),
      });
      continue;
    }

    if (opts.dryRun) {
      log.info("dry-run: would create market", {
        ticker,
        strike: m.strikeDollars,
        market: m.market.toBase58(),
      });
      result.created++; // count the intent for the dry-run report
      continue;
    }

    try {
      const sig = await createWithRetry(m, deps, opts);
      result.created++;
      log.info("market created", {
        ticker,
        strike: m.strikeDollars,
        market: m.market.toBase58(),
        signature: sig,
      });
    } catch (e) {
      result.failed++;
      // Per-strike failure does not abort the ticker or the job.
      await alert("create_strike_market failed for a strike", {
        ticker,
        strike: m.strikeDollars,
        market: m.market.toBase58(),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}

// ─── top-level pipeline (deps injected → unit-testable) ───────────────────────

/**
 * Run the create-strikes pipeline across all configured tickers using injected
 * effects. One ticker failing (planning error OR all-strikes-failed) is logged
 * + alerted and does NOT abort the others. Returns a per-ticker report.
 */
export async function createStrikes(
  cfg: AutomationConfig,
  deps: CreateStrikesDeps,
  options: RunOptions = {},
): Promise<CreateStrikesReport> {
  const opts = {
    dryRun: options.dryRun ?? false,
    maxAttempts: options.maxAttempts ?? 4,
    baseBackoffMs: options.baseBackoffMs ?? 500,
    sleep: options.sleep ?? defaultSleep,
  };

  const expiryUnix =
    Math.floor(Date.now() / 1000) + Math.round(cfg.expiryHoursFromNow * 3600);

  const results: TickerResult[] = [];
  for (const ticker of cfg.tickers) {
    try {
      results.push(
        await ensureTicker(ticker, cfg, deps, expiryUnix, opts),
      );
    } catch (e) {
      // Ticker-level failure (e.g. Hermes price read threw) — isolate it.
      const msg = e instanceof Error ? e.message : String(e);
      log.error("ticker failed entirely", { ticker, error: msg });
      await alert("create-strikes: ticker failed entirely", {
        ticker,
        error: msg,
      });
      results.push({
        ticker,
        skipped: 0,
        created: 0,
        failed: 0,
        errored: true,
        error: msg,
      });
    }
  }

  const report: CreateStrikesReport = {
    results,
    totalCreated: results.reduce((s, r) => s + r.created, 0),
    totalSkipped: results.reduce((s, r) => s + r.skipped, 0),
    totalFailed:
      results.reduce((s, r) => s + r.failed, 0) +
      results.filter((r) => r.errored).length,
  };

  log.info("create-strikes report", {
    created: report.totalCreated,
    skipped: report.totalSkipped,
    failed: report.totalFailed,
    tickers: report.results.map((r) => ({
      ticker: r.ticker,
      created: r.created,
      skipped: r.skipped,
      failed: r.failed,
      errored: r.errored,
    })),
  });

  return report;
}

// ─── real (live) deps wiring ──────────────────────────────────────────────────

/**
 * Build the live `CreateStrikesDeps` from config: a Hermes price source, an
 * on-chain account-existence check, and a real create_strike_market sender.
 * The `create_strike_market` accounts/args mirror scripts/bootstrap-devnet.mjs
 * and the IDL exactly (admin, config, market, book, yes/no mints, mint_authority,
 * usdc/yes escrow, usdc_mint, token/system program, rent).
 */
export function makeLiveDeps(cfg: AutomationConfig): CreateStrikesDeps {
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const admin = loadAdminKeypair(cfg);
  const { program, wallet } = buildClient(connection, admin);
  const configAddr = configPda();

  return {
    async fetchReferencePrice(ticker) {
      const tcfg = validateTicker(ticker);
      // Lazy-load the Pyth helper (see top-of-file note on the jito-ts chain).
      const { fetchLatestPriceUpdate, makeHermesClient } = await import(
        "../pyth.js"
      );
      const hermes = makeHermesClient(cfg.hermesUrl);
      const update = await fetchLatestPriceUpdate(hermes, tcfg.feedId);
      if (!(update.parsed.priceFloat > 0)) {
        throw new Error(
          `Hermes returned non-positive price ${update.parsed.priceFloat} for ${ticker}`,
        );
      }
      return update.parsed.priceFloat;
    },

    async accountExists(address) {
      const info = await connection.getAccountInfo(address);
      return info !== null;
    },

    async createMarket(plan) {
      const pdas = marketPdas(plan.market);
      const usdcMint = await fetchUsdcMint(program, configAddr);
      return program.methods
        .createStrikeMarket({
          ticker: Array.from(tickerBytes(plan.ticker)),
          strikePrice: new BN(plan.strikeMicro.toString()),
          expiryUnix: new BN(plan.expiryUnix),
          pythFeedId: plan.pythFeedId,
        })
        .accountsStrict({
          admin: wallet.publicKey,
          config: configAddr,
          market: plan.market,
          book: pdas.book,
          yesMint: pdas.yesMint,
          noMint: pdas.noMint,
          mintAuthority: pdas.mintAuthority,
          usdcEscrow: pdas.usdcEscrow,
          yesEscrow: pdas.yesEscrow,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    },
  };
}

/** Read `Config.usdc_mint` once per create (cached on the program's connection). */
let usdcMintCache: PublicKey | null = null;
async function fetchUsdcMint(
  program: MeridianProgram,
  configAddr: PublicKey,
): Promise<PublicKey> {
  if (usdcMintCache) return usdcMintCache;
  const config = await program.account.config.fetch(configAddr);
  usdcMintCache = config.usdcMint as PublicKey;
  return usdcMintCache;
}

/**
 * CLI entry point wired into `index.ts`'s `create-strikes` subcommand. Loads
 * config, builds live deps, runs the pipeline, and throws if every attempted
 * ticker failed (so the CLI exits non-zero on a total outage; a partial failure
 * is reported via the per-ticker alerts but the job still "completes").
 */
export async function runCreateStrikesJob(
  cfg: AutomationConfig = loadConfig(),
  options: RunOptions = {},
): Promise<CreateStrikesReport> {
  const deps = makeLiveDeps(cfg);
  const report = await createStrikes(cfg, deps, options);

  const attempted = report.results.length;
  const totalErroredTickers = report.results.filter((r) => r.errored).length;
  if (attempted > 0 && totalErroredTickers === attempted) {
    throw new Error(
      `create-strikes: all ${attempted} tickers failed entirely`,
    );
  }
  return report;
}
