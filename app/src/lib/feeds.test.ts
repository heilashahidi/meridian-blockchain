import { describe, expect, it } from "vitest";

import {
  MAG7,
  MAG7_TICKERS,
  FEED_ID_BY_TICKER,
  TICKER_BY_FEED_ID,
  tickerForFeedId,
} from "./feeds";

describe("MAG7 feed map", () => {
  it("has exactly the seven expected tickers", () => {
    expect([...MAG7_TICKERS].sort()).toEqual(
      ["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA"].sort(),
    );
  });

  it("every feed id is 64 lowercase hex chars with no 0x prefix", () => {
    for (const f of MAG7) {
      expect(f.feedId).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("symbols follow the Equity.US.<TICKER>/USD convention", () => {
    for (const f of MAG7) {
      expect(f.symbol).toBe(`Equity.US.${f.ticker}/USD`);
    }
  });

  it("ticker↔feed-id maps are consistent inverses", () => {
    for (const f of MAG7) {
      expect(FEED_ID_BY_TICKER[f.ticker]).toBe(f.feedId);
      expect(TICKER_BY_FEED_ID[f.feedId]).toBe(f.ticker);
    }
  });

  it("tickerForFeedId resolves with or without a 0x prefix, else null", () => {
    expect(tickerForFeedId(FEED_ID_BY_TICKER.AAPL)).toBe("AAPL");
    expect(tickerForFeedId(`0x${FEED_ID_BY_TICKER.AAPL}`)).toBe("AAPL");
    expect(tickerForFeedId(FEED_ID_BY_TICKER.AAPL.toUpperCase())).toBe("AAPL");
    expect(tickerForFeedId("00".repeat(32))).toBeNull();
  });
});
