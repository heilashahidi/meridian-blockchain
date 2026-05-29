# meridian-blockchain

Minimal on-chain CLOB for binary outcome markets, built as a single Anchor 1.0
program with a pure-Rust matching engine module.

See [`docs/plans/2026-05-27-001-feat-minimal-onchain-clob-plan.md`](docs/plans/2026-05-27-001-feat-minimal-onchain-clob-plan.md)
for the implementation plan and
[`docs/brainstorms/minimal-clob-scope-requirements.md`](docs/brainstorms/minimal-clob-scope-requirements.md)
for the scope rationale.

## Quick start / one-command setup

From a clean clone (after the prerequisites below):

```bash
anchor build      # produces target/deploy/meridian.so + the IDL
make dev          # boot a local validator, bootstrap Config + a market, start the app
```

`make dev` boots a local `solana-test-validator` in the background, deploys the
program, creates a throwaway local USDC mint, runs `bootstrap-devnet.mjs` to
initialize `Config` + one strike market, writes `app/.env.local`, and then starts
the Next.js dev server in the foreground. Stop the app with Ctrl-C, then stop the
validator with `pkill -f solana-test-validator`.

### Run the trading lifecycle

```bash
make demo DEMO_RPC=http://127.0.0.1:8899   # create → mint → trade against your local validator
```

### Deploy to devnet

```bash
make devnet-deploy   # idempotent; preflights the deploy wallet's SOL balance
make demo            # create → mint → trade against devnet (DEMO_RPC defaults to devnet)
```

`make devnet-deploy` requires the deploy wallet (`~/.config/solana/id.json`, the
Anchor provider wallet) to hold ~8 SOL of devnet SOL. If it is underfunded the
command exits non-zero **without** a partial deploy and prints the exact address
to fund and the shortfall. Funding is a documented human step (faucet/transfer);
see `scripts/README.md`.

Run `make help` to list all targets.

## Prerequisites

- Rust 1.78+
- Solana CLI 1.18+ (or current 2026 release)
- Anchor CLI 1.0.0 (`avm install 1.0.0 && avm use 1.0.0`)
- A Solana keypair at `~/.config/solana/id.json`

## Build and test

```bash
# Build the Anchor program (produces target/deploy/meridian.so)
anchor build

# Run the pure-Rust matching engine tests (28 tests, ~7s, no Solana toolchain needed)
cargo test -p meridian --lib matching::tests
```

## Layout

```
programs/meridian/
├── Cargo.toml          # Anchor program crate
├── Xargo.toml          # BPF target stdlib config
└── src/
    ├── lib.rs          # Anchor program entry (#[program] stub at U1)
    ├── error.rs        # MeridianError codes
    └── matching/       # Pure-Rust matching engine (U2)
        ├── order_key.rs
        ├── book_side.rs
        ├── match_step.rs
        └── tests.rs    # proptest invariants
```

Instruction handlers (`initialize_config`, `mint_pair`, `place_limit_order`,
`buy_no`, `settle_market`, etc.) land in U3-U7 — see the plan.

## Environment

Copy `.env.example` to `.env` and fill in the values you need. The defaults
target Solana devnet.
