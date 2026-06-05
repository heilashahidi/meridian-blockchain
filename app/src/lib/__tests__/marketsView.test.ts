import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import type { BookView, MarketView } from "@/lib/market";
import {
  fractionUsd,
  groupActiveByTicker,
  impliedProbabilityLabel,
  isActiveMarket,
  noFromYes,
  strikeDollars,
  strikesForTicker,
  tradeHref,
  yesAskFraction,
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
    expiryUnix: over.expiryUnix ?? 1_700_003_600n, // NOW + 1h — within the 0DTE board horizon
    settled: over.settled ?? false,
    outcome: over.outcome ?? null,
    yesMint: PublicKey.unique(),
    noMint: PublicKey.unique(),
  };
}

const NOW = 1_700_000_000; // a fixed "now" well before the default expiry

describe("strikesForTicker", () => {
  const DAY = 2_000_000_000n;
  const markets: MarketView[] = [
    mkMarket({ ticker: "AAPL", strikePrice: 240_000_000n, expiryUnix: DAY }),
    mkMarket({ ticker: "AAPL", strikePrice: 210_000_000n, expiryUnix: DAY }),
    mkMarket({ ticker: "AAPL", strikePrice: 230_000_000n, expiryUnix: DAY }),
    mkMarket({ ticker: "NVDA", strikePrice: 120_000_000n, expiryUnix: DAY }),
    // Same ticker, different trading day — excluded.
    mkMarket({ ticker: "AAPL", strikePrice: 220_000_000n, expiryUnix: DAY + 86_400n }),
  ];

  it("returns same-ticker, same-day strikes sorted ascending", () => {
    const aaplBytes = tickerBytes("AAPL");
    const ladder = strikesForTicker(markets, aaplBytes, DAY);
    expect(ladder.map((m) => m.strikePrice)).toEqual([
      210_000_000n,
      230_000_000n,
      240_000_000n,
    ]);
  });

  it("excludes other tickers and other expiries", () => {
    const ladder = strikesForTicker(markets, tickerBytes("AAPL"), DAY);
    expect(ladder.every((m) => m.expiryUnix === DAY)).toBe(true);
    expect(ladder).toHaveLength(3); // not the NVDA market, not the next-day AAPL
  });
});

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
  it("is inactive at the exact expiry boundary (expiry == now)", () => {
    // The gate is `expiryUnix > now`, so a market expiring exactly now is
    // already inactive (not tradeable at the close instant).
    expect(
      isActiveMarket(
        mkMarket({ ticker: "AAPL", expiryUnix: BigInt(NOW) }),
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

  it("sorts each stock's active strikes ascending by strike", () => {
    const groups = groupActiveByTicker(
      [
        mkMarket({ ticker: "AAPL", strikePrice: 240_000_000n }),
        mkMarket({ ticker: "AAPL", strikePrice: 210_000_000n }),
        mkMarket({ ticker: "AAPL", strikePrice: 230_000_000n }),
      ],
      NOW,
    );
    const aapl = groups.find((g) => g.ticker === "AAPL")!;
    expect(aapl.active.map((m) => m.strikePrice)).toEqual([
      210_000_000n,
      230_000_000n,
      240_000_000n,
    ]);
  });

  it("dedupes same-strike markets, keeping the nearest (earliest) future expiry", () => {
    const groups = groupActiveByTicker(
      [
        mkMarket({ ticker: "AAPL", strikePrice: 200_000_000n, expiryUnix: 1_700_003_600n }),
        mkMarket({ ticker: "AAPL", strikePrice: 200_000_000n, expiryUnix: 1_700_007_200n }),
      ],
      NOW,
    );
    const aapl = groups.find((g) => g.ticker === "AAPL")!;
    expect(aapl.active).toHaveLength(1);
    expect(aapl.active[0].expiryUnix).toBe(1_700_003_600n);
  });

  it("excludes far-out markets beyond the 0DTE horizon (the demo set)", () => {
    const groups = groupActiveByTicker(
      [
        mkMarket({ ticker: "AAPL", expiryUnix: 1_700_003_600n }), // today, ~1h out
        // 10 days out — a 6/15-style demo market; must NOT surface on the 0DTE board.
        mkMarket({ ticker: "AAPL", strikePrice: 210_000_000n, expiryUnix: BigInt(NOW + 10 * 86_400) }),
      ],
      NOW,
    );
    const aapl = groups.find((g) => g.ticker === "AAPL")!;
    expect(aapl.active).toHaveLength(1);
    expect(aapl.active[0].expiryUnix).toBe(1_700_003_600n);
  });
});

describe("yesAskFraction", () => {
  function book(bids: bigint[], asks: bigint[]): BookView {
    const lvl = (price: bigint) => ({
      price,
      seq: 0n,
      owner: PublicKey.unique(),
      qty: 1n,
    });
    return { bids: bids.map(lvl), asks: asks.map(lvl), nextSeq: 0n };
  }

  it("returns the best (lowest) ask as a $0–$1 fraction (PRD §209)", () => {
    // best ask $0.64 → Yes price $0.64; the bid side does not affect it.
    expect(yesAskFraction(book([600_000n], [640_000n]))).toBeCloseTo(0.64, 6);
  });

  it("uses index 0 of the ask side as best (priority-ordered)", () => {
    const price = yesAskFraction(
      book([600_000n, 550_000n], [640_000n, 700_000n]),
    );
    expect(price).toBeCloseTo(0.64, 6);
  });

  it("prices an asks-only book (you can still buy Yes)", () => {
    expect(yesAskFraction(book([], [640_000n]))).toBeCloseTo(0.64, 6);
  });

  it("returns null when there is no ask to quote against", () => {
    expect(yesAskFraction(book([600_000n], []))).toBeNull(); // bids only
    expect(yesAskFraction(book([], []))).toBeNull();
    expect(yesAskFraction(null)).toBeNull();
  });
});

describe("impliedProbabilityLabel", () => {
  it("renders a Yes price of 0.62 as ~62%", () => {
    expect(impliedProbabilityLabel(0.62)).toBe("62%");
  });
  it("rounds to the nearest percent", () => {
    expect(impliedProbabilityLabel(0.625)).toBe("63%");
    expect(impliedProbabilityLabel(0.054)).toBe("5%");
  });
  it("renders a dash when there is no price", () => {
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

describe("fractionUsd", () => {
  it("formats a $0–$1 fraction as a 2dp dollar string", () => {
    expect(fractionUsd(0.62)).toBe("$0.62");
    expect(fractionUsd(0)).toBe("$0.00");
    expect(fractionUsd(1)).toBe("$1.00");
  });
});

describe("tradeHref", () => {
  it("builds /trade/<pda-base58> from the market pubkey", () => {
    const pk = PublicKey.unique();
    expect(tradeHref(pk)).toBe(`/trade/${pk.toBase58()}`);
  });
});
