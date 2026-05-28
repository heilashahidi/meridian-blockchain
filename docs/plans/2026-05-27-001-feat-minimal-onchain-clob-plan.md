---
date: 2026-05-27
type: feat
status: completed
origin: docs/brainstorms/minimal-clob-scope-requirements.md
---

# feat: Minimal on-chain CLOB for binary outcome markets

## Summary

Build a minimal on-chain CLOB inside a single Anchor 1.0 program, co-designed with the binary-token mint/redeem primitives so Buy No and Sell No are first-class single-tx instructions. The matching engine lives as a pure-Rust module the program wraps, enabling millisecond-feedback proptest invariants. A day-5 decision gate fails to a Phoenix-CPI fallback if matching invariants aren't passing.

---

## Problem Frame

Meridian needs a matching venue on Solana for binary 0DTE contracts on MAG7 stocks. The brainstorm (see origin: `docs/brainstorms/minimal-clob-scope-requirements.md`) commits to building a minimal CLOB rather than integrating Phoenix, on the named bet that Peak6 evaluators uniquely value matching-engine quality. The plan executes that bet with explicit reversibility via the day-5 gate.

The technical surface is novel for Solana: a fixed-depth, FIFO, price-time-priority book per strike (~40-50 markets/day) with co-designed atomic Buy No (mint-pair + sell-Yes in one tx) and Sell No (buy-Yes + burn-pair in one tx). The $1.00 payout invariant must hold across the combined mint/redeem + CLOB system under fill, cancel, and settle races. Demo target is devnet; mainnet rejected.

---

## Output Structure

```
meridian-blockchain/
├── programs/
│   └── meridian/
│       ├── Cargo.toml
│       ├── Xargo.toml
│       └── src/
│           ├── lib.rs                    # program entry, instruction routing
│           ├── state/
│           │   ├── mod.rs
│           │   ├── config.rs             # global Config account
│           │   ├── market.rs             # per-strike Market account
│           │   ├── book.rs               # Book account (zero-copy, wraps matching engine state)
│           │   └── order.rs              # individual order escrow account
│           ├── matching/                 # pure-Rust matching engine (no Solana deps)
│           │   ├── mod.rs
│           │   ├── book_side.rs          # zero-copy fixed-depth BookSide<N>
│           │   ├── order_key.rs          # packed (price, seq) u128 key
│           │   ├── match_step.rs         # FIFO matching with partial fills
│           │   └── tests.rs              # proptest invariants
│           ├── instructions/
│           │   ├── mod.rs
│           │   ├── initialize_config.rs
│           │   ├── create_strike_market.rs
│           │   ├── mint_pair.rs
│           │   ├── burn_pair.rs
│           │   ├── place_limit_order.rs
│           │   ├── place_market_order.rs
│           │   ├── cancel_order.rs
│           │   ├── buy_no.rs             # atomic mint_pair + market-sell-yes
│           │   ├── sell_no.rs            # atomic market-buy-yes + burn_pair (conditional on No balance)
│           │   ├── settle_market.rs      # set settled flag, record outcome
│           │   ├── settle_sweep.rs       # cranked cancel-all sweep (reentrant-safe)
│           │   └── redeem.rs
│           └── error.rs
├── tests/
│   ├── litesvm/
│   │   ├── lifecycle_test.rs             # create → mint → trade (4 paths) → settle → redeem
│   │   ├── partial_fill_test.rs
│   │   ├── cancel_race_test.rs
│   │   └── settle_race_test.rs
│   └── trident/
│       ├── fuzz_targets/
│       │   └── clob_invariants.rs        # randomized sequence + invariant assertions
│       └── trident.toml
├── automation/                           # OUT OF SCOPE for this plan — see Dependencies
├── frontend/                             # OUT OF SCOPE for this plan — see Dependencies
├── Anchor.toml
├── Cargo.toml                            # workspace
└── .env.example
```

*The tree shows expected output shape; per-unit `Files` lists are authoritative.*

---

## High-Level Technical Design

The program is structured as three concentric layers:

**Layer 1 — Pure-Rust matching engine** (`programs/meridian/src/matching/`): a fixed-depth order book data structure with FIFO at each price level, encoded via a packed `(price, seq_num)` u128 key (OpenBook v2 pattern). No Solana dependencies. Match step takes a taker order + book reference, returns fills and residual. This layer is the one Peak6 evaluators read first — its correctness is the demo's wow factor, and it is the layer most amenable to proptest invariants.

**Layer 2 — Account state and Anchor wrapper** (`programs/meridian/src/state/`, `instructions/`): zero-copy `Book` account (LazyAccount from Anchor 1.0) wraps the matching state; Anchor instructions route input accounts and escrow tokens via PDA-signed CPIs into SPL Token. The settled flag lives on the Book account; Solana's per-account write lock serializes settle-vs-place races.

**Layer 3 — Composed trade paths**: `buy_no` and `sell_no` are single Anchor instructions that internally compose `mint_pair`/`burn_pair` + an internal call to the matching engine. Buy Yes and Sell Yes use `place_limit_order` / `place_market_order` directly.

Sequence sketch (Buy No, market order):

```
User signs 1 tx ──> buy_no(amount, max_yes_sell_price)
                       │
                       ├─ transfer USDC (user → usdc_escrow_pda) [amount]
                       ├─ mint Yes to user [amount]
                       ├─ mint No to user [amount]
                       ├─ matching::match_step(book, taker=sell-yes-at-best-bid, amount)
                       │     │ returns fills + residual
                       │     │
                       │     ├─ for each fill: transfer USDC from book_usdc_escrow → user
                       │     └─ for residual: REJECT (market orders do not post)
                       └─ User ends with: No tokens [amount], USDC delta [received from fills − amount paid]
```

*Directional guidance for review, not implementation specification.*

---

## Key Technical Decisions

- **Anchor 1.0.0 (April 2026).** Required for `LazyAccount` (deferred-deserialize of the book), `dup` constraint (handles same-account-twice cases), and the cleaner CPI builder. Trade-off: relatively new — keep a 0.31 fallback path in mind if a 1.0-specific bug blocks progress.
- **Classic SPL Token for Yes/No mints, not Token-2022.** Reason: USDC on devnet is classic SPL; matching simplifies wiring; Meridian doesn't need any Token-2022 extension for the demo. (If on-chain enforcement of R11 is ever pursued post-demo, a transfer hook via Token-2022 is the natural mechanism.)
- **Pure-Rust matching engine module split from the Anchor program.** This is the highest-ROI structural choice in the plan. The matching engine is the only part of the system where unit tests run in milliseconds (no LiteSVM startup); proptest invariants run thousands of cases per second; and a Peak6 evaluator reading `programs/meridian/src/matching/` sees the microstructure-relevant code cleanly without Anchor wiring noise.
- **Zero-copy `Book` account via `LazyAccount<BookSide>`.** Book depth > 10KB requires zero-copy on Solana; LazyAccount lets cancel-by-id avoid full deserialization. Pattern borrowed from OpenBook v2's BookSide.
- **Packed (price, seq_num) u128 key for order priority.** Top 64 bits = price, bottom 64 bits = sequence. Tree/array sort gives price-priority + FIFO within a price for free. OpenBook v2 pattern.
- **Single Anchor program (CLOB + mint/redeem in one program).** Carries over from origin (R1). Blast-radius concern (a single bug corrupts all markets) is real but devnet-only mitigates and the atomic Buy No / Sell No design is cleaner with shared state. Revisit if mainnet is ever pursued.
- **Market-order Buy No only for the demo.** Limit Buy No introduces transient Yes+No state during cancel and a contradiction with the (now-frontend-only) position constraint. Dropping it removes an entire bug class without losing the four-trade-path signal. (See origin: Buy No limit-path Deferred-to-Planning question.)
- **`burn_pair` primitive added for symmetric Sell No exit.** Resolves the origin's Sell No capital-lock question with the symmetric option: Sell No buys Yes from the book and immediately burns the Yes+No pair for $1 USDC, returning USDC to the user in the same transaction. Mechanically the inverse of `mint_pair`.
- **Three-layer test ladder: proptest + LiteSVM + Trident.** proptest at the matching-module level (fastest feedback, invariant coverage); LiteSVM at the Anchor instruction level (CPI flows, fill-then-cancel race, settle race); Trident fuzz at the multi-instruction-sequence level (R13/R14 across randomized sequences across multiple markets).
- **Pyth pull oracle via `PriceUpdateV2` accounts.** Use `get_price_no_older_than` with a 60-second staleness window at settlement, reject if `conf / price > 1%`. Off-chain Hermes-fetch step in the lifecycle service posts the `PriceUpdateV2` account before settle is called. (Pyth's July 2026 endpoint change is post-demo; not relevant.)
- **Day-5 decision gate fails to Phoenix-CPI fallback.** If by end of day 5, `place_limit_order` + partial fills + `cancel_order` are not passing matching-engine invariant tests (proptest + LiteSVM), swap the matching layer to Phoenix v1 via CPI. Mint/redeem/settle remain in our program. U9 below is the contingency unit.

---

## Implementation Units

### U1. Project scaffolding (Anchor 1.0 + dependencies)

**Goal:** Greenfield Anchor 1.0 workspace with all dependencies wired, `anchor build` succeeds against an empty program, devnet config in `Anchor.toml`, `.env.example` documents required keys.

**Requirements:** Foundation for all subsequent units.

**Dependencies:** None.

**Files:**
- `Cargo.toml` (workspace)
- `Anchor.toml`
- `programs/meridian/Cargo.toml`
- `programs/meridian/Xargo.toml`
- `programs/meridian/src/lib.rs` (empty program with declared ID, `#[program]` stub)
- `programs/meridian/src/error.rs` (`#[error_code]` enum, initial empty)
- `.env.example`
- `.gitignore` (target/, .anchor/, node_modules/, .env)
- `README.md` (one-command setup target documented but no logic)

**Approach:** Use `anchor init meridian --javascript false`, then upgrade to Anchor 1.0.0. Dependencies: `anchor-lang = "1.0"`, `anchor-spl = "1.0"` (features: token, associated_token), `pyth-solana-receiver-sdk = "0.6"`, `borsh = "1.5"`. Workspace structure follows Anchor 1.0 conventions; do not invent a custom layout. Configure `Anchor.toml` cluster = `devnet` with deploy/upgrade authority set via env var.

**Patterns to follow:** Anchor's `examples/tutorial/basic-0/` for the empty-program shape; the OpenBook v2 workspace `Cargo.toml` (`openbook-dex/openbook-v2`) for dependency choices.

**Test scenarios:**
- Happy path: `anchor build` succeeds with zero warnings on the empty program; `cargo check --all-targets` succeeds.
- Test expectation: build/typecheck only — no behavioral tests at this unit.

**Verification:** `anchor build` produces `target/deploy/meridian.so`; `cargo check` is clean; `Anchor.toml` cluster is `devnet`; running `anchor deploy --provider.cluster devnet` against a funded keypair would deploy (do not deploy yet).

---

### U2. Pure-Rust matching engine module + proptest invariants

**Goal:** A self-contained Rust module that defines the order book data structure and match function. No Solana dependencies. Exposes a clean API the Anchor wrapper will call from instruction handlers.

**Requirements:** R2 (one book per strike, fixed-size), R3 (FIFO price-time priority), R4-R5 (place/match semantics), R7 (partial fills), R13 (escrow reconciliation invariant — at this layer, "open notional reconciles to book state").

**Dependencies:** U1.

**Files:**
- `programs/meridian/src/matching/mod.rs`
- `programs/meridian/src/matching/order_key.rs` (packed u128 `OrderKey { price: u64, seq: u64 }`)
- `programs/meridian/src/matching/book_side.rs` (fixed-depth `BookSide<const N: usize>`; bids/asks as separate instances)
- `programs/meridian/src/matching/match_step.rs` (taker-order match function, returns `Vec<Fill>` + residual)
- `programs/meridian/src/matching/tests.rs` (proptest invariants)

**Approach:**
- `OrderKey` is a `u128` packed as `(price << 64) | seq` so natural ordering gives price-priority + FIFO within price (OpenBook v2 pattern; cite in code).
- `BookSide<N>` is a fixed-size sorted array of `OrderEntry { key: OrderKey, owner: Pubkey, qty: u64 }` with binary-search insert (O(log N) compare + O(N) shift; acceptable for small N).
- `match_step(taker: TakerOrder, book: &mut BookSide<N>) -> MatchResult` iterates the opposing side from best price, fills against each entry up to taker qty, returns ordered list of `Fill { maker_owner, price, qty }` and `residual_qty`.
- No allocation in match path (use stack buffer for fills, capped at N).
- Pure-Rust means `cargo test` runs in milliseconds without Solana toolchain.

**Patterns to follow:** OpenBook v2 `programs/openbook-v2/src/state/orderbook/` for packed-key, fixed-array node management. Cite the file in code comments.

**Test scenarios:**
- Happy path: place 1 bid, place 1 crossing ask → ask fills against bid, both removed.
- Happy path: place 3 bids at same price (FIFO order), place 1 large ask → fills in insertion order.
- Edge case: place 1 bid at $0.40, place 1 ask at $0.50 → no match, both rest in book.
- Edge case: place ask larger than full book depth on bid side → fills all bids, residual returned (taker is market order: residual rejected by caller; taker is limit order: residual posts on ask side).
- Edge case: place into a full book → `BookFull` error returned cleanly.
- Edge case: partial fill of resting order → resting order qty decremented in place, FIFO position preserved.
- Edge case: cancel-then-fill ordering — cancel removes from book in O(N), subsequent fill skips that order.
- Error path: invalid price (zero, overflow) rejected with named error.
- **proptest invariants** (run with `proptest!(cases = 10_000)`):
  - After any sequence of place/cancel/match_step ops: sum of resting qty == sum of (placed − canceled − filled) per side; no negative qty; no orders out of price-time order.
  - For every match_step: sum of fill qty + residual qty == taker qty; every fill price respects taker limit.
- Test expectation: behavioral tests required (this is the load-bearing module).

**Verification:** `cargo test -p meridian --lib matching::tests` runs in <1s; proptest invariants pass at 10K cases; `cargo clippy` clean; no `unsafe` blocks in this module.

**Execution note:** Implement this module test-first. The proptest invariants are the spec — write them first, then implement the data structure until they pass. This is the layer where Peak6 evaluators look for microstructure correctness, and the fast feedback loop here justifies the inverted order.

---

### U3. On-chain account state + initialization instructions

**Goal:** Define all on-chain account structs; implement `initialize_config` and `create_strike_market` instructions that bootstrap the on-chain state for one strike.

**Requirements:** R1 (CLOB in same Anchor program as mint/redeem), R2 (one book per strike), R12 (escrow PDAs scoped to book), R6 (immutable owner field on order accounts).

**Dependencies:** U1, U2.

**Files:**
- `programs/meridian/src/state/mod.rs`
- `programs/meridian/src/state/config.rs` (`Config { admin: Pubkey, fee_authority: Pubkey, paused: bool, usdc_mint: Pubkey }`)
- `programs/meridian/src/state/market.rs` (`Market { ticker: [u8; 8], strike_price: u64, expiry_slot: u64, yes_mint: Pubkey, no_mint: Pubkey, mint_authority_bump: u8, settled: bool, outcome: Option<Outcome>, sweep_cursor: u32 }`)
- `programs/meridian/src/state/book.rs` (`#[account(zero_copy)] Book { market: Pubkey, bids: BookSide<N>, asks: BookSide<N>, next_seq: u64 }`; uses `BookSide` from U2)
- `programs/meridian/src/state/order.rs` *(only if we need a separate per-order PDA; first-cut design puts orders inline in `Book.bids/asks` — skip this file unless escrow accounting forces it out)*
- `programs/meridian/src/instructions/initialize_config.rs`
- `programs/meridian/src/instructions/create_strike_market.rs`
- `programs/meridian/src/lib.rs` (add instruction routes)

**Approach:**
- `Config` is a singleton PDA seeded by `[b"config"]`. Stores admin authority, USDC mint, pause flag.
- `Market` is a PDA seeded by `[b"market", ticker.as_ref(), strike.to_le_bytes().as_ref(), expiry.to_le_bytes().as_ref()]`. Holds settlement state and references to Yes/No mints.
- `Book` is a zero-copy PDA seeded by `[b"book", market.key().as_ref()]`. Initialized via `init` then `realloc` if size > 10KB.
- Mint authority PDA seeded by `[b"mint_auth", market.key().as_ref()]`. Yes and No mints are created with this PDA as `mint::authority`.
- Escrow PDAs (USDC + Yes) are PDA-owned token accounts seeded by `[b"usdc_escrow", market.key().as_ref()]` and `[b"yes_escrow", market.key().as_ref()]`.
- `initialize_config` is admin-only, idempotent guarded.
- `create_strike_market` is admin-only (per origin Dependencies: admin authority enumerated permissions). Initializes Market + Book + both mints + both escrow accounts in one instruction. May exceed CU budget — if so, split into two-instruction creation (Market+mints, then Book+escrows).
- Inline orders (in `BookSide.entries`) carry `owner: Pubkey` set immutably at place time — satisfies R6's "immutable owner field" requirement without a separate per-order account.

**Patterns to follow:** Anchor 1.0 `LazyAccount<Book>` for the zero-copy book wrapper. Mint-authority-PDA pattern from `anchor-zero-copy-example`. OpenBook v2 `programs/openbook-v2/src/instructions/create_market.rs` for the multi-account init shape.

**Test scenarios:**
- Happy path: admin calls `initialize_config` → Config PDA exists with admin set, paused=false.
- Happy path: admin calls `create_strike_market(META, $680, expiry_slot)` → Market PDA exists, Book PDA exists (empty), Yes/No mints exist with mint authority = mint_authority_pda, USDC/Yes escrow PDAs exist as zero-balance token accounts.
- Error path: non-admin calls `initialize_config` → fails with `Unauthorized`.
- Error path: non-admin calls `create_strike_market` → fails with `Unauthorized`.
- Error path: `create_strike_market` called twice for the same (ticker, strike, expiry) → second call fails (PDA already exists).
- Edge case: account size exceeds 10KB init limit → instruction splits or reallocs as designed; assert via test that the post-init Book is the configured depth.
- Test expectation: behavioral tests required.

**Verification:** LiteSVM test creates a market end-to-end; all account fields are as specified; account discriminators present; rent paid by admin keypair.

---

### U4. `mint_pair` and `burn_pair` primitives

**Goal:** Two complementary instructions that deposit/burn $1 USDC ↔ 1 Yes + 1 No pair atomically. These are the building blocks for Buy No (U6) and Sell No (U6) and for redeem (U7).

**Requirements:** R8 (atomic single-signature ops), R14 (CLOB precondition: tokens only move via authorized paths). Resolves origin Outstanding Question about Sell No capital lock — `burn_pair` enables symmetric immediate-USDC-return exit.

**Dependencies:** U3.

**Files:**
- `programs/meridian/src/instructions/mint_pair.rs`
- `programs/meridian/src/instructions/burn_pair.rs`
- `programs/meridian/src/lib.rs` (add routes)

**Approach:**
- `mint_pair(amount: u64)`: user transfers `amount` USDC to USDC escrow PDA; program signs `mint_to` × 2 with `mint_authority_pda` to mint `amount` Yes and `amount` No to user's ATAs.
- `burn_pair(amount: u64)`: program burns `amount` Yes and `amount` No from user's ATAs; PDA-signed `transfer` returns `amount` USDC from escrow to user.
- Both check `config.paused == false`.
- `burn_pair` requires user holds ≥ `amount` of both Yes and No (Anchor `#[account]` token-balance constraint).
- No CPI atomicity questions — both are single Anchor instructions calling `token::transfer` / `token::mint_to` / `token::burn` via `anchor_spl::token`.

**Patterns to follow:** Quicknode "create tokens with Anchor" + `anchor-spl::token::mint_to` / `burn` CPI builders. PDA signing pattern: `with_signer(&[&[b"mint_auth", market_key.as_ref(), &[bump]]])`.

**Test scenarios:**
- Happy path: user with 100 USDC calls `mint_pair(50)` → user holds 50 Yes + 50 No, 50 USDC; USDC escrow holds 50 USDC.
- Happy path: user holding 50 Yes + 50 No + 50 USDC calls `burn_pair(30)` → user holds 20 Yes + 20 No + 80 USDC; USDC escrow holds 20 USDC.
- Error path: `mint_pair` with insufficient USDC → fails cleanly.
- Error path: `burn_pair` with insufficient Yes or No → fails cleanly.
- Error path: either called with `config.paused == true` → fails with `ProgramPaused`.
- Edge case: `mint_pair(0)` → fails with `InvalidAmount`.
- Integration: after `mint_pair`, total Yes minted == total No minted == USDC in escrow (the $1.00 invariant precondition).
- Test expectation: behavioral tests required.

**Verification:** LiteSVM test of both primitives in isolation; assert pre/post balances on user, USDC escrow PDA, Yes mint supply, No mint supply.

---

### U5. Order instructions: place_limit, place_market, cancel

**Goal:** The three core order-book instructions wrapping the matching engine module (U2) with Anchor account validation, signer constraints, and PDA-signed escrow.

**Requirements:** R4 (place_limit), R5 (place_market), R6 (cancel_order owner-only via signer constraint matched to immutable owner field), R7 (partial fills), R12 (escrow PDAs), R13 (single-account write-lock serializes cancel/fill).

**Dependencies:** U3, U4.

**Files:**
- `programs/meridian/src/instructions/place_limit_order.rs`
- `programs/meridian/src/instructions/place_market_order.rs`
- `programs/meridian/src/instructions/cancel_order.rs`
- `programs/meridian/src/lib.rs` (add routes)

**Approach:**
- `place_limit_order(side, price, qty)`:
  - Verify market is not settled (R15a check; `require!(!market.settled, MarketSettled)`).
  - For `side = Buy` (bid): transfer `qty * price` USDC from user to USDC escrow PDA.
  - For `side = Sell` (ask): transfer `qty` Yes from user to Yes escrow PDA.
  - Call `matching::match_step` with the taker order; for each fill, route USDC/Yes between escrows and user (post-match settlement loop).
  - Post residual (if any) to the book with `owner = user.key()`, `seq = book.next_seq++`.
  - CU cap: bound match iterations to a per-tx max (configurable constant; planning-time TBD based on benchmarks).
- `place_market_order(side, qty, slippage_bound)`: same as limit but residual is rejected (not posted). `slippage_bound` is worst-acceptable price.
- `cancel_order(order_id)`:
  - `order_id` indexes into `BookSide.entries`.
  - Anchor signer constraint: `require_keys_eq!(ctx.accounts.user.key(), book.bids[order_id].owner, Unauthorized)` (and similar for asks). The user MUST sign with the key that placed the order.
  - Removes the entry from the book in O(N) shift; PDA-signed transfer returns escrowed USDC/Yes to owner.
- All three instructions check `config.paused == false`.

**Patterns to follow:** OpenBook v2 `place_order.rs` and `cancel_order.rs` for instruction structure. Note: OpenBook routes through Open Orders Accounts — Meridian skips that abstraction (each order entry on the book IS the order; signer-constraint-on-owner is the entire owner-verification mechanism).

**Test scenarios:**
- Happy path: user A places limit bid at $0.40 for 100 Yes; book has 100 Yes bid at $0.40, USDC escrow holds $40.
- Happy path: user B places limit ask at $0.40 for 100 Yes → matches A's bid; both users exchange Yes/USDC; book empty.
- Happy path: partial fill — A bids 100 at $0.40, B asks 60 at $0.40 → 60 fill, 40 remains on bid side; USDC escrow has $16 remaining; B gets $24 USDC.
- Happy path: cancel — A cancels their resting bid → escrowed USDC returned to A; book empty.
- Edge case: market order with insufficient book depth → fills available, residual rejected to caller (not posted).
- Edge case: limit order with insufficient book depth → fills available, residual posts.
- Edge case: cancel an order that was already partially filled → only unfilled remainder returned.
- Error path: cancel by non-owner → fails with `Unauthorized` (signer constraint rejects).
- Error path: place on a settled market → fails with `MarketSettled`.
- Error path: place when `config.paused = true` → fails with `ProgramPaused`.
- Race: same-block cancel + fill on the same order → Solana's per-account write lock serializes; whichever lands first wins, the other sees the updated state cleanly (test via LiteSVM with two txs in one slot).
- **Covers AE2** (market order matched against book up to CU cap): exercise this scenario in LiteSVM with depth > CU cap; assert correct partial fill and unfilled-residual return.
- **Covers AE4** (origin AE5 renumbered) (cancel partially-filled order): exercise; assert escrow reconciles.
- Test expectation: behavioral tests required.

**Verification:** All three instructions exercised in LiteSVM lifecycle test (U8); escrow reconciliation invariant (sum of escrow == sum of open notional) holds after every operation.

---

### U6. Native four-trade-path instructions: `buy_no`, `sell_no`

**Goal:** Two atomic single-tx instructions that compose `mint_pair`/`burn_pair` with order-book operations to give the user Buy No and Sell No as first-class actions. Buy Yes and Sell Yes are direct uses of U5 — no separate instructions needed.

**Requirements:** R8 (single-signature atomic), R9 (Buy No = mint-pair + sell-Yes), R10 (Sell No = buy-Yes + burn-pair, returning USDC immediately — symmetric exit per the burn_pair primitive).

**Dependencies:** U4, U5.

**Files:**
- `programs/meridian/src/instructions/buy_no.rs`
- `programs/meridian/src/instructions/sell_no.rs`
- `programs/meridian/src/lib.rs` (add routes)

**Approach:**
- `buy_no(amount, slippage_bound)`:
  - Internally: `mint_pair(amount)` then `place_market_order(side=Sell, qty=amount, slippage_bound)` on the Yes mint.
  - User ends with `amount` No tokens + (USDC delta from the sell).
  - Market-order only — limit Buy No is deferred (see Scope Boundaries). If the market sell can't fill the full amount within `slippage_bound`, the instruction reverts (atomic — no partial Buy No).
- `sell_no(amount, slippage_bound)`:
  - Precondition: user holds ≥ `amount` No tokens.
  - Internally: `place_market_order(side=Buy, qty=amount, slippage_bound)` on the Yes mint → user receives `amount` Yes tokens; then `burn_pair(amount)` → user receives `amount` USDC, Yes and No both burned.
  - User ends with USDC delta (immediate return; no settlement wait).
  - If buy market order can't fill full amount within slippage, revert.
- Both check `config.paused == false` and `market.settled == false`.

**Patterns to follow:** Composition pattern — Anchor instruction calls into other instructions' internal handler functions (not via CPI, since same program). Refactor mint_pair / burn_pair / place_market_order to expose internal `_handler(ctx, params)` functions callable from buy_no/sell_no.

**Test scenarios:**
- **Covers AE3** (Buy No market order): user with 100 USDC, no positions; book has 50 Yes at $0.40 ask; `buy_no(50, slippage=$0.50)` → user ends with 50 No + 70 USDC. Single signature.
- Happy path (Sell No): user with 50 No + book has 50 Yes at $0.40 ask; `sell_no(50, slippage=$0.50)` → user receives 50 USDC (50 USDC paid to buy Yes − 50 burn_pair credit = wait, let me redo this. User pays 50*$0.40 = $20 USDC for the Yes leg; then burn_pair returns $1 per pair × 50 = $50 USDC. Net: user ends with +$30 USDC, 0 No, 0 Yes.) Single signature.
- Error path: `buy_no` when book can't fill full amount → instruction reverts atomically; no partial state.
- Error path: `sell_no` when user lacks No tokens → fails.
- Error path: either when `config.paused` or `market.settled` → fails.
- Edge case: `buy_no(0)` → fails with `InvalidAmount`.
- Race: `sell_no` raced against settle — settled flag check at instruction entry rejects sell_no after settle; in-flight sell_no completes before settle (per Solana write-lock).
- Test expectation: behavioral tests required.

**Verification:** LiteSVM tests for both buy_no and sell_no; assert single-signature atomicity (one signer in tx); pre/post balances correct including USDC delta.

---

### U7. Settlement + redemption: `settle_market`, `settle_sweep`, `redeem`

**Goal:** Three instructions that close out a market: `settle_market` reads the Pyth oracle and records the outcome with atomic settled-flag-then-record; `settle_sweep` iteratively cancels all open orders (reentrant-safe, multi-tx); `redeem` lets winning-token holders burn for $1 USDC.

**Requirements:** R15a (settled flag + atomic check at order entry), R15b (iterative cancel sweep), origin Dependencies (oracle staleness + confidence). New: redemption mechanics.

**Dependencies:** U3, U4, U5.

**Files:**
- `programs/meridian/src/instructions/settle_market.rs`
- `programs/meridian/src/instructions/settle_sweep.rs`
- `programs/meridian/src/instructions/redeem.rs`
- `programs/meridian/src/state/market.rs` (add `Outcome { YesWins, NoWins }`, settled flag, sweep_cursor — already in U3)
- `programs/meridian/src/lib.rs` (add routes)

**Approach:**
- `settle_market(price_update_account)`:
  - Anchor account: `price_update: Account<PriceUpdateV2>` (from `pyth-solana-receiver-sdk`).
  - Verify `clock.unix_timestamp >= market.expiry_slot_to_unix()` (no early settle).
  - `get_price_no_older_than(&Clock::get()?, MAX_AGE_SECONDS=60, &feed_id)?` — fails if stale.
  - Check `price.conf as u128 * 10_000 <= price.price as u128 * MAX_CONF_BPS` (e.g., MAX_CONF_BPS=100 = 1%). Fail if too wide.
  - Set `market.settled = true` (atomic via Solana write lock on Market account).
  - Compute `outcome = if price >= strike { YesWins } else { NoWins }` and record on `market.outcome`.
  - This is the atomic "settled flag set before sweep" guarantee from R15a — `place_limit_order` / `place_market_order` read `market.settled` at instruction entry and Solana's per-account lock serializes the read against this write.
- `settle_sweep(max_orders: u32)`:
  - Requires `market.settled == true`.
  - Cancels up to `max_orders` resting orders starting from `market.sweep_cursor`; refunds escrowed USDC/Yes to each owner; updates `sweep_cursor`.
  - Reentrant-safe: can be called repeatedly until all orders swept; cursor tracks position.
  - Public — anyone can call (no auth needed; just refunds).
- `redeem(amount: u64, side: Side)`:
  - Requires `market.settled == true` and `market.outcome.is_some()`.
  - If user's `side` matches `market.outcome`: burn `amount` of winning token from user; PDA-signed transfer `amount` USDC from settlement vault (USDC escrow) to user.
  - If `side` is the losing side: burn `amount` of losing token (no USDC return) — optional cleanup; could skip and let losers carry worthless tokens.
- Admin-override settle (per origin Dependencies) is a separate instruction `admin_settle_override(outcome: Outcome)` with `clock.unix_timestamp >= market.expiry_unix + ADMIN_DELAY_SECONDS` (e.g., 3600s = 1 hour) check. Documented but lower-priority for the demo; include if time permits.

**Patterns to follow:** Pyth `pyth-solana-receiver-sdk::price_update::PriceUpdateV2` integration per docs. Iterative cranking pattern from OpenBook v2's `close_market` + `prune_orders` flow.

**Test scenarios:**
- **Covers AE1** (settle then sweep): "META > $680" with open orders on both sides; `settle_market` succeeds with a valid Pyth price update; settled flag set; subsequent place attempts fail; sweep runs and returns escrowed tokens to owners.
- Happy path (redeem winners): META settles above $680 (YesWins); user holding 50 Yes calls `redeem(50, Side=Yes)` → 50 Yes burned, 50 USDC returned.
- Happy path (redeem after settlement, no urgency): user calls redeem days later — still works; unredeemed tokens remain redeemable indefinitely.
- Error path: settle with stale oracle (older than 60s) → fails with `OracleStale`.
- Error path: settle with wide confidence (conf/price > 1%) → fails with `OracleConfidenceTooWide`.
- Error path: settle before market expiry → fails with `MarketNotExpired`.
- Error path: settle twice → second call fails (settled flag already set).
- Error path: redeem before settle → fails with `MarketNotSettled`.
- Error path: redeem winning-side amount > user's balance → fails with insufficient-balance.
- Race: `place_limit_order` in flight when `settle_market` lands in same slot → Solana write lock on Market account serializes; one wins cleanly.
- Edge case: `settle_sweep(max_orders=0)` → no-op, no progress made; subsequent call resumes from same cursor.
- Edge case: settle_sweep called when book is already empty → no-op success.
- Test expectation: behavioral tests required including the settle race (LiteSVM test).

**Verification:** LiteSVM end-to-end lifecycle test exercises settle + sweep + redeem; Pyth `PriceUpdateV2` account constructed via test helper (or mocked).

---

### U8. LiteSVM integration test suite

**Goal:** End-to-end scenario tests at the Anchor instruction level covering the full lifecycle and all four trade paths plus race conditions.

**Requirements:** All. Validates the program's external behavior.

**Dependencies:** U3-U7.

**Files:**
- `tests/litesvm/lifecycle_test.rs`
- `tests/litesvm/partial_fill_test.rs`
- `tests/litesvm/cancel_race_test.rs`
- `tests/litesvm/settle_race_test.rs`
- `tests/litesvm/buy_no_sell_no_test.rs`
- `tests/litesvm/common.rs` (test setup: deploys program, sets up Config, two test users, USDC mint)

**Approach:**
- LiteSVM via `litesvm = "0.5"` (or current 2026 version per research brief item 6).
- `common.rs` provides test fixtures: deploys the meridian program, mints test USDC to two test wallets, calls `initialize_config` and `create_strike_market(META, $680, expiry)`.
- Each scenario test composes Anchor client transactions and asserts pre/post account state.
- Pyth integration in tests: construct a `PriceUpdateV2` account directly in test memory (LiteSVM `set_account`), skip the Hermes-fetch step.

**Test scenarios:**
- **`lifecycle_test.rs`** — full create → mint_pair (both users) → user A places limit bid → user B fills via market sell → settle → both redeem → final balances verified. Asserts the $1.00 USDC invariant end-to-end.
- **`partial_fill_test.rs`** — multi-fill scenarios; deep books with multiple price levels; partial cancels after partial fills.
- **`cancel_race_test.rs`** — submit cancel and fill in the same slot for the same order; assert exactly one wins and the other sees consistent state.
- **`settle_race_test.rs`** — submit place_limit and settle_market in the same slot for the same market; assert settle wins (write-lock contention rejects the place, or place lands first and is included in the sweep).
- **`buy_no_sell_no_test.rs`** — covers AE3 (Buy No market order); covers Sell No symmetric exit; assert single-signature atomicity.
- Test expectation: behavioral tests required.

**Verification:** `cargo test -p meridian --test '*'` runs in <30s; all tests pass; escrow reconciliation invariant asserted in test teardown via helper.

**Execution note:** This unit's tests are written before U7's admin override is wired — start lifecycle_test against U3-U7 baseline. Add admin-override test only after U7's admin path lands.

---

### U9. Trident fuzz harness

**Goal:** Multi-instruction-sequence fuzz coverage of R13 (escrow reconciliation) and R14 (CLOB precondition) invariants across randomized place/cancel/fill/settle sequences and multiple markets.

**Requirements:** R13, R14. Resolves origin Deferred-to-Planning fuzz framework question with the proptest + LiteSVM + Trident answer.

**Dependencies:** U3-U7.

**Files:**
- `tests/trident/fuzz_targets/clob_invariants.rs`
- `tests/trident/trident.toml`
- `tests/trident/Cargo.toml`

**Approach:**
- Use Trident v0.12+ (per research brief).
- `#[flow]` macro generates randomized sequences of `mint_pair`, `place_limit_order`, `place_market_order`, `cancel_order`, `buy_no`, `sell_no`, `settle_market`, `settle_sweep`, `redeem`.
- After each step, assert invariants:
  - **R13:** `usdc_escrow_balance == sum(open_bid.qty * open_bid.price)` AND `yes_escrow_balance == sum(open_ask.qty)`.
  - **R14:** `yes_mint.supply == no_mint.supply` (every mint_pair creates equal Yes/No; every burn_pair burns equal).
  - **Token conservation:** sum(USDC across user wallets + USDC escrows + settlement vault) == initial total USDC seeded (no creation, no destruction).
- Run targeting `cases = 100_000` in CI; locally during development run smaller iterations.
- Trident catches the failure modes proptest (engine-level) and LiteSVM (scenario-level) can't reach: cross-instruction state corruption, CPI reentrancy, oracle manipulation.

**Patterns to follow:** Trident docs `0.12.0` examples in `Ackee-Blockchain/trident` repo.

**Test scenarios:**
- 100K randomized sequences of (mint, place, cancel, fill, settle, redeem) operations across 2-3 simultaneous markets.
- Invariant checks after every step (above).
- Specific seeded scenarios for known-tricky cases: settle-during-fill, cancel-during-fill, simultaneous market+limit orders.
- Test expectation: behavioral tests required.

**Verification:** Trident run with 100K cases passes; any crash produces a reduced repro case (Trident's built-in shrinking).

---

### U10. Phoenix-CPI fallback (CONTINGENCY — fires only if day-5 gate trips)

**Goal:** If by end of day 5, U2's matching engine and U5's order instructions are not passing invariant tests (proptest + LiteSVM), swap the matching layer to Phoenix v1 via CPI while retaining mint/redeem/settle in our program. This unit only executes if the day-5 gate fires.

**Requirements:** Same as U5 (R4-R7) and U6 (R8-R10), but matching is delegated to Phoenix v1.

**Dependencies:** U3, U4 (mint_pair, burn_pair, account state stay the same); replaces U5 and U2.

**Files (only created if gate fires):**
- `programs/meridian/src/instructions/phoenix_place_order.rs` (replaces place_limit_order + place_market_order)
- `programs/meridian/src/instructions/phoenix_cancel_order.rs`
- `programs/meridian/src/instructions/buy_no.rs` (rewritten to use phoenix CPI)
- `programs/meridian/src/instructions/sell_no.rs` (rewritten to use phoenix CPI)
- `programs/meridian/src/state/market.rs` (add `phoenix_market: Pubkey`, `seat: Pubkey`)

**Approach:**
- During `create_strike_market`: also call Phoenix `InitializeMarket` via CPI (admin-only) to create a Phoenix market for the Yes/USDC pair; request a `Seat` for our program's PDA via Phoenix `RequestSeatAuthorized`.
- `phoenix_place_order` does the USDC/Yes transfer to Phoenix-owned vaults via Phoenix `DepositFunds` CPI, then Phoenix `PlaceLimitOrderWithFreeFunds` CPI.
- `buy_no` becomes: `mint_pair` + Phoenix `Swap` CPI (sell Yes leg). Solana tx-level atomicity gives the single-signature UX even though it's two instructions.
- `sell_no` becomes: Phoenix `Swap` CPI (buy Yes leg) + `burn_pair`.
- Settle still ours; sweep becomes Phoenix `CancelAllOrders` CPI.

**Patterns to follow:** Per research brief item 5 — Phoenix v1 CPI is shape-described but not Anchor-native; build instructions manually via `solana_program::instruction::Instruction` + `invoke_signed`, or use `phoenix-sdk-core` helpers.

**Test scenarios:** Mirror U8's LiteSVM scenarios against the Phoenix-backed implementation. Skip Trident fuzz (U9) for the fallback path — Phoenix is already audited; the bet on hand-rolled correctness is what required Trident.

**Verification:** LiteSVM lifecycle test passes against the Phoenix-CPI variant; demo continues on devnet.

**Execution note:** This unit is dormant. Implementers reach U10 only on the day-5 fail signal. Estimated 2-3 days of work per the research brief — keeps the day-5 gate honest with the remaining budget.

---

## System-Wide Impact

This plan delivers the on-chain matching + escrow + co-designed trade primitives. The following separate workstreams must exist by the time this plan completes for end-to-end demo:

- **Oracle wiring (separate workstream, presumed parallel):** Off-chain Hermes-fetch step that posts `PriceUpdateV2` accounts before `settle_market` is called. Lives in the automation service repo/directory (not in scope of this plan).
- **Daily lifecycle automation service (separate workstream, presumed parallel):** TypeScript/Node.js service that runs morning job (`create_strike_market` for ~40-50 markets across MAG7) and settlement job (`settle_market` + `settle_sweep` until cursor exhausted). Reads previous closes via Pyth Hermes off-chain.
- **Frontend (separate workstream, presumed parallel):** Next.js app implementing the four trade-path UX, position-constraint frontend enforcement (R11), real-time book display, portfolio + redeem flow. Position constraint check must read fresh on-chain balances at action time.
- **Strike calculation logic (separate workstream):** Off-chain morning job computes strikes at ±3%, ±6%, ±9% rounded to $10, dedups, and calls `create_strike_market` per strike.

These are referenced in origin Dependencies as "assumed present" / "built in parallel." Coordinating that they exist by demo time is a project-management concern beyond this plan's scope.

---

## Verification

The plan is complete when:
- The Anchor program deploys cleanly to Solana devnet via `anchor deploy --provider.cluster devnet`.
- `cargo test -p meridian --lib matching::tests` passes (U2 proptest invariants at 10K cases).
- `cargo test -p meridian --test '*'` passes (U8 LiteSVM scenarios).
- `trident fuzz run clob_invariants -- --cases 100000` passes without invariant violations (U9).
- A devnet reproduction script demonstrates the full lifecycle: create → mint_pair → place orders (4 paths exercised) → settle (Pyth feed) → redeem.
- One-command setup target (`make dev` or equivalent) works on a clean clone.

---

## Scope Boundaries

**In scope (this plan):**
- On-chain Anchor 1.0 program: Config, Market, Book, escrow PDAs.
- `mint_pair`, `burn_pair`, `place_limit_order`, `place_market_order`, `cancel_order`, `buy_no`, `sell_no`, `settle_market`, `settle_sweep`, `redeem`, `pause`/`unpause`.
- Pure-Rust matching engine module with proptest invariants.
- LiteSVM scenario tests + Trident fuzz harness.
- Phoenix-CPI fallback (U10, conditional).

**Out of scope (separate workstreams, see System-Wide Impact):**
- Daily lifecycle automation service.
- Off-chain Hermes oracle-fetch step.
- Frontend application.
- Strike calculation off-chain logic.
- Mainnet deployment (origin: rejected for demo).

**Deferred to follow-up work:**
- Limit-order Buy No (drop for demo; market-Buy-No is sufficient to demonstrate the four-trade-path pattern).
- On-chain enforcement of R11 (position constraints) — frontend-only for demo per origin.
- Advanced order types (IOC, FOK, post-only).
- Maker rebates / fees beyond Solana base costs.
- Dynamic book resizing.
- Self-trade prevention beyond owner-equality check.
- Admin-override settle path (lower priority; ship only if time permits within day-5 budget).
- Mainnet audit + deployment.

---

## Risk Analysis & Mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| Matching engine bugs eat days 1-5; day-5 gate fires | High | U10 contingency (Phoenix-CPI) prepared; estimated 2-3 days to ship. Pure-Rust matching module with proptest gives fast feedback to catch bugs early. |
| Pyth feed unavailable at settle time | Medium | Lifecycle service retries; if still failing, admin-override settle (deferred). Acceptable for devnet demo. |
| Account size > 10KB init limit | Medium | Two-instruction creation pattern (Market+mints, then Book+escrows). Validated during U3. |
| Anchor 1.0 surprise (it's new, April 2026) | Medium | Pin exact version; keep 0.31 fallback path in mind; surface any blocking bug to user immediately. |
| Single program blast radius (one bug corrupts all markets) | Medium | Devnet-only mitigates; Trident fuzz across multiple simultaneous markets catches cross-market state corruption. Revisit if mainnet pursued. |
| `LazyAccount<Book>` perf regression on cancel-by-id (Anchor 1.0 feature) | Low | Benchmark in U2; fallback to standard `Account` wrapper if regressed. |
| Pyth equity feed market-hours quirk (feed freezes outside 9:30-16:00 ET) | Low | Lifecycle service reads previous close immediately at 16:00 ET and pins it; settle reads at 16:00 ET exactly. |
| Trident fuzz finds late-stage invariant bug after demo prep starts | Low | Run Trident continuously from day 3 onward, not as a final-week pass. |

---

## Dependencies / Prerequisites

- Anchor CLI 1.0.0 installed (`avm install 1.0.0 && avm use 1.0.0`).
- Solana CLI 1.18+ (or current 2026 release).
- Rust 1.78+ (or current 2026 release).
- Solana devnet keypair with airdropped SOL for deployment and testing.
- Pyth devnet receiver program ID and Hermes endpoint (per `pyth-solana-receiver-sdk` docs).
- Trident v0.12+ installed (`cargo install trident`).
- Origin doc Outstanding Questions classified — RBP empty (resolved); Deferred-to-Planning items either resolved in Key Technical Decisions above or carried forward in Deferred to Follow-Up Work below.

---

## Deferred (Implementation-Time Unknowns)

These are NOT product decisions — they are technical questions best answered when seeing actual code:

- **Exact bounded depth per side (N in `BookSide<N>`).** Derived from Solana account size limits, CU budget per match, and rent cost across ~40-50 markets. Start with N=32 per side as a working number; benchmark and adjust during U2.
- **Exact CU cap on per-tx match depth.** Bench during U5 development; pick a number that leaves headroom for settlement-time edge cases.
- **Exact match-iteration loop unrolling.** Anchor + LLVM may inline `match_step` aggressively or not; verify CU spent during U5.
- **Final naming of internal handler functions.** `_handler` suffix vs other; decide during U4/U5.
- **Whether to add `admin_settle_override` instruction (deferred).** Include only if U3-U9 ship cleanly with budget remaining.
- **Final Pyth devnet feed IDs (hex) for AAPL/MSFT/GOOGL/AMZN/NVDA/META/TSLA.** Pull from Pyth docs and pin into a constants file during U3.
