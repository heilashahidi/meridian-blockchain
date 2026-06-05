import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import type { MarketView } from "@/lib/market";
import {
  canRedeem,
  computePnl,
  sharesFromBaseUnits,
  currentContractPrice,
  fmtDollars,
  fmtPct,
  fmtSignedDollars,
  type Holding,
  MINT_PAIR_LEG_BASIS,
  settledContractValue,
  visiblePositions,
} from "@/lib/pnl";

function mkMarket(over: Partial<MarketView> = {}): MarketView {
  return {
    pubkey: PublicKey.unique(),
    ticker: [65, 65, 80, 76, 0, 0, 0, 0], // "AAPL"
    strikePrice: 200_000_000n,
    expiryUnix: 2_000_000_000n,
    settled: over.settled ?? false,
    outcome: over.outcome ?? null,
    yesMint: PublicKey.unique(),
    noMint: PublicKey.unique(),
    ...over,
  };
}

describe("computePnl", () => {
  it("computes value, basis, P&L and % for a gain", () => {
    // bought 10 contracts at $0.40, now worth $0.60 each
    const r = computePnl(10, 0.4, 0.6);
    expect(r.costBasis).toBeCloseTo(4);
    expect(r.currentValue).toBeCloseTo(6);
    expect(r.pnl).toBeCloseTo(2);
    expect(r.pnlPct).toBeCloseTo(0.5); // +50%
  });

  it("computes a loss with negative P&L and %", () => {
    const r = computePnl(10, 0.6, 0.4);
    expect(r.pnl).toBeCloseTo(-2);
    expect(r.pnlPct).toBeCloseTo(-1 / 3);
  });

  it("returns null % for a zero cost basis", () => {
    const r = computePnl(10, 0, 0.5);
    expect(r.pnlPct).toBeNull();
    expect(r.pnl).toBeCloseTo(5);
  });
});

describe("settledContractValue", () => {
  it("resolves a winning side to $1 and a losing side to $0", () => {
    expect(settledContractValue("yes", "yesWins")).toBe(1);
    expect(settledContractValue("no", "yesWins")).toBe(0);
    expect(settledContractValue("no", "noWins")).toBe(1);
    expect(settledContractValue("yes", "noWins")).toBe(0);
  });

  it("returns null when there is no outcome", () => {
    expect(settledContractValue("yes", null)).toBeNull();
  });
});

describe("currentContractPrice", () => {
  it("uses $1/$0 for a settled market regardless of live price", () => {
    const m = mkMarket({ settled: true, outcome: "yesWins" });
    expect(currentContractPrice("yes", m, 0.3)).toBe(1);
    expect(currentContractPrice("no", m, 0.7)).toBe(0);
  });

  it("uses the live price for an unsettled market", () => {
    const m = mkMarket();
    expect(currentContractPrice("yes", m, 0.42)).toBe(0.42);
  });

  it("returns null when unsettled and no live price", () => {
    expect(currentContractPrice("yes", mkMarket(), null)).toBeNull();
  });

  it("falls through to the live price when settled but the outcome is null", () => {
    // A settled market with no recorded outcome can't pay $1/$0, so we fall
    // back to the supplied live/mid price.
    const m = mkMarket({ settled: true, outcome: null });
    expect(currentContractPrice("yes", m, 0.5)).toBe(0.5);
  });
});

describe("settled winner/loser end-to-end P&L", () => {
  it("a mint-pair Yes leg that wins gains $0.50/contract", () => {
    const winner = settledContractValue("yes", "yesWins")!;
    const r = computePnl(10, MINT_PAIR_LEG_BASIS, winner);
    expect(r.currentValue).toBeCloseTo(10);
    expect(r.pnl).toBeCloseTo(5); // 10 × ($1.00 − $0.50)
    expect(r.pnlPct).toBeCloseTo(1); // +100%
  });

  it("a mint-pair No leg that loses goes to $0 (−$0.50/contract)", () => {
    const loser = settledContractValue("no", "yesWins")!;
    const r = computePnl(10, MINT_PAIR_LEG_BASIS, loser);
    expect(r.currentValue).toBe(0);
    expect(r.pnl).toBeCloseTo(-5);
    expect(r.pnlPct).toBeCloseTo(-1); // −100%
  });
});

describe("visiblePositions", () => {
  it("lists only holdings with a non-zero balance", () => {
    const m = mkMarket();
    const holdings: Holding[] = [
      { market: m, side: "yes", amount: 5_000_000n },
      { market: m, side: "no", amount: 0n },
    ];
    const visible = visiblePositions(holdings);
    expect(visible).toHaveLength(1);
    expect(visible[0].side).toBe("yes");
  });

  it("returns empty when the wallet holds nothing", () => {
    const m = mkMarket();
    expect(
      visiblePositions([{ market: m, side: "yes", amount: 0n }]),
    ).toHaveLength(0);
  });
});

describe("canRedeem", () => {
  it("is true only for a settled market with an outcome", () => {
    expect(canRedeem(mkMarket({ settled: true, outcome: "yesWins" }))).toBe(
      true,
    );
  });

  it("is false for an unsettled market", () => {
    expect(canRedeem(mkMarket())).toBe(false);
  });

  it("is false for a settled market with no outcome", () => {
    expect(canRedeem(mkMarket({ settled: true, outcome: null }))).toBe(false);
  });
});

describe("sharesFromBaseUnits", () => {
  it("treats 1 base unit as 1 share (no 1e6 divide)", () => {
    expect(sharesFromBaseUnits(5n)).toBe(5);
    expect(sharesFromBaseUnits(25n)).toBe(25);
    expect(sharesFromBaseUnits(0n)).toBe(0);
  });

  it("yields a non-zero portfolio value for a small holding (regression)", () => {
    // 5 Yes shares, entry $0.50/share, current $0.87/share.
    const qty = sharesFromBaseUnits(5n);
    const r = computePnl(qty, MINT_PAIR_LEG_BASIS, 0.87);
    expect(r.currentValue).toBeCloseTo(4.35, 6);
    expect(r.pnl).toBeCloseTo(1.85, 6);
  });
});

describe("formatters", () => {
  it("formats signed dollars and percent", () => {
    expect(fmtSignedDollars(2)).toBe("+$2.00");
    expect(fmtSignedDollars(-0.5)).toBe("-$0.50");
    expect(fmtPct(0.25)).toBe("+25.0%");
    expect(fmtPct(-0.333)).toBe("-33.3%");
    expect(fmtPct(null)).toBe("—");
  });

  it("formats unsigned dollars (no leading + for positives)", () => {
    expect(fmtDollars(2.5)).toBe("$2.50");
    expect(fmtDollars(-0.1)).toBe("-$0.10");
    expect(fmtDollars(0)).toBe("$0.00");
  });
});
