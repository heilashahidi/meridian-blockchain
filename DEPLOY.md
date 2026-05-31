# Deploying Meridian

Meridian has three deployable pieces:

| Piece | Where it runs | Status |
|-------|---------------|--------|
| **Solana program** (`programs/meridian`) | Solana **devnet** | Already deployed — `scripts/deploy-devnet.sh` (PRD's required deployment) |
| **Web app** (`app/`) | Railway service (public) | This guide |
| **Automation worker** (`automation/`) | Railway service (no port) | This guide |

The PRD only *requires* the on-chain program on devnet plus reproducible scripts;
it does not mandate a web host ("Cloud Platforms: None specified but likely needs
cloud hosting for automation service"). Railway is a good fit because the
automation worker is a **long-running daemon** (the scheduler), which serverless
hosts can't run.

> The program is already on devnet — Railway hosts only the app + worker, both
> pointed at the devnet RPC. Nothing here touches mainnet or real funds.

---

## Devnet addresses (point both services at these)

```
Program ID    6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX
Config PDA    EFvqFAxw9ihw2nim2WxZVsnVqKBcnkv3gwwbfZXZUFTA
USDC mint     EzYKgPixrCfArjHvarmKorv97cgmmFKUYYHpTbbX4J3Z
Pyth receiver rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ
```

Use a devnet RPC with history (the public `api.devnet.solana.com` rate-limits;
a Helius devnet key is recommended): `https://devnet.helius-rpc.com/?api-key=…`

---

## One-time setup

1. Create a Railway project from this GitHub repo.
2. Add **two services**, both from the same repo:
   - **web** — set **Root Directory** = `app`
   - **automation** — set **Root Directory** = `automation`
   Each directory has a `Dockerfile` + `railway.json`, so Railway builds them
   deterministically (no Nixpacks guessing).

---

## Service 1 — web (`app/`)

Generate a public domain (Railway → service → Settings → Networking). The
container listens on `$PORT` (Railway sets it; the Dockerfile defaults to 3000).

**Build-time variables** (NEXT_PUBLIC_* are inlined into the client bundle, so
they must be set *before the build* — Railway exposes service variables to the
Docker build as args):

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_RPC_URL` | your devnet RPC URL |
| `NEXT_PUBLIC_PROGRAM_ID` | `6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX` |
| `NEXT_PUBLIC_DEMO_WALLET` | *(optional)* a read-only pubkey to preview the dashboard / portfolio / history when logged out |
| `NEXT_PUBLIC_HERMES_URL` | *(optional)* defaults to `https://hermes.pyth.network` |

> The USDC mint is **not** an env var: the app reads it from the on-chain
> `Config` account (`fetchConfig` → `c.usdcMint`), the single source of truth, so
> a build-time value would only drift from on-chain.

**Runtime variables** (read server-side at request time — the insights chat):

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-…` *(optional; without it the chat uses the deterministic on-chain fallback)* |
| `ANTHROPIC_MODEL` | *(optional)* defaults to `claude-haiku-4-5-20251001` |

> If you change a `NEXT_PUBLIC_*` value you must **redeploy** (rebuild) — they are
> baked in at build time, not read at runtime.

---

## Service 2 — automation (`automation/`)

No public domain needed (it's a worker). It runs `node dist/index.js schedule`
— the daemon that fires create-strikes ~08:00 ET and settle ~16:05 ET.

| Variable | Value |
|----------|-------|
| `RPC_URL` | your devnet RPC URL |
| `PYTH_RECEIVER` | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` |
| `HERMES_URL` | *(optional)* defaults to `https://hermes.pyth.network` |
| `TICKERS` | *(optional)* e.g. `AAPL,MSFT,GOOGL,AMZN,NVDA,META,TSLA` (default: `AAPL,NVDA,TSLA`) |
| `STRIKE_PERCENTS` | *(optional)* default `3,6,9` |
| `ADMIN_KEYPAIR_JSON` | **secret** — the admin keypair as a JSON byte array (see below) |

### The admin keypair (secret)

The worker signs create-strike / settle transactions with the admin keypair.
The loader reads a *file*, but containers have no persistent key file, so we
inject the secret as JSON and the entrypoint writes it to a tmp file:

```bash
# Copy the JSON array (NOT a path) into the ADMIN_KEYPAIR_JSON Railway secret:
cat ~/.config/solana/id.json
# → [12,34,...]  paste this whole array as the value
```

`docker-entrypoint.sh` writes `$ADMIN_KEYPAIR_JSON` to `/tmp/admin-keypair.json`
and sets `ADMIN_KEYPAIR` to that path before the daemon starts.

> This is a **devnet** key holding test funds only. Never put a mainnet /
> real-funds key here. Fund the admin with devnet SOL (`solana airdrop`) so it
> can pay transaction fees.

---

## Verify after deploy

- **web**: open the Railway domain → dashboard should render markets, prices
  tick from Hermes during US market hours, and the insights chat returns Claude
  answers (or the fallback if no key). History/heatmap populate from devnet RPC.
- **automation**: check the service logs for scheduler ticks
  (`scheduler: next create-strikes at …`). Manually trigger once with a
  one-off: run `create-strikes` / `settle` from the Railway service shell, or
  locally with the same env.

## Local parity

```bash
# web
cd app && npm run build && npm start
# automation daemon
cd automation && npm run build && npm run start:prod
```
