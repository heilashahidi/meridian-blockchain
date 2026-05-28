use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in fuzz testing.
///
/// This struct serves as a centralized repository for account addresses,
/// enabling their reuse across different instruction flows and test scenarios.
///
/// Docs: https://ackee.xyz/trident/docs/latest/trident-api-macro/trident-types/fuzz-accounts/
///
/// NOTE (U9 deviation): our harness doesn't use `AddressStorage` directly —
/// we hand-derive PDAs in `bootstrap` and stash them in `FuzzTest`. This
/// struct is kept because the `#[derive(FuzzTestMethods)]` macro expects
/// the `fuzz_accounts: AccountAddresses` field. Dead-code warnings on the
/// individual `AddressStorage` slots are intentional.
#[allow(dead_code)]
#[derive(Default)]
pub struct AccountAddresses {
    pub user: AddressStorage,

    pub config: AddressStorage,

    pub market: AddressStorage,

    pub user_usdc: AddressStorage,

    pub usdc_escrow: AddressStorage,

    pub yes_mint: AddressStorage,

    pub no_mint: AddressStorage,

    pub user_yes: AddressStorage,

    pub user_no: AddressStorage,

    pub mint_authority: AddressStorage,

    pub token_program: AddressStorage,

    pub book: AddressStorage,

    pub yes_escrow: AddressStorage,

    pub admin: AddressStorage,

    pub usdc_mint: AddressStorage,

    pub system_program: AddressStorage,

    pub rent: AddressStorage,

    pub payer: AddressStorage,

    pub winning_mint: AddressStorage,

    pub user_winning: AddressStorage,

    pub caller: AddressStorage,

    pub price_update: AddressStorage,
}
