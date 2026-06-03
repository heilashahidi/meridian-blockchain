/**
 * Solana/Anchor vulnerability lenses. These steer the hypothesize node toward
 * the bug classes that actually drain Anchor programs, rather than generic
 * "is this code good" musing. Each is phrased as something the agent can look
 * for in a specific instruction and then verify with a probe.
 */
export const LENSES: { id: string; prompt: string }[] = [
  {
    id: "missing-signer",
    prompt:
      "Authority/signer checks: an instruction that mutates privileged state but does not require the right Signer, or an admin-only action missing `has_one = admin` / a Signer constraint. Verify by grepping the accounts struct for the expected constraint.",
  },
  {
    id: "account-substitution",
    prompt:
      "Account substitution / owner confusion: an account used without validating its owner program, mint, or PDA derivation, letting an attacker pass a look-alike account. Look for missing `seeds`/`bump`, missing `address =`, or token accounts not tied to the market.",
  },
  {
    id: "pda-canonicalization",
    prompt:
      "PDA seed/bump handling: non-canonical bump accepted, seeds that don't bind (ticker, strike, expiry), or a bump read from input instead of `bump = market.bump`.",
  },
  {
    id: "integer-overflow",
    prompt:
      "Arithmetic safety in payout/fill/escrow math: unchecked add/sub/mul, `wrapping_*`, `as` truncation, or precision loss/rounding that lets value be created or escrow drift from the $1 invariant (usdc_escrow == winning_supply).",
  },
  {
    id: "reinitialization",
    prompt:
      "Reinitialization / double-init: an `init` that can run twice, or config/market state that can be overwritten after creation.",
  },
  {
    id: "cpi-remaining-accounts",
    prompt:
      "CPI and remaining_accounts safety: maker-payout ATAs or settle-sweep accounts not bound to the canonical key, or a fill loop that trusts attacker-supplied accounts.",
  },
  {
    id: "oracle-settlement",
    prompt:
      "Oracle/settlement gating: settle accepting a stale or mismatched Pyth feed, a confidence interval not checked, the expiry gate bypassable, or the admin emergency-settle grace window mis-enforced.",
  },
  {
    id: "state-machine",
    prompt:
      "State-machine / ordering: trading after expiry, redeeming before settle, settle-sweep running out of order, or cancel/redeem double-spending escrow.",
  },
];

export const LENS_BLOCK = LENSES.map((l) => `- ${l.id}: ${l.prompt}`).join("\n");
