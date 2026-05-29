"use client";

import { useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { placeLimitOrder } from "@/lib/actions";
import { useMeridian } from "@/lib/MeridianContext";
import { planFills, SIDE_ASK, SIDE_BID } from "@/lib/matching";
import { useTx } from "@/lib/useTx";

export function PlaceOrderPanel() {
  const { connection } = useConnection();
  const { program, market, config, book, walletPubkey } = useMeridian();
  const { busy, error, status, run } = useTx();
  const [side, setSide] = useState<number>(SIDE_BID);
  const [price, setPrice] = useState("40");
  const [qty, setQty] = useState("100");

  const ready = !!market && !!config && !!book && !!walletPubkey;
  const priceN = Number(price);
  const qtyN = Number(qty);
  const valid =
    Number.isInteger(priceN) &&
    priceN > 0 &&
    Number.isInteger(qtyN) &&
    qtyN > 0;

  // Preview how this order would match the current book.
  const preview =
    ready && valid
      ? planFills(
          side === SIDE_BID ? book!.asks : book!.bids,
          side,
          BigInt(priceN),
          BigInt(qtyN),
        )
      : null;
  const fillQty = preview
    ? preview.fills.reduce((a, f) => a + f.qty, 0n)
    : 0n;

  async function submit() {
    if (!ready) return;
    await run(async () => {
      await placeLimitOrder({
        program,
        connection,
        market: market!,
        usdcMint: config!.usdcMint,
        user: walletPubkey!,
        side,
        price: priceN,
        qty: qtyN,
        book: book!,
      });
      const verb = side === SIDE_BID ? "Bid" : "Ask";
      return `${verb} ${qtyN} @ ${priceN} placed`;
    });
  }

  return (
    <div className="panel">
      <div className="muted" style={{ marginBottom: 10 }}>
        Place limit order
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={side}
          onChange={(e) => setSide(Number(e.target.value))}
          aria-label="side"
        >
          <option value={SIDE_BID}>Bid (buy Yes)</option>
          <option value={SIDE_ASK}>Ask (sell Yes)</option>
        </select>
        <label className="muted" style={{ fontSize: 12 }}>
          price
          <input
            type="number"
            min={1}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            style={{ width: 90, marginLeft: 6 }}
            aria-label="price"
          />
        </label>
        <label className="muted" style={{ fontSize: 12 }}>
          qty
          <input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            style={{ width: 90, marginLeft: 6 }}
            aria-label="qty"
          />
        </label>
        <button
          className="btn"
          disabled={!ready || !valid || busy}
          onClick={submit}
        >
          Place
        </button>
      </div>

      {preview && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {preview.fills.length === 0
            ? "rests on the book (no cross)"
            : `crosses ${preview.fills.length} order(s), fills ${fillQty.toString()}` +
              (preview.residual > 0n
                ? `, ${preview.residual.toString()} rests`
                : "")}
        </div>
      )}
      {!walletPubkey && (
        <div className="muted" style={{ marginTop: 8 }}>
          Connect a wallet to trade.
        </div>
      )}
      {status && (
        <div style={{ color: "var(--bid)", marginTop: 8 }}>{status}</div>
      )}
      {error && <div style={{ color: "var(--ask)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
