import { describe, expect, it } from "vitest";

import {
  etPartsOf,
  isUsTradingDay,
  previousCloseUnix,
  settlementExpiryUnix,
} from "../src/tradingCalendar.js";

// All instants below are checked via etPartsOf so the assertions are DST-correct
// regardless of the host machine's timezone.

describe("tradingCalendar: previousCloseUnix", () => {
  it("returns a 16:00 ET close that is strictly in the past", () => {
    // Monday 2026-06-08 08:00 ET (a normal trading day).
    const now = new Date("2026-06-08T12:00:00Z"); // 08:00 ET (EDT, UTC-4)
    const close = previousCloseUnix(now);
    expect(close).toBeLessThan(Math.floor(now.getTime() / 1000));

    const et = etPartsOf(new Date(close * 1000));
    expect(et.hour).toBe(16);
    expect(et.minute).toBe(0);
    expect(isUsTradingDay(et)).toBe(true);
  });

  it("skips the weekend: Monday morning anchors on the prior Friday's close", () => {
    const now = new Date("2026-06-08T12:00:00Z"); // Mon 08:00 ET
    const close = previousCloseUnix(now);
    const et = etPartsOf(new Date(close * 1000));
    expect(et.weekday).toBe(5); // Friday
    expect(et.ymd).toBe("2026-06-05"); // Fri 2026-06-05 16:00 ET
  });

  it("skips an NYSE holiday: the day after Juneteenth anchors before it", () => {
    // 2026-06-19 (Juneteenth) is a holiday; markets closed. Monday 2026-06-22
    // 08:00 ET → prior trading day is Thursday 2026-06-18.
    const now = new Date("2026-06-22T12:00:00Z"); // Mon 08:00 ET
    const close = previousCloseUnix(now);
    const et = etPartsOf(new Date(close * 1000));
    expect(et.ymd).toBe("2026-06-18");
    expect(isUsTradingDay(etPartsOf(new Date("2026-06-19T20:00:00Z")))).toBe(
      false,
    );
  });

  it("anchors on the SAME day's close if run after 16:00 ET on a trading day", () => {
    const now = new Date("2026-06-08T22:00:00Z"); // Mon 18:00 ET (after close)
    const close = previousCloseUnix(now);
    const et = etPartsOf(new Date(close * 1000));
    expect(et.ymd).toBe("2026-06-08"); // today's close, now in the past
  });
});

describe("tradingCalendar: settlementExpiryUnix (regression after refactor)", () => {
  it("stamps the upcoming 16:00 ET close", () => {
    const now = new Date("2026-06-08T12:00:00Z"); // Mon 08:00 ET
    const expiry = settlementExpiryUnix(now);
    const et = etPartsOf(new Date(expiry * 1000));
    expect(et.hour).toBe(16);
    expect(expiry).toBeGreaterThan(Math.floor(now.getTime() / 1000));
  });

  it("Friday after the close settles the next TRADING day (Monday), not Saturday", () => {
    const now = new Date("2026-06-05T22:00:00Z"); // Fri 18:00 ET, past the 16:00 close
    const et = etPartsOf(new Date(settlementExpiryUnix(now) * 1000));
    expect(et.weekday).toBe(1); // Monday, not Sat(6)/Sun(0)
    expect(et.day).toBe(8); // 2026-06-08
    expect(et.hour).toBe(16);
  });

  it("Saturday and Sunday both settle the following Monday", () => {
    for (const iso of ["2026-06-06T16:00:00Z", "2026-06-07T16:00:00Z"]) {
      const et = etPartsOf(new Date(settlementExpiryUnix(new Date(iso)) * 1000));
      expect(et.weekday).toBe(1);
      expect(et.day).toBe(8);
    }
  });

  it("skips an NYSE holiday: Friday before Memorial Day Monday settles Tuesday", () => {
    // 2026-05-25 is Memorial Day (observed). Fri 2026-05-22 after close → Tue 5/26.
    const now = new Date("2026-05-22T22:00:00Z"); // Fri 18:00 ET
    const et = etPartsOf(new Date(settlementExpiryUnix(now) * 1000));
    expect(et.weekday).toBe(2); // Tuesday
    expect(et.day).toBe(26);
  });
});
