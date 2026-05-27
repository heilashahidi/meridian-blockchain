//! `initialize_config` — bootstrap the singleton Config PDA.
//!
//! Per plan §U3:
//!   * Singleton PDA at `[b"config"]`.
//!   * First caller becomes admin (no prior admin to authorize against).
//!   * Idempotent guard via Anchor's `init` constraint — the second call
//!     fails with the standard `AccountAlreadyInitialized` error, which we
//!     surface to clients but map to [`MeridianError::AlreadyInitialized`]
//!     in our own preflight check (Anchor's stock error is
//!     `ConstraintZero`, which is less obvious).

use anchor_lang::prelude::*;

use crate::state::Config;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    /// Fee payer + new admin. The first signer wins: there is no prior
    /// Config to authenticate against, so any caller can take the slot.
    /// Operators deploy this with a controlled keypair at bootstrap.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Singleton Config PDA. `init` enforces idempotency: a second call
    /// fails the address-derivation check inside Anchor's account-init
    /// machinery.
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [Config::SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// USDC mint pinned at bootstrap. Mint validation (decimals, freeze
    /// authority, supply policy) is the operator's responsibility; we
    /// only record the pubkey here.
    pub usdc_mint: Account<'info, anchor_spl::token::Mint>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_config_handler(
    ctx: Context<InitializeConfig>,
    fee_authority: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.bump = ctx.bumps.config;
    config.paused = false;
    config.admin = ctx.accounts.payer.key();
    config.fee_authority = fee_authority;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    Ok(())
}
