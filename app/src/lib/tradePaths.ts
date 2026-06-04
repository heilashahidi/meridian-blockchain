// Pure trade-path routing + Yes/No price-space math for the Trade screen (U8).
//
// This module is intentionally framework-free (no React, no wallet, no Anchor)
// so the error-prone price mapping and instruction routing are fully unit-
// testable in the node vitest env. `actions.ts` consumes the resolved path to
// build the actual transaction; `TradePanel`/`PositionGuard` consume the pure
// helpers here for display + gating.
//
// -------------------------------------------------------------------------
// Price space
// -------------------------------------------------------------------------
// The on-chain book stores a single set of orders priced as **Yes** prices, in
// USDC microunits per Yes base unit (0..1_000_000 ↔ $0.00..$1.00). The No
// price for the same economic level is `1 − yesPrice` in that same microunit
// space (see `programs/.../buy_no.rs` / `sell_no.rs` and the $1 mint-pair
// invariant: one Yes + one No always costs exactly $1).
//
// -------------------------------------------------------------------------
// The four trade paths (confirmed against the on-chain handlers)
// -------------------------------------------------------------------------
//   Buy Yes  → place_limit_order / place_market_order, side = Bid.
//              Limit: { side, price, qty }. Market: { side, slippageBound, qty }.
//              `price`/`slippageBound` is the Yes price (max the buyer pays).
//
//   Sell Yes → place_limit_order / place_market_order, side = Ask.
//              `price`/`slippageBound` is the Yes price (min the seller takes).
//
//   Buy No   → buy_no (atomic: mint_pair `amount`, then MARKET-SELL the Yes leg).
//              The Yes sell leg is an **Ask taker**; its slippage floor is
//              `min_yes_sell_price` (engine crosses a maker bid with `>=`).
//              To buy No at price `q`, the Yes leg must sell for at least
//              `1 − q`, so:  min_yes_sell_price = ONE_USDC − noPrice.
//              (`buy_no.rs`: "min_yes_sell_price ... lowest price per Yes the
//              user will sell at. A maker ask at exactly this price still
//              crosses (the engine uses `>=`).")
//
//   Sell No  → sell_no (atomic: MARKET-BUY the Yes leg, then burn_pair `amount`).
//              The Yes buy leg is a **Bid taker**; its slippage cap is
//              `max_yes_buy_price` (engine crosses a maker ask with `<=`).
//              To sell No at price `q` (receive `q`), the Yes leg may buy for
//              at most `1 − q`, so:  max_yes_buy_price = ONE_USDC − noPrice.
//              (`sell_no.rs`: "max_yes_buy_price is the highest price-per-Yes
//              the taker accepts on the buy leg ... the engine uses `<=`.")
//
// Both No paths therefore use the SAME price reflection `yesLeg = ONE − no`;
// only the inequality DIRECTION differs (Buy No: a >= floor on the Yes sell;
// Sell No: a <= cap on the Yes buy), which is exactly the Ask vs Bid side of
// the internal Yes leg.

import { SIDE_ASK, SIDE_BID } from "./matching";

/** One dollar in USDC microunits — the full mint-pair cost / max price. */
export const ONE_USDC = 1_000_000n;

export type TradeAction = "buyYes" | "sellYes" | "buyNo" | "sellNo";
export type OrderType = "limit" | "market";

export type TradeInstruction =
  | "placeLimitOrder"
  | "placeMarketOrder"
  | "buyNo"
  | "sellNo";

export interface TradePathInput {
  action: TradeAction;
  /**
   * Order price in microunits. For Yes paths this is the Yes price; for No
   * paths this is the No price (it is reflected to a Yes-leg bound internally).
   */
  price: bigint;
  /** Quantity in Yes/No base units (a Yes/No pair shares one base unit). */
  qty: bigint;
  /** Only meaningful for the Yes paths; No paths are always market (atomic). */
  orderType?: OrderType;
}

/** Args for `place_limit_order`. */
export interface LimitArgs {
  side: number;
  price: bigint;
  qty: bigint;
}
/** Args for `place_market_order`. */
export interface MarketArgs {
  side: number;
  slippageBound: bigint;
  qty: bigint;
}
/** Args for `buy_no`. */
export interface BuyNoArgs {
  amount: bigint;
  minYesSellPrice: bigint;
}
/** Args for `sell_no`. */
export interface SellNoArgs {
  amount: bigint;
  maxYesBuyPrice: bigint;
}

export type TradeArgs = LimitArgs | MarketArgs | BuyNoArgs | SellNoArgs;

export interface TradePath {
  instruction: TradeInstruction;
  /**
   * The matching side of the order against the on-chain (Yes-priced) book —
   * used to plan crossing + maker remaining-accounts. For Buy No the internal
   * Yes leg is an Ask taker; for Sell No it is a Bid taker.
   */
  side: number;
  /**
   * The Yes-leg price the fill planner should cross at (microunits). For Yes
   * paths this equals the input price; for No paths it is `ONE − noPrice`.
   */
  yesLegPrice: bigint;
  args: TradeArgs;
}

/** No price = 1 − Yes price, in the same microunit space. */
export function noPriceFromYes(yes: bigint): bigint {
  return ONE_USDC - yes;
}

/** Yes price = 1 − No price (the inverse reflection). */
export function yesPriceFromNo(no: bigint): bigint {
  return ONE_USDC - no;
}

function assertPositiveQty(qty: bigint): void {
  if (qty <= 0n) throw new Error("qty must be positive");
}

function assertYesPrice(price: bigint): void {
  // The engine rejects price 0 (reserved OrderKey sentinel). We allow the full
  // 1..ONE range so the UI can place at the bounds.
  if (price <= 0n) throw new Error("Yes price must be > 0");
  if (price > ONE_USDC) throw new Error("Yes price must be <= $1.00");
}

function assertNoPrice(price: bigint): void {
  // No price reflects to a Yes-leg bound `ONE − price`; keep it strictly inside
  // (0, ONE) so the resulting Yes bound is also a valid (>0) price.
  if (price <= 0n) throw new Error("No price must be > 0");
  if (price >= ONE_USDC) throw new Error("No price must be < $1.00");
}

/**
 * Pure router: a trade-panel input → the instruction, matching side, Yes-leg
 * price (for fill planning) and the on-chain args. No I/O, no wallet.
 */
export function resolveTradePath(input: TradePathInput): TradePath {
  const { action, price, qty } = input;
  assertPositiveQty(qty);

  switch (action) {
    case "buyYes": {
      assertYesPrice(price);
      const orderType = input.orderType ?? "limit";
      return orderType === "market"
        ? {
            instruction: "placeMarketOrder",
            side: SIDE_BID,
            yesLegPrice: price,
            args: { side: SIDE_BID, slippageBound: price, qty },
          }
        : {
            instruction: "placeLimitOrder",
            side: SIDE_BID,
            yesLegPrice: price,
            args: { side: SIDE_BID, price, qty },
          };
    }

    case "sellYes": {
      assertYesPrice(price);
      const orderType = input.orderType ?? "limit";
      return orderType === "market"
        ? {
            instruction: "placeMarketOrder",
            side: SIDE_ASK,
            yesLegPrice: price,
            args: { side: SIDE_ASK, slippageBound: price, qty },
          }
        : {
            instruction: "placeLimitOrder",
            side: SIDE_ASK,
            yesLegPrice: price,
            args: { side: SIDE_ASK, price, qty },
          };
    }

    case "buyNo": {
      // Buy No @ noPrice → mint pair, market-SELL the Yes leg (Ask taker) with
      // a floor of `ONE − noPrice`. The Yes leg crosses the *bid* side.
      assertNoPrice(price);
      const minYesSellPrice = yesPriceFromNo(price);
      return {
        instruction: "buyNo",
        side: SIDE_ASK,
        yesLegPrice: minYesSellPrice,
        args: { amount: qty, minYesSellPrice },
      };
    }

    case "sellNo": {
      // Sell No @ noPrice → market-BUY the Yes leg (Bid taker) with a cap of
      // `ONE − noPrice`, then burn pair. The Yes leg crosses the *ask* side.
      assertNoPrice(price);
      const maxYesBuyPrice = yesPriceFromNo(price);
      return {
        instruction: "sellNo",
        side: SIDE_BID,
        yesLegPrice: maxYesBuyPrice,
        args: { amount: qty, maxYesBuyPrice },
      };
    }
  }
}

// -------------------------------------------------------------------------
// Position guard (PRD §142–144): trading must not leave a user holding BOTH
// Yes and No. Holding both is only transient (mid mint-pair).
// -------------------------------------------------------------------------

export interface Balances {
  usdc: bigint;
  yes: bigint;
  no: bigint;
}

export interface ActionGate {
  allowed: boolean;
  /** Why the action is blocked (for the UI), when not allowed. */
  reason?: string;
}

export interface GuardDecision {
  buyYes: ActionGate;
  sellYes: ActionGate;
  buyNo: ActionGate;
  sellNo: ActionGate;
}

/**
 * Pure guard decision from the wallet's Yes/No balances for this market.
 *
 *   - Holding No  → block Buy Yes ("sell No first"); Buy No / Sell No allowed.
 *   - Holding Yes → block Buy No  ("sell Yes first"); Buy Yes / Sell Yes allowed.
 *   - Holding both (transient mint-pair) → block BOTH new entries but still
 *     allow Sell Yes and Sell No so the user can always unwind a leg.
 *   - Sell actions require a balance on that side (nothing to sell otherwise).
 */
export function positionGuardDecision(balances: Balances): GuardDecision {
  const hasYes = balances.yes > 0n;
  const hasNo = balances.no > 0n;

  return {
    buyYes: hasNo
      ? { allowed: false, reason: "You hold No — sell No first to buy Yes." }
      : { allowed: true },
    buyNo: hasYes
      ? { allowed: false, reason: "You hold Yes — sell Yes first to buy No." }
      : { allowed: true },
    sellYes: hasYes
      ? { allowed: true }
      : { allowed: false, reason: "No Yes position to sell." },
    sellNo: hasNo
      ? { allowed: true }
      : { allowed: false, reason: "No No position to sell." },
  };
}
