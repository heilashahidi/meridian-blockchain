# AI Usage Documentation

The PRD requires disclosure of how AI tools were used. This project was built
with heavy AI assistance, under human direction and verification. This document
describes what the AI did, what the human owned, and how the output was checked.

## Tools

- **Claude Code** (Anthropic Claude) — the primary tool: an agentic coding
  assistant used in the terminal for design discussion, implementation, test
  authoring, debugging, refactoring, documentation, and deployment config.
- Standard non-AI tooling did the actual verification: `anchor`/`cargo` test,
  LiteSVM, Trident (fuzzing), `vitest`, `tsc`, `next build`, and a real Solana
  devnet deployment.

## What AI was used for

- **On-chain program (`programs/meridian/`)** — drafting the Anchor
  instructions (mint-pair, the CLOB matching engine, settle, redeem, admin
  controls), the $1 invariant accounting, and the Pyth staleness/confidence
  checks. The fixed-bucket order book and price-scaling math were
  AI-implemented, then pinned down with unit + LiteSVM + fuzz tests.
- **Automation service (`automation/`)** — the create-strikes / settle jobs,
  the DST-correct US-trading-day calendar, retry/backoff, and the scheduler.
- **Frontend (`app/`)** — the Next.js app shell, the order-book and trade
  panels, position-constraint guards, the dashboard market browser, and the
  Pyth Hermes price layer.
- **Tests** — the LiteSVM suites (u3–u8), matching-engine unit tests, the
  Trident invariant fuzz harness, and the frontend `vitest` suites.
- **Docs & ops** — `ARCHITECTURE.md`, the devnet runbook, this repo's README,
  the Dockerfiles, and the Railway deploy config.

## What the human owned

- **Direction and scope** — which features to build, what to cut as redundant,
  product/UX decisions (e.g. consolidating Landing + Markets into the
  Dashboard), and when something was "good enough" vs needed more rigor.
- **Decisions surfaced by the AI** — architecture trade-offs, dependency
  choices, and ambiguous calls were raised to the human and decided by the
  human, not assumed.
- **Acceptance** — nothing was considered done on the AI's say-so; correctness
  was judged against passing tests, a working devnet lifecycle, and review.

## How the output was verified (not vibes)

- **Invariants under fuzzing** — Trident drives multi-instruction sequences and
  asserts escrow reconciliation, Yes/No supply parity, and token conservation.
- **Deterministic tests** — LiteSVM exercises the full instruction set against
  an in-process SVM, including settle/redeem with a forged `PriceUpdateV2`
  (stale-price, wide-confidence, at-strike/above/below, dual-user lifecycle).
  App: 140 tests; automation: 73.
- **Real devnet** — the program is deployed to Solana devnet and the
  create → mint → trade → settle → redeem lifecycle was run end-to-end there.

## Known caveat

AI-generated code can be confidently wrong, so the bias throughout was: small
verifiable steps, tests before trusting a change, and reading the actual
on-chain/test output rather than the assistant's summary of it. The test suites
and the devnet demo — not the AI — are the source of truth for correctness.
