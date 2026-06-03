import fs from "node:fs";
import path from "node:path";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import { INSTRUCTIONS_DIR, MAX_TARGETS } from "./config.js";
import { LENS_BLOCK } from "./lenses.js";
import { callJson } from "./llm.js";
import { readSource, runProbe } from "./tools.js";
import {
  HypothesesSchema,
  JudgementSchema,
  type Finding,
  type Hypothesis,
} from "./schema.js";
import { writeReport } from "./report.js";

const HYP_SHAPE =
  `{"hypotheses": [{"vulnClass": "string", "instruction": "string", ` +
  `"claim": "string", "rationale": "string", "probe": {"kind": ` +
  `"grep"|"cargo-check"|"clippy"|"cargo-audit"|"trident", "pattern": ` +
  `"regex (grep only)", "file": "optional path", "iterations": 500, ` +
  `"confirmIf": "the exact observation that CONFIRMS the vuln"}}]}`;

const JUDGE_SHAPE =
  `{"confirmed": true|false, "confidence": "low"|"medium"|"high", ` +
  `"severity": "info"|"low"|"medium"|"high"|"critical", ` +
  `"explanation": "string", "evidence": "exact lines from the probe output"}`;

// ── State ────────────────────────────────────────────────────────────────────
const Audit = Annotation.Root({
  targets: Annotation<string[]>({ default: () => [], reducer: (_a, b) => b }),
  cursor: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  currentTarget: Annotation<string>({ default: () => "", reducer: (_a, b) => b }),
  currentHypotheses: Annotation<Hypothesis[]>({ default: () => [], reducer: (_a, b) => b }),
  findings: Annotation<Finding[]>({ default: () => [], reducer: (a, b) => a.concat(b) }),
  log: Annotation<string[]>({ default: () => [], reducer: (a, b) => a.concat(b) }),
});
type AuditState = typeof Audit.State;

const SYSTEM =
  "You are a Solana/Anchor security auditor. You hunt for REAL, exploitable " +
  "vulnerabilities in an Anchor program, not style issues. You are skeptical: a " +
  "hypothesis is only worth raising if you can name a concrete probe that would " +
  "verify it against the source or toolchain. Prefer precision over volume.";

// ── Nodes ────────────────────────────────────────────────────────────────────

/** Enumerate the program's instruction files as audit targets. */
function scope(): Partial<AuditState> {
  // Read AUDIT_ONLY live (not the cached const) so the eval harness can retarget
  // per-bug between in-process invokes.
  const only = process.env.AUDIT_ONLY ?? "";
  const files = fs
    .readdirSync(INSTRUCTIONS_DIR)
    .filter((f) => f.endsWith(".rs") && f !== "mod.rs")
    .filter((f) => (only ? f.includes(only) : true))
    .sort();
  const targets = MAX_TARGETS > 0 ? files.slice(0, MAX_TARGETS) : files;
  return { targets, cursor: 0, log: [`scoped ${targets.length} instruction file(s)`] };
}

/** Read the current instruction and ask the model for verifiable hypotheses. */
async function hypothesize(state: AuditState): Promise<Partial<AuditState>> {
  const file = state.targets[state.cursor];
  const rel = path.join("src", "instructions", file);
  const source = readSource(rel);

  const human =
    `Instruction file: ${file}\n\n` +
    `Audit it through these vulnerability lenses:\n${LENS_BLOCK}\n\n` +
    `Source:\n\`\`\`rust\n${source}\n\`\`\`\n\n` +
    `Generate 3-6 candidate hypotheses — LEADS TO VERIFY, not accusations. Be ` +
    `generous: it is the verification step's job to filter false leads, so ` +
    `propose anything worth checking across the applicable lenses. For each give ` +
    `the vuln class, a specific claim, your rationale, and a PROBE to verify it:\n` +
    `- grep: a regex over the source (\`pattern\`, optional \`file\`) — e.g. check ` +
    `whether a \`has_one = admin\`, a signer, a \`checked_add\`, or a PDA \`seeds\` ` +
    `constraint is present or absent.\n` +
    `- cargo-check / clippy / cargo-audit: compile, lint, dependency CVEs.\n` +
    `- trident: the existing invariant fuzzer (deep, slow).\n` +
    `\`confirmIf\` must state the exact observation that CONFIRMS the vuln.`;

  // A model/parse failure on one file must not abort the whole audit.
  let hyps: Hypothesis[] = [];
  try {
    hyps = (await callJson(SYSTEM, human, HypothesesSchema, HYP_SHAPE)).hypotheses;
  } catch (e) {
    return { currentTarget: file, currentHypotheses: [], log: [`${file}: hypothesize error — skipped (${(e as Error).message.slice(0, 80)})`] };
  }
  return {
    currentTarget: file,
    currentHypotheses: hyps,
    log: [`${file}: ${hyps.length} hypothesis(es)`],
  };
}

/** Run each hypothesis's probe against the toolchain, then judge the result. */
async function verify(state: AuditState): Promise<Partial<AuditState>> {
  const confirmed: Finding[] = [];

  for (const h of state.currentHypotheses) {
    const res = runProbe(h.probe);
    const human =
      `Hypothesis (${h.vulnClass} in ${h.instruction}): ${h.claim}\n` +
      `Rationale: ${h.rationale}\n` +
      `Probe: ${h.probe.kind} — confirm if: ${h.probe.confirmIf}\n\n` +
      `Probe command: ${res.command}\n` +
      `Ran: ${res.ran}  exit=${res.exitCode}\n` +
      `Output:\n${res.output}\n\n` +
      `Did the probe CONFIRM the vulnerability? Be strict: confirm only if the ` +
      `output is concrete evidence of the claim. If the probe didn't run, was ` +
      `inconclusive, or actually shows the protection IS present, set ` +
      `confirmed=false. Quote the exact evidence lines.`;

    let j;
    try {
      j = await callJson(SYSTEM, human, JudgementSchema, JUDGE_SHAPE);
    } catch {
      continue; // a single un-judgeable hypothesis shouldn't sink the file
    }
    if (j.confirmed) {
      confirmed.push({
        ...j,
        vulnClass: h.vulnClass,
        instruction: h.instruction,
        claim: h.claim,
        probeKind: h.probe.kind,
      });
    }
  }

  const next = state.cursor + 1;
  return {
    findings: confirmed,
    cursor: next,
    log: [`${state.currentTarget}: ${confirmed.length} confirmed`],
  };
}

function routeAfterVerify(state: AuditState): "hypothesize" | "report" {
  return state.cursor < state.targets.length ? "hypothesize" : "report";
}

function report(state: AuditState): Partial<AuditState> {
  const file = writeReport(state.findings, state.log);
  return { log: [`report written: ${file}`] };
}

// ── Graph ────────────────────────────────────────────────────────────────────
export function buildAuditor() {
  return new StateGraph(Audit)
    .addNode("scope", scope)
    .addNode("hypothesize", hypothesize)
    .addNode("verify", verify)
    .addNode("report", report)
    .addEdge(START, "scope")
    .addEdge("scope", "hypothesize")
    .addEdge("hypothesize", "verify")
    .addConditionalEdges("verify", routeAfterVerify, {
      hypothesize: "hypothesize",
      report: "report",
    })
    .addEdge("report", END)
    .compile();
}
