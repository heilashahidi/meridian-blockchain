# Known Issues & Outstanding Fixes

One place to track what's broken, what's planned, and what's done. Updated
2026-06-05.

Legend: 🔴 critical · 🟠 high-value · 🟡 hardening · ✅ done · 🛠 in progress · 📋 planned

---

## Correctness

### ✅ 1e6 collateral unit mismatch (No-side trades + Yes redemption) — FIXED
**The big one.** The order book prices a token in `[0, ONE_USDC]` µUSDC (= $0–$1),
but `mint_pair`/`burn_pair`/`redeem` collateralized **1 µUSDC per token** instead
of **$1.00**. The two unit systems disagreed by 1,000,000×.

- **Symptoms (pre-fix):** `Buy No` / `Sell No` reverted with `InvalidAmount` and
  showed negative proceeds; a Yes bought for $0.72 would `redeem` for $0.000001
  even when it won.
- **Root cause:** violated the PRD vault invariant (`Vault = $1.00 × pairs`); it
  held `escrow == supply` (1 µUSDC/token).
- **Fix (implemented + tested, branch `fix/a-grade-1e6-and-prd-gaps`, Approach 2):**
  multiply the USDC amount by `ONE_USDC` in the three transfers —
  `mint_pair_inner`, `burn_pair_inner`, `redeem_handler` — plus a
  `pub const ONE_USDC` in `lib.rs`. Order book unchanged (already correct in these
  units). New invariant: **`usdc_escrow == supply * ONE_USDC`** (+ resting-bid
  notional on the order book). 
- **Verified:** `anchor build` produces the `.so`; the matching proptests (9),
  the LiteSVM suite (101 — `u4`–`u8` reassertions + the `u8` buy-Yes-via-book →
  settle → redeem-for-full-$1 round-trip), and the Trident R13 escrow invariant
  were all updated to the new units and pass / reconcile. `NO_SIDE_DISABLED`
  removed in `TradePanel.tsx`; all four trade paths live in the UI.
- **Remaining operational step (human-gated):** program **upgrade to devnet** +
  **re-create/re-seed markets** (old markets are collateralized under the old
  math). See `docs/DEVNET-RUNBOOK.md` → "Redeploy after the 1e6 fix".
- Plan: `docs/plans/2026-06-04-002-fix-no-side-1e6-unit-mismatch-plan.md`.

### ✅ Portfolio share-quantity display (was $0.00)
`contractsFromBaseUnits` divided share counts by 1e6. Fixed →
`sharesFromBaseUnits`. Merged + deployed.
Plan: `docs/plans/2026-06-04-001-fix-share-quantity-unit-scaling-plan.md`.

### ✅ SBF build (`anchor build`) works on the current toolchain
Earlier the build was blocked by a `getrandom`/platform-tools mismatch. On the
current env `anchor build` (anchor-cli 1.0.0, solana 3.1.10) produces
`target/deploy/meridian.so` + `target/idl/meridian.json` clean — the 1e6 fix is
build-ready for the human-gated devnet upgrade.

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
