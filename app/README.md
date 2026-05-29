# Meridian frontend (`app/`)

The single home for all Meridian frontend code. Everything web/UI lives here —
nothing frontend belongs anywhere else in the repo.

> **Status: scoped, not yet built.** This directory is established as the
> frontend's home. The implementation is planned in
> [`docs/plans/2026-05-28-003-feat-minimal-frontend-trade-ui-plan.md`](../docs/plans/2026-05-28-003-feat-minimal-frontend-trade-ui-plan.md)
> and built via that plan. The structure below is the intended layout.

## What it is

A minimal Next.js + TypeScript app to drive the Meridian on-chain CLOB through
its core trade loop from a browser: connect a wallet, view a market's order book
and your positions, `mint_pair`, place/cancel limit orders, `burn_pair`, and
`redeem` after settlement. It is a **test harness for the program**, not yet the
production retail product (no buy_no/sell_no, market orders, or admin controls —
see the plan's Scope Boundaries).

## Intended structure

```
app/
  src/
    app/        # Next.js App Router: layout, page, wallet providers
    lib/        # idl/, pdas.ts, program.ts, market.ts, matching.ts, format.ts
    components/ # WalletButton, MarketPicker, OrderBook, Balances,
                # MintBurnPanel, PlaceOrderPanel, OpenOrders, RedeemPanel, DevToolbar
```

## Running it (once built)

```bash
cd app
npm install
cp .env.local.example .env.local   # adjust RPC + program ID if needed
npm run dev
```

### Environment

| Var | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_RPC_URL` | `http://127.0.0.1:8899` | Cluster RPC (local validator; set to devnet later) |
| `NEXT_PUBLIC_PROGRAM_ID` | `6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX` | Meridian program ID |

### Prerequisites for local testing

A running local validator with the program deployed and config bootstrapped —
see the repo root demos (`scripts/settle-redeem-demo.sh` boots one end-to-end,
or deploy + `scripts/bootstrap-devnet.mjs --rpc http://127.0.0.1:8899`). Markets
are created by the scripts / an admin; this app lists what exists rather than
creating markets.

> **IDL:** the typed Anchor client reads a copy of `target/idl/meridian.json`
> placed at `app/src/lib/idl/`. Re-copy it whenever the program changes.
