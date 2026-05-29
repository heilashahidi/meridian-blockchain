"use client";

import { useEffect, useMemo, useState } from "react";

import { MAG7 } from "@/lib/feeds";
import { fetchBook, type BookView } from "@/lib/market";
import { groupActiveByTicker } from "@/lib/marketsView";
import { useMeridian } from "@/lib/MeridianContext";
import { usePrices } from "@/lib/prices";
import { StockTile } from "@/components/StockTile";

const BOOK_POLL_MS = 6000;

export default function MarketsPage() {
  const { program, markets, configError } = useMeridian();
  const prices = usePrices();

  // Group on-chain markets into one entry per MAG7 stock (all 7 always present).
  // `Date.now()` is read once per render; markets crossing expiry resolve on the
  // next markets-list refresh from the context poll.
  const nowUnix = Math.floor(Date.now() / 1000);
  const groups = useMemo(
    () => groupActiveByTicker(markets, nowUnix),
    [markets, nowUnix],
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
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>Markets</h1>
        <p className="muted" style={{ margin: 0, maxWidth: 680 }}>
          Daily binary options on the Magnificent Seven. Each contract pays $1.00
          if the stock settles above its strike at the 4:00 PM ET close. Pick a
          strike to trade.
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
