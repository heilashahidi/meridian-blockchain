"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { WalletButton } from "@/components/WalletButton";
import { PositionRow } from "@/components/PositionRow";
import { redeem } from "@/lib/actions";
import { fetchBalances, fetchBook, type BookView } from "@/lib/market";
import { useMeridian } from "@/hooks/MeridianContext";
import { noFromYes, yesMidFraction } from "@/lib/marketsView";
import {
  MINT_PAIR_LEG_BASIS,
  computePnl,
  contractsFromBaseUnits,
  currentContractPrice,
  fmtDollars,
  fmtSignedDollars,
  visiblePositions,
  type Holding,
  type PositionSide,
} from "@/lib/pnl";
import { useTx } from "@/hooks/useTx";

const POLL_MS = 8000;

/** A holding plus the data the row needs to value it. */
interface EnrichedHolding {
  holding: Holding;
  livePrice: number | null;
  entryPrice: number;
  entryIsEstimate: boolean;
}

/**
 * Per-side current price ($0–$1 fraction) from the book mid: Yes uses the mid
 * directly, No uses 1 − mid. Null when there's no derivable mid.
 */
function sidePriceFromBook(book: BookView | null, side: PositionSide): number | null {
  const yes = yesMidFraction(book);
  if (yes === null) return null;
  return side === "yes" ? yes : noFromYes(yes);
}

export default function PortfolioPage() {
  const { program, walletPubkey, config, markets } = useMeridian();
  const { connection } = useConnection();
  const tx = useTx();

  const [enriched, setEnriched] = useState<EnrichedHolding[]>([]);
  const [loading, setLoading] = useState(false);
  const [redeemingKey, setRedeemingKey] = useState<string | null>(null);

  // Stable signature of the market set so the effect only re-runs when it changes.
  const marketKeys = useMemo(
    () => markets.map((m) => m.pubkey.toBase58()).join(","),
    [markets],
  );

  // Monotonic sequence so an overlapping/stale poll can't overwrite the state a
  // fresher poll already wrote. Each load() captures its number; only the most
  // recently *started* load is allowed to commit. The effect's `cancelled` flag
  // additionally drops any response that lands after unmount.
  const seqRef = useRef(0);

  // `isCurrent()` is supplied by the caller (the effect or onRedeem): it returns
  // false once this load has been superseded or its owner cleaned up, so we
  // guard every state write with it.
  const load = useCallback(
    async (isCurrent: () => boolean) => {
      if (!walletPubkey || !config) {
        if (isCurrent()) {
          setEnriched([]);
          setLoading(false);
        }
        return;
      }
      if (isCurrent()) setLoading(true);
      try {
        // Enumerate Yes/No balances + book for every market in parallel.
        const perMarket = await Promise.all(
          markets.map(async (m) => {
            const [balances, book] = await Promise.all([
              fetchBalances(connection, walletPubkey, config.usdcMint, m),
              fetchBook(program, m.pubkey).catch(() => null),
            ]);
            return { m, balances, book };
          }),
        );

        const rows: EnrichedHolding[] = [];
        for (const { m, balances, book } of perMarket) {
          const sides: { side: PositionSide; amount: bigint }[] = [
            { side: "yes", amount: balances.yes },
            { side: "no", amount: balances.no },
          ];
          for (const { side, amount } of visiblePositions(
            sides.map((s) => ({ market: m, side: s.side, amount: s.amount })),
          )) {
            const livePrice = sidePriceFromBook(book, side);
            // Entry-basis approximation (documented in lib/pnl.ts): we lack a
            // per-fill ledger, so use the current book mid as the cost estimate;
            // when no mid exists fall back to the exact mint-pair leg basis of
            // $0.50. The "est." flag in the row marks the mid-based estimate.
            const entryIsEstimate = livePrice !== null;
            const entryPrice = livePrice ?? MINT_PAIR_LEG_BASIS;
            rows.push({
              holding: { market: m, side, amount },
              livePrice,
              entryPrice,
              entryIsEstimate,
            });
          }
        }
        // Drop a stale or post-unmount response rather than clobbering fresher
        // state.
        if (isCurrent()) setEnriched(rows);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [program, connection, walletPubkey, config, markets],
  );

  useEffect(() => {
    let cancelled = false;
    // A poll is "current" only if its sequence is still the latest started and
    // the effect hasn't been torn down.
    const start = () => {
      const mySeq = ++seqRef.current;
      void load(() => !cancelled && seqRef.current === mySeq);
    };
    start();
    const id = setInterval(start, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletPubkey, config, marketKeys]);

  // Track unmount for the onRedeem refresh path (which lives outside the polling
  // effect). Set false on cleanup so a refresh that resolves after unmount is
  // dropped.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const onRedeem = useCallback(
    async (h: Holding) => {
      if (!walletPubkey || !config) return;
      const key = `${h.market.pubkey.toBase58()}:${h.side}`;
      setRedeemingKey(key);
      await tx.run(() =>
        redeem({
          program,
          connection,
          market: h.market,
          usdcMint: config.usdcMint,
          user: walletPubkey,
          amount: h.amount,
        }),
      );
      if (mountedRef.current) setRedeemingKey(null);
      // Refresh as a fresh sequence; guard against unmount + supersession so a
      // concurrent poll's response can't be clobbered by this stale refresh.
      const mySeq = ++seqRef.current;
      await load(() => mountedRef.current && seqRef.current === mySeq);
    },
    [program, connection, walletPubkey, config, tx, load],
  );

  // Portfolio-level summary, derived from the same pure P&L helpers the rows
  // use. Only positions with a derivable current price contribute (value/P&L
  // null → skipped), so the totals never fabricate a number.
  const summary = useMemo(() => {
    let value = 0;
    let pnl = 0;
    for (const e of enriched) {
      const qty = contractsFromBaseUnits(e.holding.amount);
      const current = currentContractPrice(
        e.holding.side,
        e.holding.market,
        e.livePrice,
      );
      if (current === null) continue;
      const r = computePnl(qty, e.entryPrice, current);
      value += r.currentValue;
      pnl += r.pnl;
    }
    return { value, pnl };
  }, [enriched]);

  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>Portfolio</h1>
        <p className="muted" style={{ margin: 0, maxWidth: 680 }}>
          Your Yes/No positions across all markets. Value is marked to the book
          mid (settled markets to $1.00 / $0.00); entry basis is estimated from
          the live mid where no per-fill ledger exists.
        </p>
      </header>

      {!walletPubkey ? (
        <ConnectPrompt />
      ) : enriched.length === 0 ? (
        loading ? (
          <p className="muted">Loading positions…</p>
        ) : (
          <EmptyPositions />
        )
      ) : (
        <>
          {/* Top summary: portfolio value + total P&L */}
          <div
            className="panel"
            style={{
              display: "flex",
              gap: 32,
              flexWrap: "wrap",
              marginBottom: 16,
            }}
          >
            <div className="stat">
              <span className="stat-label">Portfolio value</span>
              <span className="stat-value mono">
                {fmtDollars(summary.value)}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Total P&amp;L</span>
              <span
                className="stat-value mono"
                style={{
                  color: summary.pnl >= 0 ? "var(--yes)" : "var(--no)",
                }}
              >
                {fmtSignedDollars(summary.pnl)}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Positions</span>
              <span className="stat-value mono">{enriched.length}</span>
            </div>
          </div>

          {/* Position cards */}
          <div style={{ display: "grid", gap: 12 }}>
            {enriched.map((e) => {
              const key = `${e.holding.market.pubkey.toBase58()}:${e.holding.side}`;
              return (
                <PositionRow
                  key={key}
                  holding={e.holding}
                  livePrice={e.livePrice}
                  entryPrice={e.entryPrice}
                  entryIsEstimate={e.entryIsEstimate}
                  onRedeem={onRedeem}
                  redeeming={redeemingKey === key}
                />
              );
            })}
          </div>
        </>
      )}

      {tx.error && (
        <p style={{ color: "var(--no)", fontSize: 13, marginTop: 16 }}>
          {tx.error}
        </p>
      )}
      {tx.status && (
        <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
          {tx.status}
        </p>
      )}
    </main>
  );
}

function EmptyPositions() {
  return (
    <div
      className="panel"
      style={{ padding: 40, textAlign: "center", display: "grid", gap: 12 }}
    >
      <div style={{ fontSize: 18, fontWeight: 600 }}>No open positions</div>
      <p
        className="muted"
        style={{ margin: "0 auto", maxWidth: 420, lineHeight: 1.5 }}
      >
        You&rsquo;re flat. Pick a market and take a Yes or No position to start
        building your portfolio.
      </p>
      <div style={{ marginTop: 8 }}>
        <Link href="/" className="btn" style={{ display: "inline-block" }}>
          Browse markets
        </Link>
      </div>
    </div>
  );
}

function ConnectPrompt() {
  return (
    <div
      className="panel"
      style={{ padding: 40, textAlign: "center", display: "grid", gap: 14 }}
    >
      <div style={{ fontSize: 18, fontWeight: 600 }}>
        Connect your wallet to see your positions
      </div>
      <p className="muted" style={{ margin: "0 auto", maxWidth: 420 }}>
        Your Yes/No holdings and live P&amp;L will appear here once a wallet is
        connected.
      </p>
      <div style={{ display: "flex", justifyContent: "center", marginTop: 4 }}>
        <WalletButton />
      </div>
    </div>
  );
}
