//! `place_market_order` — taker order with no resting.
//!
//! Per plan §U5: same semantics as `place_limit_order` except the residual
//! is **rejected** rather than posted. The unfilled portion of the
//! collateral the taker pre-deposited is refunded to them before the
//! instruction returns.
//!
//! `slippage_bound` is the worst price the taker will accept:
//!   * Buy taker (bid): maximum it will pay (`u64::MAX` = no cap).
//!   * Sell taker (ask): minimum it will accept (`1` = no cap; `0` is
//!     reserved as the invalid sentinel in `OrderKey` and is rejected up
//!     front).
//!
//! The instruction shares all of its account validation and the
//! matching/settlement loop with `place_limit_order` via
//! [`super::place_limit_order::place_order_inner`]. The only behavioral
//! diff is the `OrderType::Market` argument which routes residual handling
//! down the rejection path inside the inner kernel.
//!
//! Composition note for U6: `buy_no` / `sell_no` will reuse
//! `place_order_inner` directly (with their own `Accounts` shape).

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::MeridianError;
use crate::matching::match_step::OrderType;
use crate::state::{Book, Config, Market};

#[derive(Accounts)]
pub struct PlaceMarketOrder<'info> {
    /// Taker. Pays collateral up front; receives counter-asset on fill.
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
        has_one = yes_mint @ MeridianError::Unauthorized,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [Book::SEED_PREFIX, market.key().as_ref()],
        bump,
        constraint = book.load()?.market == market.key() @ MeridianError::Unauthorized,
    )]
    pub book: AccountLoader<'info, Book>,

    #[account(
        mut,
        seeds = [Market::USDC_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = config.usdc_mint,
        token::authority = mint_authority,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [Market::YES_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = mint_authority,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [b"yes_mint", market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// CHECK: per-market mint-authority PDA; signs every PDA-side transfer.
    #[account(
        seeds = [Market::MINT_AUTH_SEED_PREFIX, market.key().as_ref()],
        bump = market.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PlaceMarketOrderArgs {
    /// 0 = Bid (Buy Yes), 1 = Ask (Sell Yes).
    pub side: u8,
    /// Quantity in Yes-token base units.
    pub qty: u64,
    /// Slippage bound (worst acceptable price per Yes token). For a Bid
    /// taker this is the max it will pay; for an Ask taker the min it
    /// will accept. `0` is rejected — pass `1` for "no floor" Ask or
    /// `u64::MAX` for "no ceiling" Bid.
    pub slippage_bound: u64,
}

pub fn place_market_order_handler<'info>(
    ctx: Context<'info, PlaceMarketOrder<'info>>,
    args: PlaceMarketOrderArgs,
) -> Result<()> {
    super::place_limit_order::place_order_inner(
        &ctx.accounts.config,
        &ctx.accounts.market,
        &ctx.accounts.book,
        &ctx.accounts.usdc_escrow,
        &ctx.accounts.yes_escrow,
        &ctx.accounts.user_usdc,
        &ctx.accounts.user_yes,
        &ctx.accounts.mint_authority,
        &ctx.accounts.user,
        &ctx.accounts.token_program,
        ctx.remaining_accounts,
        args.side,
        OrderType::Market,
        args.slippage_bound,
        args.qty,
    )
}
