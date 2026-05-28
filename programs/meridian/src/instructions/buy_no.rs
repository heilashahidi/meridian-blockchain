//! `buy_no` — atomic single-signature "Buy No" trade path.
//!
//! Per plan §U6: composes `mint_pair_inner` (mint `amount` Yes + `amount`
//! No against `amount` USDC) with a market-sell of the Yes leg, so the
//! taker walks away holding `amount` No tokens + their leftover USDC, with
//! the Yes leg fully off-loaded to the book in a single tx.
//!
//! Sequence (the high-level diagram in the plan §"High-Level Technical
//! Design"):
//!
//! ```text
//! User signs 1 tx ──> buy_no(amount, min_yes_sell_price)
//!     ├─ mint_pair_inner(amount)
//!     │     ├─ transfer USDC (user → usdc_escrow) [amount]
//!     │     ├─ mint Yes to user [amount]
//!     │     └─ mint No to user [amount]
//!     └─ place_order_inner(side=Ask, type=Market,
//!                          qty=amount, slippage=min_yes_sell_price)
//!           ├─ transfer Yes (user → yes_escrow) [amount]
//!           ├─ match_step(book, taker=Ask, qty=amount)
//!           ├─ for each fill: yes_escrow → maker; usdc_escrow → user
//!           └─ residual rejected (market order)
//!           returns OrderOutcome { filled_qty, residual_qty }
//!     └─ U6 atomicity check: residual_qty MUST be 0, else revert.
//!         User ends with: amount No, 0 Yes, USDC delta = sum(fill_price * fill_qty) - amount.
//! ```
//!
//! # Slippage parameter naming
//!
//! The plan text says `max_yes_sell_price`, but the matching engine's
//! `slippage_bound` for an Ask taker is the **minimum** acceptable price
//! (worst-case sell price the taker accepts). Calling it `max_*` would
//! contradict the engine, so we rename to **`min_yes_sell_price`** — the
//! lowest price per Yes the user will sell at. A maker ask at exactly this
//! price still crosses (the engine uses `>=`).
//!
//! Use `1` as the "no floor" sentinel — `0` is rejected up front by
//! `place_order_inner` because zero collides with the `OrderKey` invalid
//! sentinel.
//!
//! # Atomic full-fill enforcement
//!
//! `place_order_inner` is willing to return a partial-fill outcome and
//! refund the residual collateral (this is the U5 behavior — market orders
//! never post). For `buy_no` we want a stricter semantics: either the
//! whole Yes leg sells at an acceptable price, or the user's mint_pair is
//! rolled back. We enforce that by asserting `residual_qty == 0` on the
//! `OrderOutcome` and returning [`MeridianError::InvalidAmount`] otherwise
//! — Anchor's per-instruction atomicity rolls back the mint_pair side
//! effects automatically.
//!
//! # Accounts struct shape
//!
//! The `BuyNo` struct unions the accounts `mint_pair` and
//! `place_market_order` need:
//!
//!   * From mint_pair: config, market, user_usdc, usdc_escrow, yes_mint,
//!     no_mint, user_yes, user_no, mint_authority, user, token_program.
//!   * From place_market_order: config, market, book, usdc_escrow,
//!     yes_escrow, yes_mint, user_usdc, user_yes, mint_authority, user,
//!     token_program.
//!
//! Union = the mint_pair set + book + yes_escrow. Every SPL Mint /
//! TokenAccount field is `Box`ed for the same SBPF stack reason
//! `mint_pair.rs` documents in detail.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::MeridianError;
use crate::matching::match_step::OrderType;
use crate::state::{Book, Config, Market};

#[derive(Accounts)]
pub struct BuyNo<'info> {
    /// Caller. Pays USDC, ends holding No tokens.
    #[account(mut)]
    pub user: Signer<'info>,

    /// Global config — paused flag + canonical USDC mint.
    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    /// Market the trade is against. `has_one` checks pin the Yes / No
    /// mints stored on `Market` to the accounts the user passes.
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

    /// Zero-copy `Book` account for the market. Mutated by the market-sell
    /// leg via `place_order_inner`.
    #[account(
        mut,
        seeds = [Book::SEED_PREFIX, market.key().as_ref()],
        bump,
        constraint = book.load()?.market == market.key() @ MeridianError::Unauthorized,
    )]
    pub book: AccountLoader<'info, Book>,

    /// USDC escrow PDA — receives the `amount` USDC from `mint_pair_inner`,
    /// sources the per-fill USDC payouts to makers in `place_order_inner`.
    #[account(
        mut,
        seeds = [Market::USDC_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = config.usdc_mint,
        token::authority = mint_authority,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    /// Yes escrow PDA — receives the minted Yes from the taker's
    /// up-front lock in `place_order_inner`, sourced out to makers per fill.
    #[account(
        mut,
        seeds = [Market::YES_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = mint_authority,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    /// Yes mint — `mint::authority = mint_authority`.
    #[account(
        mut,
        seeds = [Market::YES_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    /// No mint — `mint::authority = mint_authority`.
    #[account(
        mut,
        seeds = [Market::NO_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    /// User's USDC source ATA — pays the `amount` USDC for `mint_pair`.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// User's Yes ATA. Receives the minted Yes (then immediately drained
    /// into the Yes escrow by the market-sell up-front lock).
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// User's No ATA. Receives the minted No (the user's keepsake from
    /// this whole flow).
    #[account(
        mut,
        token::mint = no_mint,
        token::authority = user,
    )]
    pub user_no: Box<Account<'info, TokenAccount>>,

    /// CHECK: per-market mint-authority PDA. Signs every PDA-side transfer
    /// in both the mint_pair leg and the place_order leg.
    #[account(
        seeds = [Market::MINT_AUTH_SEED_PREFIX, market.key().as_ref()],
        bump = market.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

/// `buy_no` arguments.
///
/// `min_yes_sell_price` is the worst (lowest) price-per-Yes the taker
/// will accept on the sell leg. See module docs for the naming rationale.
/// Pass `1` for "no floor" (`0` is rejected — collides with the OrderKey
/// invalid sentinel).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct BuyNoArgs {
    /// Quantity of No tokens the user wants to end up holding.
    pub amount: u64,
    /// Slippage floor for the Yes sell leg (microunits per Yes token).
    pub min_yes_sell_price: u64,
}

pub fn buy_no_handler<'info>(
    ctx: Context<'info, BuyNo<'info>>,
    args: BuyNoArgs,
) -> Result<()> {
    // Top-level pre-condition checks. The inner handlers re-check these
    // for defense in depth but failing fast here gives a cleaner error
    // path and skips the first CPI.
    require!(!ctx.accounts.config.paused, MeridianError::ProgramPaused);
    require!(
        !ctx.accounts.market.settled,
        MeridianError::MarketSettled,
    );
    require!(args.amount > 0, MeridianError::InvalidAmount);

    // -------- Leg 1: mint_pair(amount). --------
    //
    // After this leg the user holds `amount` Yes + `amount` No and has
    // paid `amount` USDC into the escrow. The market is unsettled and
    // unpaused (mint_pair_inner re-checks).
    super::mint_pair::mint_pair_inner(
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

    // -------- Leg 2: market-sell `amount` Yes. --------
    //
    // `place_order_inner` will:
    //   1. lock the user's `amount` Yes in the yes_escrow,
    //   2. run match_step against the bid side (taker is an Ask),
    //   3. for each fill, transfer Yes from escrow → maker_yes and
    //      transfer USDC from escrow → user,
    //   4. for any residual (no remaining crossing bids OR best bid below
    //      the slippage floor), refund the residual Yes back to user_yes.
    //
    // After this call:
    //   * filled portion: user holds the USDC proceeds in user_usdc.
    //   * residual portion: user holds the residual Yes back in user_yes.
    //
    // For `buy_no` we DON'T want any residual Yes to come back — that
    // would leave the user holding Yes + No (a paired position) when they
    // asked for No-only exposure. So we enforce residual_qty == 0 below
    // and let Anchor roll back the whole tx (including the mint_pair) on
    // mismatch.
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
        /* side_byte = Ask */ 1,
        OrderType::Market,
        args.min_yes_sell_price,
        args.amount,
    )?;

    // -------- Leg 3: atomic full-fill enforcement. --------
    //
    // Plan §U6: "If the market sell can't fill the full amount within
    // slippage_bound, the instruction reverts (atomic — no partial Buy No)."
    //
    // Returning Err here triggers Anchor's per-instruction revert, which
    // unwinds **both** the mint_pair and the partial-fill side effects —
    // the user's pre-state is restored.
    require!(
        outcome.residual_qty == 0,
        MeridianError::SlippageNotMet,
    );
    debug_assert_eq!(outcome.filled_qty, args.amount);

    Ok(())
}
