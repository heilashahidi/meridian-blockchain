//! Meridian on-chain CLOB — program error codes.
//!
//! Variants are introduced as the corresponding instruction lands; the
//! current set was bootstrapped by U3 (`initialize_config`,
//! `create_strike_market`) and the predeclared errors the planning doc
//! lists for U4-U7 (`mint_pair`, order ops, settlement, redeem).
//!
//! Mapping back to the plan:
//!   * `Unauthorized` — signer-vs-state mismatch (e.g. non-admin calling
//!     admin-only instructions, cancel by non-owner).
//!   * `AlreadyInitialized` — `initialize_config` called twice.
//!   * `ProgramPaused` — `config.paused` set; any user-facing instruction
//!     refuses.
//!   * `InvalidAmount` — zero or out-of-range amount/qty/price.
//!   * `MarketSettled` / `MarketNotSettled` — settle gate flipping order
//!     entry and redeem off respectively.
//!   * `MarketNotExpired` — settle called before `clock.unix_timestamp` >=
//!     `market.expiry_unix`.
//!   * `OracleStale` / `OracleConfidenceTooWide` — Pyth feed checks at
//!     `settle_market` (U7).
//!   * `BookFull` / `OrderNotFound` — surface the matching engine's
//!     intrinsic errors at the Anchor boundary.

use anchor_lang::prelude::*;

#[error_code]
pub enum MeridianError {
    /// Signer is not authorized for this instruction (e.g. non-admin called
    /// an admin-only instruction, or a cancel was attempted by a key
    /// that does not match the resting order's `owner`).
    #[msg("Signer is not authorized for this instruction.")]
    Unauthorized,

    /// `initialize_config` was called more than once. Config is a singleton
    /// PDA and may only be created by the first caller.
    #[msg("Config is already initialized.")]
    AlreadyInitialized,

    /// Global pause flag is set. User-facing instructions refuse until the
    /// admin clears `config.paused`.
    #[msg("Program is paused.")]
    ProgramPaused,

    /// Zero, overflow, or otherwise invalid quantity / price passed in.
    #[msg("Invalid amount or price (must be > 0 and within range).")]
    InvalidAmount,

    /// Market is already settled — order entry refuses.
    #[msg("Market is already settled; orders cannot be placed.")]
    MarketSettled,

    /// Market is not yet settled — `redeem` / `settle_sweep` refuse.
    #[msg("Market is not settled yet.")]
    MarketNotSettled,

    /// `settle_market` was called before the market's expiry timestamp.
    #[msg("Market is not yet expired; cannot settle.")]
    MarketNotExpired,

    /// Pyth price update is older than the configured staleness window.
    #[msg("Oracle price update is too stale.")]
    OracleStale,

    /// Pyth `conf / price` exceeds the configured max-bps threshold.
    #[msg("Oracle confidence interval is too wide.")]
    OracleConfidenceTooWide,

    /// `BookSide` is at capacity; no more orders can rest on this side.
    #[msg("Order book side is full.")]
    BookFull,

    /// `cancel_order` could not find the given order id on the book.
    #[msg("Order not found on the book.")]
    OrderNotFound,
}
