#!/usr/bin/env node
// index.ts — CLI entry for the Meridian automation service.
//
// Two subcommands, run by cron or by hand:
//   create-strikes   morning job — create the day's MAG7 strike markets (U4)
//   settle           after-close job — settle open markets via Pyth (U5)
//
// U3 ships only the scaffold + dispatch: the job bodies live in
// src/jobs/{createStrikes,settle}.ts (added by U4/U5). Until then the
// subcommands throw a clear "not implemented" so the wiring is exercised but
// nobody mistakes a stub for a working job.

import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { runCreateStrikesJob } from "./jobs/createStrikes.js";
import { runSettleJob } from "./jobs/settle.js";
import {
  DEFAULT_SCHEDULE,
  runScheduler,
  type HourMinute,
  type ScheduleConfig,
} from "./scheduler.js";

const USAGE = `meridian-automation — daily jobs for the Meridian on-chain CLOB

Usage:
  meridian-automation <command> [options]

Commands:
  create-strikes    Create the day's MAG7 strike markets (morning job).
  settle            Settle open/expired markets via the Pyth oracle, with
                    admin-override fallback (after-close job).
  schedule          Run as a daemon: fire create-strikes (~08:00 ET) and settle
                    (~16:05 ET) automatically on US trading days. Ctrl-C to stop.

Options:
  -h, --help        Show this help and exit.
      --dry-run     (create-strikes) Plan + diff against existing markets but
                    make no on-chain writes.

Environment:
  RPC_URL               Solana RPC (default https://api.devnet.solana.com)
  HERMES_URL            Pyth Hermes endpoint (default https://hermes.pyth.network)
  PYTH_RECEIVER         Pyth receiver program (default rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ)
  ADMIN_KEYPAIR         Path to admin keypair JSON (default ~/.config/solana/id.json)
  TICKERS               Comma-separated subset, e.g. AAPL,NVDA,TSLA (default demo subset)
  STRIKE_PERCENTS       Comma-separated % offsets from prev close (default 3,6,9 per PRD)
  STRIKE_ROUNDING       Round each strike to nearest $N (default 10 per PRD)
  EXPIRY_HOURS_FROM_NOW Market expiry horizon in hours (default 24)
  LOG_LEVEL             debug|info|warn|error (default info)
  ALERT_WEBHOOK         Optional webhook URL for alert() escalations
  OVERRIDE_PRICES       (settle) Comma-separated TICKER=price for the admin
                        override fallback, e.g. AAPL=187.5,NVDA=120
  SCHEDULE_MORNING_ET   (schedule) ET time for create-strikes, HH:MM (default 08:00)
  SCHEDULE_SETTLE_ET    (schedule) ET time for settle, HH:MM (default 16:05)
  SCHEDULE_TICK_MS      (schedule) Poll interval in ms (default 60000)
`;

type Command = "create-strikes" | "settle" | "schedule";

export function printHelp(): void {
  process.stdout.write(USAGE);
}

/** Parse an `HH:MM` env value into [hour, minute], falling back to `fallback`. */
export function parseHourMinute(
  raw: string | undefined,
  fallback: HourMinute,
): HourMinute {
  if (!raw) return fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) throw new Error(`expected HH:MM, got "${raw}"`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`time out of range: "${raw}"`);
  }
  return [hour, minute];
}

/** Build the schedule from env (SCHEDULE_MORNING_ET / SCHEDULE_SETTLE_ET). */
function scheduleFromEnv(env: NodeJS.ProcessEnv): ScheduleConfig {
  return {
    morningHm: parseHourMinute(env.SCHEDULE_MORNING_ET, DEFAULT_SCHEDULE.morningHm),
    settleHm: parseHourMinute(env.SCHEDULE_SETTLE_ET, DEFAULT_SCHEDULE.settleHm),
    fireWindowMinutes: DEFAULT_SCHEDULE.fireWindowMinutes,
  };
}

/** Run the scheduler daemon until SIGINT/SIGTERM. */
async function runScheduleDaemon(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  let running = true;
  const stop = (signal: string): void => {
    if (!running) return;
    running = false;
    log.info("scheduler: shutdown signal received, stopping after current tick", {
      signal,
    });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await runScheduler(
    {
      now: () => new Date(),
      runMorning: async () => {
        await runCreateStrikesJob(cfg, { dryRun: false });
      },
      runSettle: async () => {
        await runSettleJob(cfg);
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      running: () => running,
    },
    {
      schedule: scheduleFromEnv(process.env),
      tickMs: process.env.SCHEDULE_TICK_MS
        ? Number(process.env.SCHEDULE_TICK_MS)
        : undefined,
    },
  );
}

/** Parse argv into a command (or null) + a help flag. Exported for tests. */
export function parseArgs(argv: string[]): {
  command: Command | null;
  help: boolean;
  dryRun: boolean;
  unknown?: string;
} {
  const args = argv.slice(2);
  let help = false;
  let dryRun = false;
  let command: Command | null = null;
  let unknown: string | undefined;

  for (const a of args) {
    if (a === "-h" || a === "--help") {
      help = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "create-strikes" || a === "settle" || a === "schedule") {
      command = a;
    } else if (!a.startsWith("-") && command === null) {
      unknown = a;
    }
    // Other job-specific flags are ignored here.
  }

  return { command, help, dryRun, unknown };
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const { command, help, dryRun, unknown } = parseArgs(argv);

  if (help || (command === null && unknown === undefined)) {
    printHelp();
    return help ? 0 : command === null ? 1 : 0;
  }

  if (unknown !== undefined && command === null) {
    log.error("unknown command", { command: unknown });
    printHelp();
    return 1;
  }

  const cfg = loadConfig();
  log.info("starting job", {
    command,
    rpcUrl: cfg.rpcUrl,
    tickers: cfg.tickers,
  });

  try {
    if (command === "create-strikes") await runCreateStrikesJob(cfg, { dryRun });
    else if (command === "settle") await runSettleJob(cfg);
    else if (command === "schedule") await runScheduleDaemon(cfg);
    log.info("job complete", { command });
    return 0;
  } catch (e) {
    log.error("job failed", {
      command,
      error: e instanceof Error ? e.message : String(e),
    });
    return 1;
  }
}

// Only run when invoked directly (not when imported by a test).
const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith(process.argv[1].replace(/^.*\//, "")));

if (isDirect) {
  main().then((code) => process.exit(code));
}
