//! Per-market `Book` account — zero-copy wrapper around two
//! [`BookSide<BOOK_DEPTH>`]s.
//!
//! Per plan §U3:
//!   * `#[account(zero_copy)]` because the book can exceed 10KB with
//!     larger depth (currently well under at depth 32).
//!   * PDA seed `[b"book", market.key().as_ref()]`.
//!   * Contains `bids`, `asks`, and a shared `next_seq` sequencer the
//!     program bumps on every place so resting orders get monotonically
//!     increasing seq numbers across both sides.
//!
//! ## Layout size
//!
//! `OrderEntry` is 56 bytes (`OrderKey { u64, u64 } = 16` + `[u8; 32]` +
//! `u64`), `BookSide<32>` is `8 + 32 * 56 = 1800` bytes, so the inner
//! `Book` data is `32 + 2 * 1800 + 8 = 3640` bytes. Anchor's
//! 8-byte discriminator brings the on-chain account size to 3648 bytes,
//! well under the 10KB account-init limit — the plan's "split into two
//! instructions" fallback is **not** needed at this depth.
//!
//! A `const _` assertion below pins this size so a future field addition
//! that would silently bloat the account fails the build.

use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::matching::book_side::BookSide;

/// Book depth per side. Per plan Deferred §"Exact bounded depth per side":
/// start with N=32 and adjust based on benchmarks. U3 ships at 32.
pub const BOOK_DEPTH: usize = 32;

/// Order book for a single market.
///
/// Zero-copy via Anchor's `#[account(zero_copy)]` — `Book` is `Pod` (the
/// hand-written impls live on `BookSide` and `OrderEntry` in the matching
/// module). The two sides are read/written via `AccountLoader<Book>` and
/// `load_mut()` at instruction time.
#[account(zero_copy)]
#[repr(C)]
pub struct Book {
    /// The Market PDA this book belongs to. Used as a cross-check when
    /// instructions take both Market and Book accounts.
    pub market: Pubkey,
    /// Bid side — best (highest price) first, FIFO within a price.
    pub bids: BookSide<BOOK_DEPTH>,
    /// Ask side — best (lowest price) first, FIFO within a price.
    pub asks: BookSide<BOOK_DEPTH>,
    /// Monotonically-increasing sequence number, shared across both sides.
    /// The program bumps this on every place so resting orders within a
    /// price level keep FIFO order across cancels and partial fills.
    pub next_seq: u64,
}

impl Book {
    /// PDA seed prefix.
    pub const SEED_PREFIX: &'static [u8] = b"book";

    /// Static byte size of the **data** portion (excluding Anchor's 8-byte
    /// account discriminator). Used by the `init` constraint in
    /// `create_strike_market`.
    pub const DATA_SIZE: usize = core::mem::size_of::<Self>();

    /// Allocate the next sequence number, bumping the in-account counter.
    /// Called by every order-placement instruction so resting orders get
    /// a stable FIFO tiebreak across price levels.
    ///
    /// Returns an error on `u64` overflow rather than wrapping — `seq == 0`
    /// is reserved as an invalid sentinel by [`OrderKey`], so a silent wrap
    /// would collide with `OrderEntry::default()`'s zero-key slots and
    /// break the FIFO tiebreak invariant.
    ///
    /// [`OrderKey`]: crate::matching::order_key::OrderKey
    #[inline]
    pub fn next_seq(&mut self) -> Result<u64> {
        let n = self.next_seq;
        self.next_seq = self
            .next_seq
            .checked_add(1)
            .ok_or(MeridianError::InvariantBroken)?;
        Ok(n)
    }

}

// Pin the on-chain layout. If a future change to `OrderEntry` /
// `BookSide` / `Book` silently bloats the account, this assertion fires
// at compile time and surfaces the cost.
//
// Computed size: 32 (Pubkey) + 2 * 1800 (BookSide<32>) + 8 (next_seq) =
// 3640 bytes of data. Anchor adds 8 bytes of discriminator at the wire
// layer (not part of `size_of::<Book>()`).
const _: () = {
    assert!(
        Book::DATA_SIZE == 3640,
        "Book data size drifted from the U3 baseline of 3640 bytes — \
         update create_strike_market's init space accordingly."
    );
};
