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
import { distanceToStrike } from "@/lib/marketStats";
import { fmtExpiry } from "@/lib/format";

/**
 * One active-strike contract card, framed as a prediction-market question:
 * "Will {TICKER} close above ${STRIKE}?". The implied probability (Yes price as
 * a percent) is the hero metric, backed by a `.prob-bar`, with the Yes/No
 * prices below. A distance-to-strike mini-indicator (ITM/OTM tinted) shows how
 * far live spot sits from the strike. Links into the Trade page for this
 * market's PDA. `yesPrice` may be null while the book loads or has no ask —
 * the card still renders with "—" prices. `spot` may be null off-hours.
 */
export function MarketCard({
  ticker,
  market,
  yesPrice,
  spot,
}: {
  ticker: string;
  market: MarketView;
  /** Yes price (best ask) as a $0–$1 fraction, or null when no ask to quote. */
  yesPrice: number | null;
  /** Live spot price in USD, or null when unavailable. */
  spot: number | null;
}) {
  const hasPrice = yesPrice !== null;
  const noPrice = hasPrice ? noFromYes(yesPrice) : null;
  const yesPctWidth = hasPrice ? Math.round(yesPrice * 100) : 0;

  const strikeStr = strikeDollars(market.strikePrice);
  const strikeNum = Number(market.strikePrice) / 1_000_000;
  const dist = distanceToStrike(spot, strikeNum);

  return (
    <Link
      href={tradeHref(market.pubkey)}
      className="panel"
      style={{
        display: "grid",
        gap: 12,
        textDecoration: "none",
        color: "var(--text)",
        padding: 16,
        transition: "border-color 0.14s ease, transform 0.06s ease",
      }}
    >
      {/* Question is the hero. */}
      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>
        Will {ticker} close above{" "}
        <span className="mono">${strikeStr}</span>?
      </div>

      {/* Implied probability — the price IS the probability. */}
      <div style={{ display: "grid", gap: 6 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: hasPrice ? "var(--yes)" : "var(--muted)",
              letterSpacing: "-0.02em",
            }}
          >
            {impliedProbabilityLabel(yesPrice)}
          </span>
          <span className="muted" style={{ fontSize: 11 }}>
            Yes implied
          </span>
        </div>
        <div className="prob-bar">
          <span className="prob-yes" style={{ width: `${yesPctWidth}%` }} />
        </div>
      </div>

      {/* Yes / No prices. */}
      <div style={{ display: "flex", gap: 8 }}>
        <div
          style={{
            flex: 1,
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
          }}
        >
          <div className="muted" style={{ fontSize: 11 }}>
            Yes
          </div>
          <div className="mono" style={{ color: "var(--yes)", fontSize: 15 }}>
            {hasPrice ? fractionUsd(yesPrice) : "—"}
          </div>
        </div>
        <div
          style={{
            flex: 1,
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
          }}
        >
          <div className="muted" style={{ fontSize: 11 }}>
            No
          </div>
          <div className="mono" style={{ color: "var(--no)", fontSize: 15 }}>
            {noPrice !== null ? fractionUsd(noPrice) : "—"}
          </div>
        </div>
      </div>

      {/* Distance-to-strike mini-indicator — ITM/OTM tinted. */}
      <div style={{ fontSize: 12 }}>
        {dist === null ? (
          <span className="muted">Live price unavailable</span>
        ) : dist.aboveStrike ? (
          <span style={{ color: "var(--yes)" }}>
            In the money ·{" "}
            <span className="mono" style={{ fontWeight: 600 }}>
              +${Math.abs(dist.delta).toFixed(2)} (+
              {Math.abs(dist.pct).toFixed(1)}%)
            </span>{" "}
            above strike
          </span>
        ) : (
          <span style={{ color: "var(--text-dim)" }}>
            Needs{" "}
            <span
              className="mono"
              style={{ fontWeight: 600, color: "var(--no)" }}
            >
              +${Math.abs(dist.delta).toFixed(2)} (+
              {Math.abs(dist.pct).toFixed(1)}%)
            </span>{" "}
            to cross
          </span>
        )}
      </div>

      <div
        className="muted"
        style={{
          fontSize: 11,
          borderTop: "1px solid var(--border)",
          paddingTop: 10,
        }}
      >
        Expires {fmtExpiry(market.expiryUnix)}
      </div>
    </Link>
  );
}
