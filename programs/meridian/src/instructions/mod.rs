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
//!
//! U5-U7 add the remaining handlers (order ops, buy_no/sell_no, settle,
//! redeem).

pub mod burn_pair;
pub mod create_strike_market;
pub mod initialize_config;
pub mod mint_pair;

// Re-export the `Accounts` structs and arg types only; each handler is
// invoked via its module path in `lib.rs` so the per-module `handler`
// symbols don't collide in this namespace.
pub use burn_pair::BurnPair;
pub use create_strike_market::{CreateStrikeMarket, CreateStrikeMarketArgs};
pub use initialize_config::InitializeConfig;
pub use mint_pair::MintPair;
