//! Admin controls (P1).
//!
//! [`set_paused`] toggles the global `config.paused` kill switch that every
//! user-facing instruction already checks (`mint_pair`, `burn_pair`,
//! `place_limit_order`, `place_market_order`, `cancel_order`, `buy_no`,
//! `sell_no`, `redeem`, `settle_sweep`, `create_strike_market`). Before this
//! existed the flag was set only at `initialize_config` (always `false`) and
//! could never be flipped — the pause path was dead. A single
//! `set_paused(bool)` covers both pause and unpause; admin-only via the
//! `has_one = admin` check against the singleton Config.

use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::Config;

#[derive(Accounts)]
pub struct SetPaused<'info> {
    /// Admin authority. Must equal `config.admin`.
    pub admin: Signer<'info>,

    /// Singleton Config. Seeds + bump pin it to the canonical PDA; the
    /// `has_one` ties the signer to the recorded admin.
    #[account(
        mut,
        seeds = [Config::SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
}

pub fn set_paused_handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    msg!("set_paused: paused={}", paused);
    Ok(())
}
