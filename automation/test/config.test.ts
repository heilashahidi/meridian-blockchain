import { describe, expect, it } from "vitest";

import {
  computeStrikes,
  loadConfig,
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

describe("config: computeStrikes (PRD ±3/6/9% rounded to $10)", () => {
  it("reproduces the PRD META example exactly (prev close $680)", () => {
    const ladder = computeStrikes(680);
    // PRD §"Strike Selection": ±3/6/9% rounded to nearest $10, plus the close.
    expect(ladder.strikesDollars).toEqual([620, 640, 660, 680, 700, 720, 740]);
    expect(ladder.roundingDollars).toBe(10);
    expect(ladder.strikesMicro[0]).toBe(620_000_000n);
    // Strictly ascending.
    for (let i = 1; i < ladder.strikesMicro.length; i++) {
      expect(ladder.strikesMicro[i] > ladder.strikesMicro[i - 1]).toBe(true);
    }
  });

  it("reproduces the PRD AAPL example exactly, with dedup (prev close $230)", () => {
    const ladder = computeStrikes(230);
    // −6%/−3% both round to 220; +3%/+6% both round to 240 → 5 unique strikes.
    expect(ladder.strikesDollars).toEqual([210, 220, 230, 240, 250]);
  });

  it("honors custom percents and rounding increments", () => {
    const ladder = computeStrikes(100, { percents: [5, 10], roundingDollars: 5 });
    // ±5% → 95/105, ±10% → 90/110, center 100.
    expect(ladder.strikesDollars).toEqual([90, 95, 100, 105, 110]);
  });

  it("can omit the at-the-money center strike", () => {
    const ladder = computeStrikes(680, { includeCenter: false });
    expect(ladder.strikesDollars).toEqual([620, 640, 660, 700, 720, 740]);
  });

  it("never emits a non-positive strike near zero", () => {
    const ladder = computeStrikes(3, { percents: [3, 6, 9], roundingDollars: 10 });
    expect(ladder.strikesDollars.every((s) => s > 0)).toBe(true);
  });

  it("rejects a non-positive reference price", () => {
    expect(() => computeStrikes(0)).toThrow(/positive finite/);
    expect(() => computeStrikes(-10)).toThrow(/positive finite/);
  });

  it("rejects a non-positive percent or rounding increment", () => {
    expect(() => computeStrikes(100, { percents: [3, -6] })).toThrow(/positive finite/);
    expect(() => computeStrikes(100, { roundingDollars: 0 })).toThrow(/positive finite/);
  });

  it("fixed-step mode builds an exact $10 ladder (center ± N·step)", () => {
    const ladder = computeStrikes(228.5, { stepDollars: 10, stepsPerSide: 3 });
    expect(ladder.strikesDollars).toEqual([200, 210, 220, 230, 240, 250, 260]);
    // every gap is exactly $10
    const gaps = ladder.strikesDollars.slice(1).map((d, i) => d - ladder.strikesDollars[i]);
    expect(gaps.every((g) => g === 10)).toBe(true);
  });

  it("fixed-step mode ignores percents and stays $10-even at any price", () => {
    for (const ref of [681.2, 142.3, 905]) {
      const l = computeStrikes(ref, { stepDollars: 10, percents: [3, 6, 9] });
      const gaps = l.strikesDollars.slice(1).map((d, i) => d - l.strikesDollars[i]);
      expect(gaps.every((g) => g === 10)).toBe(true);
    }
  });

  it("rejects a non-positive step", () => {
    expect(() => computeStrikes(100, { stepDollars: 0 })).toThrow(/positive finite/);
  });
});

describe("config: loadConfig env defaults", () => {
  it("falls back to devnet + canonical receiver with an empty env", () => {
    const cfg = loadConfig({});
    expect(cfg.rpcUrl).toBe("https://api.devnet.solana.com");
    expect(cfg.pythReceiver).toBe("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
    expect(cfg.tickers.length).toBeGreaterThan(0);
  });

  it("defaults to the full MAG7 set (PRD §148/§318)", () => {
    const cfg = loadConfig({});
    expect(cfg.tickers).toEqual([
      "AAPL",
      "MSFT",
      "GOOGL",
      "AMZN",
      "NVDA",
      "META",
      "TSLA",
    ]);
    // Every default ticker must have a valid Pyth feed configured.
    for (const t of cfg.tickers) {
      expect(() => validateTicker(t)).not.toThrow();
    }
  });

  it("honors a TICKERS override and rejects unknown tickers", () => {
    expect(loadConfig({ TICKERS: "AAPL,NVDA" }).tickers).toEqual(["AAPL", "NVDA"]);
    expect(() => loadConfig({ TICKERS: "AAPL,FOO" })).toThrow(/unknown ticker/);
  });
});
