//! Meridian on-chain CLOB — program error codes.
//!
//! Empty at U1 except for a placeholder variant (Anchor's `#[error_code]`
//! requires at least one variant). Real error variants land alongside the
//! instructions in U3-U7 — e.g. `Unauthorized`, `ProgramPaused`,
//! `MarketSettled`, `MarketNotExpired`, `OracleStale`, `OracleConfidenceTooWide`,
//! `BookFull`, `OrderNotFound`, `InvalidAmount`, `SlippageExceeded`.

use anchor_lang::prelude::*;

#[error_code]
pub enum MeridianError {
    /// Placeholder so the enum is non-empty for Anchor's `#[error_code]`
    /// proc-macro. Remove once any real variant is added in U3.
    #[msg("Placeholder error — remove when first real variant lands in U3.")]
    Placeholder,
}
