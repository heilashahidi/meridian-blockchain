# Meridian frontend (`app/`)

The single home for all Meridian frontend code. A Next.js (App Router) +
TypeScript app that drives the Meridian on-chain CLOB from the browser: connect a
wallet, see live MAG7 prices, trade the four Buy/Sell Yes/No paths against the
on-chain order book, track positions + P&L, and redeem settled markets.

This is the full retail product surface described in the PRD, not just a test
harness. For the system design and trade-offs see
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md); to run it against devnet end
to end see [`../docs/DEVNET-RUNBOOK.md`](../docs/DEVNET-RUNBOOK.md).

## The five pages

| Route | Page | What it does |
|---|---|---|
| `/` | **Landing** (`src/app/page.tsx`) | Explains the product, shows live MAG7 prices (via `usePrices`), and a connect-wallet CTA. |
| `/markets` | **Markets** (`src/app/markets/page.tsx`) | Grid of the MAG7 stocks (`StockTile`), each with its live price and the count of active strike contracts. Cards link into Trade. |
| `/trade/[market]` | **Trade** (`src/app/trade/[market]/page.tsx`) | The core screen: the single on-chain book shown from **both** the Yes and No perspectives (`BothSidesBook`); the four trade paths (`TradePanel`, routed by `lib/tradePaths.ts`); position constraints (`PositionGuard`); a settlement `Countdown` to 4PM ET; the `Payoff` display; and a `RedeemPanel` once settled. |
| `/portfolio` | **Portfolio** (`src/app/portfolio/page.tsx`) | The wallet's Yes/No holdings per market (`PositionRow`), current value + P&L (`lib/pnl.ts`), and a redeem action on settled markets. |
| `/history` | **History** (`src/app/history/page.tsx`) | The wallet's program transactions parsed into a trade log (`lib/history.ts`), with Solscan links. |

Navigation across all five lives in `src/components/Nav.tsx`.

## Live prices

`src/lib/prices.ts` exports the `usePrices` hook and the pure `parseHermesPrices`
parser. It polls the Pyth **Hermes** "latest price" HTTP endpoint (every ~5s) for
the MAG7 `Equity.US.<TICKER>/USD` feeds (`src/lib/feeds.ts`) and returns a
`ticker → { price, confidence, publishTime }` map.

It never throws: a network/parse failure yields nulls and the hook keeps the last
good price. Equity feeds are only fresh during US market hours (9:30AM–4PM ET,
weekdays); off-hours `publishTime` goes stale and the UI labels it accordingly
("live" / "Nm ago").

## The four trade paths

`src/lib/tradePaths.ts` (framework-free, unit-tested in
`tradePaths.test.ts`) maps the UI actions to on-chain instructions. The book is
priced in **Yes** terms; `No price = $1 − Yes price`.

- **Buy Yes** → `place_limit_order` / `place_market_order`, Bid side.
- **Sell Yes** → `place_limit_order` / `place_market_order`, Ask side.
- **Buy No** → `buy_no` (atomic mint-pair + market-sell the Yes leg).
- **Sell No** → `sell_no` (atomic market-buy the Yes leg + burn-pair).

It also exports `positionGuardDecision` (PRD §142–144: don't end up holding both
Yes and No from trading) and `toNoView` (reflect the Yes book into the No
perspective). See `../docs/ARCHITECTURE.md` §5–6 for the full rationale.

## Running it

```bash
cd app
npm install
cp .env.local.example .env.local   # adjust RPC / program id
npm run dev
```

For a one-command local stack (validator + bootstrap + this dev server), run
`make dev` from the repo root — it auto-writes `app/.env.local` pointing at the
local validator. To run against devnet, fill in `app/.env.local` with the devnet
values (see the runbook §5).

### Environment

| Var | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_RPC_URL` | `http://127.0.0.1:8899` | Cluster RPC (local validator; set to `https://api.devnet.solana.com` for devnet) |
| `NEXT_PUBLIC_PROGRAM_ID` | `6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX` | Meridian program id (same on localnet + devnet) |
| `NEXT_PUBLIC_HERMES_URL` | `https://hermes.pyth.network` | Pyth Hermes endpoint for live prices (moving to an API-key model mid-2026; treat as configurable). |
| `NEXT_PUBLIC_DEMO_WALLET` | _(unset)_ | Optional read-only account pubkey. When set and no wallet is connected, the dashboard/portfolio/history preview this account's live on-chain data instead of an empty/connect state. |

> The USDC mint is **not** an env var: the app reads it from the on-chain Config
> account (`fetchConfig` → `c.usdcMint`), the single source of truth. A build-time
> value would only drift from on-chain, so it was removed.

### Importing the dev wallet for local testing

For local testing, import `~/.config/solana/id.json` (the keypair that deployed +
bootstrapped the validator) into Phantom/Solflare. That key is the Config admin
and the test-USDC mint authority, so the dev toolbar's "Mint test USDC" can sign.
Use the toolbar to airdrop SOL and mint yourself test USDC, then mint pairs and
trade.

## Tests

```bash
cd app
npm test          # vitest
```

Pure-logic suites run offline: `tradePaths.test.ts` (path routing + No-price
math), `pnl.test.ts`, `prices.test.ts` (Hermes parsing), `payoff.test.ts`,
`countdown.test.ts`, `marketsView.test.ts`, `matching.test.ts`, `history.test.ts`,
and more. The `*.live.test.ts` suites (`place.live.test.ts`,
`mintburn.live.test.ts`, `read.live.test.ts`) require a running, bootstrapped
cluster and auto-skip otherwise.

## Structure

```
app/src/
  app/
    page.tsx              Landing
    markets/page.tsx      Markets (MAG7 grid)
    trade/[market]/page.tsx  Trade (both-sides book, 4 paths, guard, countdown, payoff)
    portfolio/page.tsx    Portfolio (positions, P&L, redeem)
    history/page.tsx      History (trade log)
    layout.tsx, providers.tsx  App shell + wallet providers
  lib/
    prices.ts             Hermes live-price client + usePrices hook
    tradePaths.ts         4-path routing, No-price math, position guard, both-sides book
    pnl.ts, history.ts, marketsView.ts, market.ts, matching.ts, actions.ts
    idlPatch.ts           in-memory Book IDL patch (see ARCHITECTURE §2)
    pdas.ts, program.ts, feeds.ts, format.ts, MeridianContext.tsx
  components/             Nav, StockTile, MarketCard, BothSidesBook, TradePanel,
                          PositionGuard, Countdown, Payoff, PositionRow, RedeemPanel,
                          OrderBook, Balances, MintBurnPanel, PlaceOrderPanel,
                          OpenOrders, WalletButton, DevToolbar
```

> **IDL:** the typed Anchor client reads a copy of `target/idl/meridian.json`
> placed at `app/src/lib/idl/`. Re-copy it whenever the program changes
> (`idlPatch.ts` patches it in memory; the committed copy stays pristine).
