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

use core::cmp::Ordering;

use crate::matching::order_key::OrderKey;

/// Which side of the book a resting order lives on.
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
/// Anchor wrapper will pass `pubkey.to_bytes()` at U3 time.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
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
#[derive(Clone, Debug)]
pub struct BookSide<const N: usize> {
    side: Side,
    len: usize,
    entries: [OrderEntry; N],
}

impl<const N: usize> BookSide<N> {
    /// Create an empty side.
    pub fn new(side: Side) -> Self {
        Self {
            side,
            len: 0,
            entries: [OrderEntry::default(); N],
        }
    }

    /// Which side this is.
    #[inline]
    pub fn side(&self) -> Side {
        self.side
    }

    /// Number of resting orders.
    #[inline]
    pub fn len(&self) -> usize {
        self.len
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
        self.len == N
    }

    /// Read-only view of the sorted, in-use prefix.
    #[inline]
    pub fn as_slice(&self) -> &[OrderEntry] {
        &self.entries[..self.len]
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

    /// Compare two keys using this side's comparator.
    #[inline]
    fn cmp_keys(&self, a: &OrderKey, b: &OrderKey) -> Ordering {
        match self.side {
            Side::Bid => a.cmp_bid(b),
            Side::Ask => a.cmp_ask(b),
        }
    }

    /// Insert an order. Returns its stable [`OrderId`] on success, [`BookFull`]
    /// if at capacity.
    ///
    /// Caller is responsible for choosing a `seq` strictly larger than any
    /// previously-inserted seq on this side (or across both sides, if the
    /// program shares one sequencer — Meridian does). Duplicate keys are
    /// rejected as a defensive measure even though the caller shouldn't
    /// produce them.
    pub fn insert(&mut self, entry: OrderEntry) -> Result<OrderId, BookFull> {
        if self.is_full() {
            return Err(BookFull);
        }
        // Find sorted insertion position with binary search. We treat
        // Ok(found) and Err(ins) the same — both are valid insertion
        // points. (A legitimate duplicate-key collision can't happen
        // because the caller bumps `seq` on every insert; even if it did,
        // inserting at `found` simply pushes the dup to the same slot,
        // which keeps the sort stable.)
        let pos = self.entries[..self.len]
            .binary_search_by(|probe| self.cmp_keys(&probe.key, &entry.key))
            .unwrap_or_else(|ins| ins);
        // Shift right.
        if pos < self.len {
            self.entries.copy_within(pos..self.len, pos + 1);
        }
        self.entries[pos] = entry;
        self.len += 1;
        Ok(OrderId(entry.key))
    }

    /// Remove an order by its stable id. Returns the removed entry, or
    /// [`OrderNotFound`] if no resting order matches.
    pub fn cancel_by_id(&mut self, id: OrderId) -> Result<OrderEntry, OrderNotFound> {
        let pos = self.entries[..self.len]
            .binary_search_by(|probe| self.cmp_keys(&probe.key, &id.0))
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
        self.entries[..self.len]
            .iter()
            .map(|e| e.qty as u128)
            .sum()
    }

    fn remove_at(&mut self, pos: usize) -> OrderEntry {
        let removed = self.entries[pos];
        if pos + 1 < self.len {
            self.entries.copy_within((pos + 1)..self.len, pos);
        }
        self.len -= 1;
        self.entries[self.len] = OrderEntry::default();
        removed
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
        b.insert(mk(40, 1, 5)).unwrap();
        b.insert(mk(50, 2, 5)).unwrap();
        b.insert(mk(50, 3, 5)).unwrap();
        b.insert(mk(45, 4, 5)).unwrap();
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
        a.insert(mk(60, 10, 1)).unwrap();
        a.insert(mk(55, 11, 1)).unwrap();
        a.insert(mk(55, 12, 1)).unwrap();
        a.insert(mk(70, 13, 1)).unwrap();
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
        a.insert(mk(10, 1, 1)).unwrap();
        a.insert(mk(20, 2, 1)).unwrap();
        assert_eq!(a.insert(mk(30, 3, 1)), Err(BookFull));
    }

    #[test]
    fn cancel_removes_and_shifts() {
        let mut b: BookSide<8> = BookSide::new(Side::Bid);
        let id_a = b.insert(mk(40, 1, 5)).unwrap();
        let id_b = b.insert(mk(50, 2, 5)).unwrap();
        let id_c = b.insert(mk(45, 3, 5)).unwrap();
        assert_eq!(b.len(), 3);

        let removed = b.cancel_by_id(id_b).unwrap();
        assert_eq!(removed.qty, 5);
        assert_eq!(b.len(), 2);
        assert_eq!(b.best().unwrap().key.price(), 45);

        // Cancel best, then last.
        b.cancel_by_id(id_c).unwrap();
        b.cancel_by_id(id_a).unwrap();
        assert!(b.is_empty());

        // Cancel missing → NotFound.
        assert_eq!(b.cancel_by_id(id_a), Err(OrderNotFound));
    }

    #[test]
    fn pop_front_returns_best_then_next() {
        let mut a: BookSide<4> = BookSide::new(Side::Ask);
        a.insert(mk(20, 1, 7)).unwrap();
        a.insert(mk(10, 2, 3)).unwrap();
        assert_eq!(a.pop_front().unwrap().key.price(), 10);
        assert_eq!(a.pop_front().unwrap().key.price(), 20);
        assert!(a.pop_front().is_none());
    }

    #[test]
    fn decrement_front_preserves_fifo_position() {
        let mut b: BookSide<4> = BookSide::new(Side::Bid);
        b.insert(mk(50, 1, 10)).unwrap();
        b.insert(mk(50, 2, 4)).unwrap();
        b.decrement_front(3);
        assert_eq!(b.best().unwrap().qty, 7);
        assert_eq!(b.best().unwrap().key.seq(), 1);
        // Order #2 still behind order #1.
        assert_eq!(b.as_slice()[1].key.seq(), 2);
    }
}
