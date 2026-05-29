# Meridian — one-command setup + devnet lifecycle.
#
# Targets:
#   make dev            Local stack: boot validator + bootstrap config + app dev server.
#   make devnet-deploy  Deploy the program to devnet (preflights wallet balance).
#   make demo           Run create -> mint -> trade lifecycle against a cluster.
#   make build          anchor build (produces target/deploy/meridian.so + IDL).
#   make help           List targets.
#
# Recipe lines are indented with REAL TABS (required by make).

REPO_ROOT := $(shell pwd)
DEVNET_RPC ?= https://api.devnet.solana.com
LOCAL_RPC  ?= http://127.0.0.1:8899

# `make demo` runs against devnet by default (the PRD pass bar). Override the
# cluster with:  make demo DEMO_RPC=http://127.0.0.1:8899   (e.g. after `make dev`)
DEMO_RPC ?= $(DEVNET_RPC)

.DEFAULT_GOAL := help

.PHONY: help dev devnet-deploy demo build

help:
	@echo "Meridian make targets:"
	@echo "  make dev            Boot local validator + bootstrap config, then start the app dev server."
	@echo "  make devnet-deploy  Deploy to devnet (preflights deploy-wallet SOL balance; no partial deploy)."
	@echo "  make demo           Run create -> mint -> trade lifecycle (DEMO_RPC, default devnet)."
	@echo "  make build          anchor build."
	@echo ""
	@echo "Override RPC:  make demo DEMO_RPC=$(LOCAL_RPC)"

build:
	anchor build

# Local one-command setup. scripts/local-dev.sh boots a background validator,
# deploys the program, creates a local USDC mint, bootstraps Config + a market,
# and writes app/.env.local. We then start the Next.js dev server in the
# foreground. The validator keeps running in the background; stop it with
# `pkill -f solana-test-validator`.
dev:
	@bash scripts/local-dev.sh
	@echo ""
	@echo "════════ starting app dev server (Ctrl-C to stop) ════════"
	@echo "The local validator is still running in the background."
	@echo "When you stop the app, also run: pkill -f solana-test-validator"
	@echo ""
	cd app && npm run dev

# Idempotent devnet deploy with a balance preflight. Exits non-zero (no partial
# deploy) if the deploy wallet is underfunded, printing the address to fund.
devnet-deploy:
	@bash scripts/deploy-devnet.sh

# create -> mint -> trade lifecycle. lifecycle-demo.mjs creates a fresh market,
# mints a pair, rests + crosses orders, then burns/cancels — exiting non-zero on
# any step failure. Requires Config already bootstrapped on the target cluster
# (make dev does this for localnet; bootstrap-devnet.mjs for devnet) and the
# Config's USDC mint to be one the keypair can mint (it seeds test USDC).
demo:
	@echo "Running lifecycle demo against $(DEMO_RPC)"
	cd scripts && node lifecycle-demo.mjs --rpc $(DEMO_RPC)
