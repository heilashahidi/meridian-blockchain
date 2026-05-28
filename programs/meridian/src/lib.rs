//! Meridian on-chain CLOB — Anchor program entry.
//!
//! As of U1 this crate is the Anchor program wrapper around the pure-Rust
//! matching engine that landed in U2 (commit `fd50d36`). The matching module
//! continues to live at `programs/meridian/src/matching/` and is intentionally
//! free of Solana / Anchor dependencies so that:
//!
//!   * unit tests still run in milliseconds (no LiteSVM / BPF startup),
//!   * `proptest` invariants can chew through 10K cases per `cargo test`,
//!   * a reviewer reading `programs/meridian/src/matching/` sees the
//!     microstructure-relevant code cleanly, without Anchor wiring noise.
//!
//! The `#[program]` module below is intentionally empty at U1 — instruction
//! handlers land in U3-U7. Pubkeys inside `matching::` are still `[u8; 32]`;
//! Anchor wrappers will pass `pubkey.to_bytes()` into the engine when those
//! instructions are added.

use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod matching;
pub mod state;

// Re-export the matching engine surface so future instruction modules
// (U3-U7) can `use crate::matching::...` or just `use crate::*` cleanly.
pub use matching::{
    book_side::{BookFull, BookSide, OrderEntry, OrderId, OrderNotFound, Side},
    match_step::{match_step, Fill, MatchError, MatchResult, OrderType, TakerOrder},
    order_key::OrderKey,
};

// Anchor's `#[program]` macro expects the generated `__client_accounts_*`
// modules (produced by `#[derive(Accounts)]`) at the crate root via
// `pub use crate::__client_accounts_<ix>::*;`. Re-exporting each
// instruction module's contents (including those generated modules)
// satisfies the macro without polluting the public API with the
// `handler` symbol collision (each module has its own `handler`).
pub use instructions::admin::*;
pub use instructions::burn_pair::*;
pub use instructions::buy_no::*;
pub use instructions::cancel_order::*;
pub use instructions::create_strike_market::*;
pub use instructions::initialize_config::*;
pub use instructions::mint_pair::*;
pub use instructions::place_limit_order::*;
pub use instructions::place_market_order::*;
pub use instructions::redeem::*;
pub use instructions::sell_no::*;
pub use instructions::settle_market::*;
pub use instructions::settle_sweep::*;

// Program keypair generated on first `anchor build`; lives on disk at
// `target/deploy/meridian-keypair.json` (gitignored) and is also reflected in
// the `[programs.*]` tables of `Anchor.toml`. Regenerate per environment if
// promoting to a fresh cluster.
declare_id!("6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX");

#[program]
pub mod meridian {
    //! U3 wired `initialize_config` and `create_strike_market`. U4 adds
    //! `mint_pair` and `burn_pair`. U5 adds `place_limit_order`,
    //! `place_market_order`, `cancel_order`. U6 adds `buy_no` and
    //! `sell_no` — the atomic single-tx Buy-No / Sell-No trade paths.
    //! U7 adds the remaining instructions (settle/redeem).
    use super::*;

    /// Bootstrap the singleton Config PDA. First caller becomes admin.
    ///
    /// `pyth_receiver` is the on-chain Pyth Receiver program ID that
    /// `settle_market` will validate against — operator-set so the same
    /// `.so` works on devnet (Pyth's real receiver), mainnet (same), and
    /// LiteSVM tests (`MERIDIAN_PROGRAM_ID`, since fixtures mint
    /// meridian-owned `PriceUpdateV2` accounts).
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        fee_authority: Pubkey,
        pyth_receiver: Pubkey,
    ) -> Result<()> {
        instructions::initialize_config::initialize_config_handler(
            ctx,
            fee_authority,
            pyth_receiver,
        )
    }

    /// Admin-only: flip the global `config.paused` kill switch. `true`
    /// pauses every user-facing instruction; `false` resumes. The only
    /// way to toggle the flag that `initialize_config` sets to `false`.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::admin::set_paused_handler(ctx, paused)
    }

    /// Admin-only: create a strike market (Market + Book + Yes/No mints
    /// + USDC/Yes escrows) for a `(ticker, strike, expiry)` triple.
    pub fn create_strike_market(
        ctx: Context<CreateStrikeMarket>,
        args: CreateStrikeMarketArgs,
    ) -> Result<()> {
        instructions::create_strike_market::create_strike_market_handler(ctx, args)
    }

    /// Deposit `amount` USDC into the per-market escrow and mint `amount`
    /// Yes + `amount` No tokens to the caller. Preserves the $1.00
    /// invariant `yes_supply == no_supply == usdc_escrow`.
    pub fn mint_pair(ctx: Context<MintPair>, amount: u64) -> Result<()> {
        instructions::mint_pair::mint_pair_handler(ctx, amount)
    }

    /// Burn `amount` Yes + `amount` No from the caller and return `amount`
    /// USDC from the per-market escrow. The symmetric inverse of `mint_pair`.
    pub fn burn_pair(ctx: Context<BurnPair>, amount: u64) -> Result<()> {
        instructions::burn_pair::burn_pair_handler(ctx, amount)
    }

    /// Place a price-time-priority limit order on the book. Partial fills
    /// settle inline against opposing makers (up to
    /// [`instructions::place_limit_order::MAX_FILLS_PER_TX`]); any residual
    /// posts to the caller's side with the engine's next sequence number.
    ///
    /// Maker ATAs (USDC + Yes per fill) must be supplied as
    /// `remaining_accounts` in fill order — see the module docs for the
    /// layout.
    pub fn place_limit_order<'info>(
        ctx: Context<'info, PlaceLimitOrder<'info>>,
        args: PlaceLimitOrderArgs,
    ) -> Result<()> {
        instructions::place_limit_order::place_limit_order_handler(ctx, args)
    }

    /// Place a market order — same matching flow as `place_limit_order`
    /// but any unfilled residual is refunded to the taker rather than
    /// posted. `slippage_bound` caps the worst price the taker accepts.
    pub fn place_market_order<'info>(
        ctx: Context<'info, PlaceMarketOrder<'info>>,
        args: PlaceMarketOrderArgs,
    ) -> Result<()> {
        instructions::place_market_order::place_market_order_handler(ctx, args)
    }

    /// Cancel a resting order by its stable [`matching::OrderKey`] `(price,
    /// seq)`. Owner-only; refunds the escrowed collateral to the owner's
    /// ATA.
    pub fn cancel_order(ctx: Context<CancelOrder>, args: CancelOrderArgs) -> Result<()> {
        instructions::cancel_order::cancel_order_handler(ctx, args)
    }

    /// Atomic "Buy No" — mint a Yes/No pair against USDC, then market-sell
    /// the Yes leg in the same tx. User ends holding `amount` No tokens
    /// + USDC proceeds from the Yes sale. Reverts atomically if the Yes
    /// sell leg can't fill the full `amount` within `min_yes_sell_price`.
    pub fn buy_no<'info>(
        ctx: Context<'info, BuyNo<'info>>,
        args: BuyNoArgs,
    ) -> Result<()> {
        instructions::buy_no::buy_no_handler(ctx, args)
    }

    /// Atomic "Sell No" — market-buy `amount` Yes, then burn the freshly
    /// bought Yes + a matching `amount` of the caller's existing No to
    /// reclaim `amount` USDC. Reverts atomically if the Yes buy leg can't
    /// fill the full `amount` within `max_yes_buy_price`. User's net USDC
    /// delta is `amount - sum(fill_price * fill_qty)`.
    pub fn sell_no<'info>(
        ctx: Context<'info, SellNo<'info>>,
        args: SellNoArgs,
    ) -> Result<()> {
        instructions::sell_no::sell_no_handler(ctx, args)
    }

    /// Read the Pyth `PriceUpdateV2` account and stamp the market's
    /// outcome (R15a). Public — anyone can call once the expiry is past
    /// and the oracle is fresh enough. Atomically sets
    /// `settled = true` + `outcome = Some(_)` so any subsequent reader
    /// sees the invariant `settled → outcome.is_some()`.
    pub fn settle_market(ctx: Context<SettleMarket>) -> Result<()> {
        instructions::settle_market::settle_market_handler(ctx)
    }

    /// Iteratively drain resting orders on a settled market and refund
    /// their escrowed collateral to the owners (R15b). Public crank;
    /// reentrant-safe across multiple calls. `max_orders = 0` is a no-op,
    /// as is calling on an already-empty book.
    pub fn settle_sweep<'info>(
        ctx: Context<'info, SettleSweep<'info>>,
        args: SettleSweepArgs,
    ) -> Result<()> {
        instructions::settle_sweep::settle_sweep_handler(ctx, args)
    }

    /// Burn `amount` of the **winning** token from the caller's ATA and
    /// PDA-signed transfer `amount` USDC from escrow back to the caller.
    /// Requires `market.settled` + `outcome.is_some()`. Caller-supplied
    /// `winning_mint` must match the outcome (`WrongRedeemMint` otherwise).
    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        instructions::redeem::redeem_handler(ctx, amount)
    }
}
