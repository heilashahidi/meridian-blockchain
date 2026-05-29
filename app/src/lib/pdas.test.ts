import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  bookPda,
  configPda,
  marketPda,
  marketPdas,
  tickerBytes,
} from "./pdas";

describe("tickerBytes", () => {
  it("right-zero-pads to 8 bytes", () => {
    expect(Array.from(tickerBytes("META"))).toEqual([77, 69, 84, 65, 0, 0, 0, 0]);
  });
  it("truncates beyond 8 bytes", () => {
    expect(tickerBytes("LONGTICKER")).toHaveLength(8);
  });
});

describe("PDA derivation", () => {
  it("config PDA is a stable valid address", () => {
    const a = configPda();
    const b = configPda();
    expect(a.equals(b)).toBe(true);
    expect(PublicKey.isOnCurve(a.toBytes())).toBe(false); // PDAs are off-curve
  });

  it("market PDA is deterministic for fixed inputs", () => {
    const a = marketPda("DEMO", 680_000_000n, 1_900_000_000n);
    const b = marketPda("DEMO", 680_000_000n, 1_900_000_000n);
    expect(a.equals(b)).toBe(true);
  });

  it("market PDA differs by strike and expiry", () => {
    const base = marketPda("DEMO", 680_000_000n, 1_900_000_000n);
    expect(marketPda("DEMO", 690_000_000n, 1_900_000_000n).equals(base)).toBe(
      false,
    );
    expect(marketPda("DEMO", 680_000_000n, 1_900_000_001n).equals(base)).toBe(
      false,
    );
    expect(marketPda("META", 680_000_000n, 1_900_000_000n).equals(base)).toBe(
      false,
    );
  });

  it("per-market PDAs are all distinct", () => {
    const m = marketPda("DEMO", 680_000_000n, 1_900_000_000n);
    const p = marketPdas(m);
    const keys = [
      p.book,
      p.yesMint,
      p.noMint,
      p.mintAuthority,
      p.usdcEscrow,
      p.yesEscrow,
    ].map((k) => k.toBase58());
    expect(new Set(keys).size).toBe(keys.length);
    expect(bookPda(m).equals(p.book)).toBe(true);
  });
});
