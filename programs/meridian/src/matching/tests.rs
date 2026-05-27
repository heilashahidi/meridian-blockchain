//! Property-based and scenario tests for the matching engine.
//!
//! Per plan §U2 "Execution note": **proptest invariants are the spec —
//! write them first, then implement until they pass.**
//!
//! The reference oracle is the simplest possible model of an order book:
//! a `Vec<OrderEntry>` for each side. After every operation against the
//! real `BookSide`, we apply the same operation to the oracle and assert:
//!
//!   1. **Sorted invariant** — the real book is sorted best-first per side
//!      with FIFO tiebreak.
//!   2. **Conservation** — sum of resting qty per side equals
//!      placed − cancelled − filled qty.
//!   3. **Match conservation** — for every `match_step`, sum of fill qty
//!      plus residual qty equals taker qty.
//!   4. **Limit respected** — every fill price respects the taker's limit
//!      (≤ for a bid taker, ≥ for an ask taker).
//!   5. **No negative qty** — `qty == 0` never appears in the in-use prefix
//!      (would indicate a partial-fill bug that didn't pop).

use proptest::prelude::*;

use crate::matching::book_side::{BookSide, OrderEntry, OrderId, Side};
use crate::matching::match_step::{match_step, OrderType, TakerOrder};
use crate::matching::order_key::OrderKey;

const N: usize = 16;

// ---------------------------------------------------------------------------
// Scenario tests (named, deterministic — complement the proptest invariants).
// ---------------------------------------------------------------------------

fn mk_entry(price: u64, seq: u64, qty: u64, owner_byte: u8) -> OrderEntry {
    OrderEntry {
        key: OrderKey::new(price, seq),
        owner: [owner_byte; 32],
        qty,
    }
}

#[test]
fn happy_one_bid_one_crossing_ask_clears_book() {
    let mut bids: BookSide<N> = BookSide::new(Side::Bid);
    bids.insert(mk_entry(40, 1, 100, 0xAA)).unwrap();
    let res = match_step(
        TakerOrder {
            side: Side::Ask,
            order_type: OrderType::Limit,
            limit_price: 40,
            qty: 100,
            owner: [0xBB; 32],
        },
        &mut bids,
    )
    .unwrap();
    assert!(bids.is_empty());
    assert_eq!(res.fills.len(), 1);
    assert_eq!(res.residual_qty, 0);
}

#[test]
fn fifo_three_same_price_then_large_ask() {
    let mut bids: BookSide<N> = BookSide::new(Side::Bid);
    bids.insert(mk_entry(40, 1, 10, 0x01)).unwrap();
    bids.insert(mk_entry(40, 2, 10, 0x02)).unwrap();
    bids.insert(mk_entry(40, 3, 10, 0x03)).unwrap();
    let res = match_step(
        TakerOrder {
            side: Side::Ask,
            order_type: OrderType::Limit,
            limit_price: 40,
            qty: 30,
            owner: [0xFF; 32],
        },
        &mut bids,
    )
    .unwrap();
    let order: Vec<u8> = res.fills.iter().map(|f| f.maker_owner[0]).collect();
    assert_eq!(order, vec![0x01, 0x02, 0x03]);
}

#[test]
fn no_match_residual_when_limit_below_best_ask() {
    let mut asks: BookSide<N> = BookSide::new(Side::Ask);
    asks.insert(mk_entry(50, 1, 10, 0xCC)).unwrap();
    let res = match_step(
        TakerOrder {
            side: Side::Bid,
            order_type: OrderType::Limit,
            limit_price: 40,
            qty: 10,
            owner: [0xDD; 32],
        },
        &mut asks,
    )
    .unwrap();
    assert!(res.fills.is_empty());
    assert_eq!(res.residual_qty, 10);
    assert_eq!(asks.len(), 1);
}

#[test]
fn cancel_then_match_skips_cancelled_order() {
    let mut bids: BookSide<N> = BookSide::new(Side::Bid);
    let id_a = bids.insert(mk_entry(50, 1, 10, 0xAA)).unwrap();
    let _id_b = bids.insert(mk_entry(50, 2, 10, 0xBB)).unwrap();
    bids.cancel_by_id(id_a).unwrap();
    // Taker should now match against BB (the only remaining order).
    let res = match_step(
        TakerOrder {
            side: Side::Ask,
            order_type: OrderType::Limit,
            limit_price: 50,
            qty: 10,
            owner: [0xCC; 32],
        },
        &mut bids,
    )
    .unwrap();
    assert_eq!(res.fills.len(), 1);
    assert_eq!(res.fills[0].maker_owner[0], 0xBB);
    assert!(bids.is_empty());
}

#[test]
fn place_into_full_book_returns_bookfull() {
    let mut a: BookSide<2> = BookSide::new(Side::Ask);
    a.insert(mk_entry(10, 1, 1, 0)).unwrap();
    a.insert(mk_entry(20, 2, 1, 0)).unwrap();
    assert!(a.insert(mk_entry(30, 3, 1, 0)).is_err());
}

#[test]
fn partial_fill_decrements_in_place_preserves_fifo() {
    let mut bids: BookSide<N> = BookSide::new(Side::Bid);
    bids.insert(mk_entry(50, 1, 10, 0xAA)).unwrap();
    bids.insert(mk_entry(50, 2, 10, 0xBB)).unwrap();
    let res = match_step(
        TakerOrder {
            side: Side::Ask,
            order_type: OrderType::Limit,
            limit_price: 50,
            qty: 3,
            owner: [0xCC; 32],
        },
        &mut bids,
    )
    .unwrap();
    assert_eq!(res.residual_qty, 0);
    assert_eq!(bids.as_slice()[0].qty, 7);
    assert_eq!(bids.as_slice()[0].key.seq(), 1);
    assert_eq!(bids.as_slice()[1].key.seq(), 2);
}

#[test]
fn invalid_price_and_qty_rejected() {
    let mut a: BookSide<N> = BookSide::new(Side::Ask);
    let zero_qty = match_step(
        TakerOrder {
            side: Side::Bid,
            order_type: OrderType::Limit,
            limit_price: 1,
            qty: 0,
            owner: [0; 32],
        },
        &mut a,
    );
    assert!(zero_qty.is_err());

    let zero_price = match_step(
        TakerOrder {
            side: Side::Bid,
            order_type: OrderType::Limit,
            limit_price: 0,
            qty: 1,
            owner: [0; 32],
        },
        &mut a,
    );
    assert!(zero_price.is_err());
}

#[test]
fn cancel_partially_filled_returns_remainder_only() {
    let mut bids: BookSide<N> = BookSide::new(Side::Bid);
    let id_a = bids.insert(mk_entry(50, 1, 10, 0xAA)).unwrap();
    // Partial fill of 4.
    match_step(
        TakerOrder {
            side: Side::Ask,
            order_type: OrderType::Limit,
            limit_price: 50,
            qty: 4,
            owner: [0xCC; 32],
        },
        &mut bids,
    )
    .unwrap();
    let removed = bids.cancel_by_id(id_a).unwrap();
    assert_eq!(removed.qty, 6); // 10 placed − 4 filled.
}

// ---------------------------------------------------------------------------
// Proptest invariants. Per plan U2, run at `cases = 10_000`.
// ---------------------------------------------------------------------------

/// Simulation model — the same operations applied to a dumb Vec.
///
/// `entries` is a mirror of the real book's resting orders, used only to
/// support the cancel-by-id codepath (we need to know which keys are alive
/// so the cancel op can target one). The `total_qty` invariant is checked
/// against the **real** `BookSide`, not this oracle, so we don't keep the
/// oracle's per-entry view sorted.
#[derive(Debug, Default, Clone)]
struct OracleSide {
    placed: u128,
    cancelled: u128,
    filled: u128,
    entries: Vec<OrderEntry>,
}

impl OracleSide {
    fn new(_side: Side) -> Self {
        Self::default()
    }
}

/// One step in a randomized scenario.
#[derive(Debug, Clone)]
enum Op {
    PlaceBid { price: u64, qty: u64, owner: u8 },
    PlaceAsk { price: u64, qty: u64, owner: u8 },
    CancelBid { index: usize },
    CancelAsk { index: usize },
    TakeBid { limit_price: u64, qty: u64, owner: u8, is_market: bool },
    TakeAsk { limit_price: u64, qty: u64, owner: u8, is_market: bool },
}

fn arb_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (1u64..=100, 1u64..=20, 0u8..8u8).prop_map(|(p, q, o)| Op::PlaceBid {
            price: p,
            qty: q,
            owner: o
        }),
        (1u64..=100, 1u64..=20, 0u8..8u8).prop_map(|(p, q, o)| Op::PlaceAsk {
            price: p,
            qty: q,
            owner: o
        }),
        (0usize..N).prop_map(|i| Op::CancelBid { index: i }),
        (0usize..N).prop_map(|i| Op::CancelAsk { index: i }),
        (1u64..=100, 1u64..=40, 0u8..8u8, any::<bool>()).prop_map(
            |(p, q, o, m)| Op::TakeBid {
                limit_price: p,
                qty: q,
                owner: o,
                is_market: m,
            }
        ),
        (1u64..=100, 1u64..=40, 0u8..8u8, any::<bool>()).prop_map(
            |(p, q, o, m)| Op::TakeAsk {
                limit_price: p,
                qty: q,
                owner: o,
                is_market: m,
            }
        ),
    ]
}

#[derive(Debug)]
struct Sim {
    bids: BookSide<N>,
    asks: BookSide<N>,
    bid_oracle: OracleSide,
    ask_oracle: OracleSide,
    next_seq: u64,
    /// Track outstanding `OrderId`s per side so cancel ops have a stable
    /// chance of hitting a real resting order.
    bid_ids: Vec<OrderId>,
    ask_ids: Vec<OrderId>,
}

impl Sim {
    fn new() -> Self {
        Self {
            bids: BookSide::new(Side::Bid),
            asks: BookSide::new(Side::Ask),
            bid_oracle: OracleSide::new(Side::Bid),
            ask_oracle: OracleSide::new(Side::Ask),
            next_seq: 1,
            bid_ids: Vec::new(),
            ask_ids: Vec::new(),
        }
    }

    fn apply(&mut self, op: &Op) {
        match *op {
            Op::PlaceBid { price, qty, owner } => {
                let entry = OrderEntry {
                    key: OrderKey::new(price, self.next_seq),
                    owner: [owner; 32],
                    qty,
                };
                self.next_seq += 1;
                if let Ok(id) = self.bids.insert(entry) {
                    self.bid_oracle.placed += qty as u128;
                    self.bid_oracle.entries.push(entry);
                    self.bid_ids.push(id);
                }
            }
            Op::PlaceAsk { price, qty, owner } => {
                let entry = OrderEntry {
                    key: OrderKey::new(price, self.next_seq),
                    owner: [owner; 32],
                    qty,
                };
                self.next_seq += 1;
                if let Ok(id) = self.asks.insert(entry) {
                    self.ask_oracle.placed += qty as u128;
                    self.ask_oracle.entries.push(entry);
                    self.ask_ids.push(id);
                }
            }
            Op::CancelBid { index } => {
                if self.bid_ids.is_empty() {
                    return;
                }
                let i = index % self.bid_ids.len();
                let id = self.bid_ids.remove(i);
                if let Ok(removed) = self.bids.cancel_by_id(id) {
                    self.bid_oracle.cancelled += removed.qty as u128;
                    // Find matching entry in oracle and remove.
                    if let Some(pos) =
                        self.bid_oracle.entries.iter().position(|e| e.key == id.0)
                    {
                        self.bid_oracle.entries.remove(pos);
                    }
                }
            }
            Op::CancelAsk { index } => {
                if self.ask_ids.is_empty() {
                    return;
                }
                let i = index % self.ask_ids.len();
                let id = self.ask_ids.remove(i);
                if let Ok(removed) = self.asks.cancel_by_id(id) {
                    self.ask_oracle.cancelled += removed.qty as u128;
                    if let Some(pos) =
                        self.ask_oracle.entries.iter().position(|e| e.key == id.0)
                    {
                        self.ask_oracle.entries.remove(pos);
                    }
                }
            }
            Op::TakeBid {
                limit_price,
                qty,
                owner,
                is_market,
            } => {
                let taker = TakerOrder {
                    side: Side::Bid,
                    order_type: if is_market {
                        OrderType::Market
                    } else {
                        OrderType::Limit
                    },
                    limit_price,
                    qty,
                    owner: [owner; 32],
                };
                if let Ok(res) = match_step(taker, &mut self.asks) {
                    // Per-match invariants.
                    let filled = res.filled_qty();
                    assert_eq!(filled + res.residual_qty as u128, qty as u128);
                    for f in &res.fills {
                        assert!(
                            f.price <= limit_price,
                            "taker bid filled at price {} above limit {}",
                            f.price,
                            limit_price
                        );
                        assert!(f.qty > 0);
                    }
                    self.ask_oracle.filled += filled;
                    // Rebuild ask oracle entries from real book to keep the
                    // ordering equivalence cheap.
                    self.ask_oracle.entries = self.asks.as_slice().to_vec();
                    self.ask_ids = self
                        .asks
                        .as_slice()
                        .iter()
                        .map(|e| OrderId(e.key))
                        .collect();
                }
            }
            Op::TakeAsk {
                limit_price,
                qty,
                owner,
                is_market,
            } => {
                let taker = TakerOrder {
                    side: Side::Ask,
                    order_type: if is_market {
                        OrderType::Market
                    } else {
                        OrderType::Limit
                    },
                    limit_price,
                    qty,
                    owner: [owner; 32],
                };
                if let Ok(res) = match_step(taker, &mut self.bids) {
                    let filled = res.filled_qty();
                    assert_eq!(filled + res.residual_qty as u128, qty as u128);
                    for f in &res.fills {
                        assert!(
                            f.price >= limit_price,
                            "taker ask filled at price {} below limit {}",
                            f.price,
                            limit_price
                        );
                        assert!(f.qty > 0);
                    }
                    self.bid_oracle.filled += filled;
                    self.bid_oracle.entries = self.bids.as_slice().to_vec();
                    self.bid_ids = self
                        .bids
                        .as_slice()
                        .iter()
                        .map(|e| OrderId(e.key))
                        .collect();
                }
            }
        }
    }

    fn check_invariants(&self) {
        // (1) Sorted invariant.
        for w in self.bids.as_slice().windows(2) {
            assert!(
                w[0].key.cmp_bid(&w[1].key).is_lt(),
                "bid side out of order: {:?}",
                self.bids.as_slice()
            );
            assert!(w[0].qty > 0, "bid side has a zero-qty entry");
        }
        for w in self.asks.as_slice().windows(2) {
            assert!(
                w[0].key.cmp_ask(&w[1].key).is_lt(),
                "ask side out of order: {:?}",
                self.asks.as_slice()
            );
            assert!(w[0].qty > 0, "ask side has a zero-qty entry");
        }
        // Front entry — also non-zero.
        if let Some(b) = self.bids.best() {
            assert!(b.qty > 0);
        }
        if let Some(a) = self.asks.best() {
            assert!(a.qty > 0);
        }

        // (2) Conservation per side.
        let bid_resting = self.bids.total_qty();
        let bid_expected = self.bid_oracle.placed
            - self.bid_oracle.cancelled
            - self.bid_oracle.filled;
        assert_eq!(
            bid_resting, bid_expected,
            "bid conservation broken: resting={} placed={} cancelled={} filled={}",
            bid_resting,
            self.bid_oracle.placed,
            self.bid_oracle.cancelled,
            self.bid_oracle.filled
        );
        let ask_resting = self.asks.total_qty();
        let ask_expected = self.ask_oracle.placed
            - self.ask_oracle.cancelled
            - self.ask_oracle.filled;
        assert_eq!(
            ask_resting, ask_expected,
            "ask conservation broken: resting={} placed={} cancelled={} filled={}",
            ask_resting,
            self.ask_oracle.placed,
            self.ask_oracle.cancelled,
            self.ask_oracle.filled
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 10_000,
        // Default shrink iterations are fine; cap test time by per-case
        // size, not shrinker depth.
        .. ProptestConfig::default()
    })]

    #[test]
    fn invariants_hold_under_random_sequences(
        ops in prop::collection::vec(arb_op(), 0..40)
    ) {
        let mut sim = Sim::new();
        for op in &ops {
            sim.apply(op);
            sim.check_invariants();
        }
    }
}
