//! Pure-Rust matching engine for the Meridian CLOB.
//!
//! Layout follows the U2 plan and OpenBook v2's `programs/openbook-v2/src/state/orderbook/`
//! conceptual split (packed-key + fixed-array node management):
//!
//! * [`order_key`] — `(price, seq)` packed into a `u128` so natural ordering
//!   gives price-priority + FIFO-within-price for free.
//! * [`book_side`] — fixed-depth `BookSide<N>` with a sorted array of
//!   [`OrderEntry`]s; binary-search insert (O(log N) compare + O(N) shift),
//!   `cancel_by_id` in O(N) shift. Bid side sorts descending by price;
//!   ask side sorts ascending; FIFO at equal price comes from the `seq`
//!   tiebreak baked into the key.
//! * [`match_step`] — taker-order matching against a single side, with
//!   stack-allocated fill buffer (no heap allocation in the match path).
//! * [`tests`] — `proptest` invariants at `cases = 10_000` plus unit tests
//!   covering every scenario category listed in the U2 dispatch.
//!
//! [`OrderEntry`]: book_side::OrderEntry

pub mod book_side;
pub mod match_step;
pub mod order_key;

#[cfg(test)]
mod tests;
