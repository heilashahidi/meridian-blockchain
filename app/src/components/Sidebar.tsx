"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { useMeridian } from "@/hooks/MeridianContext";

const REPO = "https://github.com/heilashahidi/meridian-blockchain";

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
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  support: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7" />
      <line x1="12" y1="17" x2="12" y2="17" />
    </>
  ),
  feedback: (
    <>
      <path d="M21 11.5a8.38 8.38 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 20l1.3-3.8A8.38 8.38 0 0 1 12 3.1a8.5 8.5 0 0 1 9 8.4z" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21a7 7 0 0 1 14 0" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
};

const LINKS: NavLink[] = [
  // The dashboard is the browse-and-pick surface; clicking a strike opens the
  // trade screen at /trade/[market]. No separate Markets/Trade nav items.
  { href: "/", label: "Dashboard", icon: I.dashboard, match: (p) => p === "/" || p.startsWith("/trade") },
  { href: "/portfolio", label: "Portfolio", icon: I.portfolio, match: (p) => p.startsWith("/portfolio") },
  { href: "/history", label: "History", icon: I.history, match: (p) => p.startsWith("/history") },
];

function Icon({ children }: { children: ReactNode }) {
  return (
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
      {children}
    </svg>
  );
}

const fmtUsd = (micro: bigint) =>
  (Number(micro) / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Buying-power card at the foot of the rail: live wallet USDC + deposit + addr. */
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
      <div className="buying-head">
        <span className="buying-icon" aria-hidden>
          <Icon>{I.wallet}</Icon>
        </span>
        <span className="buying-label">Buying power</span>
        <span className="badge-devnet">Devnet</span>
      </div>
      <div className="mono buying-amount">
        {walletPubkey ? `$${usdc !== null ? fmtUsd(usdc) : "—"}` : "$0.00"}
      </div>
      <div className="muted buying-sub">USDC · non-custodial</div>
      <Link href="/" className="btn buying-deposit">
        + Deposit USDC
      </Link>
      {walletPubkey && (
        <div className="buying-addr mono" title={walletPubkey.toBase58()}>
          <span className="addr-dot" aria-hidden />
          {shortAddr(walletPubkey.toBase58())}
        </div>
      )}
    </div>
  );
}

/**
 * Persistent left rail — the dashboard app-shell from the Meridian design.
 * Logo, primary nav (General), secondary links (Other / Preferences), and the
 * live buying-power card pinned to the bottom.
 */
export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const { disconnect, connected } = useWallet();

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

      <div className="sidebar-scroll">
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
                <Icon>{l.icon}</Icon>
                {l.label}
                {active && <span className="sidebar-active-dot" aria-hidden />}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-section-label">Other</div>
        <nav className="sidebar-nav">
          <a className="sidebar-link" href={REPO} target="_blank" rel="noreferrer">
            <Icon>{I.support}</Icon>
            Support
          </a>
          <a className="sidebar-link" href={`${REPO}/issues`} target="_blank" rel="noreferrer">
            <Icon>{I.feedback}</Icon>
            Feedback
          </a>
        </nav>

        <div className="sidebar-section-label">Preferences</div>
        <nav className="sidebar-nav">
          <Link href="/portfolio" className="sidebar-link">
            <Icon>{I.account}</Icon>
            Account
          </Link>
          <button
            type="button"
            className="sidebar-link sidebar-link-btn"
            onClick={() => connected && disconnect().catch(() => {})}
            disabled={!connected}
          >
            <Icon>{I.logout}</Icon>
            Log out
          </button>
        </nav>
      </div>

      <div className="sidebar-foot">
        <BuyingPower />
      </div>
    </aside>
  );
}
