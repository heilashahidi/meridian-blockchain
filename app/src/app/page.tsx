"use client";

import Link from "next/link";

import { MAG7 } from "@/lib/feeds";
import { priceAgeLabel, usePrices, type PriceData } from "@/lib/prices";
import { useMeridian } from "@/lib/MeridianContext";
import { WalletButton } from "@/components/WalletButton";

function PriceTile({
  ticker,
  name,
  data,
}: {
  ticker: string;
  name: string;
  data: PriceData | null;
}) {
  const fresh = data && Date.now() / 1000 - data.publishTime < 60;
  return (
    <div className="panel" style={{ padding: 14 }}>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
      >
        <div>
          <div style={{ fontWeight: 700 }}>{ticker}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {name}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="mono" style={{ fontSize: 18 }}>
            {data ? `$${data.price.toFixed(2)}` : "—"}
          </div>
          <div
            className="muted"
            style={{
              fontSize: 11,
              color: fresh ? "var(--bid)" : "var(--muted)",
            }}
          >
            {priceAgeLabel(data)}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const prices = usePrices();
  const { walletPubkey } = useMeridian();

  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px" }}>
      <section style={{ marginBottom: 36 }}>
        <h1 style={{ fontSize: 34, margin: "0 0 12px" }}>
          Trade MAG7 binary options on Solana
        </h1>
        <p
          className="muted"
          style={{ fontSize: 16, maxWidth: 680, lineHeight: 1.5, margin: 0 }}
        >
          Meridian is a non-custodial, on-chain order book for daily binary
          options on the seven largest US tech stocks. Each contract pays{" "}
          <strong style={{ color: "var(--text)" }}>$1.00</strong> if the stock
          settles above its strike at the 4:00 PM ET close, and{" "}
          <strong style={{ color: "var(--text)" }}>$0.00</strong> if it
          doesn&apos;t. Buy Yes or No, rest limit orders, and settle against a
          live Pyth oracle — all from your own wallet, with no custodian.
        </p>

        <div
          style={{
            display: "flex",
            gap: 12,
            marginTop: 20,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {walletPubkey ? (
            <Link href="/markets" className="btn" style={{ textDecoration: "none" }}>
              Browse markets →
            </Link>
          ) : (
            <>
              <WalletButton />
              <span className="muted" style={{ fontSize: 13 }}>
                Connect a wallet to start trading.
              </span>
            </>
          )}
        </div>
      </section>

      <section>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 12,
          }}
        >
          <h2 style={{ fontSize: 18, margin: 0 }}>Live prices</h2>
          <Link href="/markets" style={{ fontSize: 13 }}>
            View all markets →
          </Link>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          {MAG7.map((f) => (
            <PriceTile
              key={f.ticker}
              ticker={f.ticker}
              name={f.name}
              data={prices[f.ticker] ?? null}
            />
          ))}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          Equity feeds publish during US market hours (9:30 AM–4:00 PM ET,
          weekdays). Off-hours prices show the last regular-session value.
        </p>
      </section>
    </main>
  );
}
