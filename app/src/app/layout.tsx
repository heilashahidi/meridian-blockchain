import type { Metadata } from "next";

import { Nav } from "@/components/Nav";
import { Providers } from "./providers";
import "./globals.css";

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
    <html lang="en">
      <body>
        <Providers>
          <Nav />
          {children}
        </Providers>
      </body>
    </html>
  );
}
