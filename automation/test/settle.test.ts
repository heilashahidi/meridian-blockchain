import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  isAlreadySettled,
  isRetryableOracleError,
  parseOverridePrices,
  settle,
  settleOne,
  type OpenMarket,
  type SettleAttempt,
  type SettleDeps,
} from "../src/jobs/settle.js";
import { marketPda } from "../src/client.js";
import type { Ticker } from "../src/config.js";

// ─── helpers ──────────────────────────────────────────────────────────────

function openMarket(overrides: Partial<OpenMarket> = {}): OpenMarket {
  const ticker: Ticker = overrides.ticker ?? "AAPL";
  const strikeMicro = overrides.strikeMicro ?? 185_000_000n;
  const expiryUnix = overrides.expiryUnix ?? 1_900_000_000;
  return {
    market: marketPda(ticker, strikeMicro, expiryUnix),
    ticker,
    strikeMicro,
    strikeDollars: Number(strikeMicro) / 1_000_000,
    expiryUnix,
    feedIdHex: "a".repeat(64),
    ...overrides,
  };
}

/** Deps that settle every market via the oracle on the first attempt. */
function happyDeps(markets: OpenMarket[], outcome: "YesWins" | "NoWins" = "YesWins"): SettleDeps {
  return {
    listOpenMarkets: vi.fn(async () => markets),
    oracleSettle: vi.fn(async (): Promise<SettleAttempt> => ({
      ok: true,
      outcome,
      signature: "sig:ok",
    })),
    isSettled: vi.fn(async () => false),
    adminSettle: vi.fn(async () => "sig:admin"),
    sweep: vi.fn(async () => {}),
  };
}

// Fast clock + sleep so the "15min" retry window resolves in microseconds.
// The clock advances by retryIntervalMs every time `sleep` is awaited.
function fastClock(retryIntervalMs = 30_000) {
  let t = 0;
  const now = () => t;
  const sleep = vi.fn(async (ms: number) => {
    t += ms;
  });
  return { now, sleep, retryIntervalMs };
}

const fastOpts = (extra = {}) => {
  const { now, sleep, retryIntervalMs } = fastClock();
  return { now, sleep, retryIntervalMs, maxRetryWindowMs: 900_000, ...extra };
};

// ─── error classification ───────────────────────────────────────────────────

describe("settle: error classification", () => {
  it("classifies stale / wide-confidence oracle errors as retryable", () => {
    expect(isRetryableOracleError(new Error("OracleStale"))).toBe(true);
    expect(isRetryableOracleError(new Error("OracleConfidenceTooWide"))).toBe(true);
    expect(
      isRetryableOracleError(new Error("Hermes returned no parsed price for feed x")),
    ).toBe(true);
    expect(isRetryableOracleError(new Error("some random RPC blowup"))).toBe(false);
  });

  it("recognizes already-settled (MarketSettled) as idempotent, not retryable", () => {
    const e = new Error("Error: MarketSettled");
    expect(isAlreadySettled(e)).toBe(true);
    expect(isRetryableOracleError(e)).toBe(false);
  });

  it("scans attached program logs, not just the message", () => {
    const e = Object.assign(new Error("custom program error"), {
      logs: ["Program log: AnchorError ... Error Code: OracleStale"],
    });
    expect(isRetryableOracleError(e)).toBe(true);
  });
});

// ─── happy path ───────────────────────────────────────────────────────────

describe("settle: happy path", () => {
  it("settles an open market to the correct outcome from a posted price", async () => {
    const m = openMarket();
    const deps = happyDeps([m], "YesWins");
    const report = await settle(deps, fastOpts());

    expect(report.totalSettled).toBe(1);
    expect(report.totalFailed).toBe(0);
    const r = report.results[0];
    expect(r.settledVia).toBe("oracle");
    expect(r.outcome).toBe("YesWins");
    expect(r.attempts).toBe(1);
    expect(deps.oracleSettle).toHaveBeenCalledTimes(1);
    expect(deps.adminSettle).not.toHaveBeenCalled();
    // Best-effort sweep ran after settle.
    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect(r.swept).toBe(true);
  });

  it("an empty open-market list settles nothing and reports zeros", async () => {
    const deps = happyDeps([]);
    const report = await settle(deps, fastOpts());
    expect(report).toMatchObject({
      totalSettled: 0,
      totalFailed: 0,
      results: [],
    });
    expect(deps.oracleSettle).not.toHaveBeenCalled();
  });

  it("settles each open market independently", async () => {
    const markets = [
      openMarket({ ticker: "AAPL", strikeMicro: 185_000_000n }),
      openMarket({ ticker: "NVDA", strikeMicro: 120_000_000n }),
    ];
    const deps = happyDeps(markets, "NoWins");
    const report = await settle(deps, fastOpts());
    expect(report.totalSettled).toBe(2);
    expect(report.results.every((r) => r.outcome === "NoWins")).toBe(true);
  });
});

// ─── retry then succeed ─────────────────────────────────────────────────────

describe("settle: retry", () => {
  it("retries a transient stale-oracle failure, then succeeds", async () => {
    const m = openMarket();
    let calls = 0;
    const deps = happyDeps([m]);
    deps.oracleSettle = vi.fn(async (): Promise<SettleAttempt> => {
      calls++;
      if (calls < 3) return { ok: false, error: new Error("OracleStale") };
      return { ok: true, outcome: "YesWins", signature: "sig:ok" };
    });

    const opts = fastOpts();
    const report = await settle(deps, opts);

    expect(calls).toBe(3);
    expect(report.totalSettled).toBe(1);
    expect(report.results[0].attempts).toBe(3);
    expect(report.results[0].settledVia).toBe("oracle");
    // Slept twice (between the 3 attempts), never the real 30s.
    expect(opts.sleep).toHaveBeenCalledTimes(2);
    expect(deps.adminSettle).not.toHaveBeenCalled();
  });

  it("retry loop is driven by the injected clock — never sleeps for real", async () => {
    const m = openMarket();
    const deps = happyDeps([m]);
    // Always stale → exhausts the window. With no override price it ends failed,
    // but the point is: the whole 15min budget is consumed via the fake clock.
    deps.oracleSettle = vi.fn(async (): Promise<SettleAttempt> => ({
      ok: false,
      error: new Error("OracleStale"),
    }));

    const start = Date.now();
    const report = await settle(deps, fastOpts()); // no overridePrices
    const wallMs = Date.now() - start;

    // ~15min / 30s ≈ 30 attempts, all in well under a second of real time.
    expect(report.results[0].attempts).toBeGreaterThan(20);
    expect(wallMs).toBeLessThan(2000);
  });
});

// ─── override fallback ──────────────────────────────────────────────────────

describe("settle: admin-override fallback", () => {
  it("after the retry window, invokes admin_settle_market and alerts", async () => {
    const m = openMarket({ ticker: "AAPL", strikeMicro: 185_000_000n });
    const deps = happyDeps([m]);
    deps.oracleSettle = vi.fn(async (): Promise<SettleAttempt> => ({
      ok: false,
      error: new Error("OracleStale"),
    }));

    const report = await settle(deps, {
      ...fastOpts(),
      overridePrices: { AAPL: 190 }, // 190 >= 185 → YesWins
    });

    expect(deps.adminSettle).toHaveBeenCalledTimes(1);
    expect(deps.adminSettle).toHaveBeenCalledWith(m, true);
    const r = report.results[0];
    expect(r.settledVia).toBe("admin-override");
    expect(r.outcome).toBe("YesWins");
    expect(report.totalOverridden).toBe(1);
    expect(report.totalFailed).toBe(0);
  });

  it("override at exactly the strike settles YesWins (price >= strike)", async () => {
    const m = openMarket({ ticker: "AAPL", strikeMicro: 185_000_000n });
    const deps = happyDeps([m]);
    deps.oracleSettle = vi.fn(async (): Promise<SettleAttempt> => ({
      ok: false,
      error: new Error("OracleStale"),
    }));

    // overridePrice 185 == strike 185 → yesWins true.
    const report = await settle(deps, {
      ...fastOpts(),
      overridePrices: { AAPL: 185 },
    });
    expect(deps.adminSettle).toHaveBeenCalledWith(m, true);
    expect(report.results[0].outcome).toBe("YesWins");
    expect(report.totalOverridden).toBe(1);
  });

  it("override whose adminSettle hits MarketSettled is treated as already-settled", async () => {
    const m = openMarket({ ticker: "AAPL", strikeMicro: 185_000_000n });
    const deps = happyDeps([m]);
    deps.oracleSettle = vi.fn(async (): Promise<SettleAttempt> => ({
      ok: false,
      error: new Error("OracleStale"),
    }));
    deps.adminSettle = vi.fn(async () => {
      throw new Error("AnchorError ... MarketSettled");
    });

    const report = await settle(deps, {
      ...fastOpts(),
      overridePrices: { AAPL: 190 },
    });
    expect(report.results[0].settledVia).toBe("already-settled");
    expect(report.totalAlreadySettled).toBe(1);
    expect(report.totalFailed).toBe(0);
  });

  it("override picks NoWins when the operator price is below the strike", async () => {
    const m = openMarket({ ticker: "AAPL", strikeMicro: 185_000_000n });
    const deps = happyDeps([m]);
    deps.oracleSettle = vi.fn(async (): Promise<SettleAttempt> => ({
      ok: false,
      error: new Error("OracleStale"),
    }));

    await settle(deps, { ...fastOpts(), overridePrices: { AAPL: 180 } });
    expect(deps.adminSettle).toHaveBeenCalledWith(m, false);
  });

  it("a non-retryable error short-circuits to override (no full retry budget)", async () => {
    const m = openMarket({ ticker: "AAPL", strikeMicro: 185_000_000n });
    const deps = happyDeps([m]);
    deps.oracleSettle = vi.fn(async (): Promise<SettleAttempt> => ({
      ok: false,
      error: new Error("AccountNotFound: bad config"),
    }));

    const opts = fastOpts();
    await settle(deps, { ...opts, overridePrices: { AAPL: 190 } });
    expect(deps.oracleSettle).toHaveBeenCalledTimes(1); // no retries
    expect(opts.sleep).not.toHaveBeenCalled();
    expect(deps.adminSettle).toHaveBeenCalledTimes(1);
  });

  it("leaves a market open (failed) when no override price is configured", async () => {
    const m = openMarket();
    const deps = happyDeps([m]);
    deps.oracleSettle = vi.fn(async (): Promise<SettleAttempt> => ({
      ok: false,
      error: new Error("OracleStale"),
    }));

    const report = await settle(deps, fastOpts()); // no overridePrices
    expect(deps.adminSettle).not.toHaveBeenCalled();
    expect(report.totalFailed).toBe(1);
    expect(report.results[0].settledVia).toBe(null);
    expect(report.results[0].error).toMatch(/no override price/);
  });

  it("a reverting override (e.g. grace not elapsed) is isolated, not crashing", async () => {
    const m = openMarket({ ticker: "AAPL", strikeMicro: 185_000_000n });
    const deps = happyDeps([m]);
    deps.oracleSettle = vi.fn(async (): Promise<SettleAttempt> => ({
      ok: false,
      error: new Error("OracleStale"),
    }));
    deps.adminSettle = vi.fn(async () => {
      throw new Error("EmergencyGraceNotElapsed");
    });

    const report = await settle(deps, { ...fastOpts(), overridePrices: { AAPL: 190 } });
    expect(report.totalFailed).toBe(1);
    expect(report.results[0].error).toMatch(/EmergencyGraceNotElapsed/);
  });
});

// ─── idempotency ────────────────────────────────────────────────────────────

describe("settle: idempotency", () => {
  it("skips a market that is already settled (no MarketSettled crash)", async () => {
    const m = openMarket();
    const deps = happyDeps([m]);
    deps.isSettled = vi.fn(async () => true);

    const report = await settle(deps, fastOpts());
    expect(deps.oracleSettle).not.toHaveBeenCalled();
    expect(report.totalAlreadySettled).toBe(1);
    expect(report.results[0].settledVia).toBe("already-settled");
  });

  it("treats a MarketSettled error mid-retry as done (settled by another caller)", async () => {
    const m = openMarket();
    const deps = happyDeps([m]);
    deps.oracleSettle = vi.fn(async (): Promise<SettleAttempt> => ({
      ok: false,
      error: new Error("AnchorError ... MarketSettled"),
    }));

    const report = await settle(deps, fastOpts());
    expect(report.results[0].settledVia).toBe("already-settled");
    expect(deps.adminSettle).not.toHaveBeenCalled();
    expect(report.totalFailed).toBe(0);
  });
});

// ─── per-market isolation ─────────────────────────────────────────────────────

describe("settle: per-market isolation", () => {
  it("one market failing does not abort the others", async () => {
    const a = openMarket({ ticker: "AAPL", strikeMicro: 185_000_000n });
    const n = openMarket({ ticker: "NVDA", strikeMicro: 120_000_000n });
    const deps = happyDeps([a, n]);
    deps.oracleSettle = vi.fn(async (m: OpenMarket): Promise<SettleAttempt> => {
      if (m.ticker === "AAPL") return { ok: false, error: new Error("OracleStale") };
      return { ok: true, outcome: "YesWins", signature: "sig:ok" };
    });

    // AAPL has no override → fails; NVDA settles via oracle.
    const report = await settle(deps, fastOpts());
    const aapl = report.results.find((r) => r.ticker === "AAPL")!;
    const nvda = report.results.find((r) => r.ticker === "NVDA")!;
    expect(aapl.settledVia).toBe(null);
    expect(nvda.settledVia).toBe("oracle");
    expect(report.totalSettled).toBe(1);
    expect(report.totalFailed).toBe(1);
  });
});

// ─── best-effort sweep ────────────────────────────────────────────────────────

describe("settle: sweep is best-effort", () => {
  it("a sweep failure does not fail an otherwise-successful settle", async () => {
    const m = openMarket();
    const deps = happyDeps([m]);
    deps.sweep = vi.fn(async () => {
      throw new Error("sweep RPC failed");
    });

    const report = await settle(deps, fastOpts());
    expect(report.totalSettled).toBe(1);
    expect(report.results[0].settledVia).toBe("oracle");
    expect(report.results[0].swept).toBe(false);
  });

  it("sweepAfterSettle: false skips the sweep entirely", async () => {
    const m = openMarket();
    const deps = happyDeps([m]);
    const report = await settle(deps, { ...fastOpts(), sweepAfterSettle: false });
    expect(deps.sweep).not.toHaveBeenCalled();
    expect(report.totalSettled).toBe(1);
  });
});

// ─── settleOne unit ───────────────────────────────────────────────────────────

describe("settleOne", () => {
  it("never throws — returns a result even when everything fails", async () => {
    const m = openMarket();
    const deps = happyDeps([m]);
    deps.oracleSettle = vi.fn(async () => {
      throw new Error("oracleSettle exploded");
    });
    // exploded message isn't retryable → straight to override; no price → failed.
    const r = await settleOne(m, deps, {
      retryIntervalMs: 30_000,
      maxRetryWindowMs: 900_000,
      sleep: async () => {},
      now: () => 0,
      overridePrices: {},
      sweepAfterSettle: true,
    });
    expect(r.settledVia).toBe(null);
    expect(r.error).toBeTruthy();
  });
});

// ─── override-price env parsing ───────────────────────────────────────────────

describe("parseOverridePrices", () => {
  it("parses a TICKER=price list", () => {
    expect(parseOverridePrices("AAPL=187.5,NVDA=120")).toEqual({
      AAPL: 187.5,
      NVDA: 120,
    });
  });
  it("ignores unknown tickers and malformed entries", () => {
    expect(parseOverridePrices("ZZZ=1,AAPL=,NVDA=120,=5")).toEqual({ NVDA: 120 });
  });
  it("returns empty for undefined / empty input", () => {
    expect(parseOverridePrices(undefined)).toEqual({});
    expect(parseOverridePrices("")).toEqual({});
  });
  it("rejects non-positive prices", () => {
    expect(parseOverridePrices("AAPL=0,NVDA=-5")).toEqual({});
  });
});
