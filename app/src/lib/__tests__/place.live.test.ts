import { BN, Wallet } from "@coral-xyz/anchor";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  cancelOrder,
  mintPair,
  placeLimitOrder,
} from "../actions";
import { loadLocalKeypair, reachable } from "../liveTestEnv";
import {
  fetchBalances,
  fetchBook,
  fetchConfig,
  fetchMarket,
  type MarketView,
} from "../market";
import { SIDE_ASK, SIDE_BID } from "../matching";
import { configPda, marketPda, marketPdas, tickerBytes } from "../pdas";
import { getProgram, type MeridianProgram, RPC_URL } from "../program";

// Create a fresh, unexpired market so place/cancel/cross is deterministic and
// independent of how long the validator has been up. Expiry varies per run so
// repeated runs don't collide on the `init` market PDA.
async function createFreshMarket(
  program: MeridianProgram,
  admin: Keypair,
  usdcMint: PublicKey,
): Promise<MarketView> {
  const ticker = "QA";
  const strike = 680_000_000;
  const expiry = Math.floor(Date.now() / 1000) + 3600; // +1h
  const market = marketPda(ticker, strike, expiry);
  const p = marketPdas(market);
  const accounts = {
    admin: admin.publicKey,
    config: configPda(),
    market,
    book: p.book,
    yesMint: p.yesMint,
    noMint: p.noMint,
    mintAuthority: p.mintAuthority,
    usdcEscrow: p.usdcEscrow,
    yesEscrow: p.yesEscrow,
    usdcMint,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  };
  await program.methods
    .createStrikeMarket({
      ticker: Array.from(tickerBytes(ticker)),
      strikePrice: new BN(strike),
      expiryUnix: new BN(expiry),
      pythFeedId: Array.from({ length: 32 }, () => 1),
    })
    .accounts(accounts)
    .rpc();
  return fetchMarket(program, market);
}

const kp = loadLocalKeypair();
const isUp = (await reachable()) && kp !== null;
const maybe = isUp ? it : it.skip;

describe("place / cancel / cross (live validator)", () => {
  maybe(
    "rests an ask, decodes it, cancels with refund; then self-crosses",
    async () => {
      const connection = new Connection(RPC_URL, "confirmed");
      const program = getProgram(connection, new Wallet(kp!));
      const user = kp!.publicKey;

      const cfg = await fetchConfig(program, configPda());
      const market = await createFreshMarket(program, kp!, cfg.usdcMint);

      // Fund USDC + acquire Yes inventory.
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        kp!,
        cfg.usdcMint,
        user,
      );
      await mintTo(connection, kp!, cfg.usdcMint, ata.address, kp!, 100_000n);
      await mintPair({
        program,
        connection,
        market,
        usdcMint: cfg.usdcMint,
        user,
        amount: 1000n,
      });

      const base = {
        program,
        connection,
        market,
        usdcMint: cfg.usdcMint,
        user,
      };

      // --- A) resting ask: high price so it cannot cross, then cancel ---
      const yesBefore = (await fetchBalances(connection, user, cfg.usdcMint, market)).yes;
      await placeLimitOrder({ ...base, side: SIDE_ASK, price: 1000, qty: 200 });

      const afterAsk = await fetchBook(program, market.pubkey);
      const myAsk = afterAsk.asks.find(
        (l) => l.owner.equals(user) && l.price === 1000n,
      );
      expect(myAsk, "resting ask should appear in the book").toBeDefined();
      expect(myAsk!.qty).toBe(200n);

      const yesEscrowed = (await fetchBalances(connection, user, cfg.usdcMint, market)).yes;
      expect(yesEscrowed).toBe(yesBefore - 200n); // 200 Yes escrowed

      await cancelOrder({ ...base, side: SIDE_ASK, price: 1000, seq: myAsk!.seq });
      const yesAfterCancel = (await fetchBalances(connection, user, cfg.usdcMint, market)).yes;
      expect(yesAfterCancel).toBe(yesBefore); // fully refunded

      // --- B) self-cross: rest an ask @40, cross it with a bid @50 ---
      await placeLimitOrder({ ...base, side: SIDE_ASK, price: 40, qty: 200 });
      const beforeCross = await fetchBook(program, market.pubkey);
      expect(
        beforeCross.asks.some((l) => l.owner.equals(user) && l.price === 40n),
      ).toBe(true);

      const yesPreCross = (await fetchBalances(connection, user, cfg.usdcMint, market)).yes;
      // Bid @50 crosses the ask @40 — exercises remaining_accounts on-chain.
      await placeLimitOrder({ ...base, side: SIDE_BID, price: 50, qty: 200 });

      const afterCross = await fetchBook(program, market.pubkey);
      // ask consumed, bid fully filled (no residual rests)
      expect(
        afterCross.asks.some((l) => l.owner.equals(user) && l.price === 40n),
      ).toBe(false);
      expect(
        afterCross.bids.some((l) => l.owner.equals(user) && l.price === 50n),
      ).toBe(false);
      // self-trade returns the escrowed Yes to the taker
      const yesPostCross = (await fetchBalances(connection, user, cfg.usdcMint, market)).yes;
      expect(yesPostCross).toBe(yesPreCross + 200n);
    },
    45_000,
  );
});
