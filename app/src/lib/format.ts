// Display helpers. Yes/No mints and USDC are all 6-decimal; `price` is USDC
// microunits per Yes base unit (the program is a generic CLOB and does not
// constrain price to the $1 payout). We show raw base units in most places to
// match the scripts' legible-integer convention, with a USDC helper for the
// dollar-denominated fields.

export const USDC_DECIMALS = 6;

/** Convert a 6-decimal base-unit amount to a human dollar string. */
export function toUsdc(baseUnits: bigint | number): string {
  const n = BigInt(baseUnits);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Parse a dollar string into 6-decimal base units. */
export function fromUsdc(dollars: string): bigint {
  const [whole, frac = ""] = dollars.trim().split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(fracPadded || "0");
}

/** Decode an 8-byte ticker array (right-zero-padded ASCII) to a string. */
export function tickerToString(bytes: number[] | Uint8Array): string {
  return new TextDecoder()
    .decode(Uint8Array.from(bytes))
    .replace(/\0+$/, "");
}

/** Short pubkey for display, e.g. `7sYc…jaYA`. */
export function shortKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key;
}

/** Unix seconds → local datetime string. */
export function fmtExpiry(unix: bigint | number): string {
  return new Date(Number(unix) * 1000).toLocaleString();
}
