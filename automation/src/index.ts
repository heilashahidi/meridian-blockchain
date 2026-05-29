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

const USAGE = `meridian-automation — daily jobs for the Meridian on-chain CLOB

Usage:
  meridian-automation <command> [options]

Commands:
  create-strikes    Create the day's MAG7 strike markets (morning job).
  settle            Settle open/expired markets via the Pyth oracle, with
                    admin-override fallback (after-close job).

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
  STRIKES_PER_SIDE      Strikes each side of the reference price (default 3)
  EXPIRY_HOURS_FROM_NOW Market expiry horizon in hours (default 24)
  LOG_LEVEL             debug|info|warn|error (default info)
  ALERT_WEBHOOK         Optional webhook URL for alert() escalations
`;

type Command = "create-strikes" | "settle";

/**
 * Job dispatchers. `create-strikes` is implemented (U4) — it delegates to the
 * job in src/jobs/createStrikes.ts. `settle` remains a stub until U5.
 */
async function runSettle(): Promise<void> {
  throw new Error("settle is not implemented yet (U5)");
}

export function printHelp(): void {
  process.stdout.write(USAGE);
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
    } else if (a === "create-strikes" || a === "settle") {
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
    else if (command === "settle") await runSettle();
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
