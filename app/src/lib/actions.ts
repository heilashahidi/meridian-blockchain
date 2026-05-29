import { BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

import { fetchBook, winningMint, type MarketView } from "./market";
import {
  planFills,
  remainingAccountsFor,
  SIDE_ASK,
  SIDE_BID,
} from "./matching";
import {
  bookPda,
  configPda,
  mintAuthorityPda,
  noMintPda,
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
}

export async function placeLimitOrder(args: PlaceArgs): Promise<string> {
  const { program, connection, market, usdcMint, user, side, price, qty } = args;
  // Plan fills against a freshly-fetched book, not a possibly-stale UI snapshot:
  // the maker ATAs in remaining_accounts must match the makers the on-chain
  // match actually hits, or the tx reverts with BadMakerAccount.
  const book = await fetchBook(program, market.pubkey);
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

interface MarketOrderArgs {
  program: MeridianProgram;
  connection: Connection;
  market: MarketView;
  usdcMint: PublicKey;
  user: PublicKey;
  side: number; // 0 = Bid (Buy Yes), 1 = Ask (Sell Yes)
  slippageBound: bigint | number; // worst acceptable Yes price (microunits)
  qty: bigint | number;
}

/**
 * Taker market order on the Yes book — fills against the opposing side and
 * rejects (refunds) any residual rather than resting it. Same account set as
 * `place_limit_order`; only the residual handling differs on-chain. Maker
 * remaining-accounts are planned against a freshly-fetched book.
 */
export async function placeMarketOrder(args: MarketOrderArgs): Promise<string> {
  const { program, connection, market, usdcMint, user, side, slippageBound, qty } =
    args;
  const book = await fetchBook(program, market.pubkey);
  const opposing = side === SIDE_BID ? book.asks : book.bids;
  const plan = planFills(opposing, side, BigInt(slippageBound), BigInt(qty));
  const remaining = remainingAccountsFor(
    plan.fills,
    side,
    usdcMint,
    market.yesMint,
  );
  const preIxs = await ensureAtaIxs(connection, user, user, [
    usdcMint,
    market.yesMint,
  ]);
  return program.methods
    .placeMarketOrder({
      side,
      qty: new BN(qty.toString()),
      slippageBound: new BN(slippageBound.toString()),
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

interface RedeemArgs {
  program: MeridianProgram;
  connection: Connection;
  market: MarketView;
  usdcMint: PublicKey;
  user: PublicKey;
  amount: bigint | number;
}

export async function redeem(args: RedeemArgs): Promise<string> {
  const { program, connection, market, usdcMint, user, amount } = args;
  const mint = winningMint(market);
  if (!mint) throw new Error("Market is not settled yet");
  const preIxs = await ensureAtaIxs(connection, user, user, [usdcMint]);
  const accounts = {
    user,
    config: configPda(),
    market: market.pubkey,
    winningMint: mint,
    userWinning: getAssociatedTokenAddressSync(mint, user),
    userUsdc: getAssociatedTokenAddressSync(usdcMint, user),
    usdcEscrow: usdcEscrowPda(market.pubkey),
    mintAuthority: mintAuthorityPda(market.pubkey),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  return program.methods
    .redeem(new BN(amount.toString()))
    .accounts(accounts)
    .preInstructions(preIxs)
    .rpc();
}

/**
 * Shared account set for `buy_no` / `sell_no`. The on-chain `BuyNo` / `SellNo`
 * structs union the `mint_pair` set with the order leg's `book` + `yes_escrow`
 * (see `buy_no.rs` / `sell_no.rs` "Accounts struct shape").
 */
function noTradeAccounts(
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
    noMint: noMintPda(market.pubkey),
    userUsdc: getAssociatedTokenAddressSync(usdcMint, user),
    userYes: getAssociatedTokenAddressSync(market.yesMint, user),
    userNo: getAssociatedTokenAddressSync(market.noMint, user),
    mintAuthority: mintAuthorityPda(market.pubkey),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

interface BuyNoArgs {
  program: MeridianProgram;
  connection: Connection;
  market: MarketView;
  usdcMint: PublicKey;
  user: PublicKey;
  /** Quantity of No tokens to acquire (Yes/No share one base unit). */
  amount: bigint | number;
  /**
   * Slippage floor for the internal Yes market-sell leg, in microunits per Yes
   * token = `1_000_000 − noPrice`. Use `tradePaths.resolveTradePath` to derive
   * this from a No price. Pass `1` for "no floor".
   */
  minYesSellPrice: bigint | number;
}

/**
 * Buy No — atomic `buy_no`: mint a Yes/No pair against USDC, then MARKET-SELL
 * the Yes leg. The Yes leg is an **Ask taker**, so it crosses the resting
 * **bids** and pays makers in **Yes** (canonical Yes ATA per fill). We plan
 * fills against a freshly-fetched book so the maker remaining-accounts match
 * the makers the on-chain match actually hits. Single wallet approval.
 */
export async function buyNo(args: BuyNoArgs): Promise<string> {
  const { program, connection, market, usdcMint, user, amount, minYesSellPrice } =
    args;
  const book = await fetchBook(program, market.pubkey);
  // Ask taker matches the bid side at the slippage floor.
  const plan = planFills(
    book.bids,
    SIDE_ASK,
    BigInt(minYesSellPrice),
    BigInt(amount),
  );
  const remaining = remainingAccountsFor(
    plan.fills,
    SIDE_ASK,
    usdcMint,
    market.yesMint,
  );
  const preIxs = await ensureAtaIxs(connection, user, user, [
    usdcMint,
    market.yesMint,
    market.noMint,
  ]);
  return program.methods
    .buyNo({
      amount: new BN(amount.toString()),
      minYesSellPrice: new BN(minYesSellPrice.toString()),
    })
    .accounts(noTradeAccounts(market, usdcMint, user))
    .remainingAccounts(remaining)
    .preInstructions(preIxs)
    .rpc();
}

interface SellNoArgs {
  program: MeridianProgram;
  connection: Connection;
  market: MarketView;
  usdcMint: PublicKey;
  user: PublicKey;
  /** Quantity of No tokens to liquidate. */
  amount: bigint | number;
  /**
   * Slippage cap for the internal Yes market-buy leg, in microunits per Yes
   * token = `1_000_000 − noPrice`. Pass a large value for "no cap" (but the
   * up-front USDC lock is `amount * maxYesBuyPrice`, so keep it realistic).
   */
  maxYesBuyPrice: bigint | number;
}

/**
 * Sell No — atomic `sell_no`: MARKET-BUY the Yes leg, then burn the pair. The
 * Yes leg is a **Bid taker**, so it crosses the resting **asks** and pays
 * makers in **USDC** (canonical USDC ATA per fill). Plans against a fresh book.
 * Requires the wallet to already hold `amount` No (enforced on-chain). Single
 * wallet approval.
 */
export async function sellNo(args: SellNoArgs): Promise<string> {
  const { program, connection, market, usdcMint, user, amount, maxYesBuyPrice } =
    args;
  const book = await fetchBook(program, market.pubkey);
  // Bid taker matches the ask side at the slippage cap.
  const plan = planFills(
    book.asks,
    SIDE_BID,
    BigInt(maxYesBuyPrice),
    BigInt(amount),
  );
  const remaining = remainingAccountsFor(
    plan.fills,
    SIDE_BID,
    usdcMint,
    market.yesMint,
  );
  const preIxs = await ensureAtaIxs(connection, user, user, [
    usdcMint,
    market.yesMint,
    market.noMint,
  ]);
  return program.methods
    .sellNo({
      amount: new BN(amount.toString()),
      maxYesBuyPrice: new BN(maxYesBuyPrice.toString()),
    })
    .accounts(noTradeAccounts(market, usdcMint, user))
    .remainingAccounts(remaining)
    .preInstructions(preIxs)
    .rpc();
}
