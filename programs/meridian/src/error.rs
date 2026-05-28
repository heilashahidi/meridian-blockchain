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

    /// Pyth `PriceUpdateV2` account's `feed_id` does not match the market's
    /// pinned `pyth_feed_id`.
    #[msg("Oracle account feed id does not match the market's pinned feed id.")]
    OracleFeedIdMismatch,

    /// Caller passed the losing-side token to `redeem`. The instruction
    /// only accepts the side that matches `market.outcome`.
    #[msg("Redeem called with the losing side; only the winning token is redeemable.")]
    WrongRedeemSide,

    /// `redeem` was called with the wrong mint pubkey for the winning side
    /// (e.g. user passed the No mint when YesWins). Validated against
    /// `market.{yes,no}_mint` based on the recorded outcome.
    #[msg("Redeem-side mint does not match the market's recorded outcome.")]
    WrongRedeemMint,

    /// Pyth price was non-positive (`<= 0`). For binary options on equity
    /// underlyings this is degenerate — refuse to settle.
    #[msg("Oracle returned a non-positive price; refusing to settle.")]
    InvalidOraclePrice,

    /// `buy_no` / `sell_no` could not fully fill the requested amount within
    /// the supplied slippage bound. The composed instruction reverts
    /// atomically; clients can retry with a wider bound or a smaller amount.
    /// Distinct from [`InvalidAmount`] so frontends can tell "market moved"
    /// from "you passed a malformed input."
    #[msg("Order could not fully fill within slippage bound; revise and retry.")]
    SlippageNotMet,

    /// A program-internal invariant broke (e.g. matching engine returned a
    /// fill at a price worse than the taker limit, or `residual_qty > qty`).
    /// Should never fire in correctly-functioning code; surfaced loudly
    /// instead of being absorbed by `saturating_*` so regressions are
    /// caught at the call site rather than masked.
    #[msg("Internal invariant violated. This is a bug — please report.")]
    InvariantBroken,

    /// `settle_market`'s `price_update` account is not owned by the
    /// operator-pinned `Config.pyth_receiver` program. Distinct from
    /// `OracleStale` / `OracleConfidenceTooWide` so the off-chain caller
    /// can distinguish "wrong account passed" from "Pyth said no."
    #[msg("Oracle account is not owned by the operator-pinned Pyth receiver program.")]
    InvalidOracleOwner,
}
