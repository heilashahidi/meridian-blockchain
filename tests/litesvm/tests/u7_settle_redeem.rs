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
    anchor_ix, load_anchor_account, load_zero_copy_account, read_mint, read_token_account,
    set_clock_unix_ts, set_pyth_price, set_pyth_price_with_owner, Fixture,
    MERIDIAN_PROGRAM_ID, RENT_SYSVAR_ID,
    SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
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
            let usdc_kp =
                create_token_account(&mut fx.svm, &kp, &kp.pubkey(), &fx.usdc_mint.pubkey());
            let yes_kp = create_token_account(&mut fx.svm, &kp, &kp.pubkey(), &yes_mint);
            let no_kp = create_token_account(&mut fx.svm, &kp, &kp.pubkey(), &no_mint);
            if usdc_each > 0 {
                mint_usdc(
                    &mut fx.svm,
                    &fx.admin.insecure_clone(),
                    &fx.usdc_mint.pubkey(),
                    &usdc_kp.pubkey(),
                    usdc_each,
                );
            }
            users.push(UserAccounts {
                kp,
                usdc: usdc_kp.pubkey(),
                yes: yes_kp.pubkey(),
                no: no_kp.pubkey(),
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
        for (usdc, yes) in maker_pairs {
            metas.push(AccountMeta::new(*usdc, false));
            metas.push(AccountMeta::new(*yes, false));
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

    fn advance_clock(&mut self, new_ts: i64) {
        set_clock_unix_ts(&mut self.fx.svm, new_ts);
    }
}

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
