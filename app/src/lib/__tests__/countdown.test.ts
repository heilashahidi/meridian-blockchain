import { describe, expect, it } from "vitest";

import { countdownState, expiryEtLabel, formatRemaining } from "@/lib/countdown";

describe("countdownState", () => {
  const expiry = 1_700_000_000; // unix seconds

  it("is open with remaining seconds before expiry", () => {
    const s = countdownState(expiry - 90, expiry);
    expect(s.closed).toBe(false);
    expect(s.remainingSeconds).toBe(90);
    expect(s.label).toBe("01:30");
  });

  it("shows hours when more than an hour remains", () => {
    const s = countdownState(expiry - (2 * 3600 + 5 * 60 + 9), expiry);
    expect(s.closed).toBe(false);
    expect(s.label).toBe("2:05:09");
  });

  it("is closed exactly at expiry", () => {
    const s = countdownState(expiry, expiry);
    expect(s.closed).toBe(true);
    expect(s.remainingSeconds).toBe(0);
    expect(s.label).toBe("Closed");
  });

  it("is closed past expiry", () => {
    const s = countdownState(expiry + 500, expiry);
    expect(s.closed).toBe(true);
    expect(s.remainingSeconds).toBe(0);
    expect(s.label).toBe("Closed");
  });
});

describe("formatRemaining", () => {
  it("pads mm:ss under an hour", () => {
    expect(formatRemaining(5)).toBe("00:05");
    expect(formatRemaining(65)).toBe("01:05");
    expect(formatRemaining(3599)).toBe("59:59");
  });
  it("uses h:mm:ss between an hour and a day", () => {
    expect(formatRemaining(3600)).toBe("1:00:00");
    expect(formatRemaining(3661)).toBe("1:01:01");
    expect(formatRemaining(23 * 3600 + 59 * 60 + 59)).toBe("23:59:59");
  });
  it("uses compact 'Nd HHh' at/over a day", () => {
    expect(formatRemaining(86400)).toBe("1d 00h");
    expect(formatRemaining(86400 + 3600)).toBe("1d 01h");
    // 269h52m15s (the far-out seeded-market case) → "11d 05h", not "269:52:15".
    expect(formatRemaining(269 * 3600 + 52 * 60 + 15)).toBe("11d 05h");
  });
  it("clamps negatives to 0", () => {
    expect(formatRemaining(-5)).toBe("00:00");
  });
});

describe("expiryEtLabel", () => {
  it("renders a 4PM ET expiry as '4:00 PM ET' in summer (EDT)", () => {
    // 2026-06-17 20:00 UTC → 16:00 America/New_York (EDT, UTC−4).
    expect(expiryEtLabel(Date.UTC(2026, 5, 17, 20, 0) / 1000)).toBe("4:00 PM ET");
  });

  it("renders a 4PM ET expiry as '4:00 PM ET' in winter (EST)", () => {
    // 2026-01-14 21:00 UTC → 16:00 America/New_York (EST, UTC−5).
    expect(expiryEtLabel(Date.UTC(2026, 0, 14, 21, 0) / 1000)).toBe("4:00 PM ET");
  });

  it("reflects a non-4PM expiry honestly instead of a hardcoded label", () => {
    // 2026-06-17 17:30 UTC → 13:30 ET.
    expect(expiryEtLabel(Date.UTC(2026, 5, 17, 17, 30) / 1000)).toBe("1:30 PM ET");
  });
});
