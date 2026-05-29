import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import type { BookLevel } from "./market";
import {
  makerPayoutAtas,
  MAX_FILLS_PER_TX,
  planFills,
  SIDE_ASK,
  SIDE_BID,
} from "./matching";

const USDC = Keypair.generate().publicKey;
const YES = Keypair.generate().publicKey;

function lvl(price: bigint, qty: bigint, owner: PublicKey, seq = 1n): BookLevel {
  return { price, qty, owner, seq };
}

describe("planFills", () => {
  it("returns no fills against empty liquidity (order rests fully)", () => {
    const plan = planFills([], SIDE_BID, 50n, 500n);
    expect(plan.fills).toHaveLength(0);
    expect(plan.residual).toBe(500n);
  });

  it("bid crossing a single ask fills at the maker price", () => {
    const maker = Keypair.generate().publicKey;
    // asks ascending; bid @ 50 crosses ask @ 40
    const plan = planFills([lvl(40n, 500n, maker)], SIDE_BID, 50n, 500n);
    expect(plan.fills).toEqual([{ owner: maker, qty: 500n, price: 40n }]);
    expect(plan.residual).toBe(0n);
  });

  it("does not cross when the bid is below the best ask", () => {
    const maker = Keypair.generate().publicKey;
    const plan = planFills([lvl(60n, 500n, maker)], SIDE_BID, 50n, 500n);
    expect(plan.fills).toHaveLength(0);
    expect(plan.residual).toBe(500n);
  });

  it("bid sweeps multiple asks in price order, residual rests", () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const asks = [lvl(40n, 300n, a), lvl(45n, 300n, b)];
    const plan = planFills(asks, SIDE_BID, 50n, 700n);
    expect(plan.fills).toEqual([
      { owner: a, qty: 300n, price: 40n },
      { owner: b, qty: 300n, price: 45n },
    ]);
    expect(plan.residual).toBe(100n); // 700 - 600 rests
  });

  it("stops at the first non-crossing level even if depth remains", () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const asks = [lvl(40n, 100n, a), lvl(55n, 999n, b)];
    const plan = planFills(asks, SIDE_BID, 50n, 700n);
    expect(plan.fills).toEqual([{ owner: a, qty: 100n, price: 40n }]);
    expect(plan.residual).toBe(600n);
  });

  it("caps fills at MAX_FILLS_PER_TX", () => {
    const asks = Array.from({ length: 6 }, (_, i) =>
      lvl(BigInt(40 + i), 10n, Keypair.generate().publicKey, BigInt(i + 1)),
    );
    const plan = planFills(asks, SIDE_BID, 100n, 1000n);
    expect(plan.fills).toHaveLength(MAX_FILLS_PER_TX);
    expect(plan.residual).toBe(1000n - 4n * 10n);
  });

  it("ask taker crosses bids (descending), maker price >= limit", () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    // bids descending; ask @ 40 crosses bids at 50 and 45, not 30
    const bids = [lvl(50n, 100n, a), lvl(45n, 100n, b), lvl(30n, 100n, a)];
    const plan = planFills(bids, SIDE_ASK, 40n, 250n);
    expect(plan.fills).toEqual([
      { owner: a, qty: 100n, price: 50n },
      { owner: b, qty: 100n, price: 45n },
    ]);
    expect(plan.residual).toBe(50n);
  });

  it("self-cross is planned like any other (owner == taker)", () => {
    const taker = Keypair.generate().publicKey;
    const plan = planFills([lvl(40n, 500n, taker)], SIDE_BID, 50n, 500n);
    expect(plan.fills).toEqual([{ owner: taker, qty: 500n, price: 40n }]);
  });
});

describe("makerPayoutAtas", () => {
  it("bid taker pays makers in USDC (canonical ATA)", () => {
    const maker = Keypair.generate().publicKey;
    const atas = makerPayoutAtas(
      [{ owner: maker, qty: 1n, price: 1n }],
      SIDE_BID,
      USDC,
      YES,
    );
    expect(atas[0].equals(getAssociatedTokenAddressSync(USDC, maker))).toBe(true);
  });

  it("ask taker pays makers in Yes (canonical ATA)", () => {
    const maker = Keypair.generate().publicKey;
    const atas = makerPayoutAtas(
      [{ owner: maker, qty: 1n, price: 1n }],
      SIDE_ASK,
      USDC,
      YES,
    );
    expect(atas[0].equals(getAssociatedTokenAddressSync(YES, maker))).toBe(true);
  });

  it("preserves fill order across multiple makers", () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const atas = makerPayoutAtas(
      [
        { owner: a, qty: 1n, price: 1n },
        { owner: b, qty: 1n, price: 1n },
      ],
      SIDE_BID,
      USDC,
      YES,
    );
    expect(atas[0].equals(getAssociatedTokenAddressSync(USDC, a))).toBe(true);
    expect(atas[1].equals(getAssociatedTokenAddressSync(USDC, b))).toBe(true);
  });
});
