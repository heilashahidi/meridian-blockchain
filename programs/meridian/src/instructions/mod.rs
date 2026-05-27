//! Instruction handlers + `Accounts` structs.
//!
//! Each instruction is in its own file. The `#[program]` module in
//! `lib.rs` thin-wraps each handler so the public Anchor surface stays
//! readable. U3 ships:
//!
//!   * [`initialize_config`] — singleton Config bootstrap.
//!   * [`create_strike_market`] — admin-only per-strike market init
//!     (Market + Book + Yes/No mints + USDC/Yes escrows + mint-auth PDA).
//!
//! U4-U7 add the remaining handlers (mint_pair, burn_pair, order ops,
//! buy_no/sell_no, settle, redeem).

pub mod create_strike_market;
pub mod initialize_config;

// Re-export the `Accounts` structs and arg types only; each handler is
// invoked via its module path in `lib.rs` so the two `handler` symbols
// don't collide in this namespace.
pub use create_strike_market::{CreateStrikeMarket, CreateStrikeMarketArgs};
pub use initialize_config::InitializeConfig;
