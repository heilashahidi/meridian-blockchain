---
title: "fix: CLOB matching-engine hardening (queue-priority griefing, partial-fill duplication, sweep seq)"
type: fix
status: completed
created: 2026-05-28
depth: deep
related:
  - docs/brainstorms/minimal-clob-scope-requirements.md
  - docs/plans/2026-05-27-001-feat-minimal-onchain-clob-plan.md
---

# fix: CLOB matching-engine hardening

Bundle the three deferred P1/P2 review findings on the matching/settlement payout
paths into one coherent pass, with new invariant tests at every layer. The three
findings all touch the same skip-and-re-insert machinery introduced by the
ATA-close DoS hardening (`ad26423`, `6d50774`), so they must be designed together:
finding #1 deliberately reverses part of that hardening, and #2/#4 depend on the
re-insert path #1 reshapes.

**Target repo:** meridian-blockchain (this repo). Program source under
`programs/meridian/src`. Program ID unchanged.

---

## Problem Frame

The skip-and-continue hardening shipped earlier this session fixed a real DoS
(a maker who closes their payout ATA could force every crossing taker to revert).
But the *mechanism* it used — validate the maker's payout account by mint+authority,
skip on mismatch, re-insert the skipped order — opened three new gaps that the
six-persona P1 review surfaced and deferred:

- **#1 (P1) — queue-priority griefing.** The maker payout account is validated only
  by `token_accessor::mint` + `token_accessor::authority` (any token account the
  maker owns), not by canonical-ATA derivation. A taker controls the
  `remaining_accounts` it passes, so it can deliberately supply a *bad* account for
  an honest maker whose real ATA is live, forcing the `!(usdc_ok && yes_ok)` skip
  path. The skipped maker is re-inserted with a fresh seq → bumped to the back of
  its price level. A griefer can repeat this with tiny crossing orders to keep an
  honest maker perpetually at the back of the FIFO queue, denying them fills.
  (`programs/meridian/src/instructions/place_limit_order.rs:434-462`, and the
  caveat comment the review left at `:396-404`.)

- **#2 (P2) — partial-fill skip duplicates a maker entry.** `match_step`
  partially-consumes the front maker via `decrement_front`, leaving the remnant in
  the book, *and* returns a `Fill` for the consumed amount. If that fill's payout is
  then skipped, the skip path inserts a *new* `OrderEntry` for `fill.qty` while the
  decremented remnant is still resting — one logical maker order becomes two book
  entries. Total qty is conserved (R13 escrow reconciliation holds), but the book
  now wastes a slot, splits the maker's FIFO priority, and complicates accounting.
  (`place_limit_order.rs:451-461` re-insert vs. `match_step.rs:157-160`
  decrement-in-place.)

- **#4 (P2) — sweep re-inserts at original seq, throttling throughput.**
  `settle_sweep` re-inserts skipped (un-refundable) entries with their *original*
  `(price, seq)` key, so they sort straight back to the front. The next sweep call
  pops them first again, re-attempts the same un-payable orders, and burns its
  per-call attempt budget on them — a single griefed order pins at the front and
  throttles drain throughput. `place_order_inner` already re-inserts skips with a
  *fresh* seq; sweep is inconsistent.
  (`programs/meridian/src/instructions/settle_sweep.rs:288-302`.)

### Why one pass, not three PRs

#1's canonical-ATA fix changes the meaning of a "skip" in the trading path: once a
taker can no longer *forge* a skip, the only skips left are legitimately-unpayable
makers, which reshapes how #2's re-insert and the seq policy should behave. Splitting
these would force re-litigating the same re-insert code three times.

---

## Goal & Non-Goals

**Goal:** A reviewed implementation that (a) makes maker payouts canonical-ATA-bound
so honest makers cannot be force-skipped, (b) eliminates partial-fill book-entry
duplication while conserving escrow, (c) makes sweep re-insert consistent with the
trading path, and (d) locks all three in with unit + LiteSVM + Trident fuzz invariants.

**Non-goals (this pass):**
- Self-trade prevention (already deferred in the original plan).
- Changing `MAX_FILLS_PER_TX` / `MAX_SWEEP_PER_TX` CU caps.
- Real devnet deploy (faucet-blocked; tracked separately).
- Any off-chain cranker/frontend changes beyond the test-harness account builders.

---

## Key Technical Decisions

1. **Canonical-ATA-only maker payouts (confirmed).** Derive
   `anchor_spl::associated_token::get_associated_token_address(maker_owner, payout_mint)`
   on-chain and require the supplied account to equal it. `anchor-spl` already
   carries the `associated_token` feature (`programs/meridian/Cargo.toml:23`), so
   **no new dependency**. Three-way outcome per fill:
   - supplied key **≠** canonical ATA → **revert** (`InvalidArgument`-class error).
     The taker only hurts itself; no honest maker is affected.
   - supplied key **=** canonical ATA but **not receivable** (uninitialized / frozen
     / not SPL-owned, via existing `token_account_receivable`) → **skip + re-insert**
     (legitimately un-payable maker).
   - supplied key **=** canonical ATA and **receivable** → **pay**.

   This reverses the old "any maker-owned token account" tolerance: makers must
   receive into their canonical ATA. Documented as an intentional contract change.
   Derivation is `find_program_address` (~bounded CU) × at most `MAX_FILLS_PER_TX`
   (4) — within budget.

2. **remaining_accounts reduced to 1-per-fill (confirmed).** A taker order pays
   makers on exactly one mint (Bid taker pays USDC, Ask taker pays Yes), so the
   second account in the old `[maker_usdc, maker_yes]` pair was dead weight *and* an
   extra force-skip surface (a bad non-payout account forced a skip). New ABI:
   `remaining[i]` is the canonical payout ATA for fill `i`. Drops the
   `token_accessor::mint`/`authority` reads entirely — canonical-ATA derivation
   already binds (owner, mint). The off-chain cranker simulating the match must now
   supply one account per fill, not two.

3. **Seq policy.** Trading path (`place_order_inner`) **keeps fresh-seq** re-insert:
   after #1 the only skips are legitimately-unpayable makers, and moving them to the
   back is the correct DoS-avoidance behavior (a maker with a genuinely-closed ATA
   should not pin the price level). `settle_sweep` **switches to fresh-seq** (#4),
   making it consistent with the trading path and unblocking drain throughput.

4. **Partial-fill remnant identity (#2).** Add a `fully_consumed: bool` to `Fill`.
   On skip: if `fully_consumed` → re-insert a fresh entry (current behavior, correct
   — the maker was popped). If **not** `fully_consumed` → the decremented remnant is
   still resting at the **front** of the opposing side (guaranteed: `match_step`
   only partial-fills the front, and only on its last iteration; no book mutation
   happens between match and re-insert). Restore `fill.qty` into that front entry via
   a new `BookSide::increment_front`, guarded by a `debug_assert` on
   owner+price identity, with a defensive fallback to insert-new (degrades to current
   behavior, never corrupts escrow). This conserves maker qty (R13) without
   duplicating the entry.

5. **Apply canonical-ATA to `settle_sweep` too (consistency, boil-the-lake).** The
   same helper closes the analogous cranker-driven force-skip in sweep and lets us
   delete sweep's `token_accessor` validation. Folded into U4 since we are already
   editing that path; kept clearly separable in the diff. Recipient = canonical ATA
   of the *order owner* (USDC ATA for bid refunds, Yes ATA for ask refunds).

---

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not
implementation specification. The implementing agent should treat it as context, not
code to reproduce.*

Per-fill payout decision in `place_order_inner` (taker side fixed for the whole order):

```
payout_mint = if taker.side == Bid { usdc_mint } else { yes_mint }   // maker receives the opposite of what they escrowed
for i in 0..fill_count:
    canonical = get_associated_token_address(fill.maker_owner, payout_mint)
    acct      = remaining[i]                       // 1-per-fill now
    require!(acct.key == canonical, BadMakerAccount)        // revert: taker's fault
    if !token_account_receivable(acct):                     // uninit / frozen / not SPL-owned
        record_skip(fill)                                    # legitimate skip
        continue
    pay(acct, amount_for(fill))

on re-insert of each recorded skip:
    if fill.fully_consumed: book[opp].insert(fresh_seq_entry(fill))   # popped → new entry
    else:                   book[opp].increment_front(fill.qty)       # remnant still resting → restore qty
```

`settle_sweep` mirrors the validation (canonical ATA of the order owner) and changes
its re-insert from `entry` (original key) to a fresh-seq entry.

---

## Implementation Units

### U1. Engine plumbing: `Fill.fully_consumed` + `BookSide::increment_front`

**Goal:** Add the two primitives #2 and #3 need, with zero instruction-level
behavior change yet. Pure additive engine work, unit-tested in isolation.

**Requirements:** Supports R13 (escrow reconciliation under partial-fill + skip).

**Dependencies:** none.

**Files:**
- `programs/meridian/src/matching/match_step.rs` — add `fully_consumed: bool` to
  `Fill`; set it (`true` on `pop_front` branch, `false` on `decrement_front` branch).
- `programs/meridian/src/matching/book_side.rs` — add `increment_front(&mut self, delta: u64)`
  mirroring `decrement_front` (front entry only, `debug_assert!(len > 0)`).
- Update the two existing `Fill { .. }` literals in
  `place_limit_order.rs` (`match_capped`'s zero-init buffer at `:748-754`) to set the
  new field, so the crate still compiles before U2/U3 wire in the behavior.

**Approach:** `fully_consumed` is set inside `match_step`'s existing branch at
`match_step.rs:153-164` — `true` in the `fill_qty == front.qty` pop branch, `false`
in the `else` decrement branch. `increment_front` is the inverse of `decrement_front`
already at `book_side.rs:261-265`; no sort change (qty is not part of the key).

**Patterns to follow:** `decrement_front` (`book_side.rs:261`); existing `Fill`
construction in `match_step.rs:144-148`.

**Test scenarios** (`programs/meridian/src/matching/match_step.rs` `#[cfg(test)]`,
`programs/meridian/src/matching/book_side.rs` `#[cfg(test)]`):
- Full consumption sets `fully_consumed == true`: taker ask fully fills a single bid
  → the one `Fill` has `fully_consumed == true`.
- Partial consumption sets `fully_consumed == false`: taker ask of 3 vs front bid
  qty 10 → `Fill.fully_consumed == false`, remnant qty 7 still resting.
- Multi-fill mix: three makers, taker sweeps two fully + partials the third →
  fills `[true, true, false]`.
- `increment_front` adds to the front entry's qty and preserves seq/position:
  insert two entries at equal price, `decrement_front(3)` then `increment_front(3)`
  → front qty and seq restored to original, second entry unmoved.
- `increment_front` on a freshly-inserted single entry restores qty; `total_qty`
  reflects the increment.

**Verification:** `cargo test -p meridian --lib` green; new fields/methods compile
across all existing call sites.

---

### U2. Finding #1: canonical-ATA maker payouts + 1-per-fill ABI

**Goal:** Make maker payouts canonical-ATA-bound and collapse `remaining_accounts`
to one payout account per fill, closing the queue-priority griefing vector.

**Requirements:** Closes #1 (P1). Preserves R13, R14, AE2 (residual posts cleanly).

**Dependencies:** U1 (the re-insert block reads `fully_consumed` once U3 lands; U2
keeps the fresh-entry re-insert for now but must not regress the field).

**Files:**
- `programs/meridian/src/instructions/place_limit_order.rs` — rewrite the step-3
  validation (`:434-462`): derive canonical payout ATA, `require!` key match (revert),
  `token_account_receivable` for skip-vs-pay; index `remaining[i]` (not `i*2`);
  update the `remaining.len() >= fill_count` check (`:405-408`) from `* 2` to `* 1`;
  delete the now-dead `token_accessor::mint`/`authority` maker reads and the
  `maker_yes`/`maker_usdc` pair fetch; update the module doc block (`:26-46`,
  `:390-404`) to describe the 1-per-fill canonical-ATA contract.
- `programs/meridian/src/error.rs` — add a `BadMakerAccount` (or reuse a precise
  existing variant) for the non-canonical revert; pick a name distinct from the
  skip path so reverts are diagnosable.
- `programs/meridian/src/instructions/place_market_order.rs` — caller of
  `place_order_inner`; verify no per-fill account assumptions leak (it forwards
  `remaining_accounts`); update any doc referencing the 2-per-fill ABI.
- `programs/meridian/src/instructions/buy_no.rs`,
  `programs/meridian/src/instructions/sell_no.rs` — compose the kernel; update their
  `remaining_accounts` doc/contract to 1-per-fill.

**Approach:** Payout mint is fixed by taker side for the whole order: Bid taker pays
makers USDC (canonical USDC ATA), Ask taker pays makers Yes (canonical Yes ATA) — the
maker receives the opposite of what they escrowed. Derive once per fill via
`get_associated_token_address(maker_owner, payout_mint)`. Non-canonical → revert
(taker error, no honest maker harmed). Canonical-but-unreceivable → existing skip +
fresh-seq re-insert. Keep the `skipped`/`skipped_qty` fold into residual unchanged.
The price-improvement refund, residual-post, and market-refund paths (steps 4-5) are
untouched.

**Patterns to follow:** existing `token_account_receivable` (`place_limit_order.rs:91`);
PDA-signed transfer pattern in the same file (`:480-538`); error-variant style in
`error.rs`.

**Technical design:** see High-Level Technical Design above (directional).

**Test scenarios** (LiteSVM lands in U5; engine-adjacent assertions here are covered
by U5's end-to-end suite — this unit is feature-bearing but its behavior is only
observable through the instruction, so test scenarios are enumerated in U5 and
cross-referenced):
- Test expectation: behavioral coverage in U5 (force-skip-now-reverts, honest-maker-
  paid-at-canonical-ATA, closed-canonical-ATA legitimately skips). U2 carries the
  code; U5 carries the end-to-end tests because they require the LiteSVM `Env`.

**Verification:** `cargo build-sbf` / `anchor build` clean (no SBPF stack regression
from removing one boxed account per fill — should *improve* headroom); existing
LiteSVM suite updated in U5 passes; no `token_accessor` import left unused.

---

### U3. Finding #2: partial-fill skip restores remnant instead of duplicating

**Goal:** When a *partial* fill is skipped, restore its qty into the existing
front remnant rather than inserting a duplicate entry.

**Requirements:** Closes #2 (P2). Hard-preserves R13 (qty conserved, escrow
reconciled).

**Dependencies:** U1 (`fully_consumed`, `increment_front`), U2 (shares the skip path).

**Files:**
- `programs/meridian/src/instructions/place_limit_order.rs` — in the skip re-insert
  block (`:548-561`): branch on the recorded fill's `fully_consumed`. `true` →
  current fresh-seq insert. `false` → `increment_front(fill.qty)` on the opposing
  side, guarded by `debug_assert!` that the front entry's owner+price match the
  skipped fill; defensive `else` falls back to fresh-seq insert (degrades to current
  behavior). Carry `fully_consumed` (and the price/owner for the guard) on the
  `skipped` records — extend the `skipped` collection from `Vec<OrderEntry>` to
  carry the flag, or stash a parallel small vec.

**Approach:** At most one fill per match is partial (it is always the last, when the
taker exhausts against a larger front maker), so at most one `increment_front`
restore happens, and it targets the front of the opposing side. Do the partial
restore **before** inserting any fresh-seq full skips (so the front is still the
partial remnant when we increment). The guard makes the front-identity assumption
explicit and safe.

**Patterns to follow:** the existing skip-collection + re-insert loop in the same
file; `increment_front` from U1.

**Test scenarios** (engine-level where possible in
`programs/meridian/src/matching/`, end-to-end in U5):
- Unit (book-level): simulate a partial-skip restore — decrement front by `k`, then
  `increment_front(k)` → side has exactly one entry for that maker at original qty
  (no second entry), `len` unchanged.
- End-to-end (U5): a maker rests qty 10; taker crosses qty 3 with a *bad*… —
  superseded by U2's revert. With canonical ATA, the partial-skip path is now only
  reachable when the maker's canonical ATA is genuinely closed/frozen: maker rests
  qty 10, freezes their canonical payout ATA, taker crosses qty 3 → fill is partial
  + skipped → **one** book entry for the maker at qty 10 (restored), `len` of the
  side unchanged, escrow balance reconciles to total open-order notional (R13).
- End-to-end (U5): full-consumption skip still re-inserts a fresh entry (regression
  guard that the `true` branch is unchanged).
- Book-entry-count invariant: across a fill that skips a partial maker, the opposing
  side's entry count does not increase.

**Verification:** `cargo test -p meridian --lib` green; LiteSVM R13 reconciliation
assertion holds; no duplicate maker entry observable after a partial skip.

---

### U4. Finding #4: sweep fresh-seq re-insert + canonical-ATA recipient validation

**Goal:** Make `settle_sweep` re-insert skipped entries with a fresh seq (consistent
with the trading path, unblocks throughput) and validate recipients by canonical ATA
(consistency with U2, removes accessor validation).

**Requirements:** Closes #4 (P2). Preserves R15b (reentrant-safe sweep), R13.

**Dependencies:** none strictly (independent path); sequence after U2 so the
canonical-ATA helper/pattern is settled.

**Files:**
- `programs/meridian/src/instructions/settle_sweep.rs` — re-insert block (`:288-302`):
  assign a fresh seq via `book.next_seq()` before `insert` (mirror
  `place_order_inner:548-561`). Recipient validation (`:256-258`): replace the
  `token_accessor::mint`/`authority` reads with canonical-ATA derivation
  (`get_associated_token_address(entry.owner, expected_mint)`) + `require!` key match
  → on mismatch, this is a malformed crank call; **skip** (do not revert — sweep is a
  public crank and one bad slot should not abort the whole batch) and let a correct
  crank re-attempt. Keep `token_account_receivable` for frozen/closed. Update the
  module doc (`:24-42`) to the canonical-ATA contract and fresh-seq behavior.

**Approach:** The fresh-seq change is the core #4 fix; the canonical-ATA change is the
consistency extension (decision #5). Note the deliberate asymmetry with U2: the
trading path **reverts** on a non-canonical maker account (the taker is the actor and
should bear its own error), whereas sweep **skips** on a non-canonical recipient (the
cranker is an untrusted public actor and must not be able to abort other owners'
refunds). Both prevent forced-skip griefing of honest parties.

**Patterns to follow:** `place_order_inner` fresh-seq re-insert (`:548-561`);
`Book::next_seq` (`book.rs:75`); U2's canonical-ATA derivation.

**Test scenarios** (LiteSVM in U5; this unit is feature-bearing, tests live in U5
because they need the settle/sweep `Env` in `u7_settle_redeem.rs`):
- Test expectation: behavioral coverage in U5 (throughput-not-throttled,
  fresh-seq-ordering, canonical-recipient, skip-on-bad-recipient, reentrancy).

**Verification:** `anchor build` clean; U5 sweep tests pass; cursor monotonicity and
R13 reconciliation preserved.

---

### U5. LiteSVM: migrate account builders to 1-per-fill + new behavioral tests

**Goal:** Update every LiteSVM helper that builds `remaining_accounts` for
order-placement / sweep to the new ABI, and add the end-to-end tests that prove #1,
#2, #4.

**Requirements:** Verifies #1, #2, #4 end-to-end; AE2, AE4, R13, R15b regression.

**Dependencies:** U2, U3, U4.

**Files:**
- `tests/litesvm/src/lib.rs` — shared helpers: any `remaining_accounts` builder for
  `place_limit_order` / `place_market_order` / `buy_no` / `sell_no` must emit one
  canonical maker payout ATA per expected fill (payout side derived from taker side);
  sweep builder emits the canonical owner ATA per popped order. Add a helper to
  freeze a token account (for the legitimate-skip tests) if not present.
- `tests/litesvm/tests/u5_orders.rs` — update existing order tests to the 1-per-fill
  ABI; add #1 and #2 tests.
- `tests/litesvm/tests/u6_buy_no_sell_no.rs` — update composed-kernel account builders.
- `tests/litesvm/tests/u7_settle_redeem.rs` — update sweep account builders; add #4
  tests.
- `tests/litesvm/tests/u8_lifecycle.rs` — update any place/sweep account builders used
  in lifecycle flows.

**Approach:** The ABI change touches every place/sweep call in the suite — this is
the bulk of the mechanical work. Use the checkpoint's known gotcha: identical txs are
rejected `AlreadyProcessed` before the program runs, so call
`env.fx.svm.expire_blockhash()` between repeated identical instructions (the
force-skip-retry and sweep-throughput tests will need this). Each test file has its
own `Env`; place #4 tests in `u7` (has settle/sweep helpers), #1/#2 trading tests in
`u5`.

**Patterns to follow:** existing `u5_orders.rs` / `u7_settle_redeem.rs` test
structure; `expire_blockhash` idempotency pattern noted in the prior checkpoint.

**Test scenarios:**
- **#1 force-skip now reverts (U2):** honest maker rests an ask at the best price
  with a *live* canonical Yes/USDC ATA; taker crosses but supplies a non-canonical
  (but maker-owned) account → tx **reverts** with `BadMakerAccount`; maker's order is
  untouched, still at front with original seq. (This is the griefing closure: the
  griefer can no longer skip an honest maker.)
- **#1 honest happy path:** taker supplies the correct canonical maker ATA → fill
  settles, maker paid, taker receives counter-asset, escrow reconciles (R13).
- **#1 legitimate skip:** maker's canonical ATA is closed/frozen; taker supplies the
  (correct) canonical ATA → fill skips, maker re-inserted with **fresh seq** (back of
  level), taker residual posts/refunds; escrow reconciles.
- **#2 no duplicate on partial skip:** maker rests qty 10 with a frozen canonical
  payout ATA; taker crosses qty 3 → partial fill skipped → maker side has **exactly
  one** entry at qty 10, side `len` unchanged, escrow == total open notional (R13).
  Covers R13.
- **#2 full-skip still re-inserts:** two makers, front fully consumed + skipped (ATA
  frozen) → re-inserted as one fresh entry; side count correct.
- **#4 sweep throughput not throttled:** settle a market with N resting orders where
  the front order's canonical recipient is frozen; first sweep call drains the
  *payable* orders behind it (skipped one re-inserted at fresh seq → back), converges
  in expected calls instead of re-attempting the bad order every call. Covers R15b.
- **#4 sweep canonical recipient + skip-on-bad:** cranker supplies a non-canonical
  recipient → that order is skipped (not a tx revert), other refunds in the batch
  succeed; a correct re-crank pays the skipped owner.
- **#4 sweep reentrancy/idempotency:** re-running sweep after convergence is a no-op
  success; cursor monotonic. (Use `expire_blockhash` between identical calls.)
- **AE4 regression:** partial-fill-then-cancel still reconciles after the ABI change.

**Verification:** `cargo test -p meridian-litesvm-tests` green; LiteSVM count rises
from 86 with the new cases; every test asserts an explicit escrow-reconciliation or
book-entry-count invariant, not just a non-revert.

---

### U6. Trident fuzz: migrate harness ABI + add hardening invariants

**Goal:** Update the fuzz harness to the 1-per-fill ABI and add invariants that would
catch a regression of #1/#2/#4.

**Requirements:** Verifies #1/#2/#4 under fuzz; preserves the existing 100K liveness +
skip-path coverage.

**Dependencies:** U2, U3, U4.

**Files:**
- `trident-tests/clob_invariants/test_fuzz.rs` — update the order/sweep flow account
  builders to emit canonical payout ATAs (1-per-fill for trading, 1-per-attempt for
  sweep); add invariant checks.
- `trident-tests/clob_invariants/fuzz_accounts.rs`,
  `trident-tests/clob_invariants/types.rs` — adjust account-derivation helpers /
  generated types as the ABI requires.

**Approach:** Preserve the existing maker-pairing and the ~1-in-7 corruption that
exercises the skip path (per the prior session's harness work) — but the corruption
now must target the *canonical* ATA (close/freeze it) to reach the skip path, since a
non-canonical account now reverts. Add invariants:
- **No book-entry duplication:** after any matching flow, the number of distinct
  (owner, price, seq) entries per side never exceeds the number of live resting
  orders implied by escrow (catches #2 regression).
- **Entry-count non-increase on skip:** a skip-inducing fill never grows the opposing
  side's entry count (catches #2).
- **Escrow reconciliation (R13):** sum of escrow balances == total open-order
  notional, asserted across all flows (already the core invariant; keep).
- **Sweep convergence:** under repeated sweep calls a settled book always reaches
  empty (catches a #4 throttle/wedge regression).

**Patterns to follow:** the existing `clob_invariants` flow + invariant structure;
the prior session's liveness-aware, book-aware flow generation.

**Test scenarios:** the fuzz invariants above, run via
`cd trident-tests && TRIDENT_ITERATIONS=100000 TRIDENT_FLOW_CALLS=10 trident fuzz run clob_invariants`
(rebuild the `.so` first: `touch programs/meridian/src/lib.rs && anchor build`; do not
`grep -v '|'` the output — it eats the metrics table).

**Verification:** 100K-iteration fuzz run passes clean with the new invariants;
skip-path reverts still observed (now via canonical-ATA close/freeze, not arbitrary
bad accounts).

---

## System-Wide Impact

- **ABI / off-chain contract change.** `place_limit_order` / `place_market_order` /
  `buy_no` / `sell_no` now take **one** maker payout account per fill (was two), and
  it must be the maker's **canonical ATA**. Any off-chain cranker, frontend, or SDK
  that builds `remaining_accounts` must be updated. None exist in-repo yet (frontend
  is deferred), so the only consumers today are the test harnesses (U5, U6). Flag
  this prominently in the PR body so the future cranker/frontend honor it.
- **Maker UX contract.** Makers must hold a canonical ATA for the mint they will be
  paid in. A maker without one (or with it frozen) is skipped, not paid, until they
  create/unfreeze it — same recoverability as today, narrower account flexibility.
- **CU.** Adds ≤4 `find_program_address` derivations per trading tx and ≤8 per sweep
  tx; removes one boxed SPL account per fill (stack headroom improves). Expected net
  neutral-to-positive on the SBPF stack budget that previously forced the box-everything
  workaround.

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Mitigation |
|---|---|---|
| Reversing the skip-hardening re-opens the original ATA-close DoS | Med | #1 keeps skip-on-unreceivable for *canonical* ATAs + fresh-seq re-insert; the DoS fix is preserved, only the *forge* vector is closed. U5 legitimate-skip + U6 liveness invariants prove the book still progresses. |
| `increment_front` targets the wrong front entry (#2) | Low | `match_step` invariant: partial fill is always the front, always the last fill, no book mutation before re-insert. Guard with `debug_assert` + defensive insert-new fallback (degrades to current behavior, never corrupts escrow). |
| ABI migration misses a caller / test builder | Med | U2 enumerates all 4 instruction callers; U5 enumerates all 5 LiteSVM files + shared helpers; `cargo build-sbf` + full suite catch unconverted sites. |
| CU regression from per-fill ATA derivation | Low | Bounded by `MAX_FILLS_PER_TX`=4 / `MAX_SWEEP_PER_TX`=8; offset by removing a boxed account per fill. Confirm via build + fuzz CU metrics. |
| Sweep skip-vs-revert asymmetry confuses future readers | Low | Documented explicitly in U4 approach + module doc: taker path reverts (taker is the actor), sweep skips (untrusted public crank). |

---

## Execution Posture

Characterization-aware: this is security-sensitive code reversing prior hardening.
Each unit lands behind its tests, and U5/U6 must assert explicit escrow-reconciliation
and book-entry-count invariants (not just non-revert) before the pass is considered
done. Run the 100K Trident fuzz gate as the final acceptance check.

## Sequencing

```
U1 (engine plumbing) ──▶ U2 (#1 canonical ATA + ABI) ──▶ U3 (#2 no-dup)
                                   │                          │
                                   ├──────────▶ U5 (LiteSVM) ◀┤
U4 (#4 sweep) ─────────────────────┴──────────▶ U5         │
U2,U3,U4 ─────────────────────────────────────▶ U6 (Trident fuzz)
```

U1 → U2 → U3 is the critical chain. U4 is parallelizable after U2. U5 and U6 close
the loop once U2/U3/U4 land.
