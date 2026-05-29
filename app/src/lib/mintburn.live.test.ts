import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Wallet } from "@coral-xyz/anchor";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Connection, Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { burnPair, mintPair } from "./actions";
import { fetchBalances, fetchConfig, listMarkets } from "./market";
import { configPda } from "./pdas";
import { getProgram, RPC_URL } from "./program";

// Drives mint_pair + burn_pair through the same `actions.ts` the UI uses,
// against a running local validator with a funded keypair. Skips when the
// validator is down or no keypair is present, so it's safe in CI / offline.
function loadLocalKeypair(): Keypair | null {
  try {
    const path = join(homedir(), ".config/solana/id.json");
    const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
    return Keypair.fromSecretKey(secret);
  } catch {
    return null;
  }
}

async function reachable(): Promise<boolean> {
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

const kp = loadLocalKeypair();
const isUp = (await reachable()) && kp !== null;
const maybe = isUp ? it : it.skip;

describe("mint/burn pair (live validator)", () => {
  maybe(
    "mint then burn preserves the $1 invariant on real balances",
    async () => {
      const connection = new Connection(RPC_URL, "confirmed");
      const wallet = new Wallet(kp!);
      const program = getProgram(connection, wallet);
      const user = kp!.publicKey;

      const cfg = await fetchConfig(program, configPda());
      const markets = await listMarkets(program);
      const market = markets.find((m) => !m.settled);
      if (!market) return; // nothing to trade on

      // Ensure a USDC ATA and fund it (the local keypair is the mint authority
      // for the bootstrapped USDC mint).
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        kp!,
        cfg.usdcMint,
        user,
      );
      await mintTo(connection, kp!, cfg.usdcMint, ata.address, kp!, 5000n);

      const N = 1000n;
      const pre = await fetchBalances(connection, user, cfg.usdcMint, market);

      await mintPair({
        program,
        connection,
        market,
        usdcMint: cfg.usdcMint,
        user,
        amount: N,
      });

      const minted = await fetchBalances(connection, user, cfg.usdcMint, market);
      expect(minted.yes).toBe(pre.yes + N);
      expect(minted.no).toBe(pre.no + N);
      expect(minted.usdc).toBe(pre.usdc - N);

      await burnPair({
        program,
        connection,
        market,
        usdcMint: cfg.usdcMint,
        user,
        amount: N,
      });

      const burned = await fetchBalances(connection, user, cfg.usdcMint, market);
      expect(burned.yes).toBe(pre.yes);
      expect(burned.no).toBe(pre.no);
      expect(burned.usdc).toBe(pre.usdc);
    },
    30_000,
  );
});
