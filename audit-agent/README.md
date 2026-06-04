# Meridian audit-agent

A **closed-loop LangGraph.js security auditor** for the Meridian Anchor program.
It hypothesizes vulnerabilities, **verifies each one by running the real
toolchain** (grep / cargo / clippy / trident), and reports only confirmed
findings. A seeded-bug eval measures how well it actually catches things.

This is the "ties them together" tool: an agent that audits the smart contracts,
plus an eval that scores the agent.

## Why LangGraph here (and not for the app chat)

The market-chat is a single grounded LLM call — an agent framework would be
overkill. *This* is a genuine multi-step loop with tool use and a verification
gate, which is exactly what LangGraph is for.

## The loop

```
        ┌─ scope ──────────────────────────────────────────────┐
        │  enumerate programs/meridian/src/instructions/*.rs     │
        └───────────────┬───────────────────────────────────────┘
                        ▼
        ┌─ hypothesize (LLM, structured) ───────────────────────┐
        │  read the instruction, propose verifiable hypotheses   │
        │  through 8 Solana/Anchor vuln lenses; each carries a    │
        │  PROBE (grep | cargo-check | clippy | cargo-audit |     │
        │  trident) and a `confirmIf` condition                   │
        └───────────────┬───────────────────────────────────────┘
                        ▼
        ┌─ verify (run toolchain → LLM judge) ──────────────────┐
        │  run each probe for real, then judge STRICTLY: confirm  │
        │  only on concrete evidence; default to not-a-finding    │
        └───────────────┬───────────────────────────────────────┘
                        ▼               ▲ next file
                   more files? ─────────┘
                        ▼ no
                     report  →  reports/audit-latest.md
```

The model only ever picks a **probe kind + safe parameters** — it never emits raw
shell. `src/tools.ts` is the only place commands are built, so there's no
arbitrary-exec surface. Commands are time-bounded and run from the repo root.

## Setup

```bash
cd audit-agent
npm install
cp .env.example .env   # set ANTHROPIC_API_KEY (reuse app/.env.local's key)
```

## Use

```bash
npm run dry                       # no-LLM smoke test: proves the toolchain wiring
npm run audit                     # full audit → reports/audit-latest.md
AUDIT_ONLY=settle npm run audit   # scope to one instruction (cheap)
AUDIT_ENABLE_TRIDENT=1 npm run audit   # allow the slow deep-verify fuzz probe
```

Config (all env, see `.env.example`): `AUDIT_MODEL` (default `claude-sonnet-4-6`,
try `claude-opus-4-8` for depth), `AUDIT_MAX_TARGETS`, `AUDIT_ONLY`,
`AUDIT_ENABLE_TRIDENT`.

## Eval — does it actually catch bugs?

```bash
npm run eval -- --selftest   # no LLM: proves it mutates + restores source safely
npm run eval                 # seed each bug, audit, score recall + false positives
```

The harness seeds known vulnerabilities into the **real** source, runs the
auditor scoped to the affected file, and scores **recall** (did it catch the
seeded bug?) and **precision** (false positives on clean code). It refuses to run
on a non-git-clean file and **always** restores byte-for-byte in a `finally`.

Seeded bugs (`eval/run-eval.ts`):
| id | file | class | what's removed |
|----|------|-------|----------------|
| `missing-admin-check` | `create_strike_market.rs` | missing-signer | `has_one = admin` → anyone can create markets |
| `grace-bypass` | `admin.rs` | oracle-settlement | the 24h emergency-settle grace gate → admin settles early |

Add a bug: append to `BUGS` with a whitespace-robust `mutate` (see the
`removeLineContaining` / `removeRequireBlock` helpers).

## Verification depth (closed-loop)

Today's probes verify against the toolchain via **static structure** (grep for a
present/absent constraint), **compile/lint** (cargo-check, clippy), **dep CVEs**
(cargo-audit), and the existing **invariant fuzzer** (trident, behind a flag).
The natural next layer is a `gen-test` probe that writes a bespoke anchor/Trident
exploit per hypothesis and runs it — the schema and node structure already
support adding a probe kind.

## Honest limitations

- An AI auditor **complements** fuzzing + a human/professional audit; it does not
  replace them. For real funds, still get a professional audit.
- Findings are only as good as the probe. A `grep` confirm is structural
  evidence, not a runtime exploit — weight `confidence`/`severity` accordingly.
- `cargo`/`trident` probes are slow; scope with `AUDIT_ONLY` during iteration.

## Layout

```
src/config.ts    paths, model, budgets, timeouts
src/schema.ts    zod: Probe, Hypothesis, Judgement, Finding
src/tools.ts     readSource + runProbe (safe allow-list, no raw shell)
src/lenses.ts    8 Solana/Anchor vuln lenses
src/graph.ts     the LangGraph StateGraph (scope→hypothesize→verify→report)
src/report.ts    markdown report writer
src/run.ts       CLI (audit / --dry)
eval/run-eval.ts seeded-bug benchmark (recall/precision) + --selftest
```
