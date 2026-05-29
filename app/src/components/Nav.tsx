"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { WalletButton } from "@/components/WalletButton";

interface NavLink {
  href: string;
  label: string;
  /** Match prefix so e.g. /trade/<market> highlights "Trade". */
  match: (path: string) => boolean;
}

const LINKS: NavLink[] = [
  { href: "/", label: "Home", match: (p) => p === "/" },
  { href: "/markets", label: "Markets", match: (p) => p.startsWith("/markets") },
  { href: "/trade", label: "Trade", match: (p) => p.startsWith("/trade") },
  {
    href: "/portfolio",
    label: "Portfolio",
    match: (p) => p.startsWith("/portfolio"),
  },
  { href: "/history", label: "History", match: (p) => p.startsWith("/history") },
];

export function Nav() {
  const pathname = usePathname() ?? "/";

  return (
    <nav
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "12px 16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--panel)",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      <Link
        href="/"
        style={{ fontWeight: 700, color: "var(--text)", textDecoration: "none" }}
      >
        Meridian
      </Link>
      <div style={{ display: "flex", gap: 4, flex: 1 }}>
        {LINKS.filter((l) => l.href !== "/").map((l) => {
          const active = l.match(pathname);
          return (
            <Link
              key={l.href}
              href={l.href}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                textDecoration: "none",
                color: active ? "var(--text)" : "var(--muted)",
                background: active ? "var(--bg)" : "transparent",
                fontWeight: active ? 600 : 400,
              }}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
      <WalletButton />
    </nav>
  );
}
