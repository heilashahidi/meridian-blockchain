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
import { StockTile, type MoneynessFilter } from "@/components/StockTile";

const BOOK_POLL_MS = 6000;
const usd = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (yes: number | null) => (yes === null ? "—" : `${Math.round(yes * 100)}%`);

const FILTERS: { key: MoneynessFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "itm", label: "In the money" },
  { key: "near", label: "Near strike" },
  { key: "long", label: "Long shots" },
];

/** Top stat card. `market` null → a "no contract yet" spot-only card (padding). */
function StatCard({
  ticker,
  name,
  market,
  yesMid,
  spot,
}: {
  ticker: string;
  name: string;
  market: MarketView | null;
  yesMid: number | null;
  spot: number | null;
}) {
  const strikeNum = market ? Number(market.strikePrice) / 1_000_000 : 0;
  const dist = market ? distanceToStrike(spot, strikeNum) : null;
  const yesW = yesMid !== null ? Math.round(yesMid * 100) : 0;
  const inner = (
    <>
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
      {market ? (
        <>
          <div className="muted" style={{ fontSize: 12 }}>
            Will close above <span className="mono">${strikeDollars(market.strikePrice)}</span>?
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
            <span className="mono" style={{ fontSize: 30, fontWeight: 800, color: yesMid !== null ? "var(--yes)" : "var(--muted)" }}>{pct(yesMid)}</span>
            <span className="muted" style={{ fontSize: 11 }}>Yes implied</span>
          </div>
          <div className="prob-bar" style={{ margin: "8px 0 10px" }}>
            <span className="prob-yes" style={{ width: `${yesW}%` }} />
          </div>
          <div className="stat-card-foot">
            <span className="muted" style={{ fontSize: 11 }}>Spot <span className="mono" style={{ color: "var(--text-dim)" }}>{spot !== null ? `$${usd(spot)}` : "—"}</span></span>
            {dist !== null && (
              <span style={{ fontSize: 11, fontWeight: 600, color: dist.aboveStrike ? "var(--yes)" : "var(--no)" }}>{dist.aboveStrike ? "In the money" : "Below strike"}</span>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="muted" style={{ fontSize: 12 }}>No contract yet</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
            <span className="mono" style={{ fontSize: 28, fontWeight: 800, color: "var(--text-dim)" }}>{spot !== null ? `$${usd(spot)}` : "—"}</span>
            <span className="muted" style={{ fontSize: 11 }}>spot</span>
          </div>
          <div className="prob-bar" style={{ margin: "8px 0 10px", opacity: 0.25 }}>
            <span className="prob-yes" style={{ width: "0%" }} />
          </div>
          <div className="stat-card-foot">
            <span className="muted" style={{ fontSize: 11 }}>Awaiting the morning job</span>
          </div>
        </>
      )}
    </>
  );
  return market ? (
    <Link href={tradeHref(market.pubkey)} className="panel stat-card">{inner}</Link>
  ) : (
    <div className="panel stat-card stat-card-empty">{inner}</div>
  );
}

function MarketRow({ ticker, market, yesMid, spot }: { ticker: string; market: MarketView; yesMid: number | null; spot: number | null }) {
  const strikeNum = Number(market.strikePrice) / 1_000_000;
  const dist = distanceToStrike(spot, strikeNum);
  const yesW = yesMid !== null ? Math.round(yesMid * 100) : 0;
  const noMid = yesMid !== null ? noFromYes(yesMid) : null;
  return (
    <div className="market-row">
      <span className="ticker-badge mono" style={{ width: 34, height: 34, fontSize: 10 }}>{ticker}</span>
      <div className="market-row-main">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Will {ticker} close above <span className="mono">${strikeDollars(market.strikePrice)}</span>?</span>
          <span className="mono" style={{ fontWeight: 700, color: yesMid !== null ? "var(--yes)" : "var(--muted)" }}>{pct(yesMid)}</span>
        </div>
        <div className="prob-bar" style={{ margin: "6px 0" }}>
          <span className="prob-yes" style={{ width: `${yesW}%` }} />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Yes {pct(yesMid)} · No {noMid !== null ? `${Math.round(noMid * 100)}%` : "—"}
          {dist !== null && (
            <span style={{ color: dist.aboveStrike ? "var(--yes)" : "var(--no)", marginLeft: 8 }}>{dist.aboveStrike ? "+" : "−"}${usd(Math.abs(dist.delta))} vs strike</span>
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

/** Trading-activity heatmap (time-of-day × Mon–Sun). Illustrative intensities —
 *  the app has no trade-history aggregation backend yet; this populates from
 *  on-chain history once that lands. Weekends are dim (market closed). */
function ActivityPanel() {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const rows = ["10 AM", "12 PM", "2 PM", "4 PM"];
  // Deterministic sample intensities (0–4) per [row][day]; weekends near 0.
  const grid = [
    [3, 4, 2, 1, 4, 0, 0],
    [2, 1, 3, 4, 3, 0, 0],
    [1, 3, 4, 2, 4, 1, 0],
    [2, 2, 1, 3, 2, 0, 0],
  ];
  const tint = (n: number) =>
    n === 0 ? "var(--surface-3)" : `rgba(43, 212, 125, ${0.18 + n * 0.18})`;
  return (
    <aside className="panel dash-aside">
      <div className="dash-aside-head">
        <h3 style={{ fontSize: 15 }}>Trading activity</h3>
        <span className="market-strikes-badge">Last 7 days</span>
      </div>
      <div className="heatmap">
        <div className="heatmap-row">
          <span className="heatmap-time" />
          {days.map((d) => (<span key={d} className="muted heatmap-day">{d}</span>))}
        </div>
        {rows.map((r, ri) => (
          <div className="heatmap-row" key={r}>
            <span className="muted heatmap-time">{r}</span>
            {days.map((d, di) => (
              <span
                key={d}
                className="heatmap-cell"
                style={{ background: tint(grid[ri][di]), borderColor: grid[ri][di] ? "transparent" : "var(--border)" }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="dash-stats-row">
        <div className="stat"><span className="stat-label">Today</span><span className="mono stat-value">14<span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> trades</span></span></div>
        <div className="stat"><span className="stat-label">This week</span><span className="mono stat-value">63<span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> trades</span></span></div>
        <div className="stat"><span className="stat-label">Volume</span><span className="mono stat-value">$8.4k</span></div>
      </div>
    </aside>
  );
}

/** Portfolio value panel with an area chart. Values are illustrative — the app
 *  doesn't yet track portfolio value over time; this renders the real series
 *  once that lands. The months axis mirrors the reference. */
function PortfolioPanel() {
  // Illustrative series → SVG points across a 600×180 box (peak near the right).
  const pts = [8, 22, 18, 40, 34, 58, 52, 74, 96, 120, 110, 138, 128, 150];
  const W = 600, H = 180, max = 160;
  const line = pts.map((v, i) => `${(i / (pts.length - 1)) * W},${H - (v / max) * H}`);
  const peakI = pts.indexOf(Math.max(...pts));
  const peakX = (peakI / (pts.length - 1)) * W;
  const peakY = H - (Math.max(...pts) / max) * H;
  const months = ["Jan", "Feb", "Mar", "Apr", "May"];
  return (
    <section className="panel dash-portfolio">
      <div className="dash-portfolio-stats">
        <div className="stat"><span className="stat-label">Portfolio value</span><span className="mono dash-big">$4,182.00</span></div>
        <div className="stat"><span className="stat-label">Today&apos;s P&amp;L</span><span className="mono stat-value" style={{ color: "var(--yes)" }}>+$312.80 <span style={{ fontSize: 12 }}>(+8.1%)</span></span></div>
        <div className="stat"><span className="stat-label">Open positions</span><span className="mono stat-value">5</span></div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {["1W", "1M", "YTD", "All"].map((t, i) => (
            <span key={t} className="dash-range" data-active={i === 1 ? "true" : undefined}>{t}</span>
          ))}
        </div>
      </div>
      <div className="dash-chart">
        <svg viewBox="0 0 600 180" preserveAspectRatio="none" width="100%" height="180" aria-hidden>
          <defs>
            <linearGradient id="pv" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[45, 90, 135].map((y) => (
            <line key={y} x1="0" y1={y} x2="600" y2={y} stroke="var(--border)" strokeDasharray="3 6" />
          ))}
          <polygon fill="url(#pv)" points={`0,${H} ${line.join(" ")} ${W},${H}`} />
          <polyline fill="none" stroke="var(--accent)" strokeWidth="2.5" points={line.join(" ")} />
          <line x1={peakX} y1={peakY} x2={peakX} y2={H} stroke="var(--accent)" strokeDasharray="3 4" opacity="0.5" />
          <circle cx={peakX} cy={peakY} r="3.5" fill="var(--accent-2)" />
        </svg>
        <div className="dash-chart-months">
          {months.map((m) => (<span key={m} className="muted">{m}</span>))}
        </div>
      </div>
    </section>
  );
}

/** Market insights generated from the LIVE market state (not mock). */
function InsightsPanel({ items }: { items: { ticker: string; text: string }[] }) {
  return (
    <aside className="panel dash-insights">
      <div className="dash-aside-head">
        <h3 style={{ fontSize: 15 }}>⚡ Market insights</h3>
      </div>
      <div className="dash-insights-list">
        {items.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>Insights appear here once markets are live.</p>
        ) : (
          items.map((it, i) => (
            <div className="dash-insight" key={i}>
              <div className="dash-insight-tag">{it.ticker}</div>
              <div style={{ fontSize: 13, color: "var(--text-dim)" }}>{it.text}</div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

export default function Dashboard() {
  const { program, markets, walletPubkey, configError } = useMeridian();
  const prices = usePrices();
  const [filter, setFilter] = useState<MoneynessFilter>("all");

  const groups = useMemo(() => groupActiveByTicker(markets, Math.floor(Date.now() / 1000)), [markets]);
  const active = useMemo(() => groups.flatMap((g) => g.active), [groups]);
  const activeSig = active.map((m) => m.pubkey.toBase58()).sort().join(",");

  const [books, setBooks] = useState<Record<string, BookView | null>>({});
  useEffect(() => {
    if (active.length === 0) { setBooks({}); return; }
    let cancelled = false;
    const load = async () => {
      const entries = await Promise.all(active.map(async (m) => {
        try { return [m.pubkey.toBase58(), await fetchBook(program, m.pubkey)] as const; }
        catch { return [m.pubkey.toBase58(), null] as const; }
      }));
      if (!cancelled) setBooks(Object.fromEntries(entries));
    };
    void load();
    const id = setInterval(() => void load(), BOOK_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, activeSig]);

  const tickerName = useMemo(() => Object.fromEntries(MAG7.map((f) => [f.ticker, f.name])), []);
  const byTicker = useMemo(() => Object.fromEntries(groups.map((g) => [g.ticker, g])), [groups]);
  const tickerOf = (m: MarketView) => groups.find((g) => g.active.includes(m))?.ticker ?? "";
  const yesMidOf = (m: MarketView) => yesMidFraction(books[m.pubkey.toBase58()] ?? null);
  const spotOf = (t: string) => prices[t]?.price ?? null;

  // Stat cards: active markets nearest a coin-flip first, padded to 4 with MAG7
  // stocks that have no market yet (spot-only) so the row always reads as 4.
  const statCards = useMemo(() => {
    const cards: { ticker: string; market: MarketView | null }[] = [...active]
      .sort((a, b) => Math.abs((yesMidOf(a) ?? 0.5) - 0.5) - Math.abs((yesMidOf(b) ?? 0.5) - 0.5))
      .slice(0, 4)
      .map((m) => ({ ticker: tickerOf(m), market: m }));
    const used = new Set(cards.map((c) => c.ticker));
    for (const f of MAG7) {
      if (cards.length >= 4) break;
      if (!used.has(f.ticker)) cards.push({ ticker: f.ticker, market: null });
    }
    return cards;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSig, books]);

  const insights = useMemo(() => {
    const out: { ticker: string; text: string }[] = [];
    for (const m of active) {
      const t = tickerOf(m);
      const ym = yesMidOf(m);
      const spot = spotOf(t);
      const strikeNum = Number(m.strikePrice) / 1_000_000;
      const dist = distanceToStrike(spot, strikeNum);
      if (ym !== null && Math.abs(ym - 0.5) < 0.08) {
        out.push({ ticker: t, text: `${t} is sitting near its $${strikeDollars(m.strikePrice)} strike — Yes implied ${Math.round(ym * 100)}%, a near coin-flip into the close.` });
      } else if (dist) {
        out.push({ ticker: t, text: dist.aboveStrike
          ? `${t} is $${usd(Math.abs(dist.delta))} above its $${strikeDollars(m.strikePrice)} strike — Yes ${pct(ym)}, in the money.`
          : `${t} needs +$${usd(Math.abs(dist.delta))} to clear $${strikeDollars(m.strikePrice)} — No favored at ${ym !== null ? `${Math.round((1 - ym) * 100)}%` : "—"}.` });
      }
    }
    if (active.length > 0) out.push({ ticker: "SETTLEMENT", text: `${active.length} market${active.length === 1 ? "" : "s"} settle at the 4:00 PM ET close. Winners redeem 1:1 for USDC on-chain.` });
    return out.slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSig, books, prices]);

  return (
    <main className="dashboard">
      <div className="dashboard-head">
        <div>
          <h1 style={{ fontSize: 26 }}>Dashboard</h1>
          <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>Daily binary options on the Magnificent Seven · settle at the 4:00 PM ET close.</p>
        </div>
        {!walletPubkey && <WalletButton />}
      </div>

      {configError && <p className="muted" style={{ color: "var(--no)", fontSize: 13 }}>{configError}</p>}

      {/* Row 1 — stat cards */}
      <div className="stat-card-grid">
        {statCards.map((c) => (
          <StatCard key={c.ticker} ticker={c.ticker} name={tickerName[c.ticker] ?? ""} market={c.market} yesMid={c.market ? yesMidOf(c.market) : null} spot={spotOf(c.ticker)} />
        ))}
      </div>

      {/* Row 2 — ticker strip */}
      <div className="ticker-strip">
        {MAG7.map((f) => {
          const p = prices[f.ticker];
          return (
            <div className="ticker-cell" key={f.ticker}>
              <span className="mono" style={{ fontWeight: 700, fontSize: 12 }}>{f.ticker}</span>
              <span className="mono" style={{ fontSize: 12, color: "var(--text-dim)" }}>{p ? `$${usd(p.price)}` : "—"}</span>
            </div>
          );
        })}
      </div>

      {/* Row 3 — today's markets + activity */}
      <div className="dash-2col">
        <section className="panel" style={{ padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
            <div>
              <h2 style={{ fontSize: 17 }}>Today&apos;s markets</h2>
              <p className="muted" style={{ fontSize: 12, margin: "2px 0 0" }}>Daily binary options · settle at the 4:00 PM ET close</p>
            </div>
            <div className="filter-pills">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" className="filter-pill" data-active={filter === f.key ? "true" : undefined} onClick={() => setFilter(f.key)}>{f.label}</button>
              ))}
            </div>
          </div>
          {active.length > 0 ? (
            <div className="market-row-list">
              {active.map((m) => (
                <MarketRow key={m.pubkey.toBase58()} ticker={tickerOf(m)} market={m} yesMid={yesMidOf(m)} spot={spotOf(tickerOf(m))} />
              ))}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>No active markets yet — the morning job creates the day&apos;s strikes.</p>
          )}
        </section>
        <ActivityPanel />
      </div>

      {/* Row 4 — portfolio + insights */}
      <div className="dash-2col">
        <PortfolioPanel />
        <InsightsPanel items={insights} />
      </div>
    </main>
  );
}
