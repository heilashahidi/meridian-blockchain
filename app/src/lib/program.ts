import { AnchorProvider, Program } from "@coral-xyz/anchor";
import type { Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import { meridianIdl } from "./idlPatch";
import type { Meridian } from "./idl/meridian";

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ??
    "6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX",
);

export type MeridianProgram = Program<Meridian>;

/**
 * The browser wallet shape Anchor's provider actually uses at runtime. The
 * `Wallet` type Anchor exports is `NodeWallet` (requires a keypair `payer`),
 * which a wallet-adapter `AnchorWallet` doesn't have — but the provider only
 * touches `publicKey` + the sign methods, so this structural type is enough.
 */
export interface BrowserWallet {
  publicKey: PublicKey;
  signTransaction: <T extends Transaction | VersionedTransaction>(
    tx: T,
  ) => Promise<T>;
  signAllTransactions: <T extends Transaction | VersionedTransaction>(
    txs: T[],
  ) => Promise<T[]>;
}

/**
 * Build a typed Anchor `Program` bound to a wallet. Anchor 0.30+ reads the
 * program ID from `idl.address`, so we don't pass it separately — but we keep
 * `PROGRAM_ID` exported for PDA derivation and account filters.
 */
export function getProgram(
  connection: Connection,
  wallet: BrowserWallet,
): MeridianProgram {
  const provider = new AnchorProvider(connection, wallet as unknown as Wallet, {
    commitment: "confirmed",
  });
  return new Program(meridianIdl, provider);
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
  return new Program(meridianIdl, provider);
}

export const isLocalRpc = /127\.0\.0\.1|localhost/.test(RPC_URL);
