"use client";

import { useMeridian } from "@/lib/MeridianContext";
import type { BookLevel } from "@/lib/market";
import { shortKey } from "@/lib/format";

function Row({ level, side }: { level: BookLevel; side: "bid" | "ask" }) {
  const color = side === "bid" ? "var(--bid)" : "var(--ask)";
  return (
    <div
      className="mono"
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1.4fr",
        gap: 8,
        padding: "2px 0",
        fontSize: 13,
      }}
    >
      <span style={{ color }}>{level.price.toString()}</span>
      <span>{level.qty.toString()}</span>
      <span className="muted">
        {shortKey(level.owner.toBase58())} · #{level.seq.toString()}
      </span>
    </div>
  );
}

export function OrderBook() {
  const { selected, book } = useMeridian();

  if (!selected) {
    return (
      <div className="panel">
        <div className="muted">Select a market to see its book.</div>
      </div>
    );
  }

  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];

  return (
    <div className="panel">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span className="muted">Order book</span>
        <span className="muted mono" style={{ fontSize: 12 }}>
          next seq {book?.nextSeq.toString() ?? "—"}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <div className="muted" style={{ marginBottom: 4 }}>
            Bids · {bids.length}
          </div>
          {bids.length === 0 ? (
            <div className="muted">—</div>
          ) : (
            bids.map((l) => (
              <Row key={`b-${l.seq}`} level={l} side="bid" />
            ))
          )}
        </div>
        <div>
          <div className="muted" style={{ marginBottom: 4 }}>
            Asks · {asks.length}
          </div>
          {asks.length === 0 ? (
            <div className="muted">—</div>
          ) : (
            asks.map((l) => (
              <Row key={`a-${l.seq}`} level={l} side="ask" />
            ))
          )}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
        price = USDC microunits per Yes base unit · qty = Yes base units
      </div>
    </div>
  );
}
