"use client";

import { useEffect, useState } from "react";

import { countdownState } from "@/lib/countdown";

/**
 * Settlement countdown to the market's 4PM ET expiry (`expiryUnix`, unix
 * seconds). Ticks once a second; shows a "Closed" state once expired. The time
 * math lives in the pure `countdownState` helper (unit-tested) — this only
 * supplies the live `now`.
 */
export function Countdown({ expiryUnix }: { expiryUnix: bigint }) {
  const expiry = Number(expiryUnix);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const state = countdownState(now, expiry);

  return (
    <div className="panel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span className="muted" style={{ fontSize: 13 }}>
        {state.closed ? "Trading closed" : "Settles in"}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: state.closed ? "var(--ask)" : "var(--text)",
        }}
      >
        {state.label}
      </span>
    </div>
  );
}
