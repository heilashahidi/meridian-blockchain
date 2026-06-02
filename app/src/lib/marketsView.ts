// Pure view-model helpers for the Markets page (U7). Extracted from the React
// components so the grouping / pricing / routing logic is unit-testable in the
// node vitest env (no component-render harness exists).
//
// Conventions reused from the read layer (`market.ts`) and `format.ts`:
//   - `MarketView.strikePrice` is in USDC microunits (6-decimal), like the
//     scripts' `strikeMicro = dollars * 1_000_000`.
//   - `MarketView.expiryUnix` is unix seconds.
//   - Book `BookLevel.price` (from `fetchBook`) is USDC microunits per Yes base
//     unit, i.e. a Yes price in [0, 1_000_000] microunits ↔ $0.00–$1.00.

import type { BookView, MarketView } from "./market";
import { MAG7 } from "./feeds";
import { tickerToString, USDC_DECIMALS } from "./format";

/** USDC microunits per whole dollar (6-decimal mints). */
const USDC_SCALE = 10 ** USDC_DECIMALS;

/** A market is "active" if it is unsettled and has not yet expired. */
export function isActiveMarket(m: MarketView, nowUnix: number): boolean {
  return !m.settled && m.expiryUnix > BigInt(Math.floor(nowUnix));
}

/**
 * The Yes mid price as a $0–$1 fraction, derived from the book:
 *   mid = (bestBid + bestAsk) / 2, where best bid is the highest bid and best
 *   ask is the lowest ask. `fetchBook` returns bids in descending and asks in
 *   ascending priority order, so the best of each side is index 0.
 *
 * Returns null when the book is one-sided or empty (no derivable mid).
 */
export function yesMidFraction(book: BookView | null): number | null {
  if (!book) return null;
  const bestBid = book.bids.length > 0 ? book.bids[0].price : null;
  const bestAsk = book.asks.length > 0 ? book.asks[0].price : null;
  if (bestBid === null || bestAsk === null) return null;
  const midMicro = (Number(bestBid) + Number(bestAsk)) / 2;
  return midMicro / USDC_SCALE;
}

/** No price = 1 − Yes price (the same book viewed from the No perspective). */
export function noFromYes(yes: number): number {
  return 1 - yes;
}

/**
 * Implied probability of the Yes outcome, as a percent string like "62%".
 * A Yes mid of 0.62 → "62%". Returns "—" when there's no mid.
 */
export function impliedProbabilityLabel(yesFraction: number | null): string {
  if (yesFraction === null || !Number.isFinite(yesFraction)) return "—";
  const pct = Math.round(yesFraction * 100);
  return `${pct}%`;
}

/** Strike price (microunits) → human dollar string, e.g. "200.00". */
export function strikeDollars(strikeMicro: bigint): string {
  return (Number(strikeMicro) / USDC_SCALE).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** A $0–$1 fraction as a cents string, e.g. 0.62 → "$0.62". */
export function fractionUsd(fraction: number): string {
  return `$${fraction.toFixed(2)}`;
}

/** The Trade route for a market — its PDA base58 is the `[market]` route param. */
export function tradeHref(marketPubkey: { toBase58(): string }): string {
  return `/trade/${marketPubkey.toBase58()}`;
}

/**
 * The sibling strike markets for one ticker on one expiry (the day's strike
 * ladder), sorted by strike ascending. Powers the Trade screen's strike list so
 * a user can switch strikes for the selected stock without going back to Markets
 * (PRD §300). Matching on `expiryUnix` keeps the list to a single trading day.
 */
export function strikesForTicker(
  markets: MarketView[],
  ticker: number[],
  expiryUnix: bigint,
): MarketView[] {
  const want = tickerToString(ticker);
  return markets
    .filter(
      (m) => tickerToString(m.ticker) === want && m.expiryUnix === expiryUnix,
    )
    .sort((a, b) => Number(a.strikePrice - b.strikePrice));
}

export interface StockGroup {
  ticker: string;
  /** Active (unsettled, unexpired) markets for this ticker, expiry-ascending. */
  active: MarketView[];
}

/**
 * Group the on-chain market list by ticker into one entry per MAG7 stock, in
 * MAG7 display order. Every stock appears (even with no markets) so the grid is
 * stable; only active markets are bucketed. Markets whose ticker is not a MAG7
 * stock are ignored. Within a ticker, markets are deduplicated by strike —
 * keeping the one with the NEAREST (earliest) future expiry — so when a strike
 * has both a same-day contract and a longer-dated one, the soonest-settling
 * (the active 0DTE board) is what renders, never a stale longer-dated twin.
 * Strikes are returned ascending.
 */
export function groupActiveByTicker(
  markets: MarketView[],
  nowUnix: number,
): StockGroup[] {
  const buckets = new Map<string, MarketView[]>();
  for (const f of MAG7) buckets.set(f.ticker, []);

  for (const m of markets) {
    if (!isActiveMarket(m, nowUnix)) continue;
    const ticker = tickerToString(m.ticker);
    const bucket = buckets.get(ticker);
    if (!bucket) continue; // non-MAG7 ticker — ignore
    bucket.push(m);
  }

  return MAG7.map((f) => {
    // Dedupe by strike, keeping the nearest (earliest) future-expiry market for
    // each strike. All candidates are active (expiry > now), so the smallest
    // expiry is the soonest-settling contract — the one a 0DTE board should show.
    const byStrike = new Map<string, MarketView>();
    for (const m of buckets.get(f.ticker) ?? []) {
      const k = m.strikePrice.toString();
      const cur = byStrike.get(k);
      if (!cur || m.expiryUnix < cur.expiryUnix) byStrike.set(k, m);
    }
    const active = [...byStrike.values()].sort(
      (a, b) => Number(a.strikePrice - b.strikePrice),
    );
    return { ticker: f.ticker, active };
  });
}
