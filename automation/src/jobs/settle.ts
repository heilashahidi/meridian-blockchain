// jobs/settle.ts — the after-close "settle" job (U5).
//
// After a market's expiry, settle it via the Pyth pull oracle:
//   1. Enumerate OPEN markets = unsettled AND past-expiry (program.account.market.all()).
//   2. For each: fetch the latest Hermes update for the market's pyth_feed_id,
//      post it through the Solana receiver (creating a PriceUpdateV2), then call
//      settle_market referencing that account (the U2 reference flow — see
//      scripts/post-pyth-update.mjs and ../pyth.ts).
//   3. RETRY the post→settle on transient stale / wide-confidence oracle errors
//      (PRD §319): every ~30s up to ~15min. Equity feeds are only fresh during
//      US regular trading hours, so off-hours every attempt is stale.
//   4. If still failing past the OVERRIDE GRACE, fall back to admin_settle_market
//      with the operator-supplied price and alert(). (On-chain, admin override
//      additionally requires expiry + EMERGENCY_GRACE_SECONDS; if that grace has
//      not elapsed the override itself will revert and we alert.)
//   5. Best-effort: run settle_sweep to refund resting orders (logged, never
//      aborts the run).
//
// IDEMPOTENCY: an already-settled market is filtered out of the open set up
// front, and settle_market / admin_settle_market both reject a settled market
// with MarketSettled — which we treat as "already settled" (success), never a
// crash.
//
// PER-MARKET ERROR ISOLATION: one market failing (oracle outage, override
// revert, RPC error) is logged + alerted and does NOT abort the others — mirrors
// the createStrikes (U4) pattern. The job returns a per-market report and throws
// only if EVERY attempted market failed.
//
// Design for testability: all cluster + oracle effects go through an injected
// `SettleDeps`, so unit tests drive the whole job with mocked deps and a fast
// injected clock/sleep — the ~15min retry loop never actually sleeps in a test.

// `@coral-xyz/anchor` re-exports BN dynamically from bn.js; under Node ESM the
// named value export isn't statically resolvable (same quirk as createStrikes.ts
// and scripts/bootstrap-devnet.mjs). Take the TYPE via a type-only import and the
// runtime VALUE from the namespace.
import * as anchor from "@coral-xyz/anchor";
import type { BN as BNType } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import {
  buildClient,
  configPda,
  marketPda,
  marketPdas,
  type MeridianProgram,
} from "../client.js";
import {
  loadAdminKeypair,
  loadConfig,
  TICKERS,
  type AutomationConfig,
  type Ticker,
} from "../config.js";
import { alert, log } from "../log.js";

// Runtime BN constructor (see the import note above).
const BN: typeof BNType = (anchor.BN ??
  (anchor as { default?: { BN?: typeof BNType } }).default?.BN) as typeof BNType;

// NOTE: `../pyth.js` (and its heavy `@pythnetwork/pyth-solana-receiver` →
// `jito-ts` ESM chain) is imported LAZILY inside `makeLiveDeps` only — exactly
// as createStrikes.ts does — so the unit-testable core needs none of it and the
// jito-ts ESM-resolution break never touches vitest.

// ─── error classification ─────────────────────────────────────────────────────

/**
 * Oracle errors that mean "the posted price was rejected as stale or its
 * confidence interval too wide" — i.e. RETRY makes sense (a fresher update may
 * land, or market hours resume). These are the on-chain MeridianError variants
 * settle_market raises for the freshness / confidence gates (see
 * settle_market.rs). Matched loosely against the thrown message/logs because
 * Anchor surfaces them as text.
 */
const RETRYABLE_ORACLE_PATTERNS = [
  "OracleStale",
  "OracleConfidenceTooWide",
  "OracleVerificationInsufficient",
  // Hermes returned no fresh update at all (off-hours) — same remedy: wait.
  "no parsed price",
];

/** "Already settled" — treat as idempotent success, never an error. */
const ALREADY_SETTLED_PATTERNS = ["MarketSettled", "already settled"];

function messageOf(e: unknown): string {
  if (e instanceof Error) {
    const logs = (e as { logs?: string[] }).logs;
    return logs ? `${e.message}\n${logs.join("\n")}` : e.message;
  }
  return String(e);
}

export function isAlreadySettled(e: unknown): boolean {
  const msg = messageOf(e);
  return ALREADY_SETTLED_PATTERNS.some((p) => msg.includes(p));
}

export function isRetryableOracleError(e: unknown): boolean {
  const msg = messageOf(e);
  return RETRYABLE_ORACLE_PATTERNS.some((p) => msg.includes(p));
}

// ─── open-market enumeration ──────────────────────────────────────────────────

/** A market the job intends to settle. */
export interface OpenMarket {
  /** Market PDA. */
  market: PublicKey;
  ticker: Ticker;
  /** Strike price in USDC microunits. */
  strikeMicro: bigint;
  strikeDollars: number;
  expiryUnix: number;
  /** 32-byte Pyth feed id (hex, no 0x). */
  feedIdHex: string;
}

// ─── injectable effects (mocked in unit tests) ────────────────────────────────

/** Result of a settle attempt against the oracle. */
export type SettleAttempt =
  | { ok: true; outcome: "YesWins" | "NoWins"; signature: string }
  | { ok: false; error: unknown };

export interface SettleDeps {
  /** Enumerate unsettled, past-expiry markets (filtered to configured tickers). */
  listOpenMarkets(): Promise<OpenMarket[]>;
  /**
   * Fetch+post the latest Hermes price update for `m.feedIdHex`, then call
   * settle_market referencing the posted PriceUpdateV2. Resolves with the
   * stamped outcome on success; the thrown error on oracle/RPC failure is
   * surfaced via `{ ok: false }` so the retry loop can classify it.
   */
  oracleSettle(m: OpenMarket): Promise<SettleAttempt>;
  /** True if the market is already settled on-chain (idempotency re-check). */
  isSettled(m: OpenMarket): Promise<boolean>;
  /**
   * Admin-override settle with the operator-supplied outcome. `yesWins` is
   * derived from `overridePrice` (the operator's settlement price) vs the
   * strike. Resolves with the signature; rejects on revert (e.g. the on-chain
   * EMERGENCY_GRACE has not elapsed).
   */
  adminSettle(m: OpenMarket, yesWins: boolean): Promise<string>;
  /** Best-effort refund of resting orders. Logged; failures don't abort. */
  sweep(m: OpenMarket): Promise<void>;
}

export interface SettleRunOptions {
  /** Interval between retries, ms. Default 30_000 (~30s). */
  retryIntervalMs?: number;
  /** Total retry budget, ms — the override grace. Default 900_000 (~15min). */
  maxRetryWindowMs?: number;
  /** Injected sleep, for fast tests. Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock (ms since epoch), for fast tests. Default Date.now. */
  now?: () => number;
  /**
   * Operator-supplied settlement price per ticker, in dollars — used ONLY for
   * the admin-override fallback (yesWins = price >= strike). When absent for a
   * ticker, the override can't pick a side and the market is left unsettled
   * (alerted) rather than guessing.
   */
  overridePrices?: Partial<Record<Ticker, number>>;
  /** Run settle_sweep after a successful settle. Default true (best-effort). */
  sweepAfterSettle?: boolean;
}

// ─── per-market result accounting ─────────────────────────────────────────────

export type SettleMethod = "oracle" | "admin-override" | "already-settled";

export interface MarketResult {
  market: string;
  ticker: Ticker;
  strikeDollars: number;
  /** How (or whether) it settled. */
  settledVia: SettleMethod | null;
  outcome?: "YesWins" | "NoWins";
  /** Number of oracle settle attempts made (includes the first). */
  attempts: number;
  /** Whether the best-effort sweep ran without throwing. */
  swept: boolean;
  /** Set when the market could not be settled at all. */
  error?: string;
}

export interface SettleReport {
  results: MarketResult[];
  totalSettled: number;
  totalOverridden: number;
  totalAlreadySettled: number;
  totalFailed: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ─── per-market settle with retry → override fallback ─────────────────────────

interface ResolvedOpts {
  retryIntervalMs: number;
  maxRetryWindowMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  overridePrices: Partial<Record<Ticker, number>>;
  sweepAfterSettle: boolean;
}

/**
 * Settle a single market: retry the oracle path on stale/wide-confidence errors
 * within the override grace, then fall back to admin_settle_market. Never throws
 * — returns a `MarketResult`. The whole loop is driven by the injected clock +
 * sleep, so a test can exhaust a "15min" window in microseconds.
 */
export async function settleOne(
  m: OpenMarket,
  deps: SettleDeps,
  opts: ResolvedOpts,
): Promise<MarketResult> {
  const result: MarketResult = {
    market: m.market.toBase58(),
    ticker: m.ticker,
    strikeDollars: m.strikeDollars,
    settledVia: null,
    attempts: 0,
    swept: false,
  };

  // Idempotency: skip a market that's already settled (no MarketSettled crash).
  if (await deps.isSettled(m)) {
    log.info("market already settled — skipping", {
      market: result.market,
      ticker: m.ticker,
      strike: m.strikeDollars,
    });
    result.settledVia = "already-settled";
    return result;
  }

  const deadline = opts.now() + opts.maxRetryWindowMs;
  let lastError: unknown;

  // Retry the oracle path until it succeeds or the grace window elapses.
  // attempt #1 happens immediately; subsequent attempts wait retryIntervalMs.
  for (;;) {
    result.attempts++;
    let attempt: SettleAttempt;
    try {
      attempt = await deps.oracleSettle(m);
    } catch (e) {
      // oracleSettle threw rather than returning {ok:false}: normalize it.
      attempt = { ok: false, error: e };
    }

    if (attempt.ok) {
      result.settledVia = "oracle";
      result.outcome = attempt.outcome;
      log.info("market settled via oracle", {
        market: result.market,
        ticker: m.ticker,
        strike: m.strikeDollars,
        outcome: attempt.outcome,
        attempts: result.attempts,
        signature: attempt.signature,
      });
      await maybeSweep(m, deps, opts, result);
      return result;
    }

    lastError = attempt.error;

    // Idempotency mid-loop: another cranker may have settled it. Treat as done.
    if (isAlreadySettled(attempt.error)) {
      log.info("market settled by another caller mid-retry — done", {
        market: result.market,
        ticker: m.ticker,
      });
      result.settledVia = "already-settled";
      await maybeSweep(m, deps, opts, result);
      return result;
    }

    const retryable = isRetryableOracleError(attempt.error);
    const msg = messageOf(attempt.error);

    // A non-retryable error (e.g. a bad account / RPC misconfig) won't be
    // fixed by waiting — go straight to the override fallback.
    if (!retryable) {
      log.warn("non-retryable oracle settle error — falling back to override", {
        market: result.market,
        ticker: m.ticker,
        attempt: result.attempts,
        error: msg,
      });
      break;
    }

    // Retryable: wait and try again, unless the next wait would exceed the
    // grace window — then stop and fall back to override.
    const nextAt = opts.now() + opts.retryIntervalMs;
    if (nextAt > deadline) {
      log.warn("oracle settle still failing past override grace — falling back", {
        market: result.market,
        ticker: m.ticker,
        attempts: result.attempts,
        error: msg,
      });
      break;
    }
    log.warn("oracle settle attempt failed (stale/wide); retrying", {
      market: result.market,
      ticker: m.ticker,
      attempt: result.attempts,
      retryInMs: opts.retryIntervalMs,
      error: msg,
    });
    await opts.sleep(opts.retryIntervalMs);
  }

  // ── admin-override fallback ──────────────────────────────────────────────
  return overrideSettle(m, deps, opts, result, lastError);
}

/**
 * Admin-override fallback: pick the outcome from the operator-supplied price and
 * call admin_settle_market, then alert. If no override price is configured for
 * the ticker we cannot pick a side — leave the market unsettled and alert.
 */
async function overrideSettle(
  m: OpenMarket,
  deps: SettleDeps,
  opts: ResolvedOpts,
  result: MarketResult,
  lastError: unknown,
): Promise<MarketResult> {
  const overridePrice = opts.overridePrices[m.ticker];
  if (overridePrice === undefined) {
    const msg =
      `no override price configured for ${m.ticker}; cannot admin-settle ` +
      `(last oracle error: ${messageOf(lastError)})`;
    result.error = msg;
    await alert("settle: oracle failed and no override price — market left open", {
      market: result.market,
      ticker: m.ticker,
      strike: m.strikeDollars,
      error: messageOf(lastError),
    });
    return result;
  }

  const yesWins = overridePrice >= m.strikeDollars;
  try {
    const sig = await deps.adminSettle(m, yesWins);
    result.settledVia = "admin-override";
    result.outcome = yesWins ? "YesWins" : "NoWins";
    await alert("settle: oracle failed — settled via admin override", {
      market: result.market,
      ticker: m.ticker,
      strike: m.strikeDollars,
      overridePrice,
      outcome: result.outcome,
      attempts: result.attempts,
      signature: sig,
      lastOracleError: messageOf(lastError),
    });
    log.info("market settled via admin override", {
      market: result.market,
      ticker: m.ticker,
      outcome: result.outcome,
      signature: sig,
    });
    await maybeSweep(m, deps, opts, result);
    return result;
  } catch (e) {
    // The override itself reverted (e.g. on-chain emergency grace not elapsed,
    // or it was just settled by someone else).
    if (isAlreadySettled(e)) {
      result.settledVia = "already-settled";
      await maybeSweep(m, deps, opts, result);
      return result;
    }
    const msg = messageOf(e);
    result.error = msg;
    await alert("settle: admin override failed — market left open", {
      market: result.market,
      ticker: m.ticker,
      strike: m.strikeDollars,
      error: msg,
    });
    log.error("admin override failed", {
      market: result.market,
      ticker: m.ticker,
      error: msg,
    });
    return result;
  }
}

/** Best-effort sweep: logged, never aborts the per-market result. */
async function maybeSweep(
  m: OpenMarket,
  deps: SettleDeps,
  opts: ResolvedOpts,
  result: MarketResult,
): Promise<void> {
  if (!opts.sweepAfterSettle) return;
  try {
    await deps.sweep(m);
    result.swept = true;
    log.info("settle_sweep complete", {
      market: result.market,
      ticker: m.ticker,
    });
  } catch (e) {
    // Sweep is best-effort: a failure here doesn't undo a successful settle.
    log.warn("settle_sweep failed (best-effort, ignored)", {
      market: result.market,
      ticker: m.ticker,
      error: messageOf(e),
    });
  }
}

// ─── top-level pipeline (deps injected → unit-testable) ───────────────────────

/**
 * Settle every open market using injected effects. One market failing is logged
 * + alerted (inside settleOne) and does NOT abort the others. Returns a
 * per-market report.
 */
export async function settle(
  deps: SettleDeps,
  options: SettleRunOptions = {},
): Promise<SettleReport> {
  const opts: ResolvedOpts = {
    retryIntervalMs: options.retryIntervalMs ?? 30_000,
    maxRetryWindowMs: options.maxRetryWindowMs ?? 900_000,
    sleep: options.sleep ?? defaultSleep,
    now: options.now ?? Date.now,
    overridePrices: options.overridePrices ?? {},
    sweepAfterSettle: options.sweepAfterSettle ?? true,
  };

  const open = await deps.listOpenMarkets();
  log.info("settle: open markets", {
    count: open.length,
    markets: open.map((m) => ({
      ticker: m.ticker,
      strike: m.strikeDollars,
      expiryUnix: m.expiryUnix,
    })),
  });

  const results: MarketResult[] = [];
  for (const m of open) {
    try {
      results.push(await settleOne(m, deps, opts));
    } catch (e) {
      // settleOne is designed never to throw; this is a last-resort isolation
      // so an unexpected throw on one market can't sink the rest.
      const msg = messageOf(e);
      log.error("market settle threw unexpectedly", {
        market: m.market.toBase58(),
        ticker: m.ticker,
        error: msg,
      });
      await alert("settle: market threw unexpectedly", {
        market: m.market.toBase58(),
        ticker: m.ticker,
        error: msg,
      });
      results.push({
        market: m.market.toBase58(),
        ticker: m.ticker,
        strikeDollars: m.strikeDollars,
        settledVia: null,
        attempts: 0,
        swept: false,
        error: msg,
      });
    }
  }

  const report: SettleReport = {
    results,
    totalSettled: results.filter((r) => r.settledVia === "oracle").length,
    totalOverridden: results.filter((r) => r.settledVia === "admin-override").length,
    totalAlreadySettled: results.filter((r) => r.settledVia === "already-settled")
      .length,
    totalFailed: results.filter((r) => r.settledVia === null).length,
  };

  log.info("settle report", {
    settled: report.totalSettled,
    overridden: report.totalOverridden,
    alreadySettled: report.totalAlreadySettled,
    failed: report.totalFailed,
  });

  return report;
}

// ─── real (live) deps wiring ──────────────────────────────────────────────────

/** hex (no 0x) for a 32-byte feed id stored as a numeric array on-chain. */
function feedIdToHex(feedId: number[] | Uint8Array): string {
  return Buffer.from(Uint8Array.from(feedId)).toString("hex");
}

/** Map a configured ticker's on-chain 8-byte name back to a Ticker. */
function decodeTicker(raw: number[] | Uint8Array): Ticker | null {
  const name = Buffer.from(Uint8Array.from(raw))
    .toString("ascii")
    .replace(/\0+$/, "");
  return (name in TICKERS ? (name as Ticker) : null);
}

/**
 * Build the live `SettleDeps` from config. The on-chain accounts/args mirror the
 * IDL exactly (confirmed against settle_market.rs / admin.rs / settle_sweep.rs):
 *
 *   settle_market(caller, config, market, price_update)            args: []
 *   admin_settle_market(admin, config, market)                     args: { yes_wins: bool }
 *   settle_sweep(caller, config, market, book, usdc_escrow,
 *                yes_escrow, yes_mint, mint_authority,
 *                token_program)                                    args: { args: { max_orders: u32 } }
 *                + remaining_accounts: one recipient ATA per popped order.
 */
export function makeLiveDeps(cfg: AutomationConfig): SettleDeps {
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const admin = loadAdminKeypair(cfg);
  const { program, wallet } = buildClient(connection, admin);
  const configAddr = configPda();
  const receiverProgramId = new PublicKey(cfg.pythReceiver);
  const tickerSet = new Set<Ticker>(cfg.tickers);

  return {
    async listOpenMarkets() {
      const nowSec = Math.floor(Date.now() / 1000);
      // Anchor decodes every Market account; filter to unsettled + past-expiry
      // + a configured ticker. (.all() is the IDL-typed enumerator.)
      const all = await program.account.market.all();
      const open: OpenMarket[] = [];
      for (const { publicKey, account } of all) {
        const acct = account as {
          settled: boolean;
          ticker: number[];
          strikePrice: { toString(): string };
          expiryUnix: { toNumber(): number };
          pythFeedId: number[];
        };
        if (acct.settled) continue;
        const expiryUnix = Number(acct.expiryUnix.toString());
        if (expiryUnix > nowSec) continue; // not yet expired
        const ticker = decodeTicker(acct.ticker);
        if (!ticker || !tickerSet.has(ticker)) continue;
        const strikeMicro = BigInt(acct.strikePrice.toString());
        open.push({
          market: publicKey,
          ticker,
          strikeMicro,
          strikeDollars: Number(strikeMicro) / 1_000_000,
          expiryUnix,
          feedIdHex: feedIdToHex(acct.pythFeedId),
        });
      }
      return open;
    },

    async oracleSettle(m) {
      try {
        // Lazy-load the Pyth helper (jito-ts ESM chain — see top-of-file note).
        const { fetchAndPostLatest, makeHermesClient } = await import("../pyth.js");
        const hermes = makeHermesClient(cfg.hermesUrl);
        const posted = await fetchAndPostLatest(
          connection,
          admin,
          hermes,
          m.feedIdHex,
          receiverProgramId,
        );

        // Pre-check the publish_time against the on-chain window so an off-hours
        // (stale) update fails fast as a retryable error rather than burning a
        // settle_market round-trip. Window = [expiry, expiry + 900s] (mirrors
        // settle_market.rs SETTLE_WINDOW_SECONDS).
        const SETTLE_WINDOW_SECONDS = 900;
        const pt = posted.parsed.publishTime;
        if (pt < m.expiryUnix || pt > m.expiryUnix + SETTLE_WINDOW_SECONDS) {
          return {
            ok: false,
            error: new Error(
              `OracleStale: no fresh update in window [${m.expiryUnix}, ${m.expiryUnix + SETTLE_WINDOW_SECONDS}] (publish_time=${pt})`,
            ),
          };
        }

        await program.methods
          .settleMarket()
          .accountsStrict({
            caller: wallet.publicKey,
            config: configAddr,
            market: m.market,
            priceUpdate: posted.priceUpdateAccount,
          })
          .rpc();

        const acct = (await program.account.market.fetch(m.market)) as {
          outcome: Record<string, unknown> | null;
        };
        const outcome =
          acct.outcome && Object.keys(acct.outcome)[0] === "yesWins"
            ? "YesWins"
            : "NoWins";
        return {
          ok: true,
          outcome,
          signature: posted.signatures[posted.signatures.length - 1] ?? "",
        };
      } catch (e) {
        return { ok: false, error: e };
      }
    },

    async isSettled(m) {
      try {
        const acct = (await program.account.market.fetch(m.market)) as {
          settled: boolean;
        };
        return acct.settled;
      } catch {
        // If we can't read it, let the settle path surface the real error.
        return false;
      }
    },

    async adminSettle(m, yesWins) {
      return program.methods
        .adminSettleMarket(yesWins)
        .accountsStrict({
          admin: wallet.publicKey,
          config: configAddr,
          market: m.market,
        })
        .rpc();
    },

    async sweep(m) {
      const pdas = marketPdas(m.market);
      // Drain in MAX_SWEEP_PER_TX-sized batches until both book sides are empty.
      // The cranker must supply one recipient ATA per popped order; deriving
      // those requires reading the book's resting owners. We keep the sweep
      // best-effort and conservative: read the book, and if it has resting
      // orders, drain them in a bounded loop. Reading the zero-copy Book through
      // Anchor needs the patched IDL (already applied in client.ts).
      const MAX_SWEEP_PER_TX = 8;
      const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");

      const usdcMint = await fetchUsdcMint(program, configAddr);

      for (let round = 0; round < 64; round++) {
        const book = (await program.account.book.fetch(pdas.book)) as {
          bids: { len: { toNumber(): number }; entries: { owner: number[]; qty: { toString(): string } }[] };
          asks: { len: { toNumber(): number }; entries: { owner: number[]; qty: { toString(): string } }[] };
        };
        const bidLen = book.bids.len.toNumber();
        const askLen = book.asks.len.toNumber();
        if (bidLen === 0 && askLen === 0) return; // converged

        // Build the recipient list for the next batch in pop order: bids first
        // (USDC ATA), then asks (Yes ATA). Mirrors settle_sweep's drain order.
        const recipients: PublicKey[] = [];
        let budget = MAX_SWEEP_PER_TX;
        for (let i = 0; i < bidLen && budget > 0; i++, budget--) {
          const owner = new PublicKey(Uint8Array.from(book.bids.entries[i].owner));
          recipients.push(getAssociatedTokenAddressSync(usdcMint, owner, true));
        }
        for (let i = 0; i < askLen && budget > 0; i++, budget--) {
          const owner = new PublicKey(Uint8Array.from(book.asks.entries[i].owner));
          recipients.push(getAssociatedTokenAddressSync(pdas.yesMint, owner, true));
        }

        const toDrain = recipients.length;
        if (toDrain === 0) return;

        await program.methods
          .settleSweep({ maxOrders: toDrain })
          .accountsStrict({
            caller: wallet.publicKey,
            config: configAddr,
            market: m.market,
            book: pdas.book,
            usdcEscrow: pdas.usdcEscrow,
            yesEscrow: pdas.yesEscrow,
            yesMint: pdas.yesMint,
            mintAuthority: pdas.mintAuthority,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(
            recipients.map((pubkey) => ({
              pubkey,
              isSigner: false,
              isWritable: true,
            })),
          )
          .rpc();
      }
    },
  };
}

/** Read `Config.usdc_mint` once (cached). */
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
 * CLI entry point wired into `index.ts`'s `settle` subcommand. Loads config,
 * builds live deps, runs the pipeline, and throws if every attempted market
 * failed to settle (so the CLI exits non-zero on a total outage; a partial
 * failure is reported via the per-market alerts but the job still "completes").
 *
 * Operator override prices come from env `OVERRIDE_PRICES`, a comma-separated
 * `TICKER=price` list (e.g. `OVERRIDE_PRICES=AAPL=187.5,NVDA=120`).
 */
export async function runSettleJob(
  cfg: AutomationConfig = loadConfig(),
  options: SettleRunOptions = {},
): Promise<SettleReport> {
  const deps = makeLiveDeps(cfg);
  const overridePrices = options.overridePrices ?? parseOverridePrices(process.env.OVERRIDE_PRICES);
  const report = await settle(deps, { ...options, overridePrices });

  const attempted = report.results.length;
  if (attempted > 0 && report.totalFailed === attempted) {
    throw new Error(`settle: all ${attempted} open markets failed to settle`);
  }
  return report;
}

/** Parse `OVERRIDE_PRICES=AAPL=187.5,NVDA=120` into a per-ticker map. */
export function parseOverridePrices(
  raw: string | undefined,
): Partial<Record<Ticker, number>> {
  const out: Partial<Record<Ticker, number>> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [t, p] = pair.split("=").map((s) => s.trim());
    if (!t || !p) continue;
    const ticker = t.toUpperCase();
    const price = Number(p);
    if (ticker in TICKERS && Number.isFinite(price) && price > 0) {
      out[ticker as Ticker] = price;
    } else {
      log.warn("ignoring invalid OVERRIDE_PRICES entry", { entry: pair });
    }
  }
  return out;
}

// Re-export marketPda so the live-settle path/tests can derive a market PDA
// without reaching into client.js directly. (Additive; nothing else changed.)
export { marketPda };
