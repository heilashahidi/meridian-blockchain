# Meridian Security Audit

Date: 2026-06-04. Method: 8 parallel finder agents across the Anchor program,
automation, frontend, and live Railway deployment; every finding independently
confirmed by two adversarial verifiers (code-truth + exploitability).

## Headline

**No unprivileged attacker can steal funds.** Traced the $1 invariant and every
escrow path: no escrow-drain, double-redeem, wrong-side payout, arithmetic
overflow, or access-control bypass. The arithmetic finder returned zero findings;
authz found no missing signer/`has_one`/PDA check. The CLOB matching engine,
escrow conservation, and admin gating are sound.

The real risks are: **one live-exposed credential**, **market-integrity /
oracle-timing manipulation** that redistributes within a single market (never
insolvency), and **operational/centralization hardening**. Nothing rated
CRITICAL or HIGH after verification.

> Separately, a correctness bug (the 1e6 collateral mismatch) was found outside
> this audit's lens — it conserves escrow (so the audit's fund-safety finders
> correctly passed it) but breaks per-user economics. See `KNOWN-ISSUES.md`.

---

## 🔴 Do first — a valid credential is public

### Helius RPC API key in the client bundle (MEDIUM, confirmed live)
`NEXT_PUBLIC_RPC_URL` is inlined into the client bundle at build
(`app/Dockerfile`, `app/src/lib/program.ts:20`). The deployed chunk contains the
literal `https://devnet.helius-rpc.com/?api-key=…` and the key was confirmed
valid (`getHealth → ok`). Anyone can scrape it and burn the paid quota until the
app's own RPC reads fail.
**Fix:** domain-restrict the key + set a rate cap in Helius (origin allowlist is
the intended model for a public frontend RPC key), or proxy RPC through a server
route with the key in a non-`NEXT_PUBLIC_` var. Devnet-scoped, so MEDIUM.

---

## 🟠 Real exploits (no privileged key needed)

### No self-trade prevention → cost-free wash trading (MEDIUM, confirmed)
`match_step.rs:103-105` documents self-trade prevention as deferred;
`place_order_inner` never filters `maker_owner == taker.owner`. One wallet can
rest then cross its own order. **Escrow-neutral (no theft)** — the same units
cycle back — but it prints fake volume and an attacker-chosen last price on a
thin book. Same gap enables filling the 32-deep book to `BookFull` to block real
makers.
**Fix:** in `place_order_inner`, skip fills where `maker_owner == taker.owner`
(cancel-newest). One change fixes both wash-trade and BookFull grief.

### `settle_market` 900s cherry-pick window (MEDIUM, confirmed)
`settle_market` is permissionless and accepts **any** real Pyth update with
`publish_time ∈ [expiry, expiry+900]`, with no earliest/latest anchoring
(`settle_market.rs:198-215`). For a near-the-money market that crosses the strike
in that 15-min band, a holder posts the in-window tick on their side and settles
before the cranker → redistributes the escrow. Bounded: the price can't be forged
(real Wormhole-verified Pyth required), so it only works on genuinely oscillating
near-money markets.
**Fix:** shrink `SETTLE_WINDOW_SECONDS` to ~30-120s, anchor to earliest-in-window
or a short TWAP, or make `settle_market` cranker-gated.

### `/api/insights` unauthenticated LLM proxy (MEDIUM, confirmed live)
Anonymous POST → real Claude call on the server's `ANTHROPIC_API_KEY`. No auth,
no rate limit, no origin check (verified live; no `middleware.ts`). Per-call cost
is capped (500/4000/320 on Haiku) but request volume isn't.
**Fix:** per-IP rate limit (middleware), Origin allowlist, daily spend alarm.

---

## 🟡 Operational hardening

- **Worker logs the RPC URL (with key) in cleartext** on every job start
  (`automation/src/index.ts:183`) → key lands in Railway logs.
  **Fix:** redact URL credentials in `log.ts`.
- **`OVERRIDE_PRICES` decides settlement on an over-privileged hot key** — the
  automation admin key is also `config.admin` and the upgrade authority. A bad
  env value force-settles markets. Privileged misuse, not a bypass.
  **Fix:** price-deviation sanity check; split the settler key from admin;
  dual-control on override.
- **`admin_settle_market` picks an arbitrary outcome with no oracle check**
  (`admin.rs:96-127`) — emergency power by design; a rogue admin could direct a
  market 24h post-expiry. (One verifier rated LOW: the admin already holds
  upgrade authority, a strictly stronger capability.)
  **Fix:** require an oracle price in the admin path; multisig; timelock.
- **Missing security headers** (no `CSP`/`HSTS`/`X-Frame-Options`/
  `X-Content-Type-Options`; `x-powered-by` leaks Next.js).
  **Fix:** `next.config` `headers()`.
- **`npm audit` (prod): 101 vulns (1 critical, 13 high)** — mostly transitive
  wallet-adapter. **Fix:** `npm audit fix`; review the critical one.

---

## ⚪ Design / centralization

- **No admin rotation / multisig** — `config.admin` set once, no `set_admin`. Key
  loss is unrecoverable without a redeploy. Add two-step `set_admin` + multisig.
- **`pyth_receiver` stored unvalidated at init** and `require_full_verification`
  is admin-downgradable — validate against the known Pyth receiver program ID.
- **`settle_sweep` liveness** depends on an honest cranker; a closed ATA defers a
  refund (recoverable via `cancel_order`, never lost).
