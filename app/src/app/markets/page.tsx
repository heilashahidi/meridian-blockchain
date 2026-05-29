"use client";

import { useEffect, useMemo, useState } from "react";

import { MAG7 } from "@/lib/feeds";
import { fetchBook, type BookView } from "@/lib/market";
import { groupActiveByTicker } from "@/lib/marketsView";
import { useMeridian } from "@/hooks/MeridianContext";
import { usePrices } from "@/hooks/usePrices";
import { StockTile } from "@/components/StockTile";

const BOOK_POLL_MS = 6000;

export default function MarketsPage() {
  const { program, markets, configError } = useMeridian();
  const prices = usePrices();

  // Group on-chain markets into one entry per MAG7 stock (all 7 always present).
  // `Date.now()` is read inside the memo body so the memo (and the book-poll
  // effect that depends on it) only re-runs when `markets` changes; markets
  // crossing expiry resolve on the next markets-list refresh from the context
  // poll.
  const groups = useMemo(
    () => groupActiveByTicker(markets, Math.floor(Date.now() / 1000)),
    [markets],
  );

  // The set of active market PDAs we need books for. Stable string key list so
  // the effect only re-runs when the active set actually changes.
  const activeKeys = useMemo(() => {
    const keys = groups.flatMap((g) => g.active.map((m) => m.pubkey.toBase58()));
    keys.sort();
    return keys;
  }, [groups]);
  const activeKeysSig = activeKeys.join(",");

  const [books, setBooks] = useState<Record<string, BookView | null>>({});

  useEffect(() => {
    if (activeKeys.length === 0) {
      setBooks({});
      return;
    }
    let cancelled = false;
    const pubkeys = groups.flatMap((g) => g.active.map((m) => m.pubkey));

    async function loadBooks() {
      const entries = await Promise.all(
        pubkeys.map(async (pk) => {
          try {
            return [pk.toBase58(), await fetchBook(program, pk)] as const;
          } catch {
            return [pk.toBase58(), null] as const;
          }
        }),
      );
      if (cancelled) return;
      setBooks(Object.fromEntries(entries));
    }

    void loadBooks();
    const id = setInterval(() => void loadBooks(), BOOK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, activeKeysSig]);

  const byTicker = useMemo(
    () => Object.fromEntries(groups.map((g) => [g.ticker, g])),
    [groups],
  );

  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 32, margin: "0 0 8px" }}>Markets</h1>
        <p
          className="dim"
          style={{ margin: 0, maxWidth: 680, fontSize: 15 }}
        >
          Will it close above the strike? Daily binary options on the Magnificent
          Seven. Each contract pays{" "}
          <span className="mono">$1.00</span> if the stock settles above its
          strike at the 4:00 PM ET close — and the price is the market&rsquo;s
          implied probability. Pick a strike to trade.
        </p>
      </header>

      {configError && (
        <p
          className="muted"
          style={{ color: "var(--ask)", fontSize: 13, marginBottom: 16 }}
        >
          {configError}
        </p>
      )}

      <div style={{ display: "grid", gap: 16 }}>
        {MAG7.map((f) => {
          const group = byTicker[f.ticker];
          return (
            <StockTile
              key={f.ticker}
              ticker={f.ticker}
              name={f.name}
              price={prices[f.ticker] ?? null}
              active={group ? group.active : []}
              books={books}
            />
          );
        })}
      </div>
    </main>
  );
}
