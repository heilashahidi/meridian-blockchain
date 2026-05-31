import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { buildClient, configPda } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import {
  createStrikes,
  makeLiveDeps,
} from "../src/jobs/createStrikes.js";
import { loadLocalKeypair, reachable } from "../src/liveTestEnv.js";

// Guarded integration test — runs the real create-strikes pipeline against a
// running, bootstrapped cluster, then re-runs it to prove idempotency. Mirrors
// client.live.test.ts: auto-skips when the RPC is unreachable (offline / CI) or
// when the cluster is reachable but not yet bootstrapped (no Config) / the local
// keypair isn't the on-chain admin.
const cfg = loadConfig();
const isUp = await reachable(cfg.rpcUrl);
const maybe = isUp ? it : it.skip;

describe("createStrikes: live cluster (creates then no-ops)", () => {
  maybe(
    "creates the day's markets and a second run is a no-op",
    async () => {
      const connection = new Connection(cfg.rpcUrl, "confirmed");

      // Bootstrapped? (Config must exist for create_strike_market to authorize.)
      const configInfo = await connection.getAccountInfo(configPda());
      if (configInfo === null) {
        // eslint-disable-next-line no-console
        console.warn(
          `[createStrikes.live] Config not found on ${cfg.rpcUrl} — cluster reachable but not bootstrapped; skipping.`,
        );
        return;
      }

      // The local keypair must be the on-chain admin or every create fails.
      const kp = loadLocalKeypair();
      if (!kp) {
        // eslint-disable-next-line no-console
        console.warn("[createStrikes.live] no local keypair; skipping.");
        return;
      }
      const { program } = buildClient(connection, kp);
      const config = await program.account.config.fetch(configPda());
      if ((config.admin as PublicKey).toBase58() !== kp.publicKey.toBase58()) {
        // eslint-disable-next-line no-console
        console.warn(
          "[createStrikes.live] local keypair is not the on-chain admin; skipping.",
        );
        return;
      }

      // Use a small, fast subset for the live run.
      const liveCfg = { ...cfg, tickers: ["AAPL"] as const, strikePercents: [3] };
      const deps = makeLiveDeps(liveCfg);

      const first = await createStrikes(liveCfg, deps, {
        maxAttempts: 3,
        baseBackoffMs: 1000,
      });
      // Either it created some (fresh expiry) or they already existed (re-run
      // within the same hour bucket). Crucially: no failures.
      expect(first.totalFailed).toBe(0);

      // Second run with the SAME expiry horizon → everything should be skipped.
      const second = await createStrikes(liveCfg, deps, {
        maxAttempts: 3,
        baseBackoffMs: 1000,
      });
      expect(second.totalFailed).toBe(0);
      expect(second.totalCreated).toBe(0);
      expect(second.totalSkipped).toBe(first.totalCreated + first.totalSkipped);
    },
    120_000,
  );
});
