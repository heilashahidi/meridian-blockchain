"use client";

import Link from "next/link";
import type { PublicKey } from "@solana/web3.js";

import type { MarketView } from "@/lib/market";
import { strikeDollars, strikesForTicker, tradeHref } from "@/lib/marketsView";
import { tickerToString } from "@/lib/format";

/**
 * Strike list for the selected stock (PRD §300/§301): the day's strike ladder
 * for one ticker, so a user can switch strikes from the Trade screen without
 * going back to Markets. Each strike links to its own Trade route; the active
 * strike is highlighted. Strikes near the current price trade most actively, so
 * the ladder (ascending) doubles as a quick at-a-glance moneyness picker.
 */
export function StrikeList({
  markets,
  current,
}: {
  markets: MarketView[];
  current: MarketView;
}) {
  const ticker = tickerToString(current.ticker);
  const ladder = strikesForTicker(markets, current.ticker, current.expiryUnix);

  // Nothing to switch between (only this strike exists for the day).
  if (ladder.length <= 1) return null;

  return (
    <nav
      className="panel"
      aria-label={`${ticker} strikes`}
      style={{ display: "grid", gap: 8 }}
    >
      <div className="stat-label">{ticker} strikes</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {ladder.map((m) => {
          const active = m.pubkey.equals(current.pubkey as PublicKey);
          return (
            <Link
              key={m.pubkey.toBase58()}
              href={tradeHref(m.pubkey)}
              className="seg"
              aria-current={active ? "page" : undefined}
              data-active={active ? "yes" : undefined}
              style={{
                padding: "6px 12px",
                textDecoration: "none",
                opacity: m.settled ? 0.6 : 1,
              }}
              title={
                m.settled
                  ? `$${strikeDollars(m.strikePrice)} (settled)`
                  : `Trade ${ticker} > $${strikeDollars(m.strikePrice)}`
              }
            >
              <span className="mono">${strikeDollars(m.strikePrice)}</span>
              {m.settled && (
                <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                  settled
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
