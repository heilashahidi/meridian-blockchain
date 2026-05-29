"use client";

import { useMeridian } from "@/lib/MeridianContext";
import { fmtExpiry, tickerToString, toUsdc } from "@/lib/format";

export function MarketPicker() {
  const { markets, selected, selectMarket } = useMeridian();

  if (markets.length === 0) {
    return (
      <div className="panel">
        <div className="muted">
          No markets on this cluster yet. Create one with
          <span className="mono"> scripts/bootstrap-devnet.mjs </span>
          or <span className="mono">lifecycle-demo.mjs</span>.
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="muted" style={{ marginBottom: 8 }}>
        Markets ({markets.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {markets.map((m) => {
          const isSel = selected?.equals(m.pubkey) ?? false;
          return (
            <button
              key={m.pubkey.toBase58()}
              onClick={() => selectMarket(m.pubkey)}
              style={{
                textAlign: "left",
                background: isSel ? "var(--border)" : "transparent",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "8px 10px",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <strong>
                  {tickerToString(m.ticker)} · ${toUsdc(m.strikePrice)}
                </strong>
                <span className="muted">
                  {m.settled ? `settled (${m.outcome})` : "open"}
                </span>
              </div>
              <div className="muted mono" style={{ fontSize: 12 }}>
                expiry {fmtExpiry(m.expiryUnix)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
