# Meridian Trident Fuzz Harness (U9)

Multi-instruction-sequence fuzz coverage of the Meridian CLOB's R13 / R14 /
token-conservation invariants. Per plan U9.

## Layout

`trident init` (Trident v0.12.0) scaffolded into `trident-tests/` rather
than the plan's `tests/trident/` path. Trident's CLI insists on its own
directory name, so we follow Trident's convention.

```
trident-tests/
├── Cargo.toml              # standalone Cargo workspace (Trident's choice)
├── Trident.toml            # points at ../target/deploy/meridian.so
├── clob_invariants/
│   ├── test_fuzz.rs        # the FuzzTest impl + flows + invariants
│   ├── fuzz_accounts.rs    # auto-generated (unused — see test_fuzz.rs)
│   └── types.rs            # auto-generated wire shape (documentation only)
└── README.md               # this file
```

## What's fuzzed

Seven `#[flow]`-tagged instructions, randomly composed across 2 markets
and 3 users:

* `mint_pair`, `burn_pair`
* `place_limit_order`, `place_market_order`, `cancel_order`
* `buy_no`, `sell_no`

After every flow step the harness asserts:

* **R13 (escrow reconciliation):** `usdc_escrow_balance ==
  sum(open_bid.qty * open_bid.price)` AND `yes_escrow_balance ==
  sum(open_ask.qty)`.
* **R14 (Yes/No supply parity):** `yes_mint.supply == no_mint.supply`.
* **Token conservation:** sum(USDC across user ATAs + all USDC escrows) ==
  initial seeded total.

## Deviation: settle / sweep / redeem out-of-scope

Plan U9's instruction list also includes `settle_market`, `settle_sweep`,
and `redeem`. Planting a fake `PriceUpdateV2` account for `settle_market`
requires the meridian program as account owner and the vendored
Borsh-serialized layout — doable but heavy. The plan §U9 Approach
explicitly notes: *"If Trident's instruction generation can't handle the
Pyth account requirement, scope settle_market out of the fuzz sequence
for U9 — just fuzz the pre-settle instructions."* We do that here; the
settle-race scenario is already covered by LiteSVM's `settle_race_test.rs`
in U8.

## Running

```bash
# Smoke run (5 seconds, ~10k ops):
cd trident-tests
TRIDENT_ITERATIONS=500 TRIDENT_FLOW_CALLS=30 trident fuzz run clob_invariants

# Full 100K cases (plan §U9 verification target, ~45s):
TRIDENT_ITERATIONS=100000 TRIDENT_FLOW_CALLS=10 trident fuzz run clob_invariants

# Or run the binary directly to skip Trident's metric table:
TRIDENT_ITERATIONS=100000 TRIDENT_FLOW_CALLS=10 \
  ./target/release/clob_invariants
```

Trident v0.12 does **not** expose `--cases` as a CLI flag (only `<TARGET>`
and `[SEED]`). The plan's `trident fuzz run clob_invariants --cases
100000` syntax is aspirational for a future Trident release; for now we
control iteration count via environment variables read in `main()`.

## Reproducing a failure

When the harness panics on an invariant violation, Trident emits the seed
in the "Assertion failed at <file>:<line>: ... (seed: <hex>)" line. To
replay:

```bash
TRIDENT_FUZZ_DEBUG=<seed-hex> trident fuzz run clob_invariants
```

(`TRIDENT_FUZZ_DEBUG` runs single-iteration with the given seed.)

## Known limitations

* All "users" share the trident default-payer keypair. Trident's
  `process_transaction` only signs with `payer()`, so distinct user
  identities aren't achievable in v0.12 without per-flow keypair
  injection. Consequence: cancel-by-non-owner can't be exercised here —
  that case is covered by `tests/litesvm/tests/u5_orders_and_cancel.rs`.
* The `unused` `AddressStorage` slots in `fuzz_accounts.rs` are an
  artifact of `trident init`'s scaffold. The harness derives PDAs by hand
  in `bootstrap()` instead.
