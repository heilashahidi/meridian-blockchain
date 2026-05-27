//! Meridian on-chain CLOB — matching engine module (U2).
//!
//! For U2 this crate is a **standalone pure-Rust library** with no Solana or
//! Anchor dependencies. When U1 (Anchor scaffolding) lands, this `lib.rs` will
//! become the Anchor program entry and `pub mod matching` will continue to
//! live at this exact path — see plan §"Implementation Units → U2".
//!
//! The matching engine is intentionally isolated from Solana types so that:
//!   * unit tests run in milliseconds (no LiteSVM / BPF startup),
//!   * `proptest` invariants can chew through 10K cases per `cargo test`,
//!   * a reviewer reading `programs/meridian/src/matching/` sees the
//!     microstructure-relevant code cleanly, without Anchor wiring noise.
//!
//! Pubkeys are represented as `[u8; 32]` for now. When the Anchor wrapper
//! lands at U1, the wrapper will pass `pubkey.to_bytes()` into this module.

#![forbid(unsafe_code)]
#![deny(rust_2018_idioms)]

pub mod matching;

pub use matching::{
    book_side::{BookFull, BookSide, OrderEntry, OrderId, OrderNotFound, Side},
    match_step::{match_step, Fill, MatchError, MatchResult, OrderType, TakerOrder},
    order_key::OrderKey,
};
