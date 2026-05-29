"use client";

import type { BookLevel, BookView } from "@/lib/market";
import { shortKey } from "@/lib/format";
import { toNoView } from "@/lib/tradePaths";

// One book, two perspectives. The on-chain book is priced in Yes microunits;
// the No view reflects every level to `1 − price` and swaps sides (a resting
// Yes ask is a No bid, a resting Yes bid is a No ask) via the pure `toNoView`.
// Prices render as cents ($0.00–$1.00) since both Yes and No live in the same
// $0–$1 fraction space.

function priceUsd(microPerUnit: bigint): string {
  return `$${(Number(microPerUnit) / 1_000_000).toFixed(2)}`;
}

function Row({ level, side }: { level: BookLevel; side: "bid" | "ask" }) {
  const color = side === "bid" ? "var(--bid)" : "var(--ask)";
  return (
    <div
      className="mono"
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1.2fr",
        gap: 8,
        padding: "2px 0",
        fontSize: 13,
      }}
    >
      <span style={{ color }}>{priceUsd(level.price)}</span>
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
  return (
    <div>
      <div className="muted" style={{ marginBottom: 4 }}>
        {title} · {levels.length}
      </div>
      {levels.length === 0 ? (
        <div className="muted">—</div>
      ) : (
        levels.map((l) => <Row key={`${title}-${l.seq}`} level={l} side={side} />)
      )}
    </div>
  );
}

function BookView2({ book }: { book: BookView }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <SideColumn title="Bids" levels={book.bids} side="bid" />
      <SideColumn title="Asks" levels={book.asks} side="ask" />
    </div>
  );
}

/**
 * Render the single on-chain book from both the Yes (native) and No
 * (`1 − price`, sides mirrored) perspectives. A single resting Yes ask shows
 * as an ask under "Yes" and as a No bid under "No".
 */
export function BothSidesBook({ book }: { book: BookView | null }) {
  if (!book) {
    return (
      <div className="panel">
        <div className="muted">Loading order book…</div>
      </div>
    );
  }

  const noBook = toNoView(book);

  return (
    <div className="panel">
      <div style={{ marginBottom: 12 }}>
        <div className="muted" style={{ marginBottom: 6 }}>
          Yes book
        </div>
        <BookView2 book={book} />
      </div>
      <div
        style={{
          borderTop: "1px solid var(--border)",
          paddingTop: 12,
        }}
      >
        <div className="muted" style={{ marginBottom: 6 }}>
          No book <span style={{ fontSize: 11 }}>(price = $1.00 − Yes)</span>
        </div>
        <BookView2 book={noBook} />
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
        price = USDC per share ($0–$1) · qty = shares · one Yes + one No = $1.00
      </div>
    </div>
  );
}
