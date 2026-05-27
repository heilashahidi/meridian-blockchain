//! Taker-order matching against a single book side.
//!
//! See plan §U2 "Approach":
//!   * Iterates the opposing side from best price, fills against each
//!     entry up to taker `qty`.
//!   * Returns an ordered list of [`Fill`]s plus `residual_qty`.
//!   * No heap allocation on the match path — the fill buffer is a
//!     stack-allocated [`arrayvec::ArrayVec`] sized to the book's capacity,
//!     since a single taker can fill at most every resting maker on the
//!     opposing side.
//!
//! `TakerOrder::side` is the **taker's** side. The match function reads from
//! the opposite side (e.g., a taker bid matches against asks). For a taker
//! bid the limit check is `ask.price <= taker.limit_price`; for a taker ask
//! it is `bid.price >= taker.limit_price`. A market order is encoded with
//! `OrderType::Market` and the `limit_price` field is ignored.

use arrayvec::ArrayVec;

use crate::matching::book_side::{BookSide, Side};

/// Whether the taker is a limit or market order.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrderType {
    Limit,
    Market,
}

/// A taker order presented to [`match_step`].
///
/// `limit_price` is the taker's worst acceptable price for limit orders, or
/// the slippage bound for market orders. For market orders pass
/// `u64::MAX` (bid taker, willing to pay anything) or `1` (ask taker,
/// willing to sell at any positive price) if you don't want a slippage cap.
#[derive(Clone, Copy, Debug)]
pub struct TakerOrder {
    pub side: Side,
    pub order_type: OrderType,
    pub limit_price: u64,
    pub qty: u64,
    pub owner: [u8; 32],
}

/// One executed fill, in the order it was produced (best-price-first, FIFO
/// within a price).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Fill {
    pub maker_owner: [u8; 32],
    pub price: u64,
    pub qty: u64,
}

/// Errors that prevent matching from even running. Distinct from "no fill
/// available" (which is just `fills.is_empty() && residual_qty == taker.qty`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatchError {
    /// `qty == 0`.
    InvalidQty,
    /// `limit_price == 0` on a limit order. Zero is reserved as the
    /// "invalid sentinel" — see `order_key`.
    InvalidPrice,
}

/// The result of one `match_step` call.
///
/// The buffer is sized to `N` because, in the worst case, a single taker
/// can sweep every resting maker on the opposing side (at most `N`).
#[derive(Clone, Debug)]
pub struct MatchResult<const N: usize> {
    pub fills: ArrayVec<Fill, N>,
    pub residual_qty: u64,
}

impl<const N: usize> MatchResult<N> {
    /// Total quantity matched (sum of fill qtys).
    pub fn filled_qty(&self) -> u128 {
        self.fills.iter().map(|f| f.qty as u128).sum()
    }

    /// Total notional matched (sum of `price * qty`), as `u128` to avoid
    /// overflow in the test invariants.
    pub fn filled_notional(&self) -> u128 {
        self.fills
            .iter()
            .map(|f| (f.price as u128) * (f.qty as u128))
            .sum()
    }
}

/// Match a taker order against the opposing book side.
///
/// Panics? No — invalid inputs produce a [`MatchError`]; capacity is
/// statically guaranteed by `N`.
///
/// Self-trade prevention is *not* applied here (the plan defers
/// "self-trade prevention beyond owner-equality check" to follow-up work);
/// the caller may filter fills with `maker_owner == taker.owner` if needed.
pub fn match_step<const N: usize>(
    taker: TakerOrder,
    opposite: &mut BookSide<N>,
) -> Result<MatchResult<N>, MatchError> {
    if taker.qty == 0 {
        return Err(MatchError::InvalidQty);
    }
    if taker.order_type == OrderType::Limit && taker.limit_price == 0 {
        return Err(MatchError::InvalidPrice);
    }
    debug_assert_eq!(opposite.side(), taker.side.opposite());

    let mut fills: ArrayVec<Fill, N> = ArrayVec::new();
    let mut remaining = taker.qty;

    while remaining > 0 {
        let Some(front) = opposite.front_mut() else {
            break;
        };
        let maker_price = front.key.price();

        // Price-cross check. Market orders ignore the price check **except**
        // for an optional slippage bound: for a bid taker, `limit_price` is
        // the max it'll pay; for an ask taker, `limit_price` is the min
        // it'll accept.
        let crosses = match taker.side {
            Side::Bid => maker_price <= taker.limit_price,
            Side::Ask => maker_price >= taker.limit_price,
        };
        if !crosses {
            break;
        }

        let fill_qty = core::cmp::min(remaining, front.qty);
        let maker_owner = front.owner;

        // ArrayVec is sized to N == opposite.capacity(), so this push
        // cannot overflow: each iteration either consumes the front
        // (popping it, decreasing opposite.len) or partially fills it
        // (breaking the loop), so we push at most N times total.
        let push_result = fills.try_push(Fill {
            maker_owner,
            price: maker_price,
            qty: fill_qty,
        });
        debug_assert!(push_result.is_ok());

        remaining -= fill_qty;

        if fill_qty == front.qty {
            // Maker fully consumed — pop it, preserving FIFO at the next price
            // level (the next entry shifts to front).
            opposite.pop_front();
        } else {
            // Maker partially consumed — decrement in place. FIFO position
            // preserved because the entry stays at index 0.
            opposite.decrement_front(fill_qty);
            // Taker is fully filled (since remaining < front.qty implies
            // remaining became 0).
            debug_assert_eq!(remaining, 0);
        }
    }

    Ok(MatchResult {
        fills,
        residual_qty: remaining,
    })
}

#[cfg(test)]
mod match_step_tests {
    use super::*;
    use crate::matching::book_side::{OrderEntry, Side};
    use crate::matching::order_key::OrderKey;

    fn entry(price: u64, seq: u64, qty: u64, owner_byte: u8) -> OrderEntry {
        OrderEntry {
            key: OrderKey::new(price, seq),
            owner: [owner_byte; 32],
            qty,
        }
    }

    #[test]
    fn taker_ask_fully_fills_against_single_bid() {
        let mut bids: BookSide<8> = BookSide::new(Side::Bid);
        bids.insert(entry(40, 1, 100, 0xAA)).unwrap();
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
        assert_eq!(res.residual_qty, 0);
        assert_eq!(res.fills.len(), 1);
        assert_eq!(res.fills[0].qty, 100);
        assert_eq!(res.fills[0].price, 40);
        assert_eq!(res.fills[0].maker_owner, [0xAA; 32]);
        assert!(bids.is_empty());
    }

    #[test]
    fn fifo_three_bids_one_large_ask() {
        let mut bids: BookSide<8> = BookSide::new(Side::Bid);
        bids.insert(entry(40, 1, 10, 0x01)).unwrap();
        bids.insert(entry(40, 2, 10, 0x02)).unwrap();
        bids.insert(entry(40, 3, 10, 0x03)).unwrap();
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
        assert_eq!(res.residual_qty, 0);
        assert_eq!(
            res.fills.iter().map(|f| f.maker_owner[0]).collect::<Vec<_>>(),
            vec![0x01, 0x02, 0x03]
        );
    }

    #[test]
    fn no_match_when_prices_dont_cross() {
        let mut asks: BookSide<8> = BookSide::new(Side::Ask);
        asks.insert(entry(50, 1, 10, 0xCC)).unwrap();
        let res = match_step(
            TakerOrder {
                side: Side::Bid,
                order_type: OrderType::Limit,
                limit_price: 40, // below ask
                qty: 10,
                owner: [0xDD; 32],
            },
            &mut asks,
        )
        .unwrap();
        assert_eq!(res.residual_qty, 10);
        assert!(res.fills.is_empty());
        assert_eq!(asks.len(), 1); // resting order untouched
    }

    #[test]
    fn market_order_residual_returned_when_book_shallow() {
        let mut asks: BookSide<8> = BookSide::new(Side::Ask);
        asks.insert(entry(50, 1, 5, 0x11)).unwrap();
        let res = match_step(
            TakerOrder {
                side: Side::Bid,
                order_type: OrderType::Market,
                limit_price: u64::MAX,
                qty: 100,
                owner: [0xEE; 32],
            },
            &mut asks,
        )
        .unwrap();
        assert_eq!(res.residual_qty, 95);
        assert_eq!(res.fills.len(), 1);
        assert_eq!(res.fills[0].qty, 5);
        assert!(asks.is_empty());
    }

    #[test]
    fn partial_fill_preserves_fifo_position() {
        let mut bids: BookSide<8> = BookSide::new(Side::Bid);
        bids.insert(entry(50, 1, 10, 0xAA)).unwrap();
        bids.insert(entry(50, 2, 10, 0xBB)).unwrap();
        // Taker ask of 3 — should partially fill the first bid only.
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
        assert_eq!(res.fills.len(), 1);
        assert_eq!(res.fills[0].maker_owner[0], 0xAA);
        assert_eq!(res.fills[0].qty, 3);
        // Remaining: AA with qty=7 (still front), then BB with qty=10.
        assert_eq!(bids.as_slice()[0].owner[0], 0xAA);
        assert_eq!(bids.as_slice()[0].qty, 7);
        assert_eq!(bids.as_slice()[1].owner[0], 0xBB);
    }

    #[test]
    fn slippage_bound_on_market_stops_walk() {
        // Two asks at $50 and $60. Market buy with slippage bound $55
        // should only sweep the first level.
        let mut asks: BookSide<8> = BookSide::new(Side::Ask);
        asks.insert(entry(50, 1, 5, 0xAA)).unwrap();
        asks.insert(entry(60, 2, 5, 0xBB)).unwrap();
        let res = match_step(
            TakerOrder {
                side: Side::Bid,
                order_type: OrderType::Market,
                limit_price: 55,
                qty: 10,
                owner: [0xCC; 32],
            },
            &mut asks,
        )
        .unwrap();
        assert_eq!(res.fills.len(), 1);
        assert_eq!(res.fills[0].price, 50);
        assert_eq!(res.residual_qty, 5);
        assert_eq!(asks.len(), 1);
        assert_eq!(asks.best().unwrap().key.price(), 60);
    }

    #[test]
    fn zero_qty_rejected() {
        let mut a: BookSide<4> = BookSide::new(Side::Ask);
        let err = match_step(
            TakerOrder {
                side: Side::Bid,
                order_type: OrderType::Limit,
                limit_price: 1,
                qty: 0,
                owner: [0; 32],
            },
            &mut a,
        );
        assert!(matches!(err, Err(MatchError::InvalidQty)));
    }

    #[test]
    fn zero_limit_price_rejected_on_limit_order() {
        let mut a: BookSide<4> = BookSide::new(Side::Ask);
        let err = match_step(
            TakerOrder {
                side: Side::Bid,
                order_type: OrderType::Limit,
                limit_price: 0,
                qty: 1,
                owner: [0; 32],
            },
            &mut a,
        );
        assert!(matches!(err, Err(MatchError::InvalidPrice)));
    }
}
