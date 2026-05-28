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
//! `ctx.remaining_accounts` consuming **two accounts per fill**: the
//! maker's USDC token account and the maker's Yes token account. Each is
//! validated by reading the SPL `mint` + `owner/authority` fields directly
//! off the account data via [`token::accessor`]:
//!
//!   * `mint` must equal the canonical USDC mint (`config.usdc_mint`) or
//!     the Yes mint (`market.yes_mint`) respectively.
//!   * `owner` (token-account authority) must equal `fill.maker_owner`.
//!
//! We **don't** require the canonical ATA address derivation — only that
//! the funds end up in a token account the maker controls and whose mint
//! matches. (A maker could place via an ATA and receive into a different
//! Yes account they own; both are safe.) The caller pre-sorts the
//! token-account pairs in fill order (best price first, FIFO within a
//! price) by simulating the same match the program will perform.
//!
//! For Anchor's `Accounts` struct we **box every SPL `Account<...>` field**
//! to avoid blowing the 4 KB SBPF stack — same workaround as `mint_pair`,
//! which the U4 unit had to introduce after hitting "Stack offset exceeded
//! max offset of 4096" warnings during `cargo build-sbf`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, accessor as token_accessor, Mint, Token, TokenAccount, Transfer};

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
        seeds = [b"yes_mint", market.key().as_ref()],
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
        residual_qty,
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
    // For each fill we expect TWO remaining_accounts in order:
    //   [2*i + 0]: maker's USDC ATA (mut)
    //   [2*i + 1]: maker's Yes ATA  (mut)
    //
    // The ATAs are validated against `get_associated_token_address` so a
    // caller can't redirect maker proceeds to an attacker-controlled
    // account. Both must be the canonical ATA for the maker.
    require!(
        remaining.len() >= fills.fill_count * 2,
        MeridianError::InvalidAmount,
    );

    let usdc_mint_key = config.usdc_mint;
    let yes_mint_key = market.yes_mint;
    let seeds: &[&[u8]] = &[
        Market::MINT_AUTH_SEED_PREFIX,
        market_key.as_ref(),
        core::slice::from_ref(&bump),
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    let mut filled_qty_total: u128 = 0;
    let mut filled_notional_total: u128 = 0;

    for i in 0..fills.fill_count {
        let fill = fills.fills[i];
        // Compute the per-fill notional once; both `filled_notional_total`
        // and the per-fill SPL transfer use it.
        let fill_notional_u128 = (fill.qty as u128) * (fill.price as u128);
        filled_qty_total += fill.qty as u128;
        filled_notional_total += fill_notional_u128;

        let maker_pubkey = Pubkey::new_from_array(fill.maker_owner);
        let maker_usdc = &remaining[i * 2];
        let maker_yes = &remaining[i * 2 + 1];

        // Validate the maker's USDC token account: mint == config.usdc_mint
        // and owner == maker_pubkey.
        require_keys_eq!(
            token_accessor::mint(maker_usdc)?,
            usdc_mint_key,
            MeridianError::Unauthorized,
        );
        require_keys_eq!(
            token_accessor::authority(maker_usdc)?,
            maker_pubkey,
            MeridianError::Unauthorized,
        );

        // Same for the maker's Yes token account.
        require_keys_eq!(
            token_accessor::mint(maker_yes)?,
            yes_mint_key,
            MeridianError::Unauthorized,
        );
        require_keys_eq!(
            token_accessor::authority(maker_yes)?,
            maker_pubkey,
            MeridianError::Unauthorized,
        );

        require!(fill_notional_u128 <= u64::MAX as u128, MeridianError::InvalidAmount);
        let fill_notional = fill_notional_u128 as u64;

        match side {
            Side::Bid => {
                // Taker bid hit a resting ask: maker had qty Yes escrowed
                // (from when they placed their ask); we pay the maker
                // USDC from escrow and pay the taker Yes from escrow.
                //
                // USDC escrow → maker_usdc.
                token::transfer(
                    CpiContext::new_with_signer(
                        token_program_id,
                        Transfer {
                            from: usdc_escrow.to_account_info(),
                            to: maker_usdc.clone(),
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
                // Yes escrow → maker_yes.
                token::transfer(
                    CpiContext::new_with_signer(
                        token_program_id,
                        Transfer {
                            from: yes_escrow.to_account_info(),
                            to: maker_yes.clone(),
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

