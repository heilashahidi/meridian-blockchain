#!/usr/bin/env bash
#
# settle-redeem-demo.sh — end-to-end settle_market + redeem on a vanilla
# localnet, by injecting a forged Pyth PriceUpdateV2 account at genesis.
#
# Vanilla localnet has no Pyth Receiver program, so settle_market (which checks
# the price-update account's owner == config.pyth_receiver and deserializes a
# PriceUpdateV2) can't run against a real feed. We fake it: forge a byte-exact
# PriceUpdateV2 with an arbitrary owner and load it via
# `solana-test-validator --account`. The whole pipeline runs in one shot so we
# finish inside the program's 60s oracle-freshness window (the forged
# publish_time is "now"; create_strike_market doesn't clock-check expiry, so the
# market is created already-expired and we settle immediately — no waiting).
#
# This boots a DEDICATED validator (its own ledger + ports) and tears it down at
# the end. It does not touch any other running validator's ledger, but it does
# need the localnet ports free.
#
# Usage:  bash scripts/settle-redeem-demo.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$REPO_ROOT/scripts"
LOCAL="http://127.0.0.1:8899"
PYTH_RECEIVER="rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
LEDGER="/tmp/meridian-settle-ledger"
ORACLE_FIXTURE="/tmp/meridian-pyth-oracle.json"
ORACLE_KEYPAIR="/tmp/meridian-pyth-oracle-keypair.json"
VALIDATOR_LOG="/tmp/meridian-settle-validator.log"
KEYPAIR="${KEYPAIR:-$HOME/.config/solana/id.json}"

cleanup() { pkill -f "solana-test-validator.*$LEDGER" 2>/dev/null || true; }
trap cleanup EXIT

echo "════════ 0) stop any running validator + forge oracle ════════"
pkill -f solana-test-validator 2>/dev/null || true
sleep 1
rm -f "$ORACLE_KEYPAIR" # fresh oracle address each run
# Forge with price $700 vs strike $680 -> YesWins. publish_time defaults to now.
ORACLE="$(node "$SCRIPTS/forge-pyth-account.mjs" \
  --owner "$PYTH_RECEIVER" --dollars 700 --expo -8 \
  --feed-id "$(printf '01%.0s' {1..32})" \
  --out "$ORACLE_FIXTURE" --keypair-out "$ORACLE_KEYPAIR")"
echo "oracle address: $ORACLE"

echo "════════ 1) boot dedicated validator with injected oracle ════════"
rm -rf "$LEDGER"
solana-test-validator --reset --quiet \
  --ledger "$LEDGER" \
  --gossip-port 8010 --dynamic-port-range 8010-8040 --rpc-port 8899 \
  --account "$ORACLE" "$ORACLE_FIXTURE" >"$VALIDATOR_LOG" 2>&1 &
for i in $(seq 1 45); do
  if solana cluster-version --url "$LOCAL" >/dev/null 2>&1; then echo "validator up (~${i}s)"; break; fi
  sleep 1
done
solana cluster-version --url "$LOCAL" >/dev/null 2>&1 || { echo "validator failed to start; see $VALIDATOR_LOG"; tail -20 "$VALIDATOR_LOG"; exit 1; }

echo "════════ 2) fund + recreate USDC mint + deploy program ════════"
solana airdrop 100 "$(solana address -k "$KEYPAIR")" --url "$LOCAL" >/dev/null
USDC_MINT="$(spl-token create-token --decimals 6 --url "$LOCAL" 2>/dev/null | awk '/Address:/{print $2}')"
echo "USDC mint: $USDC_MINT"
PROGRAM_ID="$(solana address -k "$REPO_ROOT/target/deploy/meridian-keypair.json")"
solana program deploy "$REPO_ROOT/target/deploy/meridian.so" \
  --program-id "$REPO_ROOT/target/deploy/meridian-keypair.json" \
  --url "$LOCAL" >/dev/null
# `solana program deploy` returns before the loader marks the program
# invokable; poll until `program show` confirms it, else the first ix fails
# with "Program is not deployed".
for i in $(seq 1 20); do
  if solana program show "$PROGRAM_ID" --url "$LOCAL" >/dev/null 2>&1; then break; fi
  sleep 1
done
solana program show "$PROGRAM_ID" --url "$LOCAL" >/dev/null 2>&1 || { echo "deploy not confirmed"; exit 1; }
echo "program deployed + confirmed"

echo "════════ 3) initialize config (pyth_receiver = oracle owner) ════════"
( cd "$SCRIPTS" && node bootstrap-devnet.mjs \
    --usdc-mint "$USDC_MINT" --pyth-receiver "$PYTH_RECEIVER" \
    --rpc "$LOCAL" >/dev/null )
echo "config initialized"

echo "════════ 4) settle + redeem ════════"
cd "$SCRIPTS" && node settle-redeem-demo.mjs \
  --usdc-mint "$USDC_MINT" --oracle "$ORACLE" \
  --feed-id "$(printf '01%.0s' {1..32})" --rpc "$LOCAL"

echo ""
echo "✓ done — dedicated validator will be stopped on exit."
