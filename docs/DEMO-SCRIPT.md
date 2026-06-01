# Meridian — Demo Script

A live walkthrough of the four trade paths (Buy/Sell × Yes/No), with the exact
clicks and what to say at each step. Settlement is at the **4:00 PM ET** close;
one **Yes** + one **No** always costs **$1**, so the price of Yes is the
market's implied probability.

> **The board is real and self-maintaining.** Each trading morning the on-chain
> automation worker creates that day's strike markets from live MAG7 prices and
> seeds them with liquidity (create-strikes + seed-liquidity at ~08:00 ET), then
> settles them against the Pyth oracle at the 4:00 PM ET close. So the markets
> you see were generated automatically today — strikes shift day to day with the
> stocks, so pick by the on-screen filters rather than memorizing strikes.

---

## Before you start (off-camera)

1. **Phantom on Devnet** — Settings → Developer Settings → Testnet Mode → Solana
   Devnet. The wallet must be funded with devnet SOL (fees) + test USDC.
2. Open the app → **Select Wallet → Phantom** → approve. The **Buying power**
   pill should show your test USDC balance.
3. Pick **two** markets up front so the four paths flow without fighting the
   position guard (you can't hold Yes *and* No on the same market at once). Use
   the filter chips above the board:
   - **Market A** for the Yes round-trip — click **"Near strike"** and pick a
     market near **50%** implied (a clean coin-flip).
   - **Market B** for the No round-trip — a different ticker, any liquid strike
     (e.g. one showing **"In the money"** so No is the interesting side).
4. Every trade: **shares = 10**, **price 0.95 to buy / 0.05 to sell**.

> Strikes change daily (the board regenerates each morning). The deepest books
> are AAPL, MSFT, GOOGL — prefer those if a market feels thin.

---

## Opener (~30s)

> "Meridian is a daily prediction market on the Magnificent Seven stocks,
> running fully on-chain on Solana. Each contract is a simple yes/no question —
> *will this stock close above this strike at 4 PM Eastern?* The key invariant:
> one **Yes** token plus one **No** token always cost exactly **$1**. A Yes pays
> $1 if the stock closes at or above the strike, $0 otherwise — so the price of
> Yes, say 53 cents, is literally the market's implied probability. Everything
> trades on a real on-chain order book, and settlement reads a Pyth oracle. It's
> non-custodial — I sign every trade from my own wallet."

If asked about the **"Market closed"** banner:

> "That's the underlying stock market — it's the weekend, so there's no live
> tick; prices reflect Friday's close. The prediction contracts themselves trade
> right up to their 4 PM settlement."

Say once, up front, about the prices you'll type:

> "I'll type 95 cents to buy and 5 cents to sell — that's just to guarantee my
> order crosses the book. A crossing order fills at the *resting* price, not my
> number, so I'm not overpaying; it's the same as hitting market."

---

## The four trades

### 1 — Buy Yes  ·  *Market A (your near-coin-flip pick)*

**Do:** open the market card → Trade panel → **Buy Yes** → price **0.95**,
shares **10** → **Buy Yes** → approve in Phantom.

**Say:**
> "I think this stock closes above the strike today, so I buy Yes. The panel
> shows my payoff before I commit — max gain and max loss are both known upfront,
> that's the defined-risk part. One signature… and it's on-chain."

### 2 — Sell Yes  ·  *same market (close the position)*

**Do:** **Sell Yes** → price **0.05**, shares **10** → **Sell Yes** → approve.

**Say:**
> "Now I close it — sell my Yes back into the book. This is a real central limit
> order book on-chain, so I'm crossing a resting bid, not a pool. Position
> closed."

### 3 — Buy No  ·  *Market B (your second market)*

**Do:** open the second market → **Buy No** → price **0.95**, shares **10** →
**Buy No** → approve.

**Say:**
> "Same engine, other side. I think this one *won't* close above its strike, so
> I buy No. Under the hood this mints a Yes/No pair and sells the Yes leg in one
> atomic transaction — but to me it's one click, one approval."

### 4 — Sell No  ·  *same market (close)*

**Do:** **Sell No** → price **0.05**, shares **10** → **Sell No** → approve.

**Say:**
> "And close the No the same way. Four trade paths — Buy and Sell, Yes and No —
> all on the same order book."

> **Position-guard note (for you, not the script):** you can't hold Yes and No
> on the same market at once. Splitting the Yes round-trip and the No round-trip
> across two markets keeps the flow smooth — no need to explain it live.

---

## Show the receipts (the on-chain proof)

- **Activity heatmap (Dashboard):** "There are my four trades showing up live —
  the heatmap and the counters updated on their own, no refresh." *(Auto-refreshes
  ~10s.)*
- **Portfolio page:** "Positions, marked-to-market value, and live P&L — read
  straight from chain."
- **History page:** "Every transaction, classified, with a link to Solana
  Explorer — fully auditable."

---

## Close (one line)

> "That's Meridian end to end: pick a market, take a Yes or No position with
> defined risk, trade it on a real on-chain order book, and settle against an
> oracle at the close — non-custodial the whole way."

---

## If something hiccups

| Symptom | Fix |
|---|---|
| **"no crossing liquidity"** | That book is thin — switch to AAPL / MSFT / GOOGL (deepest books). |
| **A trade reverts** | Drop shares to **5** and retry (the atomic No paths need the full size to fill). |
| **Buy No is greyed out** | You still hold Yes on that market — Sell Yes first, or use a fresh market. |
| **Heatmap didn't move** | Wait ~10s; confirm you're connected with the funded wallet (not logged out). |
| **Buying power shows $0** | Phantom isn't on Devnet, or it's the wrong wallet. |
