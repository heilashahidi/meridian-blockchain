"use client";

import type { BookView, MarketView } from "@/lib/market";
import { priceAgeLabel, type PriceData } from "@/lib/prices";
import { yesMidFraction } from "@/lib/marketsView";
import { MarketCard } from "@/components/MarketCard";

/**
 * One MAG7 stock as a clean panel: ticker + company name, the big live spot
 * price (tabular mono), and a count of active contracts — then a question-
 * framed contract card per active strike. Stocks with no active markets render
 * gracefully with the price and a "No active contracts yet" note. `books` maps
 * a market PDA base58 → its book (absent/null while loading or empty).
 */
export function StockTile({
  ticker,
  name,
  price,
  active,
  books,
}: {
  ticker: string;
  name: string;
  price: PriceData | null;
  active: MarketView[];
  books: Record<string, BookView | null>;
}) {
  const fresh = price && Date.now() / 1000 - price.publishTime < 60;
  const spot = price ? price.price : null;
  const count = active.length;

  return (
    <section className="panel" style={{ padding: 18 }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          marginBottom: count > 0 ? 16 : 12,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 20 }}>{ticker}</span>
            <span className="muted" style={{ fontSize: 13 }}>
              {name}
            </span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {count === 0
              ? "No active contracts yet"
              : `${count} active contract${count === 1 ? "" : "s"}`}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="mono" style={{ fontSize: 26, fontWeight: 700 }}>
            {spot !== null ? `$${spot.toFixed(2)}` : "—"}
          </div>
          <div
            style={{
              fontSize: 11,
              color: fresh ? "var(--yes)" : "var(--muted)",
            }}
          >
            {priceAgeLabel(price)}
          </div>
        </div>
      </header>

      {count > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: 12,
          }}
        >
          {active.map((m) => {
            const book = books[m.pubkey.toBase58()] ?? null;
            return (
              <MarketCard
                key={m.pubkey.toBase58()}
                ticker={ticker}
                market={m}
                yesMid={yesMidFraction(book)}
                spot={spot}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
