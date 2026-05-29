import { describe, expect, it } from "vitest";

import {
  ONE_USDC,
  noPriceFromYes,
  positionGuardDecision,
  resolveTradePath,
  toNoView,
  yesPriceFromNo,
  type Balances,
} from "@/lib/tradePaths";
import { SIDE_ASK, SIDE_BID } from "@/lib/matching";
import type { BookView } from "@/lib/market";

// ---------------------------------------------------------------------------
// Price-space mapping. Book prices are Yes prices in USDC microunits per Yes
// base unit (0..1_000_000 ↔ $0..$1). The No price for the same level is
// 1 − yesPrice in the same microunit space.
// ---------------------------------------------------------------------------

describe("No-side price mapping (price = 1 − yesPrice)", () => {
  it("ONE_USDC is one dollar in microunits", () => {
    expect(ONE_USDC).toBe(1_000_000n);
  });

  it("noPriceFromYes is 1 − yes in microunits", () => {
    expect(noPriceFromYes(600_000n)).toBe(400_000n); // Yes $0.60 → No $0.40
    expect(noPriceFromYes(400_000n)).toBe(600_000n);
    expect(noPriceFromYes(0n)).toBe(1_000_000n);
    expect(noPriceFromYes(1_000_000n)).toBe(0n);
  });

  it("yesPriceFromNo is the inverse of noPriceFromYes", () => {
    expect(yesPriceFromNo(400_000n)).toBe(600_000n);
    expect(yesPriceFromNo(600_000n)).toBe(400_000n);
    for (const p of [1n, 250_000n, 500_000n, 999_999n]) {
      expect(yesPriceFromNo(noPriceFromYes(p))).toBe(p);
    }
  });
});

// ---------------------------------------------------------------------------
// The four trade paths → instruction + args + (where relevant) the Yes-leg
// price bound. Confirmed against the on-chain handlers:
//   * Buy Yes  = bid taker  (place_*_order, side=Bid),  price = Yes price.
//   * Sell Yes = ask taker  (place_*_order, side=Ask),  price = Yes price.
//   * Buy No   = buy_no  (mint pair + market-sell Yes),
//                min_yes_sell_price = 1 − noPrice  (engine crosses with >=).
//   * Sell No  = sell_no (market-buy Yes + burn pair),
//                max_yes_buy_price  = 1 − noPrice  (engine crosses with <=).
// ---------------------------------------------------------------------------

describe("resolveTradePath — Buy/Sell Yes", () => {
  it("Buy Yes (limit) → place_limit_order, Bid, Yes price unchanged", () => {
    const p = resolveTradePath({
      action: "buyYes",
      orderType: "limit",
      price: 620_000n,
      qty: 100n,
    });
    expect(p.instruction).toBe("placeLimitOrder");
    expect(p.side).toBe(SIDE_BID);
    expect(p.args).toEqual({ side: SIDE_BID, price: 620_000n, qty: 100n });
    // The Yes-leg price the matching/remaining-accounts planner should use.
    expect(p.yesLegPrice).toBe(620_000n);
  });

  it("Buy Yes (market) → place_market_order, Bid, slippageBound = price", () => {
    const p = resolveTradePath({
      action: "buyYes",
      orderType: "market",
      price: 620_000n,
      qty: 100n,
    });
    expect(p.instruction).toBe("placeMarketOrder");
    expect(p.side).toBe(SIDE_BID);
    expect(p.args).toEqual({ side: SIDE_BID, slippageBound: 620_000n, qty: 100n });
    expect(p.yesLegPrice).toBe(620_000n);
  });

  it("Sell Yes (limit) → place_limit_order, Ask, Yes price unchanged", () => {
    const p = resolveTradePath({
      action: "sellYes",
      orderType: "limit",
      price: 580_000n,
      qty: 50n,
    });
    expect(p.instruction).toBe("placeLimitOrder");
    expect(p.side).toBe(SIDE_ASK);
    expect(p.args).toEqual({ side: SIDE_ASK, price: 580_000n, qty: 50n });
    expect(p.yesLegPrice).toBe(580_000n);
  });

  it("Sell Yes (market) → place_market_order, Ask, slippageBound = price", () => {
    const p = resolveTradePath({
      action: "sellYes",
      orderType: "market",
      price: 580_000n,
      qty: 50n,
    });
    expect(p.instruction).toBe("placeMarketOrder");
    expect(p.side).toBe(SIDE_ASK);
    expect(p.args).toEqual({ side: SIDE_ASK, slippageBound: 580_000n, qty: 50n });
    // The Yes-leg price (== input price for a Sell Yes market path).
    expect(p.yesLegPrice).toBe(580_000n);
  });
});

describe("resolveTradePath — Buy No → buy_no (atomic mint-pair + sell Yes)", () => {
  it("maps a No price to the Yes-leg min sell bound (1 − noPrice), Ask side", () => {
    // Buy No @ $0.40 → the Yes leg must sell for at least $0.60.
    const p = resolveTradePath({ action: "buyNo", price: 400_000n, qty: 100n });
    expect(p.instruction).toBe("buyNo");
    // The internal Yes market-sell is an Ask taker (so remaining-accounts are
    // maker Yes ATAs, planned against the bid side).
    expect(p.side).toBe(SIDE_ASK);
    expect(p.args).toEqual({ amount: 100n, minYesSellPrice: 600_000n });
    // The price the fill planner crosses the *bid* side at.
    expect(p.yesLegPrice).toBe(600_000n);
  });

  it("Buy No @ $0.62 → min Yes sell price $0.38", () => {
    const p = resolveTradePath({ action: "buyNo", price: 620_000n, qty: 1n });
    expect(p.args).toEqual({ amount: 1n, minYesSellPrice: 380_000n });
  });
});

describe("resolveTradePath — Sell No → sell_no (atomic buy Yes + burn pair)", () => {
  it("maps a No price to the Yes-leg max buy bound (1 − noPrice), Bid side", () => {
    // Sell No @ $0.40 → the Yes leg may buy for at most $0.60.
    const p = resolveTradePath({ action: "sellNo", price: 400_000n, qty: 100n });
    expect(p.instruction).toBe("sellNo");
    // The internal Yes market-buy is a Bid taker (remaining-accounts are maker
    // USDC ATAs, planned against the ask side).
    expect(p.side).toBe(SIDE_BID);
    expect(p.args).toEqual({ amount: 100n, maxYesBuyPrice: 600_000n });
    expect(p.yesLegPrice).toBe(600_000n);
  });

  it("Sell No @ $0.38 → max Yes buy price $0.62", () => {
    const p = resolveTradePath({ action: "sellNo", price: 380_000n, qty: 7n });
    expect(p.args).toEqual({ amount: 7n, maxYesBuyPrice: 620_000n });
  });
});

describe("resolveTradePath — input validation", () => {
  it("rejects a No price outside (0, ONE)", () => {
    expect(() => resolveTradePath({ action: "buyNo", price: 0n, qty: 1n })).toThrow();
    expect(() =>
      resolveTradePath({ action: "buyNo", price: 1_000_000n, qty: 1n }),
    ).toThrow();
    expect(() =>
      resolveTradePath({ action: "sellNo", price: 1_000_001n, qty: 1n }),
    ).toThrow();
  });
  it("rejects a non-positive qty", () => {
    expect(() =>
      resolveTradePath({ action: "buyYes", orderType: "limit", price: 1n, qty: 0n }),
    ).toThrow();
  });
  it("rejects a non-positive Yes price", () => {
    expect(() =>
      resolveTradePath({ action: "buyYes", orderType: "limit", price: 0n, qty: 1n }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Position guard (PRD §142–144): no holding both Yes and No from trading.
// ---------------------------------------------------------------------------

describe("positionGuardDecision", () => {
  const bal = (yes: bigint, no: bigint): Balances => ({ usdc: 0n, yes, no });

  it("holding neither allows both buys", () => {
    const d = positionGuardDecision(bal(0n, 0n));
    expect(d.buyYes.allowed).toBe(true);
    expect(d.buyNo.allowed).toBe(true);
    expect(d.sellYes.allowed).toBe(false); // nothing to sell
    expect(d.sellNo.allowed).toBe(false);
  });

  it("holding No disables Buy Yes with the 'sell No first' prompt", () => {
    const d = positionGuardDecision(bal(0n, 100n));
    expect(d.buyYes.allowed).toBe(false);
    expect(d.buyYes.reason).toMatch(/sell No first/i);
    expect(d.buyNo.allowed).toBe(true); // can add to the No position
    expect(d.sellNo.allowed).toBe(true); // can exit the No position
    expect(d.sellYes.allowed).toBe(false);
  });

  it("holding Yes disables Buy No with the 'sell Yes first' prompt", () => {
    const d = positionGuardDecision(bal(100n, 0n));
    expect(d.buyNo.allowed).toBe(false);
    expect(d.buyNo.reason).toMatch(/sell Yes first/i);
    expect(d.buyYes.allowed).toBe(true);
    expect(d.sellYes.allowed).toBe(true);
    expect(d.sellNo.allowed).toBe(false);
  });

  it("transient both-held (mid mint-pair) does not hard-block exits", () => {
    // Holding both is only transient; we must still let the user unwind either
    // leg rather than dead-locking them.
    const d = positionGuardDecision(bal(100n, 100n));
    expect(d.sellYes.allowed).toBe(true);
    expect(d.sellNo.allowed).toBe(true);
    // New entries that would deepen an opposing imbalance are blocked.
    expect(d.buyYes.allowed).toBe(false);
    expect(d.buyNo.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Both-sides book transform: the ONE on-chain book rendered from the No view.
// A resting Yes bid is a No ask at (1 − price); a resting Yes ask is a No bid.
// ---------------------------------------------------------------------------

describe("toNoView", () => {
  function lvl(price: bigint, qty: bigint) {
    return { price, qty, seq: 0n, owner: { toBase58: () => "x" } as never };
  }

  it("a single resting Yes ask renders as a No bid at 1 − price", () => {
    const book: BookView = {
      bids: [],
      asks: [lvl(640_000n, 5n)],
      nextSeq: 1n,
    };
    const no = toNoView(book);
    // The Yes ask becomes a No bid at $0.36 (= 1 − $0.64), same qty.
    expect(no.bids).toHaveLength(1);
    expect(no.bids[0].price).toBe(360_000n);
    expect(no.bids[0].qty).toBe(5n);
    expect(no.asks).toHaveLength(0);
  });

  it("a single resting Yes bid renders as a No ask at 1 − price", () => {
    const book: BookView = {
      bids: [lvl(600_000n, 3n)],
      asks: [],
      nextSeq: 1n,
    };
    const no = toNoView(book);
    expect(no.asks).toHaveLength(1);
    expect(no.asks[0].price).toBe(400_000n);
    expect(no.asks[0].qty).toBe(3n);
    expect(no.bids).toHaveLength(0);
  });

  it("maps an empty book to an empty No view", () => {
    const empty: BookView = { bids: [], asks: [], nextSeq: 0n };
    const no = toNoView(empty);
    expect(no.bids).toHaveLength(0);
    expect(no.asks).toHaveLength(0);
    expect(no.nextSeq).toBe(0n);
  });

  it("keeps No bids descending and No asks ascending (priority order)", () => {
    // Yes asks ascending [0.64, 0.70] → No bids should be descending [0.36, 0.30].
    // Yes bids descending [0.60, 0.55] → No asks should be ascending [0.40, 0.45].
    const book: BookView = {
      bids: [lvl(600_000n, 1n), lvl(550_000n, 1n)],
      asks: [lvl(640_000n, 1n), lvl(700_000n, 1n)],
      nextSeq: 1n,
    };
    const no = toNoView(book);
    expect(no.bids.map((l) => l.price)).toEqual([360_000n, 300_000n]);
    expect(no.asks.map((l) => l.price)).toEqual([400_000n, 450_000n]);
  });
});
