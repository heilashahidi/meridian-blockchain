import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  createStrikes,
  createWithRetry,
  planTicker,
  type CreateStrikesDeps,
  type MarketPlan,
} from "../src/jobs/createStrikes.js";
import { marketPda } from "../src/client.js";
import {
  computeStrikes,
  loadConfig,
  type AutomationConfig,
  type Ticker,
} from "../src/config.js";

// ─── helpers ──────────────────────────────────────────────────────────────

/** A config with a fixed ticker set + small strike ladder for fast tests. */
function testConfig(overrides: Partial<AutomationConfig> = {}): AutomationConfig {
  return {
    ...loadConfig({}),
    tickers: ["AAPL", "NVDA"],
    strikesPerSide: 2,
    expiryHoursFromNow: 24,
    ...overrides,
  };
}

/** Deps where nothing exists yet and every create succeeds. */
function happyDeps(prices: Partial<Record<Ticker, number>>): CreateStrikesDeps {
  return {
    fetchReferencePrice: vi.fn(async (t: Ticker) => prices[t] ?? 100),
    accountExists: vi.fn(async () => false),
    createMarket: vi.fn(async (p: MarketPlan) => `sig:${p.market.toBase58()}`),
  };
}

// No-op sleep so retry/backoff tests don't actually wait.
const fastOpts = { baseBackoffMs: 1, sleep: async () => {} } as const;

// ─── strike planning (job integration with computeStrikes) ──────────────────

describe("createStrikes: planning", () => {
  it("produces the expected strike ladder for a sample close", async () => {
    const cfg = testConfig({ tickers: ["AAPL"], strikesPerSide: 2 });
    const deps = happyDeps({ AAPL: 187 });
    const plan = await planTicker("AAPL", cfg, deps, 1_900_000_000);

    // 187 with $5 spacing (100–250 bucket) → center 185, ±2 → 175,180,185,190,195
    const expected = computeStrikes(187, 2);
    expect(plan.markets.map((m) => m.strikeDollars)).toEqual(
      expected.strikesDollars,
    );
    expect(plan.markets.map((m) => m.strikeMicro)).toEqual(
      expected.strikesMicro,
    );
    // Each market PDA derives from (ticker, strikeMicro, expiry).
    for (const m of plan.markets) {
      expect(m.market.toBase58()).toBe(
        marketPda("AAPL", m.strikeMicro, 1_900_000_000).toBase58(),
      );
      expect(m.pythFeedId.length).toBe(32);
    }
  });

  it("creates one market per ladder strike when none exist", async () => {
    const cfg = testConfig({ tickers: ["AAPL"], strikesPerSide: 2 });
    const deps = happyDeps({ AAPL: 187 });
    const report = await createStrikes(cfg, deps, fastOpts);

    const ladderLen = computeStrikes(187, 2).strikesDollars.length;
    expect(report.totalCreated).toBe(ladderLen);
    expect(report.totalSkipped).toBe(0);
    expect(report.totalFailed).toBe(0);
    expect(deps.createMarket).toHaveBeenCalledTimes(ladderLen);
  });
});

// ─── idempotency ────────────────────────────────────────────────────────────

describe("createStrikes: idempotency", () => {
  it("skips markets that already exist (no AccountAlreadyInitialized)", async () => {
    const cfg = testConfig({ tickers: ["AAPL"], strikesPerSide: 2 });
    const deps = happyDeps({ AAPL: 187 });
    // Everything already exists → all skipped, nothing created.
    deps.accountExists = vi.fn(async () => true);

    const report = await createStrikes(cfg, deps, fastOpts);
    const ladderLen = computeStrikes(187, 2).strikesDollars.length;

    expect(report.totalSkipped).toBe(ladderLen);
    expect(report.totalCreated).toBe(0);
    expect(report.totalFailed).toBe(0);
    expect(deps.createMarket).not.toHaveBeenCalled();
  });

  it("creates only the missing strikes (partial pre-existing set)", async () => {
    const cfg = testConfig({ tickers: ["AAPL"], strikesPerSide: 2 });
    const deps = happyDeps({ AAPL: 187 });
    const ladder = computeStrikes(187, 2);

    // Make existence depend on the strike value: the lowest two micro-strikes
    // "exist" already. The job derives PDA from (ticker, strikeMicro, expiry);
    // we recover the strike from the PDA by matching against the ladder's PDAs
    // at the run's expiry window. Simpler: existence keyed by strike index via
    // a closure that re-derives candidate PDAs for the run's expiry range.
    const existingMicros = new Set(
      ladder.strikesMicro.slice(0, 2).map((m) => m.toString()),
    );
    // The run uses expiry = now + 24h (rounded to whole seconds). Pre-compute
    // the set of existing PDAs across a small +/- window to be robust to the
    // exact second the job samples Date.now().
    const nowSec = Math.floor(Date.now() / 1000);
    const existingPdas = new Set<string>();
    for (let dt = -2; dt <= 2; dt++) {
      const expiry = nowSec + 24 * 3600 + dt;
      for (const m of ladder.strikesMicro) {
        if (existingMicros.has(m.toString())) {
          existingPdas.add(marketPda("AAPL", m, expiry).toBase58());
        }
      }
    }
    deps.accountExists = vi.fn(async (addr: PublicKey) =>
      existingPdas.has(addr.toBase58()),
    );

    const report = await createStrikes(cfg, deps, fastOpts);
    expect(report.totalSkipped).toBe(2);
    expect(report.totalCreated).toBe(ladder.strikesDollars.length - 2);
    expect(report.totalFailed).toBe(0);
    expect(deps.createMarket).toHaveBeenCalledTimes(
      ladder.strikesDollars.length - 2,
    );
  });
});

// ─── partial failure isolation ────────────────────────────────────────────────

describe("createStrikes: partial-failure isolation", () => {
  it("one ticker's create failing does not abort the others", async () => {
    const cfg = testConfig({ tickers: ["AAPL", "NVDA"], strikesPerSide: 1 });
    const deps = happyDeps({ AAPL: 187, NVDA: 120 });
    deps.createMarket = vi.fn(async (p: MarketPlan) => {
      if (p.ticker === "AAPL") throw new Error("simulated RPC failure");
      return `sig:${p.market.toBase58()}`;
    });

    const report = await createStrikes(cfg, deps, fastOpts);

    const aapl = report.results.find((r) => r.ticker === "AAPL")!;
    const nvda = report.results.find((r) => r.ticker === "NVDA")!;

    // AAPL strikes all failed; NVDA strikes all created.
    expect(aapl.failed).toBeGreaterThan(0);
    expect(aapl.created).toBe(0);
    expect(nvda.created).toBeGreaterThan(0);
    expect(nvda.failed).toBe(0);
    expect(report.totalFailed).toBe(aapl.failed);
  });

  it("a ticker whose price read throws is isolated and marked errored", async () => {
    const cfg = testConfig({ tickers: ["AAPL", "NVDA"], strikesPerSide: 1 });
    const deps = happyDeps({ NVDA: 120 });
    deps.fetchReferencePrice = vi.fn(async (t: Ticker) => {
      if (t === "AAPL") throw new Error("Hermes unreachable");
      return 120;
    });

    const report = await createStrikes(cfg, deps, fastOpts);
    const aapl = report.results.find((r) => r.ticker === "AAPL")!;
    const nvda = report.results.find((r) => r.ticker === "NVDA")!;

    expect(aapl.errored).toBe(true);
    expect(aapl.error).toMatch(/Hermes unreachable/);
    // NVDA still created despite AAPL's failure.
    expect(nvda.created).toBeGreaterThan(0);
    expect(nvda.errored).toBe(false);
  });
});

// ─── retry / backoff ──────────────────────────────────────────────────────────

describe("createStrikes: retry/backoff", () => {
  it("retries a transient create failure then succeeds", async () => {
    const plan: MarketPlan = {
      ticker: "AAPL",
      pythFeedId: new Array(32).fill(0),
      strikeMicro: 185_000_000n,
      strikeDollars: 185,
      expiryUnix: 1_900_000_000,
      market: marketPda("AAPL", 185_000_000n, 1_900_000_000),
    };
    let calls = 0;
    const deps = happyDeps({});
    deps.createMarket = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "sig:ok";
    });

    const sig = await createWithRetry(plan, deps, {
      maxAttempts: 4,
      baseBackoffMs: 1,
      sleep: async () => {},
    });
    expect(sig).toBe("sig:ok");
    expect(calls).toBe(3);
  });

  it("gives up after maxAttempts and rejects with the last error", async () => {
    const plan: MarketPlan = {
      ticker: "AAPL",
      pythFeedId: new Array(32).fill(0),
      strikeMicro: 185_000_000n,
      strikeDollars: 185,
      expiryUnix: 1_900_000_000,
      market: marketPda("AAPL", 185_000_000n, 1_900_000_000),
    };
    const deps = happyDeps({});
    deps.createMarket = vi.fn(async () => {
      throw new Error("always fails");
    });

    await expect(
      createWithRetry(plan, deps, {
        maxAttempts: 3,
        baseBackoffMs: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/always fails/);
    expect(deps.createMarket).toHaveBeenCalledTimes(3);
  });
});

// ─── dry run ──────────────────────────────────────────────────────────────────

describe("createStrikes: dry-run", () => {
  it("plans + counts intended creates but makes no on-chain writes", async () => {
    const cfg = testConfig({ tickers: ["AAPL"], strikesPerSide: 1 });
    const deps = happyDeps({ AAPL: 187 });
    const report = await createStrikes(cfg, deps, { ...fastOpts, dryRun: true });

    expect(deps.createMarket).not.toHaveBeenCalled();
    expect(report.totalCreated).toBeGreaterThan(0); // counts intent
    expect(report.totalFailed).toBe(0);
  });
});
