// client.ts — Anchor program client + PDA helpers for the automation service.
//
// Mirrors app/src/lib/{program,pdas,idlPatch}.ts but for a Node service that
// signs with a real Keypair (NodeWallet) rather than a browser wallet.
//
// CRITICAL — the in-memory IDL patch: the Meridian program keeps its
// matching-engine types (OrderKey/OrderEntry/BookSide) out of the generated
// IDL (they implement IdlBuild as empty stubs). The `Book` account references
// `BookSide<32>`, so a bare `new Program(idl)` throws "Type not found: bids".
// We re-add those three types and flatten `Book.bids/asks` to a concrete
// `BookSide32` so Anchor can construct + decode the book. Identical to
// app/src/lib/idlPatch.ts — kept local so automation/ is self-contained.

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import type { BN as BNType } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import rawIdl from "./idl/meridian.json" with { type: "json" };
import type { Meridian } from "./idl/meridian.js";

export const PROGRAM_ID = new PublicKey(
  "6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX",
);

// ─── on-chain constant mirrors ─────────────────────────────────────────────
//
// These MUST stay in sync with the program. The jobs (U4/U5) reference them to
// pre-check the oracle window / reason about the override grace off-chain.

// MUST match programs/meridian/src/instructions/settle_market.rs (SETTLE_WINDOW_SECONDS)
export const SETTLE_WINDOW_SECONDS = 900;

// MUST match programs/meridian/src/instructions/admin.rs (EMERGENCY_GRACE_SECONDS)
export const EMERGENCY_GRACE_SECONDS = 86_400;

// ─── runtime BN constructor ─────────────────────────────────────────────────
//
// `@coral-xyz/anchor` re-exports BN dynamically from bn.js; under Node ESM the
// named value export isn't statically resolvable (`import { BN }` throws at
// runtime). Take the TYPE via a type-only import and the runtime VALUE from the
// namespace. Shared by the jobs so the workaround lives in one place.
export const BN: typeof BNType = (anchor.BN ??
  (anchor as { default?: { BN?: typeof BNType } }).default?.BN) as typeof BNType;

// ─── in-memory IDL patch (see app/src/lib/idlPatch.ts) ─────────────────────

function patchIdl(src: typeof rawIdl): typeof rawIdl {
  const idl = JSON.parse(JSON.stringify(src));
  const has = (n: string) =>
    idl.types?.some((t: { name: string }) => t.name === n);

  if (!has("OrderKey")) {
    idl.types.push({
      name: "OrderKey",
      type: {
        kind: "struct",
        fields: [
          { name: "price", type: "u64" },
          { name: "seq", type: "u64" },
        ],
      },
    });
  }
  if (!has("OrderEntry")) {
    idl.types.push({
      name: "OrderEntry",
      type: {
        kind: "struct",
        fields: [
          { name: "key", type: { defined: { name: "OrderKey" } } },
          { name: "owner", type: { array: ["u8", 32] } },
          { name: "qty", type: "u64" },
        ],
      },
    });
  }
  if (!has("BookSide32")) {
    idl.types.push({
      name: "BookSide32",
      type: {
        kind: "struct",
        fields: [
          { name: "len", type: "u64" },
          {
            name: "entries",
            type: { array: [{ defined: { name: "OrderEntry" } }, 32] },
          },
        ],
      },
    });
  }

  const book = idl.types?.find((t: { name: string }) => t.name === "Book");
  if (book) {
    for (const f of book.type.fields) {
      if (f.name === "bids" || f.name === "asks") {
        f.type = { defined: { name: "BookSide32" } };
      }
    }
  }
  return idl;
}

/** Patched IDL used for the runtime Anchor client. */
export const meridianIdl = patchIdl(rawIdl) as Meridian;

export type MeridianProgram = Program<Meridian>;

// ─── program construction ──────────────────────────────────────────────────

export interface ClientContext {
  connection: Connection;
  provider: AnchorProvider;
  program: MeridianProgram;
  wallet: Wallet;
}

/**
 * Build a typed Anchor `Program` bound to a signing keypair. Anchor 0.30+ reads
 * the program ID from `idl.address`, so we pass `(idl, provider)` only.
 */
export function buildClient(
  connection: Connection,
  keypair: Keypair,
): ClientContext {
  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new Program<Meridian>(meridianIdl, provider);
  return { connection, provider, program, wallet };
}

/**
 * Read-only program for fetching accounts (Config/Market/Book) without a real
 * signer. Anchor still wants a wallet shape; a throwaway keypair is fine.
 */
export function buildReadOnlyClient(connection: Connection): MeridianProgram {
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program<Meridian>(meridianIdl, provider);
}

// ─── PDA helpers (mirror app/src/lib/pdas.ts) ──────────────────────────────

const enc = (s: string) => new TextEncoder().encode(s);

function u64le(value: bigint | number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(value), true);
  return buf;
}

function i64le(value: bigint | number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, BigInt(value), true);
  return buf;
}

/** 8-byte right-zero-padded ASCII ticker, matching `Market.ticker`. */
export function tickerBytes(ticker: string): Uint8Array {
  const out = new Uint8Array(8);
  out.set(enc(ticker).slice(0, 8));
  return out;
}

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc("config")], PROGRAM_ID)[0];
}

export function marketPda(
  ticker: string,
  strikePrice: bigint | number,
  expiryUnix: bigint | number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc("market"), tickerBytes(ticker), u64le(strikePrice), i64le(expiryUnix)],
    PROGRAM_ID,
  )[0];
}

const perMarket = (prefix: string) => (market: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([enc(prefix), market.toBuffer()], PROGRAM_ID)[0];

export const bookPda = perMarket("book");
export const yesMintPda = perMarket("yes_mint");
export const noMintPda = perMarket("no_mint");
export const mintAuthorityPda = perMarket("mint_auth");
export const usdcEscrowPda = perMarket("usdc_escrow");
export const yesEscrowPda = perMarket("yes_escrow");

/** All per-market PDAs in one object — convenient for the jobs (U4/U5). */
export function marketPdas(market: PublicKey) {
  return {
    book: bookPda(market),
    yesMint: yesMintPda(market),
    noMint: noMintPda(market),
    mintAuthority: mintAuthorityPda(market),
    usdcEscrow: usdcEscrowPda(market),
    yesEscrow: yesEscrowPda(market),
  };
}

// ─── shared on-chain reads ──────────────────────────────────────────────────

/**
 * Read `Config.usdc_mint` once (cached process-wide). Shared by the jobs so the
 * fetch + cache lives in one place. The mint is immutable for a deployment, so a
 * single read is safe to cache for the life of the process.
 */
let usdcMintCache: PublicKey | null = null;
export async function fetchUsdcMint(
  program: MeridianProgram,
  configAddr: PublicKey,
): Promise<PublicKey> {
  if (usdcMintCache) return usdcMintCache;
  const config = await program.account.config.fetch(configAddr);
  usdcMintCache = config.usdcMint as PublicKey;
  return usdcMintCache;
}
