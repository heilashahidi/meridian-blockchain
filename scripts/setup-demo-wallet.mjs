#!/usr/bin/env node
//
// setup-demo-wallet.mjs — mint a fresh, position-free demo wallet on devnet.
//
// Generates a new keypair, funds it with SOL (fees + ATA rent) and test USDC
// (the admin is the USDC mint authority), and prints the base58 private key to
// import into Phantom. A brand-new wallet holds no Yes/No anywhere, so every
// strike shows BOTH "Buy Yes" and "Buy No" available from the start.
//
// Usage:  node setup-demo-wallet.mjs [--usdc 2000] [--sol 0.5] [--rpc <url>]

import fs from "node:fs";
import os from "node:os";
import process from "node:process";

import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const RPC = arg("rpc", "https://devnet.helius-rpc.com/?api-key=a04787cb-46b9-4bf8-977f-b21ea52a596c");
const USDC = Number(arg("usdc", "2000")); // whole USDC
const SOL = Number(arg("sol", "0.5"));
const PID = new PublicKey("6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX");

const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"))),
);
const c = new Connection(RPC, "confirmed");

// usdc_mint lives in the Config PDA at offset 74:
// 8 disc + 1 bump + 1 paused + 32 admin + 32 fee_authority = 74, then 32 bytes.
const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PID)[0];
const cfg = await c.getAccountInfo(configPda);
const usdcMint = new PublicKey(cfg.data.subarray(74, 74 + 32));

const w = Keypair.generate();

await sendAndConfirmTransaction(
  c,
  new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: w.publicKey,
      lamports: Math.round(SOL * 1e9),
    }),
  ),
  [admin],
  { commitment: "confirmed" },
);

const ata = (await getOrCreateAssociatedTokenAccount(c, admin, usdcMint, w.publicKey)).address;
await mintTo(c, admin, usdcMint, ata, admin, BigInt(USDC) * 1_000_000n);

console.log("\n=== Fresh demo wallet (Solana devnet) ===");
console.log("Address :", w.publicKey.toBase58());
console.log("Funded  :", `${SOL} SOL + ${USDC} test USDC`);
console.log("USDC mint:", usdcMint.toBase58());
console.log("\n--- Phantom: Add/Connect Wallet → Import Private Key → paste this ---\n");
console.log(bs58.encode(w.secretKey));
console.log("\n(Solana CLI keypair JSON, if you prefer a file:)");
console.log(JSON.stringify(Array.from(w.secretKey)));
console.log(
  "\nClean on every strike → Buy Yes and Buy No are both available. Switch Phantom to Devnet.\n",
);
