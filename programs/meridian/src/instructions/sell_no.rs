//! `sell_no` — atomic single-signature "Sell No" trade path.
//!
//! Per plan §U6: composes a market-buy of `amount` Yes with
//! `burn_pair_inner` so the user can liquidate `amount` No tokens for USDC
//! in a single tx, without waiting for settlement. This is the symmetric
//! exit the origin doc's "Sell No capital lock" question was waiting on.
//!
//! Sequence (the high-level diagram in the plan §"High-Level Technical
//! Design", inverted):
//!
//! ```text
//! User signs 1 tx ──> sell_no(amount, max_yes_buy_price)
//!     ├─ Precondition: user_no.amount >= amount (Anchor constraint).
//!     ├─ place_order_inner(side=Bid, type=Market,
//!     │                    qty=amount, slippage=max_yes_buy_price)
//!     │     ├─ transfer USDC (user → usdc_escrow) [amount * max_yes_buy_price]
//!     │     ├─ match_step(book, taker=Bid, qty=amount)
//!     │     ├─ for each fill: usdc_escrow → maker; yes_escrow → user
//!     │     ├─ price-improvement refund (USDC) to user
//!     │     └─ residual rejected (market order); residual USDC refunded.
//!     │     returns OrderOutcome { filled_qty, residual_qty }
//!     ├─ Atomicity check: residual_qty MUST be 0, else revert.
//!     └─ burn_pair_inner(amount)
//!           ├─ burn Yes from user [amount]
//!           ├─ burn No from user [amount]
//!           └─ transfer USDC from usdc_escrow → user [amount]
//! ```
//!
//! End state: user's No is `prior_no - amount`, Yes back to 0, USDC delta
//! is `amount` (from burn_pair) minus the actual notional paid on the buy
//! leg (= `sum(fill_qty * fill_price)`).
//!
//! # Slippage parameter naming
//!
//! `max_yes_buy_price` is the highest price-per-Yes the taker accepts on
//! the buy leg — matches `place_market_order`'s `slippage_bound` semantics
//! for `Side::Bid` (the engine uses `<=` against the limit). Pass
//! `u64::MAX` for "no cap" but be aware the up-front USDC lock is
//! `amount * max_yes_buy_price`, so very large values can overflow the
//! `u64` lock — the inner kernel rejects that as `InvalidAmount`.
//!
//! # Atomic full-fill enforcement
//!
//! Identical to `buy_no`: assert `OrderOutcome.residual_qty == 0` and let
//! Anchor's per-instruction revert undo the up-front USDC lock if the
//! market-buy couldn't fill in full.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::MeridianError;
use crate::matching::match_step::OrderType;
use crate::state::{Book, Config, Market};

#[derive(Accounts)]
#[instruction(args: SellNoArgs)]
pub struct SellNo<'info> {
    /// Caller. Holds `amount` No upfront, ends with USDC delta + 0 Yes.
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
        has_one = no_mint @ MeridianError::Unauthorized,
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
        mut,
        seeds = [Market::YES_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [Market::NO_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    /// User's USDC ATA. Sources the up-front lock for the market-buy and
    /// receives the burn_pair USDC at the end.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// User's Yes ATA. Starts at any balance — the market-buy leg deposits
    /// the bought Yes here, then burn_pair burns `amount` from it. Net
    /// change: 0 (started 0, market-buy ended with `amount`, burn cleared).
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// User's No ATA. Must hold ≥ `args.amount` before the call — the
    /// burn_pair leg drains `amount` from it. Validated via Anchor
    /// constraint so the failure surfaces before any state mutation.
    ///
    /// Note: we reference the instruction args via `#[instruction(args:
    /// SellNoArgs)]` so the constraint can read `args.amount` at account
    /// validation time. Anchor 1.0 wires this through cleanly.
    #[account(
        mut,
        token::mint = no_mint,
        token::authority = user,
        constraint = user_no.amount >= args.amount @ MeridianError::InvalidAmount,
    )]
    pub user_no: Box<Account<'info, TokenAccount>>,

    /// CHECK: per-market mint-authority PDA; signs the burn_pair USDC
    /// refund and the per-fill USDC payouts.
    #[account(
        seeds = [Market::MINT_AUTH_SEED_PREFIX, market.key().as_ref()],
        bump = market.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct SellNoArgs {
    /// Quantity of No tokens the user wants to liquidate.
    pub amount: u64,
    /// Slippage cap for the Yes buy leg (microunits per Yes token).
    pub max_yes_buy_price: u64,
}

pub fn sell_no_handler<'info>(
    ctx: Context<'info, SellNo<'info>>,
    args: SellNoArgs,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, MeridianError::ProgramPaused);
    require!(
        !ctx.accounts.market.settled,
        MeridianError::MarketSettled,
    );
    require!(args.amount > 0, MeridianError::InvalidAmount);
    // The `user_no.amount >= args.amount` check is enforced by the
    // Accounts struct's constraint, but mirror it here so the failure
    // mode is consistent regardless of upstream Anchor changes.
    require!(
        ctx.accounts.user_no.amount >= args.amount,
        MeridianError::InvalidAmount,
    );

    // -------- Leg 1: market-buy `amount` Yes. --------
    //
    // Up-front locks `amount * max_yes_buy_price` USDC; engine fills at
    // maker prices (which may be strictly less, in which case the price-
    // improvement refund inside place_order_inner returns the diff). On
    // residual, place_order_inner refunds the unfilled USDC lock at
    // limit_price — but we require residual == 0 below so that branch is
    // a dead code path for `sell_no`.
    let outcome = super::place_limit_order::place_order_inner(
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
        /* side_byte = Bid */ 0,
        OrderType::Market,
        args.max_yes_buy_price,
        args.amount,
    )?;

    // Atomic full-fill: same rationale as buy_no.
    require!(
        outcome.residual_qty == 0,
        MeridianError::SlippageNotMet,
    );
    debug_assert_eq!(outcome.filled_qty, args.amount);

    // -------- Leg 2: burn_pair(amount). --------
    //
    // After the market-buy the user holds `amount` Yes (just bought) + at
    // least `amount` No (precondition). burn_pair_inner burns one of each
    // and returns `amount` USDC from the escrow. Net USDC delta across
    // both legs:
    //
    //   - sum(fill_qty * fill_price)      paid on the market-buy
    //   - any price-improvement refund    (= 0 if we paid at limit)
    //   + `amount`                        from burn_pair
    //
    // For a fill at price p < max_yes_buy_price the user pays p per Yes
    // and gets $1 per No-share back — net profit `1 - p` per unit.
    super::burn_pair::burn_pair_inner(
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
        args.amount,
    )?;

    Ok(())
}
