// Pure settlement-countdown time math (U8). Kept framework-free so the
// "time-to-expiry / closed" logic is unit-testable in the node vitest env; the
// `Countdown` component renders `countdownState(Date.now()/1000, expiry)`.
//
// Markets expire at 4PM ET; `expiryUnix` already encodes that absolute instant
// (unix seconds), so the countdown is just `expiry − now` with no timezone math
// needed here.

export interface CountdownState {
  /** True once now >= expiry (trading is closed / awaiting settlement). */
  closed: boolean;
  /** Whole seconds remaining, clamped to 0 once closed. */
  remainingSeconds: number;
  /** Display label: "Closed", "mm:ss", or "h:mm:ss". */
  label: string;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Format a remaining-seconds count for the settlement countdown:
 *   - >= 1 day  → "Nd HHh"  (so a far-out market doesn't render a very wide
 *                 8-char clock like "269:52:15" in the hero),
 *   - >= 1 hour → "H:MM:SS",
 *   - else      → "MM:SS".
 */
export function formatRemaining(remainingSeconds: number): string {
  const s = Math.max(0, Math.floor(remainingSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${pad2(hours)}h`;
  return hours > 0
    ? `${hours}:${pad2(mins)}:${pad2(secs)}`
    : `${pad2(mins)}:${pad2(secs)}`;
}

/**
 * Format a market's expiry instant as its ET wall-clock label, e.g.
 * "4:00 PM ET". `expiryUnix` is an absolute instant, so we render it in
 * `America/New_York` via Intl — DST-correct, and HONEST: if a market's expiry
 * isn't actually 4:00 PM ET the label reflects the real time instead of a
 * hardcoded "4:00 PM ET" that could silently lie.
 */
export function expiryEtLabel(expiryUnix: number): string {
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(expiryUnix * 1000));
  return `${t} ET`;
}

/**
 * Pure countdown state from a `now` and an `expiry` (both unix seconds). At or
 * past expiry the market is closed (remaining 0, label "Closed").
 */
export function countdownState(
  nowUnix: number,
  expiryUnix: number,
): CountdownState {
  const remaining = Math.floor(expiryUnix - nowUnix);
  if (remaining <= 0) {
    return { closed: true, remainingSeconds: 0, label: "Closed" };
  }
  return {
    closed: false,
    remainingSeconds: remaining,
    label: formatRemaining(remaining),
  };
}
