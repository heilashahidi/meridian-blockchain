"use client";

import { useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { burnPair, mintPair } from "@/lib/actions";
import { useMeridian } from "@/lib/MeridianContext";
import { useTx } from "@/lib/useTx";

export function MintBurnPanel() {
  const { connection } = useConnection();
  const { program, market, config, walletPubkey } = useMeridian();
  const { busy, error, status, run } = useTx();
  const [amount, setAmount] = useState("1000");

  const ready = !!market && !!config && !!walletPubkey;
  const amt = Number(amount);
  const validAmt = Number.isInteger(amt) && amt > 0;

  async function submit(kind: "mint" | "burn") {
    if (!ready) return;
    await run(async () => {
      const common = {
        program,
        connection,
        market: market!,
        usdcMint: config!.usdcMint,
        user: walletPubkey!,
        amount: amt,
      };
      if (kind === "mint") {
        await mintPair(common);
        return `Minted ${amt} Yes + ${amt} No for ${amt} USDC`;
      }
      await burnPair(common);
      return `Burned ${amt} Yes + ${amt} No → ${amt} USDC`;
    });
  }

  return (
    <div className="panel">
      <div className="muted" style={{ marginBottom: 10 }}>
        Mint / burn pair{" "}
        <span style={{ fontSize: 12 }}>(1 USDC ⇄ 1 Yes + 1 No)</span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="number"
          min={1}
          step={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={{ width: 120 }}
          aria-label="amount in base units"
        />
        <button
          className="btn"
          disabled={!ready || !validAmt || busy}
          onClick={() => submit("mint")}
        >
          Mint pair
        </button>
        <button
          className="btn"
          style={{ background: "var(--ask)" }}
          disabled={!ready || !validAmt || busy}
          onClick={() => submit("burn")}
        >
          Burn pair
        </button>
      </div>
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
