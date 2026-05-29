import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * Instructions to create any of `mints`' canonical ATAs for `owner` that don't
 * exist yet. The Meridian program does not `init` user ATAs (mint_pair /
 * place_limit_order expect them to exist), so the UI creates them inline as
 * `preInstructions`. `payer` funds rent.
 */
export async function ensureAtaIxs(
  connection: Connection,
  owner: PublicKey,
  payer: PublicKey,
  mints: PublicKey[],
): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [];
  const atas = mints.map((m) => ({
    mint: m,
    ata: getAssociatedTokenAddressSync(m, owner),
  }));
  const infos = await connection.getMultipleAccountsInfo(
    atas.map((a) => a.ata),
  );
  atas.forEach(({ mint, ata }, i) => {
    if (infos[i] === null) {
      ixs.push(
        createAssociatedTokenAccountInstruction(payer, ata, owner, mint),
      );
    }
  });
  return ixs;
}

/** Pull a human-readable message out of an Anchor / web3 transaction error. */
export function formatError(e: unknown): string {
  if (typeof e === "string") return e;
  const any = e as {
    error?: { errorMessage?: string };
    message?: string;
    logs?: string[];
  };
  if (any?.error?.errorMessage) return any.error.errorMessage;
  // Anchor program error embedded in logs
  const logLine = any?.logs?.find((l) => l.includes("Error Message:"));
  if (logLine) {
    return logLine.slice(logLine.indexOf("Error Message:") + 14).trim();
  }
  if (any?.message) return any.message;
  return "Transaction failed";
}
