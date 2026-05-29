import { describe, expect, it } from "vitest";

import { parseHermesPrices, hermesLatestUrl } from "./prices";
import { FEED_ID_BY_TICKER, MAG7_TICKERS } from "./feeds";

// A trimmed, real-shaped Hermes `/v2/updates/price/latest?parsed=true` payload:
// AAPL at $311.076 (expo -5), MSFT at $443.2055.
const sampleParsed = [
  {
    id: FEED_ID_BY_TICKER.AAPL,
    price: {
      price: "31107600",
      conf: "24935",
      expo: -5,
      publish_time: 1780069962,
    },
  },
  {
    id: FEED_ID_BY_TICKER.MSFT,
    price: {
      price: "44320550",
      conf: "27899",
      expo: -5,
      publish_time: 1780069962,
    },
  },
];

describe("parseHermesPrices", () => {
  it("parses price + confidence scaled by the exponent", () => {
    const m = parseHermesPrices(sampleParsed);
    expect(m.AAPL).not.toBeNull();
    expect(m.AAPL!.price).toBeCloseTo(311.076, 3);
    expect(m.AAPL!.confidence).toBeCloseTo(0.24935, 5);
    expect(m.AAPL!.publishTime).toBe(1780069962);
    expect(m.MSFT!.price).toBeCloseTo(443.2055, 4);
  });

  it("returns every MAG7 ticker as a key, defaulting missing feeds to null", () => {
    const m = parseHermesPrices(sampleParsed);
    for (const t of MAG7_TICKERS) expect(t in m).toBe(true);
    // Not present in the sample → null, no throw.
    expect(m.NVDA).toBeNull();
    expect(m.TSLA).toBeNull();
  });

  it("tolerates a 0x-prefixed feed id", () => {
    const m = parseHermesPrices([
      {
        id: `0x${FEED_ID_BY_TICKER.NVDA}`,
        price: { price: "10000000", conf: "1000", expo: -5, publish_time: 1 },
      },
    ]);
    expect(m.NVDA!.price).toBeCloseTo(100, 5);
  });

  it("ignores unknown feed ids", () => {
    const m = parseHermesPrices([
      {
        id: "deadbeef".repeat(8),
        price: { price: "1", conf: "0", expo: 0, publish_time: 1 },
      },
    ]);
    // No MAG7 ticker should have been populated.
    expect(Object.values(m).every((v) => v === null)).toBe(true);
  });

  it("never throws on malformed input", () => {
    expect(parseHermesPrices(null).AAPL).toBeNull();
    expect(parseHermesPrices(undefined).AAPL).toBeNull();
    expect(parseHermesPrices("not an array" as unknown).AAPL).toBeNull();
    expect(parseHermesPrices([{}, { id: 5 }, { id: FEED_ID_BY_TICKER.AAPL }]).AAPL).toBeNull();
  });
});

describe("hermesLatestUrl", () => {
  it("builds a parsed latest-price URL for the given ids", () => {
    const url = hermesLatestUrl(["abc", "def"], "https://hermes.example.com/");
    expect(url).toBe(
      "https://hermes.example.com/v2/updates/price/latest?ids[]=abc&ids[]=def&parsed=true&encoding=hex",
    );
  });
});
