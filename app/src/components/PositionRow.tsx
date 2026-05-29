"use client";

import type { MarketView } from "@/lib/market";
import { fmtExpiry, tickerToString } from "@/lib/format";
import { strikeDollars } from "@/lib/marketsView";
import {
  canRedeem,
  computePnl,
  contractsFromBaseUnits,
  currentContractPrice,
  fmtDollars,
  fmtPct,
  fmtSignedDollars,
  type Holding,
} from "@/lib/pnl";

/**
 * One position row: market + side, quantity, entry basis, current value, P&L,
 * and a redeem button when the market is settled. `livePrice` is the Yes/No mid
 * for the held side as a $0–$1 fraction (or null when there's no derivable mid).
 * `entryPrice` is the per-contract cost basis (mint basis or an estimate — see
 * `entryIsEstimate`).
 */
export function PositionRow({
  holding,
  livePrice,
  entryPrice,
  entryIsEstimate,
  onRedeem,
  redeeming,
}: {
  holding: Holding;
  livePrice: number | null;
  entryPrice: number;
  entryIsEstimate: boolean;
  onRedeem: (h: Holding) => void;
  redeeming: boolean;
}) {
  const { market, side, amount } = holding;
  const qty = contractsFromBaseUnits(amount);
  const ticker = tickerToString(market.ticker);
  const current = currentContractPrice(side, market, livePrice);
  const pnl = current === null ? null : computePnl(qty, entryPrice, current);
  const showRedeem = canRedeem(market);
  const won =
    market.settled &&
    ((side === "yes" && market.outcome === "yesWins") ||
      (side === "no" && market.outcome === "noWins"));

  const pnlColor =
    pnl === null
      ? "var(--muted)"
      : pnl.pnl >= 0
        ? "var(--bid)"
        : "var(--ask)";

  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td style={{ padding: "10px 8px" }}>
        <div style={{ fontWeight: 600 }}>
          {ticker}{" "}
          <span
            className="mono"
            style={{
              fontSize: 12,
              color: side === "yes" ? "var(--bid)" : "var(--ask)",
            }}
          >
            {side.toUpperCase()}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          ${strikeDollars(market.strikePrice)} · exp {fmtExpiry(market.expiryUnix)}
        </div>
      </td>
      <td className="mono" style={{ padding: "10px 8px", textAlign: "right" }}>
        {qty.toLocaleString("en-US", { maximumFractionDigits: 4 })}
      </td>
      <td className="mono" style={{ padding: "10px 8px", textAlign: "right" }}>
        ${entryPrice.toFixed(2)}
        {entryIsEstimate && (
          <span className="muted" style={{ fontSize: 10 }}>
            {" "}
            est.
          </span>
        )}
      </td>
      <td className="mono" style={{ padding: "10px 8px", textAlign: "right" }}>
        {pnl === null ? "—" : fmtDollars(pnl.currentValue)}
      </td>
      <td
        className="mono"
        style={{ padding: "10px 8px", textAlign: "right", color: pnlColor }}
      >
        {pnl === null ? (
          "—"
        ) : (
          <>
            {fmtSignedDollars(pnl.pnl)}{" "}
            <span style={{ fontSize: 11 }}>({fmtPct(pnl.pnlPct)})</span>
          </>
        )}
      </td>
      <td style={{ padding: "10px 8px", textAlign: "right" }}>
        {market.settled ? (
          showRedeem && won ? (
            <button
              className="btn"
              disabled={redeeming}
              onClick={() => onRedeem(holding)}
            >
              {redeeming ? "Redeeming…" : "Redeem"}
            </button>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              {won ? "settled" : "lost"}
            </span>
          )
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            open
          </span>
        )}
      </td>
    </tr>
  );
}
