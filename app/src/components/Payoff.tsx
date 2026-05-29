// Payoff display: a binary option pays $1.00 if the stock settles above the
// strike, else $0. The pure formatter is exported so it can be unit-tested
// without rendering React.

export interface PayoffInput {
  /** What the buyer pays per contract, in dollars. */
  pay: number;
  /** Underlying ticker, e.g. "AAPL". */
  ticker: string;
  /** Strike price in dollars. */
  strike: number;
  /** Side of the bet — "Yes" wins above the strike, "No" wins at/below. */
  side?: "Yes" | "No";
}

function usd(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Pure payoff text, e.g.
 *   "You pay $0.62, win $1.00 if AAPL above $200.00"
 * For the No side, "above" becomes "at or below".
 */
export function payoffText(input: PayoffInput): string {
  const { pay, ticker, strike, side = "Yes" } = input;
  const direction = side === "No" ? "at or below" : "above";
  return `You pay $${usd(pay)}, win $1.00 if ${ticker} ${direction} $${usd(strike)}`;
}

export function Payoff({ pay, ticker, strike, side = "Yes" }: PayoffInput) {
  return (
    <div className="muted" style={{ fontSize: 13 }}>
      {payoffText({ pay, ticker, strike, side })}
    </div>
  );
}
