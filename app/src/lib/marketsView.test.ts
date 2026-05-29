import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import type { BookView, MarketView } from "@/lib/market";
import {
  groupActiveByTicker,
  impliedProbabilityLabel,
  isActiveMarket,
  noFromYes,
  strikeDollars,
  tradeHref,
  yesMidFraction,
} from "@/lib/marketsView";

// Right-pad an ASCII ticker into the 8-byte on-chain layout `MarketView.ticker`.
function tickerBytes(s: string): number[] {
  const out = new Array(8).fill(0);
  for (let i = 0; i < s.length && i < 8; i++) out[i] = s.charCodeAt(i);
  return out;
}

function mkMarket(
  over: Omit<Partial<MarketView>, "ticker"> & { ticker: string },
): MarketView {
  return {
    pubkey: PublicKey.unique(),
    ticker: tickerBytes(over.ticker),
    strikePrice: over.strikePrice ?? 200_000_000n, // $200.00
    expiryUnix: over.expiryUnix ?? 2_000_000_000n,
    settled: over.settled ?? false,
    settledAt: 0n,
    outcome: over.outcome ?? null,
    yesMint: PublicKey.unique(),
    noMint: PublicKey.unique(),
  };
}

const NOW = 1_700_000_000; // a fixed "now" well before the default expiry

describe("isActiveMarket", () => {
  it("is active when unsettled and not yet expired", () => {
    expect(isActiveMarket(mkMarket({ ticker: "AAPL" }), NOW)).toBe(true);
  });
  it("is inactive when settled", () => {
    expect(
      isActiveMarket(mkMarket({ ticker: "AAPL", settled: true }), NOW),
    ).toBe(false);
  });
  it("is inactive when expired", () => {
    expect(
      isActiveMarket(
        mkMarket({ ticker: "AAPL", expiryUnix: BigInt(NOW - 1) }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("groupActiveByTicker", () => {
  it("buckets a mixed list by ticker and keeps all 7 stocks", () => {
    const markets = [
      mkMarket({ ticker: "AAPL", strikePrice: 200_000_000n }),
      mkMarket({ ticker: "AAPL", strikePrice: 210_000_000n }),
      mkMarket({ ticker: "TSLA" }),
      mkMarket({ ticker: "AAPL", settled: true }), // excluded: settled
      mkMarket({ ticker: "NVDA", expiryUnix: BigInt(NOW - 5) }), // excluded: expired
    ];
    const groups = groupActiveByTicker(markets, NOW);

    // All seven MAG7 tickers present, in display order.
    expect(groups.map((g) => g.ticker)).toEqual([
      "AAPL",
      "MSFT",
      "GOOGL",
      "AMZN",
      "NVDA",
      "META",
      "TSLA",
    ]);

    const byTicker = Object.fromEntries(groups.map((g) => [g.ticker, g]));
    expect(byTicker.AAPL.active).toHaveLength(2); // two active strikes
    expect(byTicker.TSLA.active).toHaveLength(1);
    expect(byTicker.NVDA.active).toHaveLength(0); // expired one excluded
    expect(byTicker.MSFT.active).toHaveLength(0); // no markets at all
  });

  it("renders stocks with no active markets as empty (no active contracts)", () => {
    const groups = groupActiveByTicker([], NOW);
    expect(groups).toHaveLength(7);
    expect(groups.every((g) => g.active.length === 0)).toBe(true);
  });

  it("ignores non-MAG7 tickers", () => {
    const groups = groupActiveByTicker([mkMarket({ ticker: "SPY" })], NOW);
    expect(groups.reduce((n, g) => n + g.active.length, 0)).toBe(0);
  });

  it("sorts each stock's active strikes by expiry ascending", () => {
    const groups = groupActiveByTicker(
      [
        mkMarket({ ticker: "AAPL", expiryUnix: 2_100_000_000n }),
        mkMarket({ ticker: "AAPL", expiryUnix: 2_000_000_000n }),
      ],
      NOW,
    );
    const aapl = groups.find((g) => g.ticker === "AAPL")!;
    expect(aapl.active.map((m) => m.expiryUnix)).toEqual([
      2_000_000_000n,
      2_100_000_000n,
    ]);
  });
});

describe("yesMidFraction", () => {
  function book(bids: bigint[], asks: bigint[]): BookView {
    const lvl = (price: bigint) => ({
      price,
      seq: 0n,
      owner: PublicKey.unique(),
      qty: 1n,
    });
    return { bids: bids.map(lvl), asks: asks.map(lvl), nextSeq: 0n };
  }

  it("computes (bestBid+bestAsk)/2 as a $0–$1 fraction", () => {
    // best bid $0.60, best ask $0.64 → mid $0.62
    expect(yesMidFraction(book([600_000n], [640_000n]))).toBeCloseTo(0.62, 6);
  });

  it("uses index 0 of each side as best (priority-ordered)", () => {
    const mid = yesMidFraction(
      book([600_000n, 550_000n], [640_000n, 700_000n]),
    );
    expect(mid).toBeCloseTo(0.62, 6);
  });

  it("returns null for a one-sided or empty book", () => {
    expect(yesMidFraction(book([600_000n], []))).toBeNull();
    expect(yesMidFraction(book([], [640_000n]))).toBeNull();
    expect(yesMidFraction(book([], []))).toBeNull();
    expect(yesMidFraction(null)).toBeNull();
  });
});

describe("impliedProbabilityLabel", () => {
  it("renders a Yes mid of 0.62 as ~62%", () => {
    expect(impliedProbabilityLabel(0.62)).toBe("62%");
  });
  it("rounds to the nearest percent", () => {
    expect(impliedProbabilityLabel(0.625)).toBe("63%");
    expect(impliedProbabilityLabel(0.054)).toBe("5%");
  });
  it("renders a dash when there is no mid", () => {
    expect(impliedProbabilityLabel(null)).toBe("—");
  });
});

describe("noFromYes", () => {
  it("is 1 − yes", () => {
    expect(noFromYes(0.62)).toBeCloseTo(0.38, 6);
  });
});

describe("strikeDollars", () => {
  it("formats microunits as a dollar string", () => {
    expect(strikeDollars(200_000_000n)).toBe("200.00");
    expect(strikeDollars(1_234_500_000n)).toBe("1,234.50");
  });
});

describe("tradeHref", () => {
  it("builds /trade/<pda-base58> from the market pubkey", () => {
    const pk = PublicKey.unique();
    expect(tradeHref(pk)).toBe(`/trade/${pk.toBase58()}`);
  });
});
