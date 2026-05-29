import { describe, expect, it } from "vitest";

import { distanceToStrike, payoffSummary } from "@/lib/marketStats";

describe("distanceToStrike", () => {
  it("is out-of-the-money when spot is below the strike (positive delta)", () => {
    const d = distanceToStrike(180, 200)!;
    expect(d.delta).toBe(20);
    expect(d.pct).toBeCloseTo((20 / 180) * 100, 6);
    expect(d.aboveStrike).toBe(false);
  });

  it("is in-the-money when spot is above the strike (negative delta)", () => {
    const d = distanceToStrike(220, 200)!;
    expect(d.delta).toBe(-20);
    expect(d.pct).toBeCloseTo((-20 / 220) * 100, 6);
    expect(d.aboveStrike).toBe(true);
  });

  it("treats spot exactly at the strike as above (in-the-money), delta 0", () => {
    const d = distanceToStrike(200, 200)!;
    expect(d.delta).toBe(0);
    expect(d.pct).toBe(0);
    expect(d.aboveStrike).toBe(true);
  });

  it("returns null for missing/invalid spot", () => {
    expect(distanceToStrike(null, 200)).toBeNull();
    expect(distanceToStrike(undefined, 200)).toBeNull();
    expect(distanceToStrike(0, 200)).toBeNull();
    expect(distanceToStrike(-5, 200)).toBeNull();
    expect(distanceToStrike(Number.NaN, 200)).toBeNull();
  });

  it("returns null for a non-finite strike", () => {
    expect(distanceToStrike(180, Number.NaN)).toBeNull();
  });
});

describe("payoffSummary", () => {
  it("computes cost/payout/return/maxLoss for a Buy Yes", () => {
    const s = payoffSummary({ action: "buyYes", priceDollars: 0.62, shares: 100 })!;
    expect(s.kind).toBe("buy");
    expect(s.side).toBe("yes");
    expect(s.cost).toBeCloseTo(62, 6);
    expect(s.payout).toBeCloseTo(100, 6);
    expect(s.returnPct).toBeCloseTo(((100 - 62) / 62) * 100, 6);
    expect(s.maxLoss).toBeCloseTo(62, 6);
  });

  it("marks Buy No on the no side with the same buy math", () => {
    const s = payoffSummary({ action: "buyNo", priceDollars: 0.4, shares: 50 })!;
    expect(s.kind).toBe("buy");
    expect(s.side).toBe("no");
    expect(s.cost).toBeCloseTo(20, 6);
    expect(s.payout).toBeCloseTo(50, 6);
    expect(s.returnPct).toBeCloseTo(((50 - 20) / 20) * 100, 6);
    expect(s.maxLoss).toBeCloseTo(20, 6);
  });

  it("computes proceeds for a Sell Yes (closing, not $1-settling)", () => {
    const s = payoffSummary({ action: "sellYes", priceDollars: 0.7, shares: 30 })!;
    expect(s.kind).toBe("sell");
    expect(s.side).toBe("yes");
    expect(s.proceeds).toBeCloseTo(21, 6);
  });

  it("computes proceeds for a Sell No", () => {
    const s = payoffSummary({ action: "sellNo", priceDollars: 0.25, shares: 80 })!;
    expect(s.kind).toBe("sell");
    expect(s.side).toBe("no");
    expect(s.proceeds).toBeCloseTo(20, 6);
  });

  it("returns null for non-positive or non-finite inputs", () => {
    expect(payoffSummary({ action: "buyYes", priceDollars: 0, shares: 100 })).toBeNull();
    expect(payoffSummary({ action: "buyYes", priceDollars: 0.5, shares: 0 })).toBeNull();
    expect(payoffSummary({ action: "buyYes", priceDollars: Number.NaN, shares: 10 })).toBeNull();
    expect(payoffSummary({ action: "buyYes", priceDollars: 0.5, shares: Number.NaN })).toBeNull();
  });
});
