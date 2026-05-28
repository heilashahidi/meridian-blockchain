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
use crate::state::{Config, Market, Outcome};

/// How long after a market's expiry the admin emergency-settle path unlocks,
/// in seconds (24h). Normal permissionless Pyth settlement has the whole
/// window first; only if it never lands (oracle outage) does the admin get to
/// stamp an outcome by hand. Solvent by the $1 invariant either way:
/// `usdc_escrow == winning_supply` regardless of which side is chosen.
pub const EMERGENCY_GRACE_SECONDS: i64 = 86_400;

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

/// Admin-only: toggle the Pyth `VerificationLevel::Full` requirement on
/// `settle_market`. Reuses the [`SetPaused`] account context (same admin +
/// Config check). Default is `true` (set at `initialize_config`); operators
/// relax it on devnet where only `Partial` updates are posted.
pub fn set_require_full_verification_handler(
    ctx: Context<SetPaused>,
    require_full: bool,
) -> Result<()> {
    ctx.accounts.config.require_full_verification = require_full;
    msg!("set_require_full_verification: require_full={}", require_full);
    Ok(())
}

#[derive(Accounts)]
pub struct AdminSettleMarket<'info> {
    /// Admin authority. Must equal `config.admin`.
    pub admin: Signer<'info>,

    /// Singleton Config — authenticates the admin. Boxed for stack hygiene
    /// (same reason as `settle_market`).
    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,

    /// Market to force-settle. Mutated.
    #[account(
        mut,
        seeds = [
            Market::SEED_PREFIX,
            market.ticker.as_ref(),
            &market.strike_price.to_le_bytes(),
            &market.expiry_unix.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

/// Emergency oracle-bypass settlement (P1 stuck-oracle deadlock).
///
/// If Pyth never posts an update inside `settle_market`'s
/// `[expiry, expiry+30s]` window, the market can never settle the normal way
/// and all escrowed USDC is stranded. This admin-only path lets the operator
/// stamp an outcome by hand, but only after `expiry + EMERGENCY_GRACE_SECONDS`
/// so normal settlement always gets first claim. Same atomic
/// `settled + outcome` write as `settle_market`; `redeem` works unchanged.
pub fn admin_settle_market_handler(ctx: Context<AdminSettleMarket>, yes_wins: bool) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(!market.settled, MeridianError::MarketSettled);

    let clock = Clock::get()?;
    // Overflow here is only reachable if expiry_unix is within
    // EMERGENCY_GRACE_SECONDS of i64::MAX — a degenerate market that should
    // never exist. Map it to InvariantBroken so it is distinguishable from a
    // genuine "grace window hasn't elapsed yet" rejection.
    let unlock = market
        .expiry_unix
        .checked_add(EMERGENCY_GRACE_SECONDS)
        .ok_or(MeridianError::InvariantBroken)?;
    require!(
        clock.unix_timestamp >= unlock,
        MeridianError::EmergencyGraceNotElapsed
    );

    let outcome = if yes_wins {
        Outcome::YesWins
    } else {
        Outcome::NoWins
    };
    market.settled = true;
    market.outcome = Some(outcome);

    msg!(
        "admin_settle_market: outcome={:?} (emergency, oracle bypassed)",
        outcome
    );
    Ok(())
}
