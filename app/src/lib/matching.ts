import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AccountMeta, PublicKey } from "@solana/web3.js";

import type { BookLevel } from "./market";

// Mirror of programs/meridian/src/instructions/place_limit_order.rs and
// matching/match_step.rs. A taker walks the opposing side from the best price,
// FIFO within a price, filling at the maker's resting price, capped at
// MAX_FILLS_PER_TX entries per transaction. Each filled entry needs the maker's
// canonical payout ATA passed as a remaining account, in fill order.
export const MAX_FILLS_PER_TX = 4;
export const SIDE_BID = 0;
export const SIDE_ASK = 1;

export interface PlannedFill {
  owner: PublicKey;
  qty: bigint;
  price: bigint;
}

export interface MatchPlan {
  fills: PlannedFill[];
  /** Quantity left after fills — this is what rests on the book. */
  residual: bigint;
}

/**
 * Pure match-walk. `opposing` is the side the taker matches against, already in
 * the engine's priority order (asks ascending for a bid taker, bids descending
 * for an ask taker — exactly how `fetchBook` returns them).
 *
 *   bid taker crosses when maker (ask) price <= limit
 *   ask taker crosses when maker (bid) price >= limit
 *
 * Stops at the first non-crossing entry (the side is price-sorted), when the
 * quantity is exhausted, or at MAX_FILLS_PER_TX.
 */
export function planFills(
  opposing: BookLevel[],
  side: number,
  limitPrice: bigint,
  qty: bigint,
): MatchPlan {
  const crosses = (makerPrice: bigint) =>
    side === SIDE_BID ? makerPrice <= limitPrice : makerPrice >= limitPrice;

  let remaining = qty;
  const fills: PlannedFill[] = [];
  for (const lvl of opposing) {
    if (fills.length >= MAX_FILLS_PER_TX) break;
    if (remaining <= 0n) break;
    if (!crosses(lvl.price)) break;
    const fillQty = remaining < lvl.qty ? remaining : lvl.qty;
    fills.push({ owner: lvl.owner, qty: fillQty, price: lvl.price });
    remaining -= fillQty;
  }
  return { fills, residual: remaining };
}

/**
 * Canonical payout ATA per fill: a bid taker pays makers in USDC, an ask taker
 * pays makers in Yes. Returned in fill order — the order the handler consumes
 * `remaining_accounts`. A non-canonical account reverts (`BadMakerAccount`), so
 * this must always use the canonical ATA, including for a self-cross (the
 * owner is simply the taker).
 */
export function makerPayoutAtas(
  fills: PlannedFill[],
  side: number,
  usdcMint: PublicKey,
  yesMint: PublicKey,
): PublicKey[] {
  const payoutMint = side === SIDE_BID ? usdcMint : yesMint;
  return fills.map((f) => getAssociatedTokenAddressSync(payoutMint, f.owner));
}

/** `remaining_accounts` metas (writable, non-signer) for the fills. */
export function remainingAccountsFor(
  fills: PlannedFill[],
  side: number,
  usdcMint: PublicKey,
  yesMint: PublicKey,
): AccountMeta[] {
  return makerPayoutAtas(fills, side, usdcMint, yesMint).map((pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: true,
  }));
}
