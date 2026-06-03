//! U8 LiteSVM end-to-end lifecycle tests + cross-cutting invariant helper
//! exercise.
//!
//! Most of the U8 plan's scenario list is already covered by the per-unit
//! test files shipped in U3-U7 (see this file's `audit` block below). The
//! gaps this file fills are:
//!
//!   1. `lifecycle_dual_user_full_cycle` — the plan's strongest scenario:
//!      create → mint_pair (both users) → user A places limit bid → user B
//!      fills via market sell → settle → both users redeem → final
//!      balances + $1 USDC invariant verified end-to-end. U7's
//!      `end_to_end_dollar_invariant` covered the single-redeemer case;
//!      this test exercises the dual-redeemer case where both Yes and No
//!      holders settle their positions.
//!
//!   2. `multi_market_isolation` — two strike markets created on the same
//!      Config; trade in one, settle one; the other remains active and
//!      can still match new orders. Catches cross-market state corruption.
//!
//!   3. `mint_trade_partial_cancel_burn_roundtrip` — cross-unit
//!      composition: mint_pair → place_limit (bid) → partial fill via
//!      counter-ask → cancel residual → burn_pair → assert net USDC
//!      delta and the U4 $1 invariant.
//!
//! Each test calls the new `meridian_litesvm_tests::assert_invariants`
//! helper at logical breakpoints to verify R14 (Yes supply == No supply)
//! and USDC conservation across the test's USDC-holding accounts.
//!
//! # Out-of-scope (deferred from U8)
//!
//! Same-slot intra-block race tests for cancel-vs-fill and
//! settle-vs-place. The U7 subagent's note (carried into the U8 brief)
//! is that LiteSVM doesn't expose true intra-slot ordering control; the
//! sequential-slot variants of both races are already covered by
//! `u5_orders::cancel_by_non_owner_rejected` (consistent state after a
//! rejected cancel) and `u7_settle_redeem::place_after_settle_rejected`
//! (place rejected after settle landed in a prior slot). The same-slot
//! race "isn't a real correctness gap" per the plan.

#![allow(clippy::too_many_arguments)]

use anchor_lang::AnchorSerialize;
use litesvm::LiteSVM;
use meridian_litesvm_tests::{
    anchor_ix, assert_invariants, create_canonical_ata, load_anchor_account, load_zero_copy_account,
    read_mint, read_token_account, set_clock_unix_ts, set_pyth_price, Fixture, MERIDIAN_PROGRAM_ID,
    RENT_SYSVAR_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_interface::instruction as token_instruction;

// ---------- helpers (mirror u5/u6/u7 conventions; intentionally
// duplicated rather than promoted into the lib so per-unit test files
// stay independent and editable) ----------

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

// ---------- constants ----------

const PYTH_EXPONENT: i32 = -8;
const STRIKE_PRICE: u64 = 680_000_000;
const EXPIRY_UNIX: i64 = 86_400;
const FEED_ID: [u8; 32] = [9u8; 32];

fn dollars_to_pyth(d: i64) -> i64 {
    d.saturating_mul(100_000_000)
}

// ---------- single-market environment ----------
//
// Mirrors u7's `Env` but exposes only what the U8 scenarios need. Two
// users, one market, full instruction surface.

struct MarketCtx {
    market_pda: Address,
    book_pda: Address,
    mint_authority: Address,
    yes_mint: Address,
    no_mint: Address,
    usdc_escrow: Address,
    yes_escrow: Address,
    pyth_account: Address,
}

struct UserAccounts {
    kp: Keypair,
    usdc: Address,
    yes: Address,
    no: Address,
}

struct Env {
    fx: Fixture,
    config_pda: Address,
    market: MarketCtx,
    users: Vec<UserAccounts>,
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
                AccountMeta::new_readonly(MERIDIAN_PROGRAM_ID, false), // program (C1)
                AccountMeta::new_readonly(meridian_litesvm_tests::meridian_program_data(), false), // program_data (C1)
            ],
        );
        fx.submit_admin_ix(init_ix);

        let market = create_market(
            &mut fx,
            config_pda,
            *b"META\0\0\0\0",
            STRIKE_PRICE,
            EXPIRY_UNIX,
            FEED_ID,
        );

        let mut users = Vec::with_capacity(n_users);
        for _ in 0..n_users {
            users.push(create_user(
                &mut fx,
                &market.yes_mint,
                &market.no_mint,
                usdc_each,
            ));
        }

        Self {
            fx,
            config_pda,
            market,
            users,
        }
    }

    fn mint_pair(&mut self, i: usize, amount: u64) {
        let user_pubkey = self.users[i].kp.pubkey();
        let metas = vec![
            AccountMeta::new(user_pubkey, true),
            AccountMeta::new_readonly(self.config_pda, false),
            AccountMeta::new_readonly(self.market.market_pda, false),
            AccountMeta::new(self.users[i].usdc, false),
            AccountMeta::new(self.market.usdc_escrow, false),
            AccountMeta::new(self.market.yes_mint, false),
            AccountMeta::new(self.market.no_mint, false),
            AccountMeta::new(self.users[i].yes, false),
            AccountMeta::new(self.users[i].no, false),
            AccountMeta::new_readonly(self.market.mint_authority, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "mint_pair", &amount.to_le_bytes(), metas);
        let kp = self.users[i].kp.insecure_clone();
        submit(&mut self.fx.svm, ix, &[&kp]);
    }

    fn burn_pair(&mut self, i: usize, amount: u64) {
        let user_pubkey = self.users[i].kp.pubkey();
        let metas = vec![
            AccountMeta::new(user_pubkey, true),
            AccountMeta::new_readonly(self.config_pda, false),
            AccountMeta::new_readonly(self.market.market_pda, false),
            AccountMeta::new(self.users[i].usdc, false),
            AccountMeta::new(self.market.usdc_escrow, false),
            AccountMeta::new(self.market.yes_mint, false),
            AccountMeta::new(self.market.no_mint, false),
            AccountMeta::new(self.users[i].yes, false),
            AccountMeta::new(self.users[i].no, false),
            AccountMeta::new_readonly(self.market.mint_authority, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "burn_pair", &amount.to_le_bytes(), metas);
        let kp = self.users[i].kp.insecure_clone();
        submit(&mut self.fx.svm, ix, &[&kp]);
    }

    fn place_metas(&self, i: usize, taker_side: u8, maker_pairs: &[(Address, Address)]) -> Vec<AccountMeta> {
        let mut v = vec![
            AccountMeta::new(self.users[i].kp.pubkey(), true),
            AccountMeta::new_readonly(self.config_pda, false),
            AccountMeta::new_readonly(self.market.market_pda, false),
            AccountMeta::new(self.market.book_pda, false),
            AccountMeta::new(self.market.usdc_escrow, false),
            AccountMeta::new(self.market.yes_escrow, false),
            AccountMeta::new_readonly(self.market.yes_mint, false),
            AccountMeta::new(self.users[i].usdc, false),
            AccountMeta::new(self.users[i].yes, false),
            AccountMeta::new_readonly(self.market.mint_authority, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];
        // Post-U5 ABI: one canonical maker payout per fill — USDC for a Bid
        // taker, Yes for an Ask taker.
        for (usdc, yes) in maker_pairs {
            let payout = if taker_side == 0 { *usdc } else { *yes };
            v.push(AccountMeta::new(payout, false));
        }
        v
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
        let metas = self.place_metas(i, side, maker_pairs);
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "place_limit_order", &data, metas);
        let kp = self.users[i].kp.insecure_clone();
        try_submit(&mut self.fx.svm, ix, &[&kp])
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
        let args = meridian::PlaceMarketOrderArgs {
            side,
            qty,
            slippage_bound,
        };
        let mut data = Vec::new();
        args.serialize(&mut data).unwrap();
        let metas = self.place_metas(i, side, maker_pairs);
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "place_market_order", &data, metas);
        let kp = self.users[i].kp.insecure_clone();
        try_submit(&mut self.fx.svm, ix, &[&kp])
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
            AccountMeta::new_readonly(self.market.market_pda, false),
            AccountMeta::new(self.market.book_pda, false),
            AccountMeta::new(self.market.usdc_escrow, false),
            AccountMeta::new(self.market.yes_escrow, false),
            AccountMeta::new_readonly(self.market.yes_mint, false),
            AccountMeta::new(self.users[i].usdc, false),
            AccountMeta::new(self.users[i].yes, false),
            AccountMeta::new_readonly(self.market.mint_authority, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "cancel_order", &data, metas);
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
            AccountMeta::new(self.market.market_pda, false),
            AccountMeta::new_readonly(self.market.pyth_account, false),
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
            AccountMeta::new(self.market.market_pda, false),
            AccountMeta::new(self.market.book_pda, false),
            AccountMeta::new(self.market.usdc_escrow, false),
            AccountMeta::new(self.market.yes_escrow, false),
            AccountMeta::new_readonly(self.market.yes_mint, false),
            AccountMeta::new_readonly(self.market.mint_authority, false),
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
            AccountMeta::new_readonly(self.market.market_pda, false),
            AccountMeta::new(winning_mint, false),
            AccountMeta::new(user_winning, false),
            AccountMeta::new(self.users[i].usdc, false),
            AccountMeta::new(self.market.usdc_escrow, false),
            AccountMeta::new_readonly(self.market.mint_authority, false),
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

    fn book(&self) -> meridian::state::Book {
        load_zero_copy_account::<meridian::state::Book>(&self.fx.svm, &self.market.book_pda)
    }

    fn plant_pyth(&mut self, price: i64, conf: u64, publish_time: i64) {
        set_pyth_price(
            &mut self.fx.svm,
            self.market.pyth_account,
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

    /// USDC-holders set for `assert_invariants` — every user's USDC ATA
    /// plus the single market's USDC escrow. Pass the result + the seeded
    /// total to the helper.
    fn usdc_holders(&self) -> Vec<Address> {
        let mut v: Vec<Address> = self.users.iter().map(|u| u.usdc).collect();
        v.push(self.market.usdc_escrow);
        v
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Balances {
    usdc: u64,
    yes: u64,
    no: u64,
}

fn create_market(
    fx: &mut Fixture,
    config_pda: Address,
    ticker: [u8; 8],
    strike_price: u64,
    expiry_unix: i64,
    feed_id: [u8; 32],
) -> MarketCtx {
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
        pyth_feed_id: feed_id,
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

    let pyth_account = Keypair::new().pubkey();
    MarketCtx {
        market_pda,
        book_pda,
        mint_authority,
        yes_mint,
        no_mint,
        usdc_escrow,
        yes_escrow,
        pyth_account,
    }
}

fn create_user(
    fx: &mut Fixture,
    yes_mint: &Address,
    no_mint: &Address,
    usdc_each: u64,
) -> UserAccounts {
    let kp = Keypair::new();
    airdrop_sol(&mut fx.svm, &kp.pubkey(), 10_000_000_000);
    // Post-U5 ABI: maker payouts + sweep recipients bind to the canonical ATA.
    let usdc = create_canonical_ata(&mut fx.svm, &kp.pubkey(), &fx.usdc_mint.pubkey());
    let yes = create_canonical_ata(&mut fx.svm, &kp.pubkey(), yes_mint);
    let no = create_canonical_ata(&mut fx.svm, &kp.pubkey(), no_mint);
    if usdc_each > 0 {
        mint_usdc(
            &mut fx.svm,
            &fx.admin.insecure_clone(),
            &fx.usdc_mint.pubkey(),
            &usdc,
            usdc_each,
        );
    }
    UserAccounts {
        kp,
        usdc,
        yes,
        no,
    }
}

// ============================================================
// Scenario 1: full dual-user lifecycle + $1 USDC invariant.
// ============================================================

#[test]
fn lifecycle_dual_user_full_cycle() {
    // The plan's strongest single test: create → mint_pair (both users)
    // → user A places a limit bid → user B fills via market sell →
    // settle → BOTH users redeem (the dual-redeemer case) → final
    // balances + $1 USDC invariant verified end-to-end.
    //
    // Two users each start with 10_000 USDC; total seeded = 20_000.
    // The conservation invariant must hold across every transition.
    let mut env = Env::new(2, 10_000);
    let initial_total: u64 = 20_000;

    // ---- baseline invariants ----
    assert_invariants(
        &env.fx.svm,
        &env.usdc_holders(),
        initial_total,
        &env.market.yes_mint,
        &env.market.no_mint,
    );

    // ---- step 1: both users mint_pair ----
    // User A mints 100 pairs (-100 USDC, +100 Yes, +100 No).
    // User B mints 100 pairs (-100 USDC, +100 Yes, +100 No).
    env.mint_pair(0, 100);
    env.mint_pair(1, 100);

    let a = env.balances(0);
    let b = env.balances(1);
    assert_eq!(a, Balances { usdc: 9_900, yes: 100, no: 100 });
    assert_eq!(b, Balances { usdc: 9_900, yes: 100, no: 100 });

    // R14 holds + USDC conserved (200 USDC now in escrow).
    assert_invariants(
        &env.fx.svm,
        &env.usdc_holders(),
        initial_total,
        &env.market.yes_mint,
        &env.market.no_mint,
    );

    // ---- step 2: user A places a limit bid for 50 Yes @ price=40 ----
    // Locks 50 * 40 = 2_000 microunits USDC in escrow.
    env.place_limit(0, /* Bid */ 0, 40, 50, &[])
        .expect("A bid posts");

    let a = env.balances(0);
    assert_eq!(a.usdc, 7_900, "A's bid locks 2_000 USDC");

    // ---- step 3: user B fills via market sell of 50 Yes @ slippage=1 ----
    // Maker is A; A receives 50 Yes, B receives 50 * 40 = 2_000 USDC.
    let maker_pair = (env.users[0].usdc, env.users[0].yes);
    env.place_market(1, /* Ask */ 1, 50, 1, &[maker_pair])
        .expect("B market-sell fills A");

    let a = env.balances(0);
    let b = env.balances(1);
    // A: +50 Yes (now 150), USDC unchanged (escrow paid out).
    assert_eq!(a, Balances { usdc: 7_900, yes: 150, no: 100 });
    // B: -50 Yes (now 50), +2000 USDC (now 11_900).
    assert_eq!(b, Balances { usdc: 11_900, yes: 50, no: 100 });

    // Book is empty (bid fully consumed, ask not posted because market).
    let book = env.book();
    assert_eq!(book.bids.len(), 0);
    assert_eq!(book.asks.len(), 0);

    // Pre-settle USDC conservation.
    assert_invariants(
        &env.fx.svm,
        &env.usdc_holders(),
        initial_total,
        &env.market.yes_mint,
        &env.market.no_mint,
    );

    // ---- step 4: settle (YesWins: price=700 > strike=680) ----
    let ts = EXPIRY_UNIX + 10;
    env.advance_clock(ts);
    env.plant_pyth(dollars_to_pyth(700), 1_000, ts);
    env.settle().expect("settle ok");

    // No resting orders → sweep is a no-op (but still callable).
    env.sweep(8, &[]).expect("noop sweep ok");

    // ---- step 5: both users redeem ----
    // YesWins → only Yes tokens redeem for $1 each.
    // A holds 150 Yes → redeem 150 → +150 USDC.
    // B holds 50 Yes → redeem 50 → +50 USDC.
    // A's 100 No and B's 100 No are now worthless (NoWins lost).
    env.redeem(0, env.market.yes_mint, env.users[0].yes, 150)
        .expect("A redeems 150 Yes");
    env.redeem(1, env.market.yes_mint, env.users[1].yes, 50)
        .expect("B redeems 50 Yes");

    let a = env.balances(0);
    let b = env.balances(1);
    // A: USDC = 7_900 + 150 = 8_050. Yes = 0. No = 100 (worthless).
    assert_eq!(a, Balances { usdc: 8_050, yes: 0, no: 100 });
    // B: USDC = 11_900 + 50 = 11_950. Yes = 0. No = 100 (worthless).
    assert_eq!(b, Balances { usdc: 11_950, yes: 0, no: 100 });

    // Sum: 8_050 + 11_950 = 20_000. USDC conserved end-to-end.
    assert_eq!(a.usdc + b.usdc, initial_total);

    // ---- final invariant assertions ----
    //
    // R14: yes_supply still equals no_supply (each redeem burned only
    // the winning side, so supplies diverge — let's check).
    let yes_supply = read_mint(&env.fx.svm, &env.market.yes_mint).supply;
    let no_supply = read_mint(&env.fx.svm, &env.market.no_mint).supply;
    // We burned 200 Yes total (150+50) and 0 No. Yes supply = 0,
    // No supply = 200. R14 does NOT hold post-redeem on the winning
    // side — this is *expected*: the No tokens are by design left
    // outstanding (worthless) and the plan's R14 is a precondition
    // before settlement. We assert the explicit values instead.
    assert_eq!(yes_supply, 0, "all Yes redeemed");
    assert_eq!(no_supply, 200, "No tokens left worthless");

    // USDC conservation still holds — that's the load-bearing $1
    // invariant for end-to-end correctness.
    let mut total = 0u64;
    for u in &env.users {
        total += read_token_account(&env.fx.svm, &u.usdc).amount;
    }
    total += read_token_account(&env.fx.svm, &env.market.usdc_escrow).amount;
    assert_eq!(total, initial_total, "$1 USDC invariant holds end-to-end");

    // Escrow drained (all 200 USDC paid out: 100 from A's mint went to A
    // and B via the trade + redeem path; 100 from B's mint same).
    assert_eq!(
        read_token_account(&env.fx.svm, &env.market.usdc_escrow).amount,
        0,
    );
}

// ============================================================
// Scenario 2: multi-market isolation.
// ============================================================
//
// Two strike markets share the same Config. Settling one MUST NOT
// affect the other. Catches cross-market state corruption — the kind of
// bug the Trident fuzz harness in U9 is meant to find more
// systematically, but worth a targeted regression case at the LiteSVM
// level too.

#[test]
fn multi_market_isolation() {
    let mut fx = Fixture::new();
    let (config_pda, _) = fx.config_pda();

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
            AccountMeta::new_readonly(MERIDIAN_PROGRAM_ID, false), // program (C1)
            AccountMeta::new_readonly(meridian_litesvm_tests::meridian_program_data(), false), // program_data (C1)
        ],
    );
    fx.submit_admin_ix(init_ix);

    // Two markets on different tickers + feed ids so settle results are
    // independent.
    let market_a = create_market(
        &mut fx,
        config_pda,
        *b"META\0\0\0\0",
        STRIKE_PRICE,
        EXPIRY_UNIX,
        [1u8; 32],
    );
    // Market B expires much later than A so that at the clock we use to
    // settle A (EXPIRY_UNIX + 10) market B is still BEFORE its own expiry —
    // i.e. genuinely tradeable. (Trading halts at expiry now, so we can't
    // prove "B unaffected by A's settle" with a B that has also expired.)
    let market_b_expiry = EXPIRY_UNIX + 100_000;
    let market_b = create_market(
        &mut fx,
        config_pda,
        *b"AAPL\0\0\0\0",
        200_000_000,
        market_b_expiry,
        [2u8; 32],
    );

    // One user; we'll exercise both markets from the same wallet.
    let kp = Keypair::new();
    airdrop_sol(&mut fx.svm, &kp.pubkey(), 10_000_000_000);
    let user_usdc = create_canonical_ata(&mut fx.svm, &kp.pubkey(), &fx.usdc_mint.pubkey());
    let user_yes_a = create_canonical_ata(&mut fx.svm, &kp.pubkey(), &market_a.yes_mint);
    let user_no_a = create_canonical_ata(&mut fx.svm, &kp.pubkey(), &market_a.no_mint);
    let user_yes_b = create_canonical_ata(&mut fx.svm, &kp.pubkey(), &market_b.yes_mint);
    let user_no_b = create_canonical_ata(&mut fx.svm, &kp.pubkey(), &market_b.no_mint);
    mint_usdc(
        &mut fx.svm,
        &fx.admin.insecure_clone(),
        &fx.usdc_mint.pubkey(),
        &user_usdc,
        10_000,
    );

    let initial_total = 10_000u64;
    let usdc_holders = vec![user_usdc, market_a.usdc_escrow, market_b.usdc_escrow];

    // Mint 50 pairs on market A and 50 pairs on market B.
    submit(
        &mut fx.svm,
        anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "mint_pair",
            &50u64.to_le_bytes(),
            vec![
                AccountMeta::new(kp.pubkey(), true),
                AccountMeta::new_readonly(config_pda, false),
                AccountMeta::new_readonly(market_a.market_pda, false),
                AccountMeta::new(user_usdc, false),
                AccountMeta::new(market_a.usdc_escrow, false),
                AccountMeta::new(market_a.yes_mint, false),
                AccountMeta::new(market_a.no_mint, false),
                AccountMeta::new(user_yes_a, false),
                AccountMeta::new(user_no_a, false),
                AccountMeta::new_readonly(market_a.mint_authority, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            ],
        ),
        &[&kp],
    );
    submit(
        &mut fx.svm,
        anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "mint_pair",
            &50u64.to_le_bytes(),
            vec![
                AccountMeta::new(kp.pubkey(), true),
                AccountMeta::new_readonly(config_pda, false),
                AccountMeta::new_readonly(market_b.market_pda, false),
                AccountMeta::new(user_usdc, false),
                AccountMeta::new(market_b.usdc_escrow, false),
                AccountMeta::new(market_b.yes_mint, false),
                AccountMeta::new(market_b.no_mint, false),
                AccountMeta::new(user_yes_b, false),
                AccountMeta::new(user_no_b, false),
                AccountMeta::new_readonly(market_b.mint_authority, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            ],
        ),
        &[&kp],
    );

    // After the two mint_pairs, USDC conservation should hold across
    // both market escrows.
    assert_eq!(
        read_token_account(&fx.svm, &user_usdc).amount,
        9_900,
        "100 USDC locked across two escrows",
    );
    assert_eq!(read_token_account(&fx.svm, &market_a.usdc_escrow).amount, 50);
    assert_eq!(read_token_account(&fx.svm, &market_b.usdc_escrow).amount, 50);

    // Both markets' R14 holds.
    let supply_a_yes = read_mint(&fx.svm, &market_a.yes_mint).supply;
    let supply_a_no = read_mint(&fx.svm, &market_a.no_mint).supply;
    let supply_b_yes = read_mint(&fx.svm, &market_b.yes_mint).supply;
    let supply_b_no = read_mint(&fx.svm, &market_b.no_mint).supply;
    assert_eq!(supply_a_yes, supply_a_no);
    assert_eq!(supply_b_yes, supply_b_no);
    assert_eq!(supply_a_yes, 50);
    assert_eq!(supply_b_yes, 50);

    // Pre-settle invariant snapshot across both markets.
    assert_invariants(
        &fx.svm,
        &usdc_holders,
        initial_total,
        &market_a.yes_mint,
        &market_a.no_mint,
    );
    assert_invariants(
        &fx.svm,
        &usdc_holders,
        initial_total,
        &market_b.yes_mint,
        &market_b.no_mint,
    );

    // Settle market A only.
    let ts = EXPIRY_UNIX + 10;
    set_clock_unix_ts(&mut fx.svm, ts);
    set_pyth_price(
        &mut fx.svm,
        market_a.pyth_account,
        [1u8; 32],
        dollars_to_pyth(700),
        1_000,
        PYTH_EXPONENT,
        ts,
    );
    submit(
        &mut fx.svm,
        anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "settle_market",
            &[],
            vec![
                AccountMeta::new(kp.pubkey(), true),
                AccountMeta::new_readonly(config_pda, false),
                AccountMeta::new(market_a.market_pda, false),
                AccountMeta::new_readonly(market_a.pyth_account, false),
            ],
        ),
        &[&kp],
    );

    // Market A is settled.
    let mkt_a: meridian::state::Market = load_anchor_account(&fx.svm, &market_a.market_pda);
    assert!(mkt_a.settled);
    // Market B is still active.
    let mkt_b: meridian::state::Market = load_anchor_account(&fx.svm, &market_b.market_pda);
    assert!(!mkt_b.settled, "settling A must not touch B");

    // Market B is still active (unsettled AND before its later expiry), so it
    // must still accept new orders even though market A is settled. Place a
    // bid for 10 Yes @ price=30 on market B.
    let place_args = meridian::PlaceLimitOrderArgs {
        side: 0,
        price: 30,
        qty: 10,
    };
    let mut data = Vec::new();
    place_args.serialize(&mut data).unwrap();
    submit(
        &mut fx.svm,
        anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "place_limit_order",
            &data,
            vec![
                AccountMeta::new(kp.pubkey(), true),
                AccountMeta::new_readonly(config_pda, false),
                AccountMeta::new_readonly(market_b.market_pda, false),
                AccountMeta::new(market_b.book_pda, false),
                AccountMeta::new(market_b.usdc_escrow, false),
                AccountMeta::new(market_b.yes_escrow, false),
                AccountMeta::new_readonly(market_b.yes_mint, false),
                AccountMeta::new(user_usdc, false),
                AccountMeta::new(user_yes_b, false),
                AccountMeta::new_readonly(market_b.mint_authority, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            ],
        ),
        &[&kp],
    );

    let book_b =
        load_zero_copy_account::<meridian::state::Book>(&fx.svm, &market_b.book_pda);
    assert_eq!(book_b.bids.len(), 1, "market B accepts new orders");

    // Market A trying to accept a new order MUST fail (settled).
    let res_a = try_submit(
        &mut fx.svm,
        anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "place_limit_order",
            &data,
            vec![
                AccountMeta::new(kp.pubkey(), true),
                AccountMeta::new_readonly(config_pda, false),
                AccountMeta::new_readonly(market_a.market_pda, false),
                AccountMeta::new(market_a.book_pda, false),
                AccountMeta::new(market_a.usdc_escrow, false),
                AccountMeta::new(market_a.yes_escrow, false),
                AccountMeta::new_readonly(market_a.yes_mint, false),
                AccountMeta::new(user_usdc, false),
                AccountMeta::new(user_yes_a, false),
                AccountMeta::new_readonly(market_a.mint_authority, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            ],
        ),
        &[&kp],
    );
    let err = res_a.expect_err("market A is settled — place must reject");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketSettled") || s.contains("custom"),
        "expected MarketSettled, got {s}",
    );

    // Conservation invariant still holds across both markets.
    assert_invariants(
        &fx.svm,
        &usdc_holders,
        initial_total,
        &market_a.yes_mint,
        &market_a.no_mint,
    );
    assert_invariants(
        &fx.svm,
        &usdc_holders,
        initial_total,
        &market_b.yes_mint,
        &market_b.no_mint,
    );
}

// ============================================================
// Scenario 3: mint → trade → cancel → burn round-trip.
// ============================================================
//
// Cross-unit composition: mint_pair → place_limit (bid) → partial fill
// against a counter-ask → cancel residual → burn_pair the remaining
// matched pairs → assert USDC delta and R14 + conservation invariants
// at each step. Mirrors the user-facing "buy some, change my mind"
// flow without using buy_no/sell_no (those are exercised by u6).

#[test]
fn mint_trade_partial_cancel_burn_roundtrip() {
    let mut env = Env::new(2, 10_000);
    let initial_total = 20_000u64;

    // User A is the trader; user B is the maker on the ask side.

    // Maker mints 50 pairs, posts an ask of 30 @ price=40.
    env.mint_pair(1, 50);
    env.place_limit(1, /* Ask */ 1, 40, 30, &[])
        .expect("B ask posts");

    // Snapshot before trader acts.
    assert_invariants(
        &env.fx.svm,
        &env.usdc_holders(),
        initial_total,
        &env.market.yes_mint,
        &env.market.no_mint,
    );

    // Trader places a limit bid that crosses partially: bid 50 @ price=40.
    // Available ask qty is 30 → 30 fills, 20 rests on the bid side.
    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    env.place_limit(0, /* Bid */ 0, 40, 50, &[maker_pair])
        .expect("A bid partial-fills + posts residual");

    let book = env.book();
    assert_eq!(book.bids.len(), 1, "20-qty bid residual rests");
    assert_eq!(book.asks.len(), 0, "ask fully consumed");
    let residual_seq = book.bids.as_slice()[0].key.seq();
    let residual_qty = book.bids.as_slice()[0].qty;
    assert_eq!(residual_qty, 20);

    let a = env.balances(0);
    let b = env.balances(1);
    // A: locked 50*40=2_000 USDC, received 30 Yes (filled), 20*40=800
    // USDC still locked on residual bid. So:
    //   USDC: 10_000 - 2_000 + (refund? bid filled at maker price 40, no
    //   price improvement since same price) = 8_000. Wait: A locked at
    //   own bid price 40; maker filled at 40; no refund. End USDC: 8_000.
    //   Yes: +30. No: 0.
    assert_eq!(a, Balances { usdc: 8_000, yes: 30, no: 0 });
    // B: had 50 Yes after mint, sold 30 → 20 Yes left. USDC: started
    // 10_000, mint_pair cost 50 → 9_950, sold 30@40 → +1_200 → 11_150.
    // No: 50 (untouched).
    assert_eq!(b, Balances { usdc: 11_150, yes: 20, no: 50 });

    // Cancel the 20-qty residual. Should refund 20*40=800 USDC to A.
    env.cancel(0, /* Bid */ 0, 40, residual_seq)
        .expect("A cancels residual");

    let a = env.balances(0);
    assert_eq!(a, Balances { usdc: 8_800, yes: 30, no: 0 });

    // The book is now empty.
    let book = env.book();
    assert_eq!(book.bids.len(), 0);
    assert_eq!(book.asks.len(), 0);

    // For burn_pair we need matching Yes + No. A has 30 Yes, 0 No, so
    // can't burn directly. The trader mints 30 *more* pairs so they can
    // burn the matched 30 Yes + 30 No they bought + minted.
    //
    // Actually simpler: trader minted 0 pairs in this test. To round-trip
    // through burn_pair, trader mints 30 pairs (so they have 60 Yes + 30
    // No) then burns 30 pairs to release 30 USDC. The net flow exercises
    // mint→trade→cancel→burn correctly.
    env.mint_pair(0, 30);
    let a = env.balances(0);
    assert_eq!(a, Balances { usdc: 8_770, yes: 60, no: 30 });

    env.burn_pair(0, 30);
    let a = env.balances(0);
    // -30 Yes -30 No +30 USDC.
    assert_eq!(a, Balances { usdc: 8_800, yes: 30, no: 0 });

    // ---- Final invariants ----
    //
    // R14: Yes/No supplies match. Both A and B minted; only A burned.
    //   Total mint_pair: 50 (B) + 30 (A) = 80. Burned: 30 (A). Net 50.
    //   Yes/No supplies should both be 50.
    let yes_supply = read_mint(&env.fx.svm, &env.market.yes_mint).supply;
    let no_supply = read_mint(&env.fx.svm, &env.market.no_mint).supply;
    assert_eq!(yes_supply, no_supply, "R14: Yes supply == No supply");
    assert_eq!(yes_supply, 50);

    // USDC conservation: A 8_800 + B 11_150 + escrow = 20_000.
    //   Escrow holds the 50 USDC backing the still-outstanding 50
    //   Yes+No pairs (30 with A, 20 with B Yes; 30 burned by A; 50 No
    //   with B; the trade only moved tokens, not USDC out of the system).
    assert_eq!(
        read_token_account(&env.fx.svm, &env.market.usdc_escrow).amount,
        50,
        "escrow backs the 50 outstanding pairs",
    );
    assert_invariants(
        &env.fx.svm,
        &env.usdc_holders(),
        initial_total,
        &env.market.yes_mint,
        &env.market.no_mint,
    );
}

#[test]
fn cancel_allowed_between_expiry_and_settle() {
    // cancel_order intentionally stays OPEN between expiry and settlement so a
    // maker can pull resting collateral while price-discovery trading is
    // halted. This invariant lives only in code comments (place_order_inner
    // halts at expiry; cancel/mint/burn do not) — assert it so a stray
    // MarketExpired guard on cancel would be caught.
    let mut env = Env::new(1, 10_000);
    let pre_usdc = env.balances(0).usdc;
    env.place_limit(0, /* Bid */ 0, 40, 50, &[])
        .expect("bid posts");
    assert_eq!(
        env.balances(0).usdc,
        pre_usdc - 2_000,
        "40 * 50 = 2_000 USDC locked"
    );
    let seq = env.book().bids.as_slice()[0].key.seq();

    env.advance_clock(EXPIRY_UNIX + 10); // expired, NOT settled

    // Price-discovery trading is halted...
    env.place_limit(0, 0, 30, 10, &[])
        .expect_err("place is halted after expiry");
    // ...but cancel still works and refunds the full escrow.
    env.cancel(0, 0, 40, seq)
        .expect("cancel stays open between expiry and settle");
    assert_eq!(env.book().bids.len(), 0, "order cancelled");
    assert_eq!(
        env.balances(0).usdc,
        pre_usdc,
        "escrowed USDC fully refunded on cancel"
    );
}

// Keep an `_unused` reference to the helper that's only used in some
// scenarios so unused-import lints stay quiet when scenarios are
// re-edited.
#[allow(dead_code)]
fn _keep_helpers_live() {
    let _ = airdrop_sol;
    let _ = mint_usdc;
    let _ = create_token_account;
    let _ = create_user;
}
