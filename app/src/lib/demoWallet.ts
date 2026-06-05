import { PublicKey } from "@solana/web3.js";

// Read-only demo-wallet preview is DISABLED. The app requires a connected wallet
// to view positions/history and to trade — no fake demo state, no seeded preview
// account. Kept as `null` (ignoring NEXT_PUBLIC_DEMO_WALLET) so every
// `eff = walletPubkey ?? DEMO_WALLET` collapses to "connect your wallet", and the
// "Demo" badges / preview copy never render.
export const DEMO_WALLET: PublicKey | null = null;
