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

    /// `admin_settle_market` (the emergency oracle-bypass path) was called
    /// before `expiry + EMERGENCY_GRACE_SECONDS` elapsed. The grace window
    /// gives normal Pyth settlement first claim before the admin can stamp
    /// an outcome by hand.
    #[msg("Admin emergency-settle grace period has not elapsed yet.")]
    EmergencyGraceNotElapsed,

    /// `settle_market` requires `VerificationLevel::Full` (per
    /// `Config.require_full_verification`) but the supplied Pyth update was
    /// only `Partial`-verified.
    #[msg("Oracle price update is not fully verified; refusing to settle.")]
    OracleVerificationInsufficient,

    /// A trading instruction (place/market order, buy_no, sell_no) was called
    /// at or after the market's expiry. Price-discovery trading halts at
    /// expiry; par operations (burn_pair) and exits (cancel_order) stay open.
    #[msg("Market has reached expiry; trading is closed.")]
    MarketExpired,

    /// A maker payout account supplied in `remaining_accounts` is not the
    /// maker's canonical associated token account for the payout mint. The
    /// taker controls the accounts it passes, so we bind payouts to the
    /// canonical ATA: a non-canonical account is a malformed call and reverts
    /// (the taker only harms its own transaction). This closes the
    /// queue-priority griefing vector where a taker could force an honest
    /// maker into the skip path by supplying a deliberately-bad account.
    /// Distinct from the skip path (a *canonical* ATA that is closed/frozen),
    /// which is a recoverable, non-reverting skip.
    #[msg("Maker payout account is not the maker's canonical associated token account.")]
    BadMakerAccount,

    /// `admin_force_expire_order` was called before
    /// `market.settled_at + RECOVERY_GRACE_SECONDS`. The stuck order's owner
    /// must have the full grace window to un-freeze / re-open their canonical
    /// ATA so the normal sweep can pay them before the protocol takes custody.
    #[msg("Recovery grace period has not elapsed; cannot force-expire this order yet.")]
    RecoveryGraceNotElapsed,

    /// `admin_force_expire_order` was called on an order whose owner's canonical
    /// ATA is currently receivable — i.e. the order is NOT stuck and should
    /// drain through the normal `settle_sweep` crank. Guards the admin recovery
    /// power against confiscating a healthy order.
    #[msg("Order is not stuck (canonical ATA is receivable); use settle_sweep instead.")]
    OrderNotStuck,

    /// The destination account supplied to `admin_force_expire_order` is not the
    /// `Config.treasury`'s canonical associated token account for the recovered
    /// collateral's mint.
    #[msg("Recovery destination is not the treasury's canonical associated token account.")]
    InvalidTreasuryAccount,

    /// `admin_force_expire_order` was called while `Config.treasury` still equals
    /// `Config.admin` (its default). Recovering user collateral to the admin's
    /// own account is a self-deal; operators must rotate `set_treasury` to a
    /// dedicated custody account first.
    #[msg("Treasury is not configured (still equals admin); call set_treasury first.")]
    TreasuryNotConfigured,

    /// The treasury's canonical ATA supplied to `admin_force_expire_order` is not
    /// receivable (uninitialized / frozen / not SPL-owned). The admin must
    /// create/unfreeze it before recovery can transfer collateral into it.
    #[msg("Treasury associated token account is not receivable; create or unfreeze it first.")]
    TreasuryAtaNotReceivable,
}
