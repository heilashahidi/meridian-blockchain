import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { winningMint, type MarketView, type Outcome } from "./market";

const yes = Keypair.generate().publicKey;
const no = Keypair.generate().publicKey;

function market(settled: boolean, outcome: Outcome): MarketView {
  return {
    pubkey: Keypair.generate().publicKey,
    ticker: [68, 69, 77, 79, 0, 0, 0, 0],
    strikePrice: 680_000_000n,
    expiryUnix: 1_900_000_000n,
    settled,
    settledAt: settled ? 1_900_000_100n : 0n,
    outcome,
    yesMint: yes,
    noMint: no,
  };
}

describe("winningMint", () => {
  it("is null on an unsettled market", () => {
    expect(winningMint(market(false, null))).toBeNull();
  });
  it("is null when settled flag set but outcome missing", () => {
    expect(winningMint(market(true, null))).toBeNull();
  });
  it("is the Yes mint when Yes wins", () => {
    expect(winningMint(market(true, "yesWins"))!.equals(yes)).toBe(true);
  });
  it("is the No mint when No wins", () => {
    expect(winningMint(market(true, "noWins"))!.equals(no)).toBe(true);
  });
});
