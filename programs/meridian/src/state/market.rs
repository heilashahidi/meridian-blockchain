//! Per-strike `Market` account.
//!
//! Per plan §U3, with the **`expiry_unix` rename**: the plan text says
//! `expiry_slot: u64`, but Pyth's `get_price_no_older_than` and
//! `Clock::unix_timestamp` are both unix-seconds (`i64`), and U7's settle
//! logic compares the two — so this struct stores the expiry as `i64`
//! unix seconds. The PDA seed encodes the same value via `i64::to_le_bytes`
//! to keep `(ticker, strike, expiry)` collision-free.
//!
//! Per plan §U3 PDA shape:
//! ```text
//! [b"market", ticker.as_ref(), strike.to_le_bytes().as_ref(), expiry.to_le_bytes().as_ref()]
//! ```
//!
//! [`Market`] is **not** zero-copy; it is small (under 200 bytes) and uses
//! standard Borsh serialization. Only [`crate::state::Book`] needs the
//! zero-copy treatment because of book depth.

use anchor_lang::prelude::*;

/// Binary outcome of a settled market.
///
/// Stored as `Option<Outcome>` on [`Market`] so the pre-settle state is
/// unambiguous (`None`). Borsh-serializable for normal-account use.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq, InitSpace)]
pub enum Outcome {
    /// Underlying settled at or above the strike — Yes-token holders win.
    YesWins,
    /// Underlying settled below the strike — No-token holders win.
    NoWins,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    /// PDA bump for the seed `[b"market", ticker, strike_le, expiry_le]`.
    pub bump: u8,
    /// Bump for the Yes/No mint authority PDA at
    /// `[b"mint_auth", market.key().as_ref()]`. Cached so the mint-path
    /// instructions (`mint_pair`, redeem) can sign without recomputing.
    pub mint_authority_bump: u8,
    /// `true` once `settle_market` has recorded an outcome.
    pub settled: bool,
    /// 8-byte right-padded ASCII ticker (e.g. `b"META\0\0\0\0"`). Fixed
    /// width so the PDA seed is stable.
    pub ticker: [u8; 8],
    /// Strike price in USDC microunits (USDC has 6 decimals; $680.00 →
    /// 680_000_000). Pyth feeds are normalized to the same unit at
    /// settle time.
    pub strike_price: u64,
    /// Expiry as a unix timestamp (seconds since epoch). The plan called
    /// this `expiry_slot`; renamed to `expiry_unix` because Pyth +
    /// `Clock::unix_timestamp` work in unix seconds, not Solana slots.
    pub expiry_unix: i64,
    /// Yes-token mint pubkey. Owned by the mint-authority PDA above.
    pub yes_mint: Pubkey,
    /// No-token mint pubkey. Owned by the mint-authority PDA above.
    pub no_mint: Pubkey,
    /// Cursor into the open-order list for the iterative settle sweep
    /// (R15b). Resumable across multiple `settle_sweep` calls so a market
    /// with more open orders than fit in a single transaction's CU budget
    /// can still be drained.
    pub sweep_cursor: u32,
    /// Settled outcome, populated by `settle_market`. `None` until then.
    pub outcome: Option<Outcome>,
    /// Pyth `PriceUpdateV2` feed id (32-byte) for the underlying.
    /// Pinned at market creation so settle can verify it.
    pub pyth_feed_id: [u8; 32],
    /// Unix timestamp (seconds) at which the market was settled, stamped by
    /// `settle_market` / `admin_settle_market`. `0` while unsettled. Used as
    /// the precise base for the post-settlement recovery grace window in
    /// `admin_force_expire_order` (a stuck order can only be force-expired
    /// after `settled_at + RECOVERY_GRACE_SECONDS`).
    pub settled_at: i64,
}

impl Market {
    /// Seed prefix for the Market PDA.
    pub const SEED_PREFIX: &'static [u8] = b"market";

    /// Seed prefix for the mint-authority PDA derived per market.
    pub const MINT_AUTH_SEED_PREFIX: &'static [u8] = b"mint_auth";

    /// Seed prefix for the per-market USDC escrow token account PDA.
    pub const USDC_ESCROW_SEED_PREFIX: &'static [u8] = b"usdc_escrow";

    /// Seed prefix for the per-market Yes-token escrow token account PDA.
    pub const YES_ESCROW_SEED_PREFIX: &'static [u8] = b"yes_escrow";

    /// Seed prefix for the per-market Yes mint PDA. Used by every
    /// `seeds = [Market::YES_MINT_SEED_PREFIX, market.key().as_ref()]`
    /// account constraint across instructions.
    pub const YES_MINT_SEED_PREFIX: &'static [u8] = b"yes_mint";

    /// Seed prefix for the per-market No mint PDA. Mirror of
    /// [`Self::YES_MINT_SEED_PREFIX`].
    pub const NO_MINT_SEED_PREFIX: &'static [u8] = b"no_mint";
}
