"use client";

import { useMeridian } from "@/lib/MeridianContext";
import { toUsdc } from "@/lib/format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 18 }}>
        {value}
      </div>
    </div>
  );
}

export function Balances() {
  const { walletPubkey, balances, selected } = useMeridian();

  if (!walletPubkey) {
    return (
      <div className="panel">
        <div className="muted">Connect a wallet to see your balances.</div>
      </div>
    );
  }
  if (!selected) {
    return (
      <div className="panel">
        <div className="muted">Select a market to see your positions.</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="muted" style={{ marginBottom: 10 }}>
        Your balances
      </div>
      <div style={{ display: "flex", gap: 28 }}>
        <Stat label="USDC" value={balances ? toUsdc(balances.usdc) : "…"} />
        <Stat label="Yes" value={balances ? balances.yes.toString() : "…"} />
        <Stat label="No" value={balances ? balances.no.toString() : "…"} />
      </div>
    </div>
  );
}
