// config.ts — single source of truth for the automation service.
//
// Holds the MAG7 ticker set with their Pyth equity feed IDs, strike-spacing
// rules, RPC URL, Hermes endpoint, and the admin keypair path — all env-driven
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
 * The subset the jobs operate on by default (demo speed — the plan ships a
 * subset by default, all 7 configurable). Override with env `TICKERS`
 * (comma-separated, e.g. `TICKERS=AAPL,NVDA,TSLA`).
 */
export const DEFAULT_TICKERS: Ticker[] = ["AAPL", "NVDA", "TSLA"];

// ─── strike-spacing rules ──────────────────────────────────────────────────

export interface StrikeSpacing {
  /** If price < `maxPrice`, use `spacingDollars`. Buckets are tried in order. */
  maxPrice: number;
  spacingDollars: number;
}

/**
 * Strike spacing buckets, roughly tracking how listed options space strikes by
 * underlying price. Env-overridable count of strikes each side via
 * `STRIKES_PER_SIDE`.
 */
export const STRIKE_SPACING: StrikeSpacing[] = [
  { maxPrice: 50, spacingDollars: 1 },
  { maxPrice: 100, spacingDollars: 2.5 },
  { maxPrice: 250, spacingDollars: 5 },
  { maxPrice: 1000, spacingDollars: 10 },
  { maxPrice: Infinity, spacingDollars: 25 },
];

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
  strikesPerSide: number;
  /** Hours-from-now the create-strikes job sets as market expiry. */
  expiryHoursFromNow: number;
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
    strikesPerSide: env.STRIKES_PER_SIDE ? Number(env.STRIKES_PER_SIDE) : 3,
    expiryHoursFromNow: env.EXPIRY_HOURS_FROM_NOW
      ? Number(env.EXPIRY_HOURS_FROM_NOW)
      : 24,
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

/** Pick the spacing for a reference price from the bucket table. */
export function spacingForPrice(referencePrice: number): number {
  for (const b of STRIKE_SPACING) {
    if (referencePrice < b.maxPrice) return b.spacingDollars;
  }
  return STRIKE_SPACING[STRIKE_SPACING.length - 1].spacingDollars;
}

export interface StrikeLadder {
  /** Spacing used, in dollars. */
  spacingDollars: number;
  /** Strikes in microdollars (what `create_strike_market` expects), ascending. */
  strikesMicro: bigint[];
  /** Same strikes as whole/decimal dollars, for logging. */
  strikesDollars: number[];
}

/**
 * Produce a sane strike ladder around a reference price: round the reference to
 * the nearest spacing increment, then lay `strikesPerSide` strikes above and
 * below (the rounded reference itself is included as the center), all strictly
 * positive. Returns microdollar strikes for the program plus dollar values for
 * logging.
 */
export function computeStrikes(
  referencePrice: number,
  strikesPerSide = 3,
): StrikeLadder {
  if (!(referencePrice > 0) || !Number.isFinite(referencePrice)) {
    throw new Error(`reference price must be a positive finite number, got ${referencePrice}`);
  }
  if (!Number.isInteger(strikesPerSide) || strikesPerSide < 0) {
    throw new Error(`strikesPerSide must be a non-negative integer, got ${strikesPerSide}`);
  }

  const spacing = spacingForPrice(referencePrice);
  const center = Math.round(referencePrice / spacing) * spacing;

  const dollars: number[] = [];
  for (let i = -strikesPerSide; i <= strikesPerSide; i++) {
    const strike = center + i * spacing;
    if (strike > 0) dollars.push(Number(strike.toFixed(6)));
  }
  // Dedupe (rounding near zero) and sort ascending.
  const unique = [...new Set(dollars)].sort((a, b) => a - b);

  return {
    spacingDollars: spacing,
    strikesDollars: unique,
    strikesMicro: unique.map((d) => BigInt(Math.round(d * MICRO))),
  };
}
