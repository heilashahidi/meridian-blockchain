//! `settle_sweep` — iterative cancel-all of a settled market's open orders.
//!
//! Per plan §U7 (R15b). Once a market is settled, **no new orders can be
//! placed** (the settled check at `place_*` entry gates that). But any
//! resting orders at settle time still hold escrowed USDC / Yes that must
//! be returned to their owners. This instruction is the cranker.
//!
//! # Cursor encoding
//!
//! `Market.sweep_cursor: u32` is encoded as a single counter of "orders
//! drained so far," interpreted side-relative:
//!
//!   * **While bids are non-empty**: we drain bids. Each successful refund
//!     bumps `sweep_cursor`.
//!   * **Once bids are empty**: we drain asks. Each successful refund
//!     bumps `sweep_cursor`.
//!
//! The cursor is therefore monotonic across calls. We don't encode the
//! side bit explicitly — `book.bids.is_empty()` is the source of truth, and
//! we always drain from `pop_front()` (best entry) so per-side FIFO is
//! preserved during the drain. Off-chain callers should loop until
//! `book.bids.is_empty() && book.asks.is_empty()`.
//!
//! # Refund recipients via remaining_accounts
//!
//! Each order being canceled needs to send its escrowed collateral back to
//! the owner. The off-chain cranker, having simulated the same `pop_front`
//! sequence we'll execute, supplies one `AccountMeta` per POP ATTEMPT in
//! `remaining_accounts` — i.e. one per entry dequeued this call, whether or
//! not its refund succeeds. A skipped (un-receivable) entry still consumes
//! its slot, so the cranker must supply an account for every entry it
//! expects to be popped, not only the ones it expects to pay out:
//!
//!   * Bid cancellations → owner's canonical USDC ATA.
//!   * Ask cancellations → owner's canonical Yes ATA.
//!
//! Per-order validation mirrors `place_order_inner`'s canonical-ATA binding:
//! the recipient must be the order owner's canonical associated token account
//! for the expected mint (derived on-chain), and must be receivable (live,
//! not frozen, SPL-owned). The asymmetry with the trading path is deliberate:
//!   * trading path REVERTS on a non-canonical taker-supplied account (the
//!     taker is the actor and bears its own error);
//!   * sweep SKIPS on a non-canonical recipient (the cranker is an untrusted
//!     public actor and must not be able to abort other owners' refunds).
//! A skipped entry is re-inserted at a fresh seq (see below) and paid by a
//! correct re-crank.
//!
//! # `max_orders` cap
//!
//! Hard cap of [`MAX_SWEEP_PER_TX`] per call to stay under CU budget.
//! `max_orders = 0` is a no-op success (returns `Ok(())` without touching
//! the book), and the loop early-exits when both sides are empty (also
//! a no-op success). Both are useful for the cranker's "did it converge"
//! check.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::matching::book_side::{OrderEntry, Side};
use crate::matching::order_key::OrderKey;
use crate::state::{Book, Config, Market};
use crate::token_util::is_canonical_and_receivable;

/// Per-tx hard cap on how many resting orders one sweep call may drain.
///
/// Each cancellation emits one PDA-signed CPI (USDC or Yes transfer).
/// U5's analogous limit (`MAX_FILLS_PER_TX = 4`) covers two CPIs per
/// fill; sweep is one CPI per cancel, so we double the cap.
pub const MAX_SWEEP_PER_TX: u32 = 8;

#[derive(Accounts)]
pub struct SettleSweep<'info> {
    /// Caller — anyone. Doesn't have to be admin or order owner; the
    /// instruction is a public crank that just refunds escrowed collateral
    /// to the resting orders' owners.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
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

    /// USDC escrow PDA. Refunds bid cancellations.
    #[account(
        mut,
        seeds = [Market::USDC_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = config.usdc_mint,
        token::authority = mint_authority,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    /// Yes escrow PDA. Refunds ask cancellations.
    #[account(
        mut,
        seeds = [Market::YES_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = mint_authority,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    /// Yes mint — used to validate per-fill recipient ATAs.
    #[account(
        seeds = [Market::YES_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    /// CHECK: per-market mint-authority PDA; signs refund transfers.
    #[account(
        seeds = [Market::MINT_AUTH_SEED_PREFIX, market.key().as_ref()],
        bump = market.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct SettleSweepArgs {
    /// Number of resting orders to drain this call. Capped at
    /// [`MAX_SWEEP_PER_TX`]; 0 is a no-op success.
    pub max_orders: u32,
}

pub fn settle_sweep_handler<'info>(
    ctx: Context<'info, SettleSweep<'info>>,
    args: SettleSweepArgs,
) -> Result<()> {
    require!(ctx.accounts.market.settled, MeridianError::MarketNotSettled);
    // Pause halts the public crank too. The plan's pause semantic is "stop
    // user-driven activity"; the sweep cranker is technically a public
    // function but it moves user funds and must respect the operator's halt.
    require!(!ctx.accounts.config.paused, MeridianError::ProgramPaused);

    if args.max_orders == 0 {
        return Ok(());
    }
    let cap = args.max_orders.min(MAX_SWEEP_PER_TX) as usize;

    let remaining = ctx.remaining_accounts;
    let usdc_mint = ctx.accounts.config.usdc_mint;
    let yes_mint = ctx.accounts.market.yes_mint;
    let market_key = ctx.accounts.market.key();
    let bump = ctx.accounts.market.mint_authority_bump;
    let token_program_id = ctx.accounts.token_program.key();
    let seeds: &[&[u8]] = &[
        Market::MINT_AUTH_SEED_PREFIX,
        market_key.as_ref(),
        core::slice::from_ref(&bump),
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    // Plan the drain plan in two passes:
    //   1) drain bids while there are bids and we have budget.
    //   2) drain asks with remaining budget.
    // Because each step is a single CPI we do book-mutation +
    // CPI in lockstep, releasing the load_mut() between iterations so
    // the borrow checker is happy across the CPI call. Each iteration
    // pops the best entry from the relevant side.

    let mut drained: usize = 0;
    let mut attempts: usize = 0;
    let mut accounts_idx: usize = 0;

    // Entries whose refund couldn't be delivered this call (recipient is
    // non-canonical, or the canonical ATA is closed / frozen / uninitialized —
    // mint + owner are now implicit in the canonical-ATA address derivation, so
    // there is no separate wrong-mint/wrong-owner skip, and a failed transfer is
    // no longer a skip path: it propagates as Err). We pop them out of
    // the book so the loop can make progress on the entries behind them, then
    // re-insert them at the end so their escrowed collateral stays owed to the
    // owner. This is the ATA-close DoS fix: a single griefed order (place a
    // tiny order, close the payout ATA) can no longer permanently wedge the
    // sweep — valid orders still drain, and the griefer's order is simply
    // skipped (recoverable once they re-open a valid token account and the
    // crank re-runs). Bounded by `cap` (<= MAX_SWEEP_PER_TX), so the stash is
    // small.
    let mut skipped: Vec<(Side, OrderEntry)> = Vec::with_capacity(cap);

    while attempts < cap {
        // Decide which side to drain this step (re-check each iteration
        // because the book mutates between pops). Bids first. Skipped entries
        // are out of the book during the loop, so emptiness here reflects
        // only entries still pending a drain attempt this call.
        let (side, refund_kind) = {
            let book = ctx.accounts.book.load()?;
            if !book.bids.is_empty() {
                (Side::Bid, RefundKind::Usdc)
            } else if !book.asks.is_empty() {
                (Side::Ask, RefundKind::Yes)
            } else {
                break; // nothing left to attempt this call.
            }
        };

        // Pop the best entry. Hold the load_mut for the duration of the
        // pop only.
        let entry = {
            let mut book = ctx.accounts.book.load_mut()?;
            let side_ref = match side {
                Side::Bid => &mut book.bids,
                Side::Ask => &mut book.asks,
            };
            side_ref.pop_front().expect("non-empty side guard above")
        };
        attempts += 1;

        // Compute refund amount.
        let refund_amount: u64 = match side {
            Side::Bid => {
                let amt = (entry.qty as u128)
                    .checked_mul(entry.key.price() as u128)
                    .ok_or(MeridianError::InvalidAmount)?;
                require!(amt <= u64::MAX as u128, MeridianError::InvalidAmount);
                amt as u64
            }
            Side::Ask => entry.qty,
        };

        // One recipient account per attempt, in pop order (the off-chain
        // cranker simulated the same sequence).
        require!(accounts_idx < remaining.len(), MeridianError::InvalidAmount);
        let recipient = &remaining[accounts_idx];
        accounts_idx += 1;

        let expected_mint = match refund_kind {
            RefundKind::Usdc => usdc_mint,
            RefundKind::Yes => yes_mint,
        };
        let owner_pk = Pubkey::new_from_array(entry.owner);

        // Bind the refund recipient to the order owner's CANONICAL ATA, derived
        // on-chain (consistent with place_order_inner's maker payouts). The
        // sweep cranker is an untrusted PUBLIC caller, so unlike the trading
        // path — which reverts on a non-canonical taker-supplied account — a
        // non-canonical recipient here is SKIPPED, not reverted: a malicious or
        // sloppy cranker must not be able to abort the whole batch and starve
        // other owners' refunds. The skipped entry is re-inserted (fresh seq)
        // and a correct re-crank pays it.
        //
        // We still need `token_account_receivable` for liveness: the canonical
        // ATA may be closed/frozen/uninitialized. The frozen/closed check MUST
        // precede the CPI — a failed transfer aborts the whole tx in the
        // runtime, so it can't be caught after the fact.
        if !is_canonical_and_receivable(recipient, &owner_pk, &expected_mint) {
            skipped.push((side, entry));
            continue;
        }

        // PDA-signed refund. The recipient passed the receivable check above
        // (live, correct mint+authority, not frozen), so a failure here is a
        // genuine invariant break — propagate it rather than silently skipping.
        let from = match refund_kind {
            RefundKind::Usdc => ctx.accounts.usdc_escrow.to_account_info(),
            RefundKind::Yes => ctx.accounts.yes_escrow.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                token_program_id,
                Transfer {
                    from,
                    to: recipient.clone(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer_seeds,
            ),
            refund_amount,
        )?;

        drained += 1;
    }

    // Re-insert skipped entries (fresh seq) so their escrowed collateral stays
    // owed. They came out of the book, so capacity is guaranteed; a BookFull
    // here would be a real invariant break.
    //
    // Fresh seq (finding #4): re-inserting at the ORIGINAL seq sorted skipped
    // orders straight back to the FRONT of their price level, so each later
    // sweep call popped and re-attempted the same un-refundable orders first,
    // burning its per-call attempt budget on them and throttling drain
    // throughput. A fresh seq sends them to the BACK — consistent with
    // place_order_inner — so the cranker drains payable orders first and the
    // skipped owner is refunded once they re-open a valid canonical ATA. The
    // sweep only ever pops whole entries (no partial fills), so there is no
    // remnant-merge case here, unlike the trading path.
    if !skipped.is_empty() {
        let mut book = ctx.accounts.book.load_mut()?;
        for (side, mut entry) in skipped.drain(..) {
            let seq = book.next_seq()?;
            entry.key = OrderKey::new(entry.key.price(), seq);
            let side_ref = match side {
                Side::Bid => &mut book.bids,
                Side::Ask => &mut book.asks,
            };
            side_ref
                .insert(side, entry)
                .map_err(|_| MeridianError::InvariantBroken)?;
        }
    }

    // Update the cursor with however many we drained this call. The
    // cursor doesn't gate anything on-chain (we always re-check
    // book.bids/asks emptiness above) — it's purely a progress counter
    // for off-chain observers and audit logs. `checked_add` rather than
    // `saturating_add` so overflow (only reachable if the cumulative drain
    // count somehow exceeds u32::MAX) surfaces loudly as an audit-log
    // violation rather than silently pinning the cursor.
    let new_cursor = ctx
        .accounts
        .market
        .sweep_cursor
        .checked_add(drained as u32)
        .ok_or(MeridianError::InvariantBroken)?;
    ctx.accounts.market.sweep_cursor = new_cursor;

    msg!(
        "settle_sweep: drained={} new_cursor={}",
        drained,
        new_cursor,
    );

    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum RefundKind {
    Usdc,
    Yes,
}
