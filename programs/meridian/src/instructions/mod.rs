//! Instruction handlers + `Accounts` structs.
//!
//! Each instruction is in its own file. The `#[program]` module in
//! `lib.rs` thin-wraps each handler so the public Anchor surface stays
//! readable. Units landed so far:
//!
//!   * U3:
//!     * [`initialize_config`] — singleton Config bootstrap.
//!     * [`create_strike_market`] — admin-only per-strike market init
//!       (Market + Book + Yes/No mints + USDC/Yes escrows + mint-auth PDA).
//!   * U4:
//!     * [`mint_pair`] — deposit USDC → mint Yes + No to caller.
//!     * [`burn_pair`] — burn Yes + No → return USDC to caller.
//!   * U5:
//!     * [`place_limit_order`] — bid/ask resting order with up-front
//!       collateral and capped post-match settlement.
//!     * [`place_market_order`] — same shape but residual is rejected.
//!     * [`cancel_order`] — owner-only remove + refund by stable
//!       `OrderKey`.
//!   * U6:
//!     * [`buy_no`] — atomic mint_pair + market-sell-Yes; user ends
//!       holding `amount` No tokens with the Yes leg off-loaded.
//!     * [`sell_no`] — atomic market-buy-Yes + burn_pair; symmetric
//!       Sell-No exit returning USDC immediately.
//!   * U7:
//!     * [`settle_market`] — read Pyth oracle, stamp outcome, set
//!       `settled = true` (R15a, atomic via Solana write-lock).
//!     * [`settle_sweep`] — public crank that drains resting orders
//!       on a settled market and refunds escrowed collateral (R15b).
//!     * [`redeem`] — winning-token holders burn for $1 USDC; no
//!       deadline.

pub mod admin;
pub mod admin_force_expire_order;
pub mod burn_pair;
pub mod buy_no;
pub mod cancel_order;
pub mod create_strike_market;
pub mod initialize_config;
pub mod mint_pair;
pub mod place_limit_order;
pub mod place_market_order;
pub mod redeem;
pub mod sell_no;
pub mod settle_market;
pub mod settle_sweep;

// Re-export the `Accounts` structs and arg types only; each handler is
// invoked via its module path in `lib.rs` so the per-module `handler`
// symbols don't collide in this namespace.
pub use admin::{AdminSettleMarket, SetPaused};
pub use burn_pair::BurnPair;
pub use buy_no::{BuyNo, BuyNoArgs};
pub use cancel_order::{CancelOrder, CancelOrderArgs};
pub use create_strike_market::{CreateStrikeMarket, CreateStrikeMarketArgs};
pub use initialize_config::InitializeConfig;
pub use mint_pair::MintPair;
pub use place_limit_order::{PlaceLimitOrder, PlaceLimitOrderArgs};
pub use place_market_order::{PlaceMarketOrder, PlaceMarketOrderArgs};
pub use redeem::Redeem;
pub use sell_no::{SellNo, SellNoArgs};
pub use settle_market::SettleMarket;
pub use settle_sweep::{SettleSweep, SettleSweepArgs};
