// config.ts — single source of truth for the automation service.
//
// Holds the MAG7 ticker set with their Pyth equity feed IDs, the PRD strike
// algorithm (±%-from-prev-close, rounded to nearest $10), RPC URL, Hermes
// endpoint, and the admin keypair path — all env-driven
// with sane defaults. Also exposes the config validators and the
// `computeStrikes` ladder helper the create-strikes job (U4) builds on.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";

// ─── tickers + feed IDs ────────────────────────────────────────────────────

export type Ticker =
  | "AAPL"
  | "MSFT"
  | "GOOGL"
  | "GOOG"
  | "AMZN"
  | "NVDA"
  | "META"
  | "TSLA";

export interface TickerConfig {
  /** On-chain `Market.ticker` (≤8 ASCII bytes). */
  ticker: Ticker;
  /** Pyth canonical symbol — `Equity.US.<TICKER>/USD` (regular session). */
  pythSymbol: string;
  /**
   * Pyth price-feed ID, 64-hex (32 bytes), NO `0x` prefix — matches what the
   * Hermes API returns and what `Market.pyth_feed_id` stores.
   *
   * These are the REGULAR-SESSION (`/USD`, no `.PRE`/`.ON`/`.POST` suffix)
   * equity feeds, resolved from Hermes (`hermes.pyth.network`, assetType
   * "equity"). They are only fresh during US regular trading hours; off-hours
   * the settle job (U5) falls back to admin-override.
   */
  feedId: string;
}

// The canonical "Magnificent Seven" set is AAPL, MSFT, GOOGL (Alphabet),
// AMZN, NVDA, META, TSLA. GOOG (Alphabet's non-voting class) is included as an
// extra entry because Pyth serves a distinct feed for it and it is sometimes
// used interchangeably; the demo default (DEFAULT_TICKERS) uses GOOGL.
const RAW_TICKERS: TickerConfig[] = [
  {
    ticker: "AAPL",
    pythSymbol: "Equity.US.AAPL/USD",
    feedId: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  },
  {
    ticker: "MSFT",
    pythSymbol: "Equity.US.MSFT/USD",
    feedId: "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
  },
  {
    ticker: "GOOGL",
    pythSymbol: "Equity.US.GOOGL/USD",
    feedId: "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
  },
  {
    ticker: "GOOG",
    pythSymbol: "Equity.US.GOOG/USD",
    feedId: "e65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2",
  },
  {
    ticker: "AMZN",
    pythSymbol: "Equity.US.AMZN/USD",
    feedId: "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  },
  {
    ticker: "NVDA",
    pythSymbol: "Equity.US.NVDA/USD",
    feedId: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  },
  {
    ticker: "META",
    pythSymbol: "Equity.US.META/USD",
    feedId: "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
  },
  {
    ticker: "TSLA",
    pythSymbol: "Equity.US.TSLA/USD",
    feedId: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  },
];

/** Lookup table: ticker → config. */
export const TICKERS: Record<Ticker, TickerConfig> = Object.fromEntries(
  RAW_TICKERS.map((t) => [t.ticker, t]),
) as Record<Ticker, TickerConfig>;

/**
 * The default ticker set the jobs operate on: the full MAG7 (PRD §148/§318).
 * GOOGL is Alphabet's voting class (the canonical MAG7 member); GOOG is the
 * non-voting class and is intentionally NOT in the default to avoid a duplicate
 * Alphabet market. Override with env `TICKERS` (comma-separated, e.g.
 * `TICKERS=AAPL,NVDA,TSLA` to run a faster demo subset).
 */
export const DEFAULT_TICKERS: Ticker[] = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "NVDA",
  "META",
  "TSLA",
];

// ─── strike-spacing rules ──────────────────────────────────────────────────

/**
 * PRD strike algorithm (PRD §"Strike Selection"): each morning, generate
 * strikes at fixed PERCENTAGE offsets above and below the previous close,
 * rounded to the nearest $10. The default offsets are ±3%, ±6%, ±9% — six
 * strikes plus the rounded previous close itself (the at-the-money center),
 * deduplicated. Both configurable via env (`STRIKE_PERCENTS`, `STRIKE_ROUNDING`).
 *
 * Worked PRD examples this reproduces exactly:
 *   META prev close $680 → 620, 640, 660, 680, 700, 720, 740
 *   AAPL prev close $230 → 210, 220, 230, 240, 250 (−6%/−3% and +3%/+6% dedupe)
 */
export const DEFAULT_STRIKE_PERCENTS: number[] = [3, 6, 9];

/** Strikes are rounded to the nearest multiple of this many dollars ($10). */
export const DEFAULT_STRIKE_ROUNDING_DOLLARS = 10;

/** Fixed-step ladder: strikes each side of the rounded center. 3 → 7 strikes. */
export const DEFAULT_STRIKE_STEPS_PER_SIDE = 3;

/** USDC has 6 decimals; the program stores strike prices in microdollars. */
export const USDC_DECIMALS = 6;
export const MICRO = 1_000_000;

// ─── runtime config (env-driven) ───────────────────────────────────────────

export interface AutomationConfig {
  rpcUrl: string;
  hermesUrl: string;
  /** Devnet Pyth receiver program (already in on-chain Config.pyth_receiver). */
  pythReceiver: string;
  adminKeypairPath: string;
  tickers: Ticker[];
  /** Percentage offsets from the reference price for the strike ladder (±each). */
  strikePercents: number[];
  /** Round each strike to the nearest multiple of this many dollars. */
  strikeRoundingDollars: number;
  /**
   * Fixed-dollar strike step (e.g. 10 → strikes every $10). When set, the
   * ladder is center ± N·step and `strikePercents` is ignored. Undefined →
   * percentage ladder. From `STRIKE_STEP_DOLLARS`.
   */
  strikeStepDollars?: number;
  /** Strikes each side of center in fixed-step mode. From `STRIKE_STEP_COUNT`. */
  strikeStepsPerSide: number;
  /** Hours-from-now the create-strikes job sets as market expiry. */
  expiryHoursFromNow: number;
  /** Demo opt-in (SEED_LIQUIDITY=true): after create-strikes, rest a small
   *  bid+ask on each fresh market so the board shows implied odds immediately.
   *  Off by default — production stays PRD-pure (traders make the market). */
  seedLiquidity: boolean;
}

const DEFAULT_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

function parseTickers(raw: string | undefined): Ticker[] {
  if (!raw) return DEFAULT_TICKERS;
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean) as Ticker[];
  for (const t of parsed) {
    if (!(t in TICKERS)) {
      throw new Error(
        `unknown ticker "${t}" in TICKERS env — known: ${Object.keys(TICKERS).join(", ")}`,
      );
    }
  }
  return parsed.length > 0 ? parsed : DEFAULT_TICKERS;
}

/**
 * Parse `STRIKE_PERCENTS` (comma-separated positive numbers, e.g. "3,6,9").
 * Falls back to the PRD default ±3/6/9%. Throws on a non-positive or NaN entry
 * so a misconfigured env fails loud rather than silently dropping strikes.
 */
function parseStrikePercents(raw: string | undefined): number[] {
  if (!raw) return [...DEFAULT_STRIKE_PERCENTS];
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`STRIKE_PERCENTS entry "${s}" must be a positive number`);
      }
      return n;
    });
  return parsed.length > 0 ? parsed : [...DEFAULT_STRIKE_PERCENTS];
}

/** Load config from the environment with sane defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AutomationConfig {
  return {
    rpcUrl: env.RPC_URL ?? "https://api.devnet.solana.com",
    hermesUrl: env.HERMES_URL ?? "https://hermes.pyth.network",
    pythReceiver: env.PYTH_RECEIVER ?? DEFAULT_RECEIVER,
    adminKeypairPath: (env.ADMIN_KEYPAIR ?? join(homedir(), ".config/solana/id.json")).replace(
      /^~/,
      homedir(),
    ),
    tickers: parseTickers(env.TICKERS),
    strikePercents: parseStrikePercents(env.STRIKE_PERCENTS),
    strikeRoundingDollars: env.STRIKE_ROUNDING
      ? Number(env.STRIKE_ROUNDING)
      : DEFAULT_STRIKE_ROUNDING_DOLLARS,
    strikeStepDollars: env.STRIKE_STEP_DOLLARS
      ? Number(env.STRIKE_STEP_DOLLARS)
      : undefined,
    strikeStepsPerSide: env.STRIKE_STEP_COUNT
      ? Number(env.STRIKE_STEP_COUNT)
      : DEFAULT_STRIKE_STEPS_PER_SIDE,
    expiryHoursFromNow: env.EXPIRY_HOURS_FROM_NOW
      ? Number(env.EXPIRY_HOURS_FROM_NOW)
      : 24,
    seedLiquidity: env.SEED_LIQUIDITY === "true",
  };
}

/** Load the admin keypair from `config.adminKeypairPath`. Throws if missing. */
export function loadAdminKeypair(cfg: AutomationConfig): Keypair {
  const secret = JSON.parse(readFileSync(cfg.adminKeypairPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

// ─── validation ────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Validate a ticker config: reject a ticker with no (or malformed) feed ID.
 * Throws on the first problem; returns the validated `TickerConfig` otherwise.
 */
export function validateTicker(ticker: Ticker): TickerConfig {
  const cfg = TICKERS[ticker];
  if (!cfg) throw new Error(`unknown ticker "${ticker}"`);
  if (!cfg.feedId || cfg.feedId.trim() === "") {
    throw new Error(`ticker "${ticker}" has no Pyth feed ID configured`);
  }
  if (!HEX64.test(cfg.feedId)) {
    throw new Error(
      `ticker "${ticker}" feed ID is not 32-byte hex (64 chars): "${cfg.feedId}"`,
    );
  }
  return cfg;
}

/** Validate every configured ticker. Throws on the first failure. */
export function validateTickers(tickers: Ticker[]): TickerConfig[] {
  return tickers.map(validateTicker);
}

// ─── strike ladder ─────────────────────────────────────────────────────────

export interface ComputeStrikesOptions {
  /** Percentage offsets (±each) from the reference. Default ±3/6/9%. */
  percents?: number[];
  /** Round each strike to the nearest multiple of this many dollars. Default $10. */
  roundingDollars?: number;
  /** Include the rounded reference (at-the-money) as a center strike. Default true. */
  includeCenter?: boolean;
  /**
   * Fixed-dollar-step mode: when set (> 0), build the ladder as the rounded
   * reference ± N·stepDollars (exact even spacing, e.g. $10), ignoring
   * `percents`/`roundingDollars`. `stepsPerSide` controls N (default 3 → 7
   * strikes). This is the "$10 increments" ladder.
   */
  stepDollars?: number;
  /** Strikes each side of center in fixed-step mode. Default 3. */
  stepsPerSide?: number;
}

export interface StrikeLadder {
  /** Rounding increment used, in dollars (the PRD's "nearest $10"). */
  roundingDollars: number;
  /** Percentage offsets used to build the ladder (±each). */
  percentsUsed: number[];
  /** Strikes in microdollars (what `create_strike_market` expects), ascending. */
  strikesMicro: bigint[];
  /** Same strikes as whole/decimal dollars, for logging. */
  strikesDollars: number[];
}

/** Round `value` to the nearest multiple of `increment` (PRD: nearest $10). */
function roundToNearest(value: number, increment: number): number {
  return Math.round(value / increment) * increment;
}

/**
 * PRD strike algorithm (PRD §"Strike Selection"). Given the previous close
 * (reference price), generate strikes at ±`percents`% offsets, each rounded to
 * the nearest `roundingDollars`, plus the rounded reference as the center, then
 * deduplicate and sort ascending. Returns microdollar strikes for the program
 * plus dollar values for logging.
 *
 * Reproduces the PRD worked examples exactly:
 *   computeStrikes(680) → [620, 640, 660, 680, 700, 720, 740]
 *   computeStrikes(230) → [210, 220, 230, 240, 250]   (collisions dedupe)
 */
export function computeStrikes(
  referencePrice: number,
  opts: ComputeStrikesOptions = {},
): StrikeLadder {
  if (!(referencePrice > 0) || !Number.isFinite(referencePrice)) {
    throw new Error(`reference price must be a positive finite number, got ${referencePrice}`);
  }
  const percents = opts.percents ?? [...DEFAULT_STRIKE_PERCENTS];
  const rounding = opts.roundingDollars ?? DEFAULT_STRIKE_ROUNDING_DOLLARS;
  const includeCenter = opts.includeCenter ?? true;
  if (!(rounding > 0) || !Number.isFinite(rounding)) {
    throw new Error(`roundingDollars must be a positive finite number, got ${rounding}`);
  }
  for (const p of percents) {
    if (!(p > 0) || !Number.isFinite(p)) {
      throw new Error(`strike percent must be a positive finite number, got ${p}`);
    }
  }

  const dollars: number[] = [];
  if (opts.stepDollars !== undefined) {
    // Fixed-dollar-step ladder: rounded center ± N·step, exact even spacing.
    const step = opts.stepDollars;
    if (!(step > 0) || !Number.isFinite(step)) {
      throw new Error(`stepDollars must be a positive finite number, got ${step}`);
    }
    const perSide = opts.stepsPerSide ?? DEFAULT_STRIKE_STEPS_PER_SIDE;
    if (!Number.isInteger(perSide) || perSide < 1) {
      throw new Error(`stepsPerSide must be a positive integer, got ${perSide}`);
    }
    const center = roundToNearest(referencePrice, step);
    for (let i = -perSide; i <= perSide; i++) {
      const s = center + i * step;
      if (s > 0) dollars.push(s);
    }
  } else {
    if (includeCenter) {
      const center = roundToNearest(referencePrice, rounding);
      if (center > 0) dollars.push(center);
    }
    for (const pct of percents) {
      const above = roundToNearest(referencePrice * (1 + pct / 100), rounding);
      const below = roundToNearest(referencePrice * (1 - pct / 100), rounding);
      if (above > 0) dollars.push(above);
      if (below > 0) dollars.push(below);
    }
  }
  // Dedupe (collisions from rounding, per the PRD AAPL example) and sort.
  const unique = [...new Set(dollars)].sort((a, b) => a - b);

  return {
    roundingDollars: rounding,
    percentsUsed: [...percents],
    strikesDollars: unique,
    strikesMicro: unique.map((d) => BigInt(Math.round(d * MICRO))),
  };
}
