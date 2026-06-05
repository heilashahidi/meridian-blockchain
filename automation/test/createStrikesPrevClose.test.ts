import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the lazily-imported Pyth helper so `makeLiveDeps().fetchReferencePrice`
// is exercised end-to-end WITHOUT any network. We assert the live wiring calls
// the PREVIOUS-CLOSE path (and falls back to latest only when it throws).
const fetchPreviousClose = vi.fn();
const fetchLatestPriceUpdate = vi.fn();
vi.mock("../src/pyth.js", () => ({
  makeHermesClient: () => ({}) as unknown,
  fetchPreviousClose,
  fetchLatestPriceUpdate,
}));

import { makeLiveDeps } from "../src/jobs/createStrikes.js";
import { loadConfig, type AutomationConfig } from "../src/config.js";

/** A config pointing at an ephemeral on-disk keypair so makeLiveDeps loads. */
function liveCfg(): AutomationConfig {
  const kp = Keypair.generate();
  const path = join(tmpdir(), `meridian-admin-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return { ...loadConfig({}), adminKeypairPath: path, tickers: ["AAPL"] };
}

/** Shape fetchPreviousClose/fetchLatestPriceUpdate resolve to. */
function update(priceFloat: number) {
  return { parsed: { priceFloat }, updateData: [] };
}

beforeEach(() => {
  fetchPreviousClose.mockReset();
  fetchLatestPriceUpdate.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("createStrikes live deps: previous-close reference price", () => {
  it("uses the previous-close value (not the latest price) for strikes", async () => {
    fetchPreviousClose.mockResolvedValue(update(187.5));
    fetchLatestPriceUpdate.mockResolvedValue(update(999)); // must NOT be used

    const deps = makeLiveDeps(liveCfg());
    const price = await deps.fetchReferencePrice("AAPL");

    expect(price).toBe(187.5);
    expect(fetchPreviousClose).toHaveBeenCalledTimes(1);
    // It passed a positive close timestamp as the 3rd arg (the prior 16:00 ET).
    const [, , closeUnix] = fetchPreviousClose.mock.calls[0];
    expect(closeUnix).toBeGreaterThan(0);
    expect(fetchLatestPriceUpdate).not.toHaveBeenCalled();
  });

  it("falls back to the latest price only when previous-close fetch fails", async () => {
    fetchPreviousClose.mockRejectedValue(new Error("benchmark gap"));
    fetchLatestPriceUpdate.mockResolvedValue(update(190.25));

    const deps = makeLiveDeps(liveCfg());
    const price = await deps.fetchReferencePrice("AAPL");

    expect(price).toBe(190.25);
    expect(fetchPreviousClose).toHaveBeenCalledTimes(1);
    expect(fetchLatestPriceUpdate).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-positive reference price (no silent bad strikes)", async () => {
    fetchPreviousClose.mockResolvedValue(update(0));
    const deps = makeLiveDeps(liveCfg());
    await expect(deps.fetchReferencePrice("AAPL")).rejects.toThrow(
      /non-positive reference price/,
    );
  });
});
