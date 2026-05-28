//! `settle_market` — read the Pyth oracle and stamp the market's outcome.
//!
//! Per plan §U7:
//!   * **Anyone** can call. No admin check — the oracle + expiry gates
//!     serialize the operation. (R15a's "atomic settled flag set" comes
//!     from Solana's per-account write lock on the Market.)
//!   * Refuse if `market.settled` (R15a).
//!   * Refuse if `clock.unix_timestamp < market.expiry_unix` (`MarketNotExpired`).
//!   * Pin the settlement price to the window
//!     `[market.expiry_unix, market.expiry_unix + SETTLE_WINDOW_SECONDS]`
//!     (`SETTLE_WINDOW_SECONDS = 30`). A `publish_time` before expiry or more
//!     than the window past it is rejected (`OracleStale`). This settles the
//!     option at its expiry price rather than "whenever someone calls settle",
//!     and bounds a permissionless caller's ability to cherry-pick a favorable
//!     Pyth update to `SETTLE_WINDOW_SECONDS` regardless of call time.
//!   * Reject if `conf * 10_000 > price * MAX_CONF_BPS` for
//!     `MAX_CONF_BPS = 100` (1 %) (`OracleConfidenceTooWide`).
//!   * Compute outcome by comparing the Pyth-rebased price (microunits) to
//!     `market.strike_price` (already in microunits) — see "Price scaling"
//!     below.
//!   * Set `market.settled = true` and `market.outcome = Some(_)` in a
//!     single mutation so the invariant `settled → outcome.is_some()`
//!     holds for any subsequent reader (R15a serialized by Solana write
//!     lock).
//!
//! # Price scaling
//!
//! Pyth price-feed messages carry an `i64 price` and an `i32 exponent`
//! with the convention `actual = price * 10^exponent`. Equity feeds
//! typically use `exponent = -8` (`$680.00 → price = 68_000_000_000`).
//! Meridian's `Market.strike_price` is a `u64` in **USDC microunits** —
//! i.e. `exponent = -6` (`$680.00 → 680_000_000`).
//!
//! To compare, rebase the Pyth value to microunits:
//!
//! ```text
//! pyth_micro = pyth.price * 10^(pyth.exponent + 6)
//! ```
//!
//! When `pyth.exponent + 6 >= 0` we multiply; when `< 0` we divide. The
//! divide path can lose precision but the gap between strikes (≥ $10 =
//! 10_000_000 microunits) is far wider than the precision of any
//! reasonable feed, so the comparison stays well-defined.
//!
//! We do all arithmetic in `i128` to avoid overflow when `exponent` is
//! near `-8` and price is large.

use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize;

use crate::error::MeridianError;
use crate::state::{Config, Market, Outcome, PriceUpdateV2};

/// Width of the post-expiry window the settlement price must fall in, in
/// seconds. The accepted range is `[expiry, expiry + SETTLE_WINDOW_SECONDS]`.
///
/// Sized to comfortably cover Pyth's update cadence at expiry (sub-second on
/// mainnet) while keeping a permissionless caller's cherry-pick window small.
/// Narrower is safer against settlement manipulation but raises the liveness
/// risk that no update lands in the window — that deadlock is handled by the
/// separate admin emergency-settle / pause path (P1), not by widening this.
pub const SETTLE_WINDOW_SECONDS: u64 = 30;

/// Max acceptable `conf / price` ratio, in basis points. `100 bps = 1 %`.
pub const MAX_CONF_BPS: u128 = 100;

/// USDC microunit exponent. Strikes and quote prices are stored as `u64`
/// units of `10^EXPONENT_QUOTE = 10^-6` dollars.
pub const EXPONENT_QUOTE: i32 = -6;

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    /// Caller. Pays no SOL — `Market` is already initialized and we don't
    /// open new accounts here. Doesn't need to be admin (the oracle + the
    /// expiry timestamp are the actual gate).
    #[account(mut)]
    pub caller: Signer<'info>,

    /// Global config — read for the operator-set `pyth_receiver` pubkey
    /// that the price-update account must be owned by. Boxed for stack
    /// hygiene (Config is ~130 bytes; inline copies inflate try_accounts).
    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    /// Market to settle. Mutated.
    #[account(
        mut,
        seeds = [
            Market::SEED_PREFIX,
            market.ticker.as_ref(),
            &market.strike_price.to_le_bytes(),
            &market.expiry_unix.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// Pyth `PriceUpdateV2` account. Validated manually in the handler:
    ///
    ///   1. `owner == config.pyth_receiver` — operator-pinned per cluster
    ///      (Pyth's real receiver on devnet/mainnet; this program's ID in
    ///      LiteSVM fixtures).
    ///   2. First 8 bytes match the vendored `PriceUpdateV2` discriminator
    ///      (Anchor `try_deserialize` enforces this).
    ///   3. The Borsh-decoded `PriceFeedMessage` survives the freshness +
    ///      feed-id + confidence checks below.
    ///
    /// `UncheckedAccount` is required because Anchor's `Account<T>` for
    /// types declared with `#[account]` pins the owner check to
    /// `crate::ID`, which would reject real Pyth-owned accounts. We
    /// reproduce the discriminator check ourselves via `try_deserialize`
    /// after the manual owner check below.
    ///
    /// CHECK: see manual validation in the handler.
    pub price_update: UncheckedAccount<'info>,
}

pub fn settle_market_handler(ctx: Context<SettleMarket>) -> Result<()> {
    // Idempotency first: an already-settled market is a no-op reject,
    // independent of the oracle account. Checking this before the Pyth
    // validation means a re-submit (or a stale crank) returns MarketSettled
    // instead of a misleading OracleVerificationInsufficient / oracle error.
    require!(
        !ctx.accounts.market.settled,
        MeridianError::MarketSettled
    );

    // Validate the Pyth account before touching any other state: owner
    // pinned to config.pyth_receiver, then try_deserialize (which checks
    // the discriminator and Borsh-decodes the body). Doing this first
    // means a wrong-owner / wrong-discriminator account fails fast with
    // a meridian-side error variant instead of leaking through later.
    let price_update_info = ctx.accounts.price_update.to_account_info();
    require_keys_eq!(
        *price_update_info.owner,
        ctx.accounts.config.pyth_receiver,
        MeridianError::InvalidOracleOwner,
    );
    let price_update = {
        let data = price_update_info.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        PriceUpdateV2::try_deserialize(&mut slice)
            .map_err(|_| MeridianError::InvalidOraclePrice)?
    };

    // Verification-level gate. Secure-by-default (Config.require_full_verification
    // is true at init): only a fully Wormhole-verified price may settle. An
    // operator can relax this on devnet, where Partial updates are common.
    if ctx.accounts.config.require_full_verification {
        require!(
            price_update.verification_level == crate::state::pyth::VerificationLevel::Full,
            MeridianError::OracleVerificationInsufficient,
        );
    }

    let market = &mut ctx.accounts.market;

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= market.expiry_unix,
        MeridianError::MarketNotExpired
    );

    // Pin the settlement price to `[expiry, expiry + SETTLE_WINDOW_SECONDS]`.
    //
    // Lower bound (`publish_time >= expiry`): expressed through
    // `get_price_no_older_than`, whose check is
    // `publish_time + max_age >= clock`. Passing `max_age = clock - expiry`
    // makes that exactly `publish_time >= expiry`. The same call still does
    // the feed-id match and the `publish_time <= clock` / `publish_time > 0`
    // sanity (a settlement price can't be from the future or degenerate).
    // See `state/pyth.rs` for why we vendor the PriceUpdateV2 type.
    let elapsed_since_expiry = clock
        .unix_timestamp
        .checked_sub(market.expiry_unix)
        .ok_or(MeridianError::OracleStale)?; // >= 0: clock >= expiry checked above
    let max_age = u64::try_from(elapsed_since_expiry).map_err(|_| MeridianError::OracleStale)?;
    let price = price_update
        .get_price_no_older_than(&clock, max_age, &market.pyth_feed_id)
        .map_err(map_oracle_err)?;

    // Upper bound (`publish_time <= expiry + SETTLE_WINDOW_SECONDS`): reject
    // updates published too long after expiry so settlement tracks the expiry
    // price and the cherry-pick window stays bounded no matter when settle is
    // called.
    let window_end = market
        .expiry_unix
        .checked_add(SETTLE_WINDOW_SECONDS as i64)
        .ok_or(MeridianError::OracleStale)?;
    require!(price.publish_time <= window_end, MeridianError::OracleStale);

    // Sanity: price must be strictly positive for binary equity options.
    require!(price.price > 0, MeridianError::InvalidOraclePrice);

    // Confidence check: `conf / price <= MAX_CONF_BPS / 10_000`.
    // Rearranged to integer-only: `conf * 10_000 <= price * MAX_CONF_BPS`.
    // Use u128 to avoid overflow when conf is large.
    let conf_bps_num: u128 = (price.conf as u128).saturating_mul(10_000);
    let conf_bps_den: u128 = (price.price as u128).saturating_mul(MAX_CONF_BPS);
    require!(
        conf_bps_num <= conf_bps_den,
        MeridianError::OracleConfidenceTooWide
    );

    // Rebase Pyth price to USDC microunits and compare against strike.
    let pyth_micro = rebase_to_microunits(price.price, price.exponent)
        .ok_or(MeridianError::InvalidOraclePrice)?;
    let strike_micro = market.strike_price as i128;

    let outcome = if pyth_micro >= strike_micro {
        Outcome::YesWins
    } else {
        Outcome::NoWins
    };

    // Atomic flag-flip: settled + outcome in the same mutation, so any
    // subsequent reader sees `settled → outcome.is_some()`.
    market.settled = true;
    market.outcome = Some(outcome);

    msg!(
        "settle_market: outcome={:?} pyth_price={} pyth_expo={} strike={}",
        outcome,
        price.price,
        price.exponent,
        market.strike_price,
    );

    Ok(())
}

/// Bridge from the vendored Pyth `GetPriceError` to Anchor's `Result`. The
/// trait `From<GetPriceError> for MeridianError` is more standard but
/// `#[error_code]` doesn't generate it, so we map here.
fn map_oracle_err(e: crate::state::pyth::GetPriceError) -> Error {
    use crate::state::pyth::GetPriceError as E;
    match e {
        E::PriceTooOld => MeridianError::OracleStale.into(),
        E::MismatchedFeedId => MeridianError::OracleFeedIdMismatch.into(),
    }
}

/// Rebase a `(price, exponent)` Pyth pair into USDC microunits.
///
/// Returns `None` if the rebased value overflows `i128` (degenerate feed)
/// or if `exponent + 6` is larger than ~37 digits (also degenerate).
///
/// # Examples
///
/// * `price = 68_000_000_000, exponent = -8` (`$680.00` with 8 decimals)
///   → microunits = `68_000_000_000 * 10^-2 = 680_000_000`.
/// * `price = 680, exponent = 0` (`$680`, 0 decimals)
///   → microunits = `680 * 10^6 = 680_000_000`.
fn rebase_to_microunits(price: i64, exponent: i32) -> Option<i128> {
    let p = price as i128;
    let shift = exponent + (-EXPONENT_QUOTE); // EXPONENT_QUOTE=-6 → -(-6)=6 → shift = expo+6
    if shift == 0 {
        Some(p)
    } else if shift > 0 {
        // multiply by 10^shift
        let factor = pow10_i128(shift as u32)?;
        p.checked_mul(factor)
    } else {
        // divide by 10^(-shift)
        let factor = pow10_i128((-shift) as u32)?;
        Some(p / factor)
    }
}

/// `10^n` as `i128`, returning `None` if `n` would overflow (n > 38).
fn pow10_i128(n: u32) -> Option<i128> {
    let mut acc: i128 = 1;
    for _ in 0..n {
        acc = acc.checked_mul(10)?;
    }
    Some(acc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebase_pyth_8_decimals_to_microunits() {
        // $680.00 in pyth's typical equity convention (exponent = -8).
        let v = rebase_to_microunits(68_000_000_000, -8).unwrap();
        assert_eq!(v, 680_000_000);
    }

    #[test]
    fn rebase_pyth_already_microunits() {
        let v = rebase_to_microunits(680_000_000, -6).unwrap();
        assert_eq!(v, 680_000_000);
    }

    #[test]
    fn rebase_pyth_whole_dollars() {
        let v = rebase_to_microunits(680, 0).unwrap();
        assert_eq!(v, 680_000_000);
    }

    #[test]
    fn rebase_negative_price_passes_through() {
        // Settle_market's caller-side check rejects non-positive; rebase
        // itself preserves sign.
        let v = rebase_to_microunits(-1, -6).unwrap();
        assert_eq!(v, -1);
    }
}
