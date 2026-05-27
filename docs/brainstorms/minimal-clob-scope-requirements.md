---
date: 2026-05-27
topic: minimal-clob-scope
---

# Minimal On-Chain CLOB Scope

## Summary

A minimal on-chain CLOB built inside the Anchor program, one book per strike, with three core instructions (place limit, place market, cancel) and bounded fixed-size order accounts. Co-designed with the mint/redeem flow so Buy No and Sell No are first-class single-tx instructions, not multi-step abstractions in the frontend.

---

## Problem Frame

Meridian needs a matching venue on Solana for binary-outcome contracts. The PRD presents two options: integrate an existing CLOB (Phoenix is the strongest candidate) or build a minimal book inside the smart contract. Phoenix is the lower-risk path — it's mature, crankless, and lets the team focus on settlement, oracle, and lifecycle work.

The audience for the demo is Peak6, a quantitative trading firm. Peak6 evaluators can immediately distinguish workmanlike CLOB plumbing from a hand-rolled matching engine that demonstrates market-microstructure understanding. Phoenix integration would not carry that differentiation, and the matching engine is the one piece of the system Peak6 is uniquely positioned to evaluate. The brainstorm flipped from a Phoenix lean to build-own once the audience-specific weight was explicit.

**Audience optimization note.** This is an explicitly submission-optimized choice rather than a user-optimized one. The CLOB decision optimizes for impressing a quantitative-trading evaluator (Peak6) by demonstrating market-microstructure skill. That audience has different preferences from the retail-trader persona named in STRATEGY.md ("crypto-native retail traders with capped, known-at-entry risk and no broker in the loop"). The simplicity-as-product positioning in STRATEGY.md and the matching-engine-as-product positioning here serve different audiences; this brainstorm prioritizes the submission audience over the eventual user. If the project continues past the submission window, this trade-off should be revisited.

The cost is real: roughly 1-2 weeks of dedicated matching-engine work, larger combined invariant-testing surface, and a credible risk that matching-engine bugs eat the time needed to finish settlement / oracle / UX. The scope below is sized to manage that risk by hard-capping CLOB ambition.

---

## Requirements

**Book structure**
- R1. The CLOB lives inside the same Anchor program as mint/redeem, not as a separate program.
- R2. One on-chain order book per strike. Each book is a fixed-size account with bounded depth per side (exact depth deferred to planning).
- R3. Price-time priority (FIFO at each price level) on both bid and ask sides.

**Order instructions**
- R4. `place_limit_order` — escrows tokens (USDC for bids, Yes for asks) into a book-owned PDA, matches against the opposing side up to available depth, posts any unfilled quantity to the book.
- R5. `place_market_order` — fills against the book up to a bounded match depth per transaction; unfilled quantity returns to the caller (no posting).
- R6. `cancel_order` — owner-only, enforced by a transaction signer constraint matched against an immutable owner field stored on the order account at creation. Returns any unfilled escrowed quantity to the verified owner.
- R7. Partial fills supported on both limit and market orders.

**Four trade paths**
- R8. All four trade paths (Buy Yes / Buy No / Sell Yes / Sell No) are single-signature atomic transactions from the user's perspective.
- R9. Buy No is a native instruction that atomically mints a Yes/No pair and sells the Yes leg into the book.
- R10. Sell No is a native instruction that atomically buys a Yes from the book and pairs it with the user's existing No token (the resulting Yes+No combo is redeemable for $1 USDC at or after settlement).
- R11. Position constraints (no Buy Yes while holding No for the same strike; no Buy No while holding Yes for the same strike) are enforced in the frontend, matching the PRD's explicit placement. The frontend must read fresh token balances at the moment of action to avoid stale-state false-positives. On-chain enforcement is deferred to a post-demo hardening pass.

**Escrow and invariants**
- R12. All escrowed tokens (USDC and Yes) for open orders live in PDA-owned accounts scoped to the book.
- R13. Order state for a single open order lives in a single account so that Solana's per-account write lock serializes cancel and fill atomically. The sum of escrowed balances reconciles to the total open-order notional at all times. No tokens leak through partial fills, cancels, or fill-then-cancel races.
- R14. The CLOB's escrow and matching mechanics must not violate any precondition on which the $1.00 payout invariant depends — Yes tokens move only via authorized fill, cancel, or settlement paths, and USDC escrow is released only via the same authorized paths. The end-to-end $1.00 invariant (Yes payout + No payout = $1.00 per pair at settlement) is the mint/redeem system's responsibility to assert; this requirement bounds the CLOB's contribution to that invariant.

**Settlement interaction**
- R15a. Once `settle_market` is called for a market, no new orders may be placed. The book account carries an explicit `settled` flag set atomically by `settle_market` before any cancel sweep begins; `place_limit_order` and `place_market_order` check this flag at instruction entry, relying on Solana's per-account write lock to serialize races against in-flight order submissions.
- R15b. After the settled flag is set, all open orders are canceled and escrowed tokens returned to their owners. This sweep may be iterative or cranked across multiple transactions to stay within CU limits, and the sweep procedure must be reentrant-safe.

---

## Acceptance Examples

- AE1. **Covers R15a, R15b.** Given the market for "META > $680" has open orders on both sides at 4:00 PM ET, when `settle_market` is called, the book's `settled` flag is set atomically and subsequent `place_limit_order` or `place_market_order` calls on that market fail. The cancel-sweep then runs, returning escrowed USDC and Yes tokens to their respective owners; the sweep may execute across multiple transactions if needed.
- AE2. **Covers R5, R7.** Given a market buy order for 100 Yes against a book with 60 Yes at $0.50 ask and 80 Yes at $0.52 ask, when the order is placed and the per-tx match cap is reached after 60 fills, the user receives 60 Yes tokens; the remaining 40 are returned to the caller as unfilled (market orders do not post).
- AE3. **Covers R8, R9.** Given a user with 100 USDC and no positions in "META > $680", when Buy No is called for 50 No tokens with the Yes ask book showing 50 Yes at $0.40, the program atomically (1) deposits $50 USDC to mint 50 Yes / 50 No, (2) sells the 50 Yes at $0.40 for $20 USDC. User ends with 50 No tokens and 70 USDC. Single signature.
- AE4. **Covers R6, R13.** Given a user places a limit order to sell 100 Yes at $0.60 and 30 Yes have filled, when the user calls `cancel_order` and signs the transaction with the order's recorded owner key, the remaining 70 Yes are returned to the user; book-PDA escrow balances reconcile to the new open-order total.

*(Note: an earlier acceptance example for on-chain position-constraint enforcement was removed when R11 was downgraded to a frontend responsibility. Frontend test coverage for position-constraint UX lives in the frontend brainstorm / plan, not here.)*

---

## Success Criteria

- The matching engine passes combined property/fuzz tests across place / cancel / partial-fill / settle scenarios without violating the escrow-reconciliation invariant (R13) or the CLOB-precondition invariant (R14).
- All four trade paths execute as single-signature atomic transactions on devnet; the frontend wires "Buy No" and "Sell No" buttons directly to the native instructions without composing multiple transactions.
- A Peak6 evaluator reading the matching engine code recognizes correct microstructure: FIFO price-time priority, deterministic match ordering, escrow accounting, settlement-cancels-all semantics.

*(Handoff-readiness note, tracked separately from product success: ce-plan can pick up the architecture without re-deciding the CLOB scope, the build-own vs Phoenix question, or the four-trade-path semantics. This is a process goal, not a testable product outcome.)*

---

## Scope Boundaries

- Phoenix, OpenBook v2, or any other off-the-shelf CLOB integration.
- AMM-style matching (LMSR, fixed-product, etc.). The PRD requires an on-chain order book.
- Off-chain matching with on-chain settlement (Polymarket-style).
- Advanced order types: IOC, FOK, post-only, stop, hidden, iceberg.
- Maker rebates, taker fees, or any fee structure beyond Solana base transaction costs.
- Dynamic resizing of order book accounts. Depth is fixed at market creation.
- Cross-strike book unification. Each strike has its own independent book.
- Self-trade prevention beyond a basic owner-equality check at match time.
- On-chain enforcement of position constraints (R11) — deferred to a post-demo hardening pass.
- Mainnet deployment. This exclusion is a downstream consequence of the build-own decision: hand-rolled matching code on mainnet without an audit is a negative signal, not an independent choice. If the build-own decision is revisited (see Outstanding Questions), the mainnet decision should be reconsidered alongside it.

---

## Key Decisions

- **Build own minimal CLOB instead of integrating Phoenix — explicit bet.** Premise: Peak6 evaluators will weight a hand-rolled matching engine above a Phoenix integration. No external evidence supports this premise (no Peak6 contact, no published rubric line item, no prior-submission feedback) — this is a named bet, not a derived requirement. Mitigations: (a) the day-5 decision gate below, which converts the bet into a reversible commitment; (b) "defensible trade-offs documented" is itself one of the PRD's success criteria, so a thoughtful write-up of the build-vs-integrate trade-off has rubric value independent of which path is built. Cost: ~1-2 weeks of dedicated matching-engine work and a larger combined invariant-testing surface.
- **CLOB lives inside the same Anchor program as mint/redeem.** Rationale: enables atomic Buy No / Sell No as native single-instruction primitives co-designed with the binary-token system. *(Counter-consideration tracked in Outstanding Questions: a CPI-based composition between separate programs could achieve transaction-level atomicity without unifying state ownership.)*
- **Fixed-size order accounts with bounded depth.** Rationale: Solana account size is set at creation; bounded depth keeps matching code simple, CU usage predictable, and rent costs flat across the ~40-50 daily markets. Trade-off: deep out-of-the-money strikes that attract heavy book stuffing could exhaust depth — acceptable for the demo.
- **Day-5 decision gate; fail to Phoenix.** Build-own is the primary path. By the end of day 5 of dedicated matching-engine work, `place_limit_order` + partial fills + `cancel_order` must be passing invariant tests (single-account escrow reconciliation per R13; FIFO determinism; partial-fill correctness). If they are not, swap to Phoenix integration for the matching layer and keep the rest of the architecture (Anchor program owns mint/redeem, settlement, oracle, Buy No / Sell No composed via CPI to Phoenix). This is a routine engineering checkpoint, not a catastrophic-only trigger.
- **Devnet only for the demo.** Rationale: see Scope Boundaries — mainnet is rejected as a downstream consequence of build-own.

---

## Dependencies / Assumptions

- Anchor is the smart-contract framework. CLOB and mint/redeem live in the same Anchor program.
- USDC is the quote asset. The Yes token for each strike is the base asset of that strike's book.
- The oracle integration (Pyth or equivalent) handles previous-close reads for strike calculation and settlement-price reads at 4:00 PM ET. Built in parallel; assumed present. Required oracle properties: maximum acceptable data age at settlement time (specific value deferred to planning, e.g., 5 minutes), minimum acceptable confidence interval (specific value deferred), and a defined fallback behavior on oracle unavailability (retry window, then admin-override settlement with enforced time delay per the PRD).
- Admin authority is a named account (multisig PDA recommended) with enumerated, scoped permissions. Privileged operations are limited to: `create_strike_market`, `settle_market_override`, `pause` / `unpause`. Permissions explicitly do NOT include direct withdrawal from escrow PDAs. The admin-override settle path enforces a time delay (e.g., 1 hour after market close per the PRD) before it can be called.
- The daily lifecycle automation service creates markets each morning by calling `create_strike_market`, which initializes both the binary-token mints and the CLOB account for that strike.
- Solana account size limits are sufficient for the chosen depth-per-side parameter (verified during planning).
- Solana fuzzing / property-testing tooling is mature enough to exercise the combined mint/redeem + CLOB system. If not, fallback is a custom Anchor test harness.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R2] [Technical] Exact bounded depth per side, derived from Solana account size limits, expected order density per strike, and CU budget per match.
- [Affects R5] [Technical] Max match depth per market order, derived from CU budget per transaction.
- [Affects R13, R14] [Needs research] Choice of property-testing / fuzz framework for the combined mint/redeem + CLOB invariants. Options include `cargo-fuzz`, `proptest`, or a custom Anchor harness.
- [Affects R6] [Technical] Cancel-during-match race semantics. R13's single-account requirement should resolve this via Solana's per-account write lock; verify during planning.
- [Affects R9, R10] [User decision] **Buy No limit-order path interacts with the canceled state: canceling a pending Yes-leg sell from a limit Buy No leaves the user holding Yes + No, which R11 forbids — but R11 is now frontend-only, so the contradiction is contained at the frontend. Decide in planning: (a) frontend handles this transient Yes+No state with a guided "redeem pair" UX, or (b) drop the limit Buy No path for the demo and ship market-order Buy No only.**
- [Affects Key Decisions, R1] [Needs research] **Phoenix-CPI alternative not yet steelmanned. Before locking in build-own, spike a Phoenix-CPI Buy No instruction (Anchor program calls Phoenix via CPI within a single user transaction) and compare head-to-head: does Solana transaction-level atomicity (mint-pair + Phoenix-CPI place_order in one tx, one signature) achieve the same UX guarantee as a native single-instruction Buy No? If yes, the architectural justification for build-own collapses to "matching engine as a wow signal," and the premise scrutiny in Resolve Before Planning above becomes load-bearing.**
- [Affects Key Decisions] [User decision] **Sequencing alternative: ship a Phoenix-integrated lifecycle as the floor (complete create-mint-trade-settle-redeem demo in days, not weeks), then attempt the hand-rolled CLOB as an upgrade behind the same trade interface. Converts the current "no fallback" stance into "always a fallback." Resolve before planning if the Phoenix-CPI spike confirms a clean integration path.**
- [Affects R10] [User decision] **Sell No locks user capital until settlement under R10 as written ("Yes+No redeemable at or after settlement"). Either (a) add a burn-pair primitive (the inverse of mint-pair: burn 1 Yes + 1 No, return $1 USDC) so Sell No returns USDC immediately and mirrors Sell Yes, or (b) document that Sell No is intentionally a settlement-deferred exit and update the frontend / portfolio P&L to surface the capital-lock UX. The PRD floats "the system handles the close automatically," which implies (a); the doc as currently written commits to (b).**
- [Affects R1] [User decision] **Concentrating the CLOB + mint/redeem in one Anchor program concentrates blast radius: a single bug can corrupt state for all ~40-50 daily markets at once because they share validation code paths. Reconsider whether the atomicity argument for unifying state is load-bearing — R8's single-signature requirement is achievable via Solana transaction-level composition with CPIs, not only via instruction-level unification. A separate-program design with a CPI boundary forces invariant bugs to surface earlier at the boundary.**
