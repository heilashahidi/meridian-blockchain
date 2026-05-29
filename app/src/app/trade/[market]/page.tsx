"use client";

import { useEffect, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";

import { BothSidesBook } from "@/components/BothSidesBook";
import { Countdown } from "@/components/Countdown";
import { PositionGuard } from "@/components/PositionGuard";
import { RedeemPanel } from "@/components/RedeemPanel";
import { TradePanel } from "@/components/TradePanel";
import { tickerToString } from "@/lib/format";
import { useMeridian } from "@/lib/MeridianContext";
import { distanceToStrike } from "@/lib/marketStats";
import { yesMidFraction, strikeDollars } from "@/lib/marketsView";
import { usePrices } from "@/lib/prices";

function usd(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function TradeMarketPage({
  params,
}: {
  params: { market: string };
}) {
  const { selectMarket, market, book, balances, configError } = useMeridian();
  const prices = usePrices();

  // Parse the route PDA once; an invalid base58 yields null (bad link).
  const target = useMemo(() => {
    try {
      return new PublicKey(params.market);
    } catch {
      return null;
    }
  }, [params.market]);

  // Drive the context's selection from the route param. The context then polls
  // this market's data (market + book + balances).
  useEffect(() => {
    if (target) selectMarket(target);
    return () => selectMarket(null);
  }, [target, selectMarket]);

  if (!target) {
    return (
      <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px" }}>
        <h1 style={{ fontSize: 24, margin: "0 0 8px" }}>Trade</h1>
        <p className="muted" style={{ color: "var(--no)" }}>
          Invalid market address.
        </p>
      </main>
    );
  }

  // Guard against rendering the previously-selected market's data while the new
  // one loads (the context clears on selectMarket, but a poll may be in flight).
  const onThisMarket = market !== null && market.pubkey.equals(target);
  const m = onThisMarket ? market : null;

  const ticker = m ? tickerToString(m.ticker) : "";
  const strikeStr = m ? strikeDollars(m.strikePrice) : "";
  const strikeNum = m ? Number(m.strikePrice) / 1_000_000 : 0;
  const live = ticker ? prices[ticker] ?? null : null;
  const spot = live?.price ?? null;
  const yesMid = onThisMarket ? yesMidFraction(book) : null;
  const dist = distanceToStrike(spot, strikeNum);

  const yesPct = yesMid !== null ? Math.round(yesMid * 100) : null;
  const noPct = yesPct !== null ? 100 - yesPct : null;

  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px" }}>
      {configError && (
        <p className="muted" style={{ color: "var(--no)", fontSize: 13 }}>
          {configError}
        </p>
      )}

      {/* Hero header — PRD question framing. */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 16,
          flexWrap: "wrap",
          gap: 16,
        }}
      >
        <div style={{ display: "grid", gap: 6 }}>
          <h1 style={{ fontSize: 30, margin: 0 }}>
            {ticker
              ? `Will ${ticker} close above $${strikeStr} today?`
              : "Trade"}
          </h1>
          {ticker && (
            <div className="muted" style={{ fontSize: 13 }}>
              0DTE · settles 4:00 PM ET · price is the market’s implied probability
            </div>
          )}
        </div>
        {m && <Countdown expiryUnix={m.expiryUnix} />}
      </header>

      {/* Market summary — spot, distance-to-strike, implied-probability bar. */}
      {m && (
        <div
          className="panel"
          style={{ display: "grid", gap: 16, marginBottom: 16 }}
        >
          <div
            style={{
              display: "flex",
              gap: 32,
              flexWrap: "wrap",
              alignItems: "flex-end",
            }}
          >
            <div className="stat">
              <span className="stat-label">{ticker} spot</span>
              <span className="stat-value mono">
                {spot !== null ? `$${usd(spot)}` : "—"}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Strike</span>
              <span className="stat-value mono">${strikeStr}</span>
            </div>
            <div className="stat" style={{ minWidth: 220, flex: 1 }}>
              <span className="stat-label">Distance to strike</span>
              <span style={{ fontSize: 14 }}>
                {dist === null ? (
                  <span className="muted">live price unavailable (off-hours)</span>
                ) : dist.aboveStrike ? (
                  <span style={{ color: "var(--yes)" }}>
                    <span className="mono" style={{ fontWeight: 700 }}>
                      ${usd(spot!)}
                    </span>{" "}
                    is{" "}
                    <span className="mono" style={{ fontWeight: 700 }}>
                      ${usd(Math.abs(dist.delta))} ({dist.pct <= 0 ? "+" : ""}
                      {Math.abs(dist.pct).toFixed(2)}%) above
                    </span>{" "}
                    ${strikeStr}
                  </span>
                ) : (
                  <span style={{ color: "var(--text-dim)" }}>
                    needs{" "}
                    <span className="mono" style={{ fontWeight: 700, color: "var(--no)" }}>
                      +${usd(Math.abs(dist.delta))} (+{Math.abs(dist.pct).toFixed(2)}%)
                    </span>{" "}
                    to close above ${strikeStr}
                  </span>
                )}
              </span>
            </div>
          </div>

          {/* Implied-probability bar — the price IS the probability. */}
          <div style={{ display: "grid", gap: 8 }}>
            {yesMid !== null ? (
              <>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 14,
                    fontWeight: 700,
                  }}
                >
                  <span style={{ color: "var(--yes)" }}>Yes {yesPct}%</span>
                  <span style={{ color: "var(--no)" }}>No {noPct}%</span>
                </div>
                <div className="prob-bar">
                  <span className="prob-yes" style={{ width: `${yesMid * 100}%` }} />
                </div>
              </>
            ) : (
              <div className="muted" style={{ fontSize: 13 }}>
                No market price yet — be the first to quote.
              </div>
            )}
          </div>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <BothSidesBook book={onThisMarket ? book : null} />

        <div style={{ display: "grid", gap: 16 }}>
          <PositionGuard balances={onThisMarket ? balances : null} />
          {m && !m.settled && <TradePanel />}
          {m && m.settled && <RedeemPanel />}
        </div>
      </div>
    </main>
  );
}
