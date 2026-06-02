/**
 * Eval harness — the "ties them together" piece.
 *
 * For each seeded bug we mutate the real program source (a known vulnerability),
 * run the auditor scoped to the affected file, and score whether it caught the
 * bug (recall). A clean baseline run on the same file counts any findings as
 * false positives (precision). Source is ALWAYS restored, and the harness aborts
 * if a target file isn't git-clean to begin with — it never risks your tree.
 *
 *   npm run eval -- --selftest   # no LLM: prove apply/restore round-trips safely
 *   ANTHROPIC_API_KEY=… npm run eval
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PROGRAM_DIR } from "../src/config.js";

interface Bug {
  id: string;
  file: string; // instruction file (basename)
  vulnClass: string;
  desc: string;
  /** Remove the vulnerable-protection lines; throws if the marker is absent so
   *  a stale marker can never silently produce a no-op "clean" variant. */
  mutate: (src: string) => string;
}

function removeLineContaining(src: string, marker: string): string {
  const lines = src.split("\n");
  const idx = lines.findIndex((l) => l.includes(marker));
  if (idx < 0) throw new Error(`marker not found: ${marker}`);
  lines.splice(idx, 1);
  return lines.join("\n");
}

/** Remove a `require!( … <marker> … );` block (the macro call that enforces a
 *  check), leaving the rest intact. */
function removeRequireBlock(src: string, marker: string): string {
  const lines = src.split("\n");
  const m = lines.findIndex((l) => l.includes(marker));
  if (m < 0) throw new Error(`marker not found: ${marker}`);
  let start = m;
  while (start > 0 && !lines[start].includes("require!(")) start--;
  let end = m;
  while (end < lines.length && !lines[end].includes(");")) end++;
  if (!lines[start].includes("require!(")) throw new Error(`no require!( above ${marker}`);
  lines.splice(start, end - start + 1);
  return lines.join("\n");
}

const BUGS: Bug[] = [
  {
    id: "missing-admin-check",
    file: "create_strike_market.rs",
    vulnClass: "missing-signer",
    desc: "drop `has_one = admin` so any signer can create markets",
    mutate: (s) => removeLineContaining(s, "has_one = admin @ MeridianError::Unauthorized"),
  },
  {
    id: "grace-bypass",
    file: "admin.rs",
    vulnClass: "oracle-settlement",
    desc: "drop the emergency-settle grace gate so admin can settle pre-window",
    mutate: (s) => removeRequireBlock(s, "EmergencyGraceNotElapsed"),
  },
];

const abs = (file: string) => path.join(PROGRAM_DIR, "src", "instructions", file);

function gitClean(file: string): boolean {
  const out = execFileSync("git", ["status", "--porcelain", abs(file)], {
    cwd: PROGRAM_DIR,
    encoding: "utf8",
  });
  return out.trim() === "";
}

/** Snapshot → mutate → run `body` → ALWAYS restore → verify byte-identical. */
async function withBug<T>(bug: Bug, body: () => Promise<T>): Promise<T> {
  const p = abs(bug.file);
  const original = fs.readFileSync(p, "utf8");
  const mutated = bug.mutate(original);
  if (mutated === original) throw new Error(`${bug.id}: mutation was a no-op`);
  fs.writeFileSync(p, mutated);
  try {
    return await body();
  } finally {
    fs.writeFileSync(p, original);
    if (fs.readFileSync(p, "utf8") !== original) {
      throw new Error(`${bug.id}: FAILED TO RESTORE ${bug.file} — check git diff!`);
    }
  }
}

async function auditFile(file: string): Promise<{ instruction: string; vulnClass: string }[]> {
  process.env.AUDIT_ONLY = file.replace(/\.rs$/, "");
  const { buildAuditor } = await import("../src/graph.js");
  const res = await buildAuditor().invoke({}, { recursionLimit: 100 });
  return res.findings.map((f) => ({ instruction: f.instruction, vulnClass: f.vulnClass }));
}

async function selftest() {
  console.log("● selftest — apply/restore round-trip (no LLM)\n");
  for (const bug of BUGS) {
    if (!gitClean(bug.file)) {
      console.log(`  ✗ ${bug.id}: ${bug.file} is not git-clean — skipping (won't mutate a dirty file)`);
      continue;
    }
    const before = fs.readFileSync(abs(bug.file), "utf8");
    await withBug(bug, async () => {
      const during = fs.readFileSync(abs(bug.file), "utf8");
      if (during === before) throw new Error("mutation didn't change the file");
      console.log(`  ✓ ${bug.id}: mutation applied (${bug.desc})`);
    });
    const after = fs.readFileSync(abs(bug.file), "utf8");
    console.log(`    restored byte-identical: ${after === before}`);
  }
  console.log("\n● selftest ok — the harness mutates and restores safely.");
}

async function fullEval() {
  let caught = 0;
  let falsePositives = 0;
  const rows: string[] = [];

  for (const bug of BUGS) {
    if (!gitClean(bug.file)) {
      console.log(`skip ${bug.id}: ${bug.file} not git-clean`);
      continue;
    }
    // Baseline: clean file → any finding here is a false positive.
    const baseline = await auditFile(bug.file);
    falsePositives += baseline.length;

    // Seeded: mutate → audit → did it flag this file?
    const found = await withBug(bug, () => auditFile(bug.file));
    const hit = found.some((f) => f.instruction.includes(bug.file.replace(/\.rs$/, "")) || f.instruction.includes(bug.file));
    if (hit) caught++;
    rows.push(`  ${hit ? "✓ caught " : "✗ missed "} ${bug.id.padEnd(20)} (${bug.vulnClass}) — baseline FPs: ${baseline.length}`);
  }

  console.log("\n● eval results");
  rows.forEach((r) => console.log(r));
  console.log(
    `\n  recall: ${caught}/${BUGS.length}  ·  false positives on clean code: ${falsePositives}`,
  );
}

const mode = process.argv.includes("--selftest") ? selftest : fullEval;
if (mode === fullEval && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set. Run `npm run eval -- --selftest` for the no-LLM machinery test.");
  process.exit(1);
}
mode().catch((e) => {
  console.error("eval failed:", e?.message ?? e);
  process.exit(1);
});
