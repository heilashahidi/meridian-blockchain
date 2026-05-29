import { describe, expect, it } from "vitest";

import { fromUsdc, shortKey, tickerToString, toUsdc } from "./format";

describe("usdc conversion", () => {
  it("formats whole and fractional base units", () => {
    expect(toUsdc(680_000_000n)).toBe("680");
    expect(toUsdc(1_500_000n)).toBe("1.5");
    expect(toUsdc(0n)).toBe("0");
    expect(toUsdc(1n)).toBe("0.000001");
  });

  it("round-trips through fromUsdc", () => {
    for (const s of ["680", "1.5", "0.000001", "0", "1000000.123456"]) {
      expect(toUsdc(fromUsdc(s))).toBe(s);
    }
  });

  it("parses partial fractions", () => {
    expect(fromUsdc("1.5")).toBe(1_500_000n);
    expect(fromUsdc(".25")).toBe(250_000n);
  });
});

describe("ticker decoding", () => {
  it("strips right-pad zeros", () => {
    expect(tickerToString([77, 69, 84, 65, 0, 0, 0, 0])).toBe("META");
    expect(tickerToString([68, 69, 77, 79, 0, 0, 0, 0])).toBe("DEMO");
  });
});

describe("shortKey", () => {
  it("abbreviates long keys", () => {
    expect(shortKey("7sYcxc2hbcHuiVWGE9ZR1gM52Sm24Rdp15aED3DdjaYA")).toBe(
      "7sYc…jaYA",
    );
  });
  it("leaves short strings alone", () => {
    expect(shortKey("abc")).toBe("abc");
  });
});
