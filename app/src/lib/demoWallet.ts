import { PublicKey } from "@solana/web3.js";

// Optional read-only preview wallet (a real on-chain account): when no wallet is
// connected, the dashboard/portfolio/history panels show THIS account's live
// data so a fresh/logged-out view isn't empty. Read-only (public key only, no
// signing), so anything that needs a signature — placing orders, redeeming —
// stays disabled in preview. Set NEXT_PUBLIC_DEMO_WALLET to enable.
export const DEMO_WALLET: PublicKey | null = (() => {
  const s = process.env.NEXT_PUBLIC_DEMO_WALLET;
  if (!s) return null;
  try {
    return new PublicKey(s);
  } catch {
    return null;
  }
})();
