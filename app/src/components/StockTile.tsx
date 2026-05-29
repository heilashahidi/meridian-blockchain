"use client";

import type { BookView, MarketView } from "@/lib/market";
import { priceAgeLabel, type PriceData } from "@/lib/prices";
import { yesMidFraction } from "@/lib/marketsView";
import { MarketCard } from "@/components/MarketCard";

/**
 * One MAG7 stock: live price header + a count of active strikes and a card per
 * active strike. Stocks with no active markets still render with the price and
 * a "No active contracts" note. `books` maps a market PDA base58 → its book
 * (absent/null while loading or empty).
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
  const count = active.length;

  return (
    <section className="panel" style={{ padding: 16 }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 14,
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>{ticker}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {name}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="mono" style={{ fontSize: 20 }}>
            {price ? `$${price.price.toFixed(2)}` : "—"}
          </div>
          <div
            style={{
              fontSize: 11,
              color: fresh ? "var(--bid)" : "var(--muted)",
            }}
          >
            {priceAgeLabel(price)}
          </div>
        </div>
      </header>

      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        {count === 0
          ? "No active contracts"
          : `${count} active contract${count === 1 ? "" : "s"}`}
      </div>

      {count > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 10,
          }}
        >
          {active.map((m) => {
            const book = books[m.pubkey.toBase58()] ?? null;
            return (
              <MarketCard
                key={m.pubkey.toBase58()}
                market={m}
                yesMid={yesMidFraction(book)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
