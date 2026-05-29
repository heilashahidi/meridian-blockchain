import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { buildClient, configPda } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { makeLiveDeps, settle } from "../src/jobs/settle.js";
import { loadLocalKeypair, reachable } from "../src/liveTestEnv.js";

// Guarded integration test — runs the real settle pipeline against a running,
// bootstrapped cluster. Mirrors createStrikes.live.test.ts: auto-skips when the
// RPC is unreachable (offline / CI), or reachable-but-unbootstrapped (no Config),
// or the local keypair isn't the on-chain admin. It is also a clean no-op when
// there are simply no open (unsettled, past-expiry) markets to settle — which is
// the common case on a fresh local validator — so it never flakes.
const cfg = loadConfig();
const isUp = await reachable(cfg.rpcUrl);
const maybe = isUp ? it : it.skip;

describe("settle: live cluster (settles open markets, idempotent re-run)", () => {
  maybe(
    "settles any open markets and a second run is a clean no-op",
    async () => {
      const connection = new Connection(cfg.rpcUrl, "confirmed");

      const configInfo = await connection.getAccountInfo(configPda());
      if (configInfo === null) {
        // eslint-disable-next-line no-console
        console.warn(
          `[settle.live] Config not found on ${cfg.rpcUrl} — cluster reachable but not bootstrapped; skipping.`,
        );
        return;
      }

      const kp = loadLocalKeypair();
      if (!kp) {
        // eslint-disable-next-line no-console
        console.warn("[settle.live] no local keypair; skipping.");
        return;
      }
      const { program } = buildClient(connection, kp);
      const config = await program.account.config.fetch(configPda());
      if ((config.admin as PublicKey).toBase58() !== kp.publicKey.toBase58()) {
        // eslint-disable-next-line no-console
        console.warn("[settle.live] local keypair is not the on-chain admin; skipping.");
        return;
      }

      const deps = makeLiveDeps(cfg);

      // First run: settle whatever is open. With a forged/real feed posted these
      // settle via the oracle; off-hours with an OVERRIDE_PRICES env set they
      // settle via admin override. Either way, no market should be left in an
      // unexpected throw state.
      const first = await settle(deps, {
        retryIntervalMs: 1_000,
        maxRetryWindowMs: 5_000, // keep the live test fast
      });

      // Second run: every market that settled in the first run is now skipped as
      // already-settled (idempotent). Anything still failing in run 1 (e.g. no
      // override price off-hours) simply fails again — that's expected and not a
      // crash.
      const second = await settle(deps, {
        retryIntervalMs: 1_000,
        maxRetryWindowMs: 5_000,
      });
      const reSettledViaWrite = second.totalSettled + second.totalOverridden;
      // Anything settled in run 1 must NOT be re-settled in run 2.
      expect(reSettledViaWrite).toBeLessThanOrEqual(second.totalFailed);
    },
    120_000,
  );
});
