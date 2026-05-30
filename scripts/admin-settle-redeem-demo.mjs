#!/usr/bin/env node
//
// admin-settle-redeem-demo.mjs — drive admin_settle_market (the emergency
// oracle-bypass settle) + redeem against any live cluster, no oracle account
// needed. This demonstrates settle → redeem on devnet OUTSIDE US market hours,
// when Pyth's MAG7 equity feeds are stale and the normal oracle settle can't run
// (see ARCHITECTURE.md §4). The real-oracle path is post-pyth-update.mjs /
// settle-redeem-demo.mjs (RTH only).
//
// admin_settle_market(yes_wins) requires the market to be past
// `expiry + EMERGENCY_GRACE_SECONDS` (24h), so normal settlement always gets
// first claim during the day. create_strike_market does NOT clock-check expiry,
// so we create a market whose expiry is already >24h in the past — the override
// becomes immediately callable, the outcome is stamped by hand, and redeem works
// exactly as after a normal settle.
//
// Steps:
//   1. Create a market with expiry = now − 25h (past the 24h emergency grace).
//   2. mint_pair so USDC sits in escrow and the user holds Yes + No.
//   3. admin_settle_market(yes_wins) → market.outcome stamped (no oracle).
//   4. redeem the winning side 1:1 for USDC from escrow.
//
// Usage:
//   node admin-settle-redeem-demo.mjs --usdc-mint <m>
//        [--rpc ...] [--keypair ...] [--strike-dollars 680] [--ticker ADMN]
//        [--yes-wins true]

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

// 24h emergency grace (mirrors admin.rs EMERGENCY_GRACE_SECONDS) plus a 1h
// cushion so the override is comfortably callable the moment the market exists.
const EMERGENCY_GRACE_SECONDS = 86_400;
const EXPIRY_BACKDATE_SECONDS = EMERGENCY_GRACE_SECONDS + 3_600;

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
const STRIKE_DOLLARS = Number(args["strike-dollars"] ?? 680);
const TICKER = (args.ticker ?? "ADMN").toUpperCase();
const YES_WINS = String(args["yes-wins"] ?? "true") !== "false";

if (!USDC_MINT_STR) {
  console.error("error: --usdc-mint is required (a mint the keypair can mint)");
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
  header("Meridian admin-override settle + redeem demo (no oracle)");
  kv("RPC", RPC_URL);
  kv("Program ID", PROGRAM_ID.toBase58());

  const config = configPda();
  const cfg = await program.account.config.fetch(config);
  kv("Config", config.toBase58());
  kv("admin (config)", cfg.admin.toBase58());
  if (!cfg.admin.equals(payer.publicKey)) {
    console.error("error: keypair is not config.admin — admin_settle_market will revert Unauthorized");
    process.exit(3);
  }

  // ─── 1) back-dated market (past the 24h emergency grace) ────────────────
  header("1) create market (expiry 25h in the past → override callable now)");
  const strikeMicro = Math.round(STRIKE_DOLLARS * 1_000_000);
  const expiryUnix = Math.floor(Date.now() / 1000) - EXPIRY_BACKDATE_SECONDS;
  const market = marketPda(TICKER, strikeMicro, expiryUnix);
  const P = subPdas(market);
  // Feed id is irrelevant for the override path (no oracle is read).
  const pythFeedId = Array.from(Buffer.from("01".repeat(32), "hex"));
  kv("Ticker / strike", `${TICKER} / $${STRIKE_DOLLARS}`);
  kv("Market PDA", market.toBase58());
  kv("Expiry", `${new Date(expiryUnix * 1000).toISOString()} (now − 25h)`);
  kv("Override unlock", `expiry + 24h = ${new Date((expiryUnix + EMERGENCY_GRACE_SECONDS) * 1000).toISOString()} (elapsed ✓)`);

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

  // ─── 2) mint_pair (fund escrow + hold both sides) ──────────────────────
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

  // ─── 3) admin_settle_market (oracle bypass) ────────────────────────────
  header(`3) admin_settle_market(yes_wins=${YES_WINS}) — stamp outcome by hand`);
  let m = await program.account.market.fetch(market);
  kv("settled (pre)", String(m.settled));
  await program.methods
    .adminSettleMarket(YES_WINS)
    .accounts({ admin: payer.publicKey, config, market })
    .rpc();
  m = await program.account.market.fetch(market);
  const outcome = m.outcome ? Object.keys(m.outcome)[0] : "none";
  kv("settled (post)", String(m.settled));
  kv("outcome", outcome);

  // ─── 4) redeem the winning side ────────────────────────────────────────
  const winningMint = YES_WINS ? P.yesMint : P.noMint;
  const userWinning = YES_WINS ? userYes : userNo;
  const sideName = YES_WINS ? "Yes" : "No";
  header(`4) redeem — burn 1000 ${sideName} (winner) for 1000 USDC from escrow`);
  const usdcPre = await bal(userUsdc);
  await program.methods
    .redeem(new BN(1000))
    .accounts({
      user: payer.publicKey,
      config,
      market,
      winningMint,
      userWinning,
      userUsdc,
      usdcEscrow: P.usdcEscrow,
      mintAuthority: P.mintAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  kv(`user ${sideName} (post)`, (await bal(userWinning)).toString());
  kv("user USDC gained", ((await bal(userUsdc)) - usdcPre).toString() + "  (= 1000, 1:1 payout)");
  kv("USDC escrow (post)", (await bal(P.usdcEscrow)).toString());

  header("Summary — admin-override settle + redeem complete (devnet, no oracle)");
  kv("admin_settle_market", `✓ outcome=${outcome}`);
  kv("redeem", `✓ 1000 ${sideName} → 1000 USDC`);
  console.log("");
}

main().catch((e) => {
  console.error("\nadmin settle/redeem demo failed:", e?.message ?? e);
  if (e?.logs) {
    console.error("\nprogram logs:");
    for (const l of e.logs) console.error(`  ${l}`);
  }
  process.exit(1);
});
