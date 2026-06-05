//! U6 LiteSVM test: `buy_no` and `sell_no` end-to-end.
//!
//! These two instructions compose `mint_pair`/`burn_pair` (U4) with the
//! market-order kernel of `place_order_inner` (U5) into single-tx,
//! single-signature atomic trade paths. The interesting invariants:
//!
//!   * **Atomic full-fill** — both instructions assert
//!     `OrderOutcome.residual_qty == 0` after the market leg and let
//!     Anchor's per-instruction revert undo the mint_pair / USDC-lock side
//!     effects if any portion couldn't fill at acceptable prices.
//!   * **Single signature** — only the user signs; no admin / maker
//!     signatures involved (maker side already executed when they placed
//!     their resting order).
//!   * **$1 invariant preserved** — `yes_mint.supply == no_mint.supply`
//!     before and after every U6 call (the only mints are mint_pair which
//!     adds both, and the burn_pair inside sell_no which removes both).
//!
//! Slippage convention (matches U5 `place_market_order_handler`):
//!
//!   * `buy_no`'s `min_yes_sell_price` → engine `slippage_bound` for an
//!     **Ask taker** = minimum price the seller will accept (engine uses
//!     `>=`). Pass `1` for "no floor" (`0` is rejected — collides with
//!     the OrderKey invalid sentinel).
//!   * `sell_no`'s `max_yes_buy_price` → engine `slippage_bound` for a
//!     **Bid taker** = maximum price the buyer will pay (engine uses
//!     `<=`). Pass `u64::MAX` for "no ceiling" — but be aware the
//!     up-front USDC lock is `amount * max_yes_buy_price`, so very large
//!     values overflow `u64` and the kernel rejects them.
//!
//! Pricing convention matches u5_orders: `price` is microunits USDC per
//! Yes-base-unit. The "$0.40" in the plan text is `price = 40` here for
//! the small-toy-units used in tests; the real demo uses 6-decimal USDC
//! microunits.
//!
//! For "Buy No": the user is **selling** their newly-minted Yes leg, so
//! the maker on the other side is a **resting bid** (buying Yes). For
//! "Sell No": the user is **buying** Yes to pair against their existing
//! No, so the maker is a **resting ask** (selling Yes). The plan's text
//! "book has 50 Yes at $0.40 ask" is shorthand for "the price level is
//! $0.40"; the actual maker side depends on which direction the user is
//! trading.

#![allow(clippy::too_many_arguments)]

use anchor_lang::{AccountSerialize, AnchorSerialize};
use litesvm::LiteSVM;
use meridian_litesvm_tests::{
    anchor_ix, create_canonical_ata, load_anchor_account, load_zero_copy_account, read_mint,
    read_token_account, Fixture, MERIDIAN_PROGRAM_ID, RENT_SYSVAR_ID, SYSTEM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
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

        // create_strike_market
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

        // create users
        let mut users = Vec::with_capacity(n_users);
        for _ in 0..n_users {
            let kp = Keypair::new();
            airdrop_sol(&mut fx.svm, &kp.pubkey(), 10_000_000_000);
            // Post-U5 ABI: maker payouts bind to the maker's canonical ATA.
            let usdc = create_canonical_ata(&mut fx.svm, &kp.pubkey(), &fx.usdc_mint.pubkey());
            let yes = create_canonical_ata(&mut fx.svm, &kp.pubkey(), &yes_mint);
            let no = create_canonical_ata(&mut fx.svm, &kp.pubkey(), &no_mint);
            if usdc_each > 0 {
                // 1 token base unit = $1.00 collateral, so mint_pair/burn_pair
                // move `n * ONE_USDC` µUSDC. Fund each user in whole-USDC ×
                // ONE_USDC; order-book locks (qty*price µUSDC) stay raw.
                mint_usdc(
                    &mut fx.svm,
                    &fx.admin.insecure_clone(),
                    &fx.usdc_mint.pubkey(),
                    &usdc,
                    usdc_each * meridian::ONE_USDC,
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
            users,
        }
    }

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

    /// Common account metas for buy_no / sell_no — same shape both ways
    /// because both share the union of mint_pair + place_market_order
    /// accounts. `maker_pairs` is the per-fill `(usdc, yes)` ATA list the
    /// place_order_inner kernel needs in fill order.
    fn trade_metas(
        &self,
        i: usize,
        taker_side: u8,
        maker_pairs: &[(Address, Address)],
    ) -> Vec<AccountMeta> {
        let mut v = vec![
            AccountMeta::new(self.users[i].kp.pubkey(), true),
            AccountMeta::new_readonly(self.config_pda, false),
            AccountMeta::new_readonly(self.market_pda, false),
            AccountMeta::new(self.book_pda, false),
            AccountMeta::new(self.usdc_escrow, false),
            AccountMeta::new(self.yes_escrow, false),
            AccountMeta::new(self.yes_mint, false),
            AccountMeta::new(self.no_mint, false),
            AccountMeta::new(self.users[i].usdc, false),
            AccountMeta::new(self.users[i].yes, false),
            AccountMeta::new(self.users[i].no, false),
            AccountMeta::new_readonly(self.mint_authority, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];
        // Post-U5 ABI: ONE canonical maker payout per fill, payout mint fixed
        // by the inner taker side. buy_no runs an Ask leg (taker pays makers
        // Yes); sell_no runs a Bid leg (taker pays makers USDC).
        for (usdc, yes) in maker_pairs {
            let payout = if taker_side == 0 { *usdc } else { *yes };
            v.push(AccountMeta::new(payout, false));
        }
        v
    }

    fn buy_no(
        &mut self,
        i: usize,
        amount: u64,
        min_yes_sell_price: u64,
        maker_pairs: &[(Address, Address)],
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let args = meridian::BuyNoArgs {
            amount,
            min_yes_sell_price,
        };
        let mut data = Vec::new();
        args.serialize(&mut data).unwrap();
        // buy_no's inner leg is an Ask taker (side=1) → makers paid Yes.
        let metas = self.trade_metas(i, /* taker_side=Ask */ 1, maker_pairs);
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "buy_no", &data, metas);
        let kp = self.users[i].kp.insecure_clone();
        try_submit(&mut self.fx.svm, ix, &[&kp])
    }

    /// `buy_no_limit` — same shape and Ask-taker leg as `buy_no`, but the Yes
    /// leg is a *limit* order: the unfilled remainder rests instead of
    /// reverting. `min_yes_sell_price` doubles as the resting ask price.
    fn buy_no_limit(
        &mut self,
        i: usize,
        amount: u64,
        min_yes_sell_price: u64,
        maker_pairs: &[(Address, Address)],
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let args = meridian::BuyNoArgs {
            amount,
            min_yes_sell_price,
        };
        let mut data = Vec::new();
        args.serialize(&mut data).unwrap();
        let metas = self.trade_metas(i, /* taker_side=Ask */ 1, maker_pairs);
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "buy_no_limit", &data, metas);
        let kp = self.users[i].kp.insecure_clone();
        try_submit(&mut self.fx.svm, ix, &[&kp])
    }

    fn sell_no(
        &mut self,
        i: usize,
        amount: u64,
        max_yes_buy_price: u64,
        maker_pairs: &[(Address, Address)],
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let args = meridian::SellNoArgs {
            amount,
            max_yes_buy_price,
        };
        let mut data = Vec::new();
        args.serialize(&mut data).unwrap();
        // sell_no's inner leg is a Bid taker (side=0) → makers paid USDC.
        let metas = self.trade_metas(i, /* taker_side=Bid */ 0, maker_pairs);
        let ix = anchor_ix(MERIDIAN_PROGRAM_ID, "sell_no", &data, metas);
        let kp = self.users[i].kp.insecure_clone();
        try_submit(&mut self.fx.svm, ix, &[&kp])
    }

    /// place_limit_order metas — used to set up maker bids/asks for the
    /// U6 happy-path tests.
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

    fn place_metas(&self, i: usize, taker_side: u8, maker_pairs: &[(Address, Address)]) -> Vec<AccountMeta> {
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
        // ONE canonical maker payout per fill: USDC for a Bid taker, Yes for an
        // Ask taker.
        for (usdc, yes) in maker_pairs {
            let payout = if taker_side == 0 { *usdc } else { *yes };
            v.push(AccountMeta::new(payout, false));
        }
        v
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

    fn supplies(&self) -> (u64, u64) {
        let y = read_mint(&self.fx.svm, &self.yes_mint).supply;
        let n = read_mint(&self.fx.svm, &self.no_mint).supply;
        (y, n)
    }

    fn force_paused(&mut self) {
        let config: meridian::state::Config =
            load_anchor_account(&self.fx.svm, &self.config_pda);
        let updated = meridian::state::Config {
            paused: true,
            ..config
        };
        let mut buf = Vec::new();
        updated.try_serialize(&mut buf).expect("serialize Config");
        let mut account = self
            .fx
            .svm
            .get_account(&self.config_pda)
            .expect("config exists");
        account.data = buf;
        self.fx
            .svm
            .set_account(self.config_pda, account)
            .expect("set_account paused=true");
    }

    fn force_settled(&mut self) {
        let market: meridian::state::Market =
            load_anchor_account(&self.fx.svm, &self.market_pda);
        let updated = meridian::state::Market {
            settled: true,
            outcome: Some(meridian::state::Outcome::YesWins),
            ..market
        };
        let mut buf = Vec::new();
        updated.try_serialize(&mut buf).expect("serialize Market");
        let mut account = self
            .fx
            .svm
            .get_account(&self.market_pda)
            .expect("market exists");
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

/// One whole USDC in base units (µUSDC). mint_pair/burn_pair move `n * ONE`
/// µUSDC per token; order-book locks/fills move raw `qty * price` µUSDC.
const ONE: u64 = meridian::ONE_USDC;

// ============================================================
// Scenario tests
// ============================================================

#[test]
fn buy_no_happy_path_full_fill() {
    // AE3-style: user A calls buy_no(50, min_floor=1).
    // Maker B has posted a BID at price=40 for 50 Yes (the buy_no
    // user is the Ask taker, so the maker must be a resting bid).
    //
    // Pre-state (mint_pair moves n*ONE µUSDC; order-book qty*price µUSDC is
    // unchanged):
    //   A: 10_000*ONE µUSDC, 0 Yes, 0 No.
    //   B: 10_000*ONE µUSDC, 0 Yes, 0 No. Posts bid 50@40 → locks 2_000 µUSDC.
    //
    // After buy_no:
    //   A: mint_pair(50) → A pays 50*ONE µUSDC into escrow, mints 50 Yes + 50 No.
    //   A: market-sell 50 Yes at floor=1 → fills against B's bid at 40
    //        → A receives 50*40 = 2_000 µUSDC; B receives 50 Yes.
    //   A's final: 10_000*ONE - 50*ONE + 2_000 µUSDC, 0 Yes, 50 No.
    //   B's final: 10_000*ONE - 2_000 µUSDC (locked already), 50 Yes, 0 No.
    //
    // Escrows:
    //   usdc_escrow: 50*ONE (only A's mint_pair contribution; B's 2_000 was
    //     paid out to A).
    //   yes_escrow: 0 (A's 50 Yes was paid to B; the escrow was just a
    //     transit account).
    let mut env = Env::new(2, 10_000);

    // B posts maker bid.
    env.place_limit(1, /* Bid */ 0, 40, 50, &[])
        .expect("B bid posts");

    let (y_pre, n_pre) = env.supplies();
    assert_eq!(y_pre, n_pre, "supply invariant before");

    // A is the taker; the maker for A's market-sell is user 1 (B).
    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    let tx = env
        .buy_no(0, 50, /* min_yes_sell_price */ 1, &[maker_pair])
        .expect("buy_no should succeed");
    // Tx didn't need any other signers — the user is the only Signer in
    // the BuyNo accounts struct. (LiteSVM's TransactionMetadata is opaque
    // about signature count, but if `try_submit` accepted a single keypair
    // and it landed, the on-chain signer count == 1 by construction.)
    let _ = tx;

    let a = env.balances(0);
    let b = env.balances(1);
    assert_eq!(a.no, 50, "A holds 50 No");
    assert_eq!(a.yes, 0, "A's Yes leg fully sold");
    assert_eq!(
        a.usdc, 10_000 * ONE - 50 * ONE + 2_000,
        "A: 10_000*ONE - 50*ONE(mint_pair) + 2000(sale)"
    );
    assert_eq!(b.yes, 50, "B received 50 Yes from the match");
    assert_eq!(b.no, 0, "B never minted No");
    assert_eq!(b.usdc, 10_000 * ONE - 2_000, "B's 2_000 µUSDC was paid into the match");

    assert_eq!(env.usdc_escrow_amount(), 50 * ONE, "USDC escrow = A's mint_pair");
    assert_eq!(env.yes_escrow_amount(), 0, "Yes escrow drained to B");

    let book = env.book();
    assert_eq!(book.bids.len(), 0, "B's bid fully consumed");
    assert_eq!(book.asks.len(), 0);

    // Invariant: yes supply == no supply, change is symmetric.
    let (y_post, n_post) = env.supplies();
    assert_eq!(y_post, n_post, "supply invariant after");
    assert_eq!(y_post - y_pre, 50, "exactly 50 Yes minted (A's mint_pair)");
}

#[test]
fn buy_no_limit_rests_unfilled_residual() {
    // PRD §211: a LIMIT Buy No crosses what it can, then rests the rest instead
    // of reverting (the atomic `buy_no` would revert on this same book).
    //
    // Maker B bids 40 for only 20 Yes — not enough to fill A's 50. A calls
    // buy_no_limit(50, ask=40): 20 cross B's bid, the remaining 30 rest as A's
    // ask. A keeps all 50 No immediately.
    let mut env = Env::new(2, 10_000);
    env.place_limit(1, /* Bid */ 0, 40, 20, &[])
        .expect("maker B posts a 20-lot bid");

    let (y_pre, n_pre) = env.supplies();
    assert_eq!(y_pre, n_pre, "supply invariant before");

    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    env.buy_no_limit(0, 50, /* yes ask price */ 40, &[maker_pair])
        .expect("buy_no_limit succeeds: residual rests, no revert");

    let a = env.balances(0);
    let b = env.balances(1);
    assert_eq!(a.no, 50, "A holds all 50 No immediately");
    assert_eq!(a.yes, 0, "A's Yes is sold (20) or escrowed in the resting ask (30)");
    assert_eq!(a.usdc, 10_000 * ONE - 50 * ONE + 800, "A: 10_000*ONE - 50*ONE(mint) + 800(20 @ 40 sold)");
    assert_eq!(b.yes, 20, "B got 20 Yes from the crossed portion");
    assert_eq!(b.no, 0, "B never minted No");

    // A's mint USDC stays escrowed; the 30 unfilled Yes back the resting ask.
    assert_eq!(env.usdc_escrow_amount(), 50 * ONE, "A's mint_pair USDC remains escrowed");
    assert_eq!(env.yes_escrow_amount(), 30, "30 Yes escrowed behind A's resting ask");

    // Book: B's bid fully consumed; A now has a resting ask for 30 @ 40, owned by A.
    let book = env.book();
    assert_eq!(book.bids.len(), 0, "B's 20-lot bid fully consumed");
    assert_eq!(book.asks.len(), 1, "A's residual rests as exactly one ask");
    let ask = &book.asks.as_slice()[0];
    assert_eq!(ask.qty, 30, "30 Yes resting");
    assert_eq!(ask.key.price(), 40, "rests at A's chosen ask price");
    assert_eq!(
        ask.owner,
        env.users[0].kp.pubkey().to_bytes(),
        "resting ask is owned by A (cancellable / settles to A)"
    );

    let (y_post, n_post) = env.supplies();
    assert_eq!(y_post, n_post, "supply invariant after");
    assert_eq!(y_post - y_pre, 50, "exactly A's 50 pair minted");
}

#[test]
fn buy_no_limit_full_rest_when_no_crossing_bids() {
    // No resting bids at all: the atomic `buy_no` reverts here, but the LIMIT
    // variant rests A's whole Yes leg and leaves A holding 50 No.
    let mut env = Env::new(2, 10_000);
    let (y_pre, _n_pre) = env.supplies();

    env.buy_no_limit(0, 50, /* yes ask price */ 40, &[])
        .expect("buy_no_limit rests the whole order when nothing crosses");

    let a = env.balances(0);
    assert_eq!(a.no, 50, "A holds 50 No");
    assert_eq!(a.yes, 0, "A's 50 Yes are escrowed behind the resting ask");
    assert_eq!(a.usdc, 10_000 * ONE - 50 * ONE, "A: 10_000*ONE - 50*ONE(mint), nothing sold yet");
    assert_eq!(env.yes_escrow_amount(), 50, "all 50 Yes rest");
    assert_eq!(env.usdc_escrow_amount(), 50 * ONE, "A's mint_pair USDC escrowed");

    let book = env.book();
    assert_eq!(book.bids.len(), 0);
    assert_eq!(book.asks.len(), 1, "one resting ask");
    let ask = &book.asks.as_slice()[0];
    assert_eq!(ask.qty, 50, "all 50 rest");
    assert_eq!(ask.key.price(), 40);

    let (y_post, n_post) = env.supplies();
    assert_eq!(y_post, n_post, "supply invariant after");
    assert_eq!(y_post - y_pre, 50);
}

#[test]
fn sell_no_happy_path_full_fill() {
    // Sell No: A holds No tokens (from a previous Buy No or mint_pair),
    // wants to liquidate them for USDC without waiting for settlement.
    //
    // Setup (mint_pair/burn_pair move n*ONE µUSDC; order-book qty*price µUSDC
    // unchanged):
    //   A: 10_000*ONE µUSDC. seed_yes(A, 50) → A: 9_950*ONE µUSDC + 50 Yes + 50 No.
    //   B: 10_000*ONE µUSDC. seed_yes(B, 50) → B: 9_950*ONE µUSDC + 50 Yes + 50 No.
    //      B then posts ASK at price=40 qty=50 → 50 Yes locked in escrow.
    //      B's Yes drops to 0.
    //
    // A calls sell_no(50, max_yes_buy_price=40):
    //   Leg 1: market-buy 50 Yes at limit=40, lock 50*40=2_000 µUSDC up
    //     front. Fills against B's ask at price=40 (exactly at limit, no
    //     price-improvement refund). A gets 50 Yes from yes_escrow; B
    //     gets 2_000 µUSDC from usdc_escrow.
    //   Leg 2: burn_pair(50) — burn 50 Yes + 50 No from A; return 50*ONE µUSDC
    //     from escrow to A.
    //
    // Final state:
    //   A's USDC: 9_950*ONE - 2_000 (lock) + 50*ONE (burn_pair) = 10_000*ONE - 2_000.
    //   A's Yes: 50 - 50 (locked) + 50 (filled) - 50 (burned) = 50.
    //   A's No:  50 - 50 (burned) = 0.
    //   B's USDC: 9_950*ONE + 2_000.
    //   B's Yes: 0 (sold all to A).
    //   B's No:  50 (unchanged).
    //
    // Escrows post-trade:
    //   usdc_escrow: contributions from A's mint_pair (50*ONE) + B's mint_pair
    //     (50*ONE), MINUS the 50*ONE returned by A's burn_pair = 50*ONE.
    //   yes_escrow: B's locked 50 Yes were paid out to A; nothing left.
    let mut env = Env::new(2, 10_000);
    env.seed_yes(0, 50); // A gets 50 Yes + 50 No, USDC -> 9_950*ONE
    env.seed_yes(1, 50); // B gets 50 Yes + 50 No, USDC -> 9_950*ONE

    // B posts ask at price=40 for 50 Yes (locks B's 50 Yes in escrow).
    env.place_limit(1, /* Ask */ 1, 40, 50, &[])
        .expect("B ask posts");

    let (y_pre, n_pre) = env.supplies();
    assert_eq!(y_pre, n_pre, "supply invariant before");
    assert_eq!(y_pre, 100, "100 Yes total minted across A+B");

    // A is the sell_no caller; maker on the buy leg is B.
    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    env.sell_no(0, 50, /* max_yes_buy_price */ 40, &[maker_pair])
        .expect("sell_no should succeed");

    let a = env.balances(0);
    let b = env.balances(1);
    assert_eq!(a.no, 0, "A's No fully burned");
    assert_eq!(a.yes, 50, "A's Yes net 0: +50 from match - 50 from burn");
    assert_eq!(
        a.usdc, 10_000 * ONE - 2_000,
        "A: 9_950*ONE - 2_000(lock) + 50*ONE(burn_pair)"
    );
    assert_eq!(b.yes, 0, "B sold its locked Yes");
    assert_eq!(b.no, 50, "B's No untouched");
    assert_eq!(b.usdc, 9_950 * ONE + 2_000, "B: 9_950*ONE + 2_000 from sale");

    // Escrow: 100*ONE - 50*ONE = 50*ONE.
    assert_eq!(env.usdc_escrow_amount(), 50 * ONE);
    assert_eq!(env.yes_escrow_amount(), 0);

    let book = env.book();
    assert_eq!(book.asks.len(), 0, "B's ask fully consumed");

    // Supply invariant: each mint_pair added 50, sell_no's burn_pair
    // removed 50. Net: A's 50 + B's 50 - 50 burned = 50 each.
    let (y_post, n_post) = env.supplies();
    assert_eq!(y_post, n_post, "supply invariant after");
    assert_eq!(y_post, 50, "100 - 50 burned by sell_no");
}

#[test]
fn sell_no_holding_only_no_round_trip() {
    // REGRESSION (sell_no stale-balance bug): the realistic Sell No flow where
    // the caller holds ONLY No and ZERO Yes at entry — exactly what you get
    // after a Buy No. `sell_no` market-buys the Yes leg into `user_yes` via CPI,
    // then `burn_pair_inner` asserts `user_yes.amount >= amount`. Without a
    // post-buy `user_yes.reload()`, that check reads the STALE pre-buy balance
    // (0) and reverts with InvalidAmount. `sell_no_happy_path_full_fill` masked
    // this because its caller already held 50 Yes from `seed_yes`.
    //
    // Here A gets its No purely via buy_no (Yes leg fully sold → 0 Yes), then
    // sells that No back. Both legs must reconcile with no leftover position.
    let mut env = Env::new(2, 10_000);

    // B provides a two-sided book: a BID @40 (for A's buy_no Yes-sell) and an
    // ASK @60 (for A's sell_no Yes-buy).
    env.seed_yes(1, 100); // B: 100 Yes + 100 No, USDC 9_900*ONE
    env.place_limit(1, /* Ask */ 1, 60, 50, &[]).expect("B ask @60 posts");
    env.place_limit(1, /* Bid */ 0, 40, 50, &[]).expect("B bid @40 posts");

    let maker = (env.users[1].usdc, env.users[1].yes);

    // A Buys No: mint 50 pair, sell 50 Yes into B's bid @40 → A holds 50 No, 0 Yes.
    env.buy_no(0, 50, /* min_yes_sell_price */ 40, &[maker])
        .expect("buy_no should succeed");
    let a_mid = env.balances(0);
    assert_eq!(a_mid.no, 50, "A holds 50 No after buy_no");
    assert_eq!(a_mid.yes, 0, "A holds 0 Yes after buy_no (the realistic case)");

    // A Sells No: market-buy 50 Yes from B's ask @60, then burn the pair. This
    // is the path that reverted before the reload fix.
    env.sell_no(0, 50, /* max_yes_buy_price */ 60, &[maker])
        .expect("sell_no must succeed when caller holds only No (reload fix)");

    let a = env.balances(0);
    assert_eq!(a.no, 0, "A's No fully closed");
    assert_eq!(a.yes, 0, "A holds no leftover Yes");
    // Round-trip cost = the $0.20 spread on 50 contracts = 50*(60-40) = 1_000 µUSDC.
    //   start 10_000*ONE - 50*ONE(mint) + 2_000(sell Yes @40) - 3_000(buy Yes @60)
    //         + 50*ONE(burn) = 10_000*ONE - 1_000.
    assert_eq!(a.usdc, 10_000 * ONE - 1_000, "A net -1_000 µUSDC (the spread)");

    // Supply: B's 100 + A's buy_no 50 - A's sell_no 50 = 100.
    let (y_post, n_post) = env.supplies();
    assert_eq!(y_post, n_post, "supply invariant after");
    assert_eq!(y_post, 100, "B's 100 intact; A's mint/burn nets to 0");
}

#[test]
fn buy_no_insufficient_book_depth_reverts_atomically() {
    // Maker has only 30 Yes worth of bid; A tries buy_no(50). The market
    // sell hits 30, leaves residual_qty=20, the residual_qty != 0 check
    // fires → Anchor reverts the whole tx including the mint_pair leg.
    let mut env = Env::new(2, 10_000);
    env.place_limit(1, 0, 40, 30, &[]).expect("B small bid"); // 30 Yes @ 40

    let pre_a = env.balances(0);
    let pre_b = env.balances(1);
    let pre_escrow_usdc = env.usdc_escrow_amount();
    let pre_escrow_yes = env.yes_escrow_amount();
    let (pre_y, pre_n) = env.supplies();
    let pre_book = env.book();

    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    let err = env
        .buy_no(0, 50, 1, &[maker_pair])
        .expect_err("buy_no must revert when book too thin");
    let s = format!("{err:?}");
    assert!(
        s.contains("SlippageNotMet"),
        "expected SlippageNotMet (atomicity failure on residual_qty != 0), got {s}",
    );

    // Pre-state preserved (the key atomicity assertion).
    assert_eq!(env.balances(0), pre_a, "A's balances must be unchanged");
    assert_eq!(env.balances(1), pre_b, "B's balances must be unchanged");
    assert_eq!(env.usdc_escrow_amount(), pre_escrow_usdc);
    assert_eq!(env.yes_escrow_amount(), pre_escrow_yes);
    assert_eq!(env.supplies(), (pre_y, pre_n), "no Yes/No was minted");
    // Book unchanged.
    let post_book = env.book();
    assert_eq!(post_book.bids.len(), pre_book.bids.len());
    assert_eq!(post_book.bids.as_slice()[0].qty, 30, "B's bid untouched");
}

#[test]
fn buy_no_slippage_too_high_reverts_atomically() {
    // Book has a bid at price=30; A's min_yes_sell_price=50 → engine won't
    // cross (resting bid 30 < taker floor 50). residual_qty=50 (full
    // amount), atomicity check fires → revert.
    let mut env = Env::new(2, 10_000);
    env.place_limit(1, 0, 30, 50, &[]).expect("B bid at 30"); // bid @ 30

    let pre_a = env.balances(0);
    let pre_book = env.book();
    let (pre_y, pre_n) = env.supplies();

    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    let err = env
        .buy_no(0, 50, /* min_yes_sell_price */ 50, &[maker_pair])
        .expect_err("buy_no above slippage floor must revert");
    let s = format!("{err:?}");
    assert!(
        s.contains("SlippageNotMet"),
        "expected SlippageNotMet (no fills under slippage floor), got {s}",
    );

    // Atomicity: zero state change.
    assert_eq!(env.balances(0), pre_a);
    assert_eq!(env.supplies(), (pre_y, pre_n));
    let post_book = env.book();
    assert_eq!(post_book.bids.len(), pre_book.bids.len());
    assert_eq!(post_book.bids.as_slice()[0].qty, 50);
}

#[test]
fn sell_no_insufficient_no_balance_fails() {
    // A holds only 30 No (via mint_pair(30) → also 30 Yes); tries
    // sell_no(50). The Anchor constraint `user_no.amount >= args.amount`
    // on `SellNo.user_no` rejects this before the kernel runs.
    let mut env = Env::new(2, 10_000);
    env.seed_yes(0, 30); // A: 30 Yes + 30 No
    env.seed_yes(1, 50); // B: 50 Yes + 50 No
    env.place_limit(1, 1, 40, 50, &[]).expect("B ask posts");

    let pre_a = env.balances(0);
    let pre_escrow_usdc = env.usdc_escrow_amount();
    let pre_book = env.book();

    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    let err = env
        .sell_no(0, 50, 40, &[maker_pair])
        .expect_err("sell_no with insufficient No must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("InvalidAmount") || s.contains("custom"),
        "expected balance failure, got {s}",
    );

    // No state mutation.
    assert_eq!(env.balances(0), pre_a);
    assert_eq!(env.usdc_escrow_amount(), pre_escrow_usdc);
    let post_book = env.book();
    assert_eq!(post_book.asks.len(), pre_book.asks.len());
}

#[test]
fn sell_no_no_book_depth_reverts_atomically() {
    // Book has no asks; A tries sell_no(50). market-buy gets
    // residual_qty=50 (full amount, no fills), atomicity check fires →
    // revert.
    let mut env = Env::new(1, 10_000);
    env.seed_yes(0, 50); // A: 50 Yes + 50 No, 9_950 USDC

    let pre_a = env.balances(0);
    let pre_escrow_usdc = env.usdc_escrow_amount();
    let (pre_y, pre_n) = env.supplies();

    let err = env
        .sell_no(0, 50, 40, &[])
        .expect_err("sell_no with empty book must revert");
    let s = format!("{err:?}");
    assert!(
        s.contains("SlippageNotMet"),
        "expected SlippageNotMet (atomicity failure on residual_qty != 0), got {s}",
    );

    // No state change.
    assert_eq!(env.balances(0), pre_a);
    assert_eq!(env.usdc_escrow_amount(), pre_escrow_usdc);
    assert_eq!(env.supplies(), (pre_y, pre_n));
}

#[test]
fn buy_no_when_paused_rejected() {
    let mut env = Env::new(2, 10_000);
    env.place_limit(1, 0, 40, 50, &[]).expect("B bid posts");
    env.force_paused();

    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    let err = env
        .buy_no(0, 50, 1, &[maker_pair])
        .expect_err("paused config must reject buy_no");
    let s = format!("{err:?}");
    assert!(
        s.contains("ProgramPaused") || s.contains("custom"),
        "expected ProgramPaused, got {s}",
    );
}

#[test]
fn sell_no_when_paused_rejected() {
    let mut env = Env::new(2, 10_000);
    env.seed_yes(0, 50);
    env.seed_yes(1, 50);
    env.place_limit(1, 1, 40, 50, &[]).expect("B ask posts");
    env.force_paused();

    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    let err = env
        .sell_no(0, 50, 40, &[maker_pair])
        .expect_err("paused config must reject sell_no");
    let s = format!("{err:?}");
    assert!(
        s.contains("ProgramPaused") || s.contains("custom"),
        "expected ProgramPaused, got {s}",
    );
}

#[test]
fn buy_no_when_settled_rejected() {
    let mut env = Env::new(2, 10_000);
    env.place_limit(1, 0, 40, 50, &[]).expect("B bid posts");
    env.force_settled();

    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    let err = env
        .buy_no(0, 50, 1, &[maker_pair])
        .expect_err("settled market must reject buy_no");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketSettled") || s.contains("custom"),
        "expected MarketSettled, got {s}",
    );
}

#[test]
fn sell_no_when_settled_rejected() {
    let mut env = Env::new(2, 10_000);
    env.seed_yes(0, 50);
    env.seed_yes(1, 50);
    env.place_limit(1, 1, 40, 50, &[]).expect("B ask posts");
    env.force_settled();

    let maker_pair = (env.users[1].usdc, env.users[1].yes);
    let err = env
        .sell_no(0, 50, 40, &[maker_pair])
        .expect_err("settled market must reject sell_no");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketSettled") || s.contains("custom"),
        "expected MarketSettled, got {s}",
    );
}

#[test]
fn buy_no_zero_amount_rejected() {
    let mut env = Env::new(1, 10_000);
    let err = env
        .buy_no(0, 0, 1, &[])
        .expect_err("buy_no(0) must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("InvalidAmount") || s.contains("custom"),
        "expected InvalidAmount, got {s}",
    );
}

#[test]
fn sell_no_zero_amount_rejected() {
    let mut env = Env::new(1, 10_000);
    env.seed_yes(0, 10); // give A some No so the constraint doesn't trip
                        // first — we want the explicit `amount > 0` path.
    let err = env
        .sell_no(0, 0, 40, &[])
        .expect_err("sell_no(0) must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("InvalidAmount") || s.contains("custom"),
        "expected InvalidAmount, got {s}",
    );
}
