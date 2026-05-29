import { Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { reachable } from "./liveTestEnv";
import { fetchBalances, fetchBook, fetchConfig, listMarkets } from "./market";
import { configPda } from "./pdas";
import { getReadOnlyProgram, RPC_URL } from "./program";

// Integration check against a running local validator. Skips automatically when
// the validator is unreachable so it never fails in CI / offline runs. When the
// validator is up (and bootstrapped), it exercises the codified read layer
// end-to-end — the U2 "scratch call logs the bootstrapped market and book"
// verification, made repeatable.
const isUp = await reachable();
const maybe = isUp ? it : it.skip;

describe("read layer (live validator)", () => {
  maybe("reads Config, markets, and a decoded book", async () => {
    const connection = new Connection(RPC_URL, "confirmed");
    const program = getReadOnlyProgram(connection);

    const cfg = await fetchConfig(program, configPda());
    expect(cfg.usdcMint).toBeDefined();
    expect(typeof cfg.paused).toBe("boolean");

    const markets = await listMarkets(program);
    expect(Array.isArray(markets)).toBe(true);

    if (markets.length > 0) {
      const m = markets[0];
      const book = await fetchBook(program, m.pubkey);
      expect(Array.isArray(book.bids)).toBe(true);
      expect(Array.isArray(book.asks)).toBe(true);
      expect(book.nextSeq).toBeTypeOf("bigint");
      // book levels never exceed the per-side depth of 32
      expect(book.bids.length).toBeLessThanOrEqual(32);
      expect(book.asks.length).toBeLessThanOrEqual(32);

      // balances for the program's own admin (an arbitrary real key) must not
      // throw even when ATAs don't exist
      const bal = await fetchBalances(connection, cfg.admin, cfg.usdcMint, m);
      expect(bal.usdc).toBeTypeOf("bigint");
      expect(bal.yes).toBeTypeOf("bigint");
      expect(bal.no).toBeTypeOf("bigint");
    }
  });
});
