// log.ts — structured (JSON-lines) leveled logging + an `alert()` seam.
//
// All log lines are single-line JSON written to stderr (so stdout stays clean
// for any machine-readable job output, e.g. a created-market list). `alert()`
// is the escalation seam the jobs (U4/U5) call on persistent failure: it always
// writes a `level: "alert"` line and, if `ALERT_WEBHOOK` is set, best-effort
// POSTs the message to that URL. The webhook post never throws into the caller.

export type LogLevel = "debug" | "info" | "warn" | "error" | "alert";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  alert: 50,
};

function envLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return (raw in LEVEL_ORDER ? raw : "info") as LogLevel;
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[envLevel()]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  // Serialize bigint safely; everything structured goes to stderr.
  process.stderr.write(
    `${JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`,
  );
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

/**
 * Escalation seam. Always logs at `alert` level (stderr) and, if
 * `ALERT_WEBHOOK` is configured, best-effort POSTs a JSON body to it. Webhook
 * failures are swallowed (logged at warn) so alerting never crashes a job.
 */
export async function alert(
  msg: string,
  fields?: Record<string, unknown>,
): Promise<void> {
  emit("alert", msg, fields);

  const webhook = process.env.ALERT_WEBHOOK;
  if (!webhook) return;

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `[meridian-automation] ${msg}`,
        ...(fields ?? {}),
      }),
    });
    if (!res.ok) {
      emit("warn", "alert webhook returned non-OK", { status: res.status });
    }
  } catch (e) {
    emit("warn", "alert webhook post failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
