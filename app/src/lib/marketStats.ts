// Pure display-stat helpers for the Trade screen redesign (PRD completion).
// Framework-free so the distance-to-strike and payoff/return math are
// unit-testable in the node vitest env. These are DISPLAY-ONLY calculations —
// they never touch trade execution (that lives in `tradePaths`/`actions`).

/** Distance of the live spot from the strike, in dollars and percent. */
export interface DistanceToStrike {
  /** strike − spot, in dollars. Positive when spot is below the strike. */
  delta: number;
  /** delta / spot * 100, in percent. Positive when spot is below the strike. */
  pct: number;
  /** True when spot >= strike (the Yes outcome is currently in-the-money). */
  aboveStrike: boolean;
}

/**
 * Pure distance-to-strike. `delta` is `strike − spot` so a positive delta means
 * the spot must rise to cross the strike (Yes out-of-the-money); a non-positive
 * delta means the spot is at/above the strike (Yes in-the-money). `pct` is the
 * move relative to the current spot. Returns null when inputs are unusable
 * (no spot, non-finite, or spot <= 0 so the percent would blow up).
 */
export function distanceToStrike(
  spot: number | null | undefined,
  strike: number,
): DistanceToStrike | null {
  if (spot == null || !Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(strike)) return null;
  const delta = strike - spot;
  const pct = (delta / spot) * 100;
  return { delta, pct, aboveStrike: spot >= strike };
}

export type PayoffAction = "buyYes" | "sellYes" | "buyNo" | "sellNo";

export interface PayoffSummaryInput {
  action: PayoffAction;
  /** Per-share price the user entered, in dollars ($0–$1). */
  priceDollars: number;
  /** Whole shares (contracts). */
  shares: number;
}

/**
 * Pure payoff/return summary for the entered trade. A binary contract settles
 * to $1.00 (win) or $0 (loss).
 *
 * BUY (buyYes/buyNo): the user pays `cost = shares * price` now and the position
 *   pays `payout = shares * 1.00` if it wins.
 *     - returnPct = (payout − cost) / cost * 100  (the upside on capital at risk)
 *     - maxLoss   = cost                          (the premium, lost if it loses)
 *
 * SELL (sellYes/sellNo): the user is closing/quoting and receives
 *   `proceeds = shares * price` now (a sale, not a $1-settling position).
 *
 * Returns null when inputs are not a usable positive trade.
 */
export interface PayoffSummary {
  /** Discriminates how the UI should render the line. */
  kind: "buy" | "sell";
  /** Which outcome the trade is on — drives the win condition wording. */
  side: "yes" | "no";
  /** BUY: dollars paid now (= maxLoss). */
  cost: number;
  /** BUY: dollars received if the position wins. */
  payout: number;
  /** BUY: percent return on capital at risk if it wins. */
  returnPct: number;
  /** BUY: most that can be lost (= cost). */
  maxLoss: number;
  /** SELL: dollars received now from closing. */
  proceeds: number;
}

export function payoffSummary(
  input: PayoffSummaryInput,
): PayoffSummary | null {
  const { action, priceDollars, shares } = input;
  if (
    !Number.isFinite(priceDollars) ||
    !Number.isFinite(shares) ||
    priceDollars <= 0 ||
    shares <= 0
  ) {
    return null;
  }

  const side: "yes" | "no" =
    action === "buyNo" || action === "sellNo" ? "no" : "yes";
  const isBuy = action === "buyYes" || action === "buyNo";

  if (isBuy) {
    const cost = shares * priceDollars;
    const payout = shares * 1.0;
    const returnPct = ((payout - cost) / cost) * 100;
    return {
      kind: "buy",
      side,
      cost,
      payout,
      returnPct,
      maxLoss: cost,
      proceeds: 0,
    };
  }

  const proceeds = shares * priceDollars;
  return {
    kind: "sell",
    side,
    cost: 0,
    payout: 0,
    returnPct: 0,
    maxLoss: 0,
    proceeds,
  };
}
