"use client";

import { useMeridian } from "@/lib/MeridianContext";
import { PROGRAM_ID, RPC_URL } from "@/lib/program";
import { WalletButton } from "@/components/WalletButton";
import { MarketPicker } from "@/components/MarketPicker";
import { OrderBook } from "@/components/OrderBook";
import { Balances } from "@/components/Balances";
import { MintBurnPanel } from "@/components/MintBurnPanel";

export default function Home() {
  const { config, configError } = useMeridian();

  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "24px 16px" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Meridian</h1>
          <div className="muted mono" style={{ fontSize: 12 }}>
            {RPC_URL} · {PROGRAM_ID.toBase58().slice(0, 8)}…
            {config ? ` · USDC ${config.usdcMint.toBase58().slice(0, 8)}…` : ""}
            {config?.paused ? " · ⏸ PAUSED" : ""}
          </div>
        </div>
        <WalletButton />
      </header>

      {configError && (
        <div
          className="panel"
          style={{ borderColor: "var(--ask)", marginBottom: 16 }}
        >
          <div style={{ color: "var(--ask)" }}>{configError}</div>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "320px 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <MarketPicker />
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Balances />
          <MintBurnPanel />
          <OrderBook />
        </div>
      </div>
    </main>
  );
}
