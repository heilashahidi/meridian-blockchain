---
date: 2026-06-04
type: fix
status: planned
depth: shallow
title: "fix: portfolio share-quantity unit scaling (positions read $0.00)"
---

# fix: Portfolio share-quantity unit scaling

The Portfolio page and the dashboard "Portfolio value" panel render real
positions as **Quantity 0 / Value $0.00 / P&L $0.00**, even though the trade
page, order book, and position pill all show the position correctly. One
frontend helper divides share quantities by 1e6 when it should not.

---

## Problem Frame

After buying, say, 5 Yes:

- **Trade page** position pill shows `Yes 5` — correct.
- **Order book** shows the resting `25` qty and ticks down on fills — correct.
- **Portfolio page** (`/portfolio`) shows that position's **Quantity `0`,
  Value `$0.00`, P&L `$0.00`** — wrong.
- **Dashboard** ("Portfolio value" panel, home page) counts that position as
  ~$0, so the headline value is essentially just the wallet's USDC — wrong.

The row *appears* (so the position isn't lost), but every number reads zero.
For a demo this is the one screen that exposes the bug, so the near-term
mitigation is "don't open Portfolio"; this plan removes the bug.

## Root Cause

The system's de-facto unit is **1 token base unit = 1 share**. Every layer
treats share quantities as raw integers and prices as µUSDC-per-share:

- Seeder places `qty = BN(25)` raw (`automation/src/jobs/seedLiquidity.ts:190`).
- Trade panel sends `qty: BigInt(qtyN)` raw — no scaling
  (`app/src/components/TradePanel.tsx:87,114`).
- Order book renders `level.qty.toString()` raw (`app/src/components/OrderBook.tsx:37`).
- Position pill renders raw `balances.yes` (`app/src/components/PositionGuard.tsx:34`).
- Program locks `qty * price` µUSDC and transfers `qty` token base units
  (`programs/meridian/src/instructions/place_limit_order.rs:300,320`). Price is
  µUSDC-per-share (`870000` ↔ `$0.87`). So buying 5 shares locks
  `5 * 870000 = 4_350_000` µUSDC = **$4.35** of real (6-decimal) USDC. Internally
  consistent at "1 base unit = 1 share."

The **only** layer that disagrees is one frontend helper:

```ts
// app/src/lib/pnl.ts:135
export function contractsFromBaseUnits(baseUnits: bigint): number {
  return Number(baseUnits) / USDC_SCALE; // USDC_SCALE = 1e6  ← the bug
}
```

It divides the share count by 1e6, so a 5-share holding becomes `0.000005`,
which rounds to `0` and values to `$0.00`. Prices are *correctly* divided by
1e6 elsewhere (price is µUSDC), and USDC is *correctly* divided by 1e6 (USDC is a
real 6-decimal token). Quantity is the lone wrong division.

### Why "1 base unit = 1 share" and not the 6-decimal reading

The Yes/No mints are created with `decimals = 6`
(`programs/meridian/src/instructions/create_strike_market.rs:79,90`), which would
imply 1 share = 1e6 base units (fractional shares). But the program, seeder,
trade panel, order book, and pill *all* operate in raw integers and the
`$1 = 1 Yes + 1 No` invariant holds at the whole-share level
(`lock = qty * price`, `price ∈ 0..1e6 ↔ $0..$1`). The declared 6 decimals are
unused display metadata. Honoring them instead would be a much larger,
higher-risk change (scale trade qty ×1e6, order book ÷1e6, pill ÷1e6, re-seed at
1e6-larger lots, fund wallets with real USDC) for no product benefit — this
product trades whole-share binary contracts. See "Out of scope" for that path.

## Fix

Make the frontend quantity helper agree with the rest of the system: **1 base
unit = 1 share.** Leave every price and USDC division alone.

### Step 1 — Correct the helper (`app/src/lib/pnl.ts`)

Rename for honesty and drop the divide:

```ts
/** Share count from token base units. 1 base unit = 1 share (mints' declared
 *  6 decimals are unused; the whole system trades in whole-share integers). */
export function sharesFromBaseUnits(baseUnits: bigint): number {
  return Number(baseUnits);
}
```

Keep a one-line deprecated alias `contractsFromBaseUnits = sharesFromBaseUnits`
only if a same-PR rename of callers is noisy; prefer renaming callers.

### Step 2 — Update callers (rename + verify intent)

- `app/src/components/PositionRow.tsx:46` — `const qty = sharesFromBaseUnits(amount)`.
  `computePnl(qty, entryPrice, current)` then yields real value/P&L (entry basis
  `MINT_PAIR_LEG_BASIS = $0.50/share` and `currentContractPrice` are already
  per-share, so no other change).
- `app/src/app/portfolio/page.tsx` summary (`page.tsx:205`) — same helper; value
  and P&L totals follow automatically.
- `app/src/app/page.tsx:251-252` (dashboard PortfolioPanel) — `yes`/`no` become
  real share counts; `posVal += yes * ym + no * (1 - ym)` then reflects real
  position value. Confirm USDC stays `Number(bals.usdc) / 1_000_000`
  (`page.tsx:250`) — USDC is genuinely 6-decimal, leave it.

### Step 3 — Do NOT touch (verification checklist, these are correct)

- `app/src/lib/marketsView.ts:38` `bestAsk / USDC_SCALE` — price, keep.
- `app/src/lib/marketsView.ts:58` strike ÷ `USDC_SCALE` — strike dollars, keep.
- `app/src/app/page.tsx:53,250,526,549,565` — strike & USDC divisions, keep.
- Trade panel, order book, position pill — already in shares, no change.

## Tests

- `app/src/lib/__tests__/pnl.test.ts` (or wherever `contractsFromBaseUnits` is
  asserted) — update expectations: `sharesFromBaseUnits(5n) === 5`, and a
  value/P&L case (e.g. 5 shares, entry $0.50, current $0.87 → value $4.35,
  P&L +$1.85).
- Add a regression assertion that a 5-share Yes holding produces a non-zero
  portfolio value (guards against re-introducing the ÷1e6).
- Grep for any test asserting the old `/1e6` quantity and fix it.
- `npm test` in `app/` green.

## Verification (manual, devnet)

1. Connect a wallet flat in some market with a little devnet USDC.
2. Buy 5 Yes (~$4.35). Position pill shows `Yes 5`.
3. Open `/portfolio`: row shows **Quantity 5**, **Value ≈ $X** (current price ×
   5), non-zero **P&L**. Dashboard "Portfolio value" includes it.
4. Sell some, confirm quantity/value track down on the next poll.

## Risks

- **Low blast radius.** One helper, three call sites, display-only. No program,
  no migration, no re-seed, no on-chain behavior change.
- **Watch:** any other caller of `contractsFromBaseUnits` outside the three above
  — grep before merge.
- **Naming:** keeping the old name would relabel "contracts" as raw shares and
  mislead the next reader; rename it.

## Out of Scope (note for later)

- **Fractional shares / honoring the 6-decimal mints.** If the product ever
  wants sub-share precision, that's the larger change: scale trade qty ×1e6,
  divide order-book/pill displays ÷1e6, re-seed at 1e6 lots, and fund demo
  wallets with proportionally more USDC. Not needed for whole-share binary
  contracts. If chosen, also recreate the mints (or accept the metadata).
- **Mint decimals cleanup.** Optionally recreate Yes/No mints with `decimals = 0`
  so on-chain metadata matches the "1 base unit = 1 share" reality. Cosmetic;
  requires redeploy/re-seed. Skip unless doing a broader migration.

## Demo note (correction)

Earlier guidance that trades cost "dust" was wrong: at "1 base unit = 1 share,"
buying N shares costs `N × price` real devnet USDC (5 @ $0.87 = **$4.35**). The
live-take demo buyer wallet needs a few dollars of devnet USDC (admin
`7sYcxc2…` is the USDC mint authority and can mint it). Until this fix ships,
keep the demo off the Portfolio page.
