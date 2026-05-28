//! On-chain account state for the Meridian program.
//!
//! Three accounts in U3:
//!
//!   * [`config`] — singleton `Config` PDA at seed `[b"config"]`. Holds the
//!     admin authority, USDC mint, and global pause flag.
//!   * [`market`] — per-strike `Market` PDA. Holds settlement metadata,
//!     references to the Yes/No mints, and the Pyth feed id.
//!   * [`book`] — per-market `Book` PDA (zero-copy). Wraps two
//!     [`crate::matching::BookSide`]s and a shared sequence counter.
//!
//! `Outcome` lives in [`market`] (it's a Market-account field). The
//! per-order escrow record from the plan's U3 file list is intentionally
//! omitted — owner is carried inline on each `OrderEntry`, so the
//! signer-equality constraint on `cancel_order` (U5) is sufficient for R6.

pub mod book;
pub mod config;
pub mod market;
pub mod pyth;

pub use book::{Book, BOOK_DEPTH};
pub use config::Config;
pub use market::{Market, Outcome};
pub use pyth::{
    GetPriceError, Price, PriceFeedMessage, PriceUpdateV2, VerificationLevel,
};
