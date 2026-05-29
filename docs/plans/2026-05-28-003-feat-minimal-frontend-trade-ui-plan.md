---
date: 2026-05-28
type: feat
status: active
depth: standard
title: "feat: Minimal frontend trade UI for local testing"
---

# feat: Minimal Frontend Trade UI

A minimal Next.js web app that lets you connect a wallet and drive the Meridian
CLOB through its core trade loop against a running cluster (localnet by default,
devnet later): view a market's order book and your positions, mint a Yes/No
pair, place and cancel limit orders, burn a pair back to USDC, and redeem after
settlement. It is a **test harness for the on-chain program**, not the eventual
production product frontend — but it lives in `app/` so it can grow into one.

---

## Problem Frame

The program is fully exercised by scripts (`scripts/lifecycle-demo.mjs`) and the
LiteSVM suite, but there is no way to *click* through a trade. STRATEGY.md names
a frontend as a track and the project's one binary success metric is a demoable
create → mint → trade → settle → redeem lifecycle. Today that demo is CLI-only.
A minimal UI closes the gap between "the program works" and "I can watch it work
and let someone else try it."

This is explicitly a **submission/test-optimized** build, sized to the trade
loop only. It is not the position-aware, four-trade-path retail product the PRD
describes — that is deferred (see Scope Boundaries).

---

## Scope Boundaries

**In scope (the trade loop):**
- Wallet connect (Phantom / Solflare via `@solana/wallet-adapter`)
- Configurable RPC + program ID (defaults to localnet + the deployed program ID)
- List on-chain markets; select one
- Render the selected market's order book (bids/asks from the `Book` account)
- Show the connected wallet's Yes / No / USDC balances and resting orders
- `mint_pair`, `burn_pair`
- `place_limit_order` (including the crossing/match path), `cancel_order`
- `redeem` on a settled market
- A local-only dev toolbar: airdrop SOL + mint test USDC to the connected wallet

**Out of scope (deferred to follow-up work):**
- `buy_no` / `sell_no` and the four-trade-path abstraction (the PRD's "simple")
- `place_market_order`, slippage UI
- `create_strike_market` from the UI (markets are created by `bootstrap-devnet.mjs`
  / `lifecycle-demo.mjs` / an admin); the UI lists what exists
- `settle_market` from the UI and any admin instructions (`set_paused`,
  `set_treasury`, `admin_*`)
- Real-time book streaming / websockets (poll on an interval instead)
- Production styling, responsive design polish, market-grid/portfolio pages
- Production deploy (Vercel etc.) — runs `next dev` locally for now

**Not this product's identity:** off-chain order matching, custodial flows, or
anything that moves matching off the on-chain `Book`.

---

## Output Structure

All frontend code lives under a single new top-level directory, `app/` (the
standard Anchor convention), so the repo has exactly one frontend home:

```
app/
  README.md                  # how to run it, env vars, what it does/doesn't do
  package.json
  next.config.mjs
  tsconfig.json
  .env.local.example         # NEXT_PUBLIC_RPC_URL, NEXT_PUBLIC_PROGRAM_ID
  .gitignore                 # node_modules, .next, .env.local
  src/
    app/
      layout.tsx
      page.tsx               # market picker + trade view
      providers.tsx          # ConnectionProvider + WalletProvider + modal
    lib/
      idl/meridian.json      # copied from target/idl/meridian.json at setup
      idl/meridian.ts        # IDL TS type for the typed Anchor client
      pdas.ts                # PDA derivations (port seeds from program)
      program.ts             # Anchor Program<Meridian> factory
      market.ts              # fetch config, enumerate markets, book, balances
      matching.ts            # JS match-walk -> maker ATAs for remaining_accounts
      format.ts              # base-unit <-> display conversion helpers
    components/
      WalletButton.tsx
      MarketPicker.tsx
      OrderBook.tsx
      Balances.tsx
      MintBurnPanel.tsx
      PlaceOrderPanel.tsx
      OpenOrders.tsx         # resting orders + cancel
      RedeemPanel.tsx
      DevToolbar.tsx         # local-only: airdrop SOL + mint test USDC
```

The per-unit `**Files:**` lists are authoritative; this tree is the shape.

---

## Key Technical Decisions

- **Next.js (App Router) + TypeScript**, per STRATEGY.md, so this doesn't get
  rewritten if it becomes the real frontend. It runs as a client-side wallet app
  (`'use client'` components); no SSR/server routes are needed.
- **Typed Anchor client from the IDL.** Copy `target/idl/meridian.json` into
  `app/src/lib/idl/` and generate the matching TS type. Every instruction and
  account read goes through `Program<Meridian>` so the call shapes match what the
  scripts already prove. Re-copy the IDL whenever the program changes (documented
  in the README; a follow-up could symlink or add an `anchor build` hook).
- **PDA seeds are ground truth from the program**, not re-invented:
  `Config` = `[b"config"]`; `Market` = `[b"market", ticker, strike.to_le_bytes(),
  expiry.to_le_bytes()]`; and per-market `[b"book"|b"yes_mint"|b"no_mint"|
  b"mint_auth"|b"usdc_escrow"|b"yes_escrow", market]`. Port directly from
  `scripts/lifecycle-demo.mjs` (`subPdas`) and the program's
  `create_strike_market.rs` / `state/market.rs`.
- **Crossing orders need maker ATAs as `remaining_accounts`.** This is the one
  hard part. `place_limit_order` consumes one `remaining_account` per fill — the
  maker's canonical ATA for the payout mint (USDC when a bid takes, Yes when an
  ask takes), up to `MAX_FILLS_PER_TX`, and reverts on a non-canonical account
  (`BadMakerAccount`). The frontend must read the `Book`, replicate the engine's
  price-time match-walk in JS to determine which resting orders a new order
  hits and in what order, derive each maker's canonical ATA, and pass them in
  fill order. Isolated in `matching.ts` (U5).
- **Poll, don't stream.** Re-fetch book + balances on a short interval and after
  each tx. No websocket/account-subscription complexity for v1.
- **Amounts are raw base units** (Yes/No mints are 6-decimal like USDC); `price`
  is USDC microunits per Yes base unit. `format.ts` centralizes display
  conversion so the UI matches the scripts' conventions.

---

## Implementation Units

### U1. Scaffold the app and wire the Anchor client

**Goal:** Establish `app/` as the single frontend home: a runnable Next.js + TS
app with wallet connection, configurable RPC/program ID, and a typed Anchor
`Program` instance.

**Dependencies:** none.

**Files:** `app/package.json`, `app/next.config.mjs`, `app/tsconfig.json`,
`app/.env.local.example`, `app/.gitignore`, `app/README.md`,
`app/src/app/layout.tsx`, `app/src/app/providers.tsx`,
`app/src/lib/idl/meridian.json`, `app/src/lib/idl/meridian.ts`,
`app/src/lib/program.ts`.

**Approach:** `create-next-app` (App Router, TS, no server features). Add
`@solana/web3.js`, `@solana/wallet-adapter-{base,react,react-ui,wallets}`,
`@coral-xyz/anchor`, `@solana/spl-token`. `providers.tsx` wraps the app in
`ConnectionProvider` (RPC from `NEXT_PUBLIC_RPC_URL`, default
`http://127.0.0.1:8899`) + `WalletProvider` + `WalletModalProvider`.
`program.ts` builds `Program<Meridian>` from the IDL, the program ID
(`NEXT_PUBLIC_PROGRAM_ID`, default `6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX`),
and an `AnchorProvider` bound to the connected wallet.

**Patterns to follow:** `scripts/lifecycle-demo.mjs` (Program construction, IDL
load, BN handling); the IDL at `target/idl/meridian.json`.

**Test scenarios:**
- App boots with `next dev` and renders without a connected wallet.
- Connecting a wallet exposes a `Program` whose `programId` matches the env value.
- `program.account.config.fetch(configPda)` against the running local validator
  returns the bootstrapped Config (smoke test that IDL + RPC wiring works).

**Verification:** `cd app && npm i && npm run dev` serves the page; wallet
connect works; the Config fetch logs real data from the local validator.

### U2. PDA helpers + read layer

**Goal:** Pure functions for every PDA, and fetchers for Config, the market
list, a market's book, and a wallet's balances.

**Dependencies:** U1.

**Files:** `app/src/lib/pdas.ts`, `app/src/lib/market.ts`,
`app/src/lib/format.ts`.

**Approach:** `pdas.ts` ports the exact seeds (above). `market.ts`:
`fetchConfig()`; `listMarkets()` via `program.account.market.all()`;
`fetchMarket(marketPda)` returning market state + derived sub-PDAs + Yes/No mint
+ escrow balances; `fetchBook(marketPda)` deserializing the `Book` account into
sorted bid/ask levels with `{price, seq, qty, owner}`; `fetchBalances(owner,
market)` for USDC/Yes/No canonical ATAs (tolerating not-yet-created ATAs as 0).
`format.ts` handles base-unit ↔ display and ticker byte ↔ string.

**Patterns to follow:** `subPdas()` and the account fetches in
`scripts/lifecycle-demo.mjs`; `Book` layout in `programs/meridian/src/state/book.rs`
and `matching/book_side.rs`.

**Test scenarios:**
- Each PDA helper reproduces the address the program derives (compare against a
  known market created by `lifecycle-demo.mjs` / a litesvm fixture).
- `listMarkets()` returns the bootstrapped market(s) after running bootstrap.
- `fetchBook` on an empty book returns empty bid/ask arrays; after a resting ask
  is posted, that order appears on the ask side with the right price/qty/owner.
- `fetchBalances` returns 0 for a wallet with no ATA rather than throwing.

**Verification:** a scratch call logs the bootstrapped market and an empty book
from the local validator.

### U3. Read-only UI shell (connect, pick market, see book + balances)

**Goal:** A working read-only screen: connect wallet, choose a market, watch the
order book and your balances refresh.

**Dependencies:** U2.

**Files:** `app/src/app/page.tsx`, `app/src/components/WalletButton.tsx`,
`app/src/components/MarketPicker.tsx`, `app/src/components/OrderBook.tsx`,
`app/src/components/Balances.tsx`.

**Approach:** `page.tsx` holds selected-market state and a poll interval
(re-fetch book + balances every ~3s and after any tx). `MarketPicker` lists
markets (ticker / strike / expiry / settled). `OrderBook` renders bids
(desc) and asks (asc) with cumulative depth. `Balances` shows USDC/Yes/No and
the wallet's resting orders count.

**Test scenarios:**
- With no market selected, the panels show an empty/prompt state, not an error.
- Selecting the bootstrapped market renders its (empty) book and the wallet's
  zero balances.
- After `lifecycle-demo.mjs` posts a resting ask, the book reflects it within
  one poll cycle.

**Verification:** connect → pick the bootstrapped market → see live book/balances
that update when a script posts an order.

### U4. mint_pair / burn_pair

**Goal:** Deposit USDC for an equal Yes+No pair, and recombine a pair back to
USDC.

**Dependencies:** U3.

**Files:** `app/src/components/MintBurnPanel.tsx`.

**Approach:** amount input + Mint/Burn buttons. Builds the `mintPair` /
`burnPair` calls with the account set from `scripts/lifecycle-demo.mjs` (user
ATAs auto-created via `getOrCreateAssociatedTokenAccount` if missing). Refresh
balances + escrow on success; surface program errors (e.g. paused, insufficient
balance) as readable toasts.

**Test scenarios:**
- mint_pair of N: USDC −N, Yes +N, No +N, escrow +N; the $1 invariant
  (`yes == no == escrow delta`) holds in the displayed numbers.
- burn_pair of N (with N of each token held): the exact inverse.
- burn_pair with insufficient Yes/No surfaces the program error, no silent fail.
- mint_pair while the market is paused surfaces the pause error.

**Verification:** mint 1000, watch balances + escrow move; burn 500, watch them
reverse — matching the `lifecycle-demo.mjs` numbers.

### U5. place_limit_order (with matching) + cancel_order

**Goal:** Post bids/asks that rest *and* that cross the book, plus cancel a
resting order. This is the unit that proves the matching engine through the UI.

**Dependencies:** U4.

**Files:** `app/src/lib/matching.ts`, `app/src/components/PlaceOrderPanel.tsx`,
`app/src/components/OpenOrders.tsx`.

**Approach:** `matching.ts` reads the current `Book`, walks the opposing side in
the engine's price-time priority up to `MAX_FILLS_PER_TX`, and returns the
ordered list of maker owners that a `{side, price, qty}` order would fill —
mapped to each maker's canonical payout ATA (USDC for a bid taker, Yes for an
ask taker) for `remaining_accounts`. `PlaceOrderPanel` submits `placeLimitOrder`
with those remaining accounts (empty when the order won't cross → pure rest).
`OpenOrders` lists the wallet's resting orders (from the book, filtered by
owner) with a Cancel button that calls `cancelOrder({side, price, seq})`.

**Execution note:** Build `matching.ts` test-first against `Book` fixtures — the
maker-ATA ordering is the highest-risk logic and a wrong account reverts with
`BadMakerAccount`.

**Patterns to follow:** the `remaining_accounts` layout documented at the top of
`programs/meridian/src/instructions/place_limit_order.rs`; the crossing-bid call
in `scripts/lifecycle-demo.mjs` step 4; `matching/match_step.rs` for the walk
order; `cancel_order` accounts from the script.

**Test scenarios (matching.ts, unit):**
- No opposing liquidity → empty remaining-accounts, order rests.
- Bid crossing one resting ask → exactly that maker's canonical USDC ATA.
- Bid crossing several asks → makers in price-time fill order, capped at
  `MAX_FILLS_PER_TX`, residual rests.
- Ask crossing resting bids → makers' canonical Yes ATAs in order.
- Self-cross (wallet's own resting order) handled the way the engine handles it
  (no malformed account passed).

**Test scenarios (UI / e2e against local validator):**
- Post a resting ask → appears in `OpenOrders` and the book.
- Cross it from a second wallet → fill happens, balances move, price-improvement
  refund matches the script (taker bids above ask, pays the ask price).
- Cancel a resting order → escrowed collateral refunded to the exact pre-post
  balance.

**Verification:** reproduce `lifecycle-demo.mjs` step 4 + step 5 entirely through
the UI with two wallets.

### U6. redeem on a settled market

**Goal:** After a market settles, burn the winning token for USDC 1:1.

**Dependencies:** U3 (independent of U4/U5).

**Files:** `app/src/components/RedeemPanel.tsx`.

**Approach:** show only when `market.settled`. Read `outcome`, pick the winning
mint, and call `redeem(amount)` with the winning-mint account set. Disabled with
an explanatory note when the market is unsettled. (Settlement itself stays
out of the UI — use `scripts/settle-redeem-demo.sh` or a script to settle.)

**Test scenarios:**
- Unsettled market → panel disabled with a "not settled yet" note.
- Settled YesWins, wallet holds Yes → redeem N burns N Yes, returns N USDC,
  escrow −N.
- Redeem with the losing token → program rejects (`WrongRedeemMint`), surfaced.

**Verification:** against a settled market (via the settle script flow), redeem
the winning side and watch USDC return 1:1.

### U7. Local dev toolbar (fund + test USDC)

**Goal:** Make the app self-sufficient for local testing: fund the connected
wallet with SOL and test USDC without dropping to the CLI.

**Dependencies:** U2.

**Files:** `app/src/components/DevToolbar.tsx`.

**Approach:** local-only (render only when RPC is localhost). "Airdrop 2 SOL"
(`connection.requestAirdrop`) and "Mint 5 USDC" (`mintTo` from the config's USDC
mint — works locally because the bootstrap keypair is the mint authority; note
in the README that on devnet you fund via the script instead). Hidden on
non-local RPC so it can't mislead on devnet.

**Test scenarios:**
- On localhost: airdrop raises SOL balance; mint raises USDC balance.
- On a non-localhost RPC: the toolbar is not rendered.

**Test expectation:** light — this is dev ergonomics; one render-gating check
plus manual local verification.

**Verification:** fresh wallet → airdrop + mint test USDC → immediately able to
`mint_pair` without touching the CLI.

---

## Risks & Mitigations

- **Maker `remaining_accounts` ordering (U5)** is the highest-risk piece — a
  wrong/non-canonical account reverts (`BadMakerAccount`). Mitigation: isolate in
  `matching.ts`, build it test-first against `Book` fixtures, and validate
  against the proven `lifecycle-demo.mjs` crossing-bid case.
- **IDL drift.** The copied IDL can fall behind the program. Mitigation: document
  the re-copy step in `app/README.md`; a follow-up can automate it.
- **`Book` zero-copy layout.** `Book` is an `AccountLoader` (zero-copy) account;
  Anchor's JS `account.book.fetch` must match the on-chain layout exactly.
  Mitigation: verify `fetchBook` against a known posted order in U2 before
  building UI on top of it.
- **Scope creep toward the product.** Keep buy_no/sell_no, market orders, and
  market-creation out of v1 per Scope Boundaries; they are the product, not the
  test harness.

---

## Verification (whole feature)

The feature is done when, against the running local validator, you can: connect a
wallet, fund it from the dev toolbar, select the bootstrapped market, mint a
pair, post and cross limit orders (reproducing `lifecycle-demo.mjs` through the
UI with two wallets), cancel a resting order with a correct refund, burn a pair,
and — on a settled market — redeem the winning side 1:1. The same build, pointed
at devnet via env vars, works identically once the wallet is funded.
