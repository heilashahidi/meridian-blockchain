"use client";

import dynamic from "next/dynamic";

// The wallet-adapter button touches `window` on mount, so load it client-only
// to avoid hydration mismatch.
const WalletMultiButtonDynamic = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);

export function WalletButton() {
  return <WalletMultiButtonDynamic />;
}
