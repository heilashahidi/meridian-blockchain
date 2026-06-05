// @vitest-environment jsdom
//
// Wallet-connection-flow render test (PRD §342 — "Wallet connection flow" is a
// required frontend test; the audit found ZERO component/render tests). This is
// the first render test in the suite. It uses @testing-library/react (installed
// as a devDependency) and runs under jsdom (set per-file above; the global
// vitest env is `node` for the pure/live tests).
//
// We mock the data/wallet hooks so the panel renders without a real Solana
// connection or wallet adapter, and assert the wallet GATE:
//   - no wallet connected → "Connect a wallet to trade" prompt shows and the
//     submit button is disabled (trading gated);
//   - wallet connected (+ market/config/book loaded) → submit button enabled.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

import { TradePanel } from "@/components/TradePanel";

// A throwaway pubkey for the mock market/owner accounts.
const KEY = PublicKey.default;

// Minimal MarketView the panel reads (ticker, strikePrice, mints, pubkey).
const MARKET = {
  pubkey: KEY,
  ticker: [66, 84, 67], // "BTC"
  strikePrice: 50_000_000_000n,
  expiryUnix: 9_999_999_999n,
  settled: false,
  outcome: null,
  yesMint: KEY,
  noMint: KEY,
};

const CONFIG = { admin: KEY, usdcMint: KEY, paused: false };
const BOOK = { bids: [], asks: [], nextSeq: 0n };
const BALANCES = { usdc: 0n, yes: 0n, no: 0n };

// Mutable holder so each test can flip the connected wallet before rendering.
const meridian: { walletPubkey: PublicKey | null } & Record<string, unknown> = {
  program: {},
  market: MARKET,
  config: CONFIG,
  book: BOOK,
  balances: BALANCES,
  walletPubkey: null,
};

vi.mock("@/hooks/MeridianContext", () => ({
  useMeridian: () => meridian,
}));

vi.mock("@/hooks/useTx", () => ({
  useTx: () => ({ busy: false, error: null, status: null, run: vi.fn() }),
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: {} }),
}));

// The submit button is the primary CTA (class btn-yes for the default Buy Yes).
function submitButton(): HTMLButtonElement {
  // The last .btn (yes/no) is the submit CTA; the segmented action buttons use
  // .seg, so query by the action label rendered on the CTA ("Buy Yes").
  const buttons = screen.getAllByRole("button", { name: "Buy Yes" });
  // Two match: the segmented selector (.seg) and the submit CTA (.btn). The CTA
  // is the one carrying the btn class.
  const cta = buttons.find((b) => b.className.includes("btn-"));
  if (!cta) throw new Error("submit CTA not found");
  return cta as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  meridian.walletPubkey = null;
});

describe("TradePanel wallet connection flow", () => {
  it("gates trading when no wallet is connected", () => {
    meridian.walletPubkey = null;
    render(<TradePanel />);

    // Connect prompt is shown.
    expect(screen.getByText("Connect a wallet to trade.")).toBeTruthy();
    // Submit CTA is disabled (ready === false without a wallet).
    expect(submitButton().disabled).toBe(true);
  });

  it("enables trade controls once a wallet is connected", () => {
    meridian.walletPubkey = KEY;
    render(<TradePanel />);

    // No connect prompt when a wallet is present.
    expect(screen.queryByText("Connect a wallet to trade.")).toBeNull();
    // With market/config/book/wallet all present and valid default inputs
    // (price 0.50, qty 100), the submit CTA is enabled.
    expect(submitButton().disabled).toBe(false);
  });
});
