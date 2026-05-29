import { BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

import type { MarketView } from "./market";
import {
  configPda,
  mintAuthorityPda,
  usdcEscrowPda,
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
