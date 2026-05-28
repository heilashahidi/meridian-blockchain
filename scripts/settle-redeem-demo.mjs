#!/usr/bin/env node
//
// settle-redeem-demo.mjs — drive settle_market + redeem against a running
// localnet that has a forged Pyth account injected at genesis (see
// forge-pyth-account.mjs + settle-redeem-demo.sh). Completes the binary-option
// lifecycle to "winning side paid out".
//
// Preconditions (the .sh orchestrator sets these up):
//   * validator booted with --account <oracle> <fixture.json>
//   * program deployed; Config initialized with pyth_receiver == oracle owner
//   * a 6-decimal USDC mint exists and the local keypair is its mint authority
//
// Steps:
//   1. Create a market whose expiry is already in the past (create_strike_market
//      doesn't clock-check expiry), with pyth_feed_id matching the oracle.
//   2. mint_pair so USDC sits in escrow and the user holds Yes (the winner).
//   3. settle_market against the injected oracle → market.outcome = YesWins.
//   4. redeem the Yes tokens 1:1 for USDC from escrow.
//
// Usage:
//   node settle-redeem-demo.mjs --usdc-mint <m> --oracle <addr>
//        [--rpc ...] [--keypair ...] [--feed-id <64hex>] [--strike-dollars 680]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount as getSplAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const BN = anchor.BN ?? anchor.default?.BN;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const IDL_PATH = path.join(REPO_ROOT, "target", "idl", "meridian.json");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.replace(/^--/, "");
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = val;
  }
  return out;
}
const args = parseArgs(process.argv);
const RPC_URL = args.rpc ?? "http://127.0.0.1:8899";
const KEYPAIR_PATH = (args.keypair ?? path.join(os.homedir(), ".config/solana/id.json")).replace(
  /^~/,
  os.homedir(),
);
const USDC_MINT_STR = args["usdc-mint"];
const ORACLE_STR = args.oracle;
const FEED_HEX = args["feed-id"] ?? "01".repeat(32);
const STRIKE_DOLLARS = Number(args["strike-dollars"] ?? 680);
const TICKER = (args.ticker ?? "SETL").toUpperCase();

if (!USDC_MINT_STR || !ORACLE_STR) {
  console.error("error: --usdc-mint and --oracle are required");
  process.exit(2);
}

const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);
const STRIP = new Set(["Book"]);
if (Array.isArray(idl.accounts)) idl.accounts = idl.accounts.filter((a) => !STRIP.has(a.name));
if (Array.isArray(idl.types)) idl.types = idl.types.filter((t) => !STRIP.has(t.name));

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))));
const connection = new Connection(RPC_URL, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

const USDC_MINT = new PublicKey(USDC_MINT_STR);
const ORACLE = new PublicKey(ORACLE_STR);

const enc = (s) => Buffer.from(s, "utf8");
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const configPda = () => pda([enc("config")]);
function tickerBytes(t) {
  const b = Buffer.alloc(8, 0);
  Buffer.from(t, "ascii").copy(b, 0, 0, Math.min(8, t.length));
  return b;
}
function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}
function i64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}
const marketPda = (t, s, e) => pda([enc("market"), tickerBytes(t), u64le(s), i64le(e)]);
const subPdas = (m) => ({
  book: pda([enc("book"), m.toBuffer()]),
  yesMint: pda([enc("yes_mint"), m.toBuffer()]),
  noMint: pda([enc("no_mint"), m.toBuffer()]),
  mintAuthority: pda([enc("mint_auth"), m.toBuffer()]),
  usdcEscrow: pda([enc("usdc_escrow"), m.toBuffer()]),
  yesEscrow: pda([enc("yes_escrow"), m.toBuffer()]),
});

const line = "─".repeat(74);
const header = (s) => console.log(`\n${line}\n  ${s}\n${line}`);
const kv = (k, v) => console.log(`  ${String(k).padEnd(26)} ${v}`);
async function bal(ata) {
  try {
    return (await getSplAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

async function main() {
  header("Meridian settle + redeem demo (forged oracle)");
  kv("RPC", RPC_URL);
  kv("Program ID", PROGRAM_ID.toBase58());
  kv("Oracle (injected)", ORACLE.toBase58());

  const config = configPda();
  const cfg = await program.account.config.fetch(config);
  kv("Config", config.toBase58());
  kv("pyth_receiver (config)", cfg.pythReceiver.toBase58());

  // Sanity: the injected oracle's owner must equal config.pyth_receiver.
  const oracleInfo = await connection.getAccountInfo(ORACLE);
  if (!oracleInfo) {
    console.error(`error: oracle account ${ORACLE.toBase58()} not found — was it injected at genesis?`);
    process.exit(3);
  }
  kv("Oracle owner", oracleInfo.owner.toBase58());
  if (!oracleInfo.owner.equals(cfg.pythReceiver)) {
    console.error("error: oracle owner != config.pyth_receiver — settle will fail InvalidOracleOwner");
    process.exit(3);
  }

  // ─── 1) past-expiry market ─────────────────────────────────────────────
  header("1) create market (expiry in the past)");
  const strikeMicro = Math.round(STRIKE_DOLLARS * 1_000_000);
  const expiryUnix = Math.floor(Date.now() / 1000) - 3600; // 1h in the past
  const market = marketPda(TICKER, strikeMicro, expiryUnix);
  const P = subPdas(market);
  const pythFeedId = Array.from(Buffer.from(FEED_HEX, "hex"));
  kv("Market PDA", market.toBase58());
  kv("Strike / expiry", `$${STRIKE_DOLLARS} / ${new Date(expiryUnix * 1000).toISOString()} (past)`);

  await program.methods
    .createStrikeMarket({
      ticker: Array.from(tickerBytes(TICKER)),
      strikePrice: new BN(strikeMicro),
      expiryUnix: new BN(expiryUnix),
      pythFeedId,
    })
    .accounts({
      admin: payer.publicKey,
      config,
      market,
      book: P.book,
      yesMint: P.yesMint,
      noMint: P.noMint,
      mintAuthority: P.mintAuthority,
      usdcEscrow: P.usdcEscrow,
      yesEscrow: P.yesEscrow,
      usdcMint: USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log("  ✓ market created");

  // ─── 2) mint_pair (fund escrow + hold the winner) ──────────────────────
  header("2) mint_pair — deposit 1000 USDC -> 1000 Yes + 1000 No");
  const userUsdc = (await getOrCreateAssociatedTokenAccount(connection, payer, USDC_MINT, payer.publicKey)).address;
  const userYes = (await getOrCreateAssociatedTokenAccount(connection, payer, P.yesMint, payer.publicKey)).address;
  const userNo = (await getOrCreateAssociatedTokenAccount(connection, payer, P.noMint, payer.publicKey)).address;
  await mintTo(connection, payer, USDC_MINT, userUsdc, payer, 5_000_000n);

  await program.methods
    .mintPair(new BN(1000))
    .accounts({
      user: payer.publicKey,
      config,
      market,
      userUsdc,
      usdcEscrow: P.usdcEscrow,
      yesMint: P.yesMint,
      noMint: P.noMint,
      userYes,
      userNo,
      mintAuthority: P.mintAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  kv("user Yes", (await bal(userYes)).toString());
  kv("user No", (await bal(userNo)).toString());
  kv("USDC escrow", (await bal(P.usdcEscrow)).toString());

  // ─── 3) settle_market ──────────────────────────────────────────────────
  header("3) settle_market — read the forged oracle, stamp the outcome");
  let m = await program.account.market.fetch(market);
  kv("settled (pre)", String(m.settled));
  await program.methods
    .settleMarket()
    .accounts({ caller: payer.publicKey, config, market, priceUpdate: ORACLE })
    .rpc();
  m = await program.account.market.fetch(market);
  // outcome is an Anchor enum -> { yesWins: {} } | { noWins: {} }
  const outcome = m.outcome ? Object.keys(m.outcome)[0] : "none";
  kv("settled (post)", String(m.settled));
  kv("outcome", outcome);

  // ─── 4) redeem the winning side ────────────────────────────────────────
  header("4) redeem — burn 1000 Yes (winner) for 1000 USDC from escrow");
  const usdcPre = await bal(userUsdc);
  await program.methods
    .redeem(new BN(1000))
    .accounts({
      user: payer.publicKey,
      config,
      market,
      winningMint: P.yesMint,
      userWinning: userYes,
      userUsdc,
      usdcEscrow: P.usdcEscrow,
      mintAuthority: P.mintAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  kv("user Yes (post)", (await bal(userYes)).toString());
  kv("user USDC gained", ((await bal(userUsdc)) - usdcPre).toString() + "  (= 1000, 1:1 payout)");
  kv("USDC escrow (post)", (await bal(P.usdcEscrow)).toString());

  header("Summary — winning side paid out");
  kv("settle_market", `✓ outcome=${outcome}`);
  kv("redeem", "✓ 1000 Yes → 1000 USDC");
  console.log("");
}

main().catch((e) => {
  console.error("\nsettle/redeem demo failed:", e?.message ?? e);
  if (e?.logs) {
    console.error("\nprogram logs:");
    for (const l of e.logs) console.error(`  ${l}`);
  }
  process.exit(1);
});
