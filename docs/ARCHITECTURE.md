# Meridian — Architecture & Design Decisions

> System design and the rationale + trade-offs behind every significant architecture and on-chain
> decision. This is the canonical "why it's built this way" document.
>
> Companion docs: the scope rationale lives in
> [`docs/brainstorms/minimal-clob-scope-requirements.md`](brainstorms/minimal-clob-scope-requirements.md);
> the unit-by-unit implementation plan lives in
> [`docs/plans/2026-05-27-001-feat-minimal-onchain-clob-plan.md`](plans/2026-05-27-001-feat-minimal-onchain-clob-plan.md).

---

## 1. What Meridian is

Meridian is a minimal **on-chain central limit order book (CLOB) for binary outcome markets** — contracts
of the form *"will META close at or above $680 today?"* — implemented as a single Anchor program on
Solana. Each strike is represented by a complementary **Yes / No token pair** where, by construction,
**Yes payout + No payout = $1.00** at settlement. Markets are settled non-custodially by reading a Pyth
price oracle on-chain.

The defining choice is that the matching engine is **hand-rolled as a pure-Rust module** rather than
delegated to an existing CLOB, and the binary-token mint/redeem primitives are **co-designed with the
order book** so that *Buy No* and *Sell No* are first-class single-transaction instructions.

---

## 2. System context

The on-chain program is the trust root of a four-component system. Only the program is in scope for this
build; the other three are operated off-chain and built in parallel.

```
        ┌────────────────────┐         reads previous close,
        │  Off-chain          │◄───────  posts PriceUpdateV2 via Pyth Hermes
        │  automation service │
        │  (TypeScript/Node)  │
        └─────────┬───────────┘
   morning job:   │   4:05pm ET job:
   create ~40-50  │   settle_market + settle_sweep
   strike markets │
                  ▼
   ┌──────────────────────────────────┐        ┌──────────────────┐
   │  Meridian Anchor program (Solana) │◄──────►│  Pyth oracle      │
   │  Config / Market / Book PDAs      │ settle │  (PriceUpdateV2)  │
   │  escrow PDAs · Yes/No mints       │        └──────────────────┘
   │  pure-Rust matching engine        │
   └──────────────┬────────────────────┘
                  ▲  signs txs (4 trade paths, redeem)
                  │
        ┌─────────┴───────────┐
        │  Frontend (Next.js) │  wallet connect, market grid, trade panel,
        │                     │  position-aware constraints, portfolio / redeem
        └─────────────────────┘
```

| Component | Responsibility | Why off/on chain |
|---|---|---|
| **On-chain program** | custody, minting, matching, settlement, redemption, invariant enforcement | must be trustless |
| **Automation service** | morning strike creation, 4:05pm settlement, retries, admin-override fallback | availability concern, not a trust concern → cheap restartable jobs |
| **Oracle (Pyth pull)** | off-chain Hermes fetch posts a `PriceUpdateV2` account before `settle_market` | price provenance is verified on-chain; fetch is just transport |
| **Frontend** | turns the CLOB into a "simple directional bet"; enforces position constraints client-side | UX, not custody |

---

## 3. On-chain account model

Solana programs are stateless; all state lives in program-owned accounts addressed by **PDAs** (Program
Derived Addresses — deterministic, keyless, controlled only by program logic).

```
Config (singleton)                       seed: ["config"]
  admin, paused, usdc_mint, pyth_receiver,
  require_full_verification, fee_authority, treasury

Market (one per strike)                  seed: ["market", ticker, strike_le, expiry_le]
  strike_price (USDC microunits), expiry_unix (i64),
  settled, outcome: Option<YesWins|NoWins>, settled_at,
  yes_mint, no_mint, mint_authority_bump, sweep_cursor, pyth_feed_id
        │
        ├── Book (per market, ZERO-COPY) seed: ["book", market]
        │     bids: BookSide<32>, asks: BookSide<32>, next_seq
        ├── Yes mint        seed: ["yes_mint", market]     authority = mint_authority PDA
        ├── No mint         seed: ["no_mint", market]      authority = mint_authority PDA
        ├── USDC escrow     seed: ["usdc_escrow", market]  authority = mint_authority PDA
        ├── Yes escrow      seed: ["yes_escrow", market]   authority = mint_authority PDA
        └── mint_authority  seed: ["mint_auth", market]    (keyless PDA signer)
```

- **`Config`** is a singleton (`["config"]`); the first `initialize_config` caller becomes admin.
- **`Market`** is small (<200 bytes), standard Borsh. Strike and expiry are encoded in the PDA seed, so
  `(ticker, strike, expiry)` is unique and a market cannot be created twice.
- **`Book`** is the only zero-copy account: `OrderEntry` = 56 bytes, `BookSide<32>` = 1,800 bytes, whole
  `Book` = **3,640 bytes data + 8-byte discriminator = 3,648 bytes** (well under the 10KB init limit). A
  `const _` assertion pins the size so a field that bloats it fails the build.
- **One `mint_authority` PDA per market** signs every value-moving CPI (mint Yes/No, release USDC, pay
  makers). No keypair anywhere can move funds.

---

## 4. Instruction surface

| Group | Instruction | Auth | Purpose |
|---|---|---|---|
| Bootstrap | `initialize_config` | first caller → admin | create the singleton Config |
| Admin | `create_strike_market` | admin | create Market + Book + mints + escrows |
| | `set_paused` | admin | global kill switch |
| | `set_require_full_verification` | admin | enforce/relax Pyth Full verification |
| | `admin_settle_market` | admin, +24h grace | emergency settle without oracle |
| Mint primitives | `mint_pair` / `burn_pair` | user | USDC ↔ equal Yes + No |
| Order book | `place_limit_order` | user | match, post residual |
| | `place_market_order` | user | match, refund residual |
| | `cancel_order` | order owner | remove resting order, refund escrow |
| Trade paths | `buy_no` / `sell_no` | user | atomic mint+sell / buy+burn |
| Settlement | `settle_market` | permissionless | read Pyth, stamp outcome |
| | `settle_sweep` | permissionless crank | refund resting orders (resumable) |
| | `redeem` | user | burn winning token → $1 USDC |

(Buy Yes / Sell Yes are just `place_*_order` directly — no dedicated instruction.)

---

## 5. Decision log

Each decision is recorded as **Context → Decision → Rationale → Trade-offs → Alternatives rejected**.

### Chain & framework

#### D1. Solana as the settlement chain
- **Context.** A binary-options venue creating ~40–50 markets/day with frequent order placement and
  cancellation needs cheap, fast transactions and a state model that supports many independent books.
- **Decision.** Build on Solana.
- **Rationale.** High throughput and sub-cent fees suit high-frequency order flow; the account model lets
  each strike be an isolated set of accounts; and Solana's per-account write lock gives correct
  serialization of same-market operations *for free* (see D13).
- **Trade-offs.** Solana's account-size limits and the ~4KB SBPF stack budget constrain data-structure
  design (drove the fixed-depth book and the zero-copy layout). Rust/Anchor has a steeper learning curve
  than Solidity.
- **Alternatives rejected.** EVM L1/L2 — higher fees and lower throughput for order-book churn, and no
  equivalent of free per-account serialization.

#### D2. Anchor 1.0 framework
- **Context.** The program needs PDA management, CPI to SPL Token, account validation, and a zero-copy
  account for the book.
- **Decision.** Use Anchor 1.0.0.
- **Rationale.** `AccountLoader`/`LazyAccount` for zero-copy, a cleaner CPI builder, and strong account
  validation macros reduce boilerplate and a whole class of validation bugs.
- **Trade-offs.** Anchor 1.0 is new (April 2026), so there's some bleeding-edge risk.
- **Mitigation.** Pinned the exact version; kept the mature 0.31 line in mind as a fallback if a
  1.0-specific bug blocked progress.

#### D3. Classic SPL Token (not Token-2022)
- **Context.** Yes/No mints and the USDC quote asset need a token standard.
- **Decision.** Use classic SPL Token.
- **Rationale.** Devnet USDC is classic SPL; matching the quote asset simplifies wiring; no Token-2022
  extension is needed for the demo's feature set.
- **Trade-offs.** No transfer hooks, so on-chain position constraints (D24) can't be enforced at the token
  layer today.
- **Alternatives rejected.** Token-2022 — its transfer-hook extension is the natural mechanism if on-chain
  position-constraint enforcement is pursued post-demo, but it adds complexity with no demo payoff now.

### Program structure

#### D4. Build a custom CLOB instead of integrating Phoenix/OpenBook
- **Context.** The PRD allows either integrating an existing on-chain CLOB or building a minimal one. The
  demo audience is Peak6, a quantitative trading firm.
- **Decision.** Hand-roll a minimal matching engine.
- **Rationale.** An explicit, named bet that a quant evaluator will weight a correct hand-rolled matching
  engine (demonstrating market-microstructure understanding) above a Phoenix integration. "Defensible
  trade-offs documented" is itself a stated success criterion, so the reasoning has value regardless of
  outcome.
- **Trade-offs.** ~1–2 weeks of matching-engine work, a larger combined invariant-testing surface, and the
  risk that matching bugs eat the time needed for settlement/oracle/UX. Hand-rolled matching is also why
  mainnet is out of scope (D22) — unaudited matching on mainnet is a negative signal.
- **Mitigations.** (a) a **day-5 decision gate** (D21) that swaps to a Phoenix-CPI fallback if invariant
  tests aren't passing; (b) hard scope caps on the CLOB.
- **Alternatives rejected.** Phoenix integration — lower risk and audited, but doesn't demonstrate the
  skill the audience is uniquely positioned to evaluate. This is an explicitly *submission-optimized*
  rather than *user-optimized* choice, and the tension is documented in the brainstorm.

#### D5. One Anchor program for CLOB + mint/redeem (not separate programs)
- **Context.** The binary-token system and the order book could be separate programs composed via CPI.
- **Decision.** Put both in a single program with shared state.
- **Rationale.** Enables atomic *Buy No* / *Sell No* as native single-instruction primitives, and lets the
  $1.00 invariant (D14) span minting and trading within one trust boundary.
- **Trade-offs.** **Blast radius** — a single bug can corrupt state across all ~40–50 markets that share
  the code paths.
- **Mitigations.** Devnet-only for the demo; Trident fuzzing across multiple simultaneous markets to catch
  cross-market corruption.
- **Alternatives rejected.** Separate programs with a CPI boundary — would surface invariant bugs earlier
  at the boundary and contain blast radius, but complicates the atomic trade paths and the shared
  invariant. Worth revisiting for mainnet.

#### D6. Pure-Rust matching engine, split from the Anchor program
- **Context.** The matching logic is the highest-value and highest-risk code.
- **Decision.** Implement it as a `matching/` module with zero Solana/Anchor dependencies, wrapped by the
  Anchor instructions.
- **Rationale.** (1) unit tests run in milliseconds with no LiteSVM/BPF startup; (2) `proptest` can run
  10K invariant cases per `cargo test`; (3) a reviewer reads microstructure code cleanly, free of Anchor
  wiring. This is the highest-ROI structural choice in the design.
- **Trade-offs.** A thin translation layer (e.g. `Pubkey` ↔ `[u8; 32]`) between the engine and the Anchor
  wrapper.
- **Alternatives rejected.** Matching logic inline in instruction handlers — would couple the
  fastest-feedback code to the slowest test harness.

#### D7. Per-strike isolation (one Book + mints + escrows per market)
- **Context.** Many strikes trade concurrently each day.
- **Decision.** Every strike gets its own independent Book, Yes/No mints, and escrow PDAs; books never
  share state.
- **Rationale.** A bug or book-stuffing in one strike cannot corrupt another, and Solana processes
  transactions against different markets in parallel (no write-lock contention between strikes).
- **Trade-offs.** More accounts and more rent per market; no cross-strike liquidity.
- **Alternatives rejected.** A unified cross-strike book — more complex, couples strikes, and contends a
  single hot account.

### Matching engine

#### D8. Packed `(price, seq)` order key for price-time priority
- **Context.** Orders must sort by price, then by arrival order (FIFO) within a price level.
- **Decision.** Key each order by `(price, seq)`, conceptually a `u128` with price in the high 64 bits and
  a monotonic sequence number (shared across both sides via `Book.next_seq`) in the low 64 bits.
- **Rationale.** Natural numeric ordering then yields price priority + FIFO for free. (OpenBook v2 pattern.)
  The bid comparator is *price descending, seq ascending* — not a full key reversal, which would reverse
  seq and break FIFO at equal price.
- **Trade-offs.** `price == 0` / `seq == 0` are reserved as invalid sentinels (callers must reject zero),
  so a zeroed slot is distinguishable from a real order.

#### D9. Split the key into two `u64`s (not a single `u128` field)
- **Context.** `BookSide` lives inside a zero-copy `Book` account and must be `bytemuck::Pod` (no padding).
- **Decision.** Store `OrderKey { price: u64, seq: u64 }` instead of one `u128`.
- **Rationale.** A `u128` has 16-byte alignment, which would force 8 bytes of trailing padding on
  `OrderEntry`; `Pod` rejects padding. Two `u64`s keep the struct 8-byte aligned and padding-free while
  preserving identical ordering semantics.
- **Trade-offs.** Comparators are written by hand instead of relying on a single integer compare —
  negligible cost.

#### D10. Fixed-size sorted-array book side, bounded depth N=32
- **Context.** Solana account size is fixed at creation; the book must fit and stay CU-predictable.
- **Decision.** `BookSide<N>` is a fixed-capacity sorted array (binary-search insert, O(N) shift),
  starting at N=32 per side.
- **Rationale.** Bounded depth keeps account size, CU cost, and rent flat across all daily markets and
  keeps the match path allocation-free. For small N a contiguous array beats a tree (cache locality, no
  pointers, trivially `Pod`).
- **Trade-offs.** A heavily-stuffed deep-OTM strike could exhaust a side; depth can't grow after creation.
- **Alternatives rejected.** Red-black tree (OpenBook's choice) — only wins at much larger depth; dynamic
  resizing — explicitly out of scope.

#### D11. Allocation-free match step with CU capping
- **Context.** Matching runs on-chain under a compute-unit budget and a ~4KB stack.
- **Decision.** `match_step` fills into a stack `ArrayVec<Fill, N>`; the per-tx fill count is capped at
  `MAX_FILLS_PER_TX`, and the cap is applied via a `trim_to` / `restore_tail` dance on the book side.
- **Rationale.** No heap allocation on the hot path; partial fills `decrement_front` in place to preserve
  FIFO; the cap bounds CU; `trim_to`/`restore_tail` avoids a stack-allocated stash array that would blow
  the SBPF stack on a 32-deep side.
- **Trade-offs.** A market order against a book deeper than the cap leaves a residual (refunded); a limit
  order posts its residual.

### Settlement & oracle

#### D12. Pyth pull oracle via `PriceUpdateV2`, verified on-chain
- **Context.** Settlement must read a trustworthy underlying price.
- **Decision.** Read a Pyth `PriceUpdateV2` account; validate owner == `config.pyth_receiver`, the account
  discriminator, and (secure-by-default) `VerificationLevel::Full`.
- **Rationale.** Pyth is the standard Solana price oracle with confidence intervals and Wormhole
  verification levels. Pinning the receiver in `Config` lets the same `.so` work on devnet, mainnet, and
  LiteSVM fixtures without a feature flag.
- **Trade-offs.** Requires an off-chain step to post the price account before settle; devnet often only
  has `Partial` updates, so the Full requirement is operator-relaxable.

#### D13. Concurrency via Solana's per-account write lock (no explicit locks)
- **Context.** Cancel-vs-fill and settle-vs-place races must not corrupt state.
- **Decision.** Rely on the runtime guarantee that transactions writing the same account are serialized.
  The `settled` flag lives on `Market` and is read at the entry of every trade instruction.
- **Rationale.** The Book is write-locked during place/match/cancel; settle and place both touch the same
  Market account, so they serialize. `settled = true` and `outcome = Some(_)` are set in one mutation, so
  any reader sees `settled → outcome.is_some()`.
- **Trade-offs.** A single very hot strike serializes all its own traffic (fine for ~40–50 daily binaries).

#### D14. $1.00 invariant baked into the mint mechanism
- **Context.** The product promise is Yes + No = $1.00, always.
- **Decision.** `mint_pair` is the only way pairs come into existence and mints Yes and No in equal amounts
  against exactly that USDC; trading only moves existing tokens; `burn_pair`/`redeem` are the only exits.
- **Rationale.** The only operations that change supply are symmetric by construction, so no trade
  sequence can violate the invariant — it's structural, not a post-hoc check.
- **Trade-offs.** Forces mint/redeem and the CLOB into one program (D5).

#### D15. 30-second post-expiry settlement window
- **Context.** `settle_market` is permissionless; a hostile caller could cherry-pick a favorable update.
- **Decision.** Accept only a Pyth `publish_time` in `[expiry, expiry + 30s]` (lower bound via
  `get_price_no_older_than(max_age = clock - expiry)`, upper bound via an explicit check).
- **Rationale.** Settles the option at its *expiry* price rather than "whenever someone calls settle," and
  bounds any cherry-pick to a 30-second window regardless of call time.
- **Trade-offs.** If no update lands in the window, settlement deadlocks — handled separately by D23, not
  by widening the window (which would weaken manipulation resistance).

#### D16. 1% confidence gate + positive-price + i128 rebase
- **Context.** Pyth prices carry a confidence band and an exponent; strikes are USDC microunits.
- **Decision.** Reject if `conf/price > 1%` (integer-rearranged in u128), require `price > 0`, and rebase
  the Pyth `(price, exponent)` to microunits in i128.
- **Rationale.** Rejects untrustworthily-wide prices; integer math avoids floats; i128 avoids overflow at
  exponent ≈ −8. Strike spacing (≥ $10) dwarfs any feed precision, so the comparison stays well-defined.

### Security & safety

#### D17. PDA-owned escrow & enumerated admin powers (non-custodial)
- **Context.** Settlement must be non-custodial — the product's core trust promise.
- **Decision.** All escrow and mints are PDA-owned with the per-market `mint_authority` PDA as token
  authority; admin powers are enumerated (`create_strike_market`, pause, emergency-settle) and explicitly
  exclude any withdrawal from escrow.
- **Rationale.** Only program logic signing with PDA seeds can move funds; the operator can never abscond
  with collateral.
- **Trade-offs.** PDA-signing ceremony on every CPI (bumps cached on `Market` to keep it cheap).

#### D18. Skip-and-continue (not revert) on un-actionable orders
- **Context.** A single griefer with an unpayable/frozen ATA could block a fill or freeze the settlement
  sweep for everyone if the whole transaction reverted.
- **Decision.** Skip the un-actionable order (frozen ATA, unrefundable maker) and continue; recoverable
  collateral is handled later via a separate admin path after a grace window.
- **Rationale.** Keeps fills and the crank live for honest users; removes a denial-of-service vector.
- **Trade-offs.** Stuck collateral is recovered out-of-band rather than inline; needs a treasury custody
  account (kept distinct from `fee_authority`).

#### D19. Pause kill switch + admin emergency settle (24h grace) + treasury separation
- **Context.** Operational safety: protocol-wide incidents and stuck-oracle liveness deadlocks.
- **Decision.** `set_paused` halts all user-facing instructions; `admin_settle_market` can stamp an outcome
  without the oracle, but only after `expiry + 24h`; recovered funds go to a `treasury` distinct from
  `fee_authority`.
- **Rationale.** Normal oracle settlement always gets first claim (24h grace); the emergency path is
  solvent by the $1 invariant; separating treasury keeps custodial user funds accounting-separate from
  protocol revenue.
- **Trade-offs.** Adds privileged surface — bounded by the grace delay and the no-withdrawal rule (D17).

#### D20. `burn_pair` primitive for a symmetric Sell No exit
- **Context.** Sell No could leave the user's capital locked until settlement.
- **Decision.** Add `burn_pair` (the inverse of `mint_pair`): burn equal Yes + No, return $1 USDC.
- **Rationale.** Lets Sell No buy a Yes from the book and immediately burn the Yes+No pair for USDC in the
  same transaction — capital returns now, mirroring Sell Yes.
- **Trade-offs.** One more primitive to test, but it closes the capital-lock UX gap.

### Scope & process

#### D21. Day-5 decision gate → Phoenix-CPI fallback
- **Decision.** If `place_limit_order` + partial fills + `cancel_order` weren't passing invariant tests by
  end of day 5, swap the matching layer to Phoenix via CPI and keep mint/redeem/settle.
- **Rationale.** Converts the build-own bet (D4) into a reversible commitment with a hard checkpoint.
- **Trade-offs.** Carrying a dormant contingency unit (U10) in the plan.

#### D22. Devnet only for the demo
- **Decision.** Target Solana devnet; do not deploy to mainnet.
- **Rationale.** A downstream consequence of D4 — unaudited hand-rolled matching on mainnet is a negative
  signal, not a feature.

#### D23. Market-order-only Buy No (drop limit Buy No)
- **Decision.** Ship Buy No as a market order only.
- **Rationale.** A limit Buy No introduces transient Yes+No state on cancel and contradicts the
  position-constraint model; dropping it removes a whole bug class without losing the four-trade-path
  signal.

#### D24. Position constraints enforced in the frontend only
- **Decision.** "No Buy Yes while holding No" (and vice-versa) is enforced client-side, reading fresh
  balances at action time; on-chain enforcement is deferred.
- **Rationale.** Matches the PRD's placement; on-chain enforcement would need Token-2022 transfer hooks
  (D3). A malicious client could bypass it — acceptable for a devnet demo, flagged for a hardening pass.

#### D25. Three-layer test ladder
- **Decision.** proptest (engine invariants) + LiteSVM (instruction-level CPI flows and races) + Trident
  (multi-instruction fuzz across markets).
- **Rationale.** Each layer catches a distinct failure class; bugs are caught at the cheapest layer that
  can reach them.

---

## 6. Invariants enforced

- **$1.00 invariant** — `yes_supply == no_supply`; escrowed USDC backs every outstanding pair.
- **Escrow reconciliation (R13)** — `usdc_escrow == Σ open-bid notional`; `yes_escrow == Σ open-ask qty`.
- **Conservation** — total USDC across wallets + escrows + vault is constant.
- **Match conservation** — `Σ fill_qty + residual_qty == taker_qty`; every fill respects the taker limit.
- **Settlement atomicity** — `settled → outcome.is_some()` for any reader.
- **Price-time priority** — no resting order is ever out of (price, then FIFO) order.

---

## 7. Known limitations (and the mainnet path)

| Limitation | Status / path forward |
|---|---|
| On-chain position constraints absent | frontend-only today; Token-2022 transfer hook for on-chain enforcement |
| Single-program blast radius | acceptable on devnet; CPI boundary between programs for mainnet |
| Hand-rolled matching unaudited | the reason mainnet is out of scope; audit required before mainnet |
| Fixed book depth | book-stuffing could exhaust a side; dynamic sizing or anti-stuffing fees for production |
| No advanced order types / fees | out of scope by design (IOC/FOK/post-only, maker rebates) |
