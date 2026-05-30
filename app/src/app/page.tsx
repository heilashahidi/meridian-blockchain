"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { MAG7 } from "@/lib/feeds";
import { fetchBook, type BookView, type MarketView } from "@/lib/market";
import {
  groupActiveByTicker,
  noFromYes,
  strikeDollars,
  tradeHref,
  yesMidFraction,
} from "@/lib/marketsView";
import { distanceToStrike } from "@/lib/marketStats";
import { useMeridian } from "@/hooks/MeridianContext";
import { usePrices } from "@/hooks/usePrices";
import { WalletButton } from "@/components/WalletButton";

const BOOK_POLL_MS = 6000;
const usd = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (yes: number | null) => (yes === null ? "—" : `${Math.round(yes * 100)}%`);

/** Big market stat card (top row of the dashboard). */
function StatCard({
  ticker,
  name,
  market,
  yesMid,
  spot,
}: {
  ticker: string;
  name: string;
  market: MarketView;
  yesMid: number | null;
  spot: number | null;
}) {
  const strikeNum = Number(market.strikePrice) / 1_000_000;
  const dist = distanceToStrike(spot, strikeNum);
  const yesW = yesMid !== null ? Math.round(yesMid * 100) : 0;
  return (
    <Link href={tradeHref(market.pubkey)} className="panel stat-card">
      <div className="stat-card-head">
        <span className="ticker-badge mono">{ticker}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{ticker}</div>
          <div className="muted" style={{ fontSize: 11 }}>{name}</div>
        </div>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--muted)" strokeWidth="1.8" style={{ marginLeft: "auto" }} aria-hidden>
          <path d="M3 17l5-5 4 3 6-7" />
          <path d="M16 8h5v5" />
        </svg>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Will close above <span className="mono">${strikeDollars(market.strikePrice)}</span>?
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
        <span className="mono" style={{ fontSize: 30, fontWeight: 800, color: yesMid !== null ? "var(--yes)" : "var(--muted)" }}>
          {pct(yesMid)}
        </span>
        <span className="muted" style={{ fontSize: 11 }}>Yes implied</span>
      </div>
      <div className="prob-bar" style={{ margin: "8px 0 10px" }}>
        <span className="prob-yes" style={{ width: `${yesW}%` }} />
      </div>
      <div className="stat-card-foot">
        <span className="muted" style={{ fontSize: 11 }}>
          Spot <span className="mono" style={{ color: "var(--text-dim)" }}>{spot !== null ? `$${usd(spot)}` : "—"}</span>
        </span>
        {dist !== null && (
          <span style={{ fontSize: 11, fontWeight: 600, color: dist.aboveStrike ? "var(--yes)" : "var(--no)" }}>
            {dist.aboveStrike ? "In the money" : "Below strike"}
          </span>
        )}
      </div>
    </Link>
  );
}

/** A row in the "Today's markets" list, with Yes/No buttons into the book. */
function MarketRow({
  ticker,
  market,
  yesMid,
  spot,
}: {
  ticker: string;
  market: MarketView;
  yesMid: number | null;
  spot: number | null;
}) {
  const strikeNum = Number(market.strikePrice) / 1_000_000;
  const dist = distanceToStrike(spot, strikeNum);
  const yesW = yesMid !== null ? Math.round(yesMid * 100) : 0;
  const noMid = yesMid !== null ? noFromYes(yesMid) : null;
  return (
    <div className="market-row">
      <span className="ticker-badge mono" style={{ width: 34, height: 34, fontSize: 10 }}>{ticker}</span>
      <div className="market-row-main">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>
            Will {ticker} close above <span className="mono">${strikeDollars(market.strikePrice)}</span>?
          </span>
          <span className="mono" style={{ fontWeight: 700, color: yesMid !== null ? "var(--yes)" : "var(--muted)" }}>
            {pct(yesMid)}
          </span>
        </div>
        <div className="prob-bar" style={{ margin: "6px 0" }}>
          <span className="prob-yes" style={{ width: `${yesW}%` }} />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Yes {pct(yesMid)} · No {noMid !== null ? `${Math.round(noMid * 100)}%` : "—"}
          {dist !== null && (
            <span style={{ color: dist.aboveStrike ? "var(--yes)" : "var(--no)", marginLeft: 8 }}>
              {dist.aboveStrike ? "+" : "−"}${usd(Math.abs(dist.delta))} vs strike
            </span>
          )}
        </div>
      </div>
      <div className="market-row-actions">
        <Link href={tradeHref(market.pubkey)} className="btn btn-yes" style={{ padding: "7px 16px", fontSize: 13 }}>Yes</Link>
        <Link href={tradeHref(market.pubkey)} className="btn btn-no" style={{ padding: "7px 16px", fontSize: 13 }}>No</Link>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { program, markets, walletPubkey, configError } = useMeridian();
  const prices = usePrices();

  const groups = useMemo(
    () => groupActiveByTicker(markets, Math.floor(Date.now() / 1000)),
    [markets],
  );
  const active = useMemo(() => groups.flatMap((g) => g.active), [groups]);
  const activeSig = active.map((m) => m.pubkey.toBase58()).sort().join(",");

  const [books, setBooks] = useState<Record<string, BookView | null>>({});
  useEffect(() => {
    if (active.length === 0) {
      setBooks({});
      return;
    }
    let cancelled = false;
    const load = async () => {
      const entries = await Promise.all(
        active.map(async (m) => {
          try {
            return [m.pubkey.toBase58(), await fetchBook(program, m.pubkey)] as const;
          } catch {
            return [m.pubkey.toBase58(), null] as const;
          }
        }),
      );
      if (!cancelled) setBooks(Object.fromEntries(entries));
    };
    void load();
    const id = setInterval(() => void load(), BOOK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, activeSig]);

  const tickerName = useMemo(
    () => Object.fromEntries(MAG7.map((f) => [f.ticker, f.name])),
    [],
  );
  const tickerOf = (m: MarketView) =>
    groups.find((g) => g.active.includes(m))?.ticker ?? "";
  const yesMidOf = (m: MarketView) => yesMidFraction(books[m.pubkey.toBase58()] ?? null);
  const spotOf = (t: string) => prices[t]?.price ?? null;

  // Top cards: the markets nearest a coin-flip (most interesting), up to 4.
  const topCards = useMemo(
    () =>
      [...active]
        .sort(
          (a, b) =>
            Math.abs((yesMidOf(a) ?? 0.5) - 0.5) - Math.abs((yesMidOf(b) ?? 0.5) - 0.5),
        )
        .slice(0, 4),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSig, books],
  );

  return (
    <main className="dashboard">
      <div className="dashboard-head">
        <div>
          <h1 style={{ fontSize: 26 }}>Dashboard</h1>
          <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>
            Daily binary options on the Magnificent Seven · settle at the 4:00 PM ET close.
          </p>
        </div>
        {!walletPubkey && <WalletButton />}
      </div>

      {configError && (
        <p className="muted" style={{ color: "var(--no)", fontSize: 13 }}>{configError}</p>
      )}

      {/* Top stat cards */}
      {topCards.length > 0 ? (
        <div className="stat-card-grid">
          {topCards.map((m) => {
            const t = tickerOf(m);
            return (
              <StatCard
                key={m.pubkey.toBase58()}
                ticker={t}
                name={tickerName[t] ?? ""}
                market={m}
                yesMid={yesMidOf(m)}
                spot={spotOf(t)}
              />
            );
          })}
        </div>
      ) : (
        <div className="panel" style={{ textAlign: "center", padding: 28 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>No active contracts yet</div>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>
            The morning job creates the day&apos;s strike markets. Live MAG7 prices are below.
          </p>
        </div>
      )}

      {/* Live ticker strip */}
      <div className="ticker-strip">
        {MAG7.map((f) => {
          const p = prices[f.ticker];
          return (
            <div className="ticker-cell" key={f.ticker}>
              <span className="mono" style={{ fontWeight: 700, fontSize: 12 }}>{f.ticker}</span>
              <span className="mono" style={{ fontSize: 12, color: "var(--text-dim)" }}>
                {p ? `$${usd(p.price)}` : "—"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Today's markets list */}
      <section className="panel" style={{ padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 17 }}>Today&apos;s markets</h2>
            <p className="muted" style={{ fontSize: 12, margin: "2px 0 0" }}>
              Daily binary options · settle at the 4:00 PM ET close
            </p>
          </div>
          <Link href="/markets" className="muted" style={{ fontSize: 13 }}>View all →</Link>
        </div>
        {active.length > 0 ? (
          <div className="market-row-list">
            {active.map((m) => (
              <MarketRow
                key={m.pubkey.toBase58()}
                ticker={tickerOf(m)}
                market={m}
                yesMid={yesMidOf(m)}
                spot={spotOf(tickerOf(m))}
              />
            ))}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>No active markets right now.</p>
        )}
      </section>
    </main>
  );
}
