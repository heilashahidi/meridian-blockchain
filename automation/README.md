# meridian-automation

The daily automation service for the Meridian on-chain CLOB. Two jobs, plus a
built-in scheduler that fires them automatically on US trading days:

- **`create-strikes`** (morning, ~08:00 ET) — for each configured MAG7 stock,
  read a reference price (off-chain, from Hermes), compute the PRD strike ladder
  (±3/6/9% from the previous close, rounded to the nearest $10, deduplicated),
  and `create_strike_market` for each. Idempotent (skips existing markets), with
  per-strike retry/backoff and per-ticker failure isolation.
- **`settle`** (after close, ~16:05 ET) — settle every open/expired market via
  the Pyth pull oracle, with retry (every 30s for up to 15 min) and an
  admin-override fallback.
- **`schedule`** (daemon) — a dependency-free poll loop that fires
  `create-strikes` at ~08:00 ET and `settle` at ~16:05 ET, **only on US trading
  days** (weekends and NYSE holidays are skipped via `src/tradingCalendar.ts`).
  ET wall times are DST-correct (ICU, not manual offset math); each job fires at
  most once per day; a job failure is logged + escalated but never crashes the
  daemon. Ctrl-C (SIGINT/SIGTERM) stops it after the current tick.

## Layout

```
src/
  config.ts        MAG7 tickers + Pyth feed IDs, PRD strike algorithm
                   (computeStrikes: ±%/rounded-to-$10), env config, validators
  client.ts        Anchor program client (with the in-memory Book IDL patch)
                   + PDA helpers (mirrors app/src/lib/{program,pdas,idlPatch})
  pyth.ts          SHARED Pyth helper — Hermes fetch + receiver post
                   (fetchLatestPriceUpdate / postPriceUpdate / fetchAndPostLatest)
  tradingCalendar.ts  ET wall-clock (DST-correct) + US trading-day predicate
                      (weekend + NYSE holiday table, 2025–2027)
  scheduler.ts     poll-loop daemon: dueJobs() decision (pure) + runScheduler()
  log.ts           JSON-lines leveled logging + alert() escalation seam
  jobs/
    createStrikes.ts  morning create-strikes job: plan → diff → create,
                      idempotent + retry/backoff + per-ticker isolation
    settle.ts         after-close settle job: Pyth settle + retry + admin override
  index.ts         CLI entry: `create-strikes [--dry-run]` | `settle` |
                   `schedule` | --help
  liveTestEnv.ts   guards for the guarded live integration test
  idl/             vendored copy of the Meridian IDL (json + types)
test/              vitest suites (config, client, cli, scheduler, settle,
                   createStrikes, + guarded *.live)
```

## Build & run

```sh
cd automation
npm install
npm run build          # tsc -> dist/
npm test               # vitest (offline tests pass; live test auto-skips)

# Run a job once (via tsx, no build step needed):
npm run create-strikes              # morning job (needs a reachable, bootstrapped cluster)
npm run create-strikes -- --dry-run # plan + diff only; no on-chain writes
npm run settle                      # after-close settle job

# Or directly:
node --import tsx src/index.ts --help
node --import tsx src/index.ts schedule   # run as a daemon (08:00/16:05 ET, trading days)
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
| `STRIKE_PERCENTS` | `3,6,9` | Comma-separated % offsets from prev close (PRD ±3/6/9%) |
| `STRIKE_ROUNDING` | `10` | Round each strike to the nearest $N (PRD nearest $10) |
| `EXPIRY_HOURS_FROM_NOW` | `24` | Market expiry horizon |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ALERT_WEBHOOK` | _(unset)_ | Optional webhook URL for `alert()` escalations |
| `SCHEDULE_MORNING_ET` | `08:00` | (`schedule`) ET time to fire create-strikes, `HH:MM` |
| `SCHEDULE_SETTLE_ET` | `16:05` | (`schedule`) ET time to fire settle, `HH:MM` |
| `SCHEDULE_TICK_MS` | `60000` | (`schedule`) poll interval in ms |

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
