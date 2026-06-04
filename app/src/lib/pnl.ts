// Pure P&L math for the Portfolio page (U9). No React, no I/O — every function
// here is a deterministic transform so it can be unit-tested in the node vitest
// env.
//
// Pricing conventions (reused from `marketsView.ts` / `format.ts`):
//   - A "price" here is a per-share value as a $0–$1 fraction (a Yes or No
//     contract pays out exactly $1.00 when it wins, $0.00 when it loses).
//   - `qty` is the number of contracts held, in whole base units (the Yes/No
//     mints are 6-decimal; the caller converts microunits → whole contracts
//     before calling, so 1.0 here means one $1-payout contract).
//
// Entry-basis approximation
// --------------------------
// The program emits no fill events, and reconstructing every taker's exact
// average fill price from raw transaction data is out of scope (and lossy: a
// mint-pair has no "price", only a $0.50/$0.50 implicit split). So the entry
// basis is supplied by the caller with a documented fallback order:
//
//   1. If the position came purely from `mint_pair`, entry = $0.50/contract
//      (the mint splits $1 of USDC into one Yes + one No, so each leg's cost
//      basis is $0.50). This is exact for mint-only positions.
//   2. Otherwise we approximate entry with the *current* book price (best ask)
//      when the Portfolio first observes the position. This is an approximation, not
//      a ledger — it understates realized edge but never fabricates a price.
//
// `computePnl` itself is agnostic to where `entryPrice` came from; the
// approximation lives at the call site (Portfolio page) and is labelled in the
// UI as "est." when it is not the exact mint basis.

import type { MarketView, Outcome } from "./market";

/** Implicit per-leg cost basis of a mint_pair leg: $1 split into Yes + No. */
export const MINT_PAIR_LEG_BASIS = 0.5;

export type PositionSide = "yes" | "no";

export interface PnlResult {
  /** Value of the position now, in dollars (qty × currentPrice). */
  currentValue: number;
  /** Cost basis, in dollars (qty × entryPrice). */
  costBasis: number;
  /** Absolute P&L in dollars (currentValue − costBasis). */
  pnl: number;
  /** P&L as a fraction of cost basis (e.g. 0.25 = +25%); null if basis is 0. */
  pnlPct: number | null;
}

/**
 * The settled value of a single contract on `side`: the winner resolves to
 * $1.00, the loser to $0.00. Returns null when the market is not settled (or
 * has no recorded outcome) — the caller should fall back to a live/book price.
 */
export function settledContractValue(
  side: PositionSide,
  outcome: Outcome,
): number | null {
  if (outcome === null) return null;
  const sideWins =
    (side === "yes" && outcome === "yesWins") ||
    (side === "no" && outcome === "noWins");
  return sideWins ? 1 : 0;
}

/**
 * The per-contract current price to value a position at:
 *   - settled market → $1 (winner) or $0 (loser),
 *   - otherwise → the supplied live price ($0–$1 fraction).
 * `livePrice` may be null (no quotable price); then an unsettled position has no
 * current price and we treat it as 0 for valuation but flag it via the null we
 * return so the UI can render "—".
 */
export function currentContractPrice(
  side: PositionSide,
  market: Pick<MarketView, "settled" | "outcome">,
  livePrice: number | null,
): number | null {
  if (market.settled) {
    const v = settledContractValue(side, market.outcome);
    if (v !== null) return v;
  }
  return livePrice;
}

/**
 * Core P&L: given a per-contract entry price, a per-contract current price, and
 * a contract quantity, compute value / basis / P&L / P&L%. All prices are $0–$1
 * fractions; `qty` is whole contracts. Pure.
 */
export function computePnl(
  qty: number,
  entryPrice: number,
  currentPrice: number,
): PnlResult {
  const currentValue = qty * currentPrice;
  const costBasis = qty * entryPrice;
  const pnl = currentValue - costBasis;
  const pnlPct = costBasis === 0 ? null : pnl / costBasis;
  return { currentValue, costBasis, pnl, pnlPct };
}

// ---- Portfolio filter / decision helpers (pure, tested) --------------------

/** One Yes-or-No holding the Portfolio page enumerates across markets. */
export interface Holding {
  market: MarketView;
  side: PositionSide;
  /** Token base units held (6-decimal mint units). */
  amount: bigint;
}

/**
 * Portfolio shows only positions the wallet actually holds — drop any holding
 * with a zero balance. Pure: takes the raw per-side holdings, returns the
 * non-empty ones, preserving order.
 */
export function visiblePositions(holdings: Holding[]): Holding[] {
  return holdings.filter((h) => h.amount > 0n);
}

/**
 * The redeem button shows only on settled markets (with a recorded outcome) —
 * an unsettled or outcome-less market can't pay out yet. Pure.
 */
export function canRedeem(
  market: Pick<MarketView, "settled" | "outcome">,
): boolean {
  return market.settled && market.outcome !== null;
}

/**
 * Share count from token base units. The system trades in whole-share integers
 * (1 base unit = 1 share); the Yes/No mints' declared 6 decimals are unused
 * metadata. Price/USDC are scaled by 1e6 elsewhere — quantity is NOT.
 */
export function sharesFromBaseUnits(baseUnits: bigint): number {
  return Number(baseUnits);
}

/** Format a $0–$1-or-more dollar amount as "$1.23" (2 dp, sign-preserving). */
export function fmtDollars(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

/** Format a signed P&L like "+$0.42" / "-$0.10". */
export function fmtSignedDollars(amount: number): string {
  const sign = amount >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

/** Format a P&L fraction as a signed percent like "+25.0%"; "—" when null. */
export function fmtPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  const sign = pct >= 0 ? "+" : "-";
  return `${sign}${(Math.abs(pct) * 100).toFixed(1)}%`;
}
