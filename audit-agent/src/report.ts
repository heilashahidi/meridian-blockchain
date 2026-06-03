import fs from "node:fs";
import path from "node:path";

import { REPORTS_DIR } from "./config.js";
import type { Finding } from "./schema.js";

const SEV_ORDER = ["critical", "high", "medium", "low", "info"] as const;

/** Write a markdown report and return its path. Returns findings sorted by
 *  severity so the worst things are on top. */
export function writeReport(findings: Finding[], log: string[], stamp = "latest"): string {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const sorted = [...findings].sort(
    (a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity),
  );

  const lines: string[] = [];
  lines.push(`# Meridian audit-agent report`);
  lines.push("");
  lines.push(`Confirmed findings: **${sorted.length}**`);
  lines.push("");
  if (sorted.length === 0) {
    lines.push("_No vulnerabilities confirmed in this pass._");
  }
  for (const f of sorted) {
    lines.push(`## [${f.severity.toUpperCase()}] ${f.vulnClass} — ${f.instruction}`);
    lines.push(`- **Claim:** ${f.claim}`);
    lines.push(`- **Confidence:** ${f.confidence}  ·  **Verified by:** ${f.probeKind} probe`);
    lines.push(`- **Why:** ${f.explanation}`);
    lines.push("");
    lines.push("```");
    lines.push(f.evidence);
    lines.push("```");
    lines.push("");
  }
  lines.push("---");
  lines.push("### Run log");
  lines.push(log.map((l) => `- ${l}`).join("\n"));

  const file = path.join(REPORTS_DIR, `audit-${stamp}.md`);
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}
