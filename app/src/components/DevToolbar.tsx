"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";

import { useMeridian } from "@/lib/MeridianContext";
import { isLocalRpc } from "@/lib/program";
import { ensureAtaIxs } from "@/lib/tx";
import { useTx } from "@/lib/useTx";

const MINT_AMOUNT = 10_000_000n; // test USDC base units

export function DevToolbar() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { config } = useMeridian();
  const { busy, error, status, run } = useTx();

  // Local-only: hidden on devnet/mainnet so it can't mislead.
  if (!isLocalRpc) return null;

  const ready = !!publicKey;

  async function airdrop() {
    await run(async () => {
      const sig = await connection.requestAirdrop(
        publicKey!,
        2 * LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(sig, "confirmed");
      return "Airdropped 2 SOL";
    });
  }

  async function mintUsdc() {
    if (!config) return;
    await run(async () => {
      const user = publicKey!;
      const usdcMint = config.usdcMint;
      const ata = getAssociatedTokenAddressSync(usdcMint, user);
      const ixs = await ensureAtaIxs(connection, user, user, [usdcMint]);
      // Authority is the connected wallet — only works if it is the USDC mint
      // authority (i.e. you imported the validator's id.json keypair).
      ixs.push(createMintToInstruction(usdcMint, ata, user, MINT_AMOUNT));
      const tx = new Transaction().add(...ixs);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      return `Minted ${MINT_AMOUNT.toString()} test USDC`;
    });
  }

  return (
    <div
      className="panel"
      style={{ borderColor: "var(--accent)", marginBottom: 16 }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span className="muted" style={{ fontSize: 12 }}>
          🛠 local dev
        </span>
        <button className="btn" disabled={!ready || busy} onClick={airdrop}>
          Airdrop 2 SOL
        </button>
        <button
          className="btn"
          disabled={!ready || !config || busy}
          onClick={mintUsdc}
        >
          Mint test USDC
        </button>
        {status && <span style={{ color: "var(--bid)" }}>{status}</span>}
        {error && <span style={{ color: "var(--ask)" }}>{error}</span>}
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Mint USDC needs the connected wallet to be the mint authority — import
        the validator&apos;s <span className="mono">id.json</span> into your
        wallet for local testing (see app/README.md).
      </div>
    </div>
  );
}
