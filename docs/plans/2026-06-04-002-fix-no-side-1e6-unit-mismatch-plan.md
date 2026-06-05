---
date: 2026-06-04
type: fix
status: in-progress
depth: deep
title: "fix: No-side 1e6 unit mismatch (buy_no/sell_no revert; Yes redemption skewed)"
---

# fix: No-side 1e6 unit mismatch

`Buy No` / `Sell No` show negative proceeds and revert on-chain with
`InvalidAmount`. Root cause is a 1,000,000× unit disagreement between the
order-book leg and the mint/burn-pair leg. This is a program-level fix requiring
a devnet redeploy + re-seed. **Interim mitigation already shipped:** the No-side
trade buttons are disabled in the UI (`TradePanel.tsx` `NO_SIDE_DISABLED`).

## STATUS (2026-06-05): code implemented — chose Approach 2

On closer analysis, **Approach 2 is the optimal minimal fix** (superseding the
earlier Approach-1 lean below), for three reasons that align with the PRD:

1. The order book prices a token in **integer** µUSDC `[0, ONE_USDC]` = $0–$1.
   Integer prices only make sense if **1 token = $1** — so the order book is
   already correct, and the bug is purely in mint/burn/redeem.
2. The PRD says it outright: *"Yes token pays $1.00"* and *"Vault balance =
   $1.00 × pairs minted."* The current code collateralized **1 µUSDC per token**,
   which **violates that vault invariant**. Approach 2 restores it.
3. It's the least code (3 one-line multiplications) and touches neither the order
   book nor the frontend qty.

**Implemented** on branch `fix/no-side-1e6-collateral`:
- `lib.rs`: `pub const ONE_USDC: u64 = 1_000_000;`
- `mint_pair_inner`, `burn_pair_inner`, `redeem_handler`: USDC transfer becomes
  `amount.checked_mul(ONE_USDC)`.
- New invariant: `usdc_escrow == supply * ONE_USDC` (= $1 × pairs). Order book
  and `settle_sweep` unchanged (already in the `qty × price` µUSDC unit).
- Host-compiles clean (`cargo check -p meridian --lib`).

**Remaining to ship (NOT done — deliberate, not rushed on the live demo):**
1. **SBF build** — blocked locally by a `getrandom`/platform-tools toolchain
   issue (see `KNOWN-ISSUES.md`); build on the env that produced the deployed
   `.so`, or pin the toolchain.
2. **Rewrite the LiteSVM test assertions** that encode the *old* economics —
   `u4_mint_burn`, `u6_buy_no_sell_no` (its `sell_no_happy` currently asserts the
   seller *loses* money), `u7_settle_redeem`, `u8_lifecycle`. Any USDC delta from
   mint/burn/redeem scales ×1e6; order-book-only tests (`u5`) are unchanged.
   Run them green = fix proven.
3. **Program upgrade** to devnet.
4. **Re-create + re-seed all markets** — existing markets were collateralized
   under the old math and are insolvent under the new; abandon + recreate.
5. **Flip `NO_SIDE_DISABLED = false`** in `TradePanel.tsx` and redeploy the app.

> Cosmetic follow-up (not required for correctness): the Yes/No mints declare 6
> decimals but the system treats 1 base unit = 1 share. Re-minting at 0 decimals
> would make wallets/explorers show whole-share balances. Out of scope here.

## Problem Frame

The program carries two incompatible unit conventions:

- **Order book** (`place_limit_order.rs:300-305`, `:475`): a bid locks /
  notional = `qty × price`, with `price ∈ 0..1_000_000` representing `$0..$1`. So
  buying `qty` token base units of Yes costs up to `qty × $1` — i.e. **1 base
  unit of Yes is treated as worth up to $1**.
- **mint/burn/redeem** (`mint_pair.rs:9`, `redeem.rs:15`): the invariant
  `usdc_escrow == yes_supply == no_supply` means **1 token base unit = 1 µUSDC**.
  `mint_pair(amount)` deposits `amount` µUSDC; `redeem(amount)` returns `amount`
  µUSDC.

These disagree by 1e6. `buy_no` / `sell_no` straddle both legs, so the mismatch
becomes a visible, reverting failure:

- **`sell_no(amount)`** (`sell_no.rs:204-247`): market-buys `amount` Yes for
  `amount × fill_price` µUSDC (order-book leg, ~$0.72 for 1 unit), then
  `burn_pair(amount)` returns only `amount` µUSDC ($0.000001 for 1 unit). Net is
  hugely negative for any amount → the UI shows `Receive -$0.27` and the program
  bails with `InvalidAmount`.
- **`buy_no`** is the mirror.

**Also affected (silently):** `Buy Yes` / `Sell Yes` execute (no straddle), but a
Yes bought for $0.72 via the order book redeems for `amount` µUSDC at settle
(`redeem`) — `$0.000001` for 1 base unit. The buyer is paid 1e6× too little even
when they win. The bug only stays hidden because nobody redeems mid-demo.

The security audit's fund-safety finders rated this area clean because escrow
**conservation** holds (every outflow is matched) — but the two legs' unit
**semantics** disagree, which conservation analysis doesn't catch.

## Interim Mitigation (shipped)

`app/src/components/TradePanel.tsx` — `NO_SIDE_DISABLED = true` greys out
`Buy No` / `Sell No` (segmented buttons disabled + submit guarded). `Buy Yes` /
`Sell Yes` are unaffected. Flip the flag to `false` once the program fix is
deployed. No on-chain change; ships with a normal app redeploy.

## The Real Fix — two approaches

Both are program changes that require `cargo build-sbf` + a devnet program
**redeploy** (human-gated, IDL-drift-prone per the deployed-program history) and
a **re-seed**. The redeploy **invalidates every existing market/position**
(old escrow was created under the old math), so plan a clean wipe + re-seed.

### Approach 1 — fix the order book (RECOMMENDED)

Make the order-book notional agree with mint/burn/redeem by treating `price` as
per-whole-token:

- `place_limit_order.rs`: lock, per-fill notional, and price-improvement refund
  become `qty × price / ONE_USDC` (round **in the protocol's favor**).
- Add a **min-notional guard**: reject fills where `qty × price < ONE_USDC`
  (i.e. sub-cent dust) so integer truncation can't mint free tokens.
- Frontend trades in **whole-token amounts**: `qty = shares × 1_000_000` in
  `actions.ts` / `TradePanel.tsx`; order-book + position-pill displays divide by
  `1e6`.
- **Revert the portfolio display fix** (`fix/share-quantity-unit-scaling`): the
  canonical unit becomes 1 share = 1e6 base units, so `contractsFromBaseUnits`
  (÷1e6) is correct again.

Pros: keeps the audited solvency invariant `usdc_escrow == supply` intact; the
change lives at the actual bug site. Cons: touches multiple notional sites +
needs the truncation guard + frontend qty rescale.

### Approach 2 — scale mint/burn/redeem ×1e6

Make 1 base unit = 1 share = up to $1 by scaling the USDC legs:

- `mint_pair_inner` / `burn_pair_inner` / `redeem_handler`: USDC transfer
  amounts become `amount × ONE_USDC`.
- Re-derive the solvency invariant everywhere it's used (`usdc_escrow ==
  supply × 1e6`): `settle_market`, `redeem`, `settle_sweep` accounting.
- Order book and frontend unchanged; the portfolio display fix stays correct.

Pros: no frontend qty change; keeps `fix/share-quantity-unit-scaling`. Cons:
**rewrites the load-bearing solvency invariant** the audit verified — higher
risk, more to re-prove.

**Recommendation: Approach 1** — preserve the invariant the fund-safety audit
relied on; localize the change to the order-book notional that's actually wrong.

## Required Steps (whichever approach)

1. Implement the program change.
2. Tests: LiteSVM end-to-end for buy_no/sell_no net proceeds = `amount × noPrice`
   (and the Yes redeem round-trip); unit tests for the notional math; re-run the
   Trident fuzz gate on the $1 invariant.
3. `cargo build-sbf`, deploy to devnet (human-gated).
4. Re-seed markets (`SEED_LIQUIDITY=true` / `seed-liquidity`) under the new math;
   confirm `mint_pair` collateral costs are the intended dollars (Approach 2
   makes mint cost 1e6× more µUSDC).
5. Frontend: flip `NO_SIDE_DISABLED = false`; apply Approach-1 qty scaling /
   display changes (or confirm Approach-2 leaves frontend as-is).
6. Reconcile `fix/share-quantity-unit-scaling` per the chosen approach.

## Risks

- **Insolvency if wrong.** This is escrow math; verify the $1 invariant with the
  Trident gate before deploying.
- **Redeploy wipes positions.** Existing markets/positions are invalid after the
  upgrade; coordinate a clean wipe + re-seed.
- **IDL drift.** Deploy from a reconciled `main`; regenerate the app IDL.
- **Do not do this hours before a demo.** The interim kill-switch is the
  demo-safe path; land the real fix on a calm day with the full test gate.
