"use client";

import { useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { redeem } from "@/lib/actions";
import { useMeridian } from "@/lib/MeridianContext";
import { useTx } from "@/lib/useTx";

export function RedeemPanel() {
  const { connection } = useConnection();
  const { program, market, config, walletPubkey } = useMeridian();
  const { busy, error, status, run } = useTx();
  const [amount, setAmount] = useState("1000");

  if (!market) return null;

  // Only meaningful on a settled market.
  if (!market.settled) {
    return (
      <div className="panel">
        <div className="muted">
          Redeem unlocks once the market settles. Settle via
          <span className="mono"> scripts/settle-redeem-demo.sh</span> or a
          settle script (needs a Pyth price update).
        </div>
      </div>
    );
  }

  const winner = market.outcome === "yesWins" ? "Yes" : "No";
  const ready = !!config && !!walletPubkey;
  const amt = Number(amount);
  const validAmt = Number.isInteger(amt) && amt > 0;

  async function submit() {
    if (!ready) return;
    await run(async () => {
      await redeem({
        program,
        connection,
        market: market!,
        usdcMint: config!.usdcMint,
        user: walletPubkey!,
        amount: amt,
      });
      return `Redeemed ${amt} ${winner} → ${amt} USDC`;
    });
  }

  return (
    <div className="panel">
      <div className="muted" style={{ marginBottom: 10 }}>
        Redeem · <strong style={{ color: "var(--bid)" }}>{winner} won</strong>{" "}
        <span style={{ fontSize: 12 }}>(burn winning token for 1 USDC each)</span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="number"
          min={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={{ width: 120 }}
          aria-label="redeem amount"
        />
        <button
          className="btn"
          disabled={!ready || !validAmt || busy}
          onClick={submit}
        >
          Redeem {winner}
        </button>
      </div>
      {!walletPubkey && (
        <div className="muted" style={{ marginTop: 8 }}>
          Connect a wallet to redeem.
        </div>
      )}
      {status && (
        <div style={{ color: "var(--bid)", marginTop: 8 }}>{status}</div>
      )}
      {error && <div style={{ color: "var(--ask)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
