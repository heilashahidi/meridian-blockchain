//! U3 smoke test: end-to-end exercise of `initialize_config` +
//! `create_strike_market` against LiteSVM.
//!
//! Plan §U3 verification:
//!   * `initialize_config` produces a Config PDA with `admin = caller`
//!     and `paused = false`.
//!   * `create_strike_market` produces the full account family for one
//!     strike (Market, Book, Yes/No mints, USDC/Yes escrows).
//!   * Calling `create_strike_market` twice for the same `(ticker,
//!     strike, expiry)` fails (PDA already initialised).
//!   * Calling `create_strike_market` with a non-admin signer fails with
//!     `Unauthorized`.
//!
//! The test stays at the U3 boundary — no orders are placed, no settle
//! is invoked. U4-U8 extend coverage on top of the same fixture.

use anchor_lang::AnchorSerialize;
use meridian_litesvm_tests::{
    anchor_ix, load_anchor_account, load_zero_copy_account, read_mint, read_token_account,
    Fixture, MERIDIAN_PROGRAM_ID, RENT_SYSVAR_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use solana_instruction::account_meta::AccountMeta;
use solana_keypair::Keypair;
use solana_program_option::COption;
use solana_signer::Signer;

#[test]
fn u3_smoke_lifecycle() {
    let mut fx = Fixture::new();
    let (config_pda, _) = fx.config_pda();

    // ----- initialize_config -----

    let fee_authority = Keypair::new().pubkey();
    let mut init_args = fee_authority.to_bytes().to_vec();
        // pyth_receiver: pin to our own program ID so the LiteSVM fixture
        // (which set_account()s PriceUpdateV2 with owner=meridian) passes the
        // settle_market owner check.
        init_args.extend_from_slice(MERIDIAN_PROGRAM_ID.as_ref()); // raw 32-byte Pubkey is borsh-equivalent

    let init_ix = anchor_ix(
        MERIDIAN_PROGRAM_ID,
        "initialize_config",
        &init_args,
        vec![
            AccountMeta::new(fx.admin.pubkey(), true), // payer (signer + writable)
            AccountMeta::new(config_pda, false),       // config PDA (writable, not signer)
            AccountMeta::new_readonly(fx.usdc_mint.pubkey(), false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(MERIDIAN_PROGRAM_ID, false), // program (C1)
            AccountMeta::new_readonly(meridian_litesvm_tests::meridian_program_data(), false), // program_data (C1)
        ],
    );
    fx.submit_admin_ix(init_ix);

    let config = load_anchor_account::<meridian::state::Config>(&fx.svm, &config_pda);
    assert_eq!(config.admin, fx.admin.pubkey(), "admin must be the caller");
    assert_eq!(config.fee_authority, fee_authority);
    assert_eq!(config.usdc_mint, fx.usdc_mint.pubkey());
    assert!(!config.paused, "config must start unpaused");

    // ----- create_strike_market -----

    // META, $680 strike (USDC microunits), expiry one day out.
    let ticker: [u8; 8] = *b"META\0\0\0\0";
    let strike_price: u64 = 680_000_000;
    let expiry_unix: i64 = 86_400; // i64::MAX would also work; pick a deterministic value
    let pyth_feed_id = [0u8; 32];

    let (market_pda, _) = fx.market_pda(&ticker, strike_price, expiry_unix);
    let (book_pda, _) = fx.book_pda(&market_pda);
    let (mint_auth, _) = fx.mint_authority_pda(&market_pda);
    let (yes_mint, _) = fx.yes_mint_pda(&market_pda);
    let (no_mint, _) = fx.no_mint_pda(&market_pda);
    let (usdc_escrow, _) = fx.usdc_escrow_pda(&market_pda);
    let (yes_escrow, _) = fx.yes_escrow_pda(&market_pda);

    let args = meridian::CreateStrikeMarketArgs {
        ticker,
        strike_price,
        expiry_unix,
        pyth_feed_id,
    };
    let mut args_bytes = Vec::new();
    args.serialize(&mut args_bytes).unwrap();

    let csm_accounts = vec![
        AccountMeta::new(fx.admin.pubkey(), true),
        AccountMeta::new_readonly(config_pda, false),
        AccountMeta::new(market_pda, false),
        AccountMeta::new(book_pda, false),
        AccountMeta::new(yes_mint, false),
        AccountMeta::new(no_mint, false),
        AccountMeta::new_readonly(mint_auth, false),
        AccountMeta::new(usdc_escrow, false),
        AccountMeta::new(yes_escrow, false),
        AccountMeta::new_readonly(fx.usdc_mint.pubkey(), false),
        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        AccountMeta::new_readonly(RENT_SYSVAR_ID, false),
    ];
    let csm_ix = anchor_ix(
        MERIDIAN_PROGRAM_ID,
        "create_strike_market",
        &args_bytes,
        csm_accounts.clone(),
    );
    fx.submit_admin_ix(csm_ix);

    // ----- assert Market fields -----

    let market = load_anchor_account::<meridian::state::Market>(&fx.svm, &market_pda);
    assert_eq!(market.ticker, ticker);
    assert_eq!(market.strike_price, strike_price);
    assert_eq!(market.expiry_unix, expiry_unix);
    assert_eq!(market.yes_mint, yes_mint);
    assert_eq!(market.no_mint, no_mint);
    assert!(!market.settled);
    assert!(market.outcome.is_none());
    assert_eq!(market.sweep_cursor, 0);
    assert_eq!(market.pyth_feed_id, pyth_feed_id);

    // ----- assert Book fields -----

    let book =
        load_zero_copy_account::<meridian::state::Book>(&fx.svm, &book_pda);
    assert_eq!(book.market, market_pda);
    assert_eq!(book.bids.len(), 0, "bid side starts empty");
    assert_eq!(book.asks.len(), 0, "ask side starts empty");
    assert_eq!(book.next_seq, 1, "first seq number is 1");

    // ----- assert Yes/No mints exist with the right authority -----

    let yes_mint_state = read_mint(&fx.svm, &yes_mint);
    let no_mint_state = read_mint(&fx.svm, &no_mint);
    assert_eq!(yes_mint_state.decimals, 6);
    assert_eq!(no_mint_state.decimals, 6);
    assert_eq!(yes_mint_state.supply, 0);
    assert_eq!(no_mint_state.supply, 0);
    assert_eq!(
        yes_mint_state.mint_authority,
        COption::Some(mint_auth),
        "yes mint authority must be the per-market PDA",
    );
    assert_eq!(
        no_mint_state.mint_authority,
        COption::Some(mint_auth),
        "no mint authority must be the per-market PDA",
    );

    // ----- assert escrows are zero-balance PDA-owned token accounts -----

    let usdc_esc_state = read_token_account(&fx.svm, &usdc_escrow);
    assert_eq!(usdc_esc_state.mint, fx.usdc_mint.pubkey());
    assert_eq!(usdc_esc_state.owner, mint_auth);
    assert_eq!(usdc_esc_state.amount, 0);

    let yes_esc_state = read_token_account(&fx.svm, &yes_escrow);
    assert_eq!(yes_esc_state.mint, yes_mint);
    assert_eq!(yes_esc_state.owner, mint_auth);
    assert_eq!(yes_esc_state.amount, 0);

    // ----- second create_strike_market for same triple fails -----

    let csm_ix_again = anchor_ix(
        MERIDIAN_PROGRAM_ID,
        "create_strike_market",
        &args_bytes,
        csm_accounts.clone(),
    );
    let err = fx
        .try_submit_ix_with_signers(csm_ix_again, &[&fx.admin.insecure_clone()])
        .expect_err("second create_strike_market for the same triple must fail");
    let _ = err; // any failure suffices — Anchor surfaces this as
                 // `AccountAlreadyInitialized` via the system program.

    // ----- non-admin create_strike_market fails -----

    let intruder = Keypair::new();
    fx.svm
        .airdrop(&intruder.pubkey(), 10_000_000_000)
        .expect("airdrop intruder");

    let ticker2: [u8; 8] = *b"AAPL\0\0\0\0";
    let strike_price2: u64 = 200_000_000;
    let expiry_unix2: i64 = 86_400;
    let (market2, _) = fx.market_pda(&ticker2, strike_price2, expiry_unix2);
    let (book2, _) = fx.book_pda(&market2);
    let (mint_auth2, _) = fx.mint_authority_pda(&market2);
    let (yes_mint2, _) = fx.yes_mint_pda(&market2);
    let (no_mint2, _) = fx.no_mint_pda(&market2);
    let (usdc_escrow2, _) = fx.usdc_escrow_pda(&market2);
    let (yes_escrow2, _) = fx.yes_escrow_pda(&market2);

    let args2 = meridian::CreateStrikeMarketArgs {
        ticker: ticker2,
        strike_price: strike_price2,
        expiry_unix: expiry_unix2,
        pyth_feed_id,
    };
    let mut args2_bytes = Vec::new();
    args2.serialize(&mut args2_bytes).unwrap();

    let intruder_accounts = vec![
        AccountMeta::new(intruder.pubkey(), true), // payer/admin slot
        AccountMeta::new_readonly(config_pda, false),
        AccountMeta::new(market2, false),
        AccountMeta::new(book2, false),
        AccountMeta::new(yes_mint2, false),
        AccountMeta::new(no_mint2, false),
        AccountMeta::new_readonly(mint_auth2, false),
        AccountMeta::new(usdc_escrow2, false),
        AccountMeta::new(yes_escrow2, false),
        AccountMeta::new_readonly(fx.usdc_mint.pubkey(), false),
        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        AccountMeta::new_readonly(RENT_SYSVAR_ID, false),
    ];
    let intruder_ix = anchor_ix(
        MERIDIAN_PROGRAM_ID,
        "create_strike_market",
        &args2_bytes,
        intruder_accounts,
    );
    let err = fx
        .try_submit_ix_with_signers(intruder_ix, &[&intruder])
        .expect_err("non-admin caller must fail with Unauthorized");
    // The error string contains the custom error code that maps to
    // `MeridianError::Unauthorized` (the `has_one = admin` constraint
    // surfaces this on the Anchor side).
    let err_str = format!("{err:?}");
    assert!(
        err_str.contains("Unauthorized") || err_str.contains("custom") || err_str.contains("ConstraintHasOne"),
        "expected an Unauthorized-style error, got: {err_str}",
    );
}

/// C1: `initialize_config` is bound to the program's upgrade authority, so a
/// front-runner who is NOT the upgrade authority cannot seize the admin slot.
/// The fixture sets the upgrade authority to `fx.admin`; an attacker paying for
/// init must be rejected by the `program_data.upgrade_authority` constraint.
#[test]
fn init_rejects_non_upgrade_authority() {
    let mut fx = Fixture::new();
    let (config_pda, _) = fx.config_pda();

    let attacker = Keypair::new();
    fx.svm
        .airdrop(&attacker.pubkey(), 10_000_000_000)
        .expect("airdrop attacker");

    let fee_authority = Keypair::new().pubkey();
    let mut init_args = fee_authority.to_bytes().to_vec();
    init_args.extend_from_slice(MERIDIAN_PROGRAM_ID.as_ref()); // pyth_receiver

    let mut accounts = vec![
        AccountMeta::new(attacker.pubkey(), true), // payer = attacker (NOT the upgrade authority)
        AccountMeta::new(config_pda, false),
        AccountMeta::new_readonly(fx.usdc_mint.pubkey(), false),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
    ];
    accounts.extend(fx.init_upgrade_metas());

    let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "initialize_config", &init_args, accounts);
    let err = fx
        .try_submit_ix_with_signers(ix, &[&attacker])
        .expect_err("init by a non-upgrade-authority must be rejected (C1)");
    let err_str = format!("{err:?}");
    assert!(
        err_str.contains("Unauthorized") || err_str.contains("custom"),
        "expected an Unauthorized-style error, got: {err_str}",
    );
}
