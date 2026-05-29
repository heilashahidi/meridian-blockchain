import { describe, expect, it } from "vitest";

import {
  computeStrikes,
  loadConfig,
  spacingForPrice,
  TICKERS,
  validateTicker,
  validateTickers,
  type Ticker,
} from "../src/config.js";

describe("config: ticker validation", () => {
  it("accepts every configured MAG7 ticker (real 64-hex feed IDs)", () => {
    for (const t of Object.keys(TICKERS) as Ticker[]) {
      const cfg = validateTicker(t);
      expect(cfg.feedId).toMatch(/^[0-9a-fA-F]{64}$/);
      expect(cfg.pythSymbol).toMatch(/^Equity\.US\.[A-Z]+\/USD$/);
    }
  });

  it("rejects a ticker with no feed ID", () => {
    // Simulate a misconfigured ticker by blanking the feed ID on a clone.
    const original = TICKERS.AAPL.feedId;
    try {
      (TICKERS.AAPL as { feedId: string }).feedId = "";
      expect(() => validateTicker("AAPL")).toThrow(/no Pyth feed ID/);
    } finally {
      (TICKERS.AAPL as { feedId: string }).feedId = original;
    }
  });

  it("rejects a malformed (non-64-hex) feed ID", () => {
    const original = TICKERS.MSFT.feedId;
    try {
      (TICKERS.MSFT as { feedId: string }).feedId = "deadbeef";
      expect(() => validateTicker("MSFT")).toThrow(/not 32-byte hex/);
    } finally {
      (TICKERS.MSFT as { feedId: string }).feedId = original;
    }
  });

  it("validates a whole list", () => {
    const out = validateTickers(["AAPL", "NVDA", "TSLA"]);
    expect(out).toHaveLength(3);
  });
});

describe("config: computeStrikes", () => {
  it("produces a sane ladder centered on a rounded reference", () => {
    const ladder = computeStrikes(212.37, 3);
    // 212.37 with $5 spacing rounds to 210; 3 each side → 195..225.
    expect(ladder.spacingDollars).toBe(5);
    expect(ladder.strikesDollars).toEqual([195, 200, 205, 210, 215, 220, 225]);
    expect(ladder.strikesMicro[0]).toBe(195_000_000n);
    // Strictly ascending.
    for (let i = 1; i < ladder.strikesMicro.length; i++) {
      expect(ladder.strikesMicro[i] > ladder.strikesMicro[i - 1]).toBe(true);
    }
  });

  it("uses tighter spacing for low-priced names and wider for high", () => {
    expect(spacingForPrice(20)).toBe(1);
    expect(spacingForPrice(75)).toBe(2.5);
    expect(spacingForPrice(180)).toBe(5);
    expect(spacingForPrice(700)).toBe(10);
    expect(spacingForPrice(1500)).toBe(25);
  });

  it("never emits a non-positive strike near zero", () => {
    const ladder = computeStrikes(3, 5); // $1 spacing, center 3
    expect(ladder.strikesDollars.every((s) => s > 0)).toBe(true);
  });

  it("rejects a non-positive reference price", () => {
    expect(() => computeStrikes(0)).toThrow(/positive finite/);
    expect(() => computeStrikes(-10)).toThrow(/positive finite/);
  });
});

describe("config: loadConfig env defaults", () => {
  it("falls back to devnet + canonical receiver with an empty env", () => {
    const cfg = loadConfig({});
    expect(cfg.rpcUrl).toBe("https://api.devnet.solana.com");
    expect(cfg.pythReceiver).toBe("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
    expect(cfg.tickers.length).toBeGreaterThan(0);
  });

  it("honors a TICKERS override and rejects unknown tickers", () => {
    expect(loadConfig({ TICKERS: "AAPL,NVDA" }).tickers).toEqual(["AAPL", "NVDA"]);
    expect(() => loadConfig({ TICKERS: "AAPL,FOO" })).toThrow(/unknown ticker/);
  });
});
