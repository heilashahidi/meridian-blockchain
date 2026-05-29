#!/usr/bin/env bash
#
# local-dev.sh — bring up a local Meridian stack for development.
#
# This is the validator + bootstrap half of `make dev` (the Makefile starts the
# `app` dev server afterwards). It mirrors the boot pattern in
# settle-redeem-demo.sh but leaves the validator RUNNING in the background so the
# app can connect to it.
#
# Steps (each idempotent / safe to re-run):
#   1. Stop any solana-test-validator already bound to the local ledger.
#   2. Boot a fresh solana-test-validator in the background (own ledger + logs).
#   3. Airdrop SOL to the local keypair.
#   4. Create a local 6-decimal USDC mint (the keypair becomes its mint
#      authority — required so lifecycle-demo.mjs can mint test USDC).
#   5. Deploy the program and wait until it is invokable.
#   6. Run bootstrap-devnet.mjs against localnet to initialize Config + one
#      strike market.
#   7. Write app/.env.local pointing the frontend at the local validator +
#      program id, so `npm run dev` "just works".
#
# It prints the local USDC mint and key PDAs at the end. The validator keeps
# running after this script exits (so `make dev` can launch the app against it);
# stop it with:  pkill -f solana-test-validator
#
# Usage:  bash scripts/local-dev.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$REPO_ROOT/scripts"
APP="$REPO_ROOT/app"
LOCAL="http://127.0.0.1:8899"
PYTH_RECEIVER="${PYTH_RECEIVER:-rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ}"
LEDGER="${LEDGER:-/tmp/meridian-dev-ledger}"
VALIDATOR_LOG="${VALIDATOR_LOG:-/tmp/meridian-dev-validator.log}"
KEYPAIR="${KEYPAIR:-$HOME/.config/solana/id.json}"
PROGRAM_ID="6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX"
# Pin the gossip + dynamic port range off Solana's defaults (gossip starts at
# 8000). The 8000-range collides with unrelated local services on many dev
# machines (e.g. a Python dev server on :8000), which makes the validator panic
# with "gossip_addr bind_to port 8000: Address already in use". Mirror
# settle-redeem-demo.sh and bind 8010-8040 instead. Override if those clash too.
GOSSIP_PORT="${GOSSIP_PORT:-8010}"
DYNAMIC_PORT_RANGE="${DYNAMIC_PORT_RANGE:-8010-8040}"

bar() { printf '════════ %s ════════\n' "$1"; }

# ─── sanity ────────────────────────────────────────────────────────────────
command -v solana >/dev/null 2>&1 || { echo "error: solana CLI not found"; exit 2; }
command -v solana-test-validator >/dev/null 2>&1 || { echo "error: solana-test-validator not found"; exit 2; }
command -v spl-token >/dev/null 2>&1 || { echo "error: spl-token not found"; exit 2; }
command -v node >/dev/null 2>&1 || { echo "error: node not found"; exit 2; }
[ -f "$KEYPAIR" ] || { echo "error: keypair not found at $KEYPAIR"; exit 2; }
[ -f "$REPO_ROOT/target/deploy/meridian.so" ] || { echo "error: target/deploy/meridian.so missing — run 'anchor build' first"; exit 2; }
[ -f "$REPO_ROOT/target/idl/meridian.json" ] || { echo "error: target/idl/meridian.json missing — run 'anchor build' first"; exit 2; }

# Ensure scripts deps are installed (bootstrap-devnet.mjs needs them).
if [ ! -d "$SCRIPTS/node_modules" ]; then
  bar "installing scripts deps"
  ( cd "$SCRIPTS" && npm install )
fi

# ─── 1+2) (re)boot validator ────────────────────────────────────────────────
bar "boot local validator"
pkill -f "solana-test-validator" 2>/dev/null || true
sleep 1
rm -rf "$LEDGER"
solana-test-validator --reset --quiet \
  --ledger "$LEDGER" \
  --gossip-port "$GOSSIP_PORT" --dynamic-port-range "$DYNAMIC_PORT_RANGE" \
  --rpc-port 8899 >"$VALIDATOR_LOG" 2>&1 &
VALIDATOR_PID=$!
echo "validator pid : $VALIDATOR_PID   (logs: $VALIDATOR_LOG)"
for i in $(seq 1 45); do
  if solana cluster-version --url "$LOCAL" >/dev/null 2>&1; then echo "validator up (~${i}s)"; break; fi
  sleep 1
done
solana cluster-version --url "$LOCAL" >/dev/null 2>&1 || { echo "validator failed to start; see $VALIDATOR_LOG"; tail -20 "$VALIDATOR_LOG"; exit 1; }

# ─── 3) fund ────────────────────────────────────────────────────────────────
bar "airdrop SOL to local keypair"
solana airdrop 100 "$(solana address -k "$KEYPAIR")" --url "$LOCAL" >/dev/null
echo "balance       : $(solana balance "$(solana address -k "$KEYPAIR")" --url "$LOCAL")"

# ─── 4) local USDC mint ─────────────────────────────────────────────────────
bar "create local USDC mint (keypair = mint authority)"
USDC_MINT="$(spl-token create-token --decimals 6 --url "$LOCAL" 2>/dev/null | awk '/Address:/{print $2}')"
if [ -z "$USDC_MINT" ]; then
  echo "error: failed to create local USDC mint (empty address); see $VALIDATOR_LOG"
  exit 1
fi
echo "USDC mint     : $USDC_MINT"

# ─── 5) deploy program ──────────────────────────────────────────────────────
bar "deploy program to localnet"
solana program deploy "$REPO_ROOT/target/deploy/meridian.so" \
  --program-id "$REPO_ROOT/target/deploy/meridian-keypair.json" \
  --url "$LOCAL" >/dev/null
DEPLOYED_ID="$(solana address -k "$REPO_ROOT/target/deploy/meridian-keypair.json")"
for _ in $(seq 1 20); do
  if solana program show "$DEPLOYED_ID" --url "$LOCAL" >/dev/null 2>&1; then break; fi
  sleep 1
done
solana program show "$DEPLOYED_ID" --url "$LOCAL" >/dev/null 2>&1 || { echo "deploy not confirmed"; exit 1; }
echo "program id    : $DEPLOYED_ID"

# ─── 6) bootstrap Config + one market ───────────────────────────────────────
bar "bootstrap Config + strike market"
( cd "$SCRIPTS" && node bootstrap-devnet.mjs \
    --usdc-mint "$USDC_MINT" --pyth-receiver "$PYTH_RECEIVER" \
    --rpc "$LOCAL" )

# ─── 7) write app/.env.local ────────────────────────────────────────────────
bar "write app/.env.local"
cat >"$APP/.env.local" <<ENV
# Auto-generated by scripts/local-dev.sh — points the app at the local validator.
NEXT_PUBLIC_RPC_URL=$LOCAL
NEXT_PUBLIC_PROGRAM_ID=$DEPLOYED_ID
NEXT_PUBLIC_USDC_MINT=$USDC_MINT
ENV
echo "wrote $APP/.env.local"

bar "local stack ready"
echo "validator     : running (pid $VALIDATOR_PID, logs $VALIDATOR_LOG)"
echo "RPC           : $LOCAL"
echo "USDC mint     : $USDC_MINT"
echo ""
echo "Next: the app dev server (make dev launches this for you):"
echo "    cd app && npm run dev"
echo ""
echo "Run the trading lifecycle against this validator:"
echo "    cd scripts && node lifecycle-demo.mjs --rpc $LOCAL"
echo ""
echo "Stop the validator when done:  pkill -f solana-test-validator"
