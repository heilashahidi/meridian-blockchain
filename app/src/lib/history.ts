// Wallet transaction history for the History page (U9).
//
// The Meridian program emits almost no events (only `StuckOrderRecovered`), so
// "history" is reconstructed from the wallet's confirmed transactions: we fetch
// signatures for the wallet, load each parsed transaction, and classify every
// instruction that targets the Meridian program by its 8-byte Anchor
// discriminator (the first 8 bytes of the instruction data). The discriminator
// → action mapping is the pure, testable core (`parseInstruction` /
// `parseHistoryEntry`); the RPC plumbing (`fetchHistory`) wraps it.
//
// We classify, not decode-args: the PRD History page wants a human log of what
// the wallet did (minted, traded, cancelled, redeemed), not a full re-decode of
// every argument. Keeping it to the discriminator makes parsing robust to IDL
// arg-layout drift and trivially unit-testable.

import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
  type ParsedInstruction,
} from "@solana/web3.js";

import { PROGRAM_ID } from "./program";

/** A coarse classification of what the wallet did in a Meridian instruction. */
export type HistoryAction =
  | "mint" // mint_pair
  | "burn" // burn_pair
  | "trade" // place_limit_order / place_market_order / buy_no / sell_no
  | "cancel" // cancel_order
  | "redeem" // redeem
  | "settle" // settle_market / admin_settle_market / settle_sweep
  | "create" // create_strike_market
  | "admin" // other admin/config instructions
  | "unknown"; // a Meridian ix whose discriminator we don't recognize

export interface HistoryEntry {
  /** Transaction signature. */
  signature: string;
  /** Block time (unix seconds), or null if the RPC didn't return one. */
  blockTime: number | null;
  /** Whether the transaction failed (true = errored). */
  failed: boolean;
  /** The classified action. */
  action: HistoryAction;
  /** The matched on-chain instruction name (e.g. "place_limit_order"). */
  instruction: string;
}

// Anchor 8-byte instruction discriminators (sha256("global:<name>")[..8]),
// copied from the generated IDL (src/lib/idl/meridian.json `instructions[].
// discriminator`). Keyed by the hex of those 8 bytes so lookup is a string map.
interface IxMeta {
  name: string;
  action: HistoryAction;
}

const DISCRIMINATORS: Record<string, IxMeta> = {
  // [19,149,94,110,181,186,33,107]
  "13955e6eb5ba216b": { name: "mint_pair", action: "mint" },
  // [145,2,176,194,32,205,57,214]
  "9102b0c220cd39d6": { name: "burn_pair", action: "burn" },
  // [108,176,33,186,146,229,1,197]
  "6cb021ba92e501c5": { name: "place_limit_order", action: "trade" },
  // [90,118,192,252,192,99,39,145]
  "5a76c0fcc0632791": { name: "place_market_order", action: "trade" },
  // [89,240,244,16,196,201,190,163]
  "59f0f410c4c9bea3": { name: "buy_no", action: "trade" },
  // [189,194,132,42,80,249,154,103]
  "bdc2842a50f99a67": { name: "sell_no", action: "trade" },
  // [95,129,237,240,8,49,223,132]
  "5f81edf00831df84": { name: "cancel_order", action: "cancel" },
  // [184,12,86,149,70,196,97,225]
  "b80c569546c461e1": { name: "redeem", action: "redeem" },
  // [193,153,95,216,166,6,144,217]
  c1995fd8a60690d9: { name: "settle_market", action: "settle" },
  // [120,28,6,83,85,98,56,94]
  "781c06535562385e": { name: "admin_settle_market", action: "settle" },
  // [79,194,152,131,151,36,101,95]
  "4fc298839724655f": { name: "settle_sweep", action: "settle" },
  // [21,162,50,119,68,218,221,35]
  "15a2327744dadd23": { name: "create_strike_market", action: "create" },
  // [71,139,217,62,170,10,244,255]
  "478bd93eaa0af4ff": { name: "admin_force_expire_order", action: "admin" },
  // [208,127,21,1,194,190,196,70]
  "d07f1501c2bec446": { name: "initialize_config", action: "admin" },
  // [91,60,125,192,176,225,166,218]
  "5b3c7dc0b0e1a6da": { name: "set_paused", action: "admin" },
  // [188,226,166,153,98,79,206,73]
  bce2a699624fce49: {
    name: "set_require_full_verification",
    action: "admin",
  },
  // [57,97,196,95,195,206,106,136]
  "3961c45fc3ce6a88": { name: "set_treasury", action: "admin" },
};

const HEX = "0123456789abcdef";

/** Base58 → bytes is provided by web3.js; we only need bytes → hex here. */
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 0xf];
  return out;
}

/**
 * Decode a base58 string to bytes. web3.js bundles bs58 via `PublicKey`, but
 * instruction data in a parsed tx is base58 too; we decode it with the same
 * alphabet. Kept tiny + dependency-free so `parseInstruction` stays pure.
 */
const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = Object.fromEntries(
  [...B58_ALPHABET].map((c, i) => [c, i]),
);

export function base58ToBytes(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const ch of str) {
    const val = B58_MAP[ch];
    if (val === undefined) return new Uint8Array(0); // not base58 — bail
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1's are leading zero bytes.
  for (let k = 0; k < str.length && str[k] === "1"; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

/**
 * Classify a single instruction's first-8-bytes discriminator into a Meridian
 * action. `data` is the raw instruction data bytes (base58-decoded). Returns
 * null if the discriminator isn't a known Meridian instruction. Pure.
 */
export function parseInstruction(
  data: Uint8Array,
): { name: string; action: HistoryAction } | null {
  if (data.length < 8) return null;
  const disc = bytesToHex(data.subarray(0, 8));
  return DISCRIMINATORS[disc] ?? null;
}

/** A program ix shape that's enough to classify, from either parsed form. */
export interface RawProgramIx {
  /** Owning program id (base58). */
  programId: string;
  /** Raw instruction data, base58-encoded (web3.js `PartiallyDecodedInstruction.data`). */
  data?: string;
}

/**
 * Reduce one transaction's instructions to a single classified history entry.
 * Picks the first instruction targeting the Meridian program; if several match
 * (e.g. preInstructions creating ATAs are NOT Meridian, so this is rare), the
 * first Meridian ix wins. Returns null when the tx has no Meridian instruction.
 * Pure — takes already-extracted fields, no RPC.
 */
export function parseHistoryEntry(args: {
  signature: string;
  blockTime: number | null;
  failed: boolean;
  instructions: RawProgramIx[];
  programId?: string;
}): HistoryEntry | null {
  const pid = args.programId ?? PROGRAM_ID.toBase58();
  for (const ix of args.instructions) {
    if (ix.programId !== pid) continue;
    if (!ix.data) {
      // A Meridian ix with no decodable data field — record as unknown.
      return {
        signature: args.signature,
        blockTime: args.blockTime,
        failed: args.failed,
        action: "unknown",
        instruction: "unknown",
      };
    }
    const decoded = parseInstruction(base58ToBytes(ix.data));
    return {
      signature: args.signature,
      blockTime: args.blockTime,
      failed: args.failed,
      action: decoded?.action ?? "unknown",
      instruction: decoded?.name ?? "unknown",
    };
  }
  return null;
}

/** Human label per action for the UI. */
export const ACTION_LABEL: Record<HistoryAction, string> = {
  mint: "Mint pair",
  burn: "Burn pair",
  trade: "Trade",
  cancel: "Cancel order",
  redeem: "Redeem",
  settle: "Settle",
  create: "Create market",
  admin: "Admin",
  unknown: "Program call",
};

// ---- RPC plumbing (not pure; thin wrapper over the pure parse above) --------

/** Pull the program-targeting instructions out of a parsed transaction. */
function programIxsFromParsed(
  tx: ParsedTransactionWithMeta,
): RawProgramIx[] {
  const msgIxs = tx.transaction.message.instructions as (
    | ParsedInstruction
    | PartiallyDecodedInstruction
  )[];
  return msgIxs.map((ix) => {
    const programId = ix.programId.toBase58();
    // PartiallyDecodedInstruction carries base58 `data`; ParsedInstruction
    // ("parsed") does not — for those we leave data undefined.
    const data =
      "data" in ix && typeof ix.data === "string" ? ix.data : undefined;
    return { programId, data };
  });
}

/**
 * Fetch + parse the wallet's recent Meridian history. Reads signatures for the
 * wallet, loads each parsed tx, and classifies the first Meridian instruction.
 * Non-Meridian transactions are dropped. Tolerant: a failed `getTransaction`
 * for one signature is skipped, not fatal. Newest-first.
 */
export async function fetchHistory(
  connection: Connection,
  wallet: PublicKey,
  limit = 30,
): Promise<HistoryEntry[]> {
  let sigs: ConfirmedSignatureInfo[];
  try {
    sigs = await connection.getSignaturesForAddress(wallet, { limit });
  } catch {
    return [];
  }

  const pid = PROGRAM_ID.toBase58();
  // Fetch each tx individually but with bounded concurrency. Two RPC limits to
  // thread: a *batched* getParsedTransactions trips Helius' payload cap (413
  // Payload Too Large) and empties history, while 30 fully-parallel calls trip
  // the rate limiter (429 storm + retry backoff). A small concurrency window
  // (~6) avoids both — ~5 quick waves, no batch, no storm. A failed tx → null.
  const CONCURRENCY = 6;
  const sigStrs = sigs.map((s) => s.signature);
  type ParsedTx = Awaited<ReturnType<typeof connection.getParsedTransaction>>;
  const parsed: ParsedTx[] = new Array<ParsedTx>(sigStrs.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sigStrs.length) {
      const i = next++;
      try {
        parsed[i] = await connection.getParsedTransaction(sigStrs[i], {
          maxSupportedTransactionVersion: 0,
        });
      } catch {
        parsed[i] = null;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, sigStrs.length) }, worker),
  );
  const txs = sigs.map((s, i) => ({ s, tx: parsed[i] ?? null }));

  const entries: HistoryEntry[] = [];
  for (const { s, tx } of txs) {
    if (!tx) continue;
    const entry = parseHistoryEntry({
      signature: s.signature,
      blockTime: tx.blockTime ?? s.blockTime ?? null,
      failed: (tx.meta?.err ?? null) !== null || s.err !== null,
      instructions: programIxsFromParsed(tx),
      programId: pid,
    });
    if (entry) entries.push(entry);
  }
  return entries;
}
