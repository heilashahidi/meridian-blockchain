import { AnchorProvider, Program } from "@coral-xyz/anchor";
import type { Wallet } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";

import idl from "./idl/meridian.json";
import type { Meridian } from "./idl/meridian";

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ??
    "6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX",
);

export type MeridianProgram = Program<Meridian>;

/**
 * Build a typed Anchor `Program` bound to a wallet. Anchor 0.30+ reads the
 * program ID from `idl.address`, so we don't pass it separately — but we keep
 * `PROGRAM_ID` exported for PDA derivation and account filters.
 */
export function getProgram(
  connection: Connection,
  wallet: Wallet,
): MeridianProgram {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program(idl as Meridian, provider);
}

/**
 * A read-only Program for fetching accounts without a connected wallet. Anchor
 * still wants a wallet shape on the provider; a dummy is fine for reads.
 */
export function getReadOnlyProgram(connection: Connection): MeridianProgram {
  const dummy = {
    publicKey: PublicKey.default,
    signTransaction: async (tx: never) => tx,
    signAllTransactions: async (txs: never) => txs,
  } as unknown as Wallet;
  const provider = new AnchorProvider(connection, dummy, {
    commitment: "confirmed",
  });
  return new Program(idl as Meridian, provider);
}

export const isLocalRpc = /127\.0\.0\.1|localhost/.test(RPC_URL);
