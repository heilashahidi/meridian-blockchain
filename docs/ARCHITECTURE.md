# Meridian — Architecture, Trade-offs, and Known Limitations

This document explains how Meridian is built and why, with the trade-offs called
out honestly. It is the companion to the [README](../README.md) (setup + tests)
and the [devnet runbook](DEVNET-RUNBOOK.md) (operate it end-to-end). The
first half is the full-system narrative (frontend + automation + oracle + the
on-chain CLOB); the second half is the program-level reference — account model,
instruction surface, invariants, and the D1–D25 decision log that records the
rationale behind every significant on-chain choice.

Meridian is a non-custodial binary-options dApp: per-stock daily "will [TICKER]
close at/above [STRIKE]?" markets. A `mint_pair` deposit of `$N` USDC mints `N`
Yes + `N` No tokens; after settlement the winning side redeems 1:1 for USDC. The
core invariant is **one Yes + one No always costs exactly $1** — escrow stays
solvent (`usdc_escrow == winning_supply`) no matter which side wins.

### System context

The on-chain program is the trust root of a four-component system. Only the
program must be trustless; the other three are operated off-chain.

```
        ┌────────────────────┐         fetches Hermes price,
        │  Off-chain          │◄───────  posts PriceUpdateV2 via Pyth receiver
        │  automation service │
        │  (TypeScript/Node)  │
        └─────────┬───────────┘
   morning job:   │   after-close job:
   create strike  │   settle_market + settle_sweep
   markets        │   (oracle retry → admin-override fallback)
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
| **Automation service** | morning strike creation, after-close settlement, retries, admin-override fallback | availability concern, not a trust concern → cheap restartable jobs |
| **Oracle (Pyth pull)** | off-chain Hermes fetch posts a `PriceUpdateV2` account before `settle_market` | price provenance is verified on-chain; fetch is just transport |
| **Frontend** | turns the CLOB into a "simple directional bet"; enforces position constraints client-side | UX, not custody |

---

## 1. The matching engine: build an on-chain CLOB

The defining decision is that Meridian runs a **central limit order book on
chain**, inside the program, rather than an AMM or an off-chain book with
on-chain settlement. (See decision log D4–D11 for the per-choice rationale.)

### Why a CLOB, not an AMM

Binary outcome tokens have a hard price ceiling and floor (`$0 ≤ Yes ≤ $1`,
`No = 1 − Yes`). An AMM (constant-product or LMSR-style) would force a bonding
curve and continuous liquidity provision onto a market that is naturally a
limit-order market: traders want to say "I'll buy 100 Yes at $0.62", and the
counterparty is whoever posted the matching ask. A CLOB expresses that directly,
gives true price discovery (the book *is* the implied probability), and makes the
$1 invariant trivial to enforce per-fill. The cost is that we have to implement
matching ourselves.

### Why on-chain, not off-chain matching

An off-chain matching engine (the typical "fast book, settle on chain" design)
would be cheaper and faster, but it reintroduces a trusted operator: someone
off-chain decides which orders cross and at what price. That breaks the
non-custodial, trustless promise — the whole point of putting a prediction market
on Solana. So matching runs in the program: an order either crosses the resting
book deterministically on chain, or it rests. No operator can front-run or
reorder fills beyond what Solana's own transaction ordering allows.

### Why build instead of integrating Phoenix/OpenBook

This is an explicit, named bet (D4): a quant evaluator weights a correct
hand-rolled matching engine — demonstrating market-microstructure understanding —
above a Phoenix integration, and "defensible trade-offs documented" is itself a
success criterion. The cost is ~1–2 weeks of engine work and a larger invariant
surface; it is also why mainnet is out of scope (unaudited matching on mainnet is
a negative signal, D22). The bet was made reversible by a day-5 decision gate
(D21) that would have swapped to a Phoenix CPI fallback if invariant tests
weren't passing.

### The engine design

The matching engine is a **pure-Rust module** (`programs/meridian/src/matching/`)
with no Anchor or Solana dependencies (D6), so it is unit-testable in plain
`cargo test` (and proptest-fuzzed) without a validator. It follows OpenBook v2's
packed-key + fixed-array split:

- **`order_key.rs`** — `(price, seq)` packed so natural integer ordering gives
  price priority **and** FIFO-within-price for free (D8). Stored as two `u64`s
  (`OrderKey { price, seq }`) rather than one `u128`, because a `u128`'s 16-byte
  alignment would force trailing padding that `bytemuck::Pod` rejects (D9). The
  bid comparator is *price descending, seq ascending* — not a full key reversal,
  which would reverse seq and break FIFO at equal price. `price == 0` / `seq == 0`
  are reserved invalid sentinels so a zeroed slot is distinguishable from a real
  order.
- **`book_side.rs`** — a fixed-depth `BookSide<N>` (N = `BOOK_DEPTH` = 32) holding
  a sorted array of `OrderEntry { key, owner: [u8;32], qty }` (56 bytes each).
  Bids sort descending by price, asks ascending; binary-search insert (O(log N)
  compare + O(N) shift), `cancel_by_id` in O(N) shift. Fixed depth (D10) means the
  `Book` account is a fixed size (zero-copy) — no reallocation, no unbounded rent,
  flat CU. For small N a contiguous array beats a tree (cache locality, no
  pointers, trivially `Pod`); the trade-off is that a heavily-stuffed deep-OTM
  strike can exhaust a side, and depth can't grow after creation.
- **`match_step.rs`** — taker matching against one side, filling into a
  stack-allocated `ArrayVec<Fill, N>` (no heap allocation in the match path, D11).
  Partial fills `decrement_front` in place to preserve FIFO. The per-tx fill count
  is capped at `MAX_FILLS_PER_TX = 4`, applied by a `trim_to` / `restore_tail`
  dance on the book side rather than a stack-allocated stash array that would blow
  the ~4KB SBPF stack on a 32-deep side. A market order against a book deeper than
  the cap leaves a refunded residual; a limit order posts its residual.

The on-chain `Book` account is **zero-copy** (`bids: BookSide<32>`,
`asks: BookSide<32>`). That keeps it a fixed size (3,640 bytes of data + 8-byte
discriminator = 3,648 bytes, well under the 10KB init limit; a `const _` assertion
pins the size so any layout bloat fails the build) and avoids per-order account
creation, but it has a direct consequence for every off-chain client — see the
IDL-patch workaround below.

The book stores a **single set of Yes-priced orders**. The Trade UI renders that
one book from both the Yes and the No perspective (`No price = $1 − Yes price`);
there is no separate "No book." See §5.

---

## 2. The IDL-patch workaround

**Problem.** The program deliberately keeps its matching-engine types
(`OrderKey`, `OrderEntry`, `BookSide`) out of the generated Anchor IDL — they are
internal plumbing and implement `IdlBuild` as empty stubs. But the `Book` account
references `BookSide<32>`. So when any JS/TS client calls
`new Program(idl, provider)`, Anchor tries to resolve the `Book` account's `bids`
field type, can't find it, and throws **`Type not found: bids`** — which breaks
the entire client, not just book reads. (Anchor's TS coder ≤0.32.1 also can't
handle the `BookSide<32>` const generic.)

**Fix.** Patch the IDL **in memory** at client construction. The committed
`target/idl/meridian.json` stays pristine (so re-copying it after a program
change is always safe). There are two flavors of the patch in the repo, by need:

- **Frontend / automation (`app/src/lib/idlPatch.ts`,
  `automation/src/client.ts`):** re-add the three missing types with their exact
  `#[repr(C)]` layout — `OrderKey = { price: u64, seq: u64 }`,
  `OrderEntry = { key, owner: [u8;32], qty: u64 }`,
  `BookSide32 = { len: u64, entries: [OrderEntry; 32] }` — and rewrite the
  `Book.bids`/`Book.asks` field types from the generic `BookSide<32>` to the
  concrete `BookSide32`. This lets the client actually **decode** the book.
- **Scripts that never read the book
  (`scripts/bootstrap-devnet.mjs`, `lifecycle-demo.mjs`, `post-pyth-update.mjs`):**
  simply **strip** the `Book` account/type from the IDL before constructing the
  program. They don't decode the book, so stripping is enough to dodge the
  `Type not found` throw.

The layout in `idlPatch.ts` and `client.ts` **must stay in sync** with
`programs/meridian/src/matching/{book_side,order_key}.rs`. If the on-chain layout
changes, update both patches.

---

## 3. Settlement: real Pyth pull-oracle, with an admin-override fallback

Settlement reads a real **Pyth pull-oracle** price on devnet, and falls back to an
admin override when the oracle can't deliver. (Decision log D12–D16, D19.)

### The pull-oracle flow

Pyth's pull model means nobody is continuously pushing equity prices on chain.
To settle a market (`scripts/post-pyth-update.mjs`, and the
`automation/src/jobs/settle.ts` job):

1. Fetch the latest update for the market's `pyth_feed_id` from **Hermes**
   (`@pythnetwork/hermes-client`).
2. Post it on chain via the canonical **Pyth Solana receiver**
   (`@pythnetwork/pyth-solana-receiver`), creating a receiver-owned
   `PriceUpdateV2` account.
3. Call `settle_market`, referencing that account. The program validates the
   account's owner equals `Config.pyth_receiver`
   (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` on devnet), Borsh-decodes the
   Wormhole-verified price, checks freshness + confidence + feed-id, rebases the
   price to USDC microunits, and stamps `outcome = YesWins` iff
   `pyth_price >= strike_price`.

Pinning the receiver address in `Config` (rather than a feature flag) lets the
same `.so` run on devnet, mainnet, and LiteSVM fixtures unchanged (D12).

`settle_market` is **permissionless** (anyone can call). The oracle + the expiry
timestamp are the gate, not an admin check; Solana's per-account write lock makes
the settled-flag flip atomic (D13). A secure-by-default verification gate
(`Config.require_full_verification`, `true` at init) requires a fully
Wormhole-verified price; an operator can relax it to accept `Partial` updates,
which are common on devnet (`set_require_full_verification`).

### The settle-window reconciliation: 30s → 900s

Originally `settle_market` pinned the settlement price to a **30-second** window
`[expiry, expiry + 30s]` — demo-shaped: it assumed settlement happened
essentially at the instant of expiry. Real pull-oracle settlement does not. After
a 4PM ET expiry an operator (or the settle job) must fetch from Hermes, post the
receiver update, then call `settle_market` — a round trip that, with
retry/backoff on transient failures, routinely lands **minutes** after expiry,
outside the 30s window, failing `OracleStale`.

U2 reconciled this by **widening the window to 900s (15 minutes)**:
`SETTLE_WINDOW_SECONDS = 900` in
`programs/meridian/src/instructions/settle_market.rs`. The choice was deliberately
a **compile-time module constant, not a `Config`/`Market` field**:

- Widening the window must **not change any account layout** (a layout change is
  out of scope — see §7). A `const` keeps every on-chain account stable.
- Bumping it is a code change + redeploy, which is acceptable because
  `settle_market` is the most safety-critical instruction: a layout-free constant
  keeps the change auditable and the change history in source control.

The trade-off in the *value*: narrower is safer against settlement manipulation
(it bounds how far a permissionless caller can cherry-pick a favorable Pyth update
to the window width) but raises the liveness risk that no update lands in time.
Wider drifts settlement away from the true expiry price. 15 minutes balances the
two: equity prices don't move far in 15 minutes of regular-session trading, and it
comfortably absorbs the post-and-settle latency plus a few retries. The lower
bound (`publish_time >= expiry`) and the confidence check (`conf/price ≤ 1%`,
`MAX_CONF_BPS = 100`, plus the `price > 0` requirement and the i128 rebase that
avoids overflow at exponent ≈ −8, D16) are unchanged — only the upper bound
widened.

This change is proven by the LiteSVM suite
(`tests/litesvm/tests/u7_settle_redeem.rs`): a price published minutes after
expiry but inside the window settles; one outside is rejected.

### The admin-override fallback

If the oracle never posts an update inside the window — most commonly because
equity feeds are stale off-hours (see §4) — the market would be stuck forever and
its escrowed USDC stranded. `admin_settle_market(yes_wins: bool)`
(`programs/meridian/src/instructions/admin.rs`) is the documented escape hatch
(D19):

- **Admin-only** (`has_one = admin` against the singleton Config).
- Unlocks only after `expiry + EMERGENCY_GRACE_SECONDS` (**24h**,
  `EMERGENCY_GRACE_SECONDS = 86_400`), so normal permissionless settlement always
  gets first claim during the day.
- Stamps the outcome by hand via the same atomic `settled + outcome` write;
  `redeem` then works unchanged. The $1 invariant keeps escrow solvent regardless
  of which side the admin picks.

This is PRD-sanctioned ("Admin Settle (Override)"). The settle job
(`automation/src/jobs/settle.ts`) retries the oracle path within an override
grace (default ~15min) and then calls `admin_settle_market` with an
operator-supplied price (`OVERRIDE_PRICES=TICKER=price,...`), alerting on the
fallback. Note that on-chain the override *also* requires the 24h emergency
grace; if that hasn't elapsed the override reverts and the job alerts.

---

## 4. The market-hours / oracle limitation

Pyth's MAG7 equity feeds (`Equity.US.<TICKER>/USD`, regular session) are **only
fresh during US regular trading hours: 9:30AM–4PM ET, weekdays**. Off-hours the
latest Hermes update is the last RTH tick — its `publish_time` is far outside any
post-expiry settlement window, so `settle_market` rejects it as `OracleStale`.

Consequences, documented honestly:

- **Live UI prices** (`app/src/lib/prices.ts`, the `usePrices` hook) keep polling
  Hermes off-hours; the call still succeeds but `publishTime` goes stale. The UI
  surfaces staleness ("live" / "Nm ago") rather than throwing.
- **Real on-chain settlement only works during RTH.** Settling a 4PM-expiry
  market with the live oracle must happen between ~4:00 and ~4:15PM ET (the 900s
  window) on a weekday. `post-pyth-update.mjs` pre-checks the Hermes
  `publish_time` against the window and exits with a clear "fall back to admin
  override" message when off-hours.
- **Off-hours / weekends**, settlement uses the admin-override path (§3) after
  the 24h grace.

Meridian supports the **regular session only** — no pre/post-market or overnight
equity sessions (§7).

### Hermes API-key transition

The public `hermes.pyth.network` endpoint is moving to an API-key model
(mid-2026). The endpoint is **env-configurable everywhere**
(`NEXT_PUBLIC_HERMES_URL` in the app, `HERMES_URL` in automation, `--hermes-url` /
`--hermes-token` in the script), and the clients accept an optional access token.
Treat the key as a future dependency.

---

## 5. The four trade paths and the both-perspective book

The PRD specifies four user actions — Buy Yes, Sell Yes, Buy No, Sell No — each a
**single wallet approval**. They map to on-chain instructions in
`app/src/lib/tradePaths.ts` (built test-first; the price math is the error-prone
core). The book stores **Yes prices only** (USDC microunits per Yes base unit,
`0..1_000_000` ↔ `$0.00..$1.00`); No is the reflection `No = $1 − Yes`.

| UI action | Instruction | Side (vs Yes book) | Price |
|---|---|---|---|
| **Buy Yes** | `place_limit_order` / `place_market_order` | Bid | Yes price (max paid) |
| **Sell Yes** | `place_limit_order` / `place_market_order` | Ask | Yes price (min taken) |
| **Buy No** | `buy_no` (atomic: `mint_pair`, then market-**sell** the Yes leg) | Yes leg is an Ask taker | `min_yes_sell_price = $1 − noPrice` |
| **Sell No** | `sell_no` (atomic: market-**buy** the Yes leg, then `burn_pair`) | Yes leg is a Bid taker | `max_yes_buy_price = $1 − noPrice` |

Both No paths use the **same price reflection** `yesLeg = $1 − noPrice`; only the
inequality direction differs (Buy No: a `>=` floor on the Yes sell; Sell No: a
`<=` cap on the Yes buy), which is exactly the Ask-vs-Bid side of the internal Yes
leg. `buy_no`/`sell_no` are single atomic instructions, so each is one approval —
the user never has to manually mint-then-sell. The `burn_pair` primitive (D20) is
what lets Sell No return capital immediately — buy a Yes from the book and burn
the Yes+No pair for USDC in one tx, mirroring Sell Yes — instead of locking it
until settlement. Buy No ships as a **market order only** (D23): a limit Buy No
would introduce transient Yes+No state on cancel and contradict the
position-constraint model, so dropping it removes a bug class without losing the
four-path signal.

**Both-perspective book.** `BothSidesBook` renders the single Yes book as two
views. A resting Yes **bid** is a No **ask** at `$1 − price`; a resting Yes **ask**
is a No **bid** at `$1 − price` (`toNoView` in `tradePaths.ts`). Because `1 − p`
is monotonically decreasing, reflecting price preserves price-priority ordering,
so the No view's best-first ordering comes out correct for free.

---

## 6. Position constraints enforced in the UI

PRD §142–144: trading must not leave a user holding **both** Yes and No (that's an
arbitrage-neutral $1 lockup, only sensible transiently mid-`mint_pair`). This is
enforced **client-side**, not on chain (D24):

- It's a UX guardrail, not a solvency invariant. The program is a generic CLOB;
  forcing this on chain would add state and rejection paths for no economic gain,
  and the natural on-chain mechanism — Token-2022 transfer hooks — was ruled out
  by the classic-SPL choice (D3).
- `positionGuardDecision(balances)` in `tradePaths.ts` is a pure function reading
  fresh balances at action time: holding No blocks Buy Yes ("sell No first");
  holding Yes blocks Buy No ("sell Yes first"); holding both (transient) blocks new
  entries but still allows Sell Yes / Sell No so a user can always unwind a leg;
  sell actions require a balance on that side. `PositionGuard` consumes it to gate
  the Trade panel.

The trade-off: a user *can* still end up holding both by minting a pair directly,
or by using a raw RPC call. The UI guides the normal flow; it does not (and need
not) make the dual-hold state impossible on chain. Flagged for a hardening pass if
on-chain enforcement is ever pursued.

---

## 7. On-chain program internals

The narrative above covers *why*; this section is the *what* — the account model,
the instruction surface, and the invariants the program enforces. It is the
reference the decision log (§8) annotates.

### Account model

Solana programs are stateless; all state lives in program-owned accounts addressed
by **PDAs** (Program Derived Addresses — deterministic, keyless, controlled only
by program logic).

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

- **`Config`** is a singleton (`["config"]`); the first `initialize_config` caller
  becomes admin.
- **`Market`** is small (<200 bytes), standard Borsh. Strike and expiry are encoded
  in the PDA seed, so `(ticker, strike, expiry)` is unique and a market cannot be
  created twice.
- **`Book`** is the only zero-copy account: `OrderEntry` = 56 bytes,
  `BookSide<32>` = 1,800 bytes, whole `Book` = **3,640 bytes data + 8-byte
  discriminator = 3,648 bytes** (well under the 10KB init limit). A `const _`
  assertion pins the size so a field that bloats it fails the build.
- **One `mint_authority` PDA per market** signs every value-moving CPI (mint
  Yes/No, release USDC, pay makers), with bumps cached on `Market` to keep
  signing cheap (D17). No keypair anywhere can move funds.
- **Per-strike isolation** (D7): every strike gets its own Book, mints, and
  escrows; books never share state, so a bug in one strike can't corrupt another
  and Solana processes different markets in parallel.

### Instruction surface

15 instructions in `lib.rs`:

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

### Invariants enforced

- **$1.00 invariant** — `yes_supply == no_supply`; escrowed USDC backs every
  outstanding pair. Structural, not a post-hoc check: `mint_pair` is the only way
  pairs come into existence (equal amounts against exactly that USDC), trading only
  moves existing tokens, and `burn_pair`/`redeem` are the only exits, so no trade
  sequence can violate it (D14).
- **Escrow reconciliation (R13)** — `usdc_escrow == Σ open-bid notional`;
  `yes_escrow == Σ open-ask qty`.
- **Conservation** — total USDC across wallets + escrows + vault is constant.
- **Match conservation** — `Σ fill_qty + residual_qty == taker_qty`; every fill
  respects the taker limit.
- **Settlement atomicity** — `settled → outcome.is_some()` for any reader (the flag
  and the outcome are set in one mutation, serialized by the per-account write
  lock, D13).
- **Price-time priority** — no resting order is ever out of (price, then FIFO)
  order.

The skip-and-continue policy (D18) keeps these live under adversarial conditions:
a fill or the settlement sweep skips an un-actionable order (frozen ATA,
unrefundable maker) and continues rather than reverting the whole transaction, so
one griefer can't deny service; stuck collateral is recovered out-of-band via an
admin path after a grace window, into a `treasury` kept distinct from
`fee_authority`.

---

## 8. Decision log

Each significant on-chain decision, recorded as **Context → Decision → Rationale →
Trade-offs → Alternatives**. Decisions that also have a full narrative treatment
above are cross-referenced rather than re-argued in depth.

### Chain & framework

#### D1. Solana as the settlement chain
- **Context.** A binary-options venue creating tens of markets/day with frequent
  order placement and cancellation needs cheap, fast transactions and a state
  model that supports many independent books.
- **Decision.** Build on Solana.
- **Rationale.** High throughput and sub-cent fees suit high-frequency order flow;
  the account model lets each strike be an isolated set of accounts; and Solana's
  per-account write lock gives correct serialization of same-market operations
  *for free* (see D13).
- **Trade-offs.** Solana's account-size limits and the ~4KB SBPF stack budget
  constrain data-structure design (drove the fixed-depth book and the zero-copy
  layout). Rust/Anchor has a steeper learning curve than Solidity.
- **Alternatives rejected.** EVM L1/L2 — higher fees and lower throughput for
  order-book churn, and no equivalent of free per-account serialization.

#### D2. Anchor 1.0 framework
- **Context.** The program needs PDA management, CPI to SPL Token, account
  validation, and a zero-copy account for the book.
- **Decision.** Use Anchor 1.0.0.
- **Rationale.** `AccountLoader`/`LazyAccount` for zero-copy, a cleaner CPI
  builder, and strong account validation macros reduce boilerplate and a whole
  class of validation bugs.
- **Trade-offs.** Anchor 1.0 is new (April 2026), so there's some bleeding-edge
  risk.
- **Mitigation.** Pinned the exact version; kept the mature 0.31 line in mind as a
  fallback if a 1.0-specific bug blocked progress.

#### D3. Classic SPL Token (not Token-2022)
- **Context.** Yes/No mints and the USDC quote asset need a token standard.
- **Decision.** Use classic SPL Token.
- **Rationale.** Devnet USDC is classic SPL; matching the quote asset simplifies
  wiring; no Token-2022 extension is needed for the demo's feature set.
- **Trade-offs.** No transfer hooks, so on-chain position constraints (D24) can't
  be enforced at the token layer today.
- **Alternatives rejected.** Token-2022 — its transfer-hook extension is the
  natural mechanism if on-chain position-constraint enforcement is pursued
  post-demo, but it adds complexity with no demo payoff now.

### Program structure

#### D4. Build a custom CLOB instead of integrating Phoenix/OpenBook
- **Context.** The PRD allows either integrating an existing on-chain CLOB or
  building a minimal one. The demo audience is a quantitative trading firm.
- **Decision.** Hand-roll a minimal matching engine. (Full rationale in §1.)
- **Rationale.** An explicit bet that a quant evaluator weights a correct
  hand-rolled engine above a Phoenix integration; "defensible trade-offs
  documented" is itself a success criterion.
- **Trade-offs.** ~1–2 weeks of matching-engine work, a larger invariant surface,
  and the risk that matching bugs eat settlement/oracle/UX time. Also why mainnet
  is out of scope (D22).
- **Mitigations.** (a) the day-5 decision gate (D21); (b) hard scope caps on the
  CLOB.
- **Alternatives rejected.** Phoenix integration — lower risk and audited, but
  doesn't demonstrate the skill the audience is positioned to evaluate. An
  explicitly *submission-optimized* rather than *user-optimized* choice.

#### D5. One Anchor program for CLOB + mint/redeem (not separate programs)
- **Context.** The binary-token system and the order book could be separate
  programs composed via CPI.
- **Decision.** Put both in a single program with shared state.
- **Rationale.** Enables atomic *Buy No* / *Sell No* as native single-instruction
  primitives, and lets the $1.00 invariant (D14) span minting and trading within
  one trust boundary.
- **Trade-offs.** **Blast radius** — a single bug can corrupt state across all
  markets that share the code paths.
- **Mitigations.** Devnet-only for the demo; Trident fuzzing across multiple
  simultaneous markets to catch cross-market corruption.
- **Alternatives rejected.** Separate programs with a CPI boundary — would surface
  invariant bugs earlier at the boundary and contain blast radius, but complicates
  the atomic trade paths and the shared invariant. Worth revisiting for mainnet.

#### D6. Pure-Rust matching engine, split from the Anchor program
- **Context.** The matching logic is the highest-value and highest-risk code.
- **Decision.** Implement it as a `matching/` module with zero Solana/Anchor
  dependencies, wrapped by the Anchor instructions.
- **Rationale.** (1) unit tests run in milliseconds with no LiteSVM/BPF startup;
  (2) `proptest` can run 10K invariant cases per `cargo test`; (3) a reviewer reads
  microstructure code cleanly, free of Anchor wiring. The highest-ROI structural
  choice in the design.
- **Trade-offs.** A thin translation layer (e.g. `Pubkey` ↔ `[u8; 32]`) between the
  engine and the Anchor wrapper.
- **Alternatives rejected.** Matching logic inline in instruction handlers — would
  couple the fastest-feedback code to the slowest test harness.

#### D7. Per-strike isolation (one Book + mints + escrows per market)
- **Context.** Many strikes trade concurrently each day.
- **Decision.** Every strike gets its own independent Book, Yes/No mints, and
  escrow PDAs; books never share state.
- **Rationale.** A bug or book-stuffing in one strike cannot corrupt another, and
  Solana processes transactions against different markets in parallel (no
  write-lock contention between strikes).
- **Trade-offs.** More accounts and more rent per market; no cross-strike
  liquidity.
- **Alternatives rejected.** A unified cross-strike book — more complex, couples
  strikes, and contends a single hot account.

### Matching engine

#### D8. Packed `(price, seq)` order key for price-time priority
- **Context.** Orders must sort by price, then by arrival order (FIFO) within a
  price level.
- **Decision.** Key each order by `(price, seq)`, conceptually a `u128` with price
  in the high 64 bits and a monotonic sequence number (shared across both sides via
  `Book.next_seq`) in the low 64 bits.
- **Rationale.** Natural numeric ordering then yields price priority + FIFO for
  free (OpenBook v2 pattern). The bid comparator is *price descending, seq
  ascending* — not a full key reversal, which would reverse seq and break FIFO at
  equal price.
- **Trade-offs.** `price == 0` / `seq == 0` are reserved invalid sentinels (callers
  must reject zero), so a zeroed slot is distinguishable from a real order.

#### D9. Split the key into two `u64`s (not a single `u128` field)
- **Context.** `BookSide` lives inside a zero-copy `Book` account and must be
  `bytemuck::Pod` (no padding).
- **Decision.** Store `OrderKey { price: u64, seq: u64 }` instead of one `u128`.
- **Rationale.** A `u128` has 16-byte alignment, which would force 8 bytes of
  trailing padding on `OrderEntry`; `Pod` rejects padding. Two `u64`s keep the
  struct 8-byte aligned and padding-free while preserving identical ordering
  semantics.
- **Trade-offs.** Comparators are written by hand instead of relying on a single
  integer compare — negligible cost.

#### D10. Fixed-size sorted-array book side, bounded depth N=32
- **Context.** Solana account size is fixed at creation; the book must fit and stay
  CU-predictable.
- **Decision.** `BookSide<N>` is a fixed-capacity sorted array (binary-search
  insert, O(N) shift), starting at N=32 per side (`BOOK_DEPTH = 32`).
- **Rationale.** Bounded depth keeps account size, CU cost, and rent flat across
  all daily markets and keeps the match path allocation-free. For small N a
  contiguous array beats a tree (cache locality, no pointers, trivially `Pod`).
- **Trade-offs.** A heavily-stuffed deep-OTM strike could exhaust a side; depth
  can't grow after creation.
- **Alternatives rejected.** Red-black tree (OpenBook's choice) — only wins at much
  larger depth; dynamic resizing — explicitly out of scope.

#### D11. Allocation-free match step with CU capping
- **Context.** Matching runs on-chain under a compute-unit budget and a ~4KB stack.
- **Decision.** `match_step` fills into a stack `ArrayVec<Fill, N>`; the per-tx fill
  count is capped at `MAX_FILLS_PER_TX = 4`, and the cap is applied via a `trim_to`
  / `restore_tail` dance on the book side.
- **Rationale.** No heap allocation on the hot path; partial fills `decrement_front`
  in place to preserve FIFO; the cap bounds CU; `trim_to`/`restore_tail` avoids a
  stack-allocated stash array that would blow the SBPF stack on a 32-deep side.
- **Trade-offs.** A market order against a book deeper than the cap leaves a
  residual (refunded); a limit order posts its residual.

### Settlement & oracle

#### D12. Pyth pull oracle via `PriceUpdateV2`, verified on-chain
- **Context.** Settlement must read a trustworthy underlying price.
- **Decision.** Read a Pyth `PriceUpdateV2` account; validate owner ==
  `config.pyth_receiver`, the account discriminator, and (secure-by-default)
  `VerificationLevel::Full`. (Full flow in §3.)
- **Rationale.** Pyth is the standard Solana price oracle with confidence intervals
  and Wormhole verification levels. Pinning the receiver in `Config` lets the same
  `.so` work on devnet, mainnet, and LiteSVM fixtures without a feature flag.
- **Trade-offs.** Requires an off-chain step to post the price account before
  settle; devnet often only has `Partial` updates, so the Full requirement is
  operator-relaxable.

#### D13. Concurrency via Solana's per-account write lock (no explicit locks)
- **Context.** Cancel-vs-fill and settle-vs-place races must not corrupt state.
- **Decision.** Rely on the runtime guarantee that transactions writing the same
  account are serialized. The `settled` flag lives on `Market` and is read at the
  entry of every trade instruction.
- **Rationale.** The Book is write-locked during place/match/cancel; settle and
  place both touch the same Market account, so they serialize. `settled = true` and
  `outcome = Some(_)` are set in one mutation, so any reader sees
  `settled → outcome.is_some()`.
- **Trade-offs.** A single very hot strike serializes all its own traffic (fine for
  tens of daily binaries).

#### D14. $1.00 invariant baked into the mint mechanism
- **Context.** The product promise is Yes + No = $1.00, always.
- **Decision.** `mint_pair` is the only way pairs come into existence and mints Yes
  and No in equal amounts against exactly that USDC; trading only moves existing
  tokens; `burn_pair`/`redeem` are the only exits.
- **Rationale.** The only operations that change supply are symmetric by
  construction, so no trade sequence can violate the invariant — it's structural,
  not a post-hoc check.
- **Trade-offs.** Forces mint/redeem and the CLOB into one program (D5).

#### D15. Post-expiry settlement window (now 900s / 15min, was 30s)
- **Context.** `settle_market` is permissionless; a hostile caller could
  cherry-pick a favorable update. The original 30s window assumed settlement at the
  instant of expiry, which real pull-oracle settlement can't hit.
- **Decision.** Accept only a Pyth `publish_time` in
  `[expiry, expiry + SETTLE_WINDOW_SECONDS]` with `SETTLE_WINDOW_SECONDS = 900`
  (15 minutes) — a compile-time module constant, not an account field. (Full
  reconciliation rationale in §3.)
- **Rationale.** Settles the option at its *expiry* price rather than "whenever
  someone calls settle," and bounds any cherry-pick to the window width regardless
  of call time. 15 minutes absorbs the real Hermes-fetch → post-receiver →
  `settle_market` round trip plus retries, which routinely lands minutes after
  expiry; equity prices don't move far in 15 minutes of regular-session trading.
  Keeping it a `const` means widening it never touches an account layout.
- **Trade-offs.** Narrower is safer against manipulation but riskier for liveness;
  wider drifts from the true expiry price. If no update lands in the window,
  settlement deadlocks — handled by the admin override (D19), not by widening
  further.

#### D16. 1% confidence gate + positive-price + i128 rebase
- **Context.** Pyth prices carry a confidence band and an exponent; strikes are
  USDC microunits.
- **Decision.** Reject if `conf/price > 1%` (`MAX_CONF_BPS = 100`, integer-rearranged
  in u128), require `price > 0`, and rebase the Pyth `(price, exponent)` to
  microunits in i128.
- **Rationale.** Rejects untrustworthily-wide prices; integer math avoids floats;
  i128 avoids overflow at exponent ≈ −8. Strike spacing (≥ $10) dwarfs any feed
  precision, so the comparison stays well-defined.

### Security & safety

#### D17. PDA-owned escrow & enumerated admin powers (non-custodial)
- **Context.** Settlement must be non-custodial — the product's core trust promise.
- **Decision.** All escrow and mints are PDA-owned with the per-market
  `mint_authority` PDA as token authority; admin powers are enumerated
  (`create_strike_market`, pause, emergency-settle) and explicitly exclude any
  withdrawal from escrow.
- **Rationale.** Only program logic signing with PDA seeds can move funds; the
  operator can never abscond with collateral.
- **Trade-offs.** PDA-signing ceremony on every CPI (bumps cached on `Market` to
  keep it cheap).

#### D18. Skip-and-continue (not revert) on un-actionable orders
- **Context.** A single griefer with an unpayable/frozen ATA could block a fill or
  freeze the settlement sweep for everyone if the whole transaction reverted.
- **Decision.** Skip the un-actionable order (frozen ATA, unrefundable maker) and
  continue; recoverable collateral is handled later via a separate admin path after
  a grace window.
- **Rationale.** Keeps fills and the crank live for honest users; removes a
  denial-of-service vector.
- **Trade-offs.** Stuck collateral is recovered out-of-band rather than inline;
  needs a treasury custody account (kept distinct from `fee_authority`).

#### D19. Pause kill switch + admin emergency settle (24h grace) + treasury separation
- **Context.** Operational safety: protocol-wide incidents and stuck-oracle
  liveness deadlocks.
- **Decision.** `set_paused` halts all user-facing instructions;
  `admin_settle_market` can stamp an outcome without the oracle, but only after
  `expiry + EMERGENCY_GRACE_SECONDS` (24h); recovered funds go to a `treasury`
  distinct from `fee_authority`. (Operator workflow in §3.)
- **Rationale.** Normal oracle settlement always gets first claim (24h grace); the
  emergency path is solvent by the $1 invariant; separating treasury keeps
  custodial user funds accounting-separate from protocol revenue.
- **Trade-offs.** Adds privileged surface — bounded by the grace delay and the
  no-withdrawal rule (D17).

#### D20. `burn_pair` primitive for a symmetric Sell No exit
- **Context.** Sell No could leave the user's capital locked until settlement.
- **Decision.** Add `burn_pair` (the inverse of `mint_pair`): burn equal Yes + No,
  return $1 USDC.
- **Rationale.** Lets Sell No buy a Yes from the book and immediately burn the
  Yes+No pair for USDC in the same transaction — capital returns now, mirroring
  Sell Yes. (See §5.)
- **Trade-offs.** One more primitive to test, but it closes the capital-lock UX gap.

### Scope & process

#### D21. Day-5 decision gate → Phoenix-CPI fallback
- **Decision.** If `place_limit_order` + partial fills + `cancel_order` weren't
  passing invariant tests by end of day 5, swap the matching layer to Phoenix via
  CPI and keep mint/redeem/settle.
- **Rationale.** Converts the build-own bet (D4) into a reversible commitment with
  a hard checkpoint.
- **Trade-offs.** Carrying a dormant contingency unit in the plan.

#### D22. Devnet only for the demo
- **Decision.** Target Solana devnet; do not deploy to mainnet.
- **Rationale.** A downstream consequence of D4 — unaudited hand-rolled matching on
  mainnet is a negative signal, not a feature.

#### D23. Market-order-only Buy No (drop limit Buy No)
- **Decision.** Ship Buy No as a market order only. (See §5.)
- **Rationale.** A limit Buy No introduces transient Yes+No state on cancel and
  contradicts the position-constraint model; dropping it removes a whole bug class
  without losing the four-trade-path signal.

#### D24. Position constraints enforced in the frontend only
- **Decision.** "No Buy Yes while holding No" (and vice-versa) is enforced
  client-side, reading fresh balances at action time; on-chain enforcement is
  deferred. (Full behavior in §6.)
- **Rationale.** Matches the PRD's placement; on-chain enforcement would need
  Token-2022 transfer hooks (D3). A malicious client could bypass it — acceptable
  for a devnet demo, flagged for a hardening pass.

#### D25. Three-layer test ladder
- **Decision.** proptest (engine invariants) + LiteSVM (instruction-level CPI flows
  and races) + Trident (multi-instruction fuzz across markets). (Commands in §11.)
- **Rationale.** Each layer catches a distinct failure class; bugs are caught at
  the cheapest layer that can reach them.

---

## 9. Known limitations (scope boundaries and the mainnet path)

Documented honestly (the PRD values defensible, written-up trade-offs):

- **No mainnet deployment.** Devnet only (D22). Mainnet is an explicit bonus, not a
  pass requirement. Before mainnet: real Circle USDC mint, the real Pyth mainnet
  receiver, an audit of the hand-rolled matching engine, and the residual hardening
  items below.
- **Hand-rolled matching is unaudited** (D4) — the direct reason mainnet is out of
  scope; an audit is required first.
- **Single-program blast radius** (D5) — acceptable on devnet; a CPI boundary
  between programs would contain it for mainnet.
- **On-chain position constraints absent** — frontend-only today (D24); a
  Token-2022 transfer hook is the path to on-chain enforcement.
- **Fixed book depth N=32** (D10) — book-stuffing could exhaust a deep-OTM side;
  dynamic sizing or anti-stuffing fees for production.
- **No advanced order types or fees** — IOC/FOK/post-only and maker rebates are out
  of scope by design.
- **No `Config` ticker/feed registry.** The per-market `pyth_feed_id` (set at
  `create_strike_market`) is the source of truth for "which oracle feed settles
  this market." A central on-chain ticker registry would be a `Config` layout
  change for no functional gain right now, so it's deferred.
- **Regular session only.** No pre/post-market or overnight equity sessions —
  settlement is anchored to the 9:30–4:00 ET regular session (§4).
- **`alert()` is a seam, not full monitoring.** The automation service logs
  JSON-lines and escalates via an `alert()` hook (stderr + optional
  `ALERT_WEBHOOK`). That's an integration point, not production-grade
  observability/paging.
- **The frontend is local/devnet `next dev`, not hosted.** There is no Vercel (or
  equivalent) production deployment of the UI; running it is `cd app && npm run
  dev` against a local validator or devnet.
- **Demo runs a MAG7 subset by default** (`TICKERS=AAPL,NVDA,TSLA`) for speed; the
  config supports all seven (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA, plus GOOG).

---

## 10. Component map

```
On-chain (programs/meridian/src/)
  lib.rs                  15 instructions (initialize_config, create_strike_market,
                          mint_pair, burn_pair, place_limit_order, place_market_order,
                          cancel_order, buy_no, sell_no, settle_market, settle_sweep,
                          redeem, set_paused, set_require_full_verification,
                          admin_settle_market)
  matching/               pure-Rust engine (order_key, book_side, match_step)
  instructions/           one handler per instruction
  state/                  Config, Market, Book (zero-copy), vendored Pyth PriceUpdateV2

Automation (automation/src/)
  config.ts               MAG7 tickers + Equity.US.<T>/USD feed IDs, strike ladder, env
  client.ts               Anchor client + the in-memory Book IDL patch + PDA helpers
  pyth.ts                 shared Hermes fetch + receiver post (also mirrored by the script)
  jobs/createStrikes.ts   morning job (idempotent, retry/backoff, per-ticker isolation)
  jobs/settle.ts          after-close job (oracle retry → admin-override fallback)

Frontend (app/src/)
  app/page.tsx            Landing (live MAG7 prices + connect CTA)
  app/markets/            Markets grid (per-stock live price + active contracts)
  app/trade/[market]/     Trade (both-sides book, 4 paths, PositionGuard, Countdown, Payoff)
  app/portfolio/          Portfolio (positions, P&L, redeem)
  app/history/            History (trade execution log)
  lib/prices.ts           Hermes live-price client + usePrices hook
  lib/tradePaths.ts       4-path routing + No-price math + position guard + both-sides book
  lib/pnl.ts              P&L computation
  lib/idlPatch.ts         in-memory Book IDL patch
```

---

## 11. Tests

The three-layer test ladder (D25) plus the off-chain suites:

| Layer | Command | Coverage |
|---|---|---|
| Matching engine + price math (unit) | `cargo test -p meridian --lib` | pure-Rust engine + `rebase_to_microunits`; proptest invariants |
| On-chain integration | `cargo test -p meridian-litesvm-tests` | full instruction set against an in-process SVM incl. settle/redeem with a forged `PriceUpdateV2` |
| Invariant fuzz | `trident fuzz run clob_invariants` (in `trident-tests/`) | R13 escrow reconciliation, R14 Yes/No supply parity, token conservation across random instruction sequences |
| Automation | `cd automation && npm test` | config validation, strike ladder, client, CLI; guarded `*.live.test.ts` against a cluster |
| Frontend | `cd app && npm test` | trade-path routing + No-price math, P&L, position guard, payoff, countdown, Hermes parsing; guarded `*.live.test.ts` |
