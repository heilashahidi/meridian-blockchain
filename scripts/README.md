# Meridian scripts

One-off off-chain tooling for the Meridian on-chain CLOB. **Not** the production
lifecycle automation service — that's a separate workstream (see plan
§"System-Wide Impact").

## What's here

| File | Purpose |
|---|---|
| `local-dev.sh` | Boot a local validator, deploy the program, create a local USDC mint, bootstrap `Config` + a market, and write `app/.env.local`. The validator + bootstrap half of `make dev`. |
| `deploy-devnet.sh` | Deploy the program to devnet. Preflights the deploy wallet's SOL balance and refuses a partial deploy if underfunded. The `make devnet-deploy` entry point. |
| `bootstrap-devnet.mjs` | Initialize `Config` + create one strike market. Idempotent. Cluster-agnostic via `--rpc` (used for both localnet and devnet). |
| `lifecycle-demo.mjs` | Exercise create → mint → trade → cancel → burn end-to-end against a running cluster. The `make demo` entry point. `--rpc` selects the cluster. |
| `forge-pyth-account.mjs` | Forge a byte-exact `PriceUpdateV2` genesis fixture so `settle_market` can run on a vanilla localnet (no real Pyth). |
| `settle-redeem-demo.{sh,mjs}` | Drive `settle_market` + `redeem` on a dedicated localnet using a forged Pyth account. |

## One-command setup (Makefile)

These scripts are normally driven from the repo-root `Makefile`:

```bash
make dev            # local validator + bootstrap + app dev server (runs local-dev.sh)
make devnet-deploy  # deploy to devnet, balance-preflighted (runs deploy-devnet.sh)
make demo           # create → mint → trade lifecycle (runs lifecycle-demo.mjs)
```

`make demo` targets devnet by default; override with `make demo DEMO_RPC=http://127.0.0.1:8899`
to run against the local validator started by `make dev`.

### Devnet deploy + lifecycle (manual equivalent)

```bash
anchor build
make devnet-deploy        # fails fast with a fund-this-address message if < 8 SOL

# Bootstrap Config + a market on devnet. Use a USDC mint you control (so the
# demo can mint test USDC), e.g. spl-token create-token --decimals 6 --url devnet.
cd scripts && node bootstrap-devnet.mjs \
  --usdc-mint <your-devnet-usdc-mint> \
  --pyth-receiver rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ \
  --rpc https://api.devnet.solana.com

make demo                 # runs lifecycle-demo.mjs against devnet
```

## Prerequisites

- Node 20+
- A funded devnet keypair at `~/.config/solana/id.json` (or pass `--keypair`)
- A devnet USDC mint pubkey (canonical: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` — verify in current docs before pointing real funds at it)
- The Pyth Receiver program ID for devnet (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` as of 2026 — verify with current Pyth docs)
- `anchor build` already run from the repo root (the script reads `target/idl/meridian.json`)

## Setup

```bash
cd scripts
npm install
```

## Bootstrap devnet

```bash
node bootstrap-devnet.mjs \
  --usdc-mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU \
  --pyth-receiver rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ
```

What happens:
1. Loads the IDL from `../target/idl/meridian.json` and the program ID from it.
2. Loads your keypair, connects to devnet.
3. Initializes `Config` (skipped if already initialized).
4. Creates one strike market for `META @ $680, expiry +24h` (skipped if the
   `(ticker, strike, expiry)` triple already has a market).
5. Prints every PDA the lifecycle scripts will need: `Config`, `Market`, `Book`,
   `Yes mint`, `No mint`, mint authority, USDC escrow, Yes escrow.

### Customizing

```
--ticker META                    # 8-byte ASCII, right-padded
--strike-dollars 680             # converted to USDC microunits
--expiry-hours-from-now 24       # added to current unix timestamp
--pyth-feed-id <64-hex-chars>    # default: all-ones placeholder
--fee-authority <pubkey>         # default: payer keypair
--keypair <path>                 # default: ~/.config/solana/id.json
--rpc <url>                      # default: https://api.devnet.solana.com
```

## What this script does **not** do

- Mint pairs / place orders / settle / redeem — those are next-step demo
  scripts and ultimately the lifecycle automation service.
- Verify the Pyth feed ID actually exists on devnet — the feed id is stored on
  the Market but only validated at `settle_market` time. Use a placeholder for
  smoke-testing the market lifecycle and swap to a real Pyth feed id before any
  settle.
- Mint test USDC. The USDC mint must already exist on devnet. Use the canonical
  devnet USDC, or create your own via:
  ```
  spl-token create-mint --decimals 6 --url devnet
  spl-token create-account <mint> --url devnet
  spl-token mint <mint> 1000000 --url devnet      # 1.0 USDC
  ```

## Production deployment posture

This script targets devnet. Before pointing at mainnet:

1. The Pyth Receiver program ID must be the real Pyth mainnet receiver, not a test/placeholder. The `pyth_receiver` field is what `settle_market` validates every price-update account against.
2. The USDC mint must be Circle's canonical mint. The script warns if `decimals != 6`.
3. Review the open P1 residuals in PR #1's description — most affect the production deployment posture (stuck-oracle deadlock, oracle window selection, ATA-close DoS, `VerificationLevel::Full` skip).
