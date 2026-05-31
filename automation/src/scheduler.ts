// scheduler.ts — long-running scheduler for the two daily automation jobs.
//
// The PRD asks for "two scheduled jobs on US trading days": a morning job
// (~08:00 ET) that creates the day's strike markets, and a settlement job
// (~16:05 ET) that settles open markets after the 16:00 ET close. This module
// turns the one-shot CLI jobs into a daemon that fires them at the right ET wall
// times on trading days only.
//
// Design — a simple poll loop, NOT a third-party cron dependency:
//   * Every `tickMs` (default 60s) we read the current ET wall clock and ask
//     `dueJobs` which jobs (if any) are due. ET is recomputed each tick, so DST
//     transitions are handled for free (see tradingCalendar.ts).
//   * Each job fires at most once per ET day, within a small minutes-wide window
//     starting at its target time. The window (default 5 min) absorbs tick drift
//     and brief downtime without ever double-firing or firing all day.
//   * `dueJobs` is pure (no IO, injectable clock) so the firing logic is unit
//     tested without waiting on real time; the loop itself just wires effects.
//
// Avoiding `node-cron` keeps the dependency surface minimal (a PRD ask) and lets
// us own the trading-day gate, the once-per-day guard, and the ET/DST handling
// explicitly rather than trusting a cron string.

import { log } from "./log.js";
import {
  etPartsOf,
  holidayTableCoversYear,
  isUsTradingDay,
  type EtParts,
} from "./tradingCalendar.js";

export type JobName = "morning" | "settle";

/** ET target time-of-day for a job, as [hour, minute]. */
export type HourMinute = [number, number];

export interface ScheduleConfig {
  /** ET time the morning create-strikes job fires. Default 08:00. */
  morningHm: HourMinute;
  /** ET time the settlement job fires. Default 16:05 (5 min after close). */
  settleHm: HourMinute;
  /**
   * Minutes after the target time during which a still-unfired job will fire.
   * Absorbs poll drift and short downtime. Default 5.
   */
  fireWindowMinutes: number;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  morningHm: [8, 0],
  settleHm: [16, 5],
  fireWindowMinutes: 5,
};

/** Per-job "last fired on this ET date" bookkeeping (once-per-day guard). */
export interface SchedulerState {
  lastMorningYmd: string | null;
  lastSettleYmd: string | null;
}

export function initialState(): SchedulerState {
  return { lastMorningYmd: null, lastSettleYmd: null };
}

const minutesOfDay = (et: EtParts): number => et.hour * 60 + et.minute;

function inFireWindow(
  et: EtParts,
  [h, m]: HourMinute,
  windowMinutes: number,
): boolean {
  const now = minutesOfDay(et);
  const target = h * 60 + m;
  return now >= target && now < target + windowMinutes;
}

/**
 * Pure decision: given the current ET parts, schedule, and last-fired state,
 * return which jobs are due right now. Empty on non-trading days, outside every
 * fire window, or when a job already fired today. Caller is responsible for
 * recording the fire in `state` (do it BEFORE running the job so a long job
 * can't be re-fired by the next tick).
 */
export function dueJobs(
  et: EtParts,
  cfg: ScheduleConfig,
  state: SchedulerState,
): JobName[] {
  if (!isUsTradingDay(et)) return [];
  const due: JobName[] = [];
  if (
    state.lastMorningYmd !== et.ymd &&
    inFireWindow(et, cfg.morningHm, cfg.fireWindowMinutes)
  ) {
    due.push("morning");
  }
  if (
    state.lastSettleYmd !== et.ymd &&
    inFireWindow(et, cfg.settleHm, cfg.fireWindowMinutes)
  ) {
    due.push("settle");
  }
  return due;
}

/** Effects + clock the run loop depends on (all injectable for tests). */
export interface SchedulerDeps {
  /** Current instant. Default `new Date()`. */
  now: () => Date;
  /** Run the morning create-strikes job. */
  runMorning: () => Promise<void>;
  /** Run the settlement job. */
  runSettle: () => Promise<void>;
  /** Sleep between polls. */
  sleep: (ms: number) => Promise<void>;
  /** Loop continues while this returns true (flip it on SIGINT/SIGTERM). */
  running: () => boolean;
}

export interface RunSchedulerOptions {
  schedule?: ScheduleConfig;
  /** Poll interval. Default 60_000ms. */
  tickMs?: number;
  /** Seed state (tests). Default fresh. */
  state?: SchedulerState;
}

/**
 * Run the scheduler loop until `deps.running()` goes false. Fires due jobs,
 * recording each fire BEFORE awaiting it so a slow job is never double-fired,
 * and never lets a job failure crash the loop (logged + escalated, then the
 * loop continues to the next day/job).
 */
export async function runScheduler(
  deps: SchedulerDeps,
  opts: RunSchedulerOptions = {},
): Promise<void> {
  const cfg = opts.schedule ?? DEFAULT_SCHEDULE;
  const tickMs = opts.tickMs ?? 60_000;
  const state = opts.state ?? initialState();

  const startEt = etPartsOf(deps.now());
  if (!holidayTableCoversYear(startEt.year)) {
    log.warn(
      "scheduler: holiday table does not cover the current year — only the " +
        "weekend rule applies; extend NYSE_HOLIDAYS in tradingCalendar.ts",
      { year: startEt.year, maxCoveredYear: 2027 },
    );
  }
  log.info("scheduler started", {
    morningEt: cfg.morningHm.join(":"),
    settleEt: cfg.settleHm.join(":"),
    fireWindowMinutes: cfg.fireWindowMinutes,
    tickMs,
    nowEt: `${startEt.ymd} ${String(startEt.hour).padStart(2, "0")}:${String(
      startEt.minute,
    ).padStart(2, "0")}`,
  });

  while (deps.running()) {
    const et = etPartsOf(deps.now());
    for (const job of dueJobs(et, cfg, state)) {
      // Record the fire FIRST (once-per-day guard holds even if the job throws
      // or runs long enough to span the next tick).
      if (job === "morning") state.lastMorningYmd = et.ymd;
      else state.lastSettleYmd = et.ymd;

      log.info("scheduler firing job", { job, et: et.ymd });
      try {
        if (job === "morning") await deps.runMorning();
        else await deps.runSettle();
        log.info("scheduler job complete", { job, et: et.ymd });
      } catch (e) {
        // A failed daily job must not kill the daemon — the other job and the
        // next trading day still need to run.
        log.error("scheduler job failed", {
          job,
          et: et.ymd,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (!deps.running()) break;
    await deps.sleep(tickMs);
  }

  log.info("scheduler stopped");
}
