---
name: Meridian
last_updated: 2026-05-27
---

# Meridian Strategy

> _First draft. Sections 1-3 are inferred from the Peak6 PRD and marked **TBD** — they need your conviction before this doc is load-bearing. Sections 4-5 derive from the PRD's stated success criteria and scope._

## Target problem

**TBD — inferred from PRD, not yet owned.**

Retail traders who want a directional view on daily US stock moves face two bad options: traditional equity options (Greeks, margin, unlimited downside, broker custody) or off-chain binary-options venues (opaque settlement, custodial risk, regulatory ambiguity). Neither gives them a simple "will X close above Y today" bet with known max gain, known max loss, and no intermediary.

## Our approach

**TBD — inferred from PRD, not yet owned.**

Build the product as a pair of complementary tokens (Yes + No = $1.00 always), settled non-custodially by an on-chain oracle and traded on a CLOB. The bet: a hard-coded $1 payout invariant plus transparent on-chain settlement removes the complexity and trust barriers that keep retail out of derivatives, so the simplicity of the binary contract becomes the product.

## Who it's for

**TBD — inferred from PRD, not yet owned.**

**Primary:** Crypto-native retail traders with a directional view on MAG7 names — they're hiring Meridian to express "will [STOCK] close above [STRIKE] today" with capped, known-at-entry risk and no broker or custodian in the loop.

## Key metrics

- **Settlement correctness** — 100% of contracts pay the correct side per oracle close. Measured on-chain per settled market.
- **$1.00 invariant** — Yes payout + No payout = $1.00 for every settled contract, every day. Measured on-chain.
- **Daily liveness** — Markets created before 9:30 AM ET open; all open contracts settled within 10 minutes of 4:00 PM ET close. Measured by automation service logs.
- **Lifecycle reproducibility** — Full create → mint → trade → settle → redeem demoable on devnet via one-command script. Binary pass/fail.

## Tracks

### Smart contract (mint / settle / redeem)

The on-chain program: token mints, collateral vault, settlement, redemption, invariant enforcement, pause/admin override.

_Why it serves the approach:_ The $1.00 invariant and oracle settlement are the trust-building primitives — they have to live on-chain or the approach collapses.

### Order book and trade UX

Either integrate an existing on-chain CLOB (e.g. Phoenix) or build a minimal book. Plus the four-trade-path abstraction (Buy Yes / Buy No / Sell Yes / Sell No → one book, two perspectives) and position constraints.

_Why it serves the approach:_ The product is only "simple" if Buy No feels first-class — the abstraction over the underlying mint-and-sell is where simplicity-as-product gets earned.

### Oracle and automation

Oracle integration (price read, staleness, confidence band) plus the off-chain service that runs the morning create-strikes job and the 4:05 PM settlement job, with retry and admin-override fallback.

_Why it serves the approach:_ Daily liveness is the whole product — if markets don't open on time or don't settle on time, there is no product.

### Frontend (markets / trade / portfolio)

Next.js app: wallet connect, market grid, trade panel with position-aware constraints, real-time order book (both perspectives), portfolio with redeem flow, settlement countdown.

_Why it serves the approach:_ The non-custodial CLOB is invisible unless the UI translates it. The frontend is where "simple directional bet" becomes the experience the user feels.
