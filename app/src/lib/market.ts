import { BN } from "@coral-xyz/anchor";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

import { bookPda } from "./pdas";
import type { MeridianProgram } from "./program";

const big = (x: BN): bigint => BigInt(x.toString());
const toKey = (owner: number[]): PublicKey =>
  new PublicKey(Uint8Array.from(owner));

export type Outcome = "yesWins" | "noWins" | null;

export interface ConfigView {
  admin: PublicKey;
  usdcMint: PublicKey;
  treasury: PublicKey;
  paused: boolean;
}

export interface MarketView {
  pubkey: PublicKey;
  ticker: number[];
  strikePrice: bigint;
  expiryUnix: bigint;
  settled: boolean;
  settledAt: bigint;
  outcome: Outcome;
  yesMint: PublicKey;
  noMint: PublicKey;
}

export interface BookLevel {
  price: bigint;
  seq: bigint;
  owner: PublicKey;
  qty: bigint;
}

export interface BookView {
  bids: BookLevel[];
  asks: BookLevel[];
  nextSeq: bigint;
}

export interface Balances {
  usdc: bigint;
  yes: bigint;
  no: bigint;
}

// Raw shapes Anchor returns for the patched Book (BNs + u8 arrays).
interface RawEntry {
  key: { price: BN; seq: BN };
  owner: number[];
  qty: BN;
}
interface RawSide {
  len: BN;
  entries: RawEntry[];
}
interface RawBook {
  bids: RawSide;
  asks: RawSide;
  nextSeq: BN;
}

function normalizeOutcome(o: unknown): Outcome {
  if (!o || typeof o !== "object") return null;
  if ("yesWins" in o) return "yesWins";
  if ("noWins" in o) return "noWins";
  return null;
}

export async function fetchConfig(
  program: MeridianProgram,
  configPda: PublicKey,
): Promise<ConfigView> {
  const c = await program.account.config.fetch(configPda);
  return {
    admin: c.admin,
    usdcMint: c.usdcMint,
    treasury: c.treasury,
    paused: c.paused,
  };
}

export async function listMarkets(
  program: MeridianProgram,
): Promise<MarketView[]> {
  const all = await program.account.market.all();
  return all
    .map(({ publicKey, account }) => ({
      pubkey: publicKey,
      ticker: account.ticker,
      strikePrice: big(account.strikePrice),
      expiryUnix: big(account.expiryUnix),
      settled: account.settled,
      settledAt: big(account.settledAt),
      outcome: normalizeOutcome(account.outcome),
      yesMint: account.yesMint,
      noMint: account.noMint,
    }))
    .sort((a, b) => Number(a.expiryUnix - b.expiryUnix));
}

export async function fetchMarket(
  program: MeridianProgram,
  market: PublicKey,
): Promise<MarketView> {
  const account = await program.account.market.fetch(market);
  return {
    pubkey: market,
    ticker: account.ticker,
    strikePrice: big(account.strikePrice),
    expiryUnix: big(account.expiryUnix),
    settled: account.settled,
    settledAt: big(account.settledAt),
    outcome: normalizeOutcome(account.outcome),
    yesMint: account.yesMint,
    noMint: account.noMint,
  };
}

function sideToLevels(side: RawSide): BookLevel[] {
  const len = Number(side.len);
  return side.entries.slice(0, len).map((e) => ({
    price: big(e.key.price),
    seq: big(e.key.seq),
    owner: toKey(e.owner),
    qty: big(e.qty),
  }));
}

export async function fetchBook(
  program: MeridianProgram,
  market: PublicKey,
): Promise<BookView> {
  const raw = (await program.account.book.fetch(
    bookPda(market),
  )) as unknown as RawBook;
  return {
    bids: sideToLevels(raw.bids),
    asks: sideToLevels(raw.asks),
    nextSeq: big(raw.nextSeq),
  };
}

/** A token balance, tolerating a not-yet-created ATA as 0. */
async function ataBalance(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
): Promise<bigint> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const acc = await getAccount(connection, ata);
    return acc.amount;
  } catch (e) {
    if (
      e instanceof TokenAccountNotFoundError ||
      e instanceof TokenInvalidAccountOwnerError
    ) {
      return 0n;
    }
    throw e;
  }
}

/** The winning token's mint for a settled market, or null if unsettled. */
export function winningMint(m: MarketView): PublicKey | null {
  if (!m.settled || !m.outcome) return null;
  return m.outcome === "yesWins" ? m.yesMint : m.noMint;
}

export async function fetchBalances(
  connection: Connection,
  owner: PublicKey,
  usdcMint: PublicKey,
  market: MarketView,
): Promise<Balances> {
  const [usdc, yes, no] = await Promise.all([
    ataBalance(connection, usdcMint, owner),
    ataBalance(connection, market.yesMint, owner),
    ataBalance(connection, market.noMint, owner),
  ]);
  return { usdc, yes, no };
}
