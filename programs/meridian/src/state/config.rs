//! Global `Config` singleton account.
//!
//! Per plan §U3:
//!   * Singleton PDA seeded by `[b"config"]`.
//!   * Created idempotently by [`initialize_config`]; first caller becomes
//!     `admin` (no prior config exists, so there is no admin to check
//!     against).
//!   * Holds the admin authority, USDC mint, fee authority, and a global
//!     pause flag (`paused`).
//!
//! [`initialize_config`]: crate::instructions::initialize_config

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// PDA bump for `[b"config"]`.
    pub bump: u8,
    /// Global pause flag — user-facing instructions refuse when set.
    pub paused: bool,
    /// Admin authority — currently the only privileged role
    /// (`create_strike_market`, `pause`/`unpause`, settle override).
    pub admin: Pubkey,
    /// Fee authority — receives any fee accruals once fees are wired
    /// (deferred to follow-up work; field exists for forward compatibility).
    pub fee_authority: Pubkey,
    /// USDC mint used for all collateral on this deployment. Pinned at
    /// `initialize_config` time; markets reference it indirectly via the
    /// program's escrow PDAs.
    pub usdc_mint: Pubkey,
    /// Pyth Receiver program ID — the expected owner for every
    /// `PriceUpdateV2` account `settle_market` accepts. Operator sets this
    /// at `initialize_config` time:
    ///
    ///   * Devnet / mainnet: Pyth's on-chain Receiver program
    ///     (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` as of 2026).
    ///   * LiteSVM / test fixtures: this program's own ID
    ///     (`MERIDIAN_PROGRAM_ID`), because test code mints owner-meridian
    ///     accounts via `set_account`.
    ///
    /// Pinning this in Config (rather than hardcoding the Pyth Receiver
    /// pubkey in code) lets the same `.so` work in both environments
    /// without a feature flag.
    pub pyth_receiver: Pubkey,

    /// When `true`, `settle_market` requires the Pyth price update to carry
    /// `VerificationLevel::Full` (two-thirds of the Wormhole guardian set
    /// signed). Secure-by-default: `initialize_config` sets this `true`, so a
    /// fresh deployment is mainnet-correct without anyone flipping a switch.
    /// An operator can relax it (e.g. on devnet where only `Partial` updates
    /// are posted) via `set_require_full_verification`.
    pub require_full_verification: bool,
}

impl Config {
    /// PDA seed for the singleton Config account.
    pub const SEED: &'static [u8] = b"config";
}
