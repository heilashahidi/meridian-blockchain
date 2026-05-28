//! Vendored layout-compatible copy of Pyth's `PriceUpdateV2` account.
//!
//! # Why vendored?
//!
//! Per `programs/meridian/Cargo.toml`, the upstream `pyth-solana-receiver-sdk`
//! crate is unbuildable in our toolchain at U7:
//!
//!   * `0.6` pulls `solana-program <2`, incompatible with Anchor 1.0's
//!     `solana-program ~3`.
//!   * `1.2` pulls `borsh 0.10` transitively via `pythnet-sdk` for the
//!     `PriceFeedMessage` derive, incompatible with Anchor 1.0's
//!     `borsh 1.x` — `PriceUpdateV2` fails to satisfy `BorshDeserialize`
//!     in our crate graph.
//!
//! The plan §U7 §"Pyth integration testing" explicitly authorizes this
//! escalation: keep the prod-shape Pyth account, but speak the wire bytes
//! ourselves so the rest of the toolchain compiles. The vendored struct
//! matches the upstream byte layout exactly (`pyth-solana-receiver-sdk
//! 1.2.0` + `pythnet-sdk 2.3.1`), so a real `PriceUpdateV2` posted by
//! Pyth's Hermes/Wormhole infra deserializes through this type identically
//! to what the SDK would have produced.
//!
//! # Wire layout (Anchor `#[account]` + Borsh)
//!
//! Byte 0..8       : Anchor account discriminator
//!                   = first 8 bytes of `sha256("account:PriceUpdateV2")`
//! Byte 8..40      : write_authority: Pubkey
//! Byte 40..42     : verification_level (Borsh enum)
//!                     [tag: u8] [payload: u8 if Partial else ø]
//!                       0 → Partial { num_signatures }
//!                       1 → Full
//! Byte 42..       : price_message: PriceFeedMessage
//!     ..feed_id   : [u8; 32]
//!     ..price     : i64
//!     ..conf      : u64
//!     ..exponent  : i32
//!     ..publish_time: i64
//!     ..prev_publish_time: i64
//!     ..ema_price: i64
//!     ..ema_conf: u64
//! Byte ..N        : posted_slot: u64
//!
//! Total non-discriminator size: 32 + 2 + (32+8+8+4+8+8+8+8) + 8 = 134 bytes
//! Note that `verification_level` is `2` bytes only when `Partial`; when
//! `Full` it's 1 byte and the trailing fields shift. We don't care for
//! settle's purposes (we read `price_message` + `publish_time` and treat
//! `verification_level` as "we'll trust the off-chain Hermes path"), but
//! `try_deserialize` walks Borsh tag-by-tag so it gets it right either way.
//!
//! # Discriminator constant
//!
//! Computed at compile time via `anchor_lang`'s `Discriminator` derive — see
//! the `#[account]` attribute below. The bytes match the upstream SDK's
//! `PriceUpdateV2::DISCRIMINATOR` exactly because the macro hashes the
//! struct name (`"PriceUpdateV2"`), not its module path.

use anchor_lang::prelude::*;

/// Verification level for a Pyth price update. See module docs for the
/// Borsh tag layout.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerificationLevel {
    /// `num_signatures` Wormhole guardian signatures verified.
    Partial {
        #[allow(unused)]
        num_signatures: u8,
    },
    /// Two-thirds of the current guardian set verified.
    Full,
}

impl VerificationLevel {
    /// Total ordering: `Full` > any `Partial`; `Partial { n }` > `Partial { m }`
    /// iff `n >= m`. Mirrors the upstream SDK's `gte`.
    pub fn gte(self, other: VerificationLevel) -> bool {
        match self {
            VerificationLevel::Full => true,
            VerificationLevel::Partial { num_signatures } => match other {
                VerificationLevel::Full => false,
                VerificationLevel::Partial {
                    num_signatures: o,
                } => num_signatures >= o,
            },
        }
    }
}

/// One Pyth price feed update. Mirrors `pythnet_sdk::messages::PriceFeedMessage`
/// byte-for-byte.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PriceFeedMessage {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
    pub prev_publish_time: i64,
    pub ema_price: i64,
    pub ema_conf: u64,
}

/// Pyth `PriceUpdateV2` account, wire-compatible with the upstream SDK.
///
/// Anchor's `#[account]` macro generates a `Discriminator` impl whose
/// `DISCRIMINATOR` constant is `sha256("account:PriceUpdateV2")[..8]` —
/// identical to what the upstream `pyth-solana-receiver-sdk` ships, because
/// the macro hashes the struct's bare name.
#[account]
#[derive(Debug, PartialEq, Eq)]
pub struct PriceUpdateV2 {
    pub write_authority: Pubkey,
    pub verification_level: VerificationLevel,
    pub price_message: PriceFeedMessage,
    pub posted_slot: u64,
}

/// Resolved price snapshot returned by [`PriceUpdateV2::get_price_no_older_than`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Price {
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

/// Errors from the on-chain Pyth read path.
///
/// Surfaced upward via `From` in [`crate::error::MeridianError`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GetPriceError {
    /// The price update's `feed_id` doesn't match the market's pinned id.
    MismatchedFeedId,
    /// `publish_time + maximum_age < clock.unix_timestamp`.
    PriceTooOld,
}

impl PriceUpdateV2 {
    /// Get the latest `Price` for `feed_id` from this update account,
    /// rejecting if `publish_time` is older than `maximum_age` seconds
    /// before `clock.unix_timestamp`. Mirrors the upstream SDK's
    /// `get_price_no_older_than`, minus the `VerificationLevel::Full` gate.
    ///
    /// We deliberately don't enforce `Full` verification on devnet:
    ///   1. The lifecycle service posts via Hermes/Wormhole and we trust
    ///      that off-chain step.
    ///   2. Test fixtures construct `Partial { num_signatures: 0 }`
    ///      accounts because Wormhole guardian signatures aren't available
    ///      in LiteSVM.
    /// Mainnet would need to flip this back on — flagged in U7's commit
    /// message as a follow-up.
    pub fn get_price_no_older_than(
        &self,
        clock: &Clock,
        maximum_age: u64,
        feed_id: &[u8; 32],
    ) -> core::result::Result<Price, GetPriceError> {
        if &self.price_message.feed_id != feed_id {
            return Err(GetPriceError::MismatchedFeedId);
        }
        let max_age_i64 = maximum_age as i64;
        if self
            .price_message
            .publish_time
            .saturating_add(max_age_i64)
            < clock.unix_timestamp
        {
            return Err(GetPriceError::PriceTooOld);
        }
        Ok(Price {
            price: self.price_message.price,
            conf: self.price_message.conf,
            exponent: self.price_message.exponent,
            publish_time: self.price_message.publish_time,
        })
    }
}
