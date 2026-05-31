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

function rawToBook(raw: RawBook | null): BookView | null {
  return raw
    ? { bids: sideToLevels(raw.bids), asks: sideToLevels(raw.asks), nextSeq: big(raw.nextSeq) }
    : null;
}

/**
 * Batched book read: ONE `getMultipleAccountsInfo` for every market's book PDA
 * instead of N individual `getAccountInfo` calls. Returns a map keyed by market
 * base58. A missing/undecodable book maps to null. Anchor chunks ≤100 per RPC
 * call; the daily board is well under that. This is the load-time fix — the
 * per-market `fetchBook` storm was ~N calls × retries on a rate-limited RPC.
 */
export async function fetchBooks(
  program: MeridianProgram,
  markets: PublicKey[],
): Promise<Record<string, BookView | null>> {
  if (markets.length === 0) return {};
  const pdas = markets.map((m) => bookPda(m));
  const raws = (await program.account.book.fetchMultiple(
    pdas,
  )) as unknown as (RawBook | null)[];
  const out: Record<string, BookView | null> = {};
  markets.forEach((m, i) => {
    out[m.toBase58()] = rawToBook(raws[i] ?? null);
  });
  return out;
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

// SPL token-account `amount` is a u64 LE at byte offset 64 (mint[32] owner[32]
// amount[8] …). Decode it straight from the raw account, treating a
// missing/short account as a zero balance.
function tokenAmount(info: { data: Buffer } | null): bigint {
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

async function getMultipleChunked(
  connection: Connection,
  keys: PublicKey[],
): Promise<({ data: Buffer } | null)[]> {
  const out: ({ data: Buffer } | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const res = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100));
    for (const r of res) out.push(r ? { data: r.data as Buffer } : null);
  }
  return out;
}

/**
 * Batched balances across many markets: derive every ATA (one shared USDC + a
 * Yes and No per market) and read them all with `getMultipleAccountsInfo`
 * (chunks of 100) instead of 3 calls per market. Turns ~3N `getAccountInfo`
 * calls into ⌈(2N+1)/100⌉ — the portfolio/dashboard load-time fix. Returns a
 * map keyed by market base58. USDC is the same wallet account for every market.
 */
export async function fetchBalancesMany(
  connection: Connection,
  owner: PublicKey,
  usdcMint: PublicKey,
  markets: MarketView[],
): Promise<Record<string, Balances>> {
  if (markets.length === 0) return {};
  const usdcAta = getAssociatedTokenAddressSync(usdcMint, owner);
  const legs = markets.map((m) => ({
    key: m.pubkey.toBase58(),
    yesAta: getAssociatedTokenAddressSync(m.yesMint, owner),
    noAta: getAssociatedTokenAddressSync(m.noMint, owner),
  }));
  const infos = await getMultipleChunked(connection, [
    usdcAta,
    ...legs.flatMap((l) => [l.yesAta, l.noAta]),
  ]);
  const usdc = tokenAmount(infos[0]);
  const out: Record<string, Balances> = {};
  legs.forEach((l, i) => {
    out[l.key] = {
      usdc,
      yes: tokenAmount(infos[1 + i * 2]),
      no: tokenAmount(infos[1 + i * 2 + 1]),
    };
  });
  return out;
}
