"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { WalletButton } from "@/components/WalletButton";

/** ET wall-clock parts (DST-correct via Intl), recomputed each tick. */
function etParts(d: Date) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return {
    weekday: get("weekday"),
    hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Live status + countdown to the next 4:00 PM ET close. "Market open" when it's
 * a weekday between 9:30 and 16:00 ET. The countdown is computed from the ET
 * wall clock (no offset math), so it's DST-correct.
 */
function MarketClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!now) return <div className="topbar-clock" aria-hidden style={{ width: 188 }} />;

  const et = etParts(now);
  const weekday = !["Sat", "Sun"].includes(et.weekday);
  const mins = et.hour * 60 + et.minute;
  const open = weekday && mins >= 570 && mins < 960; // 9:30–16:00 ET

  // Seconds until the next 16:00 ET (today or tomorrow), from ET wall clock.
  const nowSec = et.hour * 3600 + et.minute * 60 + et.second;
  const target = 16 * 3600;
  const remaining = nowSec < target ? target - nowSec : 24 * 3600 - nowSec + target;
  const hh = Math.floor(remaining / 3600);
  const mm = Math.floor((remaining % 3600) / 60);
  const ss = remaining % 60;

  return (
    <div className="topbar-clock">
      <span className={`topbar-pill ${open ? "is-open" : "is-closed"}`}>
        <span className="topbar-dot" aria-hidden />
        {open ? "Market open" : "Market closed"}
      </span>
      <span className="topbar-clock-text">
        <span className="muted">Settles 4:00 PM ET</span>
        <span className="mono topbar-countdown">
          {pad(hh)}:{pad(mm)}:{pad(ss)}
        </span>
      </span>
    </div>
  );
}

function DateChip() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  if (!now) return null;
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).formatToParts(now);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return (
    <div className="topbar-date">
      <span className="topbar-date-day mono">{get("day")}</span>
      <span className="topbar-date-rest">
        {get("weekday")}, {get("month")}
        <br />
        {get("year")}
      </span>
    </div>
  );
}

/**
 * Top bar of the app-shell. Search (routes to Markets), live market clock,
 * date, and the wallet connect. The per-market settlement countdown still lives
 * on the Trade screen; this is the global status strip.
 */
export function TopBar() {
  const router = useRouter();
  const [q, setQ] = useState("");

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    router.push(q.trim() ? `/markets?q=${encodeURIComponent(q.trim())}` : "/markets");
  };

  return (
    <header className="topbar">
      <form className="topbar-search" onSubmit={onSearch} role="search">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4-4" />
        </svg>
        <input
          className="topbar-search-input"
          placeholder="Search markets — try “NVDA”, “META $700”…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search markets"
        />
        <kbd className="topbar-kbd">/</kbd>
      </form>

      <div className="topbar-right">
        <MarketClock />
        <DateChip />
        <WalletButton />
      </div>
    </header>
  );
}
