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
pub mod matching;

// Re-export the matching engine surface so future instruction modules
// (U3-U7) can `use crate::matching::...` or just `use crate::*` cleanly.
pub use matching::{
    book_side::{BookFull, BookSide, OrderEntry, OrderId, OrderNotFound, Side},
    match_step::{match_step, Fill, MatchError, MatchResult, OrderType, TakerOrder},
    order_key::OrderKey,
};

// Program keypair generated on first `anchor build`; lives on disk at
// `target/deploy/meridian-keypair.json` (gitignored) and is also reflected in
// the `[programs.*]` tables of `Anchor.toml`. Regenerate per environment if
// promoting to a fresh cluster.
declare_id!("APBHkU44Jtz7CTakjj33XKyDrnAmEoqA7gZ3n1MhYomC");

#[program]
pub mod meridian {
    // Instruction handlers land in U3 (initialize_config, create_strike_market),
    // U4 (mint_pair, burn_pair), U5 (place_limit_order, place_market_order,
    // cancel_order), U6 (buy_no, sell_no), and U7 (settle_market,
    // settle_sweep, redeem). Intentionally empty at U1 — the goal is
    // `anchor build` succeeds and the matching engine is reachable.
    #[allow(unused_imports)]
    use super::*;
}
