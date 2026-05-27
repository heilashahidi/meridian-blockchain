//! Packed `(price, seq)` order key.
//!
//! Concept ported from OpenBook v2 — see
//! `openbook-dex/openbook-v2/programs/openbook-v2/src/state/orderbook/nodes.rs`
//! and `…/ordertree.rs`, where the orderbook stores a `u128` key whose high
//! 64 bits are the price and whose low 64 bits are a per-side sequence
//! number. Natural `u128` ordering then provides:
//!
//!   * **price priority** — higher price ⇒ larger key, so a descending sort
//!     of the bid side and ascending sort of the ask side both bubble the
//!     best price to position 0;
//!   * **FIFO within a price** — at equal price, the order with the smaller
//!     `seq` (placed earlier) gets the smaller key, so ascending tiebreak by
//!     key matches first-in-first-out for asks; bids invert the price
//!     comparator but **also** want earliest-first within a level, which is
//!     why the bid comparator is "price DESC, seq ASC" rather than a plain
//!     reverse of the whole key (see [`OrderKey::cmp_bid`]).
//!
//! `price = 0` is reserved as an invalid sentinel (callers must reject zero
//! prices at instruction entry) so a freshly-zeroed `OrderEntry` can be
//! distinguished from a real order during fixed-array compaction.
//!
//! ## U3 layout
//!
//! U2 stored the key as a single `u128`. U3 needs `BookSide<N>` (which
//! contains `[OrderEntry; N]` which contains `OrderKey`) to be
//! `bytemuck::Pod` so it can live inside an `#[account(zero_copy)]` Anchor
//! account. `u128` is `Pod`, but it has 16-byte alignment, which forces
//! `OrderEntry` (otherwise an 8-byte-aligned struct) to have 8 bytes of
//! trailing padding — `Pod` rejects padding bytes.
//!
//! Splitting the key into two `u64` fields keeps the type 8-byte-aligned,
//! 16 bytes wide, padding-free, and `Pod` — while still letting the
//! comparator behave like a `u128` ordering via the conceptual
//! `(price as u128) << 64 | seq` mapping.

use core::cmp::Ordering;

/// `(price, seq)` order key.
///
/// Layout: `#[repr(C)] { price: u64, seq: u64 }`. Conceptually still the
/// packed-`u128` key of the U2 docs — see the module preamble for the
/// reason for the field split.
#[repr(C)]
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
    Hash,
    bytemuck::Pod,
    bytemuck::Zeroable,
)]
pub struct OrderKey {
    price: u64,
    seq: u64,
}

impl OrderKey {
    /// Construct from `(price, seq)`.
    #[inline]
    pub const fn new(price: u64, seq: u64) -> Self {
        Self { price, seq }
    }

    /// Extract the price half.
    #[inline]
    pub const fn price(self) -> u64 {
        self.price
    }

    /// Extract the sequence half.
    #[inline]
    pub const fn seq(self) -> u64 {
        self.seq
    }

    /// Comparator for the **ask** side: best (lowest) price first; within a
    /// price, earliest `seq` first.
    ///
    /// Equivalent to the U2 doc's "natural `u128` ordering on
    /// `(price << 64) | seq`": compare price first, then seq.
    #[inline]
    pub fn cmp_ask(&self, other: &Self) -> Ordering {
        match self.price.cmp(&other.price) {
            Ordering::Equal => self.seq.cmp(&other.seq),
            non_eq => non_eq,
        }
    }

    /// Comparator for the **bid** side: best (highest) price first; within a
    /// price, earliest `seq` first.
    ///
    /// Note: we cannot simply reverse the whole key ordering because that
    /// would also reverse the seq order, which would put **later** orders
    /// ahead at equal price and break FIFO. Compare price descending and
    /// seq ascending explicitly.
    #[inline]
    pub fn cmp_bid(&self, other: &Self) -> Ordering {
        match other.price.cmp(&self.price) {
            Ordering::Equal => self.seq.cmp(&other.seq),
            non_eq => non_eq,
        }
    }
}

// Anchor's `#[program]` macro emits IDL-builder calls on every type that
// ends up in an `#[account(zero_copy)]` field tree (see
// `anchor-syn::idl::accounts`). We're not interested in surfacing the
// matching engine's internal types in the IDL — they're plumbing — but
// they must satisfy `IdlBuild`. The default trait impl is empty and the
// trait lives behind the `idl-build` feature; both impls below are gated
// so non-IDL builds don't pull in any extra deps.
#[cfg(feature = "idl-build")]
impl anchor_lang::IdlBuild for OrderKey {}

#[cfg(test)]
mod order_key_tests {
    use super::*;

    #[test]
    fn pack_unpack_roundtrip() {
        let k = OrderKey::new(40_000, 7);
        assert_eq!(k.price(), 40_000);
        assert_eq!(k.seq(), 7);
    }

    #[test]
    fn pack_extremes() {
        let k = OrderKey::new(u64::MAX, u64::MAX);
        assert_eq!(k.price(), u64::MAX);
        assert_eq!(k.seq(), u64::MAX);

        let z = OrderKey::new(0, 0);
        assert_eq!(z.price(), 0);
        assert_eq!(z.seq(), 0);
    }

    #[test]
    fn ask_natural_order_is_price_then_seq() {
        let a = OrderKey::new(40, 1);
        let b = OrderKey::new(40, 2);
        let c = OrderKey::new(41, 1);
        assert!(a.cmp_ask(&b).is_lt());
        assert!(a.cmp_ask(&c).is_lt());
        assert!(c.cmp_ask(&b).is_gt());
    }

    #[test]
    fn bid_order_is_price_desc_seq_asc() {
        // Best bid is highest price; FIFO within price.
        let a = OrderKey::new(50, 1);
        let b = OrderKey::new(50, 2);
        let c = OrderKey::new(49, 1);
        assert!(a.cmp_bid(&b).is_lt(), "earlier seq at same price wins on bid");
        assert!(a.cmp_bid(&c).is_lt(), "higher price wins on bid");
        assert!(c.cmp_bid(&b).is_gt());
    }
}
