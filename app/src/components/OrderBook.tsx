"use client";

import type { BookLevel, BookView } from "@/lib/market";
import { shortKey } from "@/lib/format";

// The single on-chain order book — Yes tokens traded against USDC (PRD: "each
// strike market has one order book where Yes tokens are traded against USDC").
// Bids are buyers of Yes, asks are sellers of Yes; the No side is not a separate
// book, it's just the inverse price (No = $1.00 − Yes) surfaced in the trade
// panel. Prices render as cents ($0.00–$1.00). Each level draws a depth bar
// whose width is proportional to that level's qty relative to the largest qty on
// its side, making the book read like a real depth ladder.

function priceUsd(microPerUnit: bigint): string {
  return `$${(Number(microPerUnit) / 1_000_000).toFixed(2)}`;
}

function Row({
  level,
  side,
  maxQty,
}: {
  level: BookLevel;
  side: "bid" | "ask";
  maxQty: bigint;
}) {
  const color = side === "bid" ? "var(--yes)" : "var(--no)";
  const pct =
    maxQty > 0n ? Math.max(4, (Number(level.qty) / Number(maxQty)) * 100) : 0;
  return (
    <div className="depth-row" style={{ fontSize: 13 }}>
      <span
        className="depth-fill"
        style={{ width: `${pct}%`, background: color }}
      />
      <span style={{ color, fontWeight: 600 }}>{priceUsd(level.price)}</span>
      <span>{level.qty.toString()}</span>
      <span className="muted">{shortKey(level.owner.toBase58())}</span>
    </div>
  );
}

function SideColumn({
  title,
  levels,
  side,
}: {
  title: string;
  levels: BookLevel[];
  side: "bid" | "ask";
}) {
  const maxQty = levels.reduce((m, l) => (l.qty > m ? l.qty : m), 0n);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div
        className="depth-row"
        style={{ fontSize: 11, padding: "0 8px", color: "var(--muted)" }}
      >
        <span>{title}</span>
        <span>qty</span>
        <span style={{ textAlign: "right" }}>owner · {levels.length}</span>
      </div>
      {levels.length === 0 ? (
        <div className="muted" style={{ padding: "0 8px", fontSize: 13 }}>
          —
        </div>
      ) : (
        levels.map((l) => (
          <Row key={`${title}-${l.seq}`} level={l} side={side} maxQty={maxQty} />
        ))
      )}
    </div>
  );
}

/**
 * The single on-chain order book for this strike: Yes bids (buyers of Yes) and
 * Yes asks (sellers of Yes), priced in USDC per share ($0–$1). There is no
 * separate No book — selling Yes is buying No, so the No view is just the
 * inverse price shown in the trade panel.
 */
export function OrderBook({ book }: { book: BookView | null }) {
  if (!book) {
    return (
      <div className="panel">
        <div className="muted">Loading order book…</div>
      </div>
    );
  }

  return (
    <div className="panel" style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Order book</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <SideColumn title="Bids" levels={book.bids} side="bid" />
          <SideColumn title="Asks" levels={book.asks} side="ask" />
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        price = USDC per Yes share ($0–$1) · qty = shares · one Yes + one No = $1.00
      </div>
    </div>
  );
}
