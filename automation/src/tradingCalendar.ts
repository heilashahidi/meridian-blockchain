// tradingCalendar.ts — US equity market (NYSE/Nasdaq) trading-day calendar.
//
// The PRD requires the automation jobs to run "on US trading days" at ET wall
// times (morning create-strikes ~8:00 AM ET, settlement ~4:05 PM ET). That
// means two things this module provides, both dependency-free:
//
//   1. ET wall-clock conversion that is correct across DST. We never do manual
//      UTC±offset math (that breaks twice a year); instead we ask the platform
//      Intl/ICU database what the time is in `America/New_York`.
//   2. A trading-day predicate: false on weekends and on NYSE holidays (with
//      their observed-date shifts when a fixed holiday lands on a weekend).
//
// The holiday table is hand-maintained and covers 2025–2027 (the submission /
// near-term operating window). `holidayTableCoversYear` lets the scheduler warn
// loudly if it is ever run past the table's horizon rather than silently
// treating a holiday as a normal trading day.

/** ET wall-clock breakdown of an instant, DST-correct. */
export interface EtParts {
  /** `YYYY-MM-DD` in ET — the trading-day key. */
  ymd: string;
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
  /** 0–23 (ET). */
  hour: number;
  /** 0–59 (ET). */
  minute: number;
  /** 0 = Sunday … 6 = Saturday (ET). */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  weekday: "short",
});

/** Convert an instant to its ET wall-clock parts (DST handled by ICU). */
export function etPartsOf(date: Date): EtParts {
  const parts = ET_FORMAT.formatToParts(date);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  // `hour12: false` can render midnight as "24" on some ICU builds; normalize.
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(get("minute"));
  const weekday = WEEKDAY_INDEX[get("weekday")] ?? 0;

  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  return { ymd, year, month, day, hour, minute, weekday };
}

/**
 * NYSE holiday closures, by OBSERVED date (when a fixed-date holiday falls on a
 * weekend the market observes the nearest weekday). Hand-maintained; extend this
 * table before operating past `MAX_COVERED_YEAR`. Half-days (e.g. the day after
 * Thanksgiving) are intentionally NOT here — the market is open, and both jobs
 * (08:00 ET create, 16:05 ET settle) still make sense on a half day relative to
 * the 13:00 ET early close, so we treat half days as normal trading days.
 */
const NYSE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2025
  "2025-01-01", // New Year's Day
  "2025-01-20", // Martin Luther King Jr. Day
  "2025-02-17", // Washington's Birthday (Presidents' Day)
  "2025-04-18", // Good Friday
  "2025-05-26", // Memorial Day
  "2025-06-19", // Juneteenth
  "2025-07-04", // Independence Day
  "2025-09-01", // Labor Day
  "2025-11-27", // Thanksgiving Day
  "2025-12-25", // Christmas Day
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed — Jul 4 is a Saturday)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // Martin Luther King Jr. Day
  "2027-02-15", // Washington's Birthday
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth (observed — Jun 19 is a Saturday)
  "2027-07-05", // Independence Day (observed — Jul 4 is a Sunday)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving Day
  "2027-12-24", // Christmas Day (observed — Dec 25 is a Saturday)
]);

/** Last year the holiday table covers. Extend `NYSE_HOLIDAYS` past this. */
export const MAX_COVERED_YEAR = 2027;

/** True if the holiday table covers `year` (else only the weekend rule applies). */
export function holidayTableCoversYear(year: number): boolean {
  return year >= 2025 && year <= MAX_COVERED_YEAR;
}

/** True if `et`'s date is a hand-listed NYSE holiday (observed). */
export function isUsMarketHoliday(et: EtParts): boolean {
  return NYSE_HOLIDAYS.has(et.ymd);
}

/** True if `et` falls on a Saturday or Sunday (ET). */
export function isWeekend(et: EtParts): boolean {
  return et.weekday === 0 || et.weekday === 6;
}

/**
 * True if `et`'s ET date is a US equity trading day: a weekday that is not an
 * NYSE holiday. Half-days count as trading days.
 */
export function isUsTradingDay(et: EtParts): boolean {
  return !isWeekend(et) && !isUsMarketHoliday(et);
}
