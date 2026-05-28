//! U5 LiteSVM test: `place_limit_order`, `place_market_order`,
//! `cancel_order` end-to-end against the deployed Anchor program.
//!
//! Covers the plan §U5 test list plus the AE2 (book deeper than CU cap)
//! and AE4 (cancel partially-filled order) acceptance examples.
//!
//! Scenarios (one `#[test]` each):
//!
//!   * `happy_bid_only_rests_on_book` — A places limit bid 100 @ $0.40,
//!     book shows the bid, USDC escrow == $40.
//!   * `happy_bid_then_crossing_ask_matches` — A bids, B asks at same
//!     price, both cleared, USDC + Yes correctly routed.
//!   * `partial_fill_residual_posts` — A bids 100, B asks 60 → A bid
//!     trims to 40, B gets $24, A gets 60 Yes.
//!   * `price_improvement_refunds_buyer` — A bids 100 @ $0.50, B asks
//!     100 @ $0.40 → fills at $0.40, A gets 100 Yes + $10 refund.
//!   * `cancel_returns_escrowed_usdc` — A places, cancels, escrow drains.
//!   * `cancel_after_partial_fill_returns_remainder_only` — A bids 100,
//!     partial fill 40, A cancels remaining 60 → A gets $24 refund.
//!   * `market_order_partial_fill_at_cap` — book has 6 small asks; market
//!     buy crosses all but cap fires after `MAX_FILLS_PER_TX` fills; the
//!     residual is rejected and refunded.
//!   * `place_on_settled_market_rejected` — mutate Market.settled = true
//!     via set_account, attempt place → MarketSettled.
//!   * `cancel_by_non_owner_rejected` — A places, B tries to cancel →
//!     Unauthorized, book unchanged.
//!   * `market_order_against_empty_book_residual_refunded` — taker pays
//!     nothing of consequence.
//!   * `market_order_beyond_slippage_no_fill` — book has ask at $0.50,
//!     market buy with slippage_bound $0.40 → no fill, full revert.
//!   * `invariant_holds_after_complex_sequence` — runs the happy paths
//!     in sequence and asserts the USDC escrow / Yes escrow / supply
//!     reconciliation invariants.
//!
//! The shared `Env` struct owns the SVM, a Market, the mint authority,
//! and N pre-created users with USDC + Yes + No ATAs already minted. The
//! per-test setup mirrors `u4_mint_burn`'s `Env` — but extended for
//! multi-user scenarios and pre-loaded with Yes via mint_pair so users
//! can post asks without us needing a separate "deal Yes" helper.

#![allow(clippy::too_many_arguments)]

use anchor_lang::{AccountSerialize, AnchorSerialize};
use litesvm::LiteSVM;
use meridian_litesvm_tests::{
    anchor_ix, load_anchor_account, load_zero_copy_account, read_mint, read_token_account,
    Fixture, MERIDIAN_PROGRAM_ID, RENT_SYSVAR_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_interface::instruction as token_instruction;

// ---------- helpers ----------

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

/// One market + N users with token accounts and seeded balances.
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
    users: Vec<UserAccounts>,
}

struct UserAccounts {
    kp: Keypair,
    usdc: Address,
    yes: Address,
    no: Address,
}

impl Env {
    /// Build with `n_users` test wallets, each seeded with `usdc_each`
    /// USDC. Yes/No balances are zero — tests that need Yes call
    /// `seed_yes` to mint_pair on a user.
    fn new(n_users: usize, usdc_each: u64) -> Self {
        let mut fx = Fixture::new();
        let (config_pda, _) = fx.config_pda();

        // ----- initialize_config -----
        let fee_authority = Keypair::new().pubkey();
        let init_ix = anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "initialize_config",
            &fee_authority.to_bytes().to_vec(),
            vec![
                AccountMeta::new(fx.admin.pubkey(), true),
                AccountMeta::new(config_pda, false),
                AccountMeta::new_readonly(fx.usdc_mint.pubkey(), false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            ],
        );
        fx.submit_admin_ix(init_ix);

        // ----- create_strike_market -----
        let ticker: [u8; 8] = *b"META\0\0\0\0";
        let strike_price: u64 = 680_000_000;
        let expiry_unix: i64 = 86_400;
        let pyth_feed_id = [0u8; 32];
        let (market_pda, _) = fx.market_pda(&ticker, strike_price, expiry_unix);
        let (book_pda, _) = fx.book_pda(&market_pda);
        let (mint_authority, _) = fx.mint_authority_pda(&market_pda);
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

        // ----- create users -----
        let mut users = Vec::with_capacity(n_users);
        for _ in 0..n_users {
            let kp = Keypair::new();
            airdrop_sol(&mut fx.svm, &kp.pubkey(), 10_000_000_000);
            let usdc_kp = create_token_account(&mut fx.svm, &kp, &kp.pubkey(), &fx.usdc_mint.pubkey());
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
            users,
        }
    }

    /// Mint `amount` Yes + No to user `i` via the `mint_pair` instruction.
    /// Requires the user has ≥ `amount` USDC. After this the user holds
    /// `amount` Yes, `amount` No, USDC decreased by `amount`.
    fn seed_yes(&mut self, i: usize, amount: u64) {
        let user_pubkey = self.users[i].kp.pubkey();
        let user_usdc = self.users[i].usdc;
        let user_yes = self.users[i].yes;
        let user_no = self.users[i].no;
        let metas = vec![
            AccountMeta::new(user_pubkey, true),
            AccountMeta::new_readonly(self.config_pda, false),
            AccountMeta::new_readonly(self.market_pda, false),
            AccountMeta::new(user_usdc, false),
            AccountMeta::new(self.usdc_escrow, false),
            AccountMeta::new(self.yes_mint, false),
            AccountMeta::new(self.no_mint, false),
            AccountMeta::new(user_yes, false),
            AccountMeta::new(user_no, false),
            AccountMeta::new_readonly(self.mint_authority, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "mint_pair", &amount.to_le_bytes(), metas);
        let kp = self.users[i].kp.insecure_clone();
        submit(&mut self.fx.svm, ix, &[&kp]);
    }

    /// Place a limit order on behalf of user `i`. `maker_pairs` is an
    /// ordered list of `(usdc_ata, yes_ata)` pairs the program will
    /// settle fills against — empty means "no fills expected".
    fn place_limit(
        &mut self,
        i: usize,
        side: u8,
        price: u64,
        qty: u64,
        maker_pairs: &[(Address, Address)],
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let ix = self.build_place_limit_ix(i, side, price, qty, maker_pairs);
        let kp = self.users[i].kp.insecure_clone();
        try_submit(&mut self.fx.svm, ix, &[&kp])
    }

    fn build_place_limit_ix(
        &self,
        i: usize,
        side: u8,
        price: u64,
        qty: u64,
        maker_pairs: &[(Address, Address)],
    ) -> Instruction {
        let args = meridian::PlaceLimitOrderArgs { side, price, qty };
        let mut data = Vec::new();
        args.serialize(&mut data).unwrap();
        let metas = self.place_metas(i, maker_pairs);
        anchor_ix(MERIDIAN_PROGRAM_ID, "place_limit_order", &data, metas)
    }

    fn place_market(
        &mut self,
        i: usize,
        side: u8,
        qty: u64,
        slippage_bound: u64,
        maker_pairs: &[(Address, Address)],
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let ix = self.build_place_market_ix(i, side, qty, slippage_bound, maker_pairs);
        let kp = self.users[i].kp.insecure_clone();
        try_submit(&mut self.fx.svm, ix, &[&kp])
    }

    fn build_place_market_ix(
        &self,
        i: usize,
        side: u8,
        qty: u64,
        slippage_bound: u64,
        maker_pairs: &[(Address, Address)],
    ) -> Instruction {
        let args = meridian::PlaceMarketOrderArgs {
            side,
            qty,
            slippage_bound,
        };
        let mut data = Vec::new();
        args.serialize(&mut data).unwrap();
        let metas = self.place_metas(i, maker_pairs);
        anchor_ix(MERIDIAN_PROGRAM_ID, "place_market_order", &data, metas)
    }

    fn place_metas(&self, i: usize, maker_pairs: &[(Address, Address)]) -> Vec<AccountMeta> {
        let mut v = vec![
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
            v.push(AccountMeta::new(*usdc, false));
            v.push(AccountMeta::new(*yes, false));
        }
        v
    }

    fn cancel(
        &mut self,
        i: usize,
        side: u8,
        price: u64,
        seq: u64,
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let args = meridian::CancelOrderArgs { side, price, seq };
        let mut data = Vec::new();
        args.serialize(&mut data).unwrap();
        let metas = vec![
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
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "cancel_order", &data, metas);
        let kp = self.users[i].kp.insecure_clone();
        try_submit(&mut self.fx.svm, ix, &[&kp])
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

    fn force_settled(&mut self) {
        let market: meridian::state::Market =
            load_anchor_account(&self.fx.svm, &self.market_pda);
        let updated = meridian::state::Market {
            settled: true,
            outcome: Some(meridian::state::Outcome::YesWins),
            ..market
        };
        let mut account = self
            .fx
            .svm
            .get_account(&self.market_pda)
            .expect("market exists");
        let mut buf: Vec<u8> = Vec::new();
        updated.try_serialize(&mut buf).expect("serialize Market");
        account.data = buf;
        self.fx
            .svm
            .set_account(self.market_pda, account)
            .expect("set_account settled=true");
    }

}

#[derive(Debug, PartialEq, Eq)]
struct Balances {
    usdc: u64,
    yes: u64,
    no: u64,
}

// ============================================================
// Scenario tests
// ============================================================

#[test]
fn happy_bid_only_rests_on_book() {
    // A places limit bid 100 Yes @ price=40 microunits/Yes → 100 * 40 =
    // 4_000 USDC locked. Book has 1 bid, escrow holds 4_000.
    let mut env = Env::new(1, 10_000);

    env.place_limit(0, /* side=Bid */ 0, 40, 100, &[])
        .expect("bid should rest cleanly");

    let book = env.book();
    assert_eq!(book.bids.len(), 1, "exactly one resting bid");
    assert_eq!(book.asks.len(), 0);
    let entry = book.bids.as_slice()[0];
    assert_eq!(entry.qty, 100);
    assert_eq!(entry.key.price(), 40);
    assert_eq!(entry.owner, env.users[0].kp.pubkey().to_bytes());

    let bal = env.balances(0);
    assert_eq!(bal.usdc, 10_000 - 4_000, "user paid 4_000 USDC into escrow");
    assert_eq!(env.usdc_escrow_amount(), 4_000);
    assert_eq!(env.yes_escrow_amount(), 0);
}

#[test]
fn happy_bid_then_crossing_ask_matches() {
    // A bids 100 Yes @ price=40 (microunits/Yes); B mints 100 Yes via
    // mint_pair then asks 100 @ price=40 → matches fully, both sides
    // empty. usdc_each=10_000.
    //
    // Expected end state:
    //   A: 10_000 - 4000 (= 100*40) = 6_000 USDC + 100 Yes
    //   B: 10_000 - 100 (mint_pair) + 4000 (sale) = 13_900 USDC + 0 Yes
    //   USDC escrow: 100 (B's mint_pair only)
    //   Yes escrow: 0
    let mut env = Env::new(2, 10_000);
    env.seed_yes(1, 100);

    env.place_limit(0, 0, 40, 100, &[]).expect("A bid posts");

    let maker_pair = (env.users[0].usdc, env.users[0].yes);
    env.place_limit(1, /* side=Ask */ 1, 40, 100, &[maker_pair])
        .expect("B ask should fill A bid");

    let book = env.book();
    assert_eq!(book.bids.len(), 0);
    assert_eq!(book.asks.len(), 0);

    let a = env.balances(0);
    let b = env.balances(1);
    assert_eq!(a.usdc, 6_000);
    assert_eq!(a.yes, 100);
    assert_eq!(b.usdc, 13_900);
    assert_eq!(b.yes, 0);

    assert_eq!(env.usdc_escrow_amount(), 100);
    assert_eq!(env.yes_escrow_amount(), 0);
}

#[test]
fn partial_fill_residual_posts() {
    // A bids 100 @ price=40 (microunits/Yes) → escrow locks 100 * 40 =
    // 4000. B asks 60 @ price=40 → 60 fill, A's bid trimmed to 40.
    // B gets 60*40 = 2400 USDC; A gets 60 Yes. With usdc_each=10_000:
    //
    //   A: 10_000 - 4000 (lock) = 6_000 USDC + 60 Yes
    //   B: 10_000 - 100 (mint_pair) + 2400 (sale) = 12_300 USDC + 40 Yes
    //
    // USDC escrow: 100 (B's mint_pair) + 1_600 (A's residual 40*40 still
    // locked for the open bid) = 1_700.
    let mut env = Env::new(2, 10_000);
    env.seed_yes(1, 100);

    env.place_limit(0, 0, 40, 100, &[]).expect("A bid posts");
    let maker_pair = (env.users[0].usdc, env.users[0].yes);
    env.place_limit(1, 1, 40, 60, &[maker_pair])
        .expect("B ask fills 60 of A's bid");

    let book = env.book();
    assert_eq!(book.bids.len(), 1);
    assert_eq!(book.bids.as_slice()[0].qty, 40);
    assert_eq!(book.bids.as_slice()[0].key.price(), 40);
    assert_eq!(book.asks.len(), 0);

    let a = env.balances(0);
    let b = env.balances(1);
    assert_eq!(a.usdc, 6_000);
    assert_eq!(a.yes, 60);
    assert_eq!(b.usdc, 12_300);
    assert_eq!(b.yes, 40);

    assert_eq!(env.usdc_escrow_amount(), 1_700);
    assert_eq!(env.yes_escrow_amount(), 0);
}

#[test]
fn price_improvement_refunds_buyer() {
    // A wants to buy 100 Yes at up to $0.50; the best ask is at $0.40.
    // The match should cross at $0.40 (the maker price), and A should
    // be refunded the (50 - 40) * 100 = 1000 microunit price improvement.
    let mut env = Env::new(2, 10_000);
    env.seed_yes(1, 100); // B mints 100 Yes

    // B posts ask at $0.40.
    env.place_limit(1, 1, 40, 100, &[]).expect("B ask posts");

    // A places bid at $0.50 for 100 — fills against B at $0.40.
    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    env.place_limit(0, 0, 50, 100, &[maker_pair])
        .expect("A bid fills at B's ask price");

    let book = env.book();
    assert_eq!(book.bids.len(), 0);
    assert_eq!(book.asks.len(), 0);

    let a = env.balances(0);
    let b = env.balances(1);
    // A: locked 100*50 = 5000, filled at 100*40 = 4000 → refund 1000.
    // Net USDC: 10_000 - 5000 + 1000 = 6000.
    assert_eq!(a.usdc, 6_000);
    assert_eq!(a.yes, 100);
    // B: -100 from mint_pair, +4000 from sale; net 10_000 - 100 + 4000 = 13_900.
    assert_eq!(b.usdc, 13_900);
    assert_eq!(b.yes, 0);

    // USDC escrow: only the 100 from B's mint_pair stays.
    assert_eq!(env.usdc_escrow_amount(), 100);
    assert_eq!(env.yes_escrow_amount(), 0);
}

#[test]
fn cancel_returns_escrowed_usdc() {
    let mut env = Env::new(1, 10_000);

    env.place_limit(0, 0, 40, 100, &[]).expect("bid posts");
    let book_before = env.book();
    let seq = book_before.bids.as_slice()[0].key.seq();
    assert_eq!(env.usdc_escrow_amount(), 4_000);

    env.cancel(0, 0, 40, seq).expect("owner cancels their order");

    let book_after = env.book();
    assert_eq!(book_after.bids.len(), 0);
    assert_eq!(env.usdc_escrow_amount(), 0);
    let bal = env.balances(0);
    assert_eq!(bal.usdc, 10_000, "USDC fully refunded to owner");
}

#[test]
fn cancel_after_partial_fill_returns_remainder_only() {
    let mut env = Env::new(2, 10_000);
    env.seed_yes(1, 100);

    env.place_limit(0, 0, 40, 100, &[]).expect("A bid posts");
    let seq = env.book().bids.as_slice()[0].key.seq();

    let maker_pair = (env.users[0].usdc, env.users[0].yes);
    env.place_limit(1, 1, 40, 60, &[maker_pair])
        .expect("partial fill 60");

    // Cancel A's remaining 40-qty bid. Refund = 40 * 40 = 1600.
    env.cancel(0, 0, 40, seq).expect("A cancels");

    let book = env.book();
    assert_eq!(book.bids.len(), 0);

    let a = env.balances(0);
    // A pre-fill USDC was 10_000 - 4000 (lock) = 6000. After cancel
    // refund of 1600: 6000 + 1600 = 7600. (Plus the 60 Yes received.)
    assert_eq!(a.usdc, 7_600);
    assert_eq!(a.yes, 60);
}

#[test]
fn market_order_partial_fill_at_cap() {
    // AE2: post MAX_FILLS_PER_TX + 2 = 6 individual asks (each from a
    // different user so we can use distinct maker pairs without
    // self-trade). A market buy for the full quantity hits only the cap;
    // residual is refunded.
    //
    // To keep the test fixture small we use 6 makers (users 1..=6) each
    // posting 1 Yes at $0.40. User 0 then market-buys 10 Yes with a
    // generous slippage bound.
    let n_users = 7;
    let mut env = Env::new(n_users, 10_000);
    for i in 1..=6 {
        env.seed_yes(i, 1);
        env.place_limit(i, 1, 40, 1, &[])
            .unwrap_or_else(|e| panic!("maker {i} ask posts: {e:?}"));
    }

    let book_pre = env.book();
    assert_eq!(book_pre.asks.len(), 6, "6 asks posted");

    // Build maker pairs for the first MAX_FILLS_PER_TX = 4 asks.
    // The asks are sorted price-asc, seq-asc → maker order is users 1, 2, 3, 4.
    let max_fills = meridian::instructions::place_limit_order::MAX_FILLS_PER_TX;
    assert_eq!(max_fills, 4);
    let maker_pairs: Vec<(Address, Address)> = (1..=max_fills)
        .map(|i| (env.users[i].usdc, env.users[i].yes))
        .collect();

    // User 0 has 10_000 USDC. Try to buy 10 Yes @ slippage cap $1.00 = 100.
    // Pre-deposit lock = 10 * 100 = 1000. After 4 fills at 40 each
    // (= 160), price improvement refund = 4 * (100 - 40) = 240, residual
    // refund = (10 - 4) * 100 = 600. Final balance:
    // 10_000 - 1000 + 160(taken from escrow to makers) -- wait,
    // the escrow logic:
    //   * step 1: user_usdc → escrow, 1000
    //   * step 3: per-fill: escrow → maker_usdc, 40 each (4 makers,
    //     total 160); also yes_escrow → user_yes
    //   * step 4: refund (price improvement on filled): (100 - 40) * 4
    //     = 240 → user_usdc
    //   * step 5 (market residual): refund (10 - 4) * 100 = 600 → user_usdc
    //
    // Final user USDC: 10_000 - 1000 + 240 + 600 = 9_840.
    let res = env.place_market(0, 0, 10, /* slippage */ 100, &maker_pairs);
    res.expect("market buy fills 4 then rejects residual");

    let a = env.balances(0);
    assert_eq!(a.yes, 4, "user 0 received 4 Yes (cap)");
    assert_eq!(a.usdc, 9_840, "rest of lock refunded");

    // The book still has 2 asks resting (users 5 and 6).
    let book_post = env.book();
    assert_eq!(book_post.asks.len(), 2);

    // Each maker (1..=4) received 40 microunits USDC. Started 10_000,
    // minted 1 Yes (-1 USDC), sold 1 Yes (+40 USDC) → 10_039.
    for i in 1..=4 {
        let b = env.balances(i);
        assert_eq!(b.usdc, 10_039, "maker {i} received sale proceeds");
        assert_eq!(b.yes, 0);
    }
    // Makers 5..=6 still rest on book; they minted but didn't sell.
    for i in 5..=6 {
        let b = env.balances(i);
        assert_eq!(b.usdc, 9_999, "maker {i} only paid the mint_pair $1");
        assert_eq!(b.yes, 0, "maker {i}'s Yes is in the escrow");
    }
    // Yes escrow holds the 2 unsold Yes from makers 5..=6.
    assert_eq!(env.yes_escrow_amount(), 2);
}

#[test]
fn place_on_settled_market_rejected() {
    let mut env = Env::new(1, 10_000);
    env.force_settled();

    let err = env
        .place_limit(0, 0, 40, 100, &[])
        .expect_err("settled market must reject place_limit_order");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketSettled") || s.contains("custom"),
        "expected MarketSettled error, got {s}",
    );
}

#[test]
fn cancel_by_non_owner_rejected() {
    let mut env = Env::new(2, 10_000);

    env.place_limit(0, 0, 40, 100, &[]).expect("A bid posts");
    let book_pre = env.book();
    let seq = book_pre.bids.as_slice()[0].key.seq();

    let err = env
        .cancel(1, 0, 40, seq)
        .expect_err("non-owner cancel must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("Unauthorized") || s.contains("custom"),
        "expected Unauthorized, got {s}",
    );

    // Crucial: the book must be unchanged after the failed cancel.
    let book_post = env.book();
    assert_eq!(book_post.bids.len(), 1);
    assert_eq!(book_post.bids.as_slice()[0].qty, 100);
    assert_eq!(book_post.bids.as_slice()[0].key.price(), 40);
    // Escrow unchanged too.
    assert_eq!(env.usdc_escrow_amount(), 4_000);
}

#[test]
fn market_order_against_empty_book_residual_refunded() {
    let mut env = Env::new(1, 10_000);

    // User has 0 Yes; selling at market against an empty bid book should
    // fail before any state mutation (the user_yes balance check or the
    // initial yes-escrow transfer will trip).
    let err = env
        .place_market(0, /* Ask */ 1, 50, /* slippage_bound */ 1, &[])
        .expect_err("market-sell with 0 Yes must fail");
    let _ = err;

    // Same for buy: bid against empty asks. Pre-deposit 50 * 100 = 5000;
    // 0 fills; refund 5000. End balance = 10_000.
    env.place_market(0, /* Bid */ 0, 50, /* slippage */ 100, &[])
        .expect("market-buy against empty book succeeds with full refund");
    let bal = env.balances(0);
    assert_eq!(bal.usdc, 10_000, "USDC fully refunded");
    assert_eq!(bal.yes, 0);
    assert_eq!(env.usdc_escrow_amount(), 0);
}

#[test]
fn market_order_beyond_slippage_no_fill() {
    let mut env = Env::new(2, 10_000);
    env.seed_yes(1, 50);
    env.place_limit(1, 1, 50, 50, &[]).expect("ask at $0.50");

    // Market buy with slippage cap $0.40 — should NOT fill (best ask at
    // 50 > cap 40). Residual rejected, full refund.
    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    env.place_market(0, 0, 50, 40, &[maker_pair])
        .expect("market buy below slippage returns full refund (no fill)");

    let book = env.book();
    assert_eq!(book.asks.len(), 1, "ask still resting");
    let bal = env.balances(0);
    assert_eq!(bal.usdc, 10_000, "USDC fully refunded");
    assert_eq!(bal.yes, 0);
}

#[test]
fn invariant_holds_after_complex_sequence() {
    // Compose several happy paths and assert key reconciliation totals
    // after each step.
    let mut env = Env::new(3, 100_000);
    env.seed_yes(1, 1000); // B mints 1000 Yes (escrow now holds 1000 USDC)
    env.seed_yes(2, 500); // C mints 500 Yes (escrow now holds 1500 USDC)

    let mint_pair_total = 1500_u64;

    // A places bids; B partially crosses; C cancels.
    env.place_limit(0, 0, 40, 200, &[]).expect("A bid 200@40"); // lock 8_000
    env.place_limit(2, 1, 60, 100, &[]).expect("C ask 100@60"); // 100 Yes locked

    // B asks 80 @ $0.40 → fills A's bid for 80.
    let pair_a = (env.users[0].usdc, env.users[0].yes);
    env.place_limit(1, 1, 40, 80, &[pair_a]).expect("B partial fill");

    // Sanity: A's bid trimmed to 120, C's ask still at 100, no other resting.
    let book = env.book();
    assert_eq!(book.bids.len(), 1);
    assert_eq!(book.bids.as_slice()[0].qty, 120);
    assert_eq!(book.asks.len(), 1);
    assert_eq!(book.asks.as_slice()[0].qty, 100);

    // Reconcile: USDC escrow holds
    //   mint_pair_total (1500) + A's bid residual (120 * 40 = 4800) = 6300.
    assert_eq!(env.usdc_escrow_amount(), mint_pair_total + 120 * 40);
    // Yes escrow holds C's resting 100.
    assert_eq!(env.yes_escrow_amount(), 100);

    // Now A cancels remaining bid.
    let seq_a = book.bids.as_slice()[0].key.seq();
    env.cancel(0, 0, 40, seq_a).expect("A cancels");

    // USDC escrow now only holds the mint_pair_total.
    assert_eq!(env.usdc_escrow_amount(), mint_pair_total);
    // Yes escrow still has C's ask.
    assert_eq!(env.yes_escrow_amount(), 100);

    // C cancels their ask too.
    let seq_c = env.book().asks.as_slice()[0].key.seq();
    env.cancel(2, 1, 60, seq_c).expect("C cancels");

    assert_eq!(env.yes_escrow_amount(), 0);
    assert_eq!(env.usdc_escrow_amount(), mint_pair_total);

    // Yes/No supply invariant (from U4) still holds.
    let yes_mint_state = read_mint(&env.fx.svm, &env.yes_mint);
    let no_mint_state = read_mint(&env.fx.svm, &env.no_mint);
    assert_eq!(yes_mint_state.supply, no_mint_state.supply);
    assert_eq!(yes_mint_state.supply, mint_pair_total);
}
