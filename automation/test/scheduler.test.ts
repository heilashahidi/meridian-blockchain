import { describe, expect, it } from "vitest";

import {
  etPartsOf,
  holidayTableCoversYear,
  isUsMarketHoliday,
  isUsTradingDay,
  isWeekend,
  type EtParts,
} from "../src/tradingCalendar.js";
import {
  DEFAULT_SCHEDULE,
  dueJobs,
  initialState,
  runScheduler,
  type SchedulerState,
} from "../src/scheduler.js";

// ─── ET conversion (DST-correct via ICU) ────────────────────────────────────

describe("tradingCalendar: etPartsOf", () => {
  it("maps a summer UTC instant to EDT (UTC−4)", () => {
    // 2026-06-17 12:00 UTC → 08:00 America/New_York (EDT).
    const et = etPartsOf(new Date(Date.UTC(2026, 5, 17, 12, 0)));
    expect(et.ymd).toBe("2026-06-17");
    expect(et.hour).toBe(8);
    expect(et.minute).toBe(0);
    expect(et.weekday).toBe(3); // Wednesday
  });

  it("maps a winter UTC instant to EST (UTC−5)", () => {
    // 2026-01-14 13:00 UTC → 08:00 America/New_York (EST).
    const et = etPartsOf(new Date(Date.UTC(2026, 0, 14, 13, 0)));
    expect(et.ymd).toBe("2026-01-14");
    expect(et.hour).toBe(8);
  });
});

describe("tradingCalendar: trading-day predicate", () => {
  const wed = etPartsOf(new Date(Date.UTC(2026, 5, 17, 12, 0))); // 2026-06-17
  const sat = etPartsOf(new Date(Date.UTC(2026, 5, 20, 16, 0))); // 2026-06-20
  const christmas = etPartsOf(new Date(Date.UTC(2026, 11, 25, 17, 0))); // 2026-12-25

  it("treats a normal weekday as a trading day", () => {
    expect(isWeekend(wed)).toBe(false);
    expect(isUsMarketHoliday(wed)).toBe(false);
    expect(isUsTradingDay(wed)).toBe(true);
  });

  it("treats Saturday as a non-trading day", () => {
    expect(isWeekend(sat)).toBe(true);
    expect(isUsTradingDay(sat)).toBe(false);
  });

  it("treats an NYSE holiday (Christmas) as a non-trading day", () => {
    expect(christmas.ymd).toBe("2026-12-25");
    expect(isUsMarketHoliday(christmas)).toBe(true);
    expect(isUsTradingDay(christmas)).toBe(false);
  });

  it("knows the holiday table's coverage horizon", () => {
    expect(holidayTableCoversYear(2026)).toBe(true);
    expect(holidayTableCoversYear(2030)).toBe(false);
  });
});

// ─── firing decision (pure) ─────────────────────────────────────────────────

/** A trading weekday (2026-06-17, Wed) with the given ET hour:minute. */
function tradingDayAt(hour: number, minute: number): EtParts {
  return {
    ymd: "2026-06-17",
    year: 2026,
    month: 6,
    day: 17,
    hour,
    minute,
    weekday: 3,
  };
}

describe("scheduler: dueJobs", () => {
  const fresh = (): SchedulerState => initialState();

  it("fires the morning job within its window", () => {
    expect(dueJobs(tradingDayAt(8, 0), DEFAULT_SCHEDULE, fresh())).toEqual([
      "morning",
    ]);
    expect(dueJobs(tradingDayAt(8, 4), DEFAULT_SCHEDULE, fresh())).toEqual([
      "morning",
    ]);
  });

  it("does not fire before or after the window", () => {
    expect(dueJobs(tradingDayAt(7, 59), DEFAULT_SCHEDULE, fresh())).toEqual([]);
    expect(dueJobs(tradingDayAt(8, 5), DEFAULT_SCHEDULE, fresh())).toEqual([]);
  });

  it("fires the settle job at 16:05 ET", () => {
    expect(dueJobs(tradingDayAt(16, 6), DEFAULT_SCHEDULE, fresh())).toEqual([
      "settle",
    ]);
  });

  it("fires each job at most once per ET day", () => {
    const state = fresh();
    expect(dueJobs(tradingDayAt(8, 0), DEFAULT_SCHEDULE, state)).toEqual([
      "morning",
    ]);
    state.lastMorningYmd = "2026-06-17"; // caller records the fire
    expect(dueJobs(tradingDayAt(8, 1), DEFAULT_SCHEDULE, state)).toEqual([]);
  });

  it("never fires on a weekend or holiday", () => {
    const sat: EtParts = { ...tradingDayAt(8, 0), weekday: 6 };
    expect(dueJobs(sat, DEFAULT_SCHEDULE, fresh())).toEqual([]);
    const holiday: EtParts = { ...tradingDayAt(8, 0), ymd: "2026-12-25", weekday: 5 };
    expect(dueJobs(holiday, DEFAULT_SCHEDULE, fresh())).toEqual([]);
  });
});

// ─── run loop (effects injected) ────────────────────────────────────────────

describe("scheduler: runScheduler loop", () => {
  it("fires the morning job once then stops, and survives a job that throws", async () => {
    let morningCalls = 0;
    let settleCalls = 0;
    let ticks = 0;

    await runScheduler(
      {
        // Fixed instant inside the morning window on a trading weekday.
        now: () => new Date(Date.UTC(2026, 5, 17, 12, 2)), // 08:02 ET
        runMorning: async () => {
          morningCalls++;
          throw new Error("boom"); // must NOT crash the loop
        },
        runSettle: async () => {
          settleCalls++;
        },
        sleep: async () => {},
        // Run exactly one iteration.
        running: () => ticks++ < 1,
      },
      { tickMs: 1 },
    );

    expect(morningCalls).toBe(1); // fired despite throwing
    expect(settleCalls).toBe(0);
  });
});
