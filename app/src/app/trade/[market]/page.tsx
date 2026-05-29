"use client";

import { useEffect, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";

import { BothSidesBook } from "@/components/BothSidesBook";
import { Countdown } from "@/components/Countdown";
import { Payoff } from "@/components/Payoff";
import { PositionGuard } from "@/components/PositionGuard";
import { RedeemPanel } from "@/components/RedeemPanel";
import { TradePanel } from "@/components/TradePanel";
import { tickerToString } from "@/lib/format";
import { useMeridian } from "@/lib/MeridianContext";
import { yesMidFraction, strikeDollars } from "@/lib/marketsView";
import { usePrices } from "@/lib/prices";

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
        <p className="muted" style={{ color: "var(--ask)" }}>
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
  const strike = m ? Number(m.strikePrice) / 1_000_000 : 0;
  const live = ticker ? prices[ticker] ?? null : null;
  const yesMid = onThisMarket ? yesMidFraction(book) : null;
  // Default the payoff "pay" to the Yes mid (or $0.50 when no book mid yet).
  const payYes = yesMid ?? 0.5;

  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px" }}>
      {configError && (
        <p className="muted" style={{ color: "var(--ask)", fontSize: 13 }}>
          {configError}
        </p>
      )}

      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 16,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div>
          <h1 style={{ fontSize: 26, margin: "0 0 4px" }}>
            {ticker ? `${ticker} above $${strikeDollars(m!.strikePrice)}?` : "Trade"}
          </h1>
          <div className="muted" style={{ fontSize: 13 }}>
            {live
              ? `${ticker} spot $${live.price.toFixed(2)}`
              : ticker
                ? `${ticker} — live price unavailable (off-hours?)`
                : "Loading market…"}
          </div>
        </div>
        {m && <Countdown expiryUnix={m.expiryUnix} />}
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div style={{ display: "grid", gap: 16 }}>
          <BothSidesBook book={onThisMarket ? book : null} />
          {m && (
            <div className="panel">
              <Payoff pay={payYes} ticker={ticker} strike={strike} side="Yes" />
              <div style={{ height: 6 }} />
              <Payoff
                pay={1 - payYes}
                ticker={ticker}
                strike={strike}
                side="No"
              />
            </div>
          )}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <PositionGuard balances={onThisMarket ? balances : null} />
          {m && !m.settled && <TradePanel />}
          {m && m.settled && <RedeemPanel />}
        </div>
      </div>
    </main>
  );
}
