"use client";

import { useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { buyNo, placeLimitOrder, placeMarketOrder, sellNo } from "@/lib/actions";
import { useMeridian } from "@/lib/MeridianContext";
import { planFills, SIDE_BID } from "@/lib/matching";
import {
  ONE_USDC,
  positionGuardDecision,
  resolveTradePath,
  type TradeAction,
} from "@/lib/tradePaths";
import { useTx } from "@/lib/useTx";

// Microunit <-> dollar helpers local to the panel. Prices are entered in
// dollars ($0.00–$1.00); qty is whole shares.
function dollarsToMicro(d: string): bigint | null {
  const n = Number(d);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return BigInt(Math.round(n * 1_000_000));
}

const ACTIONS: { key: TradeAction; label: string; tone: "bid" | "ask" }[] = [
  { key: "buyYes", label: "Buy Yes", tone: "bid" },
  { key: "sellYes", label: "Sell Yes", tone: "ask" },
  { key: "buyNo", label: "Buy No", tone: "bid" },
  { key: "sellNo", label: "Sell No", tone: "ask" },
];

const isNoAction = (a: TradeAction) => a === "buyNo" || a === "sellNo";
const isBuy = (a: TradeAction) => a === "buyYes" || a === "buyNo";

/**
 * The four trade paths (Buy/Sell × Yes/No), each a single wallet approval. The
 * No price the user enters is reflected to the Yes-leg bound by
 * `resolveTradePath`; position constraints come from `positionGuardDecision`.
 */
export function TradePanel() {
  const { connection } = useConnection();
  const { program, market, config, book, balances, walletPubkey } =
    useMeridian();
  const { busy, error, status, run } = useTx();

  const [action, setAction] = useState<TradeAction>("buyYes");
  const [price, setPrice] = useState("0.50");
  const [qty, setQty] = useState("100");

  const ready = !!market && !!config && !!book && !!walletPubkey;
  const priceMicro = dollarsToMicro(price);
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

  // Crossing preview against the live book using the resolved Yes-leg price.
  const preview = useMemo(() => {
    if (!ready || !inputValid || !book) return null;
    const path = resolveTradePath({
      action,
      price: priceMicro!,
      qty: BigInt(qtyN),
      orderType: "limit",
    });
    // The taker matches the opposing side of its Yes-leg side.
    const opposing =
      path.side === SIDE_BID ? book.asks : book.bids;
    return planFills(opposing, path.side, path.yesLegPrice, BigInt(qtyN));
  }, [ready, inputValid, book, action, priceMicro, qtyN]);

  const fillQty = preview ? preview.fills.reduce((a, f) => a + f.qty, 0n) : 0n;

  async function submit() {
    // Guard the async gap so a rapid double-click can't fire two submits.
    if (!ready || !inputValid || busy) return;
    const path = resolveTradePath({
      action,
      price: priceMicro!,
      qty: BigInt(qtyN),
      // Yes paths default to a limit order so a non-crossing order rests; No
      // paths are inherently market (atomic) on-chain.
      orderType: "limit",
    });
    await run(async () => {
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
        case "sellNo": {
          const a = path.args as { amount: bigint; maxYesBuyPrice: bigint };
          await sellNo({ ...common, amount: a.amount, maxYesBuyPrice: a.maxYesBuyPrice });
          break;
        }
      }
      const label = ACTIONS.find((x) => x.key === action)!.label;
      return `${label} ${qtyN} @ $${price} submitted`;
    });
  }

  const noLabel = isNoAction(action) ? "No" : "Yes";

  return (
    <div className="panel" style={{ display: "grid", gap: 12 }}>
      <div className="muted">Trade</div>

      {/* Action selector — 2x2 grid of the four paths. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {ACTIONS.map((a) => {
          const allowed = guard[a.key].allowed;
          const selected = action === a.key;
          return (
            <button
              key={a.key}
              type="button"
              onClick={() => setAction(a.key)}
              disabled={!allowed}
              title={allowed ? undefined : guard[a.key].reason}
              aria-label={a.key}
              style={{
                padding: "8px 0",
                borderRadius: 8,
                border: `1px solid ${selected ? `var(--${a.tone})` : "var(--border)"}`,
                background: selected ? "var(--panel)" : "transparent",
                color: allowed ? `var(--${a.tone})` : "var(--muted)",
                cursor: allowed ? "pointer" : "not-allowed",
                fontWeight: selected ? 700 : 400,
                opacity: allowed ? 1 : 0.5,
              }}
            >
              {a.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label className="muted" style={{ fontSize: 12 }}>
          {noLabel} price ($)
          <input
            type="number"
            min={0.01}
            max={0.99}
            step={0.01}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            style={{ width: 90, marginLeft: 6 }}
            aria-label="price"
          />
        </label>
        <label className="muted" style={{ fontSize: 12 }}>
          shares
          <input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            style={{ width: 90, marginLeft: 6 }}
            aria-label="qty"
          />
        </label>
        <button
          className="btn"
          disabled={!ready || !inputValid || !gate.allowed || busy}
          onClick={submit}
        >
          {ACTIONS.find((x) => x.key === action)!.label}
        </button>
      </div>

      {!gate.allowed && (
        <div style={{ color: "var(--ask)", fontSize: 13 }}>{gate.reason}</div>
      )}

      {preview && gate.allowed && (
        <div className="muted" style={{ fontSize: 12 }}>
          {preview.fills.length === 0
            ? isBuy(action) && !isNoAction(action)
              ? "rests on the book (no cross)"
              : "no crossing liquidity at this price"
            : `crosses ${preview.fills.length} order(s), fills ${fillQty.toString()}` +
              (preview.residual > 0n
                ? isNoAction(action)
                  ? `, ${preview.residual.toString()} unfilled (atomic — reverts if not full)`
                  : `, ${preview.residual.toString()} rests`
                : "")}
        </div>
      )}

      {!walletPubkey && (
        <div className="muted">Connect a wallet to trade.</div>
      )}
      {status && <div style={{ color: "var(--bid)" }}>{status}</div>}
      {error && <div style={{ color: "var(--ask)" }}>{error}</div>}

      <div className="muted" style={{ fontSize: 11 }}>
        Max price $1.00 (one Yes + one No = $1.00). No-side prices map to the
        equivalent Yes leg ({`$${(Number(ONE_USDC) / 1_000_000).toFixed(2)}`} −
        No price).
      </div>
    </div>
  );
}
