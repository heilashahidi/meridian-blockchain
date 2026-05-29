// liveTestEnv.ts — shared guards for the guarded integration tests, mirroring
// app/src/lib/liveTestEnv.ts. Lets `*.live.test.ts` auto-skip cleanly when no
// cluster is reachable (offline / CI).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Connection, Keypair } from "@solana/web3.js";

export function loadLocalKeypair(): Keypair | null {
  try {
    const path = join(homedir(), ".config/solana/id.json");
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
    );
  } catch {
    return null;
  }
}

/** True if the RPC at `rpcUrl` answers getVersion within 1.5s. */
export async function reachable(rpcUrl: string): Promise<boolean> {
  try {
    return Boolean(
      await Promise.race([
        new Connection(rpcUrl, "confirmed").getVersion(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("t")), 1500)),
      ]),
    );
  } catch {
    return false;
  }
}
