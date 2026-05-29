"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { WalletButton } from "@/components/WalletButton";
import { shortKey } from "@/lib/format";
import {
  ACTION_LABEL,
  fetchHistory,
  type HistoryEntry,
} from "@/lib/history";
import { useMeridian } from "@/lib/MeridianContext";

const SOLSCAN_BASE = "https://solscan.io/tx";

function fmtTime(blockTime: number | null): string {
  if (!blockTime) return "—";
  return new Date(blockTime * 1000).toLocaleString();
}

export default function HistoryPage() {
  const { walletPubkey } = useMeridian();
  const { connection } = useConnection();

  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!walletPubkey) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      setEntries(await fetchHistory(connection, walletPubkey));
    } finally {
      setLoading(false);
    }
  }, [connection, walletPubkey]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px" }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>History</h1>
        <p className="muted" style={{ margin: 0, maxWidth: 680 }}>
          Your recent Meridian transactions — mints, trades, cancels, and
          redeems — classified from on-chain instruction data.
        </p>
      </header>

      {!walletPubkey ? (
        <div className="panel" style={{ padding: 24, textAlign: "center" }}>
          <p className="muted" style={{ marginBottom: 16 }}>
            Connect your wallet to see your transaction history.
          </p>
          <WalletButton />
        </div>
      ) : entries.length === 0 ? (
        <p className="muted">
          {loading ? "Loading history…" : "No Meridian transactions yet."}
        </p>
      ) : (
        <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <Th>Action</Th>
                <Th>Instruction</Th>
                <Th>Time</Th>
                <Th>Status</Th>
                <Th right>Tx</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.signature}
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <td style={{ padding: "10px 8px", fontWeight: 600 }}>
                    {ACTION_LABEL[e.action]}
                  </td>
                  <td
                    className="mono muted"
                    style={{ padding: "10px 8px", fontSize: 12 }}
                  >
                    {e.instruction}
                  </td>
                  <td
                    className="muted"
                    style={{ padding: "10px 8px", fontSize: 12 }}
                  >
                    {fmtTime(e.blockTime)}
                  </td>
                  <td style={{ padding: "10px 8px", fontSize: 12 }}>
                    {e.failed ? (
                      <span style={{ color: "var(--ask)" }}>failed</span>
                    ) : (
                      <span style={{ color: "var(--bid)" }}>ok</span>
                    )}
                  </td>
                  <td
                    className="mono"
                    style={{ padding: "10px 8px", textAlign: "right", fontSize: 12 }}
                  >
                    <a
                      href={`${SOLSCAN_BASE}/${e.signature}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--text)" }}
                    >
                      {shortKey(e.signature)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
