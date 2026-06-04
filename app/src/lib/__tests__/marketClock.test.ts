import { describe, expect, it } from "vitest";

import { etWeekdayIndex, marketSession } from "@/lib/marketClock";

// ET seconds-into-day helpers for readable cases.
const at = (h: number, m = 0, s = 0) => h * 3600 + m * 60 + s;
const OPEN = at(9, 30); // 9:30 AM ET
const CLOSE = at(16); // 4:00 PM ET

// Weekday indices (Sun=0…Sat=6).
const SUN = 0;
const MON = 1;
const WED = 3;
const FRI = 5;
const SAT = 6;

describe("etWeekdayIndex", () => {
  it("maps short ET weekday labels to JS getDay indices", () => {
    expect(etWeekdayIndex("Sun")).toBe(0);
    expect(etWeekdayIndex("Mon")).toBe(1);
    expect(etWeekdayIndex("Fri")).toBe(5);
    expect(etWeekdayIndex("Sat")).toBe(6);
  });

  it("falls back to Monday for unknown input", () => {
    expect(etWeekdayIndex("???")).toBe(1);
  });
});

describe("marketSession — open", () => {
  it("is open on a weekday midday and counts down to today's 4 PM close", () => {
    const s = marketSession(WED, at(12));
    expect(s.open).toBe(true);
    expect(s.caption).toBe("Settles 4:00 PM ET");
    expect(s.remainingSeconds).toBe(CLOSE - at(12)); // 4 hours
  });

  it("is open at exactly 9:30 AM (inclusive)", () => {
    expect(marketSession(WED, OPEN).open).toBe(true);
  });

  it("is closed at exactly 4:00 PM (exclusive)", () => {
    expect(marketSession(WED, CLOSE).open).toBe(false);
  });
});

describe("marketSession — closed counts down to the next 9:30 open", () => {
  it("pre-open on a weekday → opens today", () => {
    const s = marketSession(WED, at(8)); // 8:00 AM ET
    expect(s.open).toBe(false);
    expect(s.caption).toBe("Opens 9:30 AM ET");
    expect(s.remainingSeconds).toBe(OPEN - at(8)); // 1h30m
  });

  it("after close on a weeknight → opens tomorrow", () => {
    const s = marketSession(WED, at(17)); // 5:00 PM ET Wed
    expect(s.open).toBe(false);
    // Wed 5pm → Thu 9:30am = 16.5h.
    expect(s.remainingSeconds).toBe(at(24) + OPEN - at(17));
    expect(s.remainingSeconds).toBe(at(16, 30));
  });

  it("Friday after close → opens Monday (skips the weekend)", () => {
    const s = marketSession(FRI, at(17)); // 5:00 PM ET Fri
    // Fri 5pm → Mon 9:30am = 3 days minus the gap = 64.5h.
    expect(s.remainingSeconds).toBe(3 * at(24) + OPEN - at(17));
    expect(s.remainingSeconds).toBe(at(64, 30));
  });

  it("Saturday → opens Monday", () => {
    const s = marketSession(SAT, at(12)); // Sat noon
    expect(s.open).toBe(false);
    expect(s.remainingSeconds).toBe(2 * at(24) + OPEN - at(12)); // 45.5h
  });

  it("Sunday → opens Monday", () => {
    const s = marketSession(SUN, at(12)); // Sun noon
    expect(s.remainingSeconds).toBe(at(24) + OPEN - at(12)); // 21.5h
  });

  it("Monday pre-open → opens later today, not next week", () => {
    const s = marketSession(MON, at(6)); // Mon 6:00 AM
    expect(s.remainingSeconds).toBe(OPEN - at(6)); // 3.5h, days=0
  });

  it("never targets a non-trading day (always opens Mon–Fri)", () => {
    // Sweep every weekday index after the close; the resulting target must land
    // on a trading day at 9:30.
    for (let d = 0; d < 7; d++) {
      const s = marketSession(d, at(20)); // 8 PM, always closed
      const targetDay = (d + Math.floor((s.remainingSeconds + at(20)) / at(24))) % 7;
      expect(targetDay).toBeGreaterThanOrEqual(1);
      expect(targetDay).toBeLessThanOrEqual(5);
    }
  });
});
