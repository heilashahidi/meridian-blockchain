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
import { useMeridian } from "@/lib/MeridianContext";

const SOLSCAN_BASE = "https://solscan.io/tx";

function fmtTime(blockTime: number | null): string {
  if (!blockTime) return "—";
  return new Date(blockTime * 1000).toLocaleString();
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
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>History</h1>
        <p className="muted" style={{ margin: 0, maxWidth: 680 }}>
          Your recent Meridian transactions — mints, trades, cancels, and
          redeems — classified from on-chain instruction data.
        </p>
      </header>

      {!walletPubkey ? (
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
                      href={`${SOLSCAN_BASE}/${e.signature}`}
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
