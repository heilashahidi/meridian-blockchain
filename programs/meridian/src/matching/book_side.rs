//! Fixed-depth sorted book side.
//!
//! See plan §U2 "Approach":
//!   * `BookSide<N>` stores up to `N` resting orders as a sorted array,
//!   * insert is binary-search + shift (O(log N) compare + O(N) shift, fine
//!     for small N — plan's working number is N=32 per side),
//!   * cancel-by-id is O(N) shift.
//!
//! The sort order depends on [`Side`]:
//!   * **Bid** — best (highest price) first, FIFO at equal price.
//!   * **Ask** — best (lowest price) first, FIFO at equal price.
//!
//! Pattern ported from OpenBook v2's `programs/openbook-v2/src/state/orderbook/`
//! (fixed-array node management).
//!
//! ## Zero-copy refactor (U3)
//!
//! U3 stores `BookSide<N>` inside an `#[account(zero_copy)]` Anchor account.
//! That requires the struct to be `bytemuck::Pod`, which in turn forbids
//! enum fields (no niche guarantees) and tag fields whose values are
//! constrained (e.g. only 0 or 1). The U2-era `BookSide` carried a
//! `side: Side` field for the comparator dispatch; U3 removes the field and
//! the caller passes `Side` into the methods that need it.
//!
//! The Anchor `Book` PDA pairs two `BookSide<N>` instances — one for bids,
//! one for asks — and the surrounding `Book` struct knows which is which by
//! position. Tests and any out-of-program callers pass the same explicit
//! `Side` they used to construct the side via [`BookSide::new`].

use core::cmp::Ordering;

use crate::matching::order_key::OrderKey;

/// Which side of the book a resting order lives on.
///
/// Note: this is *not* stored on `BookSide` itself (see module docs) — it
/// is passed by value into methods that need the comparator dispatch.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum Side {
    Bid,
    Ask,
}

impl Side {
    /// The opposing side a taker of this side would match against.
    #[inline]
    pub const fn opposite(self) -> Self {
        match self {
            Side::Bid => Side::Ask,
            Side::Ask => Side::Bid,
        }
    }
}

/// One resting order. `owner` is `[u8; 32]` for U2's no-Solana stance — the
/// Anchor wrapper passes `pubkey.to_bytes()` at U3 time.
///
/// `#[repr(C)]` + `Pod + Zeroable` so the entry can live inline in a
/// zero-copy `Book` account. The trailing `_pad` field aligns the struct to
/// 8 bytes (already true by layout — `u128 + [u8;32] + u64` = 56 bytes, all
/// 8-byte aligned — but the explicit `repr(C)` keeps the layout stable
/// across Rust versions).
#[repr(C)]
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
    bytemuck::Pod,
    bytemuck::Zeroable,
)]
pub struct OrderEntry {
    pub key: OrderKey,
    pub owner: [u8; 32],
    pub qty: u64,
}

/// Stable identifier for an order while it rests on the book.
///
/// This is the packed `(price, seq)` key — **not** an array index. The book
/// re-shifts on every insert/cancel/fill, so the array slot is not stable,
/// but `(price, seq)` is unique and fixed for the life of the order.
/// `cancel_by_id` looks it up via the side's comparator.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct OrderId(pub OrderKey);

/// Error returned by [`BookSide::insert`] when the side is at capacity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BookFull;

/// Error returned by [`BookSide::cancel_by_id`] when no resting order
/// matches the given id.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OrderNotFound;

/// A fixed-depth side of the book.
///
/// Holds up to `N` resting orders sorted best-first per [`Side`].
/// Empty slots beyond `len` are `OrderEntry::default()` but **not** indexed.
///
/// `len` is `u64` rather than `usize` so the layout is stable across host
/// (64-bit) and BPF (also 64-bit but Anchor's account ABI fixes the width
/// explicitly). The Pod derive requires this — `usize` isn't `Pod`.
///
/// `Pod` / `Zeroable` are implemented by hand below rather than via the
/// `bytemuck` derive macro. The derive macro can't prove a const-generic
/// array `[OrderEntry; N]` is `Pod` (it expands a `where` clause naming
/// the concrete field type), so we open-code the impls and rely on the
/// bytemuck library's blanket `impl<T: Pod, const N: usize> Pod for [T; N]`.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BookSide<const N: usize> {
    len: u64,
    entries: [OrderEntry; N],
}

// SAFETY: `BookSide<N>` is `#[repr(C)]`, contains only `Pod` fields
// (`u64` and `[OrderEntry; N]`), has no uninhabited types, and has no
// padding because both fields are 8-byte aligned and the struct's natural
// alignment is 8. `Zeroable` is satisfied because the all-zero byte
// pattern is a valid `BookSide` (len=0, all-zero entries) — equivalent to
// `BookSide::default()`.
unsafe impl<const N: usize> bytemuck::Zeroable for BookSide<N> {}
unsafe impl<const N: usize> bytemuck::Pod for BookSide<N> {}

// IDL-builder stub. See `order_key.rs` for the rationale — the matching
// engine's internal types are plumbing and don't need to surface in the
// generated IDL. The default trait body is empty, which is what we want.
#[cfg(feature = "idl-build")]
impl<const N: usize> anchor_lang::IdlBuild for BookSide<N> {}

#[cfg(feature = "idl-build")]
impl anchor_lang::IdlBuild for OrderEntry {}

impl<const N: usize> Default for BookSide<N> {
    fn default() -> Self {
        Self {
            len: 0,
            entries: [OrderEntry::default(); N],
        }
    }
}

impl<const N: usize> BookSide<N> {
    /// Create an empty side.
    ///
    /// `_side` is accepted for source-compatibility with the U2 API but is
    /// no longer stored — see module docs. Callers must pass the same side
    /// into any method that needs the comparator dispatch.
    pub fn new(_side: Side) -> Self {
        Self::default()
    }

    /// Number of resting orders.
    #[inline]
    pub fn len(&self) -> usize {
        self.len as usize
    }

    /// Capacity (the const generic).
    #[inline]
    pub const fn capacity(&self) -> usize {
        N
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    #[inline]
    pub fn is_full(&self) -> bool {
        self.len as usize == N
    }

    /// Read-only view of the sorted, in-use prefix.
    #[inline]
    pub fn as_slice(&self) -> &[OrderEntry] {
        &self.entries[..self.len as usize]
    }

    /// Best (front-of-book) entry, if any.
    #[inline]
    pub fn best(&self) -> Option<&OrderEntry> {
        if self.len == 0 {
            None
        } else {
            Some(&self.entries[0])
        }
    }

    /// Compare two keys using the given side's comparator.
    #[inline]
    fn cmp_keys(side: Side, a: &OrderKey, b: &OrderKey) -> Ordering {
        match side {
            Side::Bid => a.cmp_bid(b),
            Side::Ask => a.cmp_ask(b),
        }
    }

    /// Insert an order on the given `side`. Returns its stable [`OrderId`]
    /// on success, [`BookFull`] if at capacity.
    ///
    /// Caller is responsible for choosing a `seq` strictly larger than any
    /// previously-inserted seq on this side (or across both sides, if the
    /// program shares one sequencer — Meridian does). Duplicate keys are
    /// rejected as a defensive measure even though the caller shouldn't
    /// produce them.
    pub fn insert(&mut self, side: Side, entry: OrderEntry) -> Result<OrderId, BookFull> {
        if self.is_full() {
            return Err(BookFull);
        }
        // Find sorted insertion position with binary search. We treat
        // Ok(found) and Err(ins) the same — both are valid insertion
        // points. (A legitimate duplicate-key collision can't happen
        // because the caller bumps `seq` on every insert; even if it did,
        // inserting at `found` simply pushes the dup to the same slot,
        // which keeps the sort stable.)
        let len = self.len as usize;
        let pos = self.entries[..len]
            .binary_search_by(|probe| Self::cmp_keys(side, &probe.key, &entry.key))
            .unwrap_or_else(|ins| ins);
        // Shift right.
        if pos < len {
            self.entries.copy_within(pos..len, pos + 1);
        }
        self.entries[pos] = entry;
        self.len += 1;
        Ok(OrderId(entry.key))
    }

    /// Remove an order by its stable id on the given `side`. Returns the
    /// removed entry, or [`OrderNotFound`] if no resting order matches.
    pub fn cancel_by_id(
        &mut self,
        side: Side,
        id: OrderId,
    ) -> Result<OrderEntry, OrderNotFound> {
        let len = self.len as usize;
        let pos = self.entries[..len]
            .binary_search_by(|probe| Self::cmp_keys(side, &probe.key, &id.0))
            .map_err(|_| OrderNotFound)?;
        Ok(self.remove_at(pos))
    }

    /// Remove the front (best) entry. Returns the removed entry, or `None`
    /// if the side is empty.
    pub fn pop_front(&mut self) -> Option<OrderEntry> {
        if self.len == 0 {
            return None;
        }
        Some(self.remove_at(0))
    }

    /// Subtract `delta` from the front entry's qty in place. Caller has
    /// already verified `delta <= front.qty`. Used by the match path to
    /// preserve FIFO position when a resting order is only partially
    /// consumed.
    pub fn decrement_front(&mut self, delta: u64) {
        debug_assert!(self.len > 0);
        debug_assert!(self.entries[0].qty >= delta);
        self.entries[0].qty -= delta;
    }

    /// Add `delta` back onto the front entry's qty in place. The inverse of
    /// [`Self::decrement_front`]: used when a partial fill's maker payout is
    /// skipped, so the decremented remnant (still resting at the front)
    /// reabsorbs the unpaid qty rather than the caller inserting a duplicate
    /// entry. `delta` does not touch the key, so the sort order and FIFO
    /// position are preserved.
    ///
    /// Returns `None` on `u64` overflow rather than panicking — the caller
    /// maps that to a loud `InvariantBroken` (the restored qty equals the qty
    /// previously decremented from an originally-valid order, so overflow is
    /// unreachable in practice, but a typed error beats a BPF panic that the
    /// runtime reports as an indistinguishable program crash).
    #[must_use]
    pub fn increment_front(&mut self, delta: u64) -> Option<()> {
        debug_assert!(self.len > 0);
        self.entries[0].qty = self.entries[0].qty.checked_add(delta)?;
        Some(())
    }

    /// Front entry, mutable (for the match loop).
    #[inline]
    pub fn front_mut(&mut self) -> Option<&mut OrderEntry> {
        if self.len == 0 {
            None
        } else {
            Some(&mut self.entries[0])
        }
    }

    /// Sum of resting qty across the side. Used by tests / invariant checks.
    pub fn total_qty(&self) -> u128 {
        self.entries[..self.len as usize]
            .iter()
            .map(|e| e.qty as u128)
            .sum()
    }

    fn remove_at(&mut self, pos: usize) -> OrderEntry {
        let len = self.len as usize;
        let removed = self.entries[pos];
        if pos + 1 < len {
            self.entries.copy_within((pos + 1)..len, pos);
        }
        self.len -= 1;
        self.entries[self.len as usize] = OrderEntry::default();
        removed
    }

    /// Temporarily shrink the visible side to `cap` entries (or `len`,
    /// whichever is smaller) and return the prior `len`. The hidden tail
    /// at `entries[cap..prior_len]` stays in storage untouched — it is
    /// just out of the comparator's reach until [`Self::restore_tail`] is
    /// called.
    ///
    /// Designed for the U5 `match_capped` dance: cap matching to
    /// `MAX_FILLS_PER_TX` opposing entries without paying for a
    /// stack-allocated stash array (which on a 32-deep `BookSide` blows
    /// past the SBPF 4 KB stack budget).
    ///
    /// Caller MUST pair this with [`Self::restore_tail`] before the side
    /// is observed by any other code path, or the hidden entries are
    /// effectively lost. The matching kernel mutates `entries[..len]`
    /// only, so the hidden tail survives intact across `match_step`.
    pub fn trim_to(&mut self, cap: usize) -> usize {
        let prior_len = self.len as usize;
        self.len = (cap as u64).min(self.len);
        prior_len
    }

    /// Restore the tail hidden by [`Self::trim_to`]. `prior_len` is the
    /// value `trim_to` returned; `trimmed_cap` is the cap that was passed
    /// to `trim_to`.
    ///
    /// Between the two calls the visible `len` may have shrunk (engine
    /// pops) but never grown — so we slide the hidden tail forward to
    /// re-establish contiguity, then bump `len` by the tail count.
    pub fn restore_tail(&mut self, prior_len: usize, trimmed_cap: usize) {
        if prior_len <= trimmed_cap {
            return;
        }
        let tail_count = prior_len - trimmed_cap;
        let visible_len = self.len as usize;
        debug_assert!(visible_len <= trimmed_cap);
        if visible_len < trimmed_cap {
            // Slide the hidden tail forward into the gap left by popped
            // front entries.
            self.entries
                .copy_within(trimmed_cap..prior_len, visible_len);
        }
        self.len = (visible_len + tail_count) as u64;
    }
}

#[cfg(test)]
mod book_side_tests {
    use super::*;

    fn mk(price: u64, seq: u64, qty: u64) -> OrderEntry {
        OrderEntry {
            key: OrderKey::new(price, seq),
            owner: [0u8; 32],
            qty,
        }
    }

    #[test]
    fn empty_side_basics() {
        let b: BookSide<4> = BookSide::new(Side::Bid);
        assert!(b.is_empty());
        assert_eq!(b.len(), 0);
        assert!(b.best().is_none());
        assert_eq!(b.total_qty(), 0);
    }

    #[test]
    fn bid_sort_is_price_desc_seq_asc() {
        let mut b: BookSide<8> = BookSide::new(Side::Bid);
        b.insert(Side::Bid, mk(40, 1, 5)).unwrap();
        b.insert(Side::Bid, mk(50, 2, 5)).unwrap();
        b.insert(Side::Bid, mk(50, 3, 5)).unwrap();
        b.insert(Side::Bid, mk(45, 4, 5)).unwrap();
        let prices_and_seq: Vec<_> = b
            .as_slice()
            .iter()
            .map(|e| (e.key.price(), e.key.seq()))
            .collect();
        assert_eq!(prices_and_seq, vec![(50, 2), (50, 3), (45, 4), (40, 1)]);
    }

    #[test]
    fn ask_sort_is_price_asc_seq_asc() {
        let mut a: BookSide<8> = BookSide::new(Side::Ask);
        a.insert(Side::Ask, mk(60, 10, 1)).unwrap();
        a.insert(Side::Ask, mk(55, 11, 1)).unwrap();
        a.insert(Side::Ask, mk(55, 12, 1)).unwrap();
        a.insert(Side::Ask, mk(70, 13, 1)).unwrap();
        let prices_and_seq: Vec<_> = a
            .as_slice()
            .iter()
            .map(|e| (e.key.price(), e.key.seq()))
            .collect();
        assert_eq!(prices_and_seq, vec![(55, 11), (55, 12), (60, 10), (70, 13)]);
    }

    #[test]
    fn full_book_rejects() {
        let mut a: BookSide<2> = BookSide::new(Side::Ask);
        a.insert(Side::Ask, mk(10, 1, 1)).unwrap();
        a.insert(Side::Ask, mk(20, 2, 1)).unwrap();
        assert_eq!(a.insert(Side::Ask, mk(30, 3, 1)), Err(BookFull));
    }

    #[test]
    fn cancel_removes_and_shifts() {
        let mut b: BookSide<8> = BookSide::new(Side::Bid);
        let id_a = b.insert(Side::Bid, mk(40, 1, 5)).unwrap();
        let id_b = b.insert(Side::Bid, mk(50, 2, 5)).unwrap();
        let id_c = b.insert(Side::Bid, mk(45, 3, 5)).unwrap();
        assert_eq!(b.len(), 3);

        let removed = b.cancel_by_id(Side::Bid, id_b).unwrap();
        assert_eq!(removed.qty, 5);
        assert_eq!(b.len(), 2);
        assert_eq!(b.best().unwrap().key.price(), 45);

        // Cancel best, then last.
        b.cancel_by_id(Side::Bid, id_c).unwrap();
        b.cancel_by_id(Side::Bid, id_a).unwrap();
        assert!(b.is_empty());

        // Cancel missing → NotFound.
        assert_eq!(b.cancel_by_id(Side::Bid, id_a), Err(OrderNotFound));
    }

    #[test]
    fn pop_front_returns_best_then_next() {
        let mut a: BookSide<4> = BookSide::new(Side::Ask);
        a.insert(Side::Ask, mk(20, 1, 7)).unwrap();
        a.insert(Side::Ask, mk(10, 2, 3)).unwrap();
        assert_eq!(a.pop_front().unwrap().key.price(), 10);
        assert_eq!(a.pop_front().unwrap().key.price(), 20);
        assert!(a.pop_front().is_none());
    }

    #[test]
    fn decrement_front_preserves_fifo_position() {
        let mut b: BookSide<4> = BookSide::new(Side::Bid);
        b.insert(Side::Bid, mk(50, 1, 10)).unwrap();
        b.insert(Side::Bid, mk(50, 2, 4)).unwrap();
        b.decrement_front(3);
        assert_eq!(b.best().unwrap().qty, 7);
        assert_eq!(b.best().unwrap().key.seq(), 1);
        // Order #2 still behind order #1.
        assert_eq!(b.as_slice()[1].key.seq(), 2);
    }

    #[test]
    fn increment_front_inverts_decrement_and_preserves_position() {
        let mut b: BookSide<4> = BookSide::new(Side::Bid);
        b.insert(Side::Bid, mk(50, 1, 10)).unwrap();
        b.insert(Side::Bid, mk(50, 2, 4)).unwrap();
        b.decrement_front(3);
        b.increment_front(3).unwrap();
        // Front qty and seq restored to the original; second entry unmoved.
        assert_eq!(b.best().unwrap().qty, 10);
        assert_eq!(b.best().unwrap().key.seq(), 1);
        assert_eq!(b.as_slice()[1].key.seq(), 2);
        assert_eq!(b.len(), 2);
        assert_eq!(b.total_qty(), 14);
    }

    #[test]
    fn increment_front_on_single_entry_restores_qty() {
        let mut a: BookSide<4> = BookSide::new(Side::Ask);
        a.insert(Side::Ask, mk(30, 1, 5)).unwrap();
        a.decrement_front(2);
        assert_eq!(a.total_qty(), 3);
        a.increment_front(2).unwrap();
        assert_eq!(a.best().unwrap().qty, 5);
        assert_eq!(a.total_qty(), 5);
        assert_eq!(a.len(), 1);
    }

    #[test]
    fn increment_front_overflow_returns_none() {
        // u64 overflow yields None (caller maps to InvariantBroken) rather
        // than panicking. Unreachable in practice but defensively typed.
        let mut a: BookSide<4> = BookSide::new(Side::Ask);
        a.insert(Side::Ask, mk(10, 1, u64::MAX)).unwrap();
        assert_eq!(a.increment_front(1), None);
        // Front qty unchanged on the overflow no-op.
        assert_eq!(a.best().unwrap().qty, u64::MAX);
    }
}
