import { BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

import type { BookView, MarketView } from "./market";
import { planFills, remainingAccountsFor, SIDE_BID } from "./matching";
import {
  bookPda,
  configPda,
  mintAuthorityPda,
  usdcEscrowPda,
  yesEscrowPda,
} from "./pdas";
import type { MeridianProgram } from "./program";
import { ensureAtaIxs } from "./tx";

interface PairArgs {
  program: MeridianProgram;
  connection: Connection;
  market: MarketView;
  usdcMint: PublicKey;
  user: PublicKey;
  amount: bigint | number;
}

/** Shared account set for mint_pair / burn_pair. */
function pairAccounts(market: MarketView, usdcMint: PublicKey, user: PublicKey) {
  return {
    user,
    config: configPda(),
    market: market.pubkey,
    userUsdc: getAssociatedTokenAddressSync(usdcMint, user),
    usdcEscrow: usdcEscrowPda(market.pubkey),
    yesMint: market.yesMint,
    noMint: market.noMint,
    userYes: getAssociatedTokenAddressSync(market.yesMint, user),
    userNo: getAssociatedTokenAddressSync(market.noMint, user),
    mintAuthority: mintAuthorityPda(market.pubkey),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

export async function mintPair(args: PairArgs): Promise<string> {
  const { program, connection, market, usdcMint, user, amount } = args;
  const preIxs = await ensureAtaIxs(connection, user, user, [
    usdcMint,
    market.yesMint,
    market.noMint,
  ]);
  return program.methods
    .mintPair(new BN(amount.toString()))
    .accounts(pairAccounts(market, usdcMint, user))
    .preInstructions(preIxs)
    .rpc();
}

export async function burnPair(args: PairArgs): Promise<string> {
  const { program, connection, market, usdcMint, user, amount } = args;
  const preIxs = await ensureAtaIxs(connection, user, user, [usdcMint]);
  return program.methods
    .burnPair(new BN(amount.toString()))
    .accounts(pairAccounts(market, usdcMint, user))
    .preInstructions(preIxs)
    .rpc();
}

/** Shared account set for place_limit_order / cancel_order. */
function orderAccounts(
  market: MarketView,
  usdcMint: PublicKey,
  user: PublicKey,
) {
  return {
    user,
    config: configPda(),
    market: market.pubkey,
    book: bookPda(market.pubkey),
    usdcEscrow: usdcEscrowPda(market.pubkey),
    yesEscrow: yesEscrowPda(market.pubkey),
    yesMint: market.yesMint,
    userUsdc: getAssociatedTokenAddressSync(usdcMint, user),
    userYes: getAssociatedTokenAddressSync(market.yesMint, user),
    mintAuthority: mintAuthorityPda(market.pubkey),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

interface PlaceArgs {
  program: MeridianProgram;
  connection: Connection;
  market: MarketView;
  usdcMint: PublicKey;
  user: PublicKey;
  side: number; // 0 = Bid, 1 = Ask
  price: bigint | number;
  qty: bigint | number;
  /** Current book — used to plan which makers a crossing order will hit. */
  book: BookView;
}

export async function placeLimitOrder(args: PlaceArgs): Promise<string> {
  const { program, connection, market, usdcMint, user, side, price, qty, book } =
    args;
  const opposing = side === SIDE_BID ? book.asks : book.bids;
  const plan = planFills(opposing, side, BigInt(price), BigInt(qty));
  const remaining = remainingAccountsFor(
    plan.fills,
    side,
    usdcMint,
    market.yesMint,
  );
  // Taker needs a USDC ATA (bid collateral / sell proceeds) and a Yes ATA
  // (ask collateral / buy fills) — create whichever is missing.
  const preIxs = await ensureAtaIxs(connection, user, user, [
    usdcMint,
    market.yesMint,
  ]);
  return program.methods
    .placeLimitOrder({
      side,
      price: new BN(price.toString()),
      qty: new BN(qty.toString()),
    })
    .accounts(orderAccounts(market, usdcMint, user))
    .remainingAccounts(remaining)
    .preInstructions(preIxs)
    .rpc();
}

interface CancelArgs {
  program: MeridianProgram;
  market: MarketView;
  usdcMint: PublicKey;
  user: PublicKey;
  side: number;
  price: bigint | number;
  seq: bigint | number;
}

export async function cancelOrder(args: CancelArgs): Promise<string> {
  const { program, market, usdcMint, user, side, price, seq } = args;
  return program.methods
    .cancelOrder({
      side,
      price: new BN(price.toString()),
      seq: new BN(seq.toString()),
    })
    .accounts(orderAccounts(market, usdcMint, user))
    .rpc();
}
