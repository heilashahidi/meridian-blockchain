import { Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { buildReadOnlyClient, configPda } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { reachable } from "../src/liveTestEnv.js";

// Guarded integration test — fetch the on-chain Config from a running cluster.
// Auto-skips when the RPC is unreachable (offline / CI), mirroring
// app/src/lib/*.live.test.ts. Run against a bootstrapped local validator or a
// deployed devnet by setting RPC_URL.
const cfg = loadConfig();
const isUp = await reachable(cfg.rpcUrl);
const maybe = isUp ? it : it.skip;

describe("client: fetch Config (live cluster)", () => {
  maybe("reads the Config singleton (skips if not yet bootstrapped)", async () => {
    const connection = new Connection(cfg.rpcUrl, "confirmed");
    const program = buildReadOnlyClient(connection);

    // The cluster may be reachable but not yet bootstrapped (Config absent) —
    // e.g. a fresh devnet before U1's deploy. Treat that as a skip, not a
    // failure: this test verifies the read path decodes a real Config, which
    // only exists once bootstrapped.
    const info = await connection.getAccountInfo(configPda());
    if (info === null) {
      // eslint-disable-next-line no-console
      console.warn(
        `[client.live] Config not found on ${cfg.rpcUrl} — cluster reachable but not bootstrapped; skipping.`,
      );
      return;
    }

    const config = await program.account.config.fetch(configPda());
    expect(config.usdcMint).toBeDefined();
    expect(typeof config.paused).toBe("boolean");
  });
});
