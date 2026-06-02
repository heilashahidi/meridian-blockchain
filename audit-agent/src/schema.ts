import { z } from "zod";

/**
 * A probe is how a hypothesis gets VERIFIED against the real toolchain. The LLM
 * only chooses a kind + safe parameters — it never emits raw shell. tools.ts
 * maps each kind to a fixed, allow-listed command, so the agent can run the
 * toolchain without an arbitrary-exec hole.
 */
export const ProbeSchema = z.object({
  kind: z.enum(["grep", "cargo-check", "clippy", "cargo-audit", "trident"]),
  // grep: regex to search the program source for (e.g. presence/absence of a
  // `has_one = admin` constraint, a `checked_add`, a Signer<'info>, ...).
  pattern: z.string().optional(),
  // grep: optional file (relative to programs/meridian) to scope the search.
  file: z.string().optional(),
  // trident: fuzz iterations (kept small so a verification run is bounded).
  iterations: z.number().int().positive().max(2000).optional(),
  // What result would CONFIRM the vuln, in plain words — used by the judge.
  confirmIf: z.string(),
});
export type Probe = z.infer<typeof ProbeSchema>;

export const HypothesisSchema = z.object({
  vulnClass: z.string(), // e.g. "missing-signer", "integer-overflow"
  instruction: z.string(), // the instruction / file the hypothesis targets
  claim: z.string(), // the specific weakness being alleged
  rationale: z.string(), // why the agent suspects it
  probe: ProbeSchema,
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const HypothesesSchema = z.object({
  // default([]) so a "this file is clean" response ({} or omitted) parses
  // instead of throwing — a zero-hypothesis verdict is a valid outcome.
  hypotheses: z.array(HypothesisSchema).max(6).default([]),
});

export const JudgementSchema = z.object({
  confirmed: z.boolean(),
  // High only when the probe output is concrete evidence; the judge is told to
  // default to NOT confirmed when the evidence is ambiguous.
  confidence: z.enum(["low", "medium", "high"]),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  explanation: z.string(),
  evidence: z.string(), // the exact lines / output that justify the verdict
});
export type Judgement = z.infer<typeof JudgementSchema>;

export interface Finding extends Judgement {
  vulnClass: string;
  instruction: string;
  claim: string;
  probeKind: string;
}
