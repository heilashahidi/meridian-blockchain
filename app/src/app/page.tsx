"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

import { MAG7 } from "@/lib/feeds";
import { fetchBalances, fetchBook, type BookView, type MarketView } from "@/lib/market";
import {
  groupActiveByTicker,
  noFromYes,
  strikeDollars,
  tradeHref,
  yesMidFraction,
} from "@/lib/marketsView";
import { distanceToStrike } from "@/lib/marketStats";
import { contractsFromBaseUnits } from "@/lib/pnl";
import { fetchHistory, type HistoryEntry } from "@/lib/history";
import { useMeridian } from "@/hooks/MeridianContext";
import { usePrices } from "@/hooks/usePrices";
import { WalletButton } from "@/components/WalletButton";
import { type MoneynessFilter } from "@/components/StockTile";

const BOOK_POLL_MS = 6000;
const usd = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (yes: number | null) => (yes === null ? "—" : `${Math.round(yes * 100)}%`);

// Optional read-only preview wallet (a real on-chain account): when no wallet is
// connected, the activity + portfolio panels show THIS account's live data so a
// fresh/logged-out dashboard isn't empty. Read-only (public key only, no signing).
const DEMO_WALLET: PublicKey | null = (() => {
  const s = process.env.NEXT_PUBLIC_DEMO_WALLET;
  if (!s) return null;
  try { return new PublicKey(s); } catch { return null; }
})();

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

/** ET day-of-week (0=Mon..6=Sun) + time slot (0..3) for a unix instant. */
function etBucket(unix: number): { day: number; slot: number } | null {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(unix * 1000));
  const wk = f.find((p) => p.type === "weekday")?.value ?? "";
  const order: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const day = order[wk];
  if (day === undefined) return null;
  let h = Number(f.find((p) => p.type === "hour")?.value ?? "0");
  if (h === 24) h = 0;
  const slot = h < 11 ? 0 : h < 13 ? 1 : h < 15 ? 2 : 3; // 10AM / 12PM / 2PM / 4PM
  return { day, slot };
}

/** Trading-activity heatmap — REAL, from the connected wallet's on-chain
 *  transaction history bucketed by ET day × time-of-day over the last 7 days. */
function ActivityPanel() {
  const { walletPubkey } = useMeridian();
  const { connection } = useConnection();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const eff = walletPubkey ?? DEMO_WALLET;
  const preview = !walletPubkey && !!DEMO_WALLET;

  useEffect(() => {
    if (!eff) { setEntries([]); return; }
    let cancelled = false;
    fetchHistory(connection, eff)
      .then((e) => { if (!cancelled) setEntries(e); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [connection, eff]);

  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const rows = ["10 AM", "12 PM", "2 PM", "4 PM"];
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const trades = entries.filter((e) => !e.failed && e.action === "trade" && e.blockTime);

  // counts[slot][day]
  const counts = rows.map(() => days.map(() => 0));
  let today = 0;
  const todayStart = (() => {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return f;
  })();
  for (const e of trades) {
    const bt = e.blockTime as number;
    if (bt < weekAgo) continue;
    const b = etBucket(bt);
    if (b) counts[b.slot][b.day]++;
    const d = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(bt * 1000));
    if (d === todayStart) today++;
  }
  const maxC = Math.max(1, ...counts.flat());
  const tint = (n: number) => (n === 0 ? "var(--surface-3)" : `rgba(43, 212, 125, ${0.2 + (n / maxC) * 0.6})`);
  const week = trades.filter((e) => (e.blockTime as number) >= weekAgo).length;

  return (
    <aside className="panel dash-aside">
      <div className="dash-aside-head">
        <h3 style={{ fontSize: 15 }}>Trading activity</h3>
        <span className="market-strikes-badge">{preview ? "Demo · 7 days" : "Last 7 days"}</span>
      </div>
      {!eff ? (
        <p className="muted" style={{ fontSize: 13 }}>Connect a wallet to see your trading activity.</p>
      ) : (
        <>
          <div className="heatmap">
            <div className="heatmap-row">
              <span className="heatmap-time" />
              {days.map((d) => (<span key={d} className="muted heatmap-day">{d}</span>))}
            </div>
            {rows.map((r, ri) => (
              <div className="heatmap-row" key={r}>
                <span className="muted heatmap-time">{r}</span>
                {days.map((d, di) => (
                  <span key={d} className="heatmap-cell" title={`${counts[ri][di]} trade(s)`} style={{ background: tint(counts[ri][di]), borderColor: counts[ri][di] ? "transparent" : "var(--border)" }} />
                ))}
              </div>
            ))}
          </div>
          <div className="dash-stats-row">
            <div className="stat"><span className="stat-label">Today</span><span className="mono stat-value">{today}<span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> trades</span></span></div>
            <div className="stat"><span className="stat-label">This week</span><span className="mono stat-value">{week}<span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> trades</span></span></div>
            <div className="stat"><span className="stat-label">All-time</span><span className="mono stat-value">{trades.length}</span></div>
          </div>
        </>
      )}
    </aside>
  );
}

interface PvPoint { t: number; v: number }
const RANGES: { key: string; ms: number }[] = [
  { key: "1W", ms: 7 * 86400_000 },
  { key: "1M", ms: 30 * 86400_000 },
  { key: "YTD", ms: 365 * 86400_000 },
  { key: "All", ms: Infinity },
];

/** Portfolio value panel — REAL. Computes total value = USDC + position
 *  mark-to-market across active markets, records a timestamped series in
 *  localStorage (per wallet), and plots the recorded trajectory. The series
 *  builds as you revisit/trade; it's your actual value over time, not a mock. */
function PortfolioPanel({ active, books }: { active: MarketView[]; books: Record<string, BookView | null> }) {
  const { walletPubkey, config } = useMeridian();
  const { connection } = useConnection();
  const eff = walletPubkey ?? DEMO_WALLET;
  const preview = !walletPubkey && !!DEMO_WALLET;
  const [value, setValue] = useState<number | null>(null);
  const [positions, setPositions] = useState(0);
  const [series, setSeries] = useState<PvPoint[]>([]);
  const [range, setRange] = useState("1M");

  const activeSig = active.map((m) => m.pubkey.toBase58()).sort().join(",");
  const key = eff ? `meridian.pv.${eff.toBase58()}` : null;

  useEffect(() => {
    if (!eff || !config) { setValue(null); setPositions(0); setSeries([]); return; }
    let cancelled = false;
    const load = async () => {
      let usdc = 0, posVal = 0, posCount = 0;
      const per = await Promise.all(active.map(async (m) => {
        try { return [m, await fetchBalances(connection, eff, config.usdcMint, m)] as const; }
        catch { return [m, null] as const; }
      }));
      for (const [m, bals] of per) {
        if (!bals) continue;
        usdc = Number(bals.usdc) / 1_000_000; // same wallet USDC across markets
        const yes = contractsFromBaseUnits(bals.yes);
        const no = contractsFromBaseUnits(bals.no);
        const ym = yesMidFraction(books[m.pubkey.toBase58()] ?? null);
        if (ym !== null) { posVal += yes * ym + no * (1 - ym); }
        if (yes > 0 || no > 0) posCount++;
      }
      const total = usdc + posVal;
      if (cancelled) return;
      setValue(total);
      setPositions(posCount);
      // append to the localStorage series (throttle to ~1/min)
      if (key) {
        let arr: PvPoint[] = [];
        try { arr = JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { arr = []; }
        const now = Date.now();
        if (arr.length === 0 || now - arr[arr.length - 1].t > 60_000) {
          arr.push({ t: now, v: total });
          arr = arr.slice(-300);
          localStorage.setItem(key, JSON.stringify(arr));
        } else {
          arr[arr.length - 1] = { t: now, v: total };
        }
        setSeries(arr);
      }
    };
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, eff, config, activeSig, books]);

  const usd2 = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const rangeMs = RANGES.find((r) => r.key === range)?.ms ?? Infinity;
  const cut = Date.now() - rangeMs;
  const pts = series.filter((p) => p.t >= cut);
  const todayPnl = (() => {
    if (pts.length < 2) return null;
    return pts[pts.length - 1].v - pts[0].v;
  })();

  // chart geometry
  const W = 600, H = 180;
  let path = "";
  if (pts.length >= 2) {
    const vs = pts.map((p) => p.v);
    const min = Math.min(...vs), max = Math.max(...vs);
    const span = max - min || 1;
    const t0 = pts[0].t, tspan = pts[pts.length - 1].t - t0 || 1;
    path = pts.map((p) => `${((p.t - t0) / tspan) * W},${H - ((p.v - min) / span) * (H - 20) - 10}`).join(" ");
  } else if (value !== null) {
    path = `0,${H / 2} ${W},${H / 2}`; // flat line until ≥2 points
  }

  return (
    <section className="panel dash-portfolio">
      <div className="dash-portfolio-stats">
        <div className="stat"><span className="stat-label">Portfolio value</span><span className="mono dash-big">{value !== null ? usd2(value) : "—"}</span></div>
        <div className="stat"><span className="stat-label">Range P&amp;L</span><span className="mono stat-value" style={{ color: todayPnl === null ? "var(--text-dim)" : todayPnl >= 0 ? "var(--yes)" : "var(--no)" }}>{todayPnl === null ? "—" : `${todayPnl >= 0 ? "+" : "−"}${usd2(Math.abs(todayPnl)).slice(1)}`}</span></div>
        <div className="stat"><span className="stat-label">Open positions</span><span className="mono stat-value">{eff ? positions : "—"}</span></div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {preview && <span className="badge-devnet" style={{ marginLeft: 0 }}>Demo</span>}
          {RANGES.map((r) => (
            <button key={r.key} type="button" className="dash-range" data-active={range === r.key ? "true" : undefined} onClick={() => setRange(r.key)}>{r.key}</button>
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
          {[45, 90, 135].map((y) => (<line key={y} x1="0" y1={y} x2="600" y2={y} stroke="var(--border)" strokeDasharray="3 6" />))}
          {path && (
            <>
              <polygon fill="url(#pv)" points={`0,${H} ${path} ${W},${H}`} />
              <polyline fill="none" stroke="var(--accent)" strokeWidth="2.5" points={path} />
            </>
          )}
        </svg>
        {(!eff || pts.length < 2) && (
          <div className="dash-chart-note muted">{eff ? "Value plots here as it's sampled over time (revisit/trade to build the curve)." : "Connect a wallet to track your portfolio value over time."}</div>
        )}
      </div>
    </section>
  );
}

const etTime = () =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date());

/** Market insights from LIVE market state, with a chat box that answers from the
 *  same real data (a deterministic market lookup, not an LLM). */
function InsightsPanel({ items, onAsk }: { items: { ticker: string; text: string }[]; onAsk: (q: string) => string }) {
  const [q, setQ] = useState("");
  const [chat, setChat] = useState<{ ticker: string; text: string; time: string }[]>([]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    setChat((c) => [{ ticker: "YOU", text: query, time: etTime() }, { ticker: "MERIDIAN", text: onAsk(query), time: etTime() }, ...c]);
    setQ("");
  };
  const live = items.map((it) => ({ ...it, time: etTime() }));
  const all = [...chat, ...live];
  return (
    <aside className="panel dash-insights">
      <div className="dash-aside-head">
        <h3 style={{ fontSize: 15 }}>⚡ Market insights</h3>
      </div>
      <div className="dash-insights-list">
        {all.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>Insights appear here once markets are live.</p>
        ) : (
          all.map((it, i) => (
            <div className="dash-insight" key={i}>
              <div className="dash-insight-row">
                <span className="dash-insight-tag">{it.ticker}</span>
                <span className="muted dash-insight-time">{it.time}</span>
              </div>
              <div style={{ fontSize: 13, color: "var(--text-dim)" }}>{it.text}</div>
            </div>
          ))
        )}
      </div>
      <form className="dash-chat" onSubmit={submit}>
        <input className="dash-chat-input" placeholder="Ask about any market…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Ask about a market" />
        <button type="submit" className="dash-chat-send" aria-label="Send">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        </button>
      </form>
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

  // Chat: answer a question from the real market data (deterministic lookup).
  const onAsk = (query: string): string => {
    const t = MAG7.find((f) => query.toUpperCase().includes(f.ticker))?.ticker;
    if (!t) return "Ask about a MAG7 ticker — e.g. “NVDA” or “META $700” — and I’ll read the live market.";
    const mkts = active.filter((m) => tickerOf(m) === t);
    if (mkts.length === 0) {
      const s = spotOf(t);
      return `${t} has no active contract yet${s !== null ? ` — spot is $${usd(s)}` : ""}. The morning job creates the day’s strikes.`;
    }
    const m = mkts[0];
    const ym = yesMidOf(m);
    const s = spotOf(t);
    const strikeNum = Number(m.strikePrice) / 1_000_000;
    const dist = distanceToStrike(s, strikeNum);
    return `${t} > $${strikeDollars(m.strikePrice)}: Yes implied ${pct(ym)}${s !== null ? `, spot $${usd(s)}` : ""}${dist ? ` (${dist.aboveStrike ? "+" : "−"}$${usd(Math.abs(dist.delta))} vs strike)` : ""}. Settles at the 4:00 PM ET close.`;
  };

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
        <PortfolioPanel active={active} books={books} />
        <InsightsPanel items={insights} onAsk={onAsk} />
      </div>
    </main>
  );
}
