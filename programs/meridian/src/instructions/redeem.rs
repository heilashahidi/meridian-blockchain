//! `redeem` — winning-token holders burn for $1 USDC.
//!
//! Per plan §U7:
//!   * Requires `market.settled && market.outcome.is_some()` (the
//!     `settle_market` ix establishes this invariant atomically).
//!   * Caller passes the **winning** mint + their ATA. We reject any other
//!     mint (`WrongRedeemMint`) — there's no caller-supplied `side`
//!     argument because the winning side is unambiguous from the outcome.
//!   * Burn `amount` of the winning token from the caller; PDA-signed
//!     transfer of `amount` USDC from the USDC escrow back to the caller.
//!   * No deadline: works indefinitely after settle.
//!
//! # $1 invariant
//!
//! At settle time, `yes_supply == no_supply == usdc_escrow.amount` per
//! U4's mint_pair / burn_pair invariant. Order-book flow only ever shuffles
//! Yes between users — it doesn't change `yes_supply`. Sell-No's
//! `burn_pair` reduces all three in lockstep. Buy-No's `mint_pair`
//! increases all three in lockstep.
//!
//! So at settle, `yes_supply == no_supply == usdc_escrow.amount = T`.
//! Total redemption demand from the winning side is exactly its supply, so
//! the escrow balance is sufficient by construction.
//!
//! # Losing-side cleanup
//!
//! Plan §U7 lists a "burn loser for nothing" path as optional. We **skip**
//! it (path (b) in the plan) — leaving losing-side tokens in users'
//! wallets is harmless, and `burn_pair` post-settle is intentionally
//! blocked by U4's `!settled` check (we don't relax that). Off-chain UX
//! can offer a "remove dust" action that simply ignores the worthless
//! tokens.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::state::{Config, Market, Outcome};

#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct Redeem<'info> {
    /// Caller — pays winning tokens, receives USDC.
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        seeds = [
            Market::SEED_PREFIX,
            market.ticker.as_ref(),
            &market.strike_price.to_le_bytes(),
            &market.expiry_unix.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// The **winning** mint. We don't constrain via seeds here because the
    /// "which side wins" is read off the market's outcome at handler time;
    /// the handler verifies `winning_mint.key()` matches `market.{yes,no}_mint`
    /// based on outcome. Passing the losing mint trips `WrongRedeemMint`.
    #[account(mut)]
    pub winning_mint: Box<Account<'info, Mint>>,

    /// User's ATA for the winning token. Source of the burn.
    #[account(
        mut,
        token::mint = winning_mint,
        token::authority = user,
        constraint = user_winning.amount >= amount @ MeridianError::InvalidAmount,
    )]
    pub user_winning: Box<Account<'info, TokenAccount>>,

    /// User's USDC ATA. Destination of the $1-per-token payout.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// USDC escrow PDA. Source of the payout.
    #[account(
        mut,
        seeds = [Market::USDC_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = config.usdc_mint,
        token::authority = mint_authority,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA used as escrow authority. Validated via seed+bump.
    #[account(
        seeds = [Market::MINT_AUTH_SEED_PREFIX, market.key().as_ref()],
        bump = market.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn redeem_handler(ctx: Context<Redeem>, amount: u64) -> Result<()> {
    require!(amount > 0, MeridianError::InvalidAmount);
    // Gate on the global pause flag like every other user-facing path.
    // Admin pause means "halt all user activity" — including post-settle
    // redemptions, so an emergency pause can stop escrow drains while a
    // discovered settle/outcome bug is investigated. Admin can always
    // unpause to let redemption proceed once cleared.
    require!(!ctx.accounts.config.paused, MeridianError::ProgramPaused);

    let market = &ctx.accounts.market;
    require!(market.settled, MeridianError::MarketNotSettled);
    let outcome = market.outcome.ok_or(MeridianError::MarketNotSettled)?;

    // Validate that the caller-supplied mint is the winning side's mint.
    let winning_mint_key = ctx.accounts.winning_mint.key();
    let expected = match outcome {
        Outcome::YesWins => market.yes_mint,
        Outcome::NoWins => market.no_mint,
    };
    require_keys_eq!(winning_mint_key, expected, MeridianError::WrongRedeemMint);

    let token_program_id = ctx.accounts.token_program.key();

    // Step 1: burn `amount` of the winning token from the user (user signs).
    token::burn(
        CpiContext::new(
            token_program_id,
            Burn {
                mint: ctx.accounts.winning_mint.to_account_info(),
                from: ctx.accounts.user_winning.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Step 2: PDA-signed USDC transfer escrow → user_usdc.
    let market_key = market.key();
    let bump = market.mint_authority_bump;
    let seeds: &[&[u8]] = &[
        Market::MINT_AUTH_SEED_PREFIX,
        market_key.as_ref(),
        core::slice::from_ref(&bump),
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    token::transfer(
        CpiContext::new_with_signer(
            token_program_id,
            Transfer {
                from: ctx.accounts.usdc_escrow.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount
            .checked_mul(crate::ONE_USDC)
            .ok_or(MeridianError::InvalidAmount)?,
    )?;

    Ok(())
}
