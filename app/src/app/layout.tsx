import type { Metadata } from "next";
import { Inter, Space_Grotesk, Space_Mono } from "next/font/google";

import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Providers } from "./providers";
import "./globals.css";

// Space Grotesk drives the UI chrome (techy, geometric); Space Mono renders all
// numbers (terminal-style, pairs with Grotesk); Inter is the body fallback.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space",
  display: "swap",
});

const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Meridian — MAG7 binary options",
  description:
    "Non-custodial MAG7 binary-options trading on Solana — live prices, an " +
    "on-chain order book, and $1 settlement.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      // The boot script sets data-theme before hydration; without this React
      // warns the attribute wasn't in the server HTML.
      suppressHydrationWarning
      className={`${spaceGrotesk.variable} ${inter.variable} ${spaceMono.variable}`}
    >
      <head>
        {/* Apply the saved (or system) theme before first paint so there's no
            dark→light flash on reload. Runs before React hydrates; ThemeToggle
            reads back whatever this sets. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <Providers>
          <div className="app-shell">
            <Sidebar />
            <div className="app-main">
              <TopBar />
              {children}
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
