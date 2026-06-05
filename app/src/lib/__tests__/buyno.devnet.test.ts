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
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { buyNo, mintPair, placeLimitOrder, sellNo } from "../actions";
import { loadLocalKeypair, reachable } from "../liveTestEnv";
import { fetchBalances, fetchMarket, type MarketView } from "../market";
import { SIDE_ASK, SIDE_BID } from "../matching";
import { configPda, marketPda, marketPdas, tickerBytes } from "../pdas";
import { getProgram, type MeridianProgram, RPC_URL } from "../program";

// ---------------------------------------------------------------------------
// LIVE DEVNET proof of the No-side trade paths (Buy No + Sell No), driving the
// EXACT app actions the frontend uses, against the deployed program. Run with:
//
//   NEXT_PUBLIC_RPC_URL="https://devnet.helius-rpc.com/?api-key=..." \
//     npx vitest run buyno.devnet
//
// Skips cleanly when the RPC is unreachable or no admin keypair is present.
// ---------------------------------------------------------------------------

const kp = loadLocalKeypair();
const isUp = (await reachable()) && kp !== null;
const maybe = isUp ? it : it.skip;

if (!isUp) {
  console.log(`[buyno.devnet] SKIP: ${RPC_URL} unreachable or no keypair.`);
}

const ONE = 1_000_000; // µUSDC per whole token ($1.00 collateral)

async function createMarket(
  program: MeridianProgram,
  admin: Keypair,
  usdcMint: PublicKey,
  strike: number,
): Promise<MarketView> {
  const ticker = "NOTST";
  const expiry = Math.floor(Date.now() / 1000) + 3600; // +1h, unique PDA
  const market = marketPda(ticker, strike, expiry);
  const p = marketPdas(market);
  await program.methods
    .createStrikeMarket({
      ticker: Array.from(tickerBytes(ticker)),
      strikePrice: new BN(strike),
      expiryUnix: new BN(expiry),
      pythFeedId: Array.from(Buffer.from("01".repeat(32), "hex")),
    })
    .accounts({
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
    })
    .rpc();
  return fetchMarket(program, market);
}

// Fund a fresh wallet from the admin: SOL via transfer (devnet airdrop is rate
// limited), USDC via mintTo (admin is the USDC mint authority).
async function fundWallet(
  connection: Connection,
  admin: Keypair,
  usdcMint: PublicKey,
  who: Keypair,
  usdcAmount: bigint,
): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: who.publicKey,
      lamports: 500_000_000, // 0.5 SOL for rent + fees
    }),
  );
  await sendAndConfirmTransaction(connection, tx, [admin], {
    commitment: "confirmed",
  });
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    who,
    usdcMint,
    who.publicKey,
  );
  await mintTo(connection, admin, usdcMint, ata.address, admin, usdcAmount);
}

describe("No-side trade paths on live devnet (Buy No / Sell No)", () => {
  maybe(
    "a fresh wallet Buys No against a resting bid, then Sells No against a resting ask",
    async () => {
      const connection = new Connection(RPC_URL, "confirmed");
      const admin = kp!;
      const programA = getProgram(connection, new Wallet(admin));
      const cfg = await programA.account.config.fetch(configPda());
      const usdcMint = cfg.usdcMint as PublicKey;

      // Fresh strike so the market PDA is brand new.
      const strike = 333_000_000; // $333
      const market = await createMarket(programA, admin, usdcMint, strike);

      // ---- Maker (admin) rests a TWO-SIDED book: ask @ $0.60, bid @ $0.40 ----
      const adminUsdc = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          admin,
          usdcMint,
          admin.publicKey,
        )
      ).address;
      await mintTo(connection, admin, usdcMint, adminUsdc, admin, BigInt(500 * ONE));
      const baseA = { program: programA, connection, market, usdcMint, user: admin.publicKey };
      await mintPair({ ...baseA, amount: 200n }); // admin: 200 Yes + 200 No
      await placeLimitOrder({ ...baseA, side: SIDE_ASK, price: 600_000, qty: 200 }); // sell Yes @ $0.60
      await placeLimitOrder({ ...baseA, side: SIDE_BID, price: 400_000, qty: 200 }); // buy Yes @ $0.40

      // ---- Taker B (fresh wallet, no position) ----
      const userB = Keypair.generate();
      await fundWallet(connection, admin, usdcMint, userB, BigInt(200 * ONE));
      const programB = getProgram(connection, new Wallet(userB));
      const baseB = { program: programB, connection, market, usdcMint, user: userB.publicKey };

      const b0 = await fetchBalances(connection, userB.publicKey, usdcMint, market);
      expect(b0.yes).toBe(0n);
      expect(b0.no).toBe(0n);

      // ===== BUY NO (atomic): mint pair + market-sell Yes into the $0.40 bid =====
      // No price = $1 − Yes sell price. Sell Yes at the $0.40 bid → No costs $0.60.
      const qty = 50n;
      await buyNo({ ...baseB, amount: qty, minYesSellPrice: 400_000 });
      const b1 = await fetchBalances(connection, userB.publicKey, usdcMint, market);
      expect(b1.no).toBe(qty); // B now holds 50 No
      expect(b1.yes).toBe(0n); // and zero Yes (atomic No-only exposure)
      // Net USDC spent = 50*$1 (mint) − 50*$0.40 (Yes sold) = $30 (= 50 * $0.60 No).
      const spent = b0.usdc - b1.usdc;
      expect(spent).toBe(BigInt(50 * 0.6 * ONE));

      // ===== SELL NO (atomic): market-buy Yes from the $0.60 ask + burn pair =====
      await sellNo({ ...baseB, amount: qty, maxYesBuyPrice: 600_000 });
      const b2 = await fetchBalances(connection, userB.publicKey, usdcMint, market);
      expect(b2.no).toBe(0n); // No position closed
      expect(b2.yes).toBe(0n); // no leftover Yes
      // Net USDC back = 50*$1 (burn) − 50*$0.60 (Yes bought) = $20.
      const recovered = b2.usdc - b1.usdc;
      expect(recovered).toBe(BigInt(50 * 0.4 * ONE));

      // Round-trip: bought No for $30, closed it for $20 → net −$10 (the $0.20
      // bid/ask spread on 50 contracts). The four No-side mechanics all executed
      // on the deployed program.
      expect(b0.usdc - b2.usdc).toBe(BigInt(50 * 0.2 * ONE));
    },
    180_000,
  );
});
