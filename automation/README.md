# meridian-automation

The daily automation service for the Meridian on-chain CLOB. Two jobs, run by
cron or by hand:

- **`create-strikes`** (morning) — for each configured MAG7 stock, read a
  reference price (off-chain, from Hermes), compute a strike ladder, and
  `create_strike_market` for each. Idempotent (skips existing markets), with
  per-strike retry/backoff and per-ticker failure isolation. *(Implemented — U4.)*
- **`settle`** (after close) — settle every open/expired market via the Pyth
  pull oracle, with retry and an admin-override fallback. *(Implemented in U5.)*

U3 shipped the **scaffold**: shared config, the Anchor client, the shared Pyth
helper, structured logging, and the CLI entry. U4 adds the `create-strikes`
job body (`src/jobs/createStrikes.ts`); `settle` remains a seam that throws
"not implemented (U5)" until U5 lands.

## Layout

```
src/
  config.ts        MAG7 tickers + Pyth feed IDs, strike spacing, env config,
                   computeStrikes() ladder helper, validators
  client.ts        Anchor program client (with the in-memory Book IDL patch)
                   + PDA helpers (mirrors app/src/lib/{program,pdas,idlPatch})
  pyth.ts          SHARED Pyth helper — Hermes fetch + receiver post
                   (fetchLatestPriceUpdate / postPriceUpdate / fetchAndPostLatest)
  log.ts           JSON-lines leveled logging + alert() escalation seam
  jobs/
    createStrikes.ts  morning create-strikes job (U4): plan → diff → create,
                      idempotent + retry/backoff + per-ticker isolation
  index.ts         CLI entry: `create-strikes [--dry-run]` | `settle` | --help
  liveTestEnv.ts   guards for the guarded live integration test
  idl/             vendored copy of the Meridian IDL (json + types)
test/              vitest suites (config, client, cli, + guarded client.live)
```

## Build & run

```sh
cd automation
npm install
npm run build          # tsc -> dist/
npm test               # vitest (offline tests pass; live test auto-skips)

# Run a job (via tsx, no build step needed):
npm run create-strikes              # morning job (needs a reachable, bootstrapped cluster)
npm run create-strikes -- --dry-run # plan + diff only; no on-chain writes
npm run settle                      # → "not implemented (U5)" until U5 lands

# Or directly:
node --import tsx src/index.ts --help
```

## Environment variables

All env-driven with sane defaults (devnet + the canonical Pyth receiver):

| Var | Default | Purpose |
| --- | --- | --- |
| `RPC_URL` | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `HERMES_URL` | `https://hermes.pyth.network` | Pyth Hermes endpoint (may move to an API-key model — see below) |
| `PYTH_RECEIVER` | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` | Pyth receiver program (matches on-chain `Config.pyth_receiver`) |
| `ADMIN_KEYPAIR` | `~/.config/solana/id.json` | Admin keypair (must equal on-chain `Config.admin`) |
| `TICKERS` | `AAPL,NVDA,TSLA` (demo subset) | Comma-separated subset of the MAG7 |
| `STRIKES_PER_SIDE` | `3` | Strikes each side of the reference price |
| `EXPIRY_HOURS_FROM_NOW` | `24` | Market expiry horizon |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ALERT_WEBHOOK` | _(unset)_ | Optional webhook URL for `alert()` escalations |

## Notes

- **MAG7 + feed IDs.** The canonical Magnificent Seven (AAPL, MSFT, GOOGL, AMZN,
  NVDA, META, TSLA) plus GOOG, each mapped to its **regular-session**
  `Equity.US.<TICKER>/USD` Pyth feed ID (resolved from Hermes). Equity feeds are
  only fresh during US regular trading hours; off-hours the settle job falls
  back to admin-override.
- **The Book IDL patch.** The program keeps its matching-engine types out of the
  generated IDL, so `new Program(idl)` throws `Type not found: bids`. `client.ts`
  re-adds `OrderKey`/`OrderEntry`/`BookSide32` and flattens `Book.bids/asks` in
  memory before constructing the program — identical to `app/src/lib/idlPatch.ts`.
- **Hermes API-key transition.** The public Hermes endpoint is moving to an
  API-key model. Pass a token via `makeHermesClient(url, token)` when needed; the
  endpoint is already env-configurable.
- **`pyth.ts` is shared.** It is the foundation U2 (settlement script) and U5
  (settle job) build on. See its exported signatures for the contract.
