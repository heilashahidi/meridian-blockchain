//! `mint_pair` — atomically deposit `amount * ONE_USDC` USDC into the per-market
//! escrow PDA and mint `amount` Yes + `amount` No tokens to the caller.
//!
//! Per plan §U4: this is the **forward** half of the $1.00 USDC ↔ 1 Yes +
//! 1 No primitive that the demo's whole settlement story rests on. Each token
//! is collateralized at **$1.00 (`ONE_USDC` µUSDC)** — the PRD's "Yes token
//! pays $1.00" and "Vault = $1.00 × pairs" — which is the same unit the order
//! book prices in (`[0, ONE_USDC]`). Every mint_pair preserves the invariant
//!
//! ```text
//! usdc_escrow.amount == yes_mint.supply * ONE_USDC == no_mint.supply * ONE_USDC
//! ```
//!
//! provided no other path can create Yes/No or move USDC out of escrow
//! without burning the pair. U5/U6 enforce that on the order-book side
//! (escrowed Yes only ever moves between users via book matches, and
//! escrowed USDC only ever returns via `burn_pair` / `redeem`).
//!
//! # Composition with U6
//!
//! U6's `buy_no` and `sell_no` instructions need to invoke mint/burn-pair
//! atomically with an order-book leg. To make that possible without going
//! through a self-CPI, the actual logic lives in [`mint_pair_inner`] —
//! a free function that takes the individual `Account` references rather
//! than a full `Context`. The Anchor `#[program]` entry point
//! ([`mint_pair_handler`]) is a thin wrapper that unpacks `ctx.accounts`
//! and forwards.
//!
//! Pattern (per plan U6 §"Approach"):
//!
//! ```ignore
//! pub(crate) fn mint_pair_inner<'info>(
//!     market: &Account<'info, Market>,
//!     user_usdc: &Account<'info, TokenAccount>,
//!     usdc_escrow: &Account<'info, TokenAccount>,
//!     yes_mint: &Account<'info, Mint>,
//!     no_mint: &Account<'info, Mint>,
//!     user_yes: &Account<'info, TokenAccount>,
//!     user_no: &Account<'info, TokenAccount>,
//!     mint_authority: &AccountInfo<'info>,
//!     user: &Signer<'info>,
//!     token_program: &Program<'info, Token>,
//!     amount: u64,
//! ) -> Result<()> { ... }
//! ```

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::state::{Config, Market};

/// Mint-pair `Accounts`.
///
/// **Boxed-account note.** `Account<'info, Mint>` and
/// `Account<'info, TokenAccount>` are large (160 + 165 bytes Borsh-deserialized
/// into stack-resident structs); with nine of them in this struct the
/// generated `try_accounts` function blew the BPF VM's 4 KB stack budget
/// when verified with `cargo build-sbf` (the warning is "Stack offset of
/// N exceeded max offset of 4096" and runtime behaviour is undefined).
/// `Box<Account<...>>` moves the deserialized payload to the heap, dropping
/// the per-account stack cost to one pointer. This is the same workaround
/// the OpenBook v2 `place_order.rs` uses. Keep it for any future
/// instruction that takes more than ~5 SPL token accounts at once.
#[derive(Accounts)]
pub struct MintPair<'info> {
    /// Caller — pays USDC, receives Yes + No.
    #[account(mut)]
    pub user: Signer<'info>,

    /// Global config — read-only here; we only need the pause flag.
    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    /// Market this mint pair belongs to. The Yes/No mints and the
    /// mint-authority PDA are validated against the fields on this account.
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

    /// User's USDC source ATA — must hold ≥ `amount` USDC. Mint check
    /// happens via the `token::mint = config.usdc_mint` constraint.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// USDC escrow PDA owned by the market's mint-authority PDA. Receives
    /// the `amount` USDC the user deposits.
    #[account(
        mut,
        seeds = [Market::USDC_ESCROW_SEED_PREFIX, market.key().as_ref()],
        bump,
        token::mint = config.usdc_mint,
        token::authority = mint_authority,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    /// Yes mint — `mint::authority = mint_authority` PDA.
    #[account(
        mut,
        seeds = [Market::YES_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    /// No mint — `mint::authority = mint_authority` PDA.
    #[account(
        mut,
        seeds = [Market::NO_MINT_SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    /// User's Yes-token ATA. Receives newly-minted Yes tokens.
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// User's No-token ATA. Receives newly-minted No tokens.
    #[account(
        mut,
        token::mint = no_mint,
        token::authority = user,
    )]
    pub user_no: Box<Account<'info, TokenAccount>>,

    /// CHECK: per-market mint-authority PDA. Validated via the seed +
    /// bump pair below; signs the two `mint_to` CPIs.
    #[account(
        seeds = [Market::MINT_AUTH_SEED_PREFIX, market.key().as_ref()],
        bump = market.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn mint_pair_handler(ctx: Context<MintPair>, amount: u64) -> Result<()> {
    mint_pair_inner(
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

/// Composition-friendly inner handler. See module docs for the shape
/// rationale (U6 invokes this directly with its own `Accounts` struct's
/// fields rather than re-entering through Anchor's dispatcher).
#[allow(clippy::too_many_arguments)]
pub(crate) fn mint_pair_inner<'info>(
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

    // Step 1: user transfers USDC into escrow (user signs).
    //
    // Anchor 1.0's `CpiContext::new` takes the program *Pubkey* (not
    // the program's `AccountInfo`) as the first argument — the underlying
    // token CPI helper hardcodes `&spl_token::ID` for the invoke, so the
    // value we pass here is informational. We pass `token_program.key()`
    // anyway for forward compatibility / clarity.
    let token_program_id = token_program.key();

    let cpi_accounts = Transfer {
        from: user_usdc.to_account_info(),
        to: usdc_escrow.to_account_info(),
        authority: user.to_account_info(),
    };
    // $1.00 of collateral per token (ONE_USDC µUSDC). The order book prices a
    // token in [0, ONE_USDC] µUSDC, so a token bought for ≤$1 there redeems for
    // exactly $1 here — the two unit systems agree (PRD vault invariant).
    let collateral = amount
        .checked_mul(crate::ONE_USDC)
        .ok_or(MeridianError::InvalidAmount)?;
    token::transfer(CpiContext::new(token_program_id, cpi_accounts), collateral)?;

    // Steps 2 + 3: mint Yes and No to user, PDA-signed.
    //
    // The mint-authority PDA is derived per market — its seeds are
    // `[MINT_AUTH_SEED_PREFIX, market.key(), &[bump]]`. We bind locals
    // here so the slice references stay alive across both CPI calls.
    let market_key = market.key();
    let bump = market.mint_authority_bump;
    let seeds: &[&[u8]] = &[
        Market::MINT_AUTH_SEED_PREFIX,
        market_key.as_ref(),
        core::slice::from_ref(&bump),
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    let mint_yes_accounts = MintTo {
        mint: yes_mint.to_account_info(),
        to: user_yes.to_account_info(),
        authority: mint_authority.to_account_info(),
    };
    token::mint_to(
        CpiContext::new_with_signer(token_program_id, mint_yes_accounts, signer_seeds),
        amount,
    )?;

    let mint_no_accounts = MintTo {
        mint: no_mint.to_account_info(),
        to: user_no.to_account_info(),
        authority: mint_authority.to_account_info(),
    };
    token::mint_to(
        CpiContext::new_with_signer(token_program_id, mint_no_accounts, signer_seeds),
        amount,
    )?;

    Ok(())
}
