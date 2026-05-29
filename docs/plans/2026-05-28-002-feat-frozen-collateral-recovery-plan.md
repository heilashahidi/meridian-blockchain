---
title: "feat: Admin-gated recovery of permanently-stuck collateral after settlement"
type: feat
status: completed
created: 2026-05-28
depth: deep
related:
  - docs/plans/2026-05-28-001-fix-clob-matching-engine-hardening-plan.md
  - PR #3 (matching-engine hardening) — Known Residuals: permanently-frozen maker
---

# feat: Admin-gated recovery of permanently-stuck collateral

Resolve the open P2 residual from PR #3: a settled market with a permanently
un-refundable order (owner's canonical ATA closed/frozen forever) never fully
drains and its escrowed collateral is locked with no recovery path.

**Target repo:** meridian-blockchain (this repo). Program source under
`programs/meridian/src`. No markets are deployed yet (devnet faucet-blocked), so
on-chain account-layout changes are safe in this pass.

---

## Problem Frame

After PR #3, `settle_sweep` re-inserts un-refundable orders at a fresh seq so the
drain makes forward progress on payable orders. But an order whose owner's
canonical ATA is **permanently** un-receivable — indefinite Circle USDC freeze,
abandoned wallet, or a closed ATA never re-opened — is never paid: it cycles to
the back on every sweep call forever. Consequences:

- The market's book never reaches `bids.is_empty() && asks.is_empty()`, so the
  sweep never reports convergence.
- The stuck order's escrowed collateral (USDC for a resting bid, Yes tokens for a
  resting ask) stays locked in `usdc_escrow` / `yes_escrow` with no exit.
- Escrow can never be reconciled to zero at market end-of-life.

**Chosen policy (confirmed):** an **admin-gated, timeout-gated** instruction that
force-expires a *specific genuinely-stuck order* and moves its collateral to a
program treasury account, held in custody (claimable later via an off-chain
process). A settled market can then always be driven to a fully-drained,
reconciled end-state.

### The linchpin safety property

The admin power must be **narrowly scoped to genuinely-unpayable orders** — an
admin must not be able to confiscate a healthy order. The instruction proves
stuck-ness on-chain: it derives the owner's canonical ATA from the order entry's
`owner` field (not admin-supplied) and requires that account to be the canonical
ATA **and** currently un-receivable. A healthy order (receivable canonical ATA)
is rejected. Combined with a long post-settlement timeout (gives the owner ample
time to un-freeze / re-open before the protocol sweeps), this keeps the escape
hatch from becoming a rug vector.

---

## Goal & Non-Goals

**Goal:** A reviewed implementation that lets an admin recover a specific
permanently-stuck order's collateral to a treasury after a settlement timeout,
provably only when the order is genuinely unpayable, preserving R13/R14, with new
invariant tests proving a stuck market can reach full drain.

**Non-goals (this pass):**
- The off-chain claim/custody process for treasury-held funds (manual/operational).
- Touching the live trading path or the existing sweep skip/fresh-seq/convergence
  logic beyond reading the same canonical-ATA helpers.
- Auto-detecting stuck orders (admin targets a specific order by id).
- Converting recovered Yes tokens to USDC (raw asset is moved as-is; redemption is
  a separate concern).

---

## Key Technical Decisions

1. **Timeout source: add `settled_at: i64` to `Market`.** Set it to
   `clock.unix_timestamp` in both `settle_market` and `admin_settle_market`. The
   recovery gate is `now >= settled_at + RECOVERY_GRACE_SECONDS`. `Market` uses
   Anchor `#[derive(InitSpace)]` (`space = 8 + Market::INIT_SPACE` in
   `create_strike_market.rs:51`), so adding a field needs no manual size math, and
   no markets are deployed, so the layout change is safe.
   - *Alternative considered:* reuse `expiry_unix + GRACE` as a proxy (no layout
     change) — rejected because it measures time-since-expiry, not time-since-settle;
     a delayed settlement would open the recovery window too early. `settled_at` is
     precise and gives a useful settlement-time audit trail.

2. **Recovery grace: a const `RECOVERY_GRACE_SECONDS`, sized generously (30 days).**
   Mirrors the existing `EMERGENCY_GRACE_SECONDS` const pattern
   (`admin.rs:22`). Far longer than the 1-day emergency-settle grace because this
   sweeps *user* funds — the owner must have a long window to fix their ATA first.
   - *Alternative:* a `Config` field for runtime tuning — deferred; a const matches
     the existing emergency-grace pattern and avoids a Config setter.

3. **Treasury destination: add `treasury: Pubkey` to `Config`.** Recovered
   collateral goes to the treasury's canonical ATAs (USDC ATA for bid collateral,
   per-market Yes ATA for ask collateral). A *dedicated* treasury (vs. reusing
   `fee_authority`) keeps custodial user funds accounting-separate from protocol
   revenue — these funds may be claimed back by the owner later. `Config` also uses
   a singleton PDA and is not deployed, so the field addition is safe; set at
   `initialize_config`, with an admin setter for rotation.

4. **Targeting: by `OrderId` (price, seq, side), mirroring `cancel_order`.** The
   admin supplies the specific stuck order's id; the handler scans the side via
   `as_slice()`, verifies, removes via `cancel_by_id`, and refunds to treasury —
   the exact `cancel_order` shape, but admin-gated and treasury-destined.

5. **Stuck-ness proof (the safety linchpin).** Derive
   `get_associated_token_address(entry.owner, payout_mint)` on-chain and require
   the supplied owner-ATA "proof" account to equal it **and** be un-receivable
   (reuse `token_util::is_canonical_ata` + `!token_account_receivable`). A
   receivable canonical ATA → reject (`OrderNotStuck`); the order should drain
   through the normal sweep, not the admin path.

6. **Invariant accounting.** Force-expire removes the order from the book (total
   open notional drops by its notional) and transfers the same amount out of escrow
   to treasury → R13 (`escrow == Σ open-order notional`) stays balanced. Moving Yes
   tokens is a transfer, not mint/burn → Yes/No supply parity (R14) is untouched.
   After recovery the funds are in treasury custody, no longer escrow-owed.

---

## High-Level Technical Design

*Directional guidance for review, not implementation specification.*

```
admin_force_expire_order(price, seq, side_byte):
    require market.settled
    require !config.paused
    require now >= market.settled_at + RECOVERY_GRACE_SECONDS      # timeout
    # admin authenticated via has_one = admin on Config

    entry = book[side].find_by_id(OrderId(price, seq))             # scan as_slice, like cancel_order
    require entry exists                                           # OrderNotFound

    payout_mint = USDC if side==Bid else market.yes_mint
    # Stuck-ness proof: owner from the ENTRY, not the admin.
    require is_canonical_ata(owner_ata_proof, entry.owner, payout_mint)
    require !token_account_receivable(owner_ata_proof)            # else OrderNotStuck

    treasury_ata must be config.treasury's canonical ATA for payout_mint
    book[side].cancel_by_id(id)                                    # remove from book
    amount = entry.qty * price (Bid)  | entry.qty (Ask)
    escrow[payout_mint] --PDA-signed--> treasury_ata               # custody
    emit StuckOrderRecovered{ market, owner, side, price, qty, amount }
```

A market reaches full drain when every remaining stuck order has been
force-expired (book empties) and escrow reconciles to zero.

---

## Implementation Units

### U1. Add `settled_at` to `Market`, stamped at settlement

**Goal:** Record settlement time so the recovery timeout is precise.

**Requirements:** Foundational for the recovery timeout (Decision 1).

**Dependencies:** none.

**Files:**
- `programs/meridian/src/state/market.rs` — add `pub settled_at: i64` (0 = unsettled
  sentinel); update the field doc.
- `programs/meridian/src/instructions/settle_market.rs` — set
  `market.settled_at = Clock::get()?.unix_timestamp` when stamping the outcome.
- `programs/meridian/src/instructions/admin.rs` — same in `admin_settle_market_handler`.
- `tests/litesvm/tests/u7_settle_redeem.rs` — assert `settled_at` is set.

**Approach:** `Market` derives `InitSpace`, so the field addition auto-resizes the
account; confirm `create_strike_market.rs:51` still uses `8 + Market::INIT_SPACE`
(no manual constant to bump). Set in both settle paths so emergency-settled markets
also get a timestamp.

**Patterns to follow:** existing `market.settled = true` + `market.outcome` writes
in `settle_market.rs` / `admin.rs`.

**Test scenarios:**
- Normal `settle_market` sets `settled_at` to the clock time; `outcome`/`settled`
  unchanged in behavior.
- `admin_settle_market` (emergency path) also sets `settled_at`.
- A freshly-created (unsettled) market has `settled_at == 0`.

**Verification:** `cargo build-sbf` clean; `cargo test -p meridian-litesvm-tests`
green; `settled_at` populated after both settle paths.

---

### U2. Add `Config.treasury`, recovery const, and error variants

**Goal:** Establish the treasury destination, the timeout constant, and the typed
errors the recovery instruction needs.

**Requirements:** Decisions 2, 3; supports the safety property (Decision 5).

**Dependencies:** none (parallel with U1).

**Files:**
- `programs/meridian/src/state/config.rs` — add `pub treasury: Pubkey`.
- `programs/meridian/src/instructions/initialize_config.rs` — accept + store
  `treasury` (extend the init args; treasury can default to the admin or
  fee_authority pubkey if the caller passes it so).
- `programs/meridian/src/instructions/admin.rs` — add `set_treasury` admin setter
  (mirror `set_paused` / `set_require_full_verification`); add
  `pub const RECOVERY_GRACE_SECONDS: i64 = 30 * 86_400;`.
- `programs/meridian/src/error.rs` — append `RecoveryGraceNotElapsed`,
  `OrderNotStuck`, and (if needed) `InvalidTreasuryAccount` at the END of the enum
  (preserve existing discriminants).
- `tests/litesvm/tests/u7_settle_redeem.rs` or a helper — extend `Env`/`Fixture`
  init to pass + expose `treasury`.

**Approach:** Mirror the existing admin-setter pattern (`has_one = admin` on
`Config`). Append error variants so existing error codes don't shift (the api-contract
reviewer flagged this convention in PR #3). Bump program version (next minor) since
this adds instructions + error codes + account fields.

**Test scenarios:**
- `initialize_config` stores the treasury pubkey; readable on `Config`.
- `set_treasury` by admin rotates it; by non-admin → `Unauthorized` (mirror existing
  admin-setter auth tests).
- Error variants compile and appear in the IDL at the end (discriminants stable).

**Verification:** build clean; admin-setter auth test passes; IDL shows new errors
appended.

---

### U3. `admin_force_expire_order` instruction

**Goal:** The admin-gated, timeout-gated, stuck-ness-proven recovery instruction
that moves a specific stuck order's collateral to the treasury.

**Requirements:** Closes the PR #3 residual; preserves R13, R14, R15b.

**Dependencies:** U1 (`settled_at`), U2 (`treasury`, const, errors).

**Files:**
- `programs/meridian/src/instructions/admin_force_expire_order.rs` (new) — the
  `Accounts` struct + handler.
- `programs/meridian/src/instructions/mod.rs` — `pub mod` the new file.
- `programs/meridian/src/lib.rs` — thin `#[program]` wrapper + re-export.
- `tests/litesvm/tests/u7_settle_redeem.rs` — behavioral tests (U4).

**Approach:** Structurally a `cancel_order` clone with four changes: (1) `has_one =
admin` on `Config` instead of an owner-signer check; (2) gated on `market.settled`
+ `now >= settled_at + RECOVERY_GRACE_SECONDS`; (3) the stuck-ness proof — derive
the canonical ATA from `entry.owner` (read from the book, never admin-supplied) and
require it equals the supplied proof account and is `!token_account_receivable`,
else `OrderNotStuck`; (4) refund destination is the treasury's canonical ATA
(validated against `config.treasury` + payout mint), not the owner. Reuse the
`OrderId` lookup, the per-side refund-amount math, and the PDA-signed escrow
transfer from `cancel_order`. Reuse `crate::token_util::{is_canonical_ata,
token_account_receivable}`. Emit a `StuckOrderRecovered` event for the off-chain
custody ledger.

**Technical design:** see High-Level Technical Design above (directional).

**Patterns to follow:** `cancel_order.rs` (id lookup, owner-check-before-mutate
ordering, PDA-signed refund); `admin.rs` `admin_settle_market_handler` (admin gating
+ grace-window check); `settle_sweep.rs` (canonical-ATA recipient validation,
PDA-signed transfer).

**Test scenarios** (LiteSVM in U4; this unit is feature-bearing, tests land in U4
because they need the settle/sweep `Env`):
- Test expectation: behavioral coverage in U4.

**Verification:** `anchor build` clean; new instruction in the IDL; U4 tests pass.

---

### U4. LiteSVM: recovery behavioral + invariant tests

**Goal:** Prove the recovery path end-to-end, including the safety guards and full
market drain.

**Requirements:** Verifies U3; R13/R14 reconciliation; AE-style end-of-life drain.

**Dependencies:** U1, U2, U3.

**Files:**
- `tests/litesvm/src/lib.rs` — helpers: advance clock past `settled_at + grace`,
  build the force-expire ix + treasury ATA, expose `treasury` balances.
- `tests/litesvm/tests/u7_settle_redeem.rs` — the tests (settle/sweep `Env` lives
  here).

**Approach:** Use `freeze_token_account` / `close_token_account` (from PR #3) to
make an order's canonical ATA genuinely un-receivable; advance the clock with the
existing time-advance helper; reuse `expire_blockhash` between repeated txs.

**Test scenarios:**
- **Happy bid:** settle a market with a resting bid whose owner froze their canonical
  USDC ATA; advance past grace; admin force-expires it → treasury USDC ATA gains
  `qty*price`, `usdc_escrow` drops by the same, order gone, R13 reconciles.
- **Happy ask:** symmetric with a resting ask + frozen canonical Yes ATA → treasury
  Yes ATA gains `qty`, `yes_escrow` drops; Yes/No supply parity (R14) unchanged.
- **Timeout not elapsed:** before `settled_at + grace` → `RecoveryGraceNotElapsed`,
  book + escrow unchanged.
- **Order not stuck:** order with a *receivable* canonical ATA → `OrderNotStuck`
  (admin cannot confiscate a healthy order), book unchanged.
- **Non-admin caller:** → `Unauthorized`, book unchanged.
- **Market not settled:** → `MarketNotSettled`.
- **Wrong treasury account:** a non-treasury / non-canonical destination → rejected.
- **Full drain:** a settled market with one payable + one permanently-stuck order →
  sweep drains the payable one, admin force-expires the stuck one → `bids.is_empty()
  && asks.is_empty()` and both escrows reconcile to zero.

**Verification:** `cargo test -p meridian-litesvm-tests` green; every test asserts an
escrow-reconciliation, supply-parity, or book-empty invariant.

---

### U5. Trident fuzz: stuck-market drain invariant

**Goal:** Prove under fuzz that a settled market with stuck orders can always be
driven to full drain via admin force-expire, and that recovery conserves value.

**Requirements:** Verifies the convergence guarantee + R13/R14 under fuzz.

**Dependencies:** U1, U2, U3.

**Files:**
- `trident-tests/clob_invariants/test_fuzz.rs` — add a force-expire flow + extend
  invariants.

**Approach:** Extend the existing `flow_sweep_convergence` (from PR #3): after
freezing a recipient and confirming the sweep can't drain it, advance the clock past
grace and have the admin force-expire the stuck entry. Add a `treasury` to the
harness. Strengthen the convergence invariant to: a settled book ALWAYS reaches
empty when admin force-expire is available for the stuck residue. Add a
value-conservation invariant: `escrow_out == treasury_in` for each recovery.

**Test scenarios:**
- Settled market, one recipient frozen indefinitely → sweep stalls, admin
  force-expire (post-grace) drains it → book empties, `escrow_drop == treasury_gain`.
- R13/R14 invariants hold across the recovery flow.
- Pre-grace force-expire attempts revert (no premature confiscation under fuzz).

**Verification:** 100K fuzz run passes; convergence + value-conservation invariants
hold.

---

## System-Wide Impact

- **New admin power.** `admin_force_expire_order` lets the admin move user collateral
  to the treasury — narrowly scoped to settled markets, post-grace, provably-stuck
  orders only. Document the trust assumption and the off-chain claim process.
- **Account-layout changes** to `Market` (+`settled_at`) and `Config` (+`treasury`).
  Safe now (nothing deployed); if any market/config is ever deployed before this
  ships, it becomes a migration.
- **New error codes + instruction + event** → IDL change; version bump; future
  off-chain consumers must know the treasury-custody semantics.
- **Off-chain follow-up (out of scope):** the claim/custody ledger that lets a
  recovered owner retrieve their funds from the treasury later.

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Mitigation |
|---|---|---|
| Admin confiscates a healthy order ("rug") | Med if unguarded | Stuck-ness proof: owner read from the book, canonical ATA derived on-chain, must be un-receivable; healthy order → `OrderNotStuck`. Long grace. |
| Owner fixes their ATA right after force-expire | Low | 30-day grace makes this very unlikely; funds remain claimable from treasury custody (off-chain). |
| R13/R14 broken by the transfer | Low | Force-expire mirrors `cancel_order`'s accounting (order leaves book, escrow drops equally); Yes moved as raw transfer (no supply change). U4/U5 assert both. |
| Account-layout change breaks a deployed instance | Low (nothing deployed) | Land before any deploy; flag as migration if that changes. |
| Treasury ATA mis-set → funds to wrong account | Low | Validate destination against `config.treasury` + canonical-ATA derivation, same binding as maker payouts. |

## Execution Posture

Security-sensitive (new admin power over user funds). Each unit lands behind its
tests; U4/U5 must assert escrow-reconciliation, supply-parity, and full-drain
invariants (not just non-revert) before the pass is considered done. Run the 100K
Trident gate as the final acceptance check.

## Sequencing

```
U1 (settled_at) ─┐
                 ├─▶ U3 (force-expire ix) ─▶ U4 (LiteSVM) ─┐
U2 (treasury+    ─┘                          U5 (Trident) ─┴─ done
   const+errors)        U2 also ──────────▶ U5
```

U1 and U2 are independent and can land in either order; U3 needs both; U4 and U5
close the loop after U3.
