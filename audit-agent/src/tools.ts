import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  ENABLE_TRIDENT,
  PROGRAM_DIR,
  READ_ROOTS,
  REPO_ROOT,
  TIMEOUTS,
  TRIDENT_DIR,
} from "./config.js";
import type { Probe } from "./schema.js";

const MAX_OUT = 6000; // probe-output cap (keep tool noise small)
const SRC_MAX = 32_000; // source-read cap — big enough for the 750-line engine

function clip(s: string, max = MAX_OUT): string {
  return s.length > max ? s.slice(0, max) + "\n…[truncated]" : s;
}

/** Resolve a caller-supplied path and refuse anything outside READ_ROOTS. */
function safeResolve(rel: string): string | null {
  for (const root of READ_ROOTS) {
    const abs = path.resolve(root, rel);
    if (abs === root || abs.startsWith(root + path.sep)) {
      if (fs.existsSync(abs)) return abs;
    }
  }
  // Also allow an absolute path that already sits under a read root.
  const abs = path.resolve(rel);
  if (READ_ROOTS.some((r) => abs === r || abs.startsWith(r + path.sep))) {
    return fs.existsSync(abs) ? abs : null;
  }
  return null;
}

/** Read a source file (optionally only the lines matching a regex). */
export function readSource(rel: string, grep?: string): string {
  const abs = safeResolve(rel);
  if (!abs) return `ERROR: ${rel} is outside the auditable program tree or does not exist.`;
  if (fs.statSync(abs).isDirectory()) {
    return fs.readdirSync(abs).join("\n");
  }
  const text = fs.readFileSync(abs, "utf8");
  if (!grep) return clip(text, SRC_MAX);
  let re: RegExp;
  try {
    re = new RegExp(grep);
  } catch {
    return `ERROR: invalid grep regex: ${grep}`;
  }
  const hits = text
    .split("\n")
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => re.test(l))
    .map(([n, l]) => `${n}: ${l}`);
  return hits.length ? clip(hits.join("\n")) : "(no matches)";
}

interface ProbeResult {
  command: string;
  exitCode: number | null;
  output: string;
  ran: boolean; // false when a probe kind is disabled / a binary is missing
}

function run(cmd: string, args: string[], cwd: string, timeout: number): ProbeResult {
  const r = spawnSync(cmd, args, {
    cwd,
    timeout,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { command: `${cmd} ${args.join(" ")}`, exitCode: null, output: `binary not found: ${cmd}`, ran: false };
  }
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { command: `${cmd} ${args.join(" ")}`, exitCode: null, output: `timed out after ${timeout}ms`, ran: true };
  }
  return { command: `${cmd} ${args.join(" ")}`, exitCode: r.status, output: clip(out || "(no output)"), ran: true };
}

const MANIFEST = path.join(PROGRAM_DIR, "Cargo.toml");

/**
 * Map a structured Probe to a fixed, allow-listed command and run it. The model
 * picks the kind + safe params; this is the only place commands are constructed,
 * so there is no arbitrary-exec surface.
 */
export function runProbe(probe: Probe): ProbeResult {
  switch (probe.kind) {
    case "grep": {
      const pattern = probe.pattern ?? "";
      if (!pattern) return { command: "grep", exitCode: null, output: "ERROR: grep probe needs a pattern", ran: false };
      const target = probe.file ? safeResolve(probe.file) ?? PROGRAM_DIR : PROGRAM_DIR;
      // -r recursive, -n line numbers, -E extended regex. Args are an array (no shell).
      return run("grep", ["-rnE", pattern, target], REPO_ROOT, TIMEOUTS.grep);
    }
    case "cargo-check":
      return run("cargo", ["check", "--manifest-path", MANIFEST], REPO_ROOT, TIMEOUTS.cargo);
    case "clippy":
      return run("cargo", ["clippy", "--manifest-path", MANIFEST], REPO_ROOT, TIMEOUTS.cargo);
    case "cargo-audit":
      return run("cargo", ["audit"], REPO_ROOT, TIMEOUTS.cargo);
    case "trident": {
      if (!ENABLE_TRIDENT) {
        return {
          command: "trident fuzz run clob_invariants",
          exitCode: null,
          output: "trident probe skipped (set AUDIT_ENABLE_TRIDENT=1 to enable the slow deep-verify run)",
          ran: false,
        };
      }
      const iters = String(probe.iterations ?? 500);
      const r = spawnSync("trident", ["fuzz", "run", "clob_invariants"], {
        cwd: TRIDENT_DIR,
        timeout: TIMEOUTS.trident,
        encoding: "utf8",
        env: { ...process.env, TRIDENT_ITERATIONS: iters, TRIDENT_FLOW_CALLS: "20" },
        maxBuffer: 32 * 1024 * 1024,
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
      return { command: `trident fuzz run clob_invariants (iters=${iters})`, exitCode: r.status, output: clip(out || "(no output)"), ran: true };
    }
  }
}
