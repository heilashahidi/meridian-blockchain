"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { WalletButton } from "@/components/WalletButton";
import { PositionRow } from "@/components/PositionRow";
import { redeem } from "@/lib/actions";
import { fetchBalances, fetchBook, type BookView } from "@/lib/market";
import { useMeridian } from "@/lib/MeridianContext";
import { noFromYes, yesMidFraction } from "@/lib/marketsView";
import {
  MINT_PAIR_LEG_BASIS,
  visiblePositions,
  type Holding,
  type PositionSide,
} from "@/lib/pnl";
import { useTx } from "@/lib/useTx";

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

  const load = useCallback(async () => {
    if (!walletPubkey || !config) {
      setEnriched([]);
      return;
    }
    setLoading(true);
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
      setEnriched(rows);
    } finally {
      setLoading(false);
    }
  }, [program, connection, walletPubkey, config, markets]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletPubkey, config, marketKeys]);

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
      setRedeemingKey(null);
      await load();
    },
    [program, connection, walletPubkey, config, tx, load],
  );

  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px" }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>Portfolio</h1>
        <p className="muted" style={{ margin: 0, maxWidth: 680 }}>
          Your Yes/No positions across all markets. Current value is marked to
          the book mid (settled markets to $1.00 / $0.00); entry basis is
          estimated from the live mid where no per-fill ledger exists.
        </p>
      </header>

      {!walletPubkey ? (
        <ConnectPrompt />
      ) : enriched.length === 0 ? (
        <p className="muted">
          {loading
            ? "Loading positions…"
            : "No open positions. Mint or trade on a market to see it here."}
        </p>
      ) : (
        <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <Th>Position</Th>
                <Th right>Qty</Th>
                <Th right>Entry</Th>
                <Th right>Value</Th>
                <Th right>P&amp;L</Th>
                <Th right></Th>
              </tr>
            </thead>
            <tbody>
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
            </tbody>
          </table>
        </div>
      )}

      {tx.error && (
        <p style={{ color: "var(--ask)", fontSize: 13, marginTop: 12 }}>
          {tx.error}
        </p>
      )}
      {tx.status && (
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          {tx.status}
        </p>
      )}
    </main>
  );
}

function Th({
  children,
  right,
}: {
  children?: React.ReactNode;
  right?: boolean;
}) {
  return (
    <th
      className="muted"
      style={{
        padding: "10px 8px",
        fontSize: 12,
        fontWeight: 600,
        textAlign: right ? "right" : "left",
      }}
    >
      {children}
    </th>
  );
}

function ConnectPrompt() {
  return (
    <div className="panel" style={{ padding: 24, textAlign: "center" }}>
      <p className="muted" style={{ marginBottom: 16 }}>
        Connect your wallet to see your positions and P&amp;L.
      </p>
      <WalletButton />
    </div>
  );
}
