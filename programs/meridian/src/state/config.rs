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
}

impl Config {
    /// PDA seed for the singleton Config account.
    pub const SEED: &'static [u8] = b"config";
}
