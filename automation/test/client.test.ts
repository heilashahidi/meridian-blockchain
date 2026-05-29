import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  bookPda,
  buildClient,
  buildReadOnlyClient,
  configPda,
  marketPda,
  PROGRAM_ID,
} from "../src/client.js";

// Offline: building the program must succeed despite the stubbed
// matching-engine types — i.e. the in-memory IDL patch worked (a bare
// new Program(idl) would throw "Type not found: bids").
describe("client: offline program construction", () => {
  it("builds a program whose programId matches the IDL", () => {
    // A dummy connection is fine — construction does no network IO.
    const conn = { rpcEndpoint: "http://127.0.0.1:8899" } as never;
    const { program } = buildClient(conn, Keypair.generate());
    expect(program.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
    expect(program.programId.toBase58()).toBe(
      "6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX",
    );
  });

  it("constructs a read-only program (IDL patch lets Book decode)", () => {
    const conn = { rpcEndpoint: "http://127.0.0.1:8899" } as never;
    const program = buildReadOnlyClient(conn);
    // The patched IDL must expose the config + book account decoders.
    expect(program.account.config).toBeDefined();
    expect(program.account.book).toBeDefined();
  });
});

describe("client: PDA derivation", () => {
  it("derives a deterministic config PDA", () => {
    expect(configPda().toBase58()).toBe(configPda().toBase58());
  });

  it("derives distinct market PDAs per (ticker, strike, expiry)", () => {
    const a = marketPda("AAPL", 200_000_000n, 1_900_000_000n);
    const b = marketPda("AAPL", 205_000_000n, 1_900_000_000n);
    expect(a.toBase58()).not.toBe(b.toBase58());
    // Stable across calls.
    expect(marketPda("AAPL", 200_000_000n, 1_900_000_000n).toBase58()).toBe(
      a.toBase58(),
    );
    // Book PDA derives from the market.
    expect(bookPda(a).toBase58()).not.toBe(bookPda(b).toBase58());
  });
});
