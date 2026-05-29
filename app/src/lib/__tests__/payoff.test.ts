import { describe, expect, it } from "vitest";

import { payoffText } from "@/components/Payoff";

describe("payoffText", () => {
  it("formats the Yes-side payoff string", () => {
    expect(payoffText({ pay: 0.62, ticker: "AAPL", strike: 200 })).toBe(
      "You pay $0.62, win $1.00 if AAPL above $200.00",
    );
  });

  it("formats the No-side payoff with 'at or below'", () => {
    expect(
      payoffText({ pay: 0.38, ticker: "TSLA", strike: 250, side: "No" }),
    ).toBe("You pay $0.38, win $1.00 if TSLA at or below $250.00");
  });

  it("rounds pay and strike to two decimals", () => {
    expect(payoffText({ pay: 0.5, ticker: "NVDA", strike: 1234.5 })).toBe(
      "You pay $0.50, win $1.00 if NVDA above $1,234.50",
    );
  });
});
