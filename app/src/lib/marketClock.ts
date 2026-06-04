// Pure market-session math for the global top-bar clock. Framework-free so the
// open/closed state and the "next close vs next open" countdown are unit-testable
// in the node vitest env.
//
// US equities trade 9:30 AM–4:00 PM ET on weekdays. While the market is open we
// count down to today's 4:00 PM close ("Settles 4:00 PM ET"); while it's closed
// — overnight, before the open, or on a weekend — we count down to the next
// session's 9:30 AM open ("Opens 9:30 AM ET"), skipping Saturday and Sunday.
//
// Inputs are ET wall-clock values (a weekday index + seconds-into-the-ET-day),
// so there's no timezone offset math here — the caller derives them via Intl,
// which keeps the whole thing DST-correct.

/** 9:30 AM ET, as seconds into the ET day. */
const OPEN_SEC = 9 * 3600 + 30 * 60;
/** 4:00 PM ET, as seconds into the ET day. */
const CLOSE_SEC = 16 * 3600;
const DAY_SEC = 24 * 3600;

const ET_WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Map an `Intl` `weekday: "short"` ET label ("Mon"…"Sun") to a JS `getDay`
 * index (Sun=0…Sat=6). Unknown input falls back to Monday so the clock degrades
 * to a normal trading day rather than throwing.
 */
export function etWeekdayIndex(short: string): number {
  return ET_WEEKDAY_INDEX[short] ?? 1;
}

export interface MarketSession {
  /** True on a weekday between 9:30 AM and 4:00 PM ET. */
  open: boolean;
  /** Footer caption: "Settles 4:00 PM ET" (open) or "Opens 9:30 AM ET" (closed). */
  caption: string;
  /**
   * Seconds until the relevant target: today's 4:00 PM close while open, else
   * the next trading day's 9:30 AM open. Always > 0.
   */
  remainingSeconds: number;
}

const isTradingDay = (idx: number) => idx >= 1 && idx <= 5; // Mon–Fri

/**
 * Market session + countdown from an ET weekday index (Sun=0…Sat=6) and the
 * seconds-into-the-ET-day. Open → counts to today's 4 PM close; closed → counts
 * to the next trading day's 9:30 AM open, skipping weekends.
 */
export function marketSession(
  weekdayIndex: number,
  nowSec: number,
): MarketSession {
  const open =
    isTradingDay(weekdayIndex) && nowSec >= OPEN_SEC && nowSec < CLOSE_SEC;

  if (open) {
    return {
      open: true,
      caption: "Settles 4:00 PM ET",
      remainingSeconds: CLOSE_SEC - nowSec,
    };
  }

  // Closed: find the next 9:30 AM ET open. Today still qualifies only if it's a
  // weekday and we're before the open; otherwise scan forward (tomorrow onward)
  // to the next Mon–Fri.
  let days = isTradingDay(weekdayIndex) && nowSec < OPEN_SEC ? 0 : 1;
  while (days > 0 && !isTradingDay((weekdayIndex + days) % 7)) days++;

  return {
    open: false,
    caption: "Opens 9:30 AM ET",
    remainingSeconds: days * DAY_SEC + OPEN_SEC - nowSec,
  };
}
