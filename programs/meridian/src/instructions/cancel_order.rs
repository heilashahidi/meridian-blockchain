//! `cancel_order` — owner-only removal of a resting order, refund of
//! escrowed collateral.
//!
//! Per plan §U5: orders are identified by the matching engine's stable
//! [`OrderKey`] (the packed `(price, seq)` pair), **not** by an array
//! index — the book reshifts on every insert/cancel/fill so an index is
//! not durable.
//!
//! # Owner check ordering (plan §U5 §2)
//!
//! We perform the owner check **before** removing the entry: scan the
//! side via `as_slice()` to locate the matching key, compare its `owner`
//! against the signer's pubkey, and only then call
//! [`crate::matching::book_side::BookSide::cancel_by_id`] to remove it.
//!
//! This is slightly more defensive than relying on tx rollback after a
//! failed `require_keys_eq!`: even though Solana would roll back the
//! removed entry along with the rest of the failed transaction, doing the
//! check first means the book mutation is conditional on success and the
//! emitted CPI (the refund transfer) doesn't fire either. A test
//! (`u5_orders::cancel_by_non_owner_rejected`) verifies the book state is
//! unchanged after a non-owner cancel attempt.
//!
//! Collateral refund:
//!   * Cancel of a resting **bid**: return `entry.qty * entry.key.price()`
//!     USDC from the USDC escrow to the owner's USDC ATA.
//!   * Cancel of a resting **ask**: return `entry.qty` Yes from the Yes
//!     escrow to the owner's Yes ATA.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::matching::book_side::{OrderId, Side};
use crate::matching::order_key::OrderKey;
use crate::state::{Book, Config, Market};

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    /// Order owner. Must equal the resting order's `owner` field.
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

    /// USDC escrow PDA. Refunds Buy-side cancels.
    #[account(
        mut,
        seeds = [Market::USDC_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = config.usdc_mint,
        token::authority = mint_authority,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    /// Yes escrow PDA. Refunds Sell-side cancels.
    #[account(
        mut,
        seeds = [Market::YES_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = mint_authority,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [Market::YES_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    /// Owner's USDC ATA. Receives the refund on Buy-side cancels.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// Owner's Yes ATA. Receives the refund on Sell-side cancels.
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// CHECK: per-market mint-authority PDA; signs the refund transfer.
    #[account(
        seeds = [Market::MINT_AUTH_SEED_PREFIX, market.key().as_ref()],
        bump = market.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

/// `cancel_order` arguments.
///
/// `side` matches `place_limit_order`'s convention: 0 = Bid, 1 = Ask.
/// `(price, seq)` is the full `OrderKey` the place instruction returned
/// (via `msg!` log) when the order was placed.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct CancelOrderArgs {
    /// 0 = Bid, 1 = Ask.
    pub side: u8,
    /// Price half of the order's `OrderKey`.
    pub price: u64,
    /// Sequence half of the order's `OrderKey`.
    pub seq: u64,
}

pub fn cancel_order_handler(ctx: Context<CancelOrder>, args: CancelOrderArgs) -> Result<()> {
    // We *don't* gate cancel on `market.settled`. After settle, two paths
    // drain resting orders:
    //   * `settle_sweep` (public crank) pops orders directly via
    //     `BookSide::pop_front` and refunds escrowed collateral to each
    //     resting owner.
    //   * Resting owners may also self-cancel via this instruction.
    // The two paths are independent; this comment used to claim sweep
    // "calls into the same removal path" but sweep does not invoke this
    // handler. Leaving the post-settle path open here gives owners a
    // self-service exit before the cranker reaches them — and the refund
    // accounting is identical either way, so neither path can double-pay.
    // Off-chain accounting should treat `sweep_cursor` as a drain-progress
    // signal for the cranker only, not as a total-cancellation tally.
    // (`config.paused` still halts everything user-driven.)
    require!(!ctx.accounts.config.paused, MeridianError::ProgramPaused);

    let side = match args.side {
        0 => Side::Bid,
        1 => Side::Ask,
        _ => return Err(MeridianError::InvalidAmount.into()),
    };
    let id = OrderId(OrderKey::new(args.price, args.seq));

    let user_key = ctx.accounts.user.key();
    let user_bytes = user_key.to_bytes();
    let market_key = ctx.accounts.market.key();
    let bump = ctx.accounts.market.mint_authority_bump;
    let token_program_id = ctx.accounts.token_program.key();

    // ---- Locate + verify owner BEFORE mutation. ----
    //
    // See module docs §"Owner check ordering". We hold the load_mut here
    // briefly so the in-between scan + cancel_by_id is atomic with
    // respect to anyone else reading the book.
    let (refund_kind, refund_amount) = {
        let mut book = ctx.accounts.book.load_mut()?;

        // Scan the matching side, find the entry whose key matches.
        let side_ref = match side {
            Side::Bid => &book.bids,
            Side::Ask => &book.asks,
        };
        let entry_opt = side_ref
            .as_slice()
            .iter()
            .find(|e| e.key == id.0)
            .copied();
        let entry = entry_opt.ok_or(MeridianError::OrderNotFound)?;

        // Owner equality check. If this fails the book has not been
        // mutated.
        require!(
            entry.owner == user_bytes,
            MeridianError::Unauthorized
        );

        // Owner verified — now remove. `cancel_by_id` shifts the side.
        let side_mut = match side {
            Side::Bid => &mut book.bids,
            Side::Ask => &mut book.asks,
        };
        let removed = side_mut
            .cancel_by_id(side, id)
            .map_err(|_| MeridianError::OrderNotFound)?;

        // Defensive: removed entry should equal scanned entry. (If the
        // engine ever lets them diverge, we'd refund the wrong amount.)
        debug_assert_eq!(removed.qty, entry.qty);
        debug_assert_eq!(removed.owner, entry.owner);

        let refund_amount = match side {
            Side::Bid => {
                // Refund: qty * price USDC.
                let amt = (removed.qty as u128)
                    .checked_mul(removed.key.price() as u128)
                    .ok_or(MeridianError::InvalidAmount)?;
                require!(amt <= u64::MAX as u128, MeridianError::InvalidAmount);
                amt as u64
            }
            Side::Ask => removed.qty,
        };
        (side, refund_amount)
    };

    // ---- Refund the escrowed collateral. ----
    let seeds: &[&[u8]] = &[
        Market::MINT_AUTH_SEED_PREFIX,
        market_key.as_ref(),
        core::slice::from_ref(&bump),
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    match refund_kind {
        Side::Bid => {
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
                refund_amount,
            )?;
        }
        Side::Ask => {
            token::transfer(
                CpiContext::new_with_signer(
                    token_program_id,
                    Transfer {
                        from: ctx.accounts.yes_escrow.to_account_info(),
                        to: ctx.accounts.user_yes.to_account_info(),
                        authority: ctx.accounts.mint_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                refund_amount,
            )?;
        }
    }

    Ok(())
}
