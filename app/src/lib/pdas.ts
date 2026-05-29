import { PublicKey } from "@solana/web3.js";

import { PROGRAM_ID } from "./program";

// Seed encoders. Use TextEncoder + DataView so these stay browser-safe with no
// Buffer/BN dependency. Strike is u64-LE, expiry is i64-LE — matching the
// program's PDA seed (`programs/meridian/src/state/market.rs`).
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
  PublicKey.findProgramAddressSync(
    [enc(prefix), market.toBuffer()],
    PROGRAM_ID,
  )[0];

export const bookPda = perMarket("book");
export const yesMintPda = perMarket("yes_mint");
export const noMintPda = perMarket("no_mint");
export const mintAuthorityPda = perMarket("mint_auth");
export const usdcEscrowPda = perMarket("usdc_escrow");
export const yesEscrowPda = perMarket("yes_escrow");

/** All per-market PDAs in one object — convenient for the trade panels. */
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
