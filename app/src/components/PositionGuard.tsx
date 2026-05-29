"use client";

import type { Balances } from "@/lib/market";
import { positionGuardDecision } from "@/lib/tradePaths";

/**
 * Position-constraint banner (PRD §142–144). Surfaces the wallet's current
 * Yes/No holdings and the guard's reasoning so the user understands why a Buy
 * path may be disabled. The actual enable/disable gating lives in `TradePanel`
 * (both read the same pure `positionGuardDecision`). Renders nothing when the
 * wallet holds no position (nothing to constrain).
 */
export function PositionGuard({ balances }: { balances: Balances | null }) {
  if (!balances) return null;
  const hasYes = balances.yes > 0n;
  const hasNo = balances.no > 0n;
  if (!hasYes && !hasNo) return null;

  const decision = positionGuardDecision(balances);
  // The blocking reason (Buy Yes blocked by No, or Buy No blocked by Yes).
  const reason = !decision.buyYes.allowed
    ? decision.buyYes.reason
    : !decision.buyNo.allowed
      ? decision.buyNo.reason
      : null;

  return (
    <div
      className="panel"
      style={{ borderColor: "var(--ask)", display: "grid", gap: 6 }}
    >
      <div className="muted" style={{ fontSize: 12 }}>
        Your position
      </div>
      <div className="mono" style={{ fontSize: 14, display: "flex", gap: 16 }}>
        <span style={{ color: "var(--bid)" }}>
          Yes {balances.yes.toString()}
        </span>
        <span style={{ color: "var(--ask)" }}>No {balances.no.toString()}</span>
      </div>
      {reason && (
        <div style={{ fontSize: 13 }}>
          {reason}{" "}
          <span className="muted">
            (no position holds both Yes and No from trading)
          </span>
        </div>
      )}
    </div>
  );
}
