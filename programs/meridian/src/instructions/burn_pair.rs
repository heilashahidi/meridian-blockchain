//! `burn_pair` — atomic inverse of `mint_pair`. Burn `amount` Yes and
//! `amount` No from the user's ATAs; PDA-signed transfer returns `amount`
//! USDC from the per-market escrow back to the user.
//!
//! Per plan §U4: this is the **symmetric** half of the $1.00 USDC ↔ 1 Yes
//! + 1 No primitive that resolves the origin doc's Sell-No capital-lock
//! question — a user can always exit a balanced Yes/No position by
//! burning the pair and receiving their USDC back immediately, no
//! settlement wait required.
//!
//! # Composition with U6
//!
//! Like `mint_pair`, the actual logic lives in [`burn_pair_inner`] so U6's
//! `sell_no` can drive it directly with its own `Accounts` struct's
//! fields. See the rationale comment in `mint_pair.rs`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::state::{Config, Market};

/// Burn-pair `Accounts`. See the boxed-account note on
/// [`super::mint_pair::MintPair`] for why every SPL account is `Box`ed.
#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct BurnPair<'info> {
    /// Caller — pays Yes + No, receives USDC.
    #[account(mut)]
    pub user: Signer<'info>,

    /// Global config — read-only here; we only need the pause flag + the
    /// pinned USDC mint for the user's source/escrow constraints.
    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    /// Market this burn pair belongs to. Yes/No mints and the mint-auth
    /// PDA are validated against fields on this account.
    #[account(
        seeds = [
            Market::SEED_PREFIX,
            market.ticker.as_ref(),
            &market.strike_price.to_le_bytes(),
            &market.expiry_unix.to_le_bytes(),
        ],
        bump = market.bump,
        has_one = yes_mint @ MeridianError::Unauthorized,
        has_one = no_mint @ MeridianError::Unauthorized,
    )]
    pub market: Box<Account<'info, Market>>,

    /// User's USDC ATA — receives the returned `amount` USDC.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// USDC escrow PDA owned by the market's mint-authority PDA. Source of
    /// the returned USDC.
    #[account(
        mut,
        seeds = [Market::USDC_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = config.usdc_mint,
        token::authority = mint_authority,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    /// Yes mint — supply decreases by `amount`.
    #[account(
        mut,
        seeds = [Market::YES_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    /// No mint — supply decreases by `amount`.
    #[account(
        mut,
        seeds = [Market::NO_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    /// User's Yes ATA. Constraint requires balance ≥ amount — surfaces the
    /// shortfall as a clean Anchor error rather than letting the burn CPI
    /// fail deep in the token program.
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
        constraint = user_yes.amount >= amount @ MeridianError::InvalidAmount,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// User's No ATA. Same balance constraint as `user_yes`.
    #[account(
        mut,
        token::mint = no_mint,
        token::authority = user,
        constraint = user_no.amount >= amount @ MeridianError::InvalidAmount,
    )]
    pub user_no: Box<Account<'info, TokenAccount>>,

    /// CHECK: per-market mint-authority PDA. Validated via seed+bump; signs
    /// the USDC escrow → user transfer.
    #[account(
        seeds = [Market::MINT_AUTH_SEED_PREFIX, market.key().as_ref()],
        bump = market.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn burn_pair_handler(ctx: Context<BurnPair>, amount: u64) -> Result<()> {
    burn_pair_inner(
        &ctx.accounts.config,
        &ctx.accounts.market,
        &ctx.accounts.user_usdc,
        &ctx.accounts.usdc_escrow,
        &ctx.accounts.yes_mint,
        &ctx.accounts.no_mint,
        &ctx.accounts.user_yes,
        &ctx.accounts.user_no,
        &ctx.accounts.mint_authority,
        &ctx.accounts.user,
        &ctx.accounts.token_program,
        amount,
    )
}

/// Composition-friendly inner handler. See `mint_pair.rs` for the shape
/// rationale.
///
/// Pre-conditions checked here (defense in depth, even though the
/// `Accounts` struct already imposes the balance constraint):
///   * config not paused
///   * market not settled
///   * `amount > 0`
///   * `user_yes.amount >= amount` and `user_no.amount >= amount`
#[allow(clippy::too_many_arguments)]
pub(crate) fn burn_pair_inner<'info>(
    config: &Account<'info, Config>,
    market: &Account<'info, Market>,
    user_usdc: &Account<'info, TokenAccount>,
    usdc_escrow: &Account<'info, TokenAccount>,
    yes_mint: &Account<'info, Mint>,
    no_mint: &Account<'info, Mint>,
    user_yes: &Account<'info, TokenAccount>,
    user_no: &Account<'info, TokenAccount>,
    mint_authority: &UncheckedAccount<'info>,
    user: &Signer<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    require!(!config.paused, MeridianError::ProgramPaused);
    require!(!market.settled, MeridianError::MarketSettled);
    require!(amount > 0, MeridianError::InvalidAmount);
    // Belt-and-suspenders: the Accounts struct's constraint catches this
    // first; mirror it here so `burn_pair_inner` is safe to call from U6
    // with a different Accounts shape that may not duplicate the check.
    require!(user_yes.amount >= amount, MeridianError::InvalidAmount);
    require!(user_no.amount >= amount, MeridianError::InvalidAmount);

    // Anchor 1.0's `CpiContext::new` takes the program *Pubkey*; see the
    // note in `mint_pair_inner` for the rationale.
    let token_program_id = token_program.key();

    // Step 1 + 2: burn Yes and No from user (user signs).
    let burn_yes_accounts = Burn {
        mint: yes_mint.to_account_info(),
        from: user_yes.to_account_info(),
        authority: user.to_account_info(),
    };
    token::burn(CpiContext::new(token_program_id, burn_yes_accounts), amount)?;

    let burn_no_accounts = Burn {
        mint: no_mint.to_account_info(),
        from: user_no.to_account_info(),
        authority: user.to_account_info(),
    };
    token::burn(CpiContext::new(token_program_id, burn_no_accounts), amount)?;

    // Step 3: PDA-signed USDC transfer back to the user.
    let market_key = market.key();
    let bump = market.mint_authority_bump;
    let seeds: &[&[u8]] = &[
        Market::MINT_AUTH_SEED_PREFIX,
        market_key.as_ref(),
        core::slice::from_ref(&bump),
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    let transfer_accounts = Transfer {
        from: usdc_escrow.to_account_info(),
        to: user_usdc.to_account_info(),
        authority: mint_authority.to_account_info(),
    };
    token::transfer(
        CpiContext::new_with_signer(token_program_id, transfer_accounts, signer_seeds),
        amount,
    )?;

    Ok(())
}
