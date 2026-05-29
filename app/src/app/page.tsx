"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";

import { getReadOnlyProgram, PROGRAM_ID, RPC_URL } from "@/lib/program";

// U1 smoke screen: prove the app boots, the wallet connects, and the Anchor
// client can read the on-chain Config from the configured cluster. U3 replaces
// the body with the market picker + order book + balances.
export default function Home() {
  const { connection } = useConnection();
  const [config, setConfig] = useState<string>("loading…");

  useEffect(() => {
    (async () => {
      try {
        const program = getReadOnlyProgram(connection);
        const [configPda] = PublicKey.findProgramAddressSync(
          [new TextEncoder().encode("config")],
          PROGRAM_ID,
        );
        const cfg = await program.account.config.fetch(configPda);
        setConfig(
          JSON.stringify(
            {
              admin: cfg.admin.toBase58(),
              usdcMint: cfg.usdcMint.toBase58(),
              treasury: cfg.treasury.toBase58(),
              paused: cfg.paused,
            },
            null,
            2,
          ),
        );
      } catch (e) {
        setConfig(
          `Config not found on this cluster.\nBootstrap it first.\n\n${String(e)}`,
        );
      }
    })();
  }, [connection]);

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "24px 16px" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Meridian</h1>
          <div className="muted mono" style={{ fontSize: 12 }}>
            {RPC_URL} · {PROGRAM_ID.toBase58()}
          </div>
        </div>
        <WalletMultiButton />
      </header>

      <section className="panel">
        <div className="muted" style={{ marginBottom: 8 }}>
          Config (read-only smoke test — U1)
        </div>
        <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
          {config}
        </pre>
      </section>
    </main>
  );
}
