"use client";

import { useEffect, useState } from "react";

import { countdownState } from "@/lib/countdown";

/**
 * Prominent settlement countdown to the market's 4PM ET expiry (`expiryUnix`,
 * unix seconds). Ticks once a second; shows a "Settling / Closed" state once
 * expired. The time math lives in the pure `countdownState` helper (unit-tested)
 * — this only supplies the live `now` and the urgency styling.
 *
 * Urgency: normal (text) → under 30 min uses --warn → under 5 min adds a subtle
 * pulse → expired shows "Settling / Closed" in --no.
 */
export function Countdown({ expiryUnix }: { expiryUnix: bigint }) {
  const expiry = Number(expiryUnix);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const state = countdownState(now, expiry);
  const remaining = state.remainingSeconds;
  const urgent = !state.closed && remaining < 30 * 60;
  const critical = !state.closed && remaining < 5 * 60;

  const color = state.closed ? "var(--no)" : urgent ? "var(--warn)" : "var(--text)";

  return (
    <div
      style={{
        display: "grid",
        gap: 2,
        justifyItems: "end",
        textAlign: "right",
      }}
    >
      <span className="stat-label">
        {state.closed ? "Trading closed" : "Settles in"}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 30,
          fontWeight: 800,
          lineHeight: 1.05,
          letterSpacing: "-0.01em",
          color,
          animation: critical ? "pulse-soft 1.4s ease-in-out infinite" : undefined,
        }}
      >
        {state.closed ? "Settling / Closed" : state.label}
      </span>
      <span className="muted" style={{ fontSize: 11 }}>
        0DTE · 4:00 PM ET
      </span>
    </div>
  );
}
