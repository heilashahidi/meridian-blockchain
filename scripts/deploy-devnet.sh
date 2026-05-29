#!/usr/bin/env bash
#
# deploy-devnet.sh — deploy the Meridian program to Solana devnet, idempotently.
#
# This is the `make devnet-deploy` entry point. It is a thin, safe wrapper around
# `anchor deploy --provider.cluster devnet`:
#
#   1. PREFLIGHT: check the deploy wallet's devnet SOL balance. A fresh program
#      deploy of meridian.so costs several SOL of rent-exempt buffer. If the
#      wallet is under MIN_SOL, exit non-zero WITHOUT touching the cluster and
#      print the exact wallet address to fund and the shortfall — never a partial
#      deploy.
#   2. Ensure the program is built (target/deploy/meridian.so + IDL exist).
#   3. `anchor deploy --provider.cluster devnet`. Anchor is idempotent: a program
#      already deployed at the same program id is upgraded in place, not
#      re-created.
#   4. Poll `solana program show` until the loader marks the program invokable.
#
# The deploy wallet is the default Anchor wallet from Anchor.toml
# ([provider] wallet = "~/.config/solana/id.json"). Override with KEYPAIR=...
#
# Usage:  bash scripts/deploy-devnet.sh
#         KEYPAIR=/path/to/id.json bash scripts/deploy-devnet.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVNET_RPC="${DEVNET_RPC:-https://api.devnet.solana.com}"
KEYPAIR="${KEYPAIR:-$HOME/.config/solana/id.json}"

# Minimum devnet SOL to attempt a fresh program deploy. meridian.so is large
# enough that the rent-exempt program buffer + deploy fees run several SOL; we
# require a comfortable cushion so the deploy never half-completes.
MIN_SOL="${MIN_SOL:-8}"

# Known admin / deploy wallet for this project (sanity reference in messages).
EXPECTED_WALLET="7sYcxc2hbcHuiVWGE9ZR1gM52Sm24Rdp15aED3DdjaYA"

bar() { printf '════════ %s ════════\n' "$1"; }

# ─── 0) sanity: tools + artifacts ──────────────────────────────────────────
command -v solana >/dev/null 2>&1 || { echo "error: solana CLI not found on PATH"; exit 2; }
command -v anchor >/dev/null 2>&1 || { echo "error: anchor CLI not found on PATH"; exit 2; }

if [ ! -f "$KEYPAIR" ]; then
  echo "error: deploy keypair not found at $KEYPAIR"
  echo "       set KEYPAIR=/path/to/id.json or create ~/.config/solana/id.json"
  exit 2
fi

SO="$REPO_ROOT/target/deploy/meridian.so"
if [ ! -f "$SO" ]; then
  echo "error: $SO not found — run 'anchor build' from the repo root first"
  exit 2
fi

WALLET_ADDR="$(solana address -k "$KEYPAIR")"

# ─── 1) preflight balance check ─────────────────────────────────────────────
bar "preflight: devnet balance"
echo "deploy wallet : $WALLET_ADDR"
echo "cluster       : $DEVNET_RPC"
if [ "$WALLET_ADDR" != "$EXPECTED_WALLET" ]; then
  echo "note          : wallet differs from the project's known admin wallet"
  echo "                ($EXPECTED_WALLET) — proceeding with $WALLET_ADDR."
fi

# `solana balance` prints e.g. "3.5 SOL"; take the leading number.
BALANCE_RAW="$(solana balance "$WALLET_ADDR" --url "$DEVNET_RPC" 2>/dev/null || true)"
BALANCE_SOL="$(printf '%s' "$BALANCE_RAW" | awk '{print $1+0}')"
echo "balance       : ${BALANCE_SOL:-0} SOL  (need >= ${MIN_SOL} SOL)"

# Float comparison via awk (bash can't do non-integer math).
if awk "BEGIN{exit !(${BALANCE_SOL:-0} < ${MIN_SOL})}"; then
  SHORT="$(awk "BEGIN{printf \"%.4f\", ${MIN_SOL} - ${BALANCE_SOL:-0}}")"
  echo ""
  echo "✗ insufficient devnet SOL — NOT deploying (no partial deploy)."
  echo ""
  echo "  Fund this wallet with at least ${SHORT} more SOL:"
  echo ""
  echo "      $WALLET_ADDR"
  echo ""
  echo "  Options:"
  echo "    solana airdrop 2 $WALLET_ADDR --url devnet   # repeat; faucet-rate-limited"
  echo "    # or the web faucet: https://faucet.solana.com  (paste the address above)"
  echo "    # or transfer from another funded devnet wallet"
  echo ""
  echo "  Then re-run: make devnet-deploy"
  exit 1
fi

# ─── 2) deploy (idempotent upgrade-in-place) ────────────────────────────────
bar "anchor deploy --provider.cluster devnet"
( cd "$REPO_ROOT" && anchor deploy --provider.cluster devnet )

# ─── 3) confirm invokable ───────────────────────────────────────────────────
bar "confirm program is invokable"
PROGRAM_ID="$(solana address -k "$REPO_ROOT/target/deploy/meridian-keypair.json")"
echo "program id    : $PROGRAM_ID"
for _ in $(seq 1 20); do
  if solana program show "$PROGRAM_ID" --url "$DEVNET_RPC" >/dev/null 2>&1; then
    solana program show "$PROGRAM_ID" --url "$DEVNET_RPC"
    echo ""
    echo "✓ deployed and invokable on devnet."
    echo "  Next: bootstrap Config + a market, then 'make demo'."
    exit 0
  fi
  sleep 1
done
echo "✗ program not confirmed invokable after deploy; check 'solana program show $PROGRAM_ID --url devnet'"
exit 1
