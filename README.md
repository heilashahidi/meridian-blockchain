# meridian-blockchain

Minimal on-chain CLOB for binary outcome markets, built as a single Anchor 1.0
program with a pure-Rust matching engine module.

See [`docs/plans/2026-05-27-001-feat-minimal-onchain-clob-plan.md`](docs/plans/2026-05-27-001-feat-minimal-onchain-clob-plan.md)
for the implementation plan and
[`docs/brainstorms/minimal-clob-scope-requirements.md`](docs/brainstorms/minimal-clob-scope-requirements.md)
for the scope rationale.

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
