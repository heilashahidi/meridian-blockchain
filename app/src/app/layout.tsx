import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";

import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Providers } from "./providers";
import "./globals.css";

// Space Grotesk drives the UI chrome (techy, geometric); Inter stays as the
// body/long-text fallback; JetBrains Mono renders all numbers.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
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
    <html lang="en" className={`${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable}`}>
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
