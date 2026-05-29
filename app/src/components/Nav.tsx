"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { WalletButton } from "@/components/WalletButton";
import { useMeridian } from "@/hooks/MeridianContext";

interface NavLink {
  href: string;
  label: string;
  match: (path: string) => boolean;
}

const LINKS: NavLink[] = [
  { href: "/", label: "Home", match: (p) => p === "/" },
  { href: "/markets", label: "Markets", match: (p) => p.startsWith("/markets") },
  { href: "/trade", label: "Trade", match: (p) => p.startsWith("/trade") },
  { href: "/portfolio", label: "Portfolio", match: (p) => p.startsWith("/portfolio") },
  { href: "/history", label: "History", match: (p) => p.startsWith("/history") },
];

const fmtUsd = (micro: bigint) =>
  (Number(micro) / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** Live wallet USDC, fetched independently of the selected market so it shows
 *  on every page. Polls every 8s; tolerates a not-yet-created ATA as $0. */
function UsdcChip() {
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
        if (!cancelled) setUsdc(0n); // ATA not created yet
      }
    };
    load();
    const id = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection, walletPubkey, config]);

  if (usdc === null) return null;
  return (
    <div className="pill mono" title="Wallet USDC balance" style={{ gap: 6 }}>
      <span style={{ color: "var(--muted)", fontFamily: "var(--font-sans)" }}>
        Balance
      </span>
      <span style={{ color: "var(--text)" }}>${fmtUsd(usdc)}</span>
    </div>
  );
}

export function Nav() {
  const pathname = usePathname() ?? "/";

  return (
    <nav
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "12px 20px",
        borderBottom: "1px solid var(--border)",
        background: "rgba(12,15,22,0.72)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      <Link
        href="/"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          fontWeight: 800,
          fontSize: 16,
          letterSpacing: "-0.02em",
          color: "var(--text)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
            boxShadow: "0 0 16px rgba(109,106,254,0.5)",
          }}
        />
        Meridian
      </Link>

      <div style={{ display: "flex", gap: 2, flex: 1 }}>
        {LINKS.filter((l) => l.href !== "/").map((l) => {
          const active = l.match(pathname);
          return (
            <Link
              key={l.href}
              href={l.href}
              style={{
                padding: "7px 13px",
                borderRadius: 9,
                color: active ? "var(--text)" : "var(--muted)",
                background: active ? "var(--surface-2)" : "transparent",
                fontWeight: active ? 600 : 500,
                transition: "color 0.14s ease, background 0.14s ease",
              }}
            >
              {l.label}
            </Link>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <UsdcChip />
        <WalletButton />
      </div>
    </nav>
  );
}
