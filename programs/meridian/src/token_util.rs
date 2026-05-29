//! Shared token-account helpers for the maker-payout / refund paths.
//!
//! Both the trading path ([`crate::instructions::place_limit_order::place_order_inner`])
//! and the settlement crank ([`crate::instructions::settle_sweep`]) pay a
//! counterparty at their **canonical** associated token account and must guard
//! against an un-receivable account before issuing the transfer CPI. These
//! helpers centralize that logic so the two callers cannot drift — previously
//! `settle_sweep` reached into `place_limit_order`'s namespace for
//! `token_account_receivable` and re-derived the canonical ATA inline.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;

use crate::error::MeridianError;

/// USDC notional for a resting **bid** of `qty` tokens at `price`: `qty * price`
/// in USDC microunits. Computes in `u128` and bounds the result to `u64`, the
/// shared math for every escrow path that refunds or recovers bid collateral
/// (`cancel_order`, `settle_sweep`, `admin_force_expire_order`). The ask side
/// is trivial (`qty` Yes) and needs no helper.
pub(crate) fn bid_notional(qty: u64, price: u64) -> Result<u64> {
    let amt = (qty as u128)
        .checked_mul(price as u128)
        .ok_or(MeridianError::InvalidAmount)?;
    require!(amt <= u64::MAX as u128, MeridianError::InvalidAmount);
    Ok(amt as u64)
}

/// True iff `info` is a live SPL token account that can actually receive a
/// transfer right now: its data is the fixed token-account length and the
/// account-state byte is `Initialized` (1), not `Uninitialized`/closed (0)
/// or `Frozen` (2).
///
/// Why this exists: a transfer CPI to a frozen or closed account fails, and
/// a failed inner instruction aborts the ENTIRE transaction in the Solana
/// runtime — the calling program never gets an `Err` back to handle. So any
/// payout path that wants skip-and-continue semantics (place_order_inner's
/// maker payouts, settle_sweep's refunds) must detect un-receivable accounts
/// BEFORE issuing the CPI, not by inspecting its result. Callers pair this
/// predicate with a canonical-ATA key check ([`is_canonical_ata`], which binds
/// the (owner, mint) pair); this predicate adds the liveness dimension those
/// callers can't get from the address alone — notably the frozen case (a
/// Circle-frozen USDC ATA on mainnet) and the uninitialized/closed case.
///
/// SPL `spl_token::state::Account` is a fixed 165 bytes with the `state`
/// enum at offset 108. We read the byte directly rather than unpacking the
/// whole account to stay cheap and tolerant of garbage/closed data.
///
/// The account MUST be owned by the SPL Token program. Without this check the
/// predicate is a pure byte read that any account can spoof: a caller could
/// supply a 165-byte account owned by an arbitrary program with `mint`/
/// `authority`/`state` bytes forged to pass every check, yet `token::transfer`
/// (pinned to classic Token) would then reject the foreign-owned account and
/// fail the CPI. Pinning the owner here keeps the un-payable account in the
/// skip path instead of letting it reach — and abort on — the transfer.
pub(crate) fn token_account_receivable(info: &AccountInfo) -> bool {
    info.owner == &anchor_spl::token::ID
        && matches!(info.try_borrow_data(), Ok(d) if d.len() >= 165 && d[108] == 1)
}

/// True iff `info`'s key is `owner`'s canonical associated token account for
/// `mint`. Binds the (owner, mint) pair to a single deterministic address, so
/// a caller cannot substitute a different account the owner happens to control.
pub(crate) fn is_canonical_ata(info: &AccountInfo, owner: &Pubkey, mint: &Pubkey) -> bool {
    info.key() == get_associated_token_address(owner, mint)
}

/// True iff `info` is `owner`'s canonical ATA for `mint` AND is receivable
/// right now.
///
/// For callers that treat a non-canonical address and an un-receivable
/// canonical ATA **the same way** (skip) — e.g. the public `settle_sweep`
/// crank, which must not let a malformed recipient abort the whole batch.
/// Callers that need to DISTINGUISH the two (e.g. the trading path, which
/// reverts on a non-canonical taker-supplied account but skips on an
/// un-receivable one) should compose [`is_canonical_ata`] +
/// [`token_account_receivable`] directly.
pub(crate) fn is_canonical_and_receivable(
    info: &AccountInfo,
    owner: &Pubkey,
    mint: &Pubkey,
) -> bool {
    is_canonical_ata(info, owner, mint) && token_account_receivable(info)
}
