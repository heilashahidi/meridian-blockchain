"use client";

import type { BookView, MarketView } from "@/lib/market";
import { priceAgeLabel, type PriceData } from "@/lib/prices";
import { yesMidFraction } from "@/lib/marketsView";
import { MarketCard } from "@/components/MarketCard";

export type MoneynessFilter = "all" | "itm" | "near" | "long";

/** Classify a strike by its Yes mid: in-the-money, near strike, or long shot. */
function passesFilter(yesMid: number | null, filter: MoneynessFilter): boolean {
  if (filter === "all") return true;
  if (yesMid === null) return filter === "near"; // unknown → treat as near
  if (filter === "itm") return yesMid >= 0.6;
  if (filter === "near") return yesMid >= 0.4 && yesMid < 0.6;
  return yesMid < 0.4; // long shots
}

/**
 * One MAG7 stock as a panel: a boxed ticker badge + company name, the live spot
 * price, and a "N strikes today" badge — then a question-framed contract card
 * per active strike. Stocks with no active markets render gracefully. `books`
 * maps a market PDA base58 → its book (absent/null while loading or empty).
 * `filter` hides strikes outside the selected moneyness band.
 */
export function StockTile({
  ticker,
  name,
  price,
  active,
  books,
  filter = "all",
}: {
  ticker: string;
  name: string;
  price: PriceData | null;
  active: MarketView[];
  books: Record<string, BookView | null>;
  filter?: MoneynessFilter;
}) {
  const fresh = price && Date.now() / 1000 - price.publishTime < 60;
  const spot = price ? price.price : null;

  const shown = active.filter((m) =>
    passesFilter(yesMidFraction(books[m.pubkey.toBase58()] ?? null), filter),
  );
  // When a non-"all" filter is active, hide tickers with no matching strikes.
  if (filter !== "all" && shown.length === 0) return null;
  const count = shown.length;

  return (
    <section className="panel market-tile">
      <header className="market-tile-head">
        <div className="market-tile-id">
          <span className="ticker-badge mono">{ticker}</span>
          <div>
            <div className="market-tile-name">
              <span style={{ fontWeight: 700, fontSize: 16 }}>{ticker}</span>
              <span className="muted" style={{ fontSize: 13 }}>
                {" "}
                · {name}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {spot !== null ? (
                <>
                  Spot{" "}
                  <span className="mono" style={{ color: "var(--text-dim)" }}>
                    ${spot.toFixed(2)}
                  </span>
                  <span style={{ color: fresh ? "var(--yes)" : "var(--muted)" }}>
                    {" "}
                    · {priceAgeLabel(price)}
                  </span>
                </>
              ) : (
                "Live price unavailable (off-hours)"
              )}
            </div>
          </div>
        </div>
        <span className="market-strikes-badge">
          {count === 0
            ? "No strikes yet"
            : `${count} strike${count === 1 ? "" : "s"} today`}
        </span>
      </header>

      {count > 0 && (
        <div className="market-strike-grid">
          {shown.map((m) => {
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
