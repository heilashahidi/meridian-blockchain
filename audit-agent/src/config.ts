import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (audit-agent/.. ). Every toolchain command runs relative to this. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** The Anchor program under audit. */
export const PROGRAM_DIR = path.join(REPO_ROOT, "programs", "meridian");
export const INSTRUCTIONS_DIR = path.join(PROGRAM_DIR, "src", "instructions");
export const TRIDENT_DIR = path.join(REPO_ROOT, "trident-tests");

/** Anything the readSource tool is allowed to touch — keeps the agent inside
 *  the program it is auditing (no reading the whole machine). */
export const READ_ROOTS = [PROGRAM_DIR, TRIDENT_DIR];

export const MODEL = process.env.AUDIT_MODEL ?? "claude-sonnet-4-6";
export const MAX_TARGETS = Number(process.env.AUDIT_MAX_TARGETS ?? "0") || 0;
export const ENABLE_TRIDENT = process.env.AUDIT_ENABLE_TRIDENT === "1";
/** Scope a run to instruction files whose name contains this substring (used by
 *  the eval harness to audit just the patched file cheaply). Empty = all. */
export const ONLY = process.env.AUDIT_ONLY ?? "";

/** Per-command wall-clock caps (ms). cargo/trident builds are slow; bound them. */
export const TIMEOUTS = {
  grep: 15_000,
  cargo: 240_000,
  trident: 420_000,
} as const;

export const REPORTS_DIR = path.join(__dirname, "..", "reports");
