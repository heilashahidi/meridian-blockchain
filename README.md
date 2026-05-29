# Meridian

A non-custodial **MAG7 binary-options dApp on Solana devnet**. Trade daily
"will [STOCK] close above [STRIKE]?" contracts: one Yes + one No token always
cost exactly $1 (the mint-pair invariant), so a Yes token pays $1 if the stock
closes at/above the strike and $0 otherwise. Orders match on an **on-chain
central limit order book** (a pure-Rust matching engine inside a single Anchor
program); settlement reads a real **Pyth pull-oracle** equity price.

Three layers, one repo:

- **`programs/meridian/`** — the Anchor program: the CLOB matching engine, the
  $1 mint/burn invariant, the four trade paths, Pyth settlement, redeem, and
  admin controls.
- **`automation/`** — a TypeScript service with two cron jobs: a morning
  `create-strikes` job and an after-close `settle` job (with an admin-override
  fallback).
- **`app/`** — a Next.js frontend: 5 pages (Landing, Markets, Trade, Portfolio,
  History) with live prices, both-perspective order book, the four Buy/Sell
  Yes/No trade paths, position constraints, settlement countdown, and P&L.

For the full design, trade-offs, and known limitations see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). To deploy and run the lifecycle
on devnet step by step, see [`docs/DEVNET-RUNBOOK.md`](docs/DEVNET-RUNBOOK.md).

---

## One-command local setup

From a clean clone (after the [prerequisites](#prerequisites)):

```bash
anchor build      # produces target/deploy/meridian.so + target/idl/meridian.json
make dev          # boot a local validator, bootstrap Config + a market, start the app
```

`make dev` runs `scripts/local-dev.sh` then starts the Next.js dev server. The
script:

1. Boots a fresh background `solana-test-validator`.
2. Airdrops local SOL and creates a throwaway 6-decimal USDC mint (the keypair
   becomes its mint authority, so the dev toolbar can mint test USDC).
3. Deploys the program and waits until it is invokable.
4. Runs `scripts/bootstrap-devnet.mjs` against localnet to initialize `Config`
   and one strike market.
5. Writes `app/.env.local` pointing the frontend at the local validator.

The Next.js dev server runs in the foreground (Ctrl-C to stop). The validator
keeps running in the background; stop it with `pkill -f solana-test-validator`.

Run `make help` to list all targets.

### Run the trading lifecycle locally

```bash
make demo DEMO_RPC=http://127.0.0.1:8899
```

This runs `scripts/lifecycle-demo.mjs` against the local validator: it creates a
fresh market, mints a pair, rests + crosses orders (with a price-improvement
refund), cancels an order, and burns a pair — exiting non-zero on any failure.
(`settle_market` + `redeem` are not exercised here; they need a real Pyth
`PriceUpdateV2` and are covered by the LiteSVM suite and the devnet runbook.)

---

## Deploy to devnet

The deploy is **one command once the wallet is funded**. Funding (~8 SOL) is a
documented human step — the devnet faucet is rate-limited.

```bash
anchor build
make devnet-deploy   # idempotent; preflights the deploy wallet's SOL balance
```

`make devnet-deploy` runs `scripts/deploy-devnet.sh`, which:

1. **Preflights the balance** of the deploy wallet (the Anchor provider wallet,
   `~/.config/solana/id.json`; override with `KEYPAIR=...`). If it holds less
   than `MIN_SOL` (default **8 SOL**), it exits non-zero **without touching the
   cluster** (no partial deploy) and prints the exact address to fund and the
   shortfall.
2. Runs `anchor deploy --provider.cluster devnet` (idempotent — upgrades in
   place at the same program id).
3. Polls `solana program show` until the program is confirmed invokable.

### Fund the deploy wallet

The project's known deploy/admin wallet is:

```
7sYcxc2hbcHuiVWGE9ZR1gM52Sm24Rdp15aED3DdjaYA
```

Fund it with **at least ~8 devnet SOL** before deploying:

```bash
solana airdrop 2 7sYcxc2hbcHuiVWGE9ZR1gM52Sm24Rdp15aED3DdjaYA --url devnet   # repeat; faucet-rate-limited
# or the web faucet: https://faucet.solana.com  (paste the address)
# or transfer from another funded devnet wallet
```

(If you deploy with a different keypair, `deploy-devnet.sh` notes the mismatch
and uses your wallet's address in the funding message.)

After deploy, bootstrap `Config` + a market and run the lifecycle:

```bash
cd scripts && node bootstrap-devnet.mjs \
  --usdc-mint <your-devnet-usdc-mint> \
  --pyth-receiver rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ \
  --rpc https://api.devnet.solana.com

make demo            # create -> mint -> trade against devnet (DEMO_RPC defaults to devnet)
```

The full deploy → bootstrap → automate → trade → settle → redeem walkthrough,
including real Pyth settlement and the off-hours admin-override fallback, is in
[`docs/DEVNET-RUNBOOK.md`](docs/DEVNET-RUNBOOK.md).

---

## Prerequisites

- **Rust** 1.78+
- **Solana CLI** 1.18+ (or current 2026 release) — `solana`, `solana-test-validator`, `spl-token`
- **Anchor CLI** 1.0.0 (`avm install 1.0.0 && avm use 1.0.0`)
- **Node** 20+
- A Solana keypair at `~/.config/solana/id.json`
- For devnet: that keypair funded with ~8 SOL (see above)

---

## Tests

All three layers have their own suites.

### On-chain program (Rust)

```bash
# Pure-Rust unit tests (matching engine + price-scaling math; no Solana toolchain needed).
cargo test -p meridian --lib

# LiteSVM integration tests — the full instruction set against an in-process SVM,
# including settle/redeem with a forged PriceUpdateV2 (u3..u8 suites).
cargo test -p meridian-litesvm-tests

# Trident fuzz harness — multi-instruction-sequence invariant fuzzing
# (R13 escrow reconciliation, R14 Yes/No supply parity, token conservation).
cd trident-tests
TRIDENT_ITERATIONS=100000 TRIDENT_FLOW_CALLS=10 trident fuzz run clob_invariants
# (smoke run: TRIDENT_ITERATIONS=500 TRIDENT_FLOW_CALLS=30 trident fuzz run clob_invariants)
```

See [`trident-tests/README.md`](trident-tests/README.md) for the fuzz harness
details (and why `--cases` is set via env vars, not a CLI flag, in Trident
v0.12).

### Automation service (TypeScript)

```bash
cd automation && npm install && npm test     # vitest; offline tests pass, live tests auto-skip
```

### Frontend (TypeScript)

```bash
cd app && npm install && npm test            # vitest; pure logic tests pass offline, *.live.test.ts
                                             # auto-skip unless a validator is up
```

The `*.live.test.ts` suites (`app/src/lib/place.live.test.ts`,
`mintburn.live.test.ts`, `read.live.test.ts`, and the automation `*.live.test.ts`)
require a running, bootstrapped cluster and are skipped otherwise.

---

## Repo layout

```
programs/meridian/        Anchor program (the on-chain CLOB)
  src/
    lib.rs                #[program] entry — 15 instructions
    instructions/         one file per instruction (mint_pair, place_limit_order,
                          buy_no, sell_no, settle_market, redeem, admin, ...)
    matching/             pure-Rust matching engine (order_key, book_side, match_step)
    state/                Config, Market, Book, vendored Pyth PriceUpdateV2
tests/litesvm/            LiteSVM integration suite (u3..u8)
trident-tests/            Trident fuzz harness (clob_invariants)
automation/               daily jobs: create-strikes + settle (TypeScript/Node)
  src/{config,client,pyth,log,index}.ts, src/jobs/{createStrikes,settle}.ts
app/                      Next.js frontend (5 pages + lib + components)
  src/app/{page,markets,trade/[market],portfolio,history}
  src/lib/{prices,tradePaths,pnl,idlPatch,matching,...}.ts
scripts/                  one-off tooling: local-dev.sh, deploy-devnet.sh,
                          bootstrap-devnet.mjs, lifecycle-demo.mjs, post-pyth-update.mjs
docs/                     ARCHITECTURE.md, DEVNET-RUNBOOK.md, plans/, brainstorms/
Makefile                  make dev | make devnet-deploy | make demo | make build | make help
```
