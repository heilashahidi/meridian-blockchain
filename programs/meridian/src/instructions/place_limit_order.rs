//! `place_limit_order` — wrap the matching engine with Anchor account
//! validation, signer constraints, and PDA-signed escrow CPIs.
//!
//! Per plan §U5 the taker:
//!   * pays collateral up-front (USDC for a Buy bid, Yes tokens for a Sell
//!     ask),
//!   * is matched against the opposing side via [`crate::matching::match_step`],
//!   * settles each [`Fill`] by routing tokens between the program-owned
//!     escrows and the maker's wallet,
//!   * receives price-improvement refunds (Buy taker only — Sell taker
//!     always crosses at the ask's price or better in the engine, so no
//!     extra refund is needed on the Yes leg),
//!   * posts any residual on its own side of the book; the residual's
//!     collateral remains escrowed against the new resting order.
//!
//! # Per-tx fill cap
//!
//! A single tx walks at most [`MAX_FILLS_PER_TX`] opposing entries. The cap
//! bounds CU consumption (each fill is two PDA-signed CPIs) and bounds the
//! number of `remaining_accounts` slots the caller must supply. If the book
//! is deeper than the cap, the residual rests on the book per the plan's
//! AE2 path (limit order partial fill, residual posts cleanly).
//!
//! # Maker token-account resolution via `remaining_accounts`
//!
//! Each fill needs to pay the maker. The handler walks
//! `ctx.remaining_accounts` consuming **one account per fill**: the maker's
//! canonical associated token account (ATA) for the payout mint. The payout
//! mint is fixed by the taker's side for the whole order:
//!
//!   * Bid taker (hit a resting ask) pays the maker USDC → canonical USDC ATA.
//!   * Ask taker (hit a resting bid) pays the maker Yes  → canonical Yes ATA.
//!
//! The account is bound to the maker's **canonical ATA**, derived on-chain via
//! [`get_associated_token_address`] and checked for an exact key match:
//!
//!   * key **≠** canonical ATA → **revert** ([`MeridianError::BadMakerAccount`]).
//!     The taker controls what it passes, so a non-canonical account is a
//!     malformed call; reverting means the taker can never force an honest
//!     maker into the skip path (the queue-priority griefing vector).
//!   * key **=** canonical ATA but not receivable (closed / frozen /
//!     uninitialized / not SPL-owned) → **skip** the fill and restore the
//!     maker's resting order. The maker genuinely can't be paid right now;
//!     this preserves the original ATA-close DoS fix.
//!   * key **=** canonical ATA and receivable → pay.
//!
//! The caller supplies one canonical ATA per fill in fill order (best price
//! first, FIFO within a price) by simulating the same match the program will
//! perform. Requiring the canonical ATA reverses the earlier "any maker-owned
//! token account" tolerance: makers must receive into their canonical ATA.
//!
//! For Anchor's `Accounts` struct we **box every SPL `Account<...>` field**
//! to avoid blowing the 4 KB SBPF stack — same workaround as `mint_pair`,
//! which the U4 unit had to introduce after hitting "Stack offset exceeded
//! max offset of 4096" warnings during `cargo build-sbf`.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::matching::book_side::{OrderEntry, Side};
use crate::matching::match_step::{match_step, OrderType, TakerOrder};
use crate::state::{Book, Config, Market, BOOK_DEPTH};

/// Per-tx hard cap on how many opposing entries one taker may walk.
///
/// Sized at 4 to leave ample CU headroom for the two PDA-signed CPIs each
/// fill emits plus the residual-post path (one more SPL Transfer in the
/// price-improvement-refund case). The plan's §U5 §"CU cap" docs this as
/// the AE2 path: any residual after the cap is treated as a partial fill,
/// and (for limit orders) the leftover quantity posts to the book.
pub const MAX_FILLS_PER_TX: usize = 4;

/// True iff `info` is a live SPL token account that can actually receive a
/// transfer right now: its data is the fixed token-account length and the
/// account-state byte is `Initialized` (1), not `Uninitialized`/closed (0)
/// or `Frozen` (2).
///
/// Why this exists: a transfer CPI to a frozen or closed account fails, and
/// a failed inner instruction aborts the ENTIRE transaction in the Solana
/// runtime — the calling program never gets an `Err` back to handle. So any
/// payout path that wants skip-and-continue semantics (place_order_inner's
/// maker payouts, settle_sweep's refunds) must detect un-receivable accounts
/// BEFORE issuing the CPI, not by inspecting its result. Callers pair this
/// predicate with a canonical-ATA key check (which binds the (owner, mint)
/// pair); this predicate adds the liveness dimension those callers can't get
/// from the address alone — notably the frozen case (a Circle-frozen USDC ATA
/// on mainnet) and the uninitialized/closed case.
///
/// SPL `spl_token::state::Account` is a fixed 165 bytes with the `state`
/// enum at offset 108. We read the byte directly rather than unpacking the
/// whole account to stay cheap and tolerant of garbage/closed data.
///
/// The account MUST be owned by the SPL Token program. Without this check the
/// predicate is a pure byte read that any account can spoof: a caller could
/// supply a 165-byte account owned by an arbitrary program with `mint`/
/// `authority`/`state` bytes forged to pass every check, yet `token::transfer`
/// (pinned to
/// classic Token) would then reject the foreign-owned account and fail the
/// CPI. Pinning the owner here keeps the un-payable account in the skip path
/// instead of letting it reach — and abort on — the transfer.
pub(crate) fn token_account_receivable(info: &AccountInfo) -> bool {
    info.owner == &anchor_spl::token::ID
        && matches!(info.try_borrow_data(), Ok(d) if d.len() >= 165 && d[108] == 1)
}

#[derive(Accounts)]
pub struct PlaceLimitOrder<'info> {
    /// Taker. Pays collateral up front; receives counter-asset on fill.
    #[account(mut)]
    pub user: Signer<'info>,

    /// Global config — read-only; we only need the pause flag and USDC mint.
    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    /// Market the book belongs to. Yes mint and settled-flag are read here.
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

    /// Zero-copy `Book` PDA. Loaded mutably for the match + insert.
    ///
    /// We use the plain `AccountLoader<Book>` rather than Anchor 1.0's
    /// `LazyAccount<Book>` because every code path in this instruction
    /// touches both sides (`bids` and `asks`) — the deferred-deserialize
    /// win of `LazyAccount` is marginal when the whole book is read each
    /// step. The plan §U5 §3 explicitly endorses this choice.
    #[account(
        mut,
        seeds = [Book::SEED_PREFIX, market.key().as_ref()],
        bump,
        constraint = book.load()?.market == market.key() @ MeridianError::Unauthorized,
    )]
    pub book: AccountLoader<'info, Book>,

    /// USDC escrow PDA owned by the per-market `mint_authority`.
    #[account(
        mut,
        seeds = [Market::USDC_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = config.usdc_mint,
        token::authority = mint_authority,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    /// Yes-token escrow PDA owned by the same `mint_authority`.
    #[account(
        mut,
        seeds = [Market::YES_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = mint_authority,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    /// Yes mint — only used to validate the escrow and maker ATAs.
    #[account(
        seeds = [Market::YES_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    /// User's USDC ATA. Source for Buy bids, destination for Sell-taker
    /// proceeds + price-improvement refunds.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// User's Yes ATA. Source for Sell asks, destination for Buy-taker
    /// fills.
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA used as the escrows' authority. Validated via the
    /// seed+bump pair below; signs every PDA-side transfer this instruction
    /// emits.
    #[account(
        seeds = [Market::MINT_AUTH_SEED_PREFIX, market.key().as_ref()],
        bump = market.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

/// `place_limit_order` arguments.
///
/// `side` is encoded as `u8` (0 = Bid, 1 = Ask) because matching's `Side`
/// enum isn't `AnchorSerialize`. The handler maps the byte to [`Side`].
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PlaceLimitOrderArgs {
    /// 0 = Bid (Buy Yes), 1 = Ask (Sell Yes). Any other value rejected.
    pub side: u8,
    /// Limit price in USDC microunits per Yes token.
    pub price: u64,
    /// Quantity in Yes-token base units.
    pub qty: u64,
}

pub fn place_limit_order_handler<'info>(
    ctx: Context<'info, PlaceLimitOrder<'info>>,
    args: PlaceLimitOrderArgs,
) -> Result<()> {
    place_order_inner(
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
        OrderType::Limit,
        args.price,
        args.qty,
    )?;
    Ok(())
}

/// Result of a [`place_order_inner`] call.
///
/// U5 callers (`place_limit_order_handler`, `place_market_order_handler`)
/// ignore the payload — the on-chain state and post-state is the spec.
/// U6 (`buy_no` / `sell_no`) uses `residual_qty` to enforce **atomic
/// full-fill on the market leg**: if the market sell/buy can't fill the
/// requested `amount` within `slippage_bound`, U6 reverts the whole
/// instruction rather than letting the user end up with a partial position.
#[derive(Clone, Copy, Debug)]
pub struct OrderOutcome {
    /// How much of the taker order was filled (in Yes-token base units).
    pub filled_qty: u64,
    /// How much of the taker order was NOT filled. For limit orders this
    /// is the qty that got posted to the book. For market orders this is
    /// the qty that was refunded/skipped (no posting).
    pub residual_qty: u64,
}

/// Shared place-order kernel.
///
/// Routes the appropriate collateral, runs `match_step` (capped at
/// [`MAX_FILLS_PER_TX`]), settles each fill via PDA-signed CPIs, refunds
/// any price-improvement (Buy taker), and either posts the residual
/// (limit) or rejects it (market). Returns `Ok(())` regardless of whether
/// any fills happened — caller distinguishes via the on-chain emitted
/// events / post-state.
///
/// `side_byte` is the taker's side encoded as 0=Bid / 1=Ask.
#[allow(clippy::too_many_arguments)]
pub(crate) fn place_order_inner<'info>(
    config: &Account<'info, Config>,
    market: &Account<'info, Market>,
    book_loader: &AccountLoader<'info, Book>,
    usdc_escrow: &Account<'info, TokenAccount>,
    yes_escrow: &Account<'info, TokenAccount>,
    user_usdc: &Account<'info, TokenAccount>,
    user_yes: &Account<'info, TokenAccount>,
    mint_authority: &UncheckedAccount<'info>,
    user: &Signer<'info>,
    token_program: &Program<'info, Token>,
    remaining: &[AccountInfo<'info>],
    side_byte: u8,
    order_type: OrderType,
    price: u64,
    qty: u64,
) -> Result<OrderOutcome> {
    require!(!config.paused, MeridianError::ProgramPaused);
    require!(!market.settled, MeridianError::MarketSettled);
    // Halt price-discovery trading at expiry. This single guard covers every
    // trading path — place_limit_order, place_market_order, and buy_no/sell_no
    // (which compose this kernel). Par operations (burn_pair) and exits
    // (cancel_order) intentionally stay open so positions can still be unwound
    // between expiry and settlement.
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp < market.expiry_unix,
        MeridianError::MarketExpired
    );
    require!(qty > 0, MeridianError::InvalidAmount);
    // For limit orders: price=0 is a reserved sentinel in `OrderKey`.
    // For market orders: the parameter carries the slippage bound and must
    // also be > 0 (a zero bound means "any price", which we don't support —
    // callers should pass the loosest realistic bound: `u64::MAX` for a
    // bid taker or `1` for an ask taker). Same check, same error.
    require!(price > 0, MeridianError::InvalidAmount);

    let side = match side_byte {
        0 => Side::Bid,
        1 => Side::Ask,
        _ => return Err(MeridianError::InvalidAmount.into()),
    };

    let token_program_id = token_program.key();
    let market_key = market.key();
    let bump = market.mint_authority_bump;

    // -------- Step 1: deposit taker collateral up-front. --------
    //
    // The escrow is the one that signs every PDA outflow below. Routing
    // collateral here keeps the maker payout loop simple — every USDC
    // outflow comes from the USDC escrow, every Yes outflow comes from
    // the Yes escrow, regardless of taker side.
    match side {
        Side::Bid => {
            // Taker is buying Yes for USDC. Up-front lock = qty * price.
            let lock = (qty as u128)
                .checked_mul(price as u128)
                .ok_or(MeridianError::InvalidAmount)?;
            require!(lock <= u64::MAX as u128, MeridianError::InvalidAmount);
            let lock = lock as u64;
            token::transfer(
                CpiContext::new(
                    token_program_id,
                    Transfer {
                        from: user_usdc.to_account_info(),
                        to: usdc_escrow.to_account_info(),
                        authority: user.to_account_info(),
                    },
                ),
                lock,
            )?;
        }
        Side::Ask => {
            // Taker is selling Yes for USDC. Up-front lock = qty Yes.
            token::transfer(
                CpiContext::new(
                    token_program_id,
                    Transfer {
                        from: user_yes.to_account_info(),
                        to: yes_escrow.to_account_info(),
                        authority: user.to_account_info(),
                    },
                ),
                qty,
            )?;
        }
    }

    // -------- Step 2: match against opposing side. --------
    //
    // We collect the fills into a small owned vector so the PDA-signed
    // CPIs below don't need to hold a borrow on the book account. The
    // book itself stays under the RefMut for the match step only.
    let user_owner_bytes = user.key().to_bytes();
    let taker = TakerOrder {
        side,
        order_type,
        limit_price: price,
        qty,
        owner: user_owner_bytes,
    };

    // Plan §U5 §7: cap match iterations so CU and the
    // `remaining_accounts` window stay bounded. We accomplish this by
    // **temporarily truncating** the opposing side to the first
    // MAX_FILLS_PER_TX entries before invoking match_step, then restoring
    // the truncated tail afterwards. This is structurally cleaner than
    // teaching `match_step` about a max-iterations parameter — the engine
    // stays caller-agnostic, and the residual semantics fall out for free
    // (any unmatched qty becomes a normal post-or-reject residual).
    //
    // Concretely: stash entries past the cap into a small fixed array
    // and shrink `len`; run the match; re-append the survivors. Because
    // the opposing side is sorted best-first, entries beyond the cap are
    // strictly worse-priced than anything we'd match against, so this
    // doesn't change which makers fill.
    let MatchOutcome {
        fills,
        mut residual_qty,
    } = {
        let mut book = book_loader.load_mut()?;
        let opposite = match side {
            Side::Bid => &mut book.asks,
            Side::Ask => &mut book.bids,
        };
        match_capped(opposite, taker)?
    };

    // -------- Step 3: settle fills. --------
    //
    // For each fill we expect ONE remaining_account: the maker's canonical
    // associated token account for the payout mint, in fill order.
    //   * Bid taker (hit a resting ask) pays the maker USDC → canonical USDC ATA.
    //   * Ask taker (hit a resting bid) pays the maker Yes  → canonical Yes ATA.
    //
    // The taker only ever pays makers on one mint, so a single payout account
    // per fill is sufficient (the old two-account `[usdc, yes]` pair carried a
    // dead slot and an extra force-skip surface).
    //
    // Each payout account is bound to the maker's CANONICAL ATA: we derive it
    // on-chain and require an exact key match. A non-canonical account is a
    // malformed call by the taker and REVERTS — the taker can no longer force
    // an honest maker into the skip path by supplying a deliberately-bad
    // account (that was the queue-priority griefing vector). A canonical ATA
    // that is closed/frozen/uninitialized still SKIPS (the maker genuinely
    // can't be paid right now), which preserves the original ATA-close DoS fix.
    require!(
        remaining.len() >= fills.fill_count,
        MeridianError::InvalidAmount,
    );

    // The mint the maker is paid in is fixed by the taker's side for the whole
    // order (every fill on the opposing side pays the same mint).
    let payout_mint = match side {
        Side::Bid => config.usdc_mint,
        Side::Ask => market.yes_mint,
    };
    let seeds: &[&[u8]] = &[
        Market::MINT_AUTH_SEED_PREFIX,
        market_key.as_ref(),
        core::slice::from_ref(&bump),
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    let mut filled_qty_total: u128 = 0;
    let mut filled_notional_total: u128 = 0;

    // Fills whose maker can't be paid (closed / wrong payout account). The
    // maker's resting order was already consumed by match_step but its
    // collateral was never moved, so we restore the order afterward and fold
    // the qty into the taker's residual. This is the ATA-close DoS fix for the
    // trading path: a maker who rests a best-priced order then closes their
    // payout ATA can no longer force every crossing taker to revert — the
    // taker skips past them, and matching at that level resumes once the maker
    // has a valid account again.
    let opposite_side = side.opposite();
    let mut skipped: Vec<OrderEntry> = Vec::new();
    let mut skipped_qty: u64 = 0;

    for i in 0..fills.fill_count {
        let fill = fills.fills[i];
        let maker_pubkey = Pubkey::new_from_array(fill.maker_owner);
        let maker_payout = &remaining[i];

        // Bind the payout to the maker's CANONICAL ATA. The taker controls the
        // accounts it passes, so a non-canonical account is a malformed call:
        // REVERT (the taker only harms its own tx). This is what makes the
        // force-skip griefing impossible — there is no bad-but-accepted account
        // the taker can substitute for an honest maker.
        let canonical = get_associated_token_address(&maker_pubkey, &payout_mint);
        require!(
            maker_payout.key() == canonical,
            MeridianError::BadMakerAccount
        );

        // The canonical ATA exists in the address space but may be closed,
        // uninitialized, frozen, or not SPL-owned. `token_account_receivable`
        // pins the SPL Token owner and checks the account-state byte; if it
        // can't receive a transfer right now, SKIP this maker (don't revert) —
        // a failed transfer CPI would abort the whole taker tx, so the check
        // MUST precede the CPI. The maker's resting order is restored below.
        if !token_account_receivable(maker_payout) {
            skipped_qty = skipped_qty
                .checked_add(fill.qty)
                .ok_or(MeridianError::InvalidAmount)?;
            // seq is assigned a fresh value at re-insert time.
            skipped.push(OrderEntry {
                key: crate::matching::order_key::OrderKey::new(fill.price, 0),
                owner: fill.maker_owner,
                qty: fill.qty,
            });
            continue;
        }

        // Compute the per-fill notional once; both `filled_notional_total`
        // and the per-fill SPL transfer use it.
        let fill_notional_u128 = (fill.qty as u128) * (fill.price as u128);
        filled_qty_total += fill.qty as u128;
        filled_notional_total += fill_notional_u128;

        require!(fill_notional_u128 <= u64::MAX as u128, MeridianError::InvalidAmount);
        let fill_notional = fill_notional_u128 as u64;

        match side {
            Side::Bid => {
                // Taker bid hit a resting ask: maker had qty Yes escrowed
                // (from when they placed their ask); we pay the maker
                // USDC from escrow and pay the taker Yes from escrow.
                //
                // USDC escrow → maker's canonical USDC ATA.
                token::transfer(
                    CpiContext::new_with_signer(
                        token_program_id,
                        Transfer {
                            from: usdc_escrow.to_account_info(),
                            to: maker_payout.clone(),
                            authority: mint_authority.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    fill_notional,
                )?;
                // Yes escrow → user_yes.
                token::transfer(
                    CpiContext::new_with_signer(
                        token_program_id,
                        Transfer {
                            from: yes_escrow.to_account_info(),
                            to: user_yes.to_account_info(),
                            authority: mint_authority.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    fill.qty,
                )?;
            }
            Side::Ask => {
                // Taker ask hit a resting bid: maker had qty*price USDC
                // escrowed (from when they placed their bid); we pay the
                // maker Yes from escrow and pay the taker USDC from escrow.
                //
                // Yes escrow → maker's canonical Yes ATA.
                token::transfer(
                    CpiContext::new_with_signer(
                        token_program_id,
                        Transfer {
                            from: yes_escrow.to_account_info(),
                            to: maker_payout.clone(),
                            authority: mint_authority.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    fill.qty,
                )?;
                // USDC escrow → user_usdc.
                token::transfer(
                    CpiContext::new_with_signer(
                        token_program_id,
                        Transfer {
                            from: usdc_escrow.to_account_info(),
                            to: user_usdc.to_account_info(),
                            authority: mint_authority.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    fill_notional,
                )?;
            }
        }
    }

    // Restore skipped makers' orders with fresh sequence numbers (they go to
    // the back of their price level). With the canonical-ATA binding above, a
    // skip now only happens when the maker's OWN canonical ATA is genuinely
    // closed/frozen — a taker can no longer force the skip, so this is no
    // longer a griefing-induced demotion. Sending the genuinely-unpayable
    // maker to the back is the right DoS-avoidance behavior: it stops a maker
    // with a closed ATA from pinning the price level for everyone else.
    // Their collateral is still escrowed, so the book stays consistent. Fold
    // the skipped qty into the residual so the taker's unfilled portion is
    // refunded (market) or posts (limit) by the existing step-4/step-5
    // machinery — a skipped fill is economically identical to
    // unfilled qty from the taker's side.
    if !skipped.is_empty() {
        let mut book = book_loader.load_mut()?;
        for mut entry in skipped.drain(..) {
            let seq = book.next_seq()?;
            entry.key = crate::matching::order_key::OrderKey::new(entry.key.price(), seq);
            let side_ref = match opposite_side {
                Side::Bid => &mut book.bids,
                Side::Ask => &mut book.asks,
            };
            side_ref
                .insert(opposite_side, entry)
                .map_err(|_| MeridianError::BookFull)?;
        }
    }
    residual_qty = residual_qty
        .checked_add(skipped_qty)
        .ok_or(MeridianError::InvalidAmount)?;

    // -------- Step 4: price-improvement refund (Buy taker only). --------
    //
    // For a Buy bid the taker pre-deposited `qty * price` USDC. If some
    // fills crossed at a maker price strictly below the taker's limit
    // the difference `(price - fill.price) * fill.qty` belongs to the
    // taker. Refund it before the residual posts so the residual locks
    // only what it needs (`residual_qty * price`).
    //
    // For a Sell ask the taker pre-deposited `qty` Yes. Filled qty was
    // already transferred out as Yes (to maker); unfilled qty stays
    // escrowed for the residual. No price-improvement refund applies on
    // the Yes leg — the engine's "Side::Ask: maker_price >= taker.limit_price"
    // means the taker receives at least limit_price * qty USDC, and the
    // USDC leg of each fill was already sent to the taker at the maker
    // price (which is >= limit), i.e. the taker keeps the improvement
    // implicitly.
    if side == Side::Bid && filled_qty_total > 0 {
        let filled_qty = filled_qty_total as u64;
        let want_at_limit = (filled_qty as u128) * (price as u128);
        // `checked_sub` instead of `saturating_sub`: every Bid fill respects
        // `fill.price <= taker.price` (engine invariant), so
        // `filled_notional_total <= want_at_limit`. A `None` here would mean
        // the matching engine returned a fill at a maker price worse than
        // the taker's limit — surface that as a loud `InvariantBroken`
        // rather than silently flooring the refund to zero.
        let refund = want_at_limit
            .checked_sub(filled_notional_total)
            .ok_or(MeridianError::InvariantBroken)?;
        if refund > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    token_program_id,
                    Transfer {
                        from: usdc_escrow.to_account_info(),
                        to: user_usdc.to_account_info(),
                        authority: mint_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                refund as u64,
            )?;
        }
    }

    // -------- Step 5: residual handling. --------
    //
    // Limit order: any unfilled qty posts to the book. Collateral for the
    // residual stays escrowed (already deposited in step 1; we already
    // refunded the price-improvement above so the remaining USDC at this
    // point is exactly `residual_qty * price` for a Buy, or `residual_qty`
    // Yes for a Sell).
    //
    // Market order: residual is rejected; refund the unfilled collateral.
    if residual_qty > 0 {
        match order_type {
            OrderType::Limit => {
                let mut book = book_loader.load_mut()?;
                let seq = book.next_seq()?;
                let entry = OrderEntry {
                    key: crate::matching::order_key::OrderKey::new(price, seq),
                    owner: user_owner_bytes,
                    qty: residual_qty,
                };
                let side_mut = match side {
                    Side::Bid => &mut book.bids,
                    Side::Ask => &mut book.asks,
                };
                side_mut
                    .insert(side, entry)
                    .map_err(|_| MeridianError::BookFull)?;
                msg!(
                    "place_limit_order: posted residual price={} seq={} qty={}",
                    price,
                    seq,
                    residual_qty,
                );
            }
            OrderType::Market => {
                // Refund the unfilled collateral the taker pre-deposited.
                match side {
                    Side::Bid => {
                        // Pre-deposit was `qty * price`. After steps 3+4:
                        //   * step 3 paid `filled_notional_total` to makers
                        //   * step 4 refunded `filled_qty * price -
                        //     filled_notional_total` to the taker (price
                        //     improvement)
                        // So escrow now holds `qty*price -
                        // filled_qty*price = residual_qty * price`, which
                        // is exactly the residual refund the taker should
                        // get back at the limit_price (= slippage_bound).
                        let refund = (residual_qty as u128)
                            .checked_mul(price as u128)
                            .ok_or(MeridianError::InvalidAmount)?;
                        require!(refund <= u64::MAX as u128, MeridianError::InvalidAmount);
                        let refund = refund as u64;
                        if refund > 0 {
                            token::transfer(
                                CpiContext::new_with_signer(
                                    token_program_id,
                                    Transfer {
                                        from: usdc_escrow.to_account_info(),
                                        to: user_usdc.to_account_info(),
                                        authority: mint_authority.to_account_info(),
                                    },
                                    signer_seeds,
                                ),
                                refund,
                            )?;
                        }
                    }
                    Side::Ask => {
                        // Refund residual Yes from escrow to taker.
                        token::transfer(
                            CpiContext::new_with_signer(
                                token_program_id,
                                Transfer {
                                    from: yes_escrow.to_account_info(),
                                    to: user_yes.to_account_info(),
                                    authority: mint_authority.to_account_info(),
                                },
                                signer_seeds,
                            ),
                            residual_qty,
                        )?;
                    }
                }
            }
        }
    }

    // `checked_sub`: matching engine guarantees `residual_qty <= qty`. A
    // wrap would mean the engine corrupted its accounting — surface loudly.
    let filled_qty = qty
        .checked_sub(residual_qty)
        .ok_or(MeridianError::InvariantBroken)?;
    Ok(OrderOutcome {
        filled_qty,
        residual_qty,
    })
}

/// Result of [`match_capped`].
///
/// We use a fixed-size buffer rather than `arrayvec` here to keep the
/// instruction's deps the same as before. `fill_count` indexes into
/// `fills[..fill_count]`.
struct MatchOutcome {
    fills: FillBuffer,
    residual_qty: u64,
}

struct FillBuffer {
    fills: [crate::matching::match_step::Fill; MAX_FILLS_PER_TX],
    fill_count: usize,
}

/// Run a single match step, capped at [`MAX_FILLS_PER_TX`] resting entries.
///
/// **How the cap is enforced.** The engine's `match_step` always walks
/// from the front of the opposing side and stops at the first
/// non-crossing entry. We don't want to consume more than
/// `MAX_FILLS_PER_TX` opposing entries, so we temporarily shrink the
/// visible `len` via `BookSide::trim_to`, call `match_step` (which only
/// walks `entries[..len]`), then slide the hidden tail forward via
/// `BookSide::restore_tail`. Because the opposing side is sorted
/// best-first, entries beyond the cap are strictly worse-priced than
/// anything we'd match against, so the outcome is identical to capping
/// inside the engine.
///
/// This zero-copy in/out dance avoids a ~1.8 KB stack-allocated stash
/// array that previously blew the SBPF 4 KB stack budget once enough
/// callers (boxed accounts + composed instructions like `buy_no`/
/// `sell_no`) shared the frame.
fn match_capped(
    opposite: &mut crate::matching::book_side::BookSide<BOOK_DEPTH>,
    taker: TakerOrder,
) -> Result<MatchOutcome> {
    let prior_len = opposite.trim_to(MAX_FILLS_PER_TX);
    let result = match_step(taker, opposite)
        .map_err(|_| MeridianError::InvalidAmount)?;
    opposite.restore_tail(prior_len, MAX_FILLS_PER_TX);

    let mut buf = FillBuffer {
        fills: [crate::matching::match_step::Fill {
            maker_owner: [0; 32],
            price: 0,
            qty: 0,
            fully_consumed: false,
        }; MAX_FILLS_PER_TX],
        fill_count: 0,
    };
    let count = result.fills.len();
    debug_assert!(count <= MAX_FILLS_PER_TX);
    // Single memcpy of the matched fills (at most MAX_FILLS_PER_TX entries).
    buf.fills[..count].copy_from_slice(&result.fills.as_slice()[..count]);
    buf.fill_count = count;

    Ok(MatchOutcome {
        fills: buf,
        residual_qty: result.residual_qty,
    })
}

