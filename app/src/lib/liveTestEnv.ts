import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Connection, Keypair } from "@solana/web3.js";

import { RPC_URL } from "./program";

// Shared guards for the `*.live.test.ts` integration tests: load the local
// validator keypair and check the validator is reachable. Used to skip the
// integration tests cleanly when run offline or in CI.

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

export async function reachable(): Promise<boolean> {
  try {
    return Boolean(
      await Promise.race([
        new Connection(RPC_URL, "confirmed").getVersion(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("t")), 1500)),
      ]),
    );
  } catch {
    return false;
  }
}
