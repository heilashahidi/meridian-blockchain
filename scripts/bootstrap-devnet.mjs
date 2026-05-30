#!/usr/bin/env node
//
// bootstrap-devnet.mjs — one-off devnet bootstrap for the Meridian CLOB.
//
// What it does (idempotent on each step):
//   1. Load the IDL + program ID from the workspace.
//   2. Connect to devnet with the local Solana keypair (~/.config/solana/id.json).
//   3. Ensure the global Config singleton exists. If not, call initialize_config
//      with the operator-supplied pyth_receiver pubkey.
//   4. Create one strike market for the supplied (ticker, strike, expiry) triple.
//      Skips if the Market PDA already exists.
//   5. Print every resulting account address so you can copy-paste into clients.
//
// Usage:
//
//   cd scripts && npm install
//   node bootstrap-devnet.mjs \
//     --usdc-mint <devnet USDC mint pubkey> \
//     --pyth-receiver <Pyth Receiver program ID> \
//     [--ticker META] [--strike-dollars 680] [--expiry-hours-from-now 24] \
//     [--pyth-feed-id <hex>] [--fee-authority <pubkey>] \
//     [--keypair ~/.config/solana/id.json] [--rpc https://api.devnet.solana.com]
//
// Notes:
//   * The Pyth Receiver program on devnet (and mainnet) as of 2026 is
//     `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`. Verify in current Pyth docs
//     before pointing real funds at it; pyth_receiver is stored in Config and
//     gates every settle_market call.
//   * Devnet USDC test mint commonly used: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
//     You can also use a mint you control via spl-token create-mint.
//   * pyth_feed_id is stored on the Market but not validated at create time
//     (settle_market validates it). For a smoke-test market a placeholder
//     all-1s value works; for a real settle you need the actual feed id.
//   * After this script lands, settle_market is the next demo step — supply
//     the matching Pyth feed via the off-chain Hermes path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount as getSplAccount,
  getMint as getSplMint,
} from "@solana/spl-token";

// @coral-xyz/anchor is CJS. Under Node's ESM namespace import, statically
// detectable named exports (Program, Wallet, AnchorProvider…) are hoisted to
// the namespace, but BN — re-exported dynamically from bn.js — is not, so
// `anchor.BN` is undefined. Resolve it from the default export as a fallback.
const BN = anchor.BN ?? anchor.default?.BN;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const IDL_PATH = path.join(REPO_ROOT, "target", "idl", "meridian.json");

// ─── arg parsing ─────────────────────────────────────────────────────────

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

const RPC_URL = args.rpc ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH = (args.keypair ?? path.join(os.homedir(), ".config/solana/id.json")).replace(
  /^~/,
  os.homedir(),
);
const USDC_MINT_STR = args["usdc-mint"];
const PYTH_RECEIVER_STR = args["pyth-receiver"];
const TICKER = (args.ticker ?? "META").toUpperCase();
const STRIKE_DOLLARS = Number(args["strike-dollars"] ?? 680);
const EXPIRY_HOURS = Number(args["expiry-hours-from-now"] ?? 24);
const PYTH_FEED_ID_HEX = args["pyth-feed-id"] ?? "01".repeat(32);
const FEE_AUTHORITY_STR = args["fee-authority"]; // optional; defaults to admin
// --config-only: run initialize_config and stop, skipping create_strike_market.
// Used by local-dev.sh, where seed-local-markets.mjs creates the full board from
// real oracle prices and a bootstrap market would only add a stray strike.
const CONFIG_ONLY = args["config-only"] === "true";

if (!USDC_MINT_STR) {
  console.error("error: --usdc-mint is required (devnet USDC mint pubkey)");
  process.exit(2);
}
if (!PYTH_RECEIVER_STR) {
  console.error("error: --pyth-receiver is required (Pyth Receiver program ID)");
  process.exit(2);
}

// ─── load IDL + keypair ──────────────────────────────────────────────────

if (!fs.existsSync(IDL_PATH)) {
  console.error(`error: IDL not found at ${IDL_PATH}`);
  console.error("       run 'anchor build' from the repo root first");
  process.exit(2);
}
const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);

// The Anchor TS client (≤0.32.1 at npm publish time) can't resolve
// const-generic types in the IDL — Book uses `BookSide<32>` for its bid/ask
// sides. The BorshCoder reports `Type not found: bids` on Program(). We
// don't decode Book from this script (only initialize_config +
// create_strike_market are called), so strip the entry from both
// `idl.accounts` and `idl.types`. The instruction coder doesn't need them.
const PROBLEMATIC_ACCOUNTS = new Set(["Book"]);
if (Array.isArray(idl.accounts)) {
  idl.accounts = idl.accounts.filter((a) => !PROBLEMATIC_ACCOUNTS.has(a.name));
}
if (Array.isArray(idl.types)) {
  idl.types = idl.types.filter((t) => !PROBLEMATIC_ACCOUNTS.has(t.name));
}

if (!fs.existsSync(KEYPAIR_PATH)) {
  console.error(`error: keypair not found at ${KEYPAIR_PATH}`);
  process.exit(2);
}
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))),
);

const USDC_MINT = new PublicKey(USDC_MINT_STR);
const PYTH_RECEIVER = new PublicKey(PYTH_RECEIVER_STR);
const FEE_AUTHORITY = FEE_AUTHORITY_STR ? new PublicKey(FEE_AUTHORITY_STR) : keypair.publicKey;

// ─── wire up Anchor provider ─────────────────────────────────────────────

const connection = new Connection(RPC_URL, "confirmed");
const wallet = new anchor.Wallet(keypair);
const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: "confirmed",
});
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

// ─── PDA derivations ─────────────────────────────────────────────────────

const enc = (s) => Buffer.from(s, "utf8");

function configPda() {
  return PublicKey.findProgramAddressSync([enc("config")], PROGRAM_ID)[0];
}

function tickerBytes(ticker) {
  const buf = Buffer.alloc(8, 0);
  Buffer.from(ticker, "ascii").copy(buf, 0, 0, Math.min(8, ticker.length));
  return buf;
}

function strikeBytes(microunits) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(microunits), 0);
  return buf;
}

function expiryBytes(unixSeconds) {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(unixSeconds), 0);
  return buf;
}

function marketPda(ticker, strikeMicro, expiryUnix) {
  return PublicKey.findProgramAddressSync(
    [enc("market"), tickerBytes(ticker), strikeBytes(strikeMicro), expiryBytes(expiryUnix)],
    PROGRAM_ID,
  )[0];
}

function bookPda(market) {
  return PublicKey.findProgramAddressSync([enc("book"), market.toBuffer()], PROGRAM_ID)[0];
}

function yesMintPda(market) {
  return PublicKey.findProgramAddressSync([enc("yes_mint"), market.toBuffer()], PROGRAM_ID)[0];
}

function noMintPda(market) {
  return PublicKey.findProgramAddressSync([enc("no_mint"), market.toBuffer()], PROGRAM_ID)[0];
}

function mintAuthorityPda(market) {
  return PublicKey.findProgramAddressSync([enc("mint_auth"), market.toBuffer()], PROGRAM_ID)[0];
}

function usdcEscrowPda(market) {
  return PublicKey.findProgramAddressSync([enc("usdc_escrow"), market.toBuffer()], PROGRAM_ID)[0];
}

function yesEscrowPda(market) {
  return PublicKey.findProgramAddressSync([enc("yes_escrow"), market.toBuffer()], PROGRAM_ID)[0];
}

// ─── account-exists helper ───────────────────────────────────────────────

async function accountExists(pubkey) {
  const info = await connection.getAccountInfo(pubkey);
  return info !== null;
}

// ─── log helper ──────────────────────────────────────────────────────────

const line = "─".repeat(72);
function header(s) {
  console.log(`\n${line}\n  ${s}\n${line}`);
}
function kv(k, v) {
  console.log(`  ${k.padEnd(22)} ${v}`);
}

// ─── main ────────────────────────────────────────────────────────────────

async function main() {
  header("Meridian devnet bootstrap");
  kv("RPC", RPC_URL);
  kv("Program ID", PROGRAM_ID.toBase58());
  kv("Admin / payer", keypair.publicKey.toBase58());
  kv("USDC mint", USDC_MINT.toBase58());
  kv("Pyth Receiver", PYTH_RECEIVER.toBase58());
  kv("Fee authority", FEE_AUTHORITY.toBase58());

  // Payer balance sanity check.
  const balance = await connection.getBalance(keypair.publicKey);
  kv("Payer SOL balance", `${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.5e9) {
    console.warn(
      "  ⚠ payer balance below 0.5 SOL — initialize_config + create_strike_market will likely fail. Run: solana airdrop 5 --url devnet",
    );
  }

  // USDC mint sanity check.
  try {
    const mintInfo = await getSplMint(connection, USDC_MINT, "confirmed", TOKEN_PROGRAM_ID);
    kv("USDC decimals", mintInfo.decimals);
    if (mintInfo.decimals !== 6) {
      console.warn(
        "  ⚠ USDC mint has decimals != 6 — the program assumes 6-decimal microunits. The $1 invariant will silently break if you continue.",
      );
    }
  } catch (e) {
    console.error(`  error: failed to read USDC mint ${USDC_MINT.toBase58()}: ${e.message}`);
    console.error("  is the mint pubkey correct and on this cluster?");
    process.exit(3);
  }

  // ─── 1) initialize_config (idempotent) ────────────────────────────────
  header("1) initialize_config");

  const configAddr = configPda();
  kv("Config PDA", configAddr.toBase58());

  if (await accountExists(configAddr)) {
    console.log("  ✓ Config already initialized — skipping");
  } else {
    console.log("  → Submitting initialize_config…");
    const sig = await program.methods
      .initializeConfig(FEE_AUTHORITY, PYTH_RECEIVER)
      .accounts({
        payer: keypair.publicKey,
        config: configAddr,
        usdcMint: USDC_MINT,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    kv("Signature", sig);
    console.log("  ✓ Config initialized");
  }

  // Read back to confirm.
  const config = await program.account.config.fetch(configAddr);
  kv("admin (on-chain)", config.admin.toBase58());
  kv("pyth_receiver (on-chain)", config.pythReceiver.toBase58());
  kv("usdc_mint (on-chain)", config.usdcMint.toBase58());
  kv("paused", String(config.paused));

  if (!config.admin.equals(keypair.publicKey)) {
    console.warn(
      `  ⚠ admin on-chain (${config.admin.toBase58()}) is not this keypair (${keypair.publicKey.toBase58()}). create_strike_market will fail with Unauthorized.`,
    );
  }

  // ─── 2) create_strike_market (idempotent) ─────────────────────────────
  if (CONFIG_ONLY) {
    header("Summary (config-only)");
    kv("Config", configAddr.toBase58());
    console.log("\n  ✓ Config initialized; skipped create_strike_market (--config-only).\n");
    return;
  }
  header("2) create_strike_market");

  const strikeMicro = Math.round(STRIKE_DOLLARS * 1_000_000);
  const expiryUnix = Math.floor(Date.now() / 1000) + EXPIRY_HOURS * 3600;
  const pythFeedId = Array.from(Buffer.from(PYTH_FEED_ID_HEX, "hex"));
  if (pythFeedId.length !== 32) {
    console.error(`  error: pyth_feed_id must be 32 bytes (64 hex chars), got ${pythFeedId.length}`);
    process.exit(2);
  }

  const market = marketPda(TICKER, strikeMicro, expiryUnix);
  const book = bookPda(market);
  const yesMint = yesMintPda(market);
  const noMint = noMintPda(market);
  const mintAuth = mintAuthorityPda(market);
  const usdcEscrow = usdcEscrowPda(market);
  const yesEscrow = yesEscrowPda(market);

  kv("Ticker", `"${TICKER}"`);
  kv("Strike", `$${STRIKE_DOLLARS} (${strikeMicro} microunits)`);
  kv("Expiry", `${new Date(expiryUnix * 1000).toISOString()} (unix ${expiryUnix})`);
  kv("pyth_feed_id", PYTH_FEED_ID_HEX);
  kv("Market PDA", market.toBase58());

  if (await accountExists(market)) {
    console.log("  ✓ Market already exists — skipping");
  } else {
    console.log("  → Submitting create_strike_market…");
    const sig = await program.methods
      .createStrikeMarket({
        ticker: Array.from(tickerBytes(TICKER)),
        strikePrice: new BN(strikeMicro),
        expiryUnix: new BN(expiryUnix),
        pythFeedId,
      })
      .accounts({
        admin: keypair.publicKey,
        config: configAddr,
        market,
        book,
        yesMint,
        noMint,
        mintAuthority: mintAuth,
        usdcEscrow,
        yesEscrow,
        usdcMint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    kv("Signature", sig);
    console.log("  ✓ Market created");
  }

  // ─── 3) summary ───────────────────────────────────────────────────────
  header("Summary");
  kv("Config", configAddr.toBase58());
  kv("Market", market.toBase58());
  kv("Book", book.toBase58());
  kv("Yes mint", yesMint.toBase58());
  kv("No mint", noMint.toBase58());
  kv("Mint authority PDA", mintAuth.toBase58());
  kv("USDC escrow", usdcEscrow.toBase58());
  kv("Yes escrow", yesEscrow.toBase58());

  // Quick state sanity.
  try {
    const usdcEscrowAcc = await getSplAccount(connection, usdcEscrow, "confirmed", TOKEN_PROGRAM_ID);
    kv("USDC escrow balance", usdcEscrowAcc.amount.toString());
  } catch {
    /* fresh market — fine */
  }
  try {
    const yesMintAcc = await getSplMint(connection, yesMint, "confirmed", TOKEN_PROGRAM_ID);
    kv("Yes supply", yesMintAcc.supply.toString());
  } catch {
    /* fresh market — fine */
  }

  console.log(
    "\nNext: mint_pair / place_limit_order / settle_market / redeem against these accounts.\n",
  );
}

main().catch((e) => {
  console.error("\nbootstrap failed:", e?.message ?? e);
  if (e?.logs) {
    console.error("\nprogram logs:");
    for (const l of e.logs) console.error(`  ${l}`);
  }
  process.exit(1);
});
