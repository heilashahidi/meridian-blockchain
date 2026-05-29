//! `admin_force_expire_order` — admin recovery of a permanently-stuck order's
//! collateral after settlement.
//!
//! Closes the PR #3 residual: a settled market with an order whose owner's
//! canonical ATA is permanently un-receivable (indefinite freeze, abandoned
//! wallet, closed-and-never-reopened ATA) never fully drains via `settle_sweep`
//! — the entry cycles to the back of its side forever and its escrowed
//! collateral is locked. This admin-gated instruction removes one such order
//! and moves its collateral to the `Config.treasury` for off-chain custody, so
//! a settled market can always reach a fully-drained, reconciled end-state.
//!
//! # Narrowly-scoped admin power (the safety linchpin)
//!
//! This must not let an admin confiscate a *healthy* order. Three guards keep
//! the power narrow:
//!   1. **Settled + grace.** Only after the market is settled AND
//!      `now >= settled_at + RECOVERY_GRACE_SECONDS` (30 days). The owner has
//!      the whole window to un-freeze / re-open their ATA so the normal sweep
//!      pays them first.
//!   2. **Stuck-ness proof.** The owner pubkey is read from the order entry on
//!      the book (never admin-supplied). We derive that owner's canonical ATA
//!      on-chain and require the supplied `owner_ata` to BE it and to be
//!      currently un-receivable. A receivable canonical ATA → `OrderNotStuck`
//!      (the order should drain through `settle_sweep`, not here).
//!   3. **Treasury binding.** The destination must be `Config.treasury`'s
//!      canonical ATA for the recovered mint (`InvalidTreasuryAccount`).
//!
//! # Invariants
//!
//! Removing the order drops total open-order notional by its notional, and the
//! transfer drops escrow by the same amount → R13 (`escrow == Σ open notional`)
//! stays balanced; the funds are now treasury-custodied, no longer escrow-owed.
//! Yes collateral is moved as a raw transfer (no mint/burn) → Yes/No supply
//! parity (R14) is untouched. Mirrors `cancel_order`'s removal + refund shape,
//! but admin-gated and treasury-destined.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::instructions::admin::RECOVERY_GRACE_SECONDS;
use crate::matching::book_side::{OrderId, Side};
use crate::matching::order_key::OrderKey;
use crate::state::{Book, Config, Market};
use crate::token_util::{is_canonical_ata, token_account_receivable};

#[derive(Accounts)]
pub struct AdminForceExpireOrder<'info> {
    /// Admin authority. Must equal `config.admin`.
    pub admin: Signer<'info>,

    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::Unauthorized,
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

    /// USDC escrow PDA. Source for recovered bid collateral.
    #[account(
        mut,
        seeds = [Market::USDC_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = config.usdc_mint,
        token::authority = mint_authority,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    /// Yes escrow PDA. Source for recovered ask collateral.
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

    /// CHECK: stuck-ness proof — the order owner's canonical ATA for the payout
    /// mint. Read-only; validated in the handler to be the canonical ATA (the
    /// owner is taken from the book entry, never from here) AND to be currently
    /// un-receivable. Never receives funds.
    pub owner_ata: UncheckedAccount<'info>,

    /// CHECK: recovery destination — `Config.treasury`'s canonical ATA for the
    /// recovered mint. Validated in the handler.
    #[account(mut)]
    pub treasury_ata: UncheckedAccount<'info>,

    /// CHECK: per-market mint-authority PDA; signs the recovery transfer.
    #[account(
        seeds = [Market::MINT_AUTH_SEED_PREFIX, market.key().as_ref()],
        bump = market.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

/// `admin_force_expire_order` arguments. `(side, price, seq)` identify the
/// specific stuck order, same convention as `cancel_order`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct AdminForceExpireOrderArgs {
    /// 0 = Bid, 1 = Ask.
    pub side: u8,
    /// Price half of the order's `OrderKey`.
    pub price: u64,
    /// Sequence half of the order's `OrderKey`.
    pub seq: u64,
}

/// Emitted when an admin recovers a stuck order's collateral to the treasury.
/// The off-chain custody ledger consumes this to track what an owner may later
/// reclaim.
#[event]
pub struct StuckOrderRecovered {
    pub market: Pubkey,
    pub owner: Pubkey,
    /// The recovered collateral's mint (USDC for a Bid, the market's Yes mint
    /// for an Ask) — so an off-chain custody ledger needn't re-derive it.
    pub mint: Pubkey,
    /// 0 = Bid (USDC recovered), 1 = Ask (Yes recovered).
    pub side: u8,
    pub price: u64,
    pub qty: u64,
    pub amount: u64,
}

pub fn admin_force_expire_order_handler(
    ctx: Context<AdminForceExpireOrder>,
    args: AdminForceExpireOrderArgs,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, MeridianError::ProgramPaused);
    require!(ctx.accounts.market.settled, MeridianError::MarketNotSettled);

    // Treasury must be a DISTINCT custody account, not the admin itself. The
    // treasury defaults to `admin` at `initialize_config`; recovering user
    // collateral to the admin's own ATA is a self-deal. Force operators to
    // rotate `set_treasury` to a dedicated account before any recovery.
    require!(
        ctx.accounts.config.treasury != ctx.accounts.config.admin,
        MeridianError::TreasuryNotConfigured
    );

    // Defense-in-depth: a settled market always has `settled_at` stamped by
    // both settle paths, but guard against a `settled_at == 0` market (e.g. a
    // future zero-filling migration of legacy settled markets) whose grace
    // window would otherwise resolve to 1970 and open instantly.
    require!(
        ctx.accounts.market.settled_at > 0,
        MeridianError::InvariantBroken
    );

    // Grace gate: measured from settlement, not expiry, so a delayed settlement
    // doesn't open the recovery window early. Overflow is only reachable for a
    // degenerate settled_at near i64::MAX — surface it loudly.
    let clock = Clock::get()?;
    let unlock = ctx
        .accounts
        .market
        .settled_at
        .checked_add(RECOVERY_GRACE_SECONDS)
        .ok_or(MeridianError::InvariantBroken)?;
    require!(
        clock.unix_timestamp >= unlock,
        MeridianError::RecoveryGraceNotElapsed
    );

    let side = match args.side {
        0 => Side::Bid,
        1 => Side::Ask,
        _ => return Err(MeridianError::InvalidAmount.into()),
    };
    let id = OrderId(OrderKey::new(args.price, args.seq));

    // The mint the order's collateral is denominated in: a resting Bid escrowed
    // USDC, a resting Ask escrowed Yes.
    let payout_mint = match side {
        Side::Bid => ctx.accounts.config.usdc_mint,
        Side::Ask => ctx.accounts.market.yes_mint,
    };

    let market_key = ctx.accounts.market.key();
    let bump = ctx.accounts.market.mint_authority_bump;
    let token_program_id = ctx.accounts.token_program.key();
    let treasury = ctx.accounts.config.treasury;

    // ---- Locate, prove stuck, validate destination — all BEFORE mutation. ----
    let (owner_bytes, order_qty, recovery_amount) = {
        let mut book = ctx.accounts.book.load_mut()?;

        let side_ref = match side {
            Side::Bid => &book.bids,
            Side::Ask => &book.asks,
        };
        let entry = side_ref
            .as_slice()
            .iter()
            .find(|e| e.key == id.0)
            .copied()
            .ok_or(MeridianError::OrderNotFound)?;

        let owner = Pubkey::new_from_array(entry.owner);

        // Stuck-ness proof. The owner comes from the book entry, not the admin.
        // The supplied `owner_ata` must BE that owner's canonical ATA for the
        // payout mint AND be currently un-receivable. A receivable canonical
        // ATA means the order can be paid normally → reject so the admin can't
        // confiscate a healthy order.
        require!(
            is_canonical_ata(&ctx.accounts.owner_ata.to_account_info(), &owner, &payout_mint)
                && !token_account_receivable(&ctx.accounts.owner_ata.to_account_info()),
            MeridianError::OrderNotStuck
        );

        // Destination must be the configured treasury's canonical ATA, and it
        // must be receivable RIGHT NOW — the transfer CPI below would otherwise
        // abort the whole tx with an opaque SPL error. A typed error tells the
        // operator to create/unfreeze the treasury ATA first.
        require!(
            is_canonical_ata(
                &ctx.accounts.treasury_ata.to_account_info(),
                &treasury,
                &payout_mint
            ),
            MeridianError::InvalidTreasuryAccount
        );
        require!(
            token_account_receivable(&ctx.accounts.treasury_ata.to_account_info()),
            MeridianError::TreasuryAtaNotReceivable
        );

        // All guards passed — remove the order.
        let side_mut = match side {
            Side::Bid => &mut book.bids,
            Side::Ask => &mut book.asks,
        };
        let removed = side_mut
            .cancel_by_id(side, id)
            .map_err(|_| MeridianError::OrderNotFound)?;
        debug_assert_eq!(removed.qty, entry.qty);
        debug_assert_eq!(removed.owner, entry.owner);

        // Collateral moving to the treasury (NOT refunded to the owner — that
        // is the whole point of recovery). Bid escrowed USDC = qty*price; Ask
        // escrowed Yes = qty.
        let recovery_amount = match side {
            Side::Bid => crate::token_util::bid_notional(removed.qty, removed.key.price())?,
            Side::Ask => removed.qty,
        };
        (entry.owner, removed.qty, recovery_amount)
    };

    // ---- Transfer the recovered collateral to the treasury. ----
    let seeds: &[&[u8]] = &[
        Market::MINT_AUTH_SEED_PREFIX,
        market_key.as_ref(),
        core::slice::from_ref(&bump),
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    let from = match side {
        Side::Bid => ctx.accounts.usdc_escrow.to_account_info(),
        Side::Ask => ctx.accounts.yes_escrow.to_account_info(),
    };
    token::transfer(
        CpiContext::new_with_signer(
            token_program_id,
            Transfer {
                from,
                to: ctx.accounts.treasury_ata.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            signer_seeds,
        ),
        recovery_amount,
    )?;

    emit!(StuckOrderRecovered {
        market: market_key,
        owner: Pubkey::new_from_array(owner_bytes),
        mint: payout_mint,
        side: args.side,
        price: args.price,
        qty: order_qty,
        amount: recovery_amount,
    });
    msg!(
        "admin_force_expire_order: recovered side={} price={} amount={} to treasury",
        args.side,
        args.price,
        recovery_amount,
    );

    Ok(())
}
