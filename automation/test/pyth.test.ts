import { describe, expect, it, vi } from "vitest";

import {
  fetchPreviousClose,
  fetchLatestPriceUpdate,
  type ParsedPrice,
} from "../src/pyth.js";

// A minimal stand-in for the parts of HermesClient pyth.ts touches. We only need
// `getPriceUpdatesAtTimestamp` (previous close) and `getLatestPriceUpdates`
// (fallback); both return the same PriceUpdate shape (binary + parsed).
function fakeHermes(opts: {
  atTimestamp?: (publishTime: number, ids: string[]) => unknown;
  latest?: (ids: string[]) => unknown;
}): any {
  return {
    getPriceUpdatesAtTimestamp: vi.fn(
      async (publishTime: number, ids: string[]) =>
        opts.atTimestamp
          ? opts.atTimestamp(publishTime, ids)
          : { binary: { data: [] }, parsed: [] },
    ),
    getLatestPriceUpdates: vi.fn(async (ids: string[]) =>
      opts.latest ? opts.latest(ids) : { binary: { data: [] }, parsed: [] },
    ),
  };
}

/** Build a Hermes PriceUpdate response for one feed at a price (integer + expo). */
function priceUpdate(
  feedId: string,
  rawPrice: string,
  expo: number,
  publishTime: number,
): unknown {
  return {
    binary: { data: ["deadbeef"] },
    parsed: [
      {
        id: feedId,
        price: { price: rawPrice, conf: "1000", expo, publish_time: publishTime },
        ema_price: { price: rawPrice, conf: "1000", expo, publish_time: publishTime },
      },
    ],
  };
}

const FEED = "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688";
const CLOSE_UNIX = 1_780_000_000;

describe("pyth: fetchPreviousClose", () => {
  it("queries Hermes at the close timestamp and parses the price", async () => {
    // 18750000000 * 10^-8 = 187.5
    const hermes = fakeHermes({
      atTimestamp: () => priceUpdate(FEED, "18750000000", -8, CLOSE_UNIX),
    });

    const update = await fetchPreviousClose(hermes, FEED, CLOSE_UNIX);

    // It asked Hermes for the price AS-OF the close instant, not the latest.
    expect(hermes.getPriceUpdatesAtTimestamp).toHaveBeenCalledWith(
      CLOSE_UNIX,
      [FEED],
      expect.objectContaining({ parsed: true, encoding: "base64" }),
    );
    expect(hermes.getLatestPriceUpdates).not.toHaveBeenCalled();

    const parsed: ParsedPrice = update.parsed;
    expect(parsed.priceFloat).toBeCloseTo(187.5, 6);
    expect(parsed.feedId).toBe(FEED);
    expect(update.updateData).toEqual(["deadbeef"]);
  });

  it("accepts a 0x-prefixed feed id and matches the bare id Hermes returns", async () => {
    const hermes = fakeHermes({
      atTimestamp: () => priceUpdate(FEED, "10000000000", -8, CLOSE_UNIX),
    });
    const update = await fetchPreviousClose(hermes, `0x${FEED}`, CLOSE_UNIX);
    expect(update.parsed.priceFloat).toBeCloseTo(100, 6);
  });

  it("throws when Hermes returns no parsed entry for the feed", async () => {
    const hermes = fakeHermes({
      atTimestamp: () => ({ binary: { data: [] }, parsed: [] }),
    });
    await expect(fetchPreviousClose(hermes, FEED, CLOSE_UNIX)).rejects.toThrow(
      /no parsed previous-close price/,
    );
  });
});

describe("pyth: fetchLatestPriceUpdate (fallback path)", () => {
  it("parses the latest price update", async () => {
    const hermes = fakeHermes({
      latest: () => priceUpdate(FEED, "20000000000", -8, CLOSE_UNIX + 3600),
    });
    const update = await fetchLatestPriceUpdate(hermes, FEED);
    expect(update.parsed.priceFloat).toBeCloseTo(200, 6);
  });
});
