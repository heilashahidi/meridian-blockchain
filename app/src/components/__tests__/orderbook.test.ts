import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { perspectiveLevels } from "../OrderBook";
import type { BookView } from "@/lib/market";

const ONE = 1_000_000n;
const lvl = (price: bigint, qty: bigint, seq: bigint) => ({
  price,
  qty,
  seq,
  owner: PublicKey.default,
});

// Deliberately ASYMMETRIC (different prices AND quantities per side) so a
// wrong-source-array bug can't hide behind bid/ask symmetry — the exact class
// of bug that shipped when the No-view ask column read book.asks instead of
// book.bids.map(reflect).
const book: BookView = {
  bids: [lvl(400_000n, 10n, 1n)], // Yes buyers @ $0.40 x10
  asks: [lvl(600_000n, 7n, 2n)], //  Yes sellers @ $0.60 x7
  nextSeq: 3n,
};

describe("OrderBook perspectiveLevels (PRD §308 — same book, two views)", () => {
  it("Yes view is the book exactly as stored", () => {
    const { bids, asks } = perspectiveLevels(book, "yes");
    expect(bids[0].price).toBe(400_000n);
    expect(bids[0].qty).toBe(10n);
    expect(asks[0].price).toBe(600_000n);
    expect(asks[0].qty).toBe(7n); // the ASK's qty (7), not the bid's 10
  });

  it("No view reflects price and flips bid<->ask", () => {
    const { bids, asks } = perspectiveLevels(book, "no");
    // No bids come from Yes asks, reflected: $1 - $0.60 = $0.40, qty 7.
    expect(bids[0].price).toBe(ONE - 600_000n);
    expect(bids[0].qty).toBe(7n);
    // No asks come from Yes bids, reflected: $1 - $0.40 = $0.60, qty 10.
    expect(asks[0].price).toBe(ONE - 400_000n);
    expect(asks[0].qty).toBe(10n);
  });

  it("No bid + No ask sum to ONE_USDC with their Yes counterparts (Yes+No=$1)", () => {
    const yes = perspectiveLevels(book, "yes");
    const no = perspectiveLevels(book, "no");
    // Yes best ask ($0.60) ⇔ No best bid ($0.40): 0.60 + 0.40 = $1.00.
    expect(yes.asks[0].price + no.bids[0].price).toBe(ONE);
    // Yes best bid ($0.40) ⇔ No best ask ($0.60).
    expect(yes.bids[0].price + no.asks[0].price).toBe(ONE);
  });
});
