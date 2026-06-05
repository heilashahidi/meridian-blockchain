"use client";

import { useState } from "react";

import type { BookLevel, BookView } from "@/lib/market";
import { shortKey } from "@/lib/format";
import { ONE_USDC } from "@/lib/tradePaths";

// The single on-chain order book — Yes tokens traded against USDC (PRD: "each
// strike market has one order book where Yes tokens are traded against USDC").
// Bids are buyers of Yes, asks are sellers of Yes. The No side is NOT a separate
// book — it's the same book viewed in inverted price space, surfaced here as a
// second perspective (PRD §308: "displayed for both Yes and No perspectives —
// same book, two views"). Prices render as cents ($0.00–$1.00). Each level
// draws a depth bar whose width is proportional to that level's qty relative to
// the largest qty on its side, making the book read like a real depth ladder.

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
    <div style={{ display: "grid", gap: 6, alignContent: "start" }}>
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
 * Reflect a Yes level into No price space (PRD §308 "two views, same book").
 * The economics are exact: one Yes + one No = $1.00, so the No price for any
 * Yes level is `ONE_USDC − yesPrice`. Selling Yes IS buying No, so the bid/ask
 * roles flip: a resting Yes BID (someone buying Yes) is a No ASK (offering No),
 * and a resting Yes ASK (selling Yes) is a No BID. Quantity (shares) is
 * unchanged — a Yes/No pair shares one base unit. We don't refetch anything;
 * the No view is a pure transform of the same `book` data.
 */
function reflectLevel(level: BookLevel): BookLevel {
  return { ...level, price: ONE_USDC - level.price };
}

type Perspective = "yes" | "no";

export function OrderBook({ book }: { book: BookView | null }) {
  // Default to the Yes perspective (the canonical price space the book stores).
  const [view, setView] = useState<Perspective>("yes");

  if (!book) {
    return (
      <div className="panel">
        <div className="muted">Loading order book…</div>
      </div>
    );
  }

  // Yes view: bids = Yes buyers, asks = Yes sellers (book as stored).
  // No view: invert price (ONE_USDC − yesPrice) and FLIP bid↔ask. Yes asks
  // (selling Yes = offering No to buyers) become No bids; Yes bids become No
  // asks. Best No bid stays first because the Yes asks are already sorted best
  // (lowest) first, which maps to the highest No price = best No bid.
  const bids =
    view === "yes" ? book.bids : book.asks.map(reflectLevel);
  const asks =
    view === "yes" ? book.bids.map(reflectLevel) : book.asks;

  return (
    <div className="panel" style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gap: 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>Order book</div>
          {/* Same book, two perspectives (PRD §308). Toggle, no refetch. */}
          <div style={{ display: "flex", gap: 6 }}>
            {(["yes", "no"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className="seg"
                style={{ padding: "2px 10px", fontSize: 12 }}
                onClick={() => setView(p)}
                data-active={view === p ? (p === "yes" ? "yes" : "no") : undefined}
                aria-label={`book-view-${p}`}
              >
                {p === "yes" ? "Yes view" : "No view"}
              </button>
            ))}
          </div>
        </div>
        {/* align-items: start so the shorter side (e.g. one ask vs six bids)
            keeps its natural height — otherwise the lone row stretches and its
            absolute depth-fill balloons into a big colored block. */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
          <SideColumn title="Bids" levels={bids} side="bid" />
          <SideColumn title="Asks" levels={asks} side="ask" />
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        {view === "yes"
          ? "price = USDC per Yes share ($0–$1) · qty = shares · one Yes + one No = $1.00"
          : "No view — price = $1.00 − Yes price · selling Yes = buying No (bid↔ask flipped) · same book"}
      </div>
    </div>
  );
}
