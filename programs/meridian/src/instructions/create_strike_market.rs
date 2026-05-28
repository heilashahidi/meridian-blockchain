//! `create_strike_market` — admin-only per-strike market initialization.
//!
//! Per plan §U3, initializes in a single instruction:
//!
//!   * Market PDA (`[b"market", ticker, strike_le, expiry_le]`)
//!   * Book PDA — zero-copy (`[b"book", market.key().as_ref()]`)
//!   * Yes mint + No mint, both with `mint::authority = mint_authority_pda`
//!     (`[b"mint_auth", market.key().as_ref()]`)
//!   * USDC escrow token account (`[b"usdc_escrow", market.key().as_ref()]`)
//!   * Yes escrow token account (`[b"yes_escrow", market.key().as_ref()]`)
//!
//! Plan §U3 contemplates splitting this into two instructions if the CU
//! budget can't accommodate all six init paths; at depth 32 the Book is
//! 3640 bytes which Anchor 1.0 initializes comfortably, so one
//! instruction is fine for the demo.
//!
//! `mint_authority_pda` is a bare PDA — there's no account at that
//! address. Anchor doesn't validate it via an `#[account(...)]` entry; we
//! re-derive it on every mint/burn/transfer signing path and pass the
//! bump (cached on `Market.mint_authority_bump`) to `with_signer`.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::MeridianError;
use crate::state::{Book, Config, Market};

#[derive(Accounts)]
#[instruction(args: CreateStrikeMarketArgs)]
pub struct CreateStrikeMarket<'info> {
    /// Admin signer. Must equal `config.admin`.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Global config — used only to authenticate the admin.
    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    /// Market PDA. Seed = `(ticker, strike, expiry)` so a second call for
    /// the same triple fails the PDA derivation.
    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [
            Market::SEED_PREFIX,
            args.ticker.as_ref(),
            &args.strike_price.to_le_bytes(),
            &args.expiry_unix.to_le_bytes(),
        ],
        bump,
    )]
    pub market: Account<'info, Market>,

    /// Order book PDA. Zero-copy because it carries `BookSide<32>`s.
    /// `space` is the `Book` data size plus Anchor's 8-byte discriminator.
    #[account(
        init,
        payer = admin,
        space = 8 + Book::DATA_SIZE,
        seeds = [Book::SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub book: AccountLoader<'info, Book>,

    /// Yes-token mint. Mint authority is the per-market PDA; freeze
    /// authority is unset (mints can't be frozen — keeps the design
    /// simple at the cost of an option we don't need for the demo).
    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = mint_authority,
        seeds = [Market::YES_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Account<'info, Mint>,

    /// No-token mint. Same authority pattern as `yes_mint`.
    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = mint_authority,
        seeds = [Market::NO_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub no_mint: Account<'info, Mint>,

    /// CHECK: PDA used as the mint authority for `yes_mint` / `no_mint`
    /// and the owner of the escrow token accounts below. No account data
    /// stored at this address — the seed + bump pair *is* the identity.
    #[account(
        seeds = [Market::MINT_AUTH_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// USDC escrow — receives buy-side resting collateral and any
    /// mint_pair / settlement deposits. Owned by `mint_authority` PDA.
    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = mint_authority,
        seeds = [Market::USDC_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub usdc_escrow: Account<'info, TokenAccount>,

    /// Yes-token escrow — receives sell-side resting Yes inventory.
    /// Owned by the same `mint_authority` PDA.
    #[account(
        init,
        payer = admin,
        token::mint = yes_mint,
        token::authority = mint_authority,
        seeds = [Market::YES_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub yes_escrow: Account<'info, TokenAccount>,

    /// USDC mint — must match the one pinned in `config`.
    #[account(
        address = config.usdc_mint @ MeridianError::Unauthorized,
    )]
    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Arguments to `create_strike_market`.
///
/// Bundled into a single struct so the PDA-seed derivation in the
/// `#[instruction(...)]` macro stays readable.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct CreateStrikeMarketArgs {
    /// 8-byte right-padded ASCII ticker (e.g. `b"META\0\0\0\0"`).
    pub ticker: [u8; 8],
    /// Strike price in USDC microunits.
    pub strike_price: u64,
    /// Expiry as a unix timestamp (seconds since epoch).
    pub expiry_unix: i64,
    /// Pyth `PriceUpdateV2` feed id for the underlying.
    pub pyth_feed_id: [u8; 32],
}

pub fn create_strike_market_handler(
    ctx: Context<CreateStrikeMarket>,
    args: CreateStrikeMarketArgs,
) -> Result<()> {
    // Reject paused config — admin still authenticates, but creating new
    // markets during a global pause is almost certainly a misconfig.
    require!(!ctx.accounts.config.paused, MeridianError::ProgramPaused);

    let market = &mut ctx.accounts.market;
    market.bump = ctx.bumps.market;
    market.mint_authority_bump = ctx.bumps.mint_authority;
    market.settled = false;
    market.ticker = args.ticker;
    market.strike_price = args.strike_price;
    market.expiry_unix = args.expiry_unix;
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.sweep_cursor = 0;
    market.outcome = None;
    market.pyth_feed_id = args.pyth_feed_id;

    let market_key = market.key();
    let book_loader = &ctx.accounts.book;
    let mut book = book_loader.load_init()?;
    book.market = market_key;
    book.next_seq = 1;
    // `bids` and `asks` start zeroed — `BookSide::Pod` impl guarantees the
    // all-zero pattern is a valid empty side (len=0, all-zero entries).

    Ok(())
}
