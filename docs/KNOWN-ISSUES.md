# Known Issues & Outstanding Fixes

One place to track what's broken, what's planned, and what's done. Updated
2026-06-05.

Legend: 🔴 critical · 🟠 high-value · 🟡 hardening · ✅ done · 🛠 in progress · 📋 planned

---

## Correctness

### 🛠 1e6 collateral unit mismatch (No-side trades + Yes redemption)
**The big one.** The order book prices a token in `[0, ONE_USDC]` µUSDC (= $0–$1),
but `mint_pair`/`burn_pair`/`redeem` collateralized **1 µUSDC per token** instead
of **$1.00**. The two unit systems disagreed by 1,000,000×.

- **Symptoms:** `Buy No` / `Sell No` revert with `InvalidAmount` and show negative
  proceeds; a Yes bought for $0.72 would `redeem` for $0.000001 even when it wins.
- **Root cause:** current code violates the PRD vault invariant
  (`Vault = $1.00 × pairs`); it held `escrow == supply` (1 µUSDC/token).
- **Fix (implemented, branch `fix/no-side-1e6-collateral`):** multiply the USDC
  amount by `ONE_USDC` in the three transfers — `mint_pair_inner`,
  `burn_pair_inner`, `redeem_handler` — plus a `pub const ONE_USDC` in `lib.rs`.
  Order book unchanged (already correct). New invariant:
  `usdc_escrow == supply * ONE_USDC`. Host-compiles clean.
- **NOT yet deployed.** Requires: (a) an SBF build (blocked locally by a
  `getrandom`/platform-tools toolchain issue — see below), (b) a program upgrade,
  (c) **re-create + re-seed all markets** (existing markets are collateralized
  under the old math and would be insolvent under the new), (d) rewrite the
  LiteSVM test assertions that currently encode the *old* (wrong) economics
  (`u4/u6/u7/u8`), (e) flip `NO_SIDE_DISABLED = false` in `TradePanel.tsx`.
- **Interim mitigation (live):** No-side buttons disabled (`TradePanel.tsx`).
- Plan: `docs/plans/2026-06-04-002-fix-no-side-1e6-unit-mismatch-plan.md`.

### ✅ Portfolio share-quantity display (was $0.00)
`contractsFromBaseUnits` divided share counts by 1e6. Fixed →
`sharesFromBaseUnits`. Merged + deployed.
Plan: `docs/plans/2026-06-04-001-fix-share-quantity-unit-scaling-plan.md`.

### ⚠️ SBF build blocked in this environment (`getrandom`)
`cargo build-sbf` fails: `getrandom 0.2.17` (via `rand_core 0.6`) **and**
`getrandom 0.3.4` (via `rand_core 0.9`) don't support the Solana SBF target in
platform-tools v1.52. 0.2 is fixable with a target-scoped `custom` feature; 0.3
needs a `getrandom_backend="custom"` cfg + a backend impl. The committed
`Cargo.toml` builds on the toolchain that produced the deployed `.so`. **Resolve
on the working build env, or pin the toolchain, before deploying the 1e6 fix.**

---

## Security (from the 8-agent audit, 2026-06-04 — see `docs/SECURITY-AUDIT.md`)

**Headline:** no unprivileged attacker can steal funds. Matching engine, escrow
conservation, and access control are sound. The items below are credential
exposure, market-integrity griefing, and centralization hardening.

- 🔴 **Helius RPC key public in the client bundle** — `NEXT_PUBLIC_RPC_URL` is
  inlined; the key is live-served and valid. **Domain-restrict + rate-cap** (or
  proxy server-side). Not yet done.
- 🟠 **`/api/insights` unauthenticated** — anonymous POSTs burn the Anthropic
  key. Add per-IP rate limit + origin check + spend cap.
- 🟠 **`settle_market` 900s cherry-pick window** — a near-the-money holder can
  pick the in-window Pyth tick that wins. Shrink the window / anchor to
  earliest-in-window or a short TWAP.
- 🟡 Worker logs the RPC URL (with key) in cleartext; missing security headers
  (`CSP`/`HSTS`/`X-Frame-Options`); `OVERRIDE_PRICES` decides settlement on the
  over-privileged admin hot key; `admin_settle_market` picks an arbitrary
  outcome with no oracle check; no admin rotation/multisig; `pyth_receiver`
  unvalidated at init; `npm audit` 101 prod vulns (1 critical, 13 high).

---

## Operational

- ✅ **0DTE board / demo cleanup** — board filters to today-only; demo wallet
  disabled; trading gated behind wallet connect. Live.
- ✅ **$10 strike ladder** — `STRIKE_STEP_DOLLARS=10` on the worker. Live.
- ✅ **Market-maker liquidity** — `SEED_LIQUIDITY=true`; today's markets seeded.
  Live (PRD "Market Maker — Mint & Quote").
- 📋 **Automation catch-up** — if the worker restarts past its 8 AM window it
  skips the day's create-strikes (has bitten us twice). Add a catch-up so a late
  start still creates the day's markets.
