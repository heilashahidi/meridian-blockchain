"use client";

import { useConnection } from "@solana/wallet-adapter-react";

import { cancelOrder } from "@/lib/actions";
import { useMeridian } from "@/lib/MeridianContext";
import type { BookLevel } from "@/lib/market";
import { SIDE_ASK, SIDE_BID } from "@/lib/matching";
import { useTx } from "@/lib/useTx";

interface MyOrder extends BookLevel {
  side: number;
}

export function OpenOrders() {
  const { connection } = useConnection();
  const { program, market, config, book, walletPubkey } = useMeridian();
  const { busy, error, run } = useTx();

  if (!walletPubkey || !book) return null;

  const mine: MyOrder[] = [
    ...book.bids
      .filter((l) => l.owner.equals(walletPubkey))
      .map((l) => ({ ...l, side: SIDE_BID })),
    ...book.asks
      .filter((l) => l.owner.equals(walletPubkey))
      .map((l) => ({ ...l, side: SIDE_ASK })),
  ];

  if (mine.length === 0) return null;

  async function cancel(o: MyOrder) {
    await run(async () => {
      await cancelOrder({
        program,
        market: market!,
        usdcMint: config!.usdcMint,
        user: walletPubkey!,
        side: o.side,
        price: o.price,
        seq: o.seq,
      });
      return `Cancelled ${o.side === SIDE_BID ? "bid" : "ask"} ${o.qty} @ ${o.price}`;
    });
  }

  return (
    <div className="panel">
      <div className="muted" style={{ marginBottom: 10 }}>
        Your open orders ({mine.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {mine.map((o) => (
          <div
            key={`${o.side}-${o.seq}`}
            className="mono"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 13,
            }}
          >
            <span style={{ color: o.side === SIDE_BID ? "var(--bid)" : "var(--ask)" }}>
              {o.side === SIDE_BID ? "BID" : "ASK"} {o.qty.toString()} @{" "}
              {o.price.toString()} · #{o.seq.toString()}
            </span>
            <button
              className="btn"
              style={{ padding: "4px 10px", background: "var(--border)" }}
              disabled={busy}
              onClick={() => cancel(o)}
            >
              Cancel
            </button>
          </div>
        ))}
      </div>
      {error && <div style={{ color: "var(--ask)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
