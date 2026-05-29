//! U7 LiteSVM test: `settle_market`, `settle_sweep`, `redeem`.
//!
//! Covers plan §U7 test list + the AE1 acceptance example (settle then
//! sweep) and the strongest end-of-lifecycle assertion: USDC conservation
//! across the entire create → mint → trade → settle → sweep → redeem cycle.
//!
//! # Pyth account construction
//!
//! Pyth's `PriceUpdateV2` SDK can't compile in our crate graph (see
//! `programs/meridian/src/state/pyth.rs` for the receiver/Anchor version
//! conflict). We vendored a layout-compatible `PriceUpdateV2` and use
//! `Fixture::set_pyth_price` to plant a fake account in LiteSVM. The
//! account is owned by the meridian program so Anchor's `Account<...>`
//! owner check passes. Discriminator is the standard
//! `sha256("account:PriceUpdateV2")[..8]` — same as upstream.
//!
//! # Clock manipulation
//!
//! `settle_market` requires `clock.unix_timestamp >= market.expiry_unix`
//! and an oracle `publish_time` inside the post-expiry window
//! `[expiry, expiry + SETTLE_WINDOW_SECONDS]` (`SETTLE_WINDOW_SECONDS = 30`).
//! LiteSVM's default `Clock` has a small unix_timestamp; we advance it via
//! `set_clock_unix_ts` before each settle so the expiry + window checks are
//! meaningful.

#![allow(clippy::too_many_arguments)]

use anchor_lang::{AccountSerialize, AnchorSerialize};
use litesvm::LiteSVM;
use meridian_litesvm_tests::{
    anchor_ix, close_token_account, create_canonical_ata, freeze_token_account,
    load_anchor_account, load_zero_copy_account, read_mint, read_token_account, set_clock_unix_ts,
    set_pyth_price, set_pyth_price_partial, set_pyth_price_with_owner, Fixture, MERIDIAN_PROGRAM_ID,
    RENT_SYSVAR_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_interface::instruction as token_instruction;

// ---------- helpers (lifted from u5/u6 conventions) ----------

fn airdrop_sol(svm: &mut LiteSVM, who: &Address, lamports: u64) {
    svm.airdrop(who, lamports).expect("airdrop SOL");
}

#[allow(dead_code)]
fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    owner: &Address,
    mint: &Address,
) -> Keypair {
    let acct = Keypair::new();
    let acct_len: usize =
        <spl_token_interface::state::Account as solana_program_pack::Pack>::LEN;
    let rent = svm.minimum_balance_for_rent_exemption(acct_len);

    let create_ix = solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &acct.pubkey(),
        rent,
        acct_len as u64,
        &TOKEN_PROGRAM_ID,
    );
    let init_ix =
        token_instruction::initialize_account(&TOKEN_PROGRAM_ID, &acct.pubkey(), mint, owner)
            .expect("build initialize_account ix");
    let blockhash = svm.latest_blockhash();
    let msg =
        Message::new_with_blockhash(&[create_ix, init_ix], Some(&payer.pubkey()), &blockhash);
    let tx = Transaction::new(&[payer, &acct], msg, blockhash);
    svm.send_transaction(tx).expect("create token account");
    acct
}

fn mint_usdc(
    svm: &mut LiteSVM,
    mint_authority: &Keypair,
    mint: &Address,
    dest: &Address,
    amount: u64,
) {
    let ix = token_instruction::mint_to(
        &TOKEN_PROGRAM_ID,
        mint,
        dest,
        &mint_authority.pubkey(),
        &[],
        amount,
    )
    .expect("build mint_to ix");
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&mint_authority.pubkey()), &blockhash);
    let tx = Transaction::new(&[mint_authority], msg, blockhash);
    svm.send_transaction(tx).expect("mint USDC");
}

fn try_submit(
    svm: &mut LiteSVM,
    ix: Instruction,
    signers: &[&Keypair],
) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    let blockhash = svm.latest_blockhash();
    let payer = signers[0].pubkey();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer), &blockhash);
    let tx = Transaction::new(signers, msg, blockhash);
    svm.send_transaction(tx)
}

fn submit(svm: &mut LiteSVM, ix: Instruction, signers: &[&Keypair]) {
    try_submit(svm, ix, signers).expect("instruction should succeed");
}

// ---------- environment ----------

/// Pyth equity-feed exponent (microdollar precision-style: `-8` is what
/// Pyth uses for most equity feeds — `$680.00 → 68_000_000_000`).
const PYTH_EXPONENT: i32 = -8;

/// The strike used across U7 tests: $680.00 in USDC microunits.
const STRIKE_PRICE: u64 = 680_000_000;

/// Expiry timestamp the market is created with. Chosen large enough that
/// the default LiteSVM clock isn't already past it.
const EXPIRY_UNIX: i64 = 86_400;

/// Pyth feed id we pin into the market; matches what the fake oracle
/// posts in `set_pyth_price`.
const FEED_ID: [u8; 32] = [7u8; 32];

struct Env {
    fx: Fixture,
    config_pda: Address,
    market_pda: Address,
    book_pda: Address,
    mint_authority: Address,
    yes_mint: Address,
    no_mint: Address,
    usdc_escrow: Address,
    yes_escrow: Address,
    pyth_account: Address,
    users: Vec<UserAccounts>,
}

struct UserAccounts {
    kp: Keypair,
    usdc: Address,
    yes: Address,
    no: Address,
}

impl Env {
    fn new(n_users: usize, usdc_each: u64) -> Self {
        let mut fx = Fixture::new();
        let (config_pda, _) = fx.config_pda();

        // initialize_config
        let fee_authority = Keypair::new().pubkey();
        let mut init_args = fee_authority.to_bytes().to_vec();
        // pyth_receiver: pin to our own program ID so the LiteSVM fixture
        // (which set_account()s PriceUpdateV2 with owner=meridian) passes the
        // settle_market owner check.
        init_args.extend_from_slice(MERIDIAN_PROGRAM_ID.as_ref());
        let init_ix = anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "initialize_config",
            &init_args,
            vec![
                AccountMeta::new(fx.admin.pubkey(), true),
                AccountMeta::new(config_pda, false),
                AccountMeta::new_readonly(fx.usdc_mint.pubkey(), false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            ],
        );
        fx.submit_admin_ix(init_ix);

        // create_strike_market with a non-zero feed id so we can tell
        // matched/mismatched scenarios apart in the error tests.
        let ticker: [u8; 8] = *b"META\0\0\0\0";
        let (market_pda, _) = fx.market_pda(&ticker, STRIKE_PRICE, EXPIRY_UNIX);
        let (book_pda, _) = fx.book_pda(&market_pda);
        let (mint_authority, _) = fx.mint_authority_pda(&market_pda);
        let (yes_mint, _) = fx.yes_mint_pda(&market_pda);
        let (no_mint, _) = fx.no_mint_pda(&market_pda);
        let (usdc_escrow, _) = fx.usdc_escrow_pda(&market_pda);
        let (yes_escrow, _) = fx.yes_escrow_pda(&market_pda);

        let args = meridian::CreateStrikeMarketArgs {
            ticker,
            strike_price: STRIKE_PRICE,
            expiry_unix: EXPIRY_UNIX,
            pyth_feed_id: FEED_ID,
        };
        let mut args_bytes = Vec::new();
        args.serialize(&mut args_bytes).unwrap();
        let csm_ix = anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "create_strike_market",
            &args_bytes,
            vec![
                AccountMeta::new(fx.admin.pubkey(), true),
                AccountMeta::new_readonly(config_pda, false),
                AccountMeta::new(market_pda, false),
                AccountMeta::new(book_pda, false),
                AccountMeta::new(yes_mint, false),
                AccountMeta::new(no_mint, false),
                AccountMeta::new_readonly(mint_authority, false),
                AccountMeta::new(usdc_escrow, false),
                AccountMeta::new(yes_escrow, false),
                AccountMeta::new_readonly(fx.usdc_mint.pubkey(), false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                AccountMeta::new_readonly(RENT_SYSVAR_ID, false),
            ],
        );
        fx.submit_admin_ix(csm_ix);

        // Distinct address for the Pyth account — generated fresh, not a
        // PDA. settle_market doesn't constrain the address (the feed id
        // is on the account body, not the key).
        let pyth_account = Keypair::new().pubkey();

        // Users.
        let mut users = Vec::with_capacity(n_users);
        for _ in 0..n_users {
            let kp = Keypair::new();
            airdrop_sol(&mut fx.svm, &kp.pubkey(), 10_000_000_000);
            // Post-U5 ABI: maker payouts + sweep refund recipients bind to the
            // owner's canonical ATA.
            let usdc = create_canonical_ata(&mut fx.svm, &kp.pubkey(), &fx.usdc_mint.pubkey());
            let yes = create_canonical_ata(&mut fx.svm, &kp.pubkey(), &yes_mint);
            let no = create_canonical_ata(&mut fx.svm, &kp.pubkey(), &no_mint);
            if usdc_each > 0 {
                mint_usdc(
                    &mut fx.svm,
                    &fx.admin.insecure_clone(),
                    &fx.usdc_mint.pubkey(),
                    &usdc,
                    usdc_each,
                );
            }
            users.push(UserAccounts {
                kp,
                usdc,
                yes,
                no,
            });
        }

        Self {
            fx,
            config_pda,
            market_pda,
            book_pda,
            mint_authority,
            yes_mint,
            no_mint,
            usdc_escrow,
            yes_escrow,
            pyth_account,
            users,
        }
    }

    fn seed_yes(&mut self, i: usize, amount: u64) {
        let user_pubkey = self.users[i].kp.pubkey();
        let metas = vec![
            AccountMeta::new(user_pubkey, true),
            AccountMeta::new_readonly(self.config_pda, false),
            AccountMeta::new_readonly(self.market_pda, false),
            AccountMeta::new(self.users[i].usdc, false),
            AccountMeta::new(self.usdc_escrow, false),
            AccountMeta::new(self.yes_mint, false),
            AccountMeta::new(self.no_mint, false),
            AccountMeta::new(self.users[i].yes, false),
            AccountMeta::new(self.users[i].no, false),
            AccountMeta::new_readonly(self.mint_authority, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "mint_pair", &amount.to_le_bytes(), metas);
        let kp = self.users[i].kp.insecure_clone();
        submit(&mut self.fx.svm, ix, &[&kp]);
    }

    /// Force `config.paused = true` via raw account mutation (no on-chain
    /// pause instruction exists yet — see module docs).
    fn force_paused(&mut self) {
        let config: meridian::state::Config =
            load_anchor_account(&self.fx.svm, &self.config_pda);
        let updated = meridian::state::Config {
            paused: true,
            ..config
        };
        let mut account = self
            .fx
            .svm
            .get_account(&self.config_pda)
            .expect("config exists");
        let mut buf: Vec<u8> = Vec::new();
        updated.try_serialize(&mut buf).expect("serialize Config");
        account.data = buf;
        self.fx
            .svm
            .set_account(self.config_pda, account)
            .expect("set_account paused=true");
    }

    fn place_limit(
        &mut self,
        i: usize,
        side: u8,
        price: u64,
        qty: u64,
        maker_pairs: &[(Address, Address)],
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let args = meridian::PlaceLimitOrderArgs { side, price, qty };
        let mut data = Vec::new();
        args.serialize(&mut data).unwrap();
        let mut metas = vec![
            AccountMeta::new(self.users[i].kp.pubkey(), true),
            AccountMeta::new_readonly(self.config_pda, false),
            AccountMeta::new_readonly(self.market_pda, false),
            AccountMeta::new(self.book_pda, false),
            AccountMeta::new(self.usdc_escrow, false),
            AccountMeta::new(self.yes_escrow, false),
            AccountMeta::new_readonly(self.yes_mint, false),
            AccountMeta::new(self.users[i].usdc, false),
            AccountMeta::new(self.users[i].yes, false),
            AccountMeta::new_readonly(self.mint_authority, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];
        // Post-U5 ABI: one canonical maker payout per fill — USDC for a Bid
        // taker, Yes for an Ask taker.
        for (usdc, yes) in maker_pairs {
            let payout = if side == 0 { *usdc } else { *yes };
            metas.push(AccountMeta::new(payout, false));
        }
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "place_limit_order", &data, metas);
        let kp = self.users[i].kp.insecure_clone();
        try_submit(&mut self.fx.svm, ix, &[&kp])
    }

    fn settle(
        &mut self,
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let caller = self.users[0].kp.insecure_clone();
        let metas = vec![
            AccountMeta::new(caller.pubkey(), true),
            AccountMeta::new_readonly(self.config_pda, false),
            AccountMeta::new(self.market_pda, false),
            AccountMeta::new_readonly(self.pyth_account, false),
        ];
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "settle_market", &[], metas);
        try_submit(&mut self.fx.svm, ix, &[&caller])
    }

    fn sweep(
        &mut self,
        max_orders: u32,
        recipients: &[Address],
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let caller = self.users[0].kp.insecure_clone();
        let args = meridian::SettleSweepArgs { max_orders };
        let mut data = Vec::new();
        args.serialize(&mut data).unwrap();
        let mut metas = vec![
            AccountMeta::new(caller.pubkey(), true),
            AccountMeta::new_readonly(self.config_pda, false),
            AccountMeta::new(self.market_pda, false),
            AccountMeta::new(self.book_pda, false),
            AccountMeta::new(self.usdc_escrow, false),
            AccountMeta::new(self.yes_escrow, false),
            AccountMeta::new_readonly(self.yes_mint, false),
            AccountMeta::new_readonly(self.mint_authority, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];
        for r in recipients {
            metas.push(AccountMeta::new(*r, false));
        }
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "settle_sweep", &data, metas);
        try_submit(&mut self.fx.svm, ix, &[&caller])
    }

    fn redeem(
        &mut self,
        i: usize,
        winning_mint: Address,
        user_winning: Address,
        amount: u64,
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let user = self.users[i].kp.insecure_clone();
        let metas = vec![
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new_readonly(self.config_pda, false),
            AccountMeta::new_readonly(self.market_pda, false),
            AccountMeta::new(winning_mint, false),
            AccountMeta::new(user_winning, false),
            AccountMeta::new(self.users[i].usdc, false),
            AccountMeta::new(self.usdc_escrow, false),
            AccountMeta::new_readonly(self.mint_authority, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];
        let ix = anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "redeem",
            &amount.to_le_bytes(),
            metas,
        );
        try_submit(&mut self.fx.svm, ix, &[&user])
    }

    /// Emergency oracle-bypass settle, signed by `signer` (admin or not).
    fn admin_settle(
        &mut self,
        signer: &Keypair,
        yes_wins: bool,
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let metas = vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new_readonly(self.config_pda, false),
            AccountMeta::new(self.market_pda, false),
        ];
        let ix = anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "admin_settle_market",
            &[yes_wins as u8],
            metas,
        );
        try_submit(&mut self.fx.svm, ix, &[signer])
    }

    fn balances(&self, i: usize) -> Balances {
        Balances {
            usdc: read_token_account(&self.fx.svm, &self.users[i].usdc).amount,
            yes: read_token_account(&self.fx.svm, &self.users[i].yes).amount,
            no: read_token_account(&self.fx.svm, &self.users[i].no).amount,
        }
    }

    fn usdc_escrow_amount(&self) -> u64 {
        read_token_account(&self.fx.svm, &self.usdc_escrow).amount
    }

    fn yes_escrow_amount(&self) -> u64 {
        read_token_account(&self.fx.svm, &self.yes_escrow).amount
    }

    fn book(&self) -> meridian::state::Book {
        load_zero_copy_account::<meridian::state::Book>(&self.fx.svm, &self.book_pda)
    }

    fn market(&self) -> meridian::state::Market {
        load_anchor_account(&self.fx.svm, &self.market_pda)
    }

    fn supplies(&self) -> (u64, u64) {
        (
            read_mint(&self.fx.svm, &self.yes_mint).supply,
            read_mint(&self.fx.svm, &self.no_mint).supply,
        )
    }

    /// Plant a fresh Pyth `PriceUpdateV2` at `self.pyth_account` with the
    /// given price (Pyth-scale `i64 * 10^PYTH_EXPONENT`) and publish_time.
    fn plant_pyth(&mut self, price: i64, conf: u64, publish_time: i64) {
        set_pyth_price(
            &mut self.fx.svm,
            self.pyth_account,
            FEED_ID,
            price,
            conf,
            PYTH_EXPONENT,
            publish_time,
        );
    }

    fn plant_pyth_partial(&mut self, price: i64, conf: u64, publish_time: i64) {
        set_pyth_price_partial(
            &mut self.fx.svm,
            self.pyth_account,
            FEED_ID,
            price,
            conf,
            PYTH_EXPONENT,
            publish_time,
        );
    }

    fn advance_clock(&mut self, new_ts: i64) {
        set_clock_unix_ts(&mut self.fx.svm, new_ts);
    }

    /// Admin toggles `Config.require_full_verification` (reuses SetPaused ctx).
    fn set_require_full(&mut self, require_full: bool) {
        let admin = self.fx.admin.insecure_clone();
        let metas = vec![
            AccountMeta::new_readonly(admin.pubkey(), true),
            AccountMeta::new(self.config_pda, false),
        ];
        let ix = anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "set_require_full_verification",
            &[require_full as u8],
            metas,
        );
        submit(&mut self.fx.svm, ix, &[&admin]);
    }

    /// Read the current `Config` account.
    fn config(&self) -> meridian::state::Config {
        load_anchor_account(&self.fx.svm, &self.config_pda)
    }

    /// Admin (or `signer`) rotates `config.treasury` via `set_treasury`, which
    /// reuses the `SetPaused` accounts context (admin signer + mut config).
    fn set_treasury(
        &mut self,
        signer: &Keypair,
        new_treasury: Address,
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let metas = vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(self.config_pda, false),
        ];
        let ix = anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "set_treasury",
            new_treasury.as_ref(),
            metas,
        );
        try_submit(&mut self.fx.svm, ix, &[signer])
    }

    /// Advance the clock to `settled_at + RECOVERY_GRACE_SECONDS + 1` — one
    /// second past the recovery-grace unlock for the currently-settled market.
    fn advance_past_recovery_grace(&mut self) {
        let settled_at = self.market().settled_at;
        assert!(settled_at > 0, "market must be settled before advancing past grace");
        self.advance_clock(settled_at + RECOVERY_GRACE_SECONDS + 1);
    }

    /// Build + submit `admin_force_expire_order`, signed by `signer`. The
    /// `owner_ata`/`treasury_ata` are supplied explicitly so error-path tests
    /// can pass deliberately-wrong accounts. Accounts are in the ABI order
    /// documented on `AdminForceExpireOrder`.
    fn force_expire(
        &mut self,
        signer: &Keypair,
        side: u8,
        price: u64,
        seq: u64,
        owner_ata: Address,
        treasury_ata: Address,
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let args = meridian::AdminForceExpireOrderArgs { side, price, seq };
        let mut data = Vec::new();
        args.serialize(&mut data).unwrap();
        let metas = vec![
            AccountMeta::new(signer.pubkey(), true),
            AccountMeta::new_readonly(self.config_pda, false),
            AccountMeta::new_readonly(self.market_pda, false),
            AccountMeta::new(self.book_pda, false),
            AccountMeta::new(self.usdc_escrow, false),
            AccountMeta::new(self.yes_escrow, false),
            AccountMeta::new_readonly(self.yes_mint, false),
            AccountMeta::new_readonly(owner_ata, false),
            AccountMeta::new(treasury_ata, false),
            AccountMeta::new_readonly(self.mint_authority, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "admin_force_expire_order", &data, metas);
        try_submit(&mut self.fx.svm, ix, &[signer])
    }

    /// `(price, seq)` of the sole resting bid (panics if none).
    fn sole_bid_key(&self) -> (u64, u64) {
        let book = self.book();
        let e = book.bids.as_slice()[0];
        (e.key.price(), e.key.seq())
    }

    /// `(price, seq)` of the sole resting ask (panics if none).
    fn sole_ask_key(&self) -> (u64, u64) {
        let book = self.book();
        let e = book.asks.as_slice()[0];
        (e.key.price(), e.key.seq())
    }
}

/// Mirror of `admin::RECOVERY_GRACE_SECONDS` (30 days). Kept local so the test
/// crate doesn't need to reach into the program's `instructions::admin` module.
const RECOVERY_GRACE_SECONDS: i64 = 30 * 86_400;

#[derive(Debug, PartialEq, Eq)]
struct Balances {
    usdc: u64,
    yes: u64,
    no: u64,
}

/// Convenience: $X.00 → Pyth-scale price at PYTH_EXPONENT = -8.
fn dollars_to_pyth(d: i64) -> i64 {
    d.saturating_mul(100_000_000)
}

// ============================================================
// Scenario tests
// ============================================================

#[test]
fn settle_happy_yes_wins() {
    // META settles at $700 vs strike $680 → YesWins.
    let mut env = Env::new(1, 10_000);
    // Advance clock past expiry, plant fresh oracle.
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);

    env.settle().expect("settle should succeed");
    let m = env.market();
    assert!(m.settled);
    assert_eq!(m.outcome, Some(meridian::state::Outcome::YesWins));
}

#[test]
fn settle_happy_no_wins() {
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(660), 1_000, ts);

    env.settle().expect("settle should succeed");
    let m = env.market();
    assert!(m.settled);
    assert_eq!(m.outcome, Some(meridian::state::Outcome::NoWins));
}

#[test]
fn settle_at_strike_yes_wins() {
    // Edge case: price exactly equals strike. Spec: YesWins (price >= strike).
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(680), 1_000, ts);
    env.settle().expect("settle should succeed");
    assert_eq!(
        env.market().outcome,
        Some(meridian::state::Outcome::YesWins),
        "exactly-at-strike should be YesWins"
    );
}

#[test]
fn settle_fails_before_expiry() {
    let mut env = Env::new(1, 10_000);
    // Clock is below EXPIRY_UNIX.
    env.advance_clock(EXPIRY_UNIX - 100);
    env.plant_pyth(dollars_to_pyth(700), 1_000, EXPIRY_UNIX - 100);
    let err = env.settle().expect_err("settle before expiry must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketNotExpired") || s.contains("custom"),
        "expected MarketNotExpired, got {s}"
    );
}

#[test]
fn settle_fails_stale_oracle() {
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 1000;
    env.advance_clock(ts);
    // publish_time is 880s after expiry → far outside the 30s settlement
    // window, so settle is rejected (OracleStale).
    env.plant_pyth(dollars_to_pyth(700), 1_000, EXPIRY_UNIX + 880);
    let err = env.settle().expect_err("stale oracle must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("OracleStale") || s.contains("custom"),
        "expected OracleStale, got {s}"
    );
}

#[test]
fn settle_fails_price_before_expiry() {
    // A price published before expiry must not settle the option — even
    // though the clock is past expiry, the settlement price has to track the
    // expiry moment. This is the lower bound of the [expiry, expiry+window]
    // pin (anti-cherry-pick: caller can't reach back to a pre-expiry quote).
    let mut env = Env::new(1, 10_000);
    env.advance_clock(EXPIRY_UNIX + 10);
    env.plant_pyth(dollars_to_pyth(700), 1_000, EXPIRY_UNIX - 5);
    let err = env.settle().expect_err("pre-expiry price must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("OracleStale") || s.contains("custom"),
        "expected OracleStale, got {s}"
    );
}

#[test]
fn settle_fails_price_after_window() {
    // A price published more than SETTLE_WINDOW_SECONDS (30) after expiry is
    // rejected. This is the upper bound that bounds the cherry-pick window
    // regardless of how late settle is called.
    let mut env = Env::new(1, 10_000);
    env.advance_clock(EXPIRY_UNIX + 100);
    env.plant_pyth(dollars_to_pyth(700), 1_000, EXPIRY_UNIX + 45);
    let err = env.settle().expect_err("post-window price must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("OracleStale") || s.contains("custom"),
        "expected OracleStale, got {s}"
    );
}

#[test]
fn settle_at_window_edge_succeeds() {
    // publish_time exactly at expiry + SETTLE_WINDOW_SECONDS (30) is the last
    // accepted instant — boundary is inclusive.
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 30;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, EXPIRY_UNIX + 30);
    env.settle().expect("settle at window edge should succeed");
    assert_eq!(
        env.market().outcome,
        Some(meridian::state::Outcome::YesWins),
        "edge-of-window settle should record YesWins"
    );
}

#[test]
fn settle_fails_wide_confidence() {
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    // price = $700 * 10^8 = 70_000_000_000; conf = 2% of price → trips
    // MAX_CONF_BPS = 100 (1%).
    env.plant_pyth(dollars_to_pyth(700), 1_400_000_000, ts);
    let err = env.settle().expect_err("wide-conf oracle must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("OracleConfidenceTooWide") || s.contains("custom"),
        "expected OracleConfidenceTooWide, got {s}"
    );
}

#[test]
fn redeem_when_paused_rejected() {
    // A settled market that is then paused must still reject redeem
    // (ProgramPaused gate runs before the settled check).
    let mut env = Env::new(1, 10_000);
    env.seed_yes(0, 50);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle YesWins");
    env.force_paused();
    let err = env
        .redeem(0, env.yes_mint, env.users[0].yes, 50)
        .expect_err("paused config must reject redeem");
    let s = format!("{err:?}");
    assert!(
        s.contains("ProgramPaused") || s.contains("custom"),
        "expected ProgramPaused, got {s}"
    );
}

#[test]
fn settle_sweep_when_paused_rejected() {
    // Settled market with an open order; pausing must block settle_sweep.
    let mut env = Env::new(1, 10_000);
    env.place_limit(0, 0, 40, 10, &[]).expect("bid posts");
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle");
    env.force_paused();
    let err = env
        .sweep(1, &[env.users[0].usdc])
        .expect_err("paused config must reject settle_sweep");
    let s = format!("{err:?}");
    assert!(
        s.contains("ProgramPaused") || s.contains("custom"),
        "expected ProgramPaused, got {s}"
    );
}

const EMERGENCY_GRACE: i64 = 86_400; // mirror admin::EMERGENCY_GRACE_SECONDS

#[test]
fn admin_settle_before_grace_rejected() {
    // Past expiry but inside the 24h grace window: emergency settle is denied
    // so normal Pyth settlement keeps first claim.
    let mut env = Env::new(1, 10_000);
    let admin = env.fx.admin.insecure_clone();
    env.advance_clock(EXPIRY_UNIX + 1_000); // << EXPIRY + 86_400
    let err = env
        .admin_settle(&admin, true)
        .expect_err("emergency settle before grace must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("EmergencyGraceNotElapsed") || s.contains("custom"),
        "expected EmergencyGraceNotElapsed, got {s}"
    );
    assert!(!env.market().settled, "market must stay unsettled");
}

#[test]
fn admin_settle_non_admin_rejected() {
    let mut env = Env::new(1, 10_000);
    env.advance_clock(EXPIRY_UNIX + EMERGENCY_GRACE + 10);
    let user = env.users[0].kp.insecure_clone(); // not the admin
    let err = env
        .admin_settle(&user, true)
        .expect_err("non-admin emergency settle must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("Unauthorized") || s.contains("custom"),
        "expected Unauthorized, got {s}"
    );
    assert!(!env.market().settled, "market must stay unsettled");
}

#[test]
fn admin_settle_after_grace_succeeds_and_redeems() {
    // Pyth never settled; after the 24h grace the admin stamps YesWins by
    // hand, and the winning side redeems normally — escrow drains, solvent.
    let mut env = Env::new(1, 10_000);
    env.seed_yes(0, 50);
    let admin = env.fx.admin.insecure_clone();
    env.advance_clock(EXPIRY_UNIX + EMERGENCY_GRACE + 10);

    env.admin_settle(&admin, true).expect("emergency settle ok");
    let m = env.market();
    assert!(m.settled, "market settled");
    assert_eq!(
        m.outcome,
        Some(meridian::state::Outcome::YesWins),
        "admin-stamped outcome"
    );

    env.redeem(0, env.yes_mint, env.users[0].yes, 50)
        .expect("winner redeems after emergency settle");
    assert_eq!(env.balances(0).yes, 0, "Yes burned");
    assert_eq!(env.balances(0).usdc, 9_950 + 50, "USDC restored");
    assert_eq!(env.usdc_escrow_amount(), 0, "escrow drained — solvent");
}

#[test]
fn admin_settle_twice_rejected() {
    let mut env = Env::new(1, 10_000);
    let admin = env.fx.admin.insecure_clone();
    env.advance_clock(EXPIRY_UNIX + EMERGENCY_GRACE + 10);
    env.admin_settle(&admin, true).expect("first emergency settle ok");
    let err = env
        .admin_settle(&admin, false)
        .expect_err("second settle must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketSettled") || s.contains("custom"),
        "expected MarketSettled, got {s}"
    );
}

#[test]
fn admin_settle_no_wins_succeeds_and_redeems() {
    // Mirror of admin_settle_after_grace_succeeds_and_redeems for the NoWins
    // branch. Previously the yes_wins=false path of admin_settle_market and the
    // No-side redeem were only hit as the *rejected* second call in
    // admin_settle_twice_rejected — never as a stamped, redeemed outcome.
    let mut env = Env::new(1, 10_000);
    env.seed_yes(0, 50); // 50 Yes + 50 No, 9_950 USDC
    let admin = env.fx.admin.insecure_clone();
    env.advance_clock(EXPIRY_UNIX + EMERGENCY_GRACE + 10);

    env.admin_settle(&admin, false)
        .expect("emergency NoWins settle ok");
    let m = env.market();
    assert!(m.settled, "market settled");
    assert_eq!(
        m.outcome,
        Some(meridian::state::Outcome::NoWins),
        "admin-stamped NoWins"
    );

    // The No holder redeems; escrow drains, proving NoWins is solvent.
    env.redeem(0, env.no_mint, env.users[0].no, 50)
        .expect("No winner redeems after emergency NoWins settle");
    assert_eq!(env.balances(0).no, 0, "No burned");
    assert_eq!(env.balances(0).usdc, 9_950 + 50, "USDC restored");
    assert_eq!(env.usdc_escrow_amount(), 0, "escrow drained — solvent");
}

#[test]
fn settle_already_settled_short_circuits_before_oracle_checks() {
    // Idempotency must win over oracle validation: once settled, a re-submit
    // returns MarketSettled even when the supplied oracle account would
    // otherwise be rejected. We re-submit with a Partial-verified update (which
    // the default require_full_verification rejects with
    // OracleVerificationInsufficient); the settled short-circuit must fire
    // first. Guards the reorder that moved the !settled check ahead of the
    // Pyth owner/deserialize/verification block.
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("first settle ok");
    assert!(env.market().settled);

    // Expire the blockhash so the second settle is a DISTINCT transaction that
    // actually reaches the program (an identical tx is rejected as
    // AlreadyProcessed by the runtime before the handler runs).
    env.fx.svm.expire_blockhash();
    env.plant_pyth_partial(dollars_to_pyth(700), 1_000, ts);
    let err = env.settle().expect_err("re-settle on a settled market must fail");
    let s = format!("{err:?}");
    // The settled short-circuit must fire BEFORE the Pyth verification gate:
    // we expect MarketSettled, NOT OracleVerificationInsufficient (which the
    // planted Partial update would trigger if verification ran first).
    assert!(
        s.contains("MarketSettled"),
        "expected MarketSettled, got {s}"
    );
    assert!(
        !s.contains("OracleVerificationInsufficient"),
        "settled guard must short-circuit BEFORE the verification check; got {s}"
    );
}

#[test]
fn settle_at_lower_window_bound_succeeds() {
    // Inclusive lower bound: a price published at exactly `expiry` settles.
    // settle_fails_price_before_expiry covers expiry-5 (reject) and
    // settle_at_window_edge_succeeds covers expiry+30 (accept, upper edge);
    // this pins the lower edge (publish_time == expiry) as inclusive.
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 10; // clock past expiry so settle is open
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, EXPIRY_UNIX); // published AT expiry
    env.settle()
        .expect("price published at exactly expiry settles (inclusive lower bound)");
    assert!(env.market().settled, "settled at lower window bound");
}

#[test]
fn settle_rejects_partial_when_full_required() {
    // require_full_verification defaults ON, so a Partial-verified Pyth price
    // must be rejected.
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth_partial(dollars_to_pyth(700), 1_000, ts);
    let err = env.settle().expect_err("partial price must be rejected by default");
    let s = format!("{err:?}");
    assert!(
        s.contains("OracleVerificationInsufficient") || s.contains("custom"),
        "expected OracleVerificationInsufficient, got {s}"
    );
    assert!(!env.market().settled, "market must stay unsettled");
}

#[test]
fn settle_accepts_partial_when_relaxed() {
    // Operator relaxes the flag (e.g. devnet); a Partial price then settles.
    let mut env = Env::new(1, 10_000);
    env.set_require_full(false);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth_partial(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("partial price accepted once full not required");
    assert!(env.market().settled, "market settled with relaxed flag");
    assert_eq!(env.market().outcome, Some(meridian::state::Outcome::YesWins));
}

#[test]
fn set_require_full_non_admin_rejected() {
    let mut env = Env::new(1, 10_000);
    let user = env.users[0].kp.insecure_clone(); // not the admin
    let metas = vec![
        AccountMeta::new_readonly(user.pubkey(), true),
        AccountMeta::new(env.config_pda, false),
    ];
    let ix = anchor_ix(
        MERIDIAN_PROGRAM_ID,
        "set_require_full_verification",
        &[0u8],
        metas,
    );
    let err = try_submit(&mut env.fx.svm, ix, &[&user])
        .expect_err("non-admin must not toggle verification requirement");
    let s = format!("{err:?}");
    assert!(
        s.contains("Unauthorized") || s.contains("custom"),
        "expected Unauthorized, got {s}"
    );
}

#[test]
fn settle_fails_twice() {
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("first settle succeeds");
    env.fx.svm.expire_blockhash(); // force a fresh tx signature for the retry
    let err = env.settle().expect_err("second settle must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketSettled") || s.contains("custom"),
        "expected MarketSettled, got {s}"
    );
}

#[test]
fn settle_fails_when_pyth_account_owned_by_wrong_program() {
    // Regression test for the P0 production-deployment finding: settle_market
    // must validate that the price_update account is owned by
    // config.pyth_receiver. The LiteSVM fixture's default initialize_config
    // sets pyth_receiver = MERIDIAN_PROGRAM_ID; plant a Pyth-shaped account
    // owned by some OTHER program and assert settle rejects with
    // InvalidOracleOwner.
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);

    // Construct an "imposter" owner — any pubkey that isn't MERIDIAN_PROGRAM_ID.
    // Use a deterministic non-zero pubkey so a regression is easy to trace.
    let imposter_owner = anchor_lang::prelude::Pubkey::new_from_array([7u8; 32]);
    set_pyth_price_with_owner(
        &mut env.fx.svm,
        env.pyth_account,
        imposter_owner,
        FEED_ID,
        dollars_to_pyth(700),
        1_000,
        PYTH_EXPONENT,
        ts,
    );

    let err = env
        .settle()
        .expect_err("settle must reject Pyth account owned by wrong program");
    let s = format!("{err:?}");
    assert!(
        s.contains("InvalidOracleOwner"),
        "expected InvalidOracleOwner, got {s}",
    );
}

#[test]
fn settle_fails_with_mismatched_feed_id() {
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    // Plant with wrong feed id (the market pins FEED_ID, we send a
    // different one).
    set_pyth_price(
        &mut env.fx.svm,
        env.pyth_account,
        [0u8; 32], // not FEED_ID
        dollars_to_pyth(700),
        1_000,
        PYTH_EXPONENT,
        ts,
    );
    let err = env.settle().expect_err("mismatched feed id must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("OracleFeedIdMismatch") || s.contains("custom"),
        "expected OracleFeedIdMismatch, got {s}"
    );
}

#[test]
fn place_after_settle_rejected() {
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");

    let err = env
        .place_limit(0, 0, 40, 50, &[])
        .expect_err("place after settle must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketSettled") || s.contains("custom"),
        "expected MarketSettled, got {s}"
    );
}

#[test]
fn place_after_expiry_rejected() {
    // Expired but NOT settled: price-discovery trading is closed. The guard
    // lives in place_order_inner, so this also covers place_market_order and
    // buy_no/sell_no (same kernel).
    let mut env = Env::new(1, 10_000);
    env.advance_clock(EXPIRY_UNIX + 10); // past expiry, no settle
    let err = env
        .place_limit(0, 0, 40, 50, &[])
        .expect_err("place after expiry must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketExpired") || s.contains("custom"),
        "expected MarketExpired, got {s}"
    );
}

#[test]
fn mint_pair_allowed_after_expiry() {
    // Par operations stay open past expiry so holders can still build/unwind a
    // pair (a Yes+No pair is always worth exactly $1, outcome-neutral). Only
    // price-discovery trading halts.
    let mut env = Env::new(1, 10_000);
    env.advance_clock(EXPIRY_UNIX + 10);
    env.seed_yes(0, 50); // mint_pair; submit() panics if it were rejected
    assert_eq!(env.balances(0).yes, 50, "mint_pair still works after expiry");
    assert_eq!(env.balances(0).no, 50);
}

#[test]
fn ae1_settle_then_sweep_refunds_open_orders() {
    // AE1: open orders on both sides, settle, then sweep refunds.
    //
    // Setup:
    //   A: 10_000 USDC. Bids 50 Yes @ price=40 → 2_000 USDC locked.
    //   B: 10_000 USDC. seed_yes(50) → 9_950 USDC + 50 Yes + 50 No.
    //      Asks 50 Yes @ price=60 → 50 Yes locked in escrow.
    //
    // After settle: market settled, both orders still resting.
    // After sweep: both orders gone, A gets back 2_000 USDC, B gets back
    //   50 Yes.
    let mut env = Env::new(2, 10_000);
    env.seed_yes(1, 50);

    env.place_limit(0, /* Bid */ 0, 40, 50, &[])
        .expect("A bid posts");
    env.place_limit(1, /* Ask */ 1, 60, 50, &[])
        .expect("B ask posts");

    // Pre-settle state snapshot.
    let pre_a = env.balances(0);
    let pre_b = env.balances(1);
    assert_eq!(env.book().bids.len(), 1);
    assert_eq!(env.book().asks.len(), 1);
    assert_eq!(env.usdc_escrow_amount(), 2_000 + 50, "A bid + B mint_pair");
    assert_eq!(env.yes_escrow_amount(), 50, "B ask collateral");

    // Settle.
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");

    // Subsequent place must fail.
    let err = env
        .place_limit(0, 0, 30, 10, &[])
        .expect_err("place after settle rejected");
    let _ = err;

    // Sweep. Bid first (A is index 0, recipient = A's USDC ATA).
    env.sweep(8, &[env.users[0].usdc, env.users[1].yes])
        .expect("sweep ok");

    // Verify book empty + refunds happened.
    let post_book = env.book();
    assert_eq!(post_book.bids.len(), 0, "bid drained");
    assert_eq!(post_book.asks.len(), 0, "ask drained");

    let post_a = env.balances(0);
    let post_b = env.balances(1);
    assert_eq!(
        post_a.usdc,
        pre_a.usdc + 2_000,
        "A reclaims bid USDC"
    );
    assert_eq!(post_b.yes, pre_b.yes + 50, "B reclaims ask Yes");

    // Escrows drain (modulo unsettled mint_pair USDC which stays put).
    // A had no mint_pair; B minted 50. So USDC escrow holds B's 50.
    assert_eq!(env.usdc_escrow_amount(), 50);
    assert_eq!(env.yes_escrow_amount(), 0);

    // Cursor advanced.
    assert_eq!(env.market().sweep_cursor, 2);
}

#[test]
fn sweep_skips_unrefundable_order_and_continues() {
    // ATA-close DoS regression: a resting order whose payout recipient can't
    // receive (here, an account whose authority != the order owner — same
    // skip branch a closed ATA hits) must NOT wedge the sweep. The valid
    // order still drains; the bad one is skipped and stays in the book.
    let mut env = Env::new(2, 10_000);
    // Two resting bids. Best bid (price 50, user1) pops first, then user0 (40).
    env.place_limit(1, 0, 50, 10, &[]).expect("user1 bid posts");
    env.place_limit(0, 0, 40, 10, &[]).expect("user0 bid posts");
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle");

    let escrow_pre = env.usdc_escrow_amount(); // 10*50 + 10*40 = 900
    // Recipients in pop order: [user1-slot, user0-slot]. user1's slot gets
    // user0's USDC ATA (authority = user0 != user1) → recipient_ok=false →
    // skip. user0's slot is valid → refund 400.
    env.sweep(2, &[env.users[0].usdc, env.users[0].usdc])
        .expect("sweep must not revert on an unrefundable entry");

    assert_eq!(
        env.usdc_escrow_amount(),
        escrow_pre - 400,
        "only user0 (40*10) refunded; user1's 500 still escrowed"
    );
    let book = env.book();
    assert_eq!(book.bids.len(), 1, "user1's bid remains (skipped, re-inserted)");
    assert_eq!(
        book.bids.as_slice()[0].key.price(),
        50,
        "the skipped entry is user1's price-50 bid"
    );
    // Cursor only counts successful drains.
    assert_eq!(env.market().sweep_cursor, 1);
}

#[test]
fn sweep_partial_then_resume() {
    // Post 5 orders (all bids by A); sweep with max_orders=3, then sweep
    // with max_orders=3 again. Second call cleans the rest; cursor
    // advances correctly.
    //
    // Mass: 5 * 10 * 40 = 2000 USDC; cancel 3 → +1200 back to A; then
    // cancel 2 → +800 back. Total returned 2000.
    let mut env = Env::new(1, 10_000);
    for _ in 0..5 {
        env.place_limit(0, 0, 40, 10, &[]).expect("bid posts");
        // Same caller + same args would otherwise dedupe under LiteSVM's
        // blockhash cache (`AlreadyProcessed`); expiring the blockhash
        // between submissions forces a unique tx each time.
        env.fx.svm.expire_blockhash();
    }
    assert_eq!(env.book().bids.len(), 5);
    assert_eq!(env.usdc_escrow_amount(), 5 * 10 * 40);

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");

    // First sweep: 3 orders.
    env.sweep(
        3,
        &[
            env.users[0].usdc,
            env.users[0].usdc,
            env.users[0].usdc,
        ],
    )
    .expect("sweep 1 ok");
    assert_eq!(env.book().bids.len(), 2, "2 remaining after first sweep");
    assert_eq!(env.market().sweep_cursor, 3);
    assert_eq!(env.usdc_escrow_amount(), 2 * 10 * 40);

    // Second sweep: drain rest. Force a fresh blockhash so the new tx
    // isn't deduped against the previous identical-shape sweep.
    env.fx.svm.expire_blockhash();
    env.sweep(3, &[env.users[0].usdc, env.users[0].usdc])
        .expect("sweep 2 ok");
    assert_eq!(env.book().bids.len(), 0, "all drained");
    assert_eq!(env.market().sweep_cursor, 5);
    assert_eq!(env.usdc_escrow_amount(), 0);
}

#[test]
fn sweep_zero_max_orders_noop() {
    let mut env = Env::new(1, 10_000);
    env.place_limit(0, 0, 40, 10, &[]).expect("bid posts");

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");

    let pre_book_len = env.book().bids.len();
    env.sweep(0, &[]).expect("noop sweep ok");
    assert_eq!(env.book().bids.len(), pre_book_len, "book unchanged");
    assert_eq!(env.market().sweep_cursor, 0, "cursor unchanged");
}

#[test]
fn sweep_empty_book_noop() {
    let mut env = Env::new(1, 10_000);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");
    env.sweep(8, &[]).expect("empty sweep ok");
    assert_eq!(env.market().sweep_cursor, 0);
}

#[test]
fn sweep_fails_before_settle() {
    let mut env = Env::new(1, 10_000);
    env.place_limit(0, 0, 40, 10, &[]).expect("bid posts");
    let err = env
        .sweep(1, &[env.users[0].usdc])
        .expect_err("sweep before settle must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketNotSettled") || s.contains("custom"),
        "expected MarketNotSettled, got {s}"
    );
}

#[test]
fn redeem_happy_yes_wins() {
    // User holds 50 Yes from mint_pair; settle YesWins; redeem(50, Yes)
    // → 50 Yes burned, 50 USDC received.
    let mut env = Env::new(1, 10_000);
    env.seed_yes(0, 50);
    // pre: 9_950 USDC + 50 Yes + 50 No, escrow has 50 USDC.
    assert_eq!(env.balances(0).usdc, 9_950);
    assert_eq!(env.balances(0).yes, 50);

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle YesWins");

    env.redeem(0, env.yes_mint, env.users[0].yes, 50)
        .expect("redeem ok");

    let post = env.balances(0);
    assert_eq!(post.yes, 0, "Yes burned");
    assert_eq!(post.no, 50, "No untouched");
    assert_eq!(post.usdc, 9_950 + 50, "USDC restored");
    assert_eq!(env.usdc_escrow_amount(), 0, "escrow drained");
    let (y, _n) = env.supplies();
    assert_eq!(y, 0, "Yes supply zero");
}

#[test]
fn redeem_happy_no_wins() {
    let mut env = Env::new(1, 10_000);
    env.seed_yes(0, 50);

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(660), 1_000, ts);
    env.settle().expect("settle NoWins");

    env.redeem(0, env.no_mint, env.users[0].no, 50)
        .expect("redeem ok");

    let post = env.balances(0);
    assert_eq!(post.no, 0, "No burned");
    assert_eq!(post.yes, 50, "Yes untouched");
    assert_eq!(post.usdc, 9_950 + 50, "USDC restored");
}

#[test]
fn redeem_works_after_clock_advance() {
    // Redeem days later. settle_market doesn't care, redeem doesn't care.
    let mut env = Env::new(1, 10_000);
    env.seed_yes(0, 50);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");

    // Fast forward 7 days.
    env.advance_clock(ts + 7 * 86_400);
    env.redeem(0, env.yes_mint, env.users[0].yes, 50)
        .expect("redeem still works much later");
    assert_eq!(env.balances(0).usdc, 10_000);
}

#[test]
fn redeem_before_settle_rejected() {
    let mut env = Env::new(1, 10_000);
    env.seed_yes(0, 50);
    let err = env
        .redeem(0, env.yes_mint, env.users[0].yes, 50)
        .expect_err("redeem before settle must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketNotSettled") || s.contains("custom"),
        "expected MarketNotSettled, got {s}"
    );
}

#[test]
fn redeem_losing_side_rejected() {
    // YesWins; user tries to redeem with the No mint.
    let mut env = Env::new(1, 10_000);
    env.seed_yes(0, 50);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle YesWins");

    let err = env
        .redeem(0, env.no_mint, env.users[0].no, 50)
        .expect_err("losing side must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("WrongRedeemMint") || s.contains("custom"),
        "expected WrongRedeemMint, got {s}"
    );
}

#[test]
fn redeem_more_than_balance_rejected() {
    let mut env = Env::new(1, 10_000);
    env.seed_yes(0, 50);
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle YesWins");

    let err = env
        .redeem(0, env.yes_mint, env.users[0].yes, 100)
        .expect_err("over-balance redeem must fail");
    let _ = err;
}

#[test]
fn end_to_end_dollar_invariant() {
    // The strongest single test in the U7 suite: assert sum-of-USDC across
    // all user wallets + escrow is conserved across the full lifecycle.
    //
    // Two users start with 10_000 USDC each = 20_000 total. After
    // create → mint → trade → settle → sweep → redeem, the sum across
    // all USDC-bearing accounts must still equal 20_000.
    let mut env = Env::new(2, 10_000);
    let initial_total: u64 = env.balances(0).usdc + env.balances(1).usdc;
    assert_eq!(initial_total, 20_000);

    // A buys some Yes (50 @ price=40) from B's mint+ask.
    env.seed_yes(1, 50); // B: 9_950 USDC, 50 Yes, 50 No
    env.place_limit(1, /* Ask */ 1, 40, 50, &[])
        .expect("B ask posts");
    // A places a crossing bid → 50 Yes flows to A.
    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    env.place_limit(0, /* Bid */ 0, 40, 50, &[maker_pair])
        .expect("A bid fills");

    // Snapshot conservation pre-settle.
    let pre_settle = sum_usdc_everywhere(&env);
    assert_eq!(
        pre_settle, initial_total,
        "USDC conserved through trade"
    );

    // Settle YesWins.
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");

    // No open orders; sweep is a no-op.
    env.sweep(8, &[]).expect("noop sweep ok");

    // A redeems 50 Yes for 50 USDC. B holds 50 No which is now worthless.
    env.redeem(0, env.yes_mint, env.users[0].yes, 50)
        .expect("A redeems");

    // Final conservation check.
    let final_total = sum_usdc_everywhere(&env);
    assert_eq!(
        final_total, initial_total,
        "USDC conserved end-to-end ($1 invariant)"
    );
    // The 50 No tokens are still in B's wallet — worthless but harmless.
    assert_eq!(env.balances(1).no, 50);
    // USDC escrow drained (B's 50 mint_pair USDC stayed put because the
    // No side won zero; A's redemption pulled out the 50 that funded the
    // Yes side at mint time).
    assert_eq!(env.usdc_escrow_amount(), 0);
}

#[test]
fn sweep_throughput_not_throttled_by_frozen_front_order() {
    // #4 sweep throughput not throttled + R15b reentrancy. Four resting bids;
    // the FRONT order's owner has a FROZEN canonical USDC recipient. A single
    // sweep call with enough budget must drain the THREE payable orders behind
    // it (skipped one re-inserted at a FRESH seq → back of the level) — it does
    // NOT burn the whole call re-attempting the bad front order each time. Then
    // after unfreezing, one more call drains the last → converges in 2 calls.
    // R15b: re-running after convergence is a no-op success; cursor monotonic.
    let mut env = Env::new(4, 10_000);
    // Distinct prices so pop order is deterministic: user0 best (price 50),
    // then user1 (45), user2 (44), user3 (43). user0 is the frozen front.
    env.place_limit(0, 0, 50, 10, &[]).expect("u0 bid");
    env.place_limit(1, 0, 45, 10, &[]).expect("u1 bid");
    env.place_limit(2, 0, 44, 10, &[]).expect("u2 bid");
    env.place_limit(3, 0, 43, 10, &[]).expect("u3 bid");

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle");

    let escrow_pre = env.usdc_escrow_amount();
    assert_eq!(escrow_pre, 10 * 50 + 10 * 45 + 10 * 44 + 10 * 43, "all four bids escrowed");

    // Freeze user0's canonical USDC recipient (bid refunds go to USDC ATA).
    freeze_token_account(&mut env.fx.svm, &env.users[0].usdc);

    // One sweep call, budget 4, recipients in pop order: u0(frozen), u1, u2, u3.
    env.sweep(
        4,
        &[
            env.users[0].usdc,
            env.users[1].usdc,
            env.users[2].usdc,
            env.users[3].usdc,
        ],
    )
    .expect("sweep must not revert; drains payable orders behind the frozen front");

    // The 3 payable orders drained in this single call (not throttled); only
    // user0's frozen order remains, re-inserted at the back (fresh seq).
    let book = env.book();
    assert_eq!(book.bids.len(), 1, "only the frozen front order remains");
    assert_eq!(book.bids.as_slice()[0].owner, env.users[0].kp.pubkey().to_bytes());
    assert_eq!(
        env.usdc_escrow_amount(),
        10 * 50, // only user0's 500 still owed
        "u1+u2+u3 refunded in ONE call; only frozen u0 still escrowed",
    );
    // Cursor counts only successful drains.
    assert_eq!(env.market().sweep_cursor, 3, "3 successful drains");

    // Unfreeze user0 and re-crank → the last order drains. Converges (2 calls).
    env.fx.svm.expire_blockhash();
    // Re-create user0's canonical USDC ATA live again (un-freeze == replant as
    // an Initialized, zero-balance ATA at the same canonical address).
    let u0 = env.users[0].kp.pubkey();
    let usdc_mint = env.fx.usdc_mint.pubkey();
    let relived = create_canonical_ata(&mut env.fx.svm, &u0, &usdc_mint);
    assert_eq!(relived, env.users[0].usdc, "same canonical address re-created live");
    env.sweep(4, &[env.users[0].usdc]).expect("re-crank drains last");
    assert_eq!(env.book().bids.len(), 0, "all orders drained — converged");
    assert_eq!(env.usdc_escrow_amount(), 0, "escrow fully drained");
    assert_eq!(env.market().sweep_cursor, 4, "cursor monotonic: 4 total drains");

    // R15b reentrancy: re-running after convergence is a no-op success and the
    // cursor stays put (monotonic, never rewinds).
    env.fx.svm.expire_blockhash();
    env.sweep(4, &[]).expect("post-convergence sweep is a no-op success");
    assert_eq!(env.market().sweep_cursor, 4, "cursor unchanged on no-op re-crank");
    assert_eq!(env.usdc_escrow_amount(), 0);
}

#[test]
fn sweep_skips_non_canonical_recipient_and_recrank_pays() {
    // #4 sweep canonical recipient + skip-on-bad. The cranker is an untrusted
    // PUBLIC caller, so a NON-canonical recipient is SKIPPED (not a tx revert):
    // other refunds in the same batch still succeed. A correct re-crank then
    // pays the skipped owner. (Asymmetry vs the trading path, which reverts.)
    let mut env = Env::new(2, 10_000);
    // Two resting bids: user0 best (price 50), user1 behind (price 45).
    env.place_limit(0, 0, 50, 10, &[]).expect("u0 bid");
    env.place_limit(1, 0, 45, 10, &[]).expect("u1 bid");

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle");

    let escrow_pre = env.usdc_escrow_amount();
    assert_eq!(escrow_pre, 10 * 50 + 10 * 45);

    // Pop order: [u0-slot, u1-slot]. Supply a NON-canonical recipient for u0's
    // slot (user1's USDC ATA, which is canonical for user1, != canonical(u0)).
    // u0's refund must SKIP (not revert); u1's slot is correct → refunded.
    env.sweep(2, &[env.users[1].usdc, env.users[1].usdc])
        .expect("non-canonical recipient must be SKIPPED, not revert the batch");

    // Only u1 (45*10=450) refunded; u0 skipped and re-inserted (fresh seq).
    assert_eq!(
        env.usdc_escrow_amount(),
        escrow_pre - 450,
        "u1 refunded; u0's 500 still escrowed (skipped, not reverted)",
    );
    let book = env.book();
    assert_eq!(book.bids.len(), 1, "u0's bid re-inserted after skip");
    assert_eq!(book.bids.as_slice()[0].owner, env.users[0].kp.pubkey().to_bytes());
    assert_eq!(env.market().sweep_cursor, 1, "only the successful drain counted");

    // Re-crank with u0's CORRECT canonical recipient → pays the skipped owner.
    env.fx.svm.expire_blockhash();
    env.sweep(2, &[env.users[0].usdc]).expect("correct re-crank pays u0");
    assert_eq!(env.book().bids.len(), 0, "u0 finally refunded");
    assert_eq!(env.usdc_escrow_amount(), 0, "escrow fully drained");
    assert_eq!(env.market().sweep_cursor, 2, "cursor monotonic to 2");
}

#[test]
fn sweep_ask_side_not_throttled_by_frozen_front_yes_refund() {
    // Symmetric to sweep_throughput_not_throttled_by_frozen_front_order, but for
    // the ASK side (RefundKind::Yes). The existing sweep tests only freeze the
    // Bid side (USDC refund); this pins the Yes/ask refund path. Four resting
    // ASKS (Yes collateral); the FRONT (best-priced) ask's owner has a FROZEN
    // canonical YES recipient. A single sweep with enough budget must drain the
    // THREE payable asks behind it in ONE call (skipped one re-inserted at a
    // FRESH seq → back of the level) — not throttled by re-attempting the bad
    // front. After thawing, one more call drains the last → converges in 2 calls.
    let mut env = Env::new(4, 10_000);
    // Each maker mints a pair then rests an ask (sells Yes). Ascending prices so
    // pop order is deterministic: user0 best (40, frozen front), then user1 (45),
    // user2 (46), user3 (47). No bids → sweep drains the ask side.
    for i in 0..4 {
        env.seed_yes(i, 10);
    }
    env.place_limit(0, /* Ask */ 1, 40, 10, &[]).expect("u0 ask (front)");
    env.place_limit(1, 1, 45, 10, &[]).expect("u1 ask");
    env.place_limit(2, 1, 46, 10, &[]).expect("u2 ask");
    env.place_limit(3, 1, 47, 10, &[]).expect("u3 ask");

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle");

    // Ask collateral is Yes: 10 from each of the 4 makers = 40 Yes escrowed.
    assert_eq!(env.book().bids.len(), 0, "no bids → ask-side sweep");
    assert_eq!(env.yes_escrow_amount(), 40, "all four asks' Yes escrowed");

    // Freeze user0's canonical YES recipient (ask refunds go to the Yes ATA).
    freeze_token_account(&mut env.fx.svm, &env.users[0].yes);

    // One sweep call, budget 4, recipients in pop order: u0(frozen), u1, u2, u3.
    // Ask refunds bind to each owner's canonical YES ATA.
    env.sweep(
        4,
        &[
            env.users[0].yes,
            env.users[1].yes,
            env.users[2].yes,
            env.users[3].yes,
        ],
    )
    .expect("sweep must not revert; drains payable asks behind the frozen front");

    // The 3 payable asks drained in this single call (not throttled); only u0's
    // frozen order remains, re-inserted at the back (fresh seq).
    let book = env.book();
    assert_eq!(book.asks.len(), 1, "only the frozen front ask remains");
    assert_eq!(book.asks.as_slice()[0].owner, env.users[0].kp.pubkey().to_bytes());
    // yes_escrow drains PARTIALLY: u1+u2+u3 (10 each = 30) refunded; u0's 10 owed.
    assert_eq!(
        env.yes_escrow_amount(),
        10,
        "u1+u2+u3 Yes refunded in ONE call; only frozen u0's 10 still escrowed",
    );
    // The three refunded owners got their 10 Yes back.
    assert_eq!(env.balances(1).yes, 10, "u1 Yes refunded");
    assert_eq!(env.balances(2).yes, 10, "u2 Yes refunded");
    assert_eq!(env.balances(3).yes, 10, "u3 Yes refunded");
    assert_eq!(env.balances(0).yes, 0, "u0 frozen — not yet refunded");
    // Cursor counts only successful drains.
    assert_eq!(env.market().sweep_cursor, 3, "3 successful drains");

    // Thaw user0 (replant a live, zero-balance canonical Yes ATA) and re-crank →
    // the last ask drains and the previously-frozen owner is paid. Converges.
    env.fx.svm.expire_blockhash();
    let u0 = env.users[0].kp.pubkey();
    let yes_mint = env.yes_mint;
    let relived = create_canonical_ata(&mut env.fx.svm, &u0, &yes_mint);
    assert_eq!(relived, env.users[0].yes, "same canonical Yes address re-created live");
    env.sweep(4, &[env.users[0].yes]).expect("re-crank drains the thawed ask");
    assert_eq!(env.book().asks.len(), 0, "all asks drained — converged");
    assert_eq!(env.yes_escrow_amount(), 0, "Yes escrow fully drained");
    assert_eq!(env.balances(0).yes, 10, "previously-frozen u0 now refunded");
    assert_eq!(env.market().sweep_cursor, 4, "cursor monotonic: 4 total drains");
}

/// Sum USDC across both users + the per-market USDC escrow. The total
/// must be invariant across all U7 operations.
fn sum_usdc_everywhere(env: &Env) -> u64 {
    let mut t = 0u64;
    for u in &env.users {
        t += read_token_account(&env.fx.svm, &u.usdc).amount;
    }
    t += env.usdc_escrow_amount();
    t
}

// ============================================================
// U4 — admin_force_expire_order (frozen-collateral recovery)
// ============================================================
//
// The recovery instruction confiscates a permanently-stuck order's escrowed
// collateral to `Config.treasury` after settlement + a 30-day grace, but only
// when the order's owner canonical ATA is provably un-receivable. Every test
// below asserts the escrow-reconciliation / supply-parity / book-state
// invariants the program promises, not just non-revert.

/// U1: `settle_market` stamps `settled_at` to the clock; a fresh market reads 0.
#[test]
fn force_expire_settled_at_stamped_by_settle() {
    let mut env = Env::new(1, 10_000);
    // Fresh market: never settled → settled_at == 0.
    assert_eq!(env.market().settled_at, 0, "fresh market has settled_at == 0");
    assert!(!env.market().settled);

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");

    let m = env.market();
    assert!(m.settled);
    assert_eq!(
        m.settled_at, ts,
        "settle_market stamps settled_at to clock.unix_timestamp"
    );
}

/// U1 (admin path): `admin_settle_market` also stamps `settled_at` to the clock.
#[test]
fn force_expire_settled_at_stamped_by_admin_settle() {
    let mut env = Env::new(1, 10_000);
    let admin = env.fx.admin.insecure_clone();
    let ts = EXPIRY_UNIX + EMERGENCY_GRACE + 123;
    env.advance_clock(ts);
    env.admin_settle(&admin, true).expect("emergency settle ok");
    assert_eq!(
        env.market().settled_at,
        ts,
        "admin_settle_market stamps settled_at too"
    );
}

/// set_treasury: admin rotates `config.treasury`; non-admin → Unauthorized.
#[test]
fn set_treasury_admin_rotates_non_admin_rejected() {
    let mut env = Env::new(1, 10_000);
    let admin = env.fx.admin.insecure_clone();

    // Treasury defaults to the admin at initialize_config.
    assert_eq!(
        env.config().treasury,
        admin.pubkey(),
        "treasury defaults to admin"
    );

    let new_treasury = Keypair::new().pubkey();
    env.set_treasury(&admin, new_treasury)
        .expect("admin rotates treasury");
    assert_eq!(env.config().treasury, new_treasury, "treasury rotated");

    // Non-admin must be rejected; treasury unchanged.
    let user = env.users[0].kp.insecure_clone();
    env.fx.svm.expire_blockhash();
    let err = env
        .set_treasury(&user, Keypair::new().pubkey())
        .expect_err("non-admin set_treasury must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("Unauthorized") || s.contains("custom"),
        "expected Unauthorized, got {s}"
    );
    assert_eq!(
        env.config().treasury,
        new_treasury,
        "treasury unchanged after rejected rotation"
    );
}

/// Happy bid recovery: resting bid, owner freezes their canonical USDC ATA,
/// settle, advance past grace, admin force-expires → treasury USDC ATA gains
/// qty*price, usdc_escrow drops by the same, order gone, R13 reconciles.
#[test]
fn force_expire_happy_bid_recovery() {
    let mut env = Env::new(1, 10_000);
    let admin = env.fx.admin.insecure_clone();
    let usdc_mint = env.fx.usdc_mint.pubkey();

    // Owner (user0) rests a bid: 10 @ price 40 → 400 USDC escrowed.
    env.place_limit(0, /* Bid */ 0, 40, 10, &[]).expect("bid posts");
    let (price, seq) = env.sole_bid_key();
    assert_eq!(env.usdc_escrow_amount(), 400, "bid collateral escrowed");

    // Treasury rotates to a dedicated custody account; create its canonical
    // USDC ATA (zero balance) so the transfer has a live destination.
    let treasury = Keypair::new().pubkey();
    env.set_treasury(&admin, treasury).expect("set treasury");
    let treasury_usdc = create_canonical_ata(&mut env.fx.svm, &treasury, &usdc_mint);

    // Settle, then freeze the owner's canonical USDC ATA → permanently stuck.
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");
    freeze_token_account(&mut env.fx.svm, &env.users[0].usdc);

    // Advance one second past settled_at + grace and recover.
    env.advance_past_recovery_grace();
    let owner_usdc = env.users[0].usdc;
    env.force_expire(&admin, 0, price, seq, owner_usdc, treasury_usdc)
        .expect("admin force-expires the stuck bid");

    // Invariants: treasury gains exactly qty*price; escrow drops by the same;
    // order gone; R13 — escrow now reconciles to zero open notional.
    assert_eq!(
        read_token_account(&env.fx.svm, &treasury_usdc).amount,
        400,
        "treasury USDC ATA gains qty*price = 400"
    );
    assert_eq!(env.usdc_escrow_amount(), 0, "usdc_escrow drained by 400");
    assert_eq!(env.book().bids.len(), 0, "stuck bid removed from book");
    // R13: escrow == Σ open-order notional == 0 (no open orders left).
}

/// Happy ask recovery: resting ask + frozen canonical Yes ATA → treasury Yes
/// ATA gains qty, yes_escrow drops; Yes mint supply unchanged (R14 — recovery
/// is a transfer, not a burn).
#[test]
fn force_expire_happy_ask_recovery() {
    let mut env = Env::new(1, 10_000);
    let admin = env.fx.admin.insecure_clone();
    let yes_mint = env.yes_mint;

    // Owner mints a pair then rests an ask: 10 Yes @ price 60 → 10 Yes escrowed.
    env.seed_yes(0, 10);
    env.place_limit(0, /* Ask */ 1, 60, 10, &[]).expect("ask posts");
    let (price, seq) = env.sole_ask_key();
    assert_eq!(env.yes_escrow_amount(), 10, "ask collateral (Yes) escrowed");
    let (yes_supply_pre, no_supply_pre) = env.supplies();

    let treasury = Keypair::new().pubkey();
    env.set_treasury(&admin, treasury).expect("set treasury");
    let treasury_yes = create_canonical_ata(&mut env.fx.svm, &treasury, &yes_mint);

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");
    // Freeze the owner's canonical YES ATA → ask is permanently stuck.
    freeze_token_account(&mut env.fx.svm, &env.users[0].yes);

    env.advance_past_recovery_grace();
    let owner_yes = env.users[0].yes;
    env.force_expire(&admin, 1, price, seq, owner_yes, treasury_yes)
        .expect("admin force-expires the stuck ask");

    assert_eq!(
        read_token_account(&env.fx.svm, &treasury_yes).amount,
        10,
        "treasury Yes ATA gains qty = 10"
    );
    assert_eq!(env.yes_escrow_amount(), 0, "yes_escrow drained by 10");
    assert_eq!(env.book().asks.len(), 0, "stuck ask removed from book");
    // R14: recovery moves Yes by transfer (not burn) → supplies unchanged.
    let (yes_supply_post, no_supply_post) = env.supplies();
    assert_eq!(yes_supply_post, yes_supply_pre, "Yes supply unchanged (transfer, not burn)");
    assert_eq!(no_supply_post, no_supply_pre, "No supply unchanged");
    assert_eq!(yes_supply_post, no_supply_post, "R14: Yes supply == No supply");
}

/// Timeout not elapsed: force-expire before settled_at + grace →
/// RecoveryGraceNotElapsed; book + escrow unchanged.
#[test]
fn force_expire_before_grace_rejected() {
    let mut env = Env::new(1, 10_000);
    let admin = env.fx.admin.insecure_clone();
    let usdc_mint = env.fx.usdc_mint.pubkey();

    env.place_limit(0, 0, 40, 10, &[]).expect("bid posts");
    let (price, seq) = env.sole_bid_key();

    let treasury = Keypair::new().pubkey();
    env.set_treasury(&admin, treasury).expect("set treasury");
    let treasury_usdc = create_canonical_ata(&mut env.fx.svm, &treasury, &usdc_mint);

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");
    freeze_token_account(&mut env.fx.svm, &env.users[0].usdc);

    // Clock at settled_at + grace - 1 → inside the grace window, must reject.
    let settled_at = env.market().settled_at;
    env.advance_clock(settled_at + RECOVERY_GRACE_SECONDS - 1);

    let escrow_pre = env.usdc_escrow_amount();
    let bids_pre = env.book().bids.len();
    let err = env
        .force_expire(&admin, 0, price, seq, env.users[0].usdc, treasury_usdc)
        .expect_err("force-expire inside grace must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("RecoveryGraceNotElapsed") || s.contains("custom"),
        "expected RecoveryGraceNotElapsed, got {s}"
    );
    assert_eq!(env.usdc_escrow_amount(), escrow_pre, "escrow unchanged");
    assert_eq!(env.book().bids.len(), bids_pre, "book unchanged");
    assert_eq!(read_token_account(&env.fx.svm, &treasury_usdc).amount, 0, "treasury untouched");
}

/// Order not stuck: a resting order whose canonical ATA is live/receivable,
/// post-grace → OrderNotStuck (admin cannot confiscate a healthy order); book
/// unchanged.
#[test]
fn force_expire_order_not_stuck_rejected() {
    let mut env = Env::new(1, 10_000);
    let admin = env.fx.admin.insecure_clone();
    let usdc_mint = env.fx.usdc_mint.pubkey();

    env.place_limit(0, 0, 40, 10, &[]).expect("bid posts");
    let (price, seq) = env.sole_bid_key();

    let treasury = Keypair::new().pubkey();
    env.set_treasury(&admin, treasury).expect("set treasury");
    let treasury_usdc = create_canonical_ata(&mut env.fx.svm, &treasury, &usdc_mint);

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");
    env.advance_past_recovery_grace();

    // The owner's canonical USDC ATA is live & receivable (created at fixture
    // time, never frozen/closed) → the order is NOT stuck.
    let escrow_pre = env.usdc_escrow_amount();
    let bids_pre = env.book().bids.len();
    let err = env
        .force_expire(&admin, 0, price, seq, env.users[0].usdc, treasury_usdc)
        .expect_err("force-expire on a healthy order must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("OrderNotStuck") || s.contains("custom"),
        "expected OrderNotStuck, got {s}"
    );
    assert_eq!(env.usdc_escrow_amount(), escrow_pre, "escrow unchanged");
    assert_eq!(env.book().bids.len(), bids_pre, "book unchanged");
}

/// Non-admin caller: a non-admin signer → Unauthorized; book unchanged.
#[test]
fn force_expire_non_admin_rejected() {
    let mut env = Env::new(1, 10_000);
    let admin = env.fx.admin.insecure_clone();
    let usdc_mint = env.fx.usdc_mint.pubkey();

    env.place_limit(0, 0, 40, 10, &[]).expect("bid posts");
    let (price, seq) = env.sole_bid_key();

    let treasury = Keypair::new().pubkey();
    env.set_treasury(&admin, treasury).expect("set treasury");
    let treasury_usdc = create_canonical_ata(&mut env.fx.svm, &treasury, &usdc_mint);

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");
    freeze_token_account(&mut env.fx.svm, &env.users[0].usdc);
    env.advance_past_recovery_grace();

    let bids_pre = env.book().bids.len();
    let escrow_pre = env.usdc_escrow_amount();
    let user = env.users[0].kp.insecure_clone(); // not the admin
    let err = env
        .force_expire(&user, 0, price, seq, env.users[0].usdc, treasury_usdc)
        .expect_err("non-admin force-expire must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("Unauthorized") || s.contains("custom"),
        "expected Unauthorized, got {s}"
    );
    assert_eq!(env.book().bids.len(), bids_pre, "book unchanged");
    assert_eq!(env.usdc_escrow_amount(), escrow_pre, "escrow unchanged");
}

/// Market not settled: force-expire on an unsettled market → MarketNotSettled.
#[test]
fn force_expire_market_not_settled_rejected() {
    let mut env = Env::new(1, 10_000);
    let admin = env.fx.admin.insecure_clone();
    let usdc_mint = env.fx.usdc_mint.pubkey();

    env.place_limit(0, 0, 40, 10, &[]).expect("bid posts");
    let (price, seq) = env.sole_bid_key();

    let treasury = Keypair::new().pubkey();
    env.set_treasury(&admin, treasury).expect("set treasury");
    let treasury_usdc = create_canonical_ata(&mut env.fx.svm, &treasury, &usdc_mint);

    // Never settle. Even with the clock far in the future, the !settled gate
    // fires first. Freeze the ATA so the only remaining objection is settle.
    freeze_token_account(&mut env.fx.svm, &env.users[0].usdc);
    env.advance_clock(EXPIRY_UNIX + RECOVERY_GRACE_SECONDS + 10);

    let bids_pre = env.book().bids.len();
    let err = env
        .force_expire(&admin, 0, price, seq, env.users[0].usdc, treasury_usdc)
        .expect_err("force-expire on unsettled market must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketNotSettled") || s.contains("custom"),
        "expected MarketNotSettled, got {s}"
    );
    assert_eq!(env.book().bids.len(), bids_pre, "book unchanged");
}

/// Wrong treasury account: a non-canonical / non-treasury destination →
/// InvalidTreasuryAccount; book + escrow unchanged.
#[test]
fn force_expire_wrong_treasury_rejected() {
    let mut env = Env::new(1, 10_000);
    let admin = env.fx.admin.insecure_clone();
    let usdc_mint = env.fx.usdc_mint.pubkey();

    env.place_limit(0, 0, 40, 10, &[]).expect("bid posts");
    let (price, seq) = env.sole_bid_key();

    // Rotate the treasury but then supply a destination that is NOT the
    // treasury's canonical ATA — here the canonical ATA of an unrelated owner.
    let treasury = Keypair::new().pubkey();
    env.set_treasury(&admin, treasury).expect("set treasury");
    let imposter = Keypair::new().pubkey();
    let imposter_usdc = create_canonical_ata(&mut env.fx.svm, &imposter, &usdc_mint);

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");
    freeze_token_account(&mut env.fx.svm, &env.users[0].usdc);
    env.advance_past_recovery_grace();

    let escrow_pre = env.usdc_escrow_amount();
    let bids_pre = env.book().bids.len();
    let err = env
        .force_expire(&admin, 0, price, seq, env.users[0].usdc, imposter_usdc)
        .expect_err("non-treasury destination must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("InvalidTreasuryAccount") || s.contains("custom"),
        "expected InvalidTreasuryAccount, got {s}"
    );
    assert_eq!(env.usdc_escrow_amount(), escrow_pre, "escrow unchanged");
    assert_eq!(env.book().bids.len(), bids_pre, "book unchanged");
    assert_eq!(read_token_account(&env.fx.svm, &imposter_usdc).amount, 0, "imposter untouched");
}

/// Full drain: one payable order + one permanently-stuck order → settle_sweep
/// drains the payable one, admin force-expires the stuck one → both book sides
/// empty, both escrows reconcile to zero.
#[test]
fn force_expire_full_drain_to_empty_book() {
    let mut env = Env::new(2, 10_000);
    let admin = env.fx.admin.insecure_clone();
    let usdc_mint = env.fx.usdc_mint.pubkey();

    // user0: payable bid (10 @ 50 → 500 USDC). user1: stuck bid (10 @ 40 → 400).
    env.place_limit(0, 0, 50, 10, &[]).expect("u0 bid (payable)");
    env.place_limit(1, 0, 40, 10, &[]).expect("u1 bid (stuck)");
    let (stuck_price, stuck_seq) = {
        // user1's bid is the price-40 entry; user0's is price-50 (best).
        let book = env.book();
        let e = book
            .bids
            .as_slice()
            .iter()
            .find(|e| e.key.price() == 40)
            .copied()
            .expect("u1 bid present");
        (e.key.price(), e.key.seq())
    };
    assert_eq!(env.usdc_escrow_amount(), 500 + 400, "both bids escrowed");

    let treasury = Keypair::new().pubkey();
    env.set_treasury(&admin, treasury).expect("set treasury");
    let treasury_usdc = create_canonical_ata(&mut env.fx.svm, &treasury, &usdc_mint);

    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");

    // user1 is permanently stuck: close their canonical USDC ATA.
    close_token_account(&mut env.fx.svm, &env.users[1].usdc);

    // Sweep with the best (user0) bid first: it drains, the stuck user1 bid is
    // skipped and re-inserted. Recipients in pop order: [u0, u1].
    env.sweep(2, &[env.users[0].usdc, env.users[1].usdc])
        .expect("sweep drains the payable bid, skips the stuck one");
    assert_eq!(env.book().bids.len(), 1, "only the stuck bid remains");
    assert_eq!(env.usdc_escrow_amount(), 400, "only the stuck 400 still escrowed");

    // The stuck bid was re-inserted at a FRESH seq during the sweep skip — read
    // the current key before force-expiring.
    let _ = (stuck_price, stuck_seq);
    let (price, seq) = env.sole_bid_key();
    assert_eq!(price, 40, "remaining bid is the stuck price-40 order");

    env.advance_past_recovery_grace();
    env.force_expire(&admin, 0, price, seq, env.users[1].usdc, treasury_usdc)
        .expect("admin force-expires the stuck bid → fully drained");

    // Both book sides empty; both escrows reconcile to zero.
    let book = env.book();
    assert_eq!(book.bids.len(), 0, "bids empty");
    assert_eq!(book.asks.len(), 0, "asks empty");
    assert_eq!(env.usdc_escrow_amount(), 0, "usdc_escrow fully drained");
    assert_eq!(env.yes_escrow_amount(), 0, "yes_escrow zero");
    assert_eq!(
        read_token_account(&env.fx.svm, &treasury_usdc).amount,
        400,
        "treasury custodies the recovered 400 USDC"
    );
    // user0 reclaimed their 500 via the normal sweep.
    assert_eq!(env.balances(0).usdc, 10_000, "u0 fully refunded via sweep");
}
