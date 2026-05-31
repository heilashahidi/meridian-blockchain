"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { WalletButton } from "@/components/WalletButton";
import { shortKey } from "@/lib/format";
import {
  ACTION_LABEL,
  fetchHistory,
  type HistoryAction,
  type HistoryEntry,
} from "@/lib/history";
import { useMeridian } from "@/hooks/MeridianContext";
import { DEMO_WALLET } from "@/lib/demoWallet";

function fmtTime(blockTime: number | null): string {
  if (!blockTime) return "—";
  return new Date(blockTime * 1000).toLocaleString();
}

/**
 * Cluster-aware Solana Explorer link for a transaction. Solscan (the old link)
 * is mainnet-only — its links 404 on devnet and can't see a local validator at
 * all. Solana Explorer supports devnet, testnet, and a custom RPC (resolved
 * client-side in the browser, so a localhost validator works). We derive the
 * cluster from the connection's actual RPC endpoint.
 */
function explorerTxUrl(signature: string, rpcEndpoint: string): string {
  const ep = rpcEndpoint.toLowerCase();
  const base = `https://explorer.solana.com/tx/${signature}`;
  if (ep.includes("devnet")) return `${base}?cluster=devnet`;
  if (ep.includes("testnet")) return `${base}?cluster=testnet`;
  if (ep.includes("127.0.0.1") || ep.includes("localhost"))
    return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcEndpoint)}`;
  return base; // mainnet-beta (default)
}

/** Accent color per action so the log is scannable at a glance. */
const ACTION_COLOR: Record<HistoryAction, string> = {
  mint: "var(--accent)",
  burn: "var(--muted)",
  trade: "var(--yes)",
  cancel: "var(--no)",
  redeem: "var(--yes)",
  settle: "var(--warn)",
  create: "var(--accent)",
  admin: "var(--muted)",
  unknown: "var(--muted)",
};

function ActionBadge({ action }: { action: HistoryAction }) {
  const color = ACTION_COLOR[action];
  return (
    <span
      className="pill"
      style={{
        color,
        borderColor: color,
        background: "transparent",
      }}
    >
      {ACTION_LABEL[action]}
    </span>
  );
}

export default function HistoryPage() {
  const { walletPubkey } = useMeridian();
  const { connection } = useConnection();

  // No wallet connected → preview the demo wallet's on-chain history (read-only)
  // so the page matches the dashboard instead of dead-ending on a connect prompt.
  const eff = walletPubkey ?? DEMO_WALLET;
  const preview = !walletPubkey && !!DEMO_WALLET;

  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!eff) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      setEntries(await fetchHistory(connection, eff));
    } finally {
      setLoading(false);
    }
  }, [connection, eff]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px" }}>
      <header style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 8px" }}>
          <h1 style={{ fontSize: 28, margin: 0 }}>History</h1>
          {preview && <span className="badge-devnet">Demo</span>}
        </div>
        <p className="muted" style={{ margin: 0, maxWidth: 680 }}>
          {preview
            ? "Previewing a demo wallet's recent Meridian transactions. Connect your wallet to see your own."
            : "Your recent Meridian transactions — mints, trades, cancels, and redeems — classified from on-chain instruction data."}
        </p>
      </header>

      {!eff ? (
        <ConnectPrompt />
      ) : entries.length === 0 ? (
        loading ? (
          <p className="muted">Loading history…</p>
        ) : (
          <EmptyHistory />
        )
      ) : (
        <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
          <table
            className="mono"
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
          >
            <thead>
              <tr style={{ textAlign: "left" }}>
                <Th>Action</Th>
                <Th>Instruction</Th>
                <Th>Time</Th>
                <Th>Status</Th>
                <Th right>Signature</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.signature}
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <td style={{ padding: "12px 12px" }}>
                    <ActionBadge action={e.action} />
                  </td>
                  <td
                    className="muted"
                    style={{ padding: "12px 12px", fontSize: 12 }}
                  >
                    {e.instruction}
                  </td>
                  <td
                    className="dim"
                    style={{ padding: "12px 12px", fontSize: 12 }}
                  >
                    {fmtTime(e.blockTime)}
                  </td>
                  <td style={{ padding: "12px 12px", fontSize: 12 }}>
                    {e.failed ? (
                      <span style={{ color: "var(--no)", fontWeight: 600 }}>
                        Failed
                      </span>
                    ) : (
                      <span style={{ color: "var(--yes)", fontWeight: 600 }}>
                        OK
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: "12px 12px",
                      textAlign: "right",
                      fontSize: 12,
                    }}
                  >
                    <a
                      href={explorerTxUrl(e.signature, connection.rpcEndpoint)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--accent)" }}
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

function EmptyHistory() {
  return (
    <div
      className="panel"
      style={{ padding: 40, textAlign: "center", display: "grid", gap: 12 }}
    >
      <div style={{ fontSize: 18, fontWeight: 600 }}>No activity yet</div>
      <p className="muted" style={{ margin: "0 auto", maxWidth: 420 }}>
        Your mints, trades, cancels, and redeems will show up here as soon as
        you make your first move.
      </p>
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
        Connect your wallet to see your transaction history
      </div>
      <p className="muted" style={{ margin: "0 auto", maxWidth: 420 }}>
        Every Meridian transaction this wallet makes will appear here.
      </p>
      <div style={{ display: "flex", justifyContent: "center", marginTop: 4 }}>
        <WalletButton />
      </div>
    </div>
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
