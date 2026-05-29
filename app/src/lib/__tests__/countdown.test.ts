import { describe, expect, it } from "vitest";

import { countdownState, formatRemaining } from "@/lib/countdown";

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
  it("uses h:mm:ss at/over an hour", () => {
    expect(formatRemaining(3600)).toBe("1:00:00");
    expect(formatRemaining(3661)).toBe("1:01:01");
  });
  it("clamps negatives to 0", () => {
    expect(formatRemaining(-5)).toBe("00:00");
  });
});
