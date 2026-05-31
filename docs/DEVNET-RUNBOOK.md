# Meridian — Devnet Runbook

Step-by-step: deploy Meridian to Solana devnet and run the full lifecycle —
create → mint → trade → settle → redeem — using the real scripts and the
automation service. Every command here is the actual command in the repo
(cross-checked against the `Makefile`, `scripts/`, and `automation/`).

Companion docs: [README](../README.md) (setup + tests) and
[ARCHITECTURE](ARCHITECTURE.md) (design + trade-offs).

> **Timing matters for live settlement.** Pyth's MAG7 equity feeds are only
> fresh during **US regular trading hours (9:30AM–4:00PM ET, weekdays)**. Real
> on-chain settlement only works in that window; off-hours you use the
> admin-override fallback (step 7b). Plan a market whose expiry lands during RTH
> if you want to demo real oracle settlement.

---

## 0. Prerequisites

- The [README prerequisites](../README.md#prerequisites): Rust, Solana CLI,
  Anchor 1.0.0, Node 20+.
- A Solana keypair at `~/.config/solana/id.json` (the deploy/admin wallet).
- `anchor build` already run (so `target/deploy/meridian.so` and
  `target/idl/meridian.json` exist).

```bash
anchor build
```

---

## 1. Fund the deploy wallet (the human-gated step)

A fresh program deploy costs several SOL of rent-exempt buffer. The devnet faucet
is rate-limited, so funding is a **manual step** before deploy.

The project's known deploy/admin wallet:

```
7sYcxc2hbcHuiVWGE9ZR1gM52Sm24Rdp15aED3DdjaYA
```

Fund it with **at least ~8 SOL** (the `MIN_SOL` preflight in
`scripts/deploy-devnet.sh`):

```bash
solana airdrop 2 7sYcxc2hbcHuiVWGE9ZR1gM52Sm24Rdp15aED3DdjaYA --url devnet   # repeat; rate-limited
# or web faucet: https://faucet.solana.com  (paste the address)
# or transfer from another funded devnet wallet
```

Check the balance:

```bash
solana balance 7sYcxc2hbcHuiVWGE9ZR1gM52Sm24Rdp15aED3DdjaYA --url devnet
```

If you deploy with a different keypair, use *its* address instead (the deploy
script reports the mismatch and uses your wallet's address in its funding
message).

---

## 2. Deploy the program

```bash
make devnet-deploy
```

This runs `scripts/deploy-devnet.sh`, which:

1. Preflights the deploy wallet's devnet balance. **If under ~8 SOL it exits
   non-zero without touching the cluster** (no partial deploy) and prints the
   address to fund and the exact shortfall. Go back to step 1.
2. Runs `anchor deploy --provider.cluster "$DEVNET_RPC"` (idempotent — re-running
   upgrades in place at the same program id).
3. Polls `solana program show` until the program is confirmed invokable.

> **Use a dedicated RPC, not the public endpoint.** A program `meridian.so`'s
> size uploads in hundreds of transactions, and `api.devnet.solana.com` 429s
> mid-deploy. Point `DEVNET_RPC` at a keyed RPC (e.g. Helius — see
> [ARCHITECTURE.md D26](ARCHITECTURE.md)):
> ```bash
> make devnet-deploy DEVNET_RPC="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
> ```
> The same `DEVNET_RPC` drives both the balance preflight and the deploy.
> `make demo DEMO_RPC="…"` takes the endpoint the same way.

> **On-chain IDL is optional.** With Anchor 1.0 the deploy may print
> "Failed to initialize IDL" *after* the program itself deploys successfully —
> that step writes a convenience on-chain IDL account. The app and scripts use a
> vendored IDL, so the program is fully invokable regardless; confirm with
> `solana program show <program-id> --url "$DEVNET_RPC"`.

On success it prints the program id
(`6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX`) and a "deployed and invokable"
confirmation.

---

## 3. Bootstrap `Config` + a market

`bootstrap-devnet.mjs` initializes the singleton `Config` (idempotent) and
creates one strike market. Use a USDC mint you **control** so you can mint
yourself test USDC for trading. The simplest path is to create a throwaway
devnet mint:

```bash
spl-token create-token --decimals 6 --url devnet      # prints a new mint address
```

Then bootstrap (from `scripts/`; `npm install` once):

```bash
cd scripts && npm install
node bootstrap-devnet.mjs \
  --usdc-mint <your-devnet-usdc-mint> \
  --pyth-receiver rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ \
  --rpc https://api.devnet.solana.com
```

This initializes `Config` (skipped if already done) and creates one
`META @ $680, expiry +24h` market by default. It prints every PDA the lifecycle
needs (`Config`, `Market`, `Book`, Yes/No mints, mint authority, escrows).

Customize the market with `--ticker`, `--strike-dollars`,
`--expiry-hours-from-now`, and `--pyth-feed-id` (see
[`scripts/README.md`](../scripts/README.md)). For **real** settlement later, pass
a real `--pyth-feed-id` (an `Equity.US.<TICKER>/USD` feed) and choose an expiry
that lands during market hours.

---

## 4. (Optional) Run the automation morning create-strikes job

Instead of bootstrapping markets one at a time, the automation service can create
the day's MAG7 strike ladder. It reads a reference price off-chain from Hermes,
computes a strike ladder, and `create_strike_market`s each — idempotent (skips
existing markets), with per-ticker failure isolation.

```bash
cd automation && npm install
npm run create-strikes -- --dry-run   # plan + diff only, no on-chain writes
npm run create-strikes                 # actually create the day's markets
```

Configure via env (defaults shown):

```bash
RPC_URL=https://api.devnet.solana.com \
HERMES_URL=https://hermes.pyth.network \
PYTH_RECEIVER=rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ \
ADMIN_KEYPAIR=~/.config/solana/id.json \
TICKERS=AAPL,NVDA,TSLA \
STRIKE_PERCENTS=3,6,9 \
STRIKE_ROUNDING=10 \
EXPIRY_HOURS_FROM_NOW=24 \
  npm run create-strikes
```

The strike ladder follows the PRD: strikes at ±`STRIKE_PERCENTS`% from the
previous close, each rounded to the nearest `$STRIKE_ROUNDING`, deduplicated.
To run both daily jobs automatically on US trading days (08:00 / 16:05 ET),
use the scheduler daemon instead of cron: `npm run start schedule` (see
[`automation/README.md`](../automation/README.md)).

The admin keypair must equal the on-chain `Config.admin` (the wallet that
bootstrapped Config), or `create_strike_market` reverts with `Unauthorized`. See
[`automation/README.md`](../automation/README.md) for the full env table.

---

## 5. Connect a wallet and trade in the frontend

Point the app at devnet and start it:

```bash
cd app && npm install
cp .env.local.example .env.local
```

Edit `app/.env.local`:

```
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_PROGRAM_ID=6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX
# The USDC mint is read from the on-chain Config account, not an env var.
# NEXT_PUBLIC_HERMES_URL=https://hermes.pyth.network   # optional override
```

```bash
npm run dev
```

Then in the browser (Landing → Markets → Trade):

1. **Connect a wallet** (Phantom/Solflare). For a self-contained demo, import
   `~/.config/solana/id.json` — that key is the Config admin and your test-USDC
   mint authority, so the dev toolbar's "Mint test USDC" can sign.
2. Use the **dev toolbar** to airdrop devnet SOL and mint yourself test USDC.
3. On a market's **Trade** page, exercise the four paths — **Buy Yes**,
   **Sell Yes**, **Buy No**, **Sell No** — each a single approval. The book shows
   both the Yes and No perspectives; the position guard blocks the disallowed path
   (e.g. Buy Yes while holding No); the countdown ticks to the 4PM ET expiry.
4. **Portfolio** shows your positions and P&L; **History** shows your executions.

For a quick non-UI sanity check of the trading lifecycle on devnet:

```bash
make demo                 # runs scripts/lifecycle-demo.mjs against devnet (DEMO_RPC defaults to devnet)
```

(`make demo` creates its own fresh market, mints, rests + crosses orders,
cancels, and burns — it does not exercise settle/redeem.)

---

## 6. Wait for expiry

A market can only settle at or after `expiry_unix`. For real oracle settlement,
that expiry must land during US regular trading hours (so a fresh Pyth equity
price exists in the `[expiry, expiry + 15min]` window).

---

## 7. Settle

### 7a. Real Pyth settlement (during market hours)

Single market, via the script:

```bash
cd scripts
node --import tsx post-pyth-update.mjs \
  --ticker META --strike-dollars 680 --expiry-unix <the-market-expiry-unix> \
  --feed-id <the-market-pyth-feed-id-64-hex> \
  --rpc https://api.devnet.solana.com
```

> Run it with `node --import tsx` (not plain `node`): the Pyth receiver dep pulls
> in `jito-ts`, whose ESM imports Node's strict resolver rejects. `tsx` patches
> module resolution. See the header of `post-pyth-update.mjs`.

It fetches the latest Hermes update, posts it through the receiver (creating a
`PriceUpdateV2`), and calls `settle_market`. If the latest update is outside the
settlement window (off-hours), it prints a clear message and exits non-zero —
fall back to 7b.

All open markets, via the automation settle job:

```bash
cd automation
npm run settle
```

The job enumerates open (unsettled, past-expiry) markets, posts a fresh Pyth
update and `settle_market`s each, retrying on stale/wide-confidence errors within
the override grace (default ~15min).

### 7b. Admin-override fallback (off-hours / oracle outage)

If the oracle never delivers a fresh price in the window, settle by hand. On
chain this requires `expiry + 24h` (the emergency grace) to have elapsed, so
normal settlement always gets first claim during the day.

Via the settle job, supplying the operator's settlement price per ticker:

```bash
cd automation
OVERRIDE_PRICES=META=690,AAPL=187.5 npm run settle
```

The job derives `yes_wins = price >= strike` and calls `admin_settle_market`,
alerting on the fallback. (If the 24h grace hasn't elapsed yet, the override
reverts and the job alerts — wait for the grace.) The admin keypair must equal
`Config.admin`.

After settling, the job can optionally run `settle_sweep` to refund resting
orders.

---

## 8. Redeem

Once a market is settled, the winning side redeems 1:1 for USDC. In the
frontend, open the settled market's **Portfolio** entry and click **Redeem** —
the winning Yes (or No) tokens burn and pay out USDC from escrow. The $1 invariant
guarantees escrow is solvent for the winning side regardless of outcome.

---

## Quick reference

| Goal | Command |
|---|---|
| Build | `anchor build` |
| Deploy to devnet | `make devnet-deploy` |
| Bootstrap Config + a market | `cd scripts && node bootstrap-devnet.mjs --usdc-mint <mint> --pyth-receiver rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ --rpc https://api.devnet.solana.com` |
| Create the day's markets | `cd automation && npm run create-strikes` |
| Run the app against devnet | `cd app && npm run dev` (with devnet `app/.env.local`) |
| Lifecycle smoke (no settle) | `make demo` |
| Settle one market (RTH) | `cd scripts && node --import tsx post-pyth-update.mjs --ticker ... --feed-id ... --expiry-unix ...` |
| Settle all open markets | `cd automation && npm run settle` |
| Admin-override settle | `cd automation && OVERRIDE_PRICES=TICKER=price npm run settle` |

**Key addresses (devnet):**

- Program id: `6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX`
- Deploy/admin wallet: `7sYcxc2hbcHuiVWGE9ZR1gM52Sm24Rdp15aED3DdjaYA`
- Pyth receiver: `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`
