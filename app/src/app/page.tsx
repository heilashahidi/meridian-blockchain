"use client";

import Link from "next/link";

import { MAG7 } from "@/lib/feeds";
import { priceAgeLabel, type PriceData } from "@/lib/prices";
import { usePrices } from "@/hooks/usePrices";
import { useMeridian } from "@/hooks/MeridianContext";
import { WalletButton } from "@/components/WalletButton";

/** One stock in the live MAG7 ticker strip. */
function TickerCell({
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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        borderRight: "1px solid var(--border)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          flexShrink: 0,
          background: fresh ? "var(--yes)" : "var(--muted)",
          boxShadow: fresh ? "0 0 8px var(--yes)" : "none",
        }}
      />
      <div style={{ display: "grid", lineHeight: 1.2 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{ticker}</span>
        <span className="muted" style={{ fontSize: 11 }}>
          {name}
        </span>
      </div>
      <div style={{ display: "grid", textAlign: "right", marginLeft: 8 }}>
        <span className="mono" style={{ fontSize: 14, fontWeight: 600 }}>
          {data ? `$${data.price.toFixed(2)}` : "—"}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: fresh ? "var(--yes)" : "var(--muted)",
          }}
        >
          {priceAgeLabel(data)}
        </span>
      </div>
    </div>
  );
}

/** A "how it works" step with a CSS-shape glyph (no emojis). */
function Step({
  n,
  glyph,
  title,
  body,
}: {
  n: number;
  glyph: React.ReactNode;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="panel" style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          aria-hidden
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            display: "grid",
            placeItems: "center",
            background: "var(--accent-dim)",
            border: "1px solid var(--border-strong)",
            color: "var(--accent-2)",
          }}
        >
          {glyph}
        </div>
        <span className="mono muted" style={{ fontSize: 12 }}>
          STEP {n}
        </span>
      </div>
      <h3 style={{ fontSize: 16, margin: 0 }}>{title}</h3>
      <p className="dim" style={{ fontSize: 13, margin: 0, lineHeight: 1.55 }}>
        {body}
      </p>
    </div>
  );
}

export default function Home() {
  const prices = usePrices();
  const { walletPubkey } = useMeridian();

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "0 16px 64px" }}>
      {/* ── Hero ─────────────────────────────────────────────── */}
      <section
        style={{
          position: "relative",
          overflow: "hidden",
          borderRadius: "var(--radius-lg)",
          border: "1px solid var(--border)",
          margin: "28px 0",
          padding: "clamp(40px, 7vw, 80px) clamp(24px, 5vw, 64px)",
          background:
            "radial-gradient(900px 420px at 78% -10%, rgba(109,106,254,0.28), transparent 60%), " +
            "radial-gradient(700px 380px at 8% 120%, rgba(43,212,125,0.10), transparent 55%), " +
            "linear-gradient(180deg, var(--surface), #11141d)",
        }}
      >
        <span
          className="pill"
          style={{ marginBottom: 18, borderColor: "var(--accent)", color: "var(--accent-2)" }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: "var(--yes)",
              boxShadow: "0 0 8px var(--yes)",
            }}
          />
          Live on Solana · 0DTE binary options
        </span>

        <h1
          style={{
            fontSize: "clamp(34px, 5.5vw, 56px)",
            margin: "0 0 18px",
            maxWidth: 760,
            lineHeight: 1.05,
          }}
        >
          Will{" "}
          <span style={{ color: "var(--accent-2)" }}>AAPL close above $230</span>{" "}
          today?
          <br />
          Take a side for{" "}
          <span className="mono" style={{ color: "var(--yes)" }}>
            $1
          </span>
          .
        </h1>

        <p
          className="dim"
          style={{
            fontSize: 17,
            maxWidth: 620,
            lineHeight: 1.55,
            margin: "0 0 12px",
          }}
        >
          Meridian is a non-custodial order book for daily binary options on the
          Magnificent Seven. Buy <strong style={{ color: "var(--yes)" }}>Yes</strong> or{" "}
          <strong style={{ color: "var(--no)" }}>No</strong> on whether a stock
          closes above its strike. Every Yes + No pair is worth exactly{" "}
          <span className="mono" style={{ color: "var(--text)" }}>$1 USDC</span> —
          your <strong style={{ color: "var(--text)" }}>max gain and max loss
          are known at entry</strong>. No Greeks, no margin, no liquidations.
        </p>
        <p className="muted" style={{ fontSize: 14, margin: "0 0 28px" }}>
          Same-day settle at 4:00 PM ET against a Pyth oracle. The winning side
          redeems for <span className="mono">$1</span>; the other expires worthless.
        </p>

        {/* CTAs */}
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {walletPubkey ? (
            <Link
              href="/markets"
              className="btn"
              style={{ textDecoration: "none", fontSize: 15, padding: "12px 22px" }}
            >
              Explore markets →
            </Link>
          ) : (
            <WalletButton />
          )}
          <Link
            href="/markets"
            className="btn-ghost"
            style={{
              textDecoration: "none",
              fontSize: 15,
              padding: "11px 20px",
              borderRadius: "var(--radius-sm)",
              fontWeight: 600,
            }}
          >
            {walletPubkey ? "How it works" : "Explore markets"}
          </Link>
          {!walletPubkey && (
            <span className="muted" style={{ fontSize: 13 }}>
              Connect a wallet to start trading — no sign-up, no KYC.
            </span>
          )}
        </div>

        {/* Trust / feature chips */}
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            marginTop: 28,
          }}
        >
          {["Non-custodial", "On-chain CLOB", "Pyth oracle", "No KYC"].map((c) => (
            <span key={c} className="pill">
              {c}
            </span>
          ))}
        </div>
      </section>

      {/* ── Live MAG7 ticker strip ───────────────────────────── */}
      <section style={{ marginBottom: 56 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 12,
          }}
        >
          <h2 style={{ fontSize: 14, margin: 0, color: "var(--muted)", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Live MAG7 prices
          </h2>
          <Link href="/markets" style={{ fontSize: 13 }}>
            View all markets →
          </Link>
        </div>
        <div
          className="panel"
          style={{
            padding: 0,
            overflowX: "auto",
            background:
              "linear-gradient(90deg, rgba(109,106,254,0.07), rgba(43,212,125,0.04) 60%, transparent), " +
              "linear-gradient(180deg, var(--surface), #14171f)",
          }}
        >
          <div style={{ display: "flex", minWidth: "max-content" }}>
            {MAG7.map((f) => (
              <TickerCell
                key={f.ticker}
                ticker={f.ticker}
                name={f.name}
                data={prices[f.ticker] ?? null}
              />
            ))}
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Equity feeds publish during US market hours (9:30 AM–4:00 PM ET,
          weekdays). Off-hours show the last regular-session value.
        </p>
      </section>

      {/* ── How it works ─────────────────────────────────────── */}
      <section style={{ marginBottom: 56 }}>
        <h2 style={{ fontSize: 24, margin: "0 0 6px" }}>How it works</h2>
        <p className="muted" style={{ fontSize: 14, margin: "0 0 24px" }}>
          Three steps, fully on-chain, settled the same day.
        </p>
        <div
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          }}
        >
          <Step
            n={1}
            glyph={
              <div style={{ display: "flex", gap: 3 }}>
                <span style={{ width: 12, height: 18, borderRadius: 3, background: "var(--yes)" }} />
                <span style={{ width: 12, height: 18, borderRadius: 3, background: "var(--no)" }} />
              </div>
            }
            title="Mint a $1 pair"
            body={
              <>
                Deposit <span className="mono">$1 USDC</span> and mint one{" "}
                <strong style={{ color: "var(--yes)" }}>Yes</strong> and one{" "}
                <strong style={{ color: "var(--no)" }}>No</strong> token. Together
                they&apos;re always worth $1 — keep both, or sell the side you
                don&apos;t want.
              </>
            }
          />
          <Step
            n={2}
            glyph={
              <div style={{ display: "grid", gap: 3, width: 18 }}>
                <span style={{ height: 4, width: "100%", borderRadius: 2, background: "var(--accent-2)" }} />
                <span style={{ height: 4, width: "65%", borderRadius: 2, background: "var(--accent-2)", opacity: 0.6 }} />
                <span style={{ height: 4, width: "85%", borderRadius: 2, background: "var(--accent-2)", opacity: 0.8 }} />
              </div>
            }
            title="Trade on the order book"
            body={
              <>
                Buy or sell <strong style={{ color: "var(--yes)" }}>Yes</strong> /{" "}
                <strong style={{ color: "var(--no)" }}>No</strong> on a fully
                on-chain limit order book. A Yes price of{" "}
                <span className="mono">$0.62</span> is the market&apos;s 62%
                implied probability.
              </>
            }
          />
          <Step
            n={3}
            glyph={
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 999,
                  border: "2px solid var(--accent-2)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--yes)" }} />
              </div>
            }
            title="Settle & redeem"
            body={
              <>
                At <strong style={{ color: "var(--text)" }}>4:00 PM ET</strong> a
                Pyth oracle settles the market. The winning token redeems for{" "}
                <span className="mono" style={{ color: "var(--yes)" }}>$1</span>;
                the losing side expires at <span className="mono">$0</span>.
              </>
            }
          />
        </div>
      </section>

      {/* ── Closing CTA ──────────────────────────────────────── */}
      <section
        className="panel"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          alignItems: "center",
          justifyContent: "space-between",
          padding: "28px 32px",
          background:
            "radial-gradient(600px 300px at 90% 0%, rgba(109,106,254,0.18), transparent 60%), " +
            "linear-gradient(180deg, var(--surface), #11141d)",
        }}
      >
        <div style={{ display: "grid", gap: 6 }}>
          <h2 style={{ fontSize: 22, margin: 0 }}>Ready to take a side?</h2>
          <p className="dim" style={{ fontSize: 14, margin: 0, maxWidth: 460 }}>
            Connect a non-custodial wallet and trade today&apos;s MAG7 markets.
            Your keys, your funds, your position.
          </p>
        </div>
        {walletPubkey ? (
          <Link
            href="/markets"
            className="btn"
            style={{ textDecoration: "none", fontSize: 15, padding: "12px 22px" }}
          >
            Explore markets →
          </Link>
        ) : (
          <WalletButton />
        )}
      </section>
    </main>
  );
}
