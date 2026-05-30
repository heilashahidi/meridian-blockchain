"use client";

import { WalletButton } from "@/components/WalletButton";

/**
 * Top bar of the app-shell (sits above page content inside the main column).
 * Left: product/settlement status. Right: wallet connect. The per-market
 * settlement countdown lives on the Trade screen; this is the global status
 * strip from the Meridian dashboard design.
 */
export function TopBar() {
  return (
    <header className="topbar">
      <div className="topbar-status">
        <span className="topbar-dot" aria-hidden />
        <span className="topbar-status-text">
          Devnet · 0DTE binary options · settle at the 4:00 PM ET close
        </span>
      </div>
      <div className="topbar-right">
        <WalletButton />
      </div>
    </header>
  );
}
