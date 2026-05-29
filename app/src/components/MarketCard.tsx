"use client";

import Link from "next/link";

import type { MarketView } from "@/lib/market";
import {
  fractionUsd,
  impliedProbabilityLabel,
  noFromYes,
  strikeDollars,
  tradeHref,
} from "@/lib/marketsView";
import { fmtExpiry } from "@/lib/format";

/**
 * One active-strike card. Shows the strike, the current Yes/No mid (from the
 * book), the implied probability, and links into the Trade page for this
 * market's PDA. `book` may be null while it loads or when the book is empty —
 * the card still renders with "—" mids.
 */
export function MarketCard({
  market,
  yesMid,
}: {
  market: MarketView;
  /** Yes mid as a $0–$1 fraction, or null when no derivable mid. */
  yesMid: number | null;
}) {
  const hasMid = yesMid !== null;
  const noMid = hasMid ? noFromYes(yesMid) : null;

  return (
    <Link
      href={tradeHref(market.pubkey)}
      className="panel"
      style={{
        display: "block",
        textDecoration: "none",
        color: "var(--text)",
        padding: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 10,
        }}
      >
        <div className="mono" style={{ fontSize: 16, fontWeight: 700 }}>
          ${strikeDollars(market.strikePrice)}
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {impliedProbabilityLabel(yesMid)} implied
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <div
          style={{
            flex: 1,
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 8px",
          }}
        >
          <div className="muted" style={{ fontSize: 11 }}>
            Yes
          </div>
          <div className="mono" style={{ color: "var(--bid)", fontSize: 15 }}>
            {hasMid ? fractionUsd(yesMid) : "—"}
          </div>
        </div>
        <div
          style={{
            flex: 1,
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 8px",
          }}
        >
          <div className="muted" style={{ fontSize: 11 }}>
            No
          </div>
          <div className="mono" style={{ color: "var(--ask)", fontSize: 15 }}>
            {noMid !== null ? fractionUsd(noMid) : "—"}
          </div>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
        Expires {fmtExpiry(market.expiryUnix)}
      </div>
    </Link>
  );
}
