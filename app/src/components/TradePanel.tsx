"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { buyNo, buyNoLimit, placeLimitOrder, placeMarketOrder, sellNo } from "@/lib/actions";
import { Payoff } from "@/components/Payoff";
import { useMeridian } from "@/hooks/MeridianContext";
import { planFills, SIDE_BID } from "@/lib/matching";
import { payoffSummary } from "@/lib/marketStats";
import { tickerToString } from "@/lib/format";
import {
  ONE_USDC,
  positionGuardDecision,
  resolveTradePath,
  type OrderType,
  type TradeAction,
} from "@/lib/tradePaths";
import { useTx } from "@/hooks/useTx";

// Microunit <-> dollar helpers local to the panel. Prices are entered in
// dollars ($0.00–$1.00); qty is whole shares.
function dollarsToMicro(d: string): bigint | null {
  const n = Number(d);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return BigInt(Math.round(n * 1_000_000));
}

function usd(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const ACTIONS: { key: TradeAction; label: string; tone: "yes" | "no" }[] = [
  { key: "buyYes", label: "Buy Yes", tone: "yes" },
  { key: "sellYes", label: "Sell Yes", tone: "yes" },
  { key: "buyNo", label: "Buy No", tone: "no" },
  { key: "sellNo", label: "Sell No", tone: "no" },
];

const isNoAction = (a: TradeAction) => a === "buyNo" || a === "sellNo";

// No-side trading (Buy No / Sell No) is now ENABLED. The on-chain 1e6 unit fix
// landed: mint_pair/burn_pair/redeem now move `n × ONE_USDC` µUSDC, so the
// order-book leg (qty × price, µUSDC) and the pair leg agree and buy_no/sell_no
// no longer revert with InvalidAmount. The position-guard and atomic
// partial-fill block below still apply.
// See docs/plans/2026-06-04-002-fix-no-side-1e6-unit-mismatch-plan.md.

/**
 * The four trade paths (Buy/Sell × Yes/No), each a single wallet approval. The
 * No price the user enters is reflected to the Yes-leg bound by
 * `resolveTradePath`; position constraints come from `positionGuardDecision`.
 */
export function TradePanel() {
  const { connection } = useConnection();
  const { program, market, config, book, balances, walletPubkey } =
    useMeridian();
  const { busy, error, status, run, reset } = useTx();

  const [action, setAction] = useState<TradeAction>("buyYes");
  const [price, setPrice] = useState("0.50");
  const [qty, setQty] = useState("100");
  // Buy No can rest (limit) or take liquidity now (market). Yes paths always
  // rest as a limit; Sell No is always atomic (a resting Sell No would need
  // burn-on-fill matching that the engine doesn't have).
  const [buyNoMode, setBuyNoMode] = useState<OrderType>("market");
  // Buy Yes / Sell Yes can take liquidity now (market) or rest at a price (limit).
  // Default market so the common "buy, then sell" flow fills against the resting
  // quote instead of resting unfilled below the ask.
  const [yesMode, setYesMode] = useState<OrderType>("market");

  const ready = !!market && !!config && !!book && !!walletPubkey;
  const isYesSide = action === "buyYes" || action === "sellYes";

  const orderType: OrderType =
    action === "buyNo" ? buyNoMode : action === "sellNo" ? "market" : yesMode;
  const isMarket = orderType === "market";

  // A market order takes the best price now, so it asks for no price: it passes a
  // permissive slippage bound — a buy crosses up to ~$0.99, a sell down to
  // ~$0.01 (mapped through the No leg for the No side) — and fills against the
  // resting quote. Limit mode uses the user's typed price.
  const isBuy = action === "buyYes" || action === "buyNo";
  const priceMicro = isMarket
    ? isBuy
      ? 990_000n
      : 10_000n
    : dollarsToMicro(price);
  const qtyN = Number(qty);
  const qtyValid = Number.isInteger(qtyN) && qtyN > 0;
  const inputValid = priceMicro !== null && qtyValid;

  // Position guard (PRD §142–144). With no balances yet (wallet/loading), allow.
  const guard = useMemo(
    () =>
      positionGuardDecision(balances ?? { usdc: 0n, yes: 0n, no: 0n }),
    [balances],
  );
  const gate = guard[action];

  // Switching action drops a stale success/error from the prior trade, so the
  // last "submitted" message never lingers under a different action's controls.
  useEffect(() => reset(), [action, reset]);

  // Crossing preview against the live book using the resolved Yes-leg price.
  const preview = useMemo(() => {
    if (!ready || !inputValid || !book) return null;
    const path = resolveTradePath({
      action,
      price: priceMicro!,
      qty: BigInt(qtyN),
      orderType,
    });
    // The taker matches the opposing side of its Yes-leg side.
    const opposing =
      path.side === SIDE_BID ? book.asks : book.bids;
    return planFills(opposing, path.side, path.yesLegPrice, BigInt(qtyN));
  }, [ready, inputValid, book, action, priceMicro, qtyN, orderType]);

  const fillQty = preview ? preview.fills.reduce((a, f) => a + f.qty, 0n) : 0n;

  // Only *atomic* No orders must fill in full or revert with "could not fully
  // fill within slippage bound": market Buy No (mint-and-sell) and Sell No
  // (buy-and-burn). A Buy No *limit* rests its residual on the book, so it's
  // never blocked. When the live preview shows an atomic No can't fully fill,
  // block the submit and explain — far better than signing a guaranteed revert.
  const isAtomicNo =
    (action === "buyNo" && orderType === "market") || action === "sellNo";
  const cannotFullyFill =
    isAtomicNo && inputValid && (!preview || preview.residual > 0n);

  async function submit() {
    // Guard the async gap so a rapid double-click can't fire two submits.
    if (!ready || !inputValid || busy) return;
    const path = resolveTradePath({
      action,
      price: priceMicro!,
      qty: BigInt(qtyN),
      orderType,
    });
    const ok = await run(async () => {
      const common = {
        program,
        connection,
        market: market!,
        usdcMint: config!.usdcMint,
        user: walletPubkey!,
      };
      switch (path.instruction) {
        case "placeLimitOrder": {
          const a = path.args as { side: number; price: bigint; qty: bigint };
          await placeLimitOrder({ ...common, side: a.side, price: a.price, qty: a.qty });
          break;
        }
        case "placeMarketOrder": {
          const a = path.args as {
            side: number;
            slippageBound: bigint;
            qty: bigint;
          };
          await placeMarketOrder({
            ...common,
            side: a.side,
            slippageBound: a.slippageBound,
            qty: a.qty,
          });
          break;
        }
        case "buyNo": {
          const a = path.args as { amount: bigint; minYesSellPrice: bigint };
          await buyNo({ ...common, amount: a.amount, minYesSellPrice: a.minYesSellPrice });
          break;
        }
        case "buyNoLimit": {
          const a = path.args as { amount: bigint; minYesSellPrice: bigint };
          await buyNoLimit({ ...common, amount: a.amount, minYesSellPrice: a.minYesSellPrice });
          break;
        }
        case "sellNo": {
          const a = path.args as { amount: bigint; maxYesBuyPrice: bigint };
          await sellNo({ ...common, amount: a.amount, maxYesBuyPrice: a.maxYesBuyPrice });
          break;
        }
      }
      const label = ACTIONS.find((x) => x.key === action)!.label;
      const at = isMarket ? "market" : `$${price}`;
      return `${label} ${qtyN} @ ${at} submitted`;
    });
    // Clear both inputs on success so the whole form visibly resets — a
    // populated box + active button after submit read as "nothing happened".
    // Clearing only shares left the just-submitted price behind, which still
    // read as half-done; reset both for an unambiguous "order placed, start
    // fresh".
    if (ok) {
      setQty("");
      setPrice("");
    }
  }

  const side: "yes" | "no" = isNoAction(action) ? "no" : "yes";
  const sideLabel = side === "no" ? "No" : "Yes";
  const submitLabel = ACTIONS.find((x) => x.key === action)!.label;

  // Live payoff / return summary from the entered price + shares (display only).
  const ticker = market ? tickerToString(market.ticker) : "";
  const strikeNum = market ? Number(market.strikePrice) / 1_000_000 : 0;
  const payoff =
    inputValid && priceMicro !== null
      ? payoffSummary({ action, priceDollars: Number(price), shares: qtyN })
      : null;

  return (
    <div className="panel" style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 700 }}>Trade</div>

      {/* Action selector — 2x2 grid of the four paths as segmented buttons. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {ACTIONS.map((a) => {
          const allowed = guard[a.key].allowed;
          const selected = action === a.key;
          return (
            <button
              key={a.key}
              type="button"
              className="seg"
              onClick={() => setAction(a.key)}
              disabled={!allowed}
              title={allowed ? undefined : guard[a.key].reason}
              aria-label={a.key}
              data-active={selected ? a.tone : undefined}
            >
              {a.label}
            </button>
          );
        })}
      </div>

      {/* Order type — Yes side: take now (market) vs rest at a price (limit). */}
      {isYesSide && (
        <div style={{ display: "grid", gap: 4 }}>
          <span className="stat-label">Order type</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {(["market", "limit"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className="seg"
                onClick={() => setYesMode(m)}
                data-active={yesMode === m ? "yes" : undefined}
                aria-label={`yes-${m}`}
              >
                {m === "market" ? "Market" : "Limit"}
              </button>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 11 }}>
            {yesMode === "market"
              ? "Fills now at the book’s best price; any unfilled shares are refunded."
              : "Rests at your price until someone crosses it."}
          </span>
        </div>
      )}

      {/* Order type — only Buy No can choose to rest (limit) vs take (market). */}
      {action === "buyNo" && (
        <div style={{ display: "grid", gap: 4 }}>
          <span className="stat-label">Order type</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {(["market", "limit"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className="seg"
                onClick={() => setBuyNoMode(m)}
                data-active={buyNoMode === m ? "no" : undefined}
                aria-label={`buyNo-${m}`}
              >
                {m === "market" ? "Market" : "Limit"}
              </button>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 11 }}>
            {buyNoMode === "market"
              ? "Fills now against resting bids; blocked if it can’t fill in full."
              : "Fills what it can now, then rests the remainder at your price until a buyer crosses it."}
          </span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: isMarket ? "1fr" : "1fr 1fr", gap: 10 }}>
        {!isMarket && (
          <label style={{ display: "grid", gap: 4 }}>
            <span className="stat-label">{sideLabel} price ($)</span>
            <input
              className="input mono"
              type="number"
              min={0.01}
              max={0.99}
              step={0.01}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              aria-label="price"
            />
          </label>
        )}
        <label style={{ display: "grid", gap: 4 }}>
          <span className="stat-label">shares</span>
          <input
            className="input mono"
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            aria-label="qty"
          />
        </label>
      </div>

      {/* Payoff / return summary — max gain/loss known at entry (PRD). Skipped
          for Yes market orders, where the fill price comes from the book. */}
      {payoff && !isMarket && (
        <div
          className="panel"
          style={{
            padding: 12,
            background: side === "yes" ? "var(--yes-dim)" : "var(--no-dim)",
            border: `1px solid ${side === "yes" ? "var(--yes)" : "var(--no)"}`,
            boxShadow: "none",
            display: "grid",
            gap: 4,
          }}
        >
          {payoff.kind === "buy" ? (
            <>
              {/* Canonical PRD payoff sentence (per $1 contract). */}
              <Payoff
                pay={Number(price)}
                ticker={ticker}
                strike={strikeNum}
                side={sideLabel}
              />
              <div className="mono" style={{ fontSize: 13, color: "var(--text-dim)" }}>
                {qtyN} shares: pay ${usd(payoff.cost)} → win ${usd(payoff.payout)} ·
                +{payoff.returnPct.toFixed(1)}% · Max loss ${usd(payoff.maxLoss)}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 14 }}>
              Receive ~
              <span className="mono" style={{ fontWeight: 700 }}>
                ${usd(payoff.proceeds)}
              </span>{" "}
              <span className="muted" style={{ fontSize: 12 }}>(closing proceeds)</span>
            </div>
          )}
        </div>
      )}

      <button
        className={side === "yes" ? "btn btn-yes" : "btn btn-no"}
        disabled={!ready || !inputValid || !gate.allowed || busy || cannotFullyFill}
        onClick={submit}
      >
        {submitLabel}
      </button>

      {/* Suppress the "no position to sell" guard note while a fresh success is
          shown: after a sell closes a position the guard correctly reports it,
          but stacked under "submitted" it reads as if the trade failed. */}
      {!gate.allowed && !status && (
        <div style={{ color: "var(--no)", fontSize: 13 }}>{gate.reason}</div>
      )}

      {gate.allowed && cannotFullyFill && (
        <div style={{ color: "var(--no)", fontSize: 13 }}>
          Not enough resting liquidity to fill this {submitLabel} in full at ${price}.{" "}
          {action === "buyNo"
            ? "Switch to a Limit order to rest the unfilled part on the book, or adjust the price or size."
            : "Sell No settles atomically, so a partial fill would revert — wait for a quote, or adjust the price or size."}
        </div>
      )}

      {preview && gate.allowed && !cannotFullyFill && (
        <div className="muted" style={{ fontSize: 12 }}>
          {preview.fills.length === 0
            ? isAtomicNo || isMarket
              ? "no crossing liquidity at this price"
              : "rests on the book (no cross)"
            : `crosses ${preview.fills.length} order(s), fills ${fillQty.toString()}` +
              (preview.residual > 0n
                ? isAtomicNo
                  ? `, ${preview.residual.toString()} unfilled (atomic — reverts if not full)`
                  : isMarket
                    ? `, ${preview.residual.toString()} unfilled (refunded)`
                    : `, ${preview.residual.toString()} rests`
                : "")}
        </div>
      )}

      {!walletPubkey && (
        <div className="muted">Connect a wallet to trade.</div>
      )}
      {status && <div style={{ color: "var(--yes)" }}>{status}</div>}
      {error && <div style={{ color: "var(--no)" }}>{error}</div>}

      <div className="muted" style={{ fontSize: 11 }}>
        Max price $1.00 (one Yes + one No = $1.00). No-side prices map to the
        equivalent Yes leg ({`$${(Number(ONE_USDC) / 1_000_000).toFixed(2)}`} −
        No price).
      </div>
    </div>
  );
}
