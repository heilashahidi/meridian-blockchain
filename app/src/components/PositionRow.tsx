"use client";

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
 * One position as a clean card: the plain-language market question, a Yes/No
 * side pill, and a metric grid (qty · entry est. · current value · P&L). A
 * Redeem button appears only on settled markets the held side won; settled
 * losers and open positions show a calm status pill instead.
 *
 * `livePrice` is the Yes/No mid for the held side as a $0–$1 fraction (or null
 * when there's no derivable mid). `entryPrice` is the per-contract cost basis
 * (exact mint basis or an estimate — see `entryIsEstimate`).
 */
export function PositionRow({
  holding,
  livePrice,
  entryPrice,
  entryIsEstimate,
  onRedeem,
  redeeming,
  redeemDisabled = false,
}: {
  holding: Holding;
  livePrice: number | null;
  entryPrice: number;
  entryIsEstimate: boolean;
  onRedeem: (h: Holding) => void;
  redeeming: boolean;
  /** Read-only preview (demo wallet): show the Redeem affordance disabled —
   *  a public-key-only wallet can't sign the redeem transaction. */
  redeemDisabled?: boolean;
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

  const isYes = side === "yes";
  const pnlPositive = pnl !== null && pnl.pnl >= 0;
  const pnlColor =
    pnl === null ? "var(--muted)" : pnlPositive ? "var(--yes)" : "var(--no)";

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--surface-2)",
        padding: 16,
        display: "grid",
        gap: 14,
      }}
    >
      {/* Header: question + side pill + status / redeem */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span className={isYes ? "pill pill-yes" : "pill pill-no"}>
              {isYes ? "Yes" : "No"}
            </span>
            <span style={{ fontSize: 16, fontWeight: 600 }}>
              {ticker} above{" "}
              <span className="mono">${strikeDollars(market.strikePrice)}</span>
            </span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Expires {fmtExpiry(market.expiryUnix)}
          </div>
        </div>

        <div style={{ flexShrink: 0 }}>
          {market.settled ? (
            showRedeem && won ? (
              <button
                className="btn-yes"
                style={{
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  padding: "8px 16px",
                  fontWeight: 600,
                  cursor: redeeming || redeemDisabled ? "not-allowed" : "pointer",
                  opacity: redeeming || redeemDisabled ? 0.6 : 1,
                }}
                disabled={redeeming || redeemDisabled}
                onClick={() => onRedeem(holding)}
                title={redeemDisabled ? "Connect your wallet to redeem" : undefined}
              >
                {redeeming ? "Redeeming…" : "Redeem"}
              </button>
            ) : (
              <span
                className="pill"
                style={
                  won
                    ? {}
                    : { color: "var(--no)", borderColor: "var(--no)" }
                }
              >
                {won ? "Settled" : "Lost"}
              </span>
            )
          ) : (
            <span className="pill">Open</span>
          )}
        </div>
      </div>

      {/* Metric grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
        }}
      >
        <div className="stat">
          <span className="stat-label">Quantity</span>
          <span className="stat-value mono" style={{ fontSize: 15 }}>
            {qty.toLocaleString("en-US", { maximumFractionDigits: 4 })}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">
            Entry{entryIsEstimate ? " (est.)" : ""}
          </span>
          <span className="stat-value mono" style={{ fontSize: 15 }}>
            ${entryPrice.toFixed(2)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Value</span>
          <span className="stat-value mono" style={{ fontSize: 15 }}>
            {pnl === null ? "—" : fmtDollars(pnl.currentValue)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">P&amp;L</span>
          <span
            className="stat-value mono"
            style={{ fontSize: 15, color: pnlColor }}
          >
            {pnl === null ? (
              "—"
            ) : (
              <>
                {fmtSignedDollars(pnl.pnl)}{" "}
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  ({fmtPct(pnl.pnlPct)})
                </span>
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
