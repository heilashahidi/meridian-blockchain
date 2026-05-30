"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { useMeridian } from "@/hooks/MeridianContext";

interface NavLink {
  href: string;
  label: string;
  icon: ReactNode;
  match: (path: string) => boolean;
}

// Minimal inline icons (stroke = currentColor) so the rail needs no icon dep.
const I = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  markets: (
    <>
      <path d="M3 17l5-5 4 3 6-7" />
      <path d="M16 8h5v5" />
    </>
  ),
  trade: (
    <>
      <path d="M7 7h13" />
      <path d="M17 4l3 3-3 3" />
      <path d="M17 17H4" />
      <path d="M7 14l-3 3 3 3" />
    </>
  ),
  portfolio: (
    <>
      <path d="M21 12a9 9 0 1 1-9-9v9z" />
      <path d="M12 3a9 9 0 0 1 9 9h-9z" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </>
  ),
};

const LINKS: NavLink[] = [
  { href: "/", label: "Dashboard", icon: I.dashboard, match: (p) => p === "/" },
  { href: "/markets", label: "Markets", icon: I.markets, match: (p) => p.startsWith("/markets") },
  { href: "/trade", label: "Trade", icon: I.trade, match: (p) => p.startsWith("/trade") },
  { href: "/portfolio", label: "Portfolio", icon: I.portfolio, match: (p) => p.startsWith("/portfolio") },
  { href: "/history", label: "History", icon: I.history, match: (p) => p.startsWith("/history") },
];

const fmtUsd = (micro: bigint) =>
  (Number(micro) / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Buying-power card at the foot of the rail: live wallet USDC + address. */
function BuyingPower() {
  const { connection } = useConnection();
  const { walletPubkey, config } = useMeridian();
  const [usdc, setUsdc] = useState<bigint | null>(null);

  useEffect(() => {
    if (!walletPubkey || !config) {
      setUsdc(null);
      return;
    }
    let cancelled = false;
    const ata = getAssociatedTokenAddressSync(config.usdcMint, walletPubkey);
    const load = async () => {
      try {
        const acc = await getAccount(connection, ata);
        if (!cancelled) setUsdc(acc.amount);
      } catch {
        if (!cancelled) setUsdc(0n);
      }
    };
    load();
    const id = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection, walletPubkey, config]);

  return (
    <div className="sidebar-buying">
      <div className="stat-label">Buying power · Devnet</div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 800, marginTop: 2 }}>
        {walletPubkey ? `$${usdc !== null ? fmtUsd(usdc) : "—"}` : "—"}
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
        USDC · non-custodial
      </div>
      {walletPubkey && (
        <div
          className="mono"
          style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}
          title={walletPubkey.toBase58()}
        >
          {shortAddr(walletPubkey.toBase58())}
        </div>
      )}
    </div>
  );
}

/**
 * Persistent left rail — the dashboard app-shell from the Meridian design.
 * Logo, primary nav, and the live buying-power card pinned to the bottom.
 */
export function Sidebar() {
  const pathname = usePathname() ?? "/";

  return (
    <aside className="sidebar">
      <Link href="/" className="sidebar-brand">
        <span className="sidebar-mark" aria-hidden>
          <svg viewBox="0 0 100 100" width="22" height="22">
            <circle cx="50" cy="50" r="34" fill="none" stroke="currentColor" strokeWidth="6" />
            <line x1="50" y1="16" x2="50" y2="84" stroke="currentColor" strokeWidth="6" />
            <ellipse cx="50" cy="50" rx="14" ry="34" fill="none" stroke="currentColor" strokeWidth="6" />
          </svg>
        </span>
        Meridian
      </Link>

      <div className="sidebar-section-label">General</div>
      <nav className="sidebar-nav">
        {LINKS.map((l) => {
          const active = l.match(pathname);
          return (
            <Link
              key={l.href}
              href={l.href}
              className="sidebar-link"
              data-active={active ? "true" : undefined}
              aria-current={active ? "page" : undefined}
            >
              <svg
                viewBox="0 0 24 24"
                width="17"
                height="17"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                {l.icon}
              </svg>
              {l.label}
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <BuyingPower />
      </div>
    </aside>
  );
}
