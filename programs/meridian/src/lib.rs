//! Meridian on-chain CLOB — Anchor program entry.
//!
//! As of U1 this crate is the Anchor program wrapper around the pure-Rust
//! matching engine that landed in U2 (commit `fd50d36`). The matching module
//! continues to live at `programs/meridian/src/matching/` and is intentionally
//! free of Solana / Anchor dependencies so that:
//!
//!   * unit tests still run in milliseconds (no LiteSVM / BPF startup),
//!   * `proptest` invariants can chew through 10K cases per `cargo test`,
//!   * a reviewer reading `programs/meridian/src/matching/` sees the
//!     microstructure-relevant code cleanly, without Anchor wiring noise.
//!
//! The `#[program]` module below is intentionally empty at U1 — instruction
//! handlers land in U3-U7. Pubkeys inside `matching::` are still `[u8; 32]`;
//! Anchor wrappers will pass `pubkey.to_bytes()` into the engine when those
//! instructions are added.

use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod matching;
pub mod state;

// Re-export the matching engine surface so future instruction modules
// (U3-U7) can `use crate::matching::...` or just `use crate::*` cleanly.
pub use matching::{
    book_side::{BookFull, BookSide, OrderEntry, OrderId, OrderNotFound, Side},
    match_step::{match_step, Fill, MatchError, MatchResult, OrderType, TakerOrder},
    order_key::OrderKey,
};

// Anchor's `#[program]` macro expects the generated `__client_accounts_*`
// modules (produced by `#[derive(Accounts)]`) at the crate root via
// `pub use crate::__client_accounts_<ix>::*;`. Re-exporting each
// instruction module's contents (including those generated modules)
// satisfies the macro without polluting the public API with the
// `handler` symbol collision (each module has its own `handler`).
pub use instructions::burn_pair::*;
pub use instructions::create_strike_market::*;
pub use instructions::initialize_config::*;
pub use instructions::mint_pair::*;

// Program keypair generated on first `anchor build`; lives on disk at
// `target/deploy/meridian-keypair.json` (gitignored) and is also reflected in
// the `[programs.*]` tables of `Anchor.toml`. Regenerate per environment if
// promoting to a fresh cluster.
declare_id!("APBHkU44Jtz7CTakjj33XKyDrnAmEoqA7gZ3n1MhYomC");

#[program]
pub mod meridian {
    //! U3 wired `initialize_config` and `create_strike_market`. U4 adds
    //! `mint_pair` and `burn_pair`. U5-U7 add the remaining instructions
    //! (place/market/cancel, buy_no/sell_no, settle/redeem).
    use super::*;

    /// Bootstrap the singleton Config PDA. First caller becomes admin.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        fee_authority: Pubkey,
    ) -> Result<()> {
        instructions::initialize_config::initialize_config_handler(ctx, fee_authority)
    }

    /// Admin-only: create a strike market (Market + Book + Yes/No mints
    /// + USDC/Yes escrows) for a `(ticker, strike, expiry)` triple.
    pub fn create_strike_market(
        ctx: Context<CreateStrikeMarket>,
        args: CreateStrikeMarketArgs,
    ) -> Result<()> {
        instructions::create_strike_market::create_strike_market_handler(ctx, args)
    }

    /// Deposit `amount` USDC into the per-market escrow and mint `amount`
    /// Yes + `amount` No tokens to the caller. Preserves the $1.00
    /// invariant `yes_supply == no_supply == usdc_escrow`.
    pub fn mint_pair(ctx: Context<MintPair>, amount: u64) -> Result<()> {
        instructions::mint_pair::mint_pair_handler(ctx, amount)
    }

    /// Burn `amount` Yes + `amount` No from the caller and return `amount`
    /// USDC from the per-market escrow. The symmetric inverse of `mint_pair`.
    pub fn burn_pair(ctx: Context<BurnPair>, amount: u64) -> Result<()> {
        instructions::burn_pair::burn_pair_handler(ctx, amount)
    }
}
