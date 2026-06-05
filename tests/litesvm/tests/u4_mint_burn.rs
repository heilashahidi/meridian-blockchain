//! U4 LiteSVM test: `mint_pair` and `burn_pair` end-to-end against a real
//! Anchor + SPL Token program inside LiteSVM.
//!
//! Plan §U4 verification:
//!
//!   * **Happy mint_pair(50):** user with 100 USDC ends with 50 Y + 50 N +
//!     50 USDC; escrow holds 50 USDC; both mint supplies are 50.
//!   * **Happy burn_pair(30) after the above:** user ends with 20 Y +
//!     20 N + 80 USDC; escrow holds 20 USDC; both mint supplies are 20.
//!   * **`mint_pair(0)` → `InvalidAmount`.**
//!   * **`mint_pair` with insufficient USDC → token-program error.**
//!   * **`burn_pair` with insufficient Yes → clean error.**
//!   * **`burn_pair` with insufficient No → clean error.**
//!   * **Either instruction with `config.paused = true` → `ProgramPaused`.**
//!     There is no `pause` instruction in U3 / U4 (the plan punts it to
//!     U7's settlement family), so this test mutates the on-chain `Config`
//!     account directly via `LiteSVM::set_account`. The `Config` struct is
//!     `[u8: discriminator(8)][u8: bump][u8: paused]...` — byte 9 carries
//!     the bool. Documented inline so a future `pause` instruction can
//!     replace this workaround without changing the assertion shape.
//!   * **$1.00 invariant:** at every assertion point,
//!     `yes_mint.supply == no_mint.supply` and the escrow holds exactly
//!     `supply * ONE_USDC` µUSDC ($1.00 collateral per token). The happy-path
//!     dollar figures above (50 USDC, etc.) are the whole-USDC view of that
//!     raw µUSDC escrow.
//!
//! The test reuses the `Fixture` from `meridian_litesvm_tests` and wires
//! in a couple of local helpers for user-wallet creation / token-account
//! creation / USDC airdropping. Those helpers stay local so U4 doesn't
//! leak into the shared fixture API before U5 needs them.

use anchor_lang::{AccountSerialize, AnchorSerialize};
use litesvm::LiteSVM;
use meridian_litesvm_tests::{
    anchor_ix, load_anchor_account, read_mint, read_token_account, Fixture,
    MERIDIAN_PROGRAM_ID, RENT_SYSVAR_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use solana_account::Account as SolanaAccount;
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_interface::{instruction as token_instruction, state::Account as TokenAccountState};

// ---------- helpers (local to this test) ----------

fn airdrop_sol(svm: &mut LiteSVM, who: &Address, lamports: u64) {
    svm.airdrop(who, lamports).expect("airdrop SOL");
}

/// Create a non-PDA SPL Token account owned by `owner`, for `mint`.
/// Returns the account keypair so the caller can later look up its address.
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

/// Mint `amount` USDC from the fixture's USDC mint to a token account.
fn mint_usdc(svm: &mut LiteSVM, mint_authority: &Keypair, mint: &Address, dest: &Address, amount: u64) {
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

/// Submit an instruction signed by an arbitrary keypair (used for the user,
/// not the fixture's admin). Mirrors `Fixture::submit_ix_with_signers` but
/// surfaces the inner `Result` so we can assert on failures.
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

/// Build the standard `MintPair` / `BurnPair` account-meta list. Both
/// instructions take the same accounts (Anchor `#[derive(Accounts)]`
/// generates the same `try_accounts` shape modulo the `#[instruction(...)]`
/// hook on `burn_pair`).
#[allow(clippy::too_many_arguments)]
fn pair_account_metas(
    user: &Address,
    config: &Address,
    market: &Address,
    user_usdc: &Address,
    usdc_escrow: &Address,
    yes_mint: &Address,
    no_mint: &Address,
    user_yes: &Address,
    user_no: &Address,
    mint_authority: &Address,
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*user, true),
        AccountMeta::new_readonly(*config, false),
        AccountMeta::new_readonly(*market, false),
        AccountMeta::new(*user_usdc, false),
        AccountMeta::new(*usdc_escrow, false),
        AccountMeta::new(*yes_mint, false),
        AccountMeta::new(*no_mint, false),
        AccountMeta::new(*user_yes, false),
        AccountMeta::new(*user_no, false),
        AccountMeta::new_readonly(*mint_authority, false),
        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
    ]
}

/// One-shot environment for the U4 tests. Owns the SVM + a single market +
/// a single user with pre-created Yes / No / USDC token accounts. Built
/// once per test so failure-mode assertions can reuse the same setup.
struct Env {
    fx: Fixture,
    user: Keypair,
    config_pda: Address,
    market_pda: Address,
    mint_authority: Address,
    yes_mint: Address,
    no_mint: Address,
    usdc_escrow: Address,
    user_usdc: Address,
    user_yes: Address,
    user_no: Address,
}

impl Env {
    /// Build the environment and seed the user with `usdc_initial` USDC.
    fn new(usdc_initial: u64) -> Self {
        let mut fx = Fixture::new();
        let (config_pda, _) = fx.config_pda();

        // ----- initialize_config -----
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

        // ----- create user + user's token accounts -----
        let user = Keypair::new();
        airdrop_sol(&mut fx.svm, &user.pubkey(), 10_000_000_000);

        let user_usdc_kp =
            create_token_account(&mut fx.svm, &user, &user.pubkey(), &fx.usdc_mint.pubkey());
        let user_yes_kp = create_token_account(&mut fx.svm, &user, &user.pubkey(), &yes_mint);
        let user_no_kp = create_token_account(&mut fx.svm, &user, &user.pubkey(), &no_mint);

        // Mint `usdc_initial` *whole USDC* to the user (× ONE_USDC µUSDC). The
        // dollar-denominated `usdc_initial` keeps the per-test funding readable;
        // mint_pair/burn_pair move ONE_USDC µUSDC per token, so a user funded
        // with N dollars can mint exactly N tokens.
        if usdc_initial > 0 {
            mint_usdc(
                &mut fx.svm,
                &fx.admin.insecure_clone(),
                &fx.usdc_mint.pubkey(),
                &user_usdc_kp.pubkey(),
                usdc_initial * meridian::ONE_USDC,
            );
        }

        Self {
            fx,
            user,
            config_pda,
            market_pda,
            mint_authority,
            yes_mint,
            no_mint,
            usdc_escrow,
            user_usdc: user_usdc_kp.pubkey(),
            user_yes: user_yes_kp.pubkey(),
            user_no: user_no_kp.pubkey(),
        }
    }

    fn mint_pair_ix(&self, amount: u64) -> Instruction {
        let metas = pair_account_metas(
            &self.user.pubkey(),
            &self.config_pda,
            &self.market_pda,
            &self.user_usdc,
            &self.usdc_escrow,
            &self.yes_mint,
            &self.no_mint,
            &self.user_yes,
            &self.user_no,
            &self.mint_authority,
        );
        anchor_ix(MERIDIAN_PROGRAM_ID, "mint_pair", &amount.to_le_bytes(), metas)
    }

    fn burn_pair_ix(&self, amount: u64) -> Instruction {
        let metas = pair_account_metas(
            &self.user.pubkey(),
            &self.config_pda,
            &self.market_pda,
            &self.user_usdc,
            &self.usdc_escrow,
            &self.yes_mint,
            &self.no_mint,
            &self.user_yes,
            &self.user_no,
            &self.mint_authority,
        );
        anchor_ix(MERIDIAN_PROGRAM_ID, "burn_pair", &amount.to_le_bytes(), metas)
    }

    /// Build a `set_paused(paused)` ix signed by `signer` (admin or not).
    fn set_paused_ix(&self, signer: &Keypair, paused: bool) -> Instruction {
        anchor_ix(
            MERIDIAN_PROGRAM_ID,
            "set_paused",
            &[paused as u8],
            vec![
                AccountMeta::new_readonly(signer.pubkey(), true),
                AccountMeta::new(self.config_pda, false),
            ],
        )
    }

    fn paused(&self) -> bool {
        let config: meridian::state::Config =
            load_anchor_account(&self.fx.svm, &self.config_pda);
        config.paused
    }

    /// Verify the $1.00 invariant: yes_supply == no_supply, and the escrow
    /// holds exactly `supply * ONE_USDC` µUSDC ($1.00 of collateral per token).
    /// Checked on the RAW on-chain amounts (no dollar rescaling) so this is a
    /// faithful test of the deployed vault invariant.
    fn assert_invariant(&self) {
        let yes = read_mint(&self.fx.svm, &self.yes_mint);
        let no = read_mint(&self.fx.svm, &self.no_mint);
        let esc = read_token_account(&self.fx.svm, &self.usdc_escrow);
        assert_eq!(
            yes.supply, no.supply,
            "yes_mint.supply ({}) != no_mint.supply ({})",
            yes.supply, no.supply,
        );
        let expected_escrow = (yes.supply as u128) * (meridian::ONE_USDC as u128);
        assert_eq!(
            expected_escrow,
            esc.amount as u128,
            "yes_mint.supply * ONE_USDC ({}) != usdc_escrow.amount ({})",
            expected_escrow,
            esc.amount,
        );
    }

    /// Snapshot of the user's three token balances + escrow + supplies.
    ///
    /// `usdc` and `escrow` are reported in **whole USDC** (raw µUSDC ÷
    /// `ONE_USDC`). Every USDC movement in this file is a mint/burn of a token
    /// pair, which moves exactly `ONE_USDC` µUSDC per token, so the division is
    /// always exact and the assertions below read in dollars. Token balances
    /// (`yes`/`no`) and supplies stay in raw base units (= share count, since
    /// the system trades 1 base unit = 1 share).
    fn balances(&self) -> Balances {
        let usdc = read_token_account(&self.fx.svm, &self.user_usdc).amount / meridian::ONE_USDC;
        let yes = read_token_account(&self.fx.svm, &self.user_yes).amount;
        let no = read_token_account(&self.fx.svm, &self.user_no).amount;
        let escrow = read_token_account(&self.fx.svm, &self.usdc_escrow).amount / meridian::ONE_USDC;
        let yes_supply = read_mint(&self.fx.svm, &self.yes_mint).supply;
        let no_supply = read_mint(&self.fx.svm, &self.no_mint).supply;
        Balances {
            usdc,
            yes,
            no,
            escrow,
            yes_supply,
            no_supply,
        }
    }

    /// Force `config.paused = true` via raw account mutation (no on-chain
    /// pause instruction exists yet — see module docs).
    fn force_pause(&mut self) {
        let mut account = self
            .fx
            .svm
            .get_account(&self.config_pda)
            .expect("config account exists");
        // Re-serialize the Config struct with `paused = true` via Anchor's
        // `AccountSerialize` so the discriminator stays intact.
        let config: meridian::state::Config =
            load_anchor_account(&self.fx.svm, &self.config_pda);
        let updated = meridian::state::Config {
            paused: true,
            ..config
        };
        let mut buf: Vec<u8> = Vec::with_capacity(8 + std::mem::size_of_val(&updated));
        updated.try_serialize(&mut buf).expect("serialize Config");
        account.data = buf;
        self.fx
            .svm
            .set_account(self.config_pda, account)
            .expect("set_account paused=true");
    }

    /// Force `market.settled = true` via raw account mutation (settle_market
    /// needs a Pyth account; for the gate tests we just flip the flag).
    fn force_settled(&mut self) {
        let market: meridian::state::Market =
            load_anchor_account(&self.fx.svm, &self.market_pda);
        let updated = meridian::state::Market {
            settled: true,
            outcome: Some(meridian::state::Outcome::YesWins),
            ..market
        };
        let mut buf: Vec<u8> = Vec::new();
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

#[derive(Debug)]
struct Balances {
    usdc: u64,
    yes: u64,
    no: u64,
    escrow: u64,
    yes_supply: u64,
    no_supply: u64,
}

// ---------- happy paths ----------

#[test]
fn mint_pair_then_burn_pair_happy_path() {
    let mut env = Env::new(100);
    env.assert_invariant();

    // ----- mint_pair(50) -----
    // (Bind the instruction before the mutable-borrow on `env.fx.svm` to
    // satisfy the borrow checker — `env.mint_pair_ix(...)` takes `&self`
    // and would conflict with `&mut env.fx.svm` if inlined.)
    let ix = env.mint_pair_ix(50);
    let user = env.user.insecure_clone();
    submit(&mut env.fx.svm, ix, &[&user]);

    let b = env.balances();
    assert_eq!(b.usdc, 50, "user should have 50 USDC left after mint_pair(50)");
    assert_eq!(b.yes, 50, "user should hold 50 Yes");
    assert_eq!(b.no, 50, "user should hold 50 No");
    assert_eq!(b.escrow, 50, "USDC escrow should hold 50");
    assert_eq!(b.yes_supply, 50, "Yes supply should be 50");
    assert_eq!(b.no_supply, 50, "No supply should be 50");
    env.assert_invariant();

    // ----- burn_pair(30) -----
    let ix = env.burn_pair_ix(30);
    submit(&mut env.fx.svm, ix, &[&user]);

    let b = env.balances();
    assert_eq!(b.usdc, 80, "user USDC: 50 leftover + 30 returned by burn_pair");
    assert_eq!(b.yes, 20, "user Yes: 50 minted - 30 burned");
    assert_eq!(b.no, 20, "user No: 50 minted - 30 burned");
    assert_eq!(b.escrow, 20, "USDC escrow: 50 deposited - 30 returned");
    assert_eq!(b.yes_supply, 20, "Yes supply: 50 - 30");
    assert_eq!(b.no_supply, 20, "No supply: 50 - 30");
    env.assert_invariant();
}

// ---------- error paths ----------

#[test]
fn mint_pair_zero_amount_rejected() {
    let mut env = Env::new(100);
    let ix = env.mint_pair_ix(0);
    let user = env.user.insecure_clone();
    let err = try_submit(&mut env.fx.svm, ix, &[&user])
        .expect_err("mint_pair(0) must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("InvalidAmount") || s.contains("custom"),
        "expected InvalidAmount-style error, got: {s}",
    );
    env.assert_invariant();
}

#[test]
fn mint_pair_insufficient_usdc_fails() {
    let mut env = Env::new(10);
    let ix = env.mint_pair_ix(50);
    let user = env.user.insecure_clone();
    let err = try_submit(&mut env.fx.svm, ix, &[&user])
        .expect_err("mint_pair(50) with only 10 USDC must fail");
    // The token program rejects the user → escrow transfer; we just want
    // a clean failure (no partial state change).
    let _ = err;
    let b = env.balances();
    assert_eq!(b.usdc, 10, "user USDC unchanged on failed mint_pair");
    assert_eq!(b.yes, 0, "no Yes minted on failed mint_pair");
    assert_eq!(b.no, 0, "no No minted on failed mint_pair");
    env.assert_invariant();
}

#[test]
fn burn_pair_insufficient_yes_fails() {
    let mut env = Env::new(100);
    let user = env.user.insecure_clone();

    // First mint 50 Yes + 50 No so the user has *some* balance.
    let mint_ix = env.mint_pair_ix(50);
    submit(&mut env.fx.svm, mint_ix, &[&user]);

    // burn_pair(60) trips the constraint (user_yes.amount = 50 < 60).
    let burn_ix = env.burn_pair_ix(60);
    let err = try_submit(&mut env.fx.svm, burn_ix, &[&user])
        .expect_err("burn_pair(60) with only 50 Yes/No must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("InvalidAmount") || s.contains("custom") || s.contains("Constraint"),
        "expected InvalidAmount/constraint error, got: {s}",
    );

    // No state should have changed; invariant still holds.
    let b = env.balances();
    assert_eq!(b.yes, 50);
    assert_eq!(b.no, 50);
    assert_eq!(b.escrow, 50);
    env.assert_invariant();
}

#[test]
fn burn_pair_insufficient_no_fails() {
    // Build a scenario where the user holds 50 Yes but only 5 No, so
    // burn_pair(30) trips the `user_no.amount >= amount` constraint
    // specifically (not the Yes one).
    let mut env = Env::new(100);
    let user = env.user.insecure_clone();

    // mint_pair(50) → user holds 50 Y + 50 N + 50 USDC.
    let mint_ix = env.mint_pair_ix(50);
    submit(&mut env.fx.svm, mint_ix, &[&user]);

    // Move 45 No to a sink account so user_no.amount = 5 while user_yes
    // stays at 50. This isolates the No-side failure path.
    let sink_no = create_token_account(
        &mut env.fx.svm,
        &user,
        &env.user.pubkey(),
        &env.no_mint,
    );
    let transfer_no_ix = token_instruction::transfer(
        &TOKEN_PROGRAM_ID,
        &env.user_no,
        &sink_no.pubkey(),
        &env.user.pubkey(),
        &[],
        45,
    )
    .expect("build transfer ix");
    submit(&mut env.fx.svm, transfer_no_ix, &[&user]);

    let pre = env.balances();
    assert_eq!(pre.yes, 50);
    assert_eq!(pre.no, 5, "user_no.amount drained to 5 for the test");

    // burn_pair(30) should fail because user_no.amount (5) < 30.
    let burn_ix = env.burn_pair_ix(30);
    let err = try_submit(&mut env.fx.svm, burn_ix, &[&user])
        .expect_err("burn_pair(30) with 5 No must fail");
    let s = format!("{err:?}");
    assert!(
        s.contains("InvalidAmount") || s.contains("custom") || s.contains("Constraint"),
        "expected InvalidAmount/constraint error, got: {s}",
    );

    // Pre-burn state preserved.
    let post = env.balances();
    assert_eq!(post.yes, 50);
    assert_eq!(post.no, 5);
    assert_eq!(post.escrow, 50);
}

#[test]
fn mint_pair_when_paused_rejected() {
    let mut env = Env::new(100);
    env.force_pause();

    let ix = env.mint_pair_ix(50);
    let user = env.user.insecure_clone();
    let err = try_submit(&mut env.fx.svm, ix, &[&user])
        .expect_err("mint_pair must fail when config.paused = true");
    let s = format!("{err:?}");
    assert!(
        s.contains("ProgramPaused") || s.contains("custom"),
        "expected ProgramPaused error, got: {s}",
    );

    // No state should have changed.
    let b = env.balances();
    assert_eq!(b.usdc, 100);
    assert_eq!(b.yes, 0);
    assert_eq!(b.no, 0);
    assert_eq!(b.escrow, 0);
}

#[test]
fn burn_pair_when_paused_rejected() {
    let mut env = Env::new(100);
    let user = env.user.insecure_clone();

    // Mint first while still unpaused so the user has something to burn.
    let mint_ix = env.mint_pair_ix(50);
    submit(&mut env.fx.svm, mint_ix, &[&user]);

    env.force_pause();

    let burn_ix = env.burn_pair_ix(20);
    let err = try_submit(&mut env.fx.svm, burn_ix, &[&user])
        .expect_err("burn_pair must fail when config.paused = true");
    let s = format!("{err:?}");
    assert!(
        s.contains("ProgramPaused") || s.contains("custom"),
        "expected ProgramPaused error, got: {s}",
    );

    // Post-mint state preserved.
    let b = env.balances();
    assert_eq!(b.usdc, 50);
    assert_eq!(b.yes, 50);
    assert_eq!(b.no, 50);
    assert_eq!(b.escrow, 50);
    env.assert_invariant();
}

#[test]
fn mint_pair_when_settled_rejected() {
    let mut env = Env::new(100);
    env.force_settled();

    let ix = env.mint_pair_ix(50);
    let user = env.user.insecure_clone();
    let err = try_submit(&mut env.fx.svm, ix, &[&user])
        .expect_err("mint_pair must fail on a settled market");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketSettled") || s.contains("custom"),
        "expected MarketSettled error, got: {s}",
    );

    // No tokens minted.
    let b = env.balances();
    assert_eq!(b.yes, 0);
    assert_eq!(b.no, 0);
    assert_eq!(b.escrow, 0);
}

#[test]
fn burn_pair_when_settled_rejected() {
    let mut env = Env::new(100);
    let user = env.user.insecure_clone();

    // Mint a pair while open so the user holds tokens, then settle + burn.
    let mint_ix = env.mint_pair_ix(50);
    submit(&mut env.fx.svm, mint_ix, &[&user]);
    env.force_settled();

    let burn_ix = env.burn_pair_ix(20);
    let err = try_submit(&mut env.fx.svm, burn_ix, &[&user])
        .expect_err("burn_pair must fail on a settled market");
    let s = format!("{err:?}");
    assert!(
        s.contains("MarketSettled") || s.contains("custom"),
        "expected MarketSettled error, got: {s}",
    );

    // Post-mint state preserved (burn was rejected).
    let b = env.balances();
    assert_eq!(b.yes, 50);
    assert_eq!(b.no, 50);
    assert_eq!(b.escrow, 50);
}

#[test]
fn create_strike_market_when_paused_rejected() {
    // Admin pauses, then tries to open a brand-new market → ProgramPaused.
    let mut env = Env::new(0);
    env.force_pause();

    let ticker: [u8; 8] = *b"PAUSED__";
    let strike_price: u64 = 999_000_000;
    let expiry_unix: i64 = 200_000;
    let pyth_feed_id = [0u8; 32];
    let (market_pda, _) = env.fx.market_pda(&ticker, strike_price, expiry_unix);
    let (book_pda, _) = env.fx.book_pda(&market_pda);
    let (mint_authority, _) = env.fx.mint_authority_pda(&market_pda);
    let (yes_mint, _) = env.fx.yes_mint_pda(&market_pda);
    let (no_mint, _) = env.fx.no_mint_pda(&market_pda);
    let (usdc_escrow, _) = env.fx.usdc_escrow_pda(&market_pda);
    let (yes_escrow, _) = env.fx.yes_escrow_pda(&market_pda);

    let args = meridian::CreateStrikeMarketArgs {
        ticker,
        strike_price,
        expiry_unix,
        pyth_feed_id,
    };
    let mut args_bytes = Vec::new();
    args.serialize(&mut args_bytes).unwrap();
    let ix = anchor_ix(
        MERIDIAN_PROGRAM_ID,
        "create_strike_market",
        &args_bytes,
        vec![
            AccountMeta::new(env.fx.admin.pubkey(), true),
            AccountMeta::new_readonly(env.config_pda, false),
            AccountMeta::new(market_pda, false),
            AccountMeta::new(book_pda, false),
            AccountMeta::new(yes_mint, false),
            AccountMeta::new(no_mint, false),
            AccountMeta::new_readonly(mint_authority, false),
            AccountMeta::new(usdc_escrow, false),
            AccountMeta::new(yes_escrow, false),
            AccountMeta::new_readonly(env.fx.usdc_mint.pubkey(), false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(RENT_SYSVAR_ID, false),
        ],
    );
    let admin = env.fx.admin.insecure_clone();
    let err = try_submit(&mut env.fx.svm, ix, &[&admin])
        .expect_err("create_strike_market must fail when paused");
    let s = format!("{err:?}");
    assert!(
        s.contains("ProgramPaused") || s.contains("custom"),
        "expected ProgramPaused error, got: {s}",
    );
}

#[test]
fn admin_can_pause_and_unpause() {
    let mut env = Env::new(0);
    let admin = env.fx.admin.insecure_clone();
    assert!(!env.paused(), "starts unpaused");

    let ix = env.set_paused_ix(&admin, true);
    submit(&mut env.fx.svm, ix, &[&admin]);
    assert!(env.paused(), "admin pause sets paused=true");

    let ix = env.set_paused_ix(&admin, false);
    submit(&mut env.fx.svm, ix, &[&admin]);
    assert!(!env.paused(), "admin unpause sets paused=false");
}

#[test]
fn non_admin_cannot_pause() {
    let mut env = Env::new(0);
    let user = env.user.insecure_clone(); // not the admin
    let ix = env.set_paused_ix(&user, true);
    let err = try_submit(&mut env.fx.svm, ix, &[&user])
        .expect_err("non-admin must not be able to pause");
    let s = format!("{err:?}");
    assert!(
        s.contains("Unauthorized") || s.contains("custom"),
        "expected Unauthorized, got: {s}",
    );
    assert!(!env.paused(), "paused stays false after a rejected attempt");
}

#[test]
fn set_paused_gates_then_resumes_mint_pair() {
    // End-to-end: the real instruction wires to the gate. Pause blocks
    // mint_pair; unpause lets it through.
    let mut env = Env::new(100);
    let admin = env.fx.admin.insecure_clone();
    let user = env.user.insecure_clone();

    let pause_ix = env.set_paused_ix(&admin, true);
    submit(&mut env.fx.svm, pause_ix, &[&admin]);
    let mint_ix = env.mint_pair_ix(50);
    let err = try_submit(&mut env.fx.svm, mint_ix, &[&user])
        .expect_err("mint_pair must fail while paused");
    assert!(
        format!("{err:?}").contains("ProgramPaused") || format!("{err:?}").contains("custom"),
        "expected ProgramPaused"
    );

    let unpause_ix = env.set_paused_ix(&admin, false);
    submit(&mut env.fx.svm, unpause_ix, &[&admin]);
    // Different amount than the rejected attempt so the tx signature differs
    // (LiteSVM keeps a fixed blockhash; an identical tx would be deduped as
    // AlreadyProcessed).
    let mint_ix = env.mint_pair_ix(30);
    submit(&mut env.fx.svm, mint_ix, &[&user]);
    let b = env.balances();
    assert_eq!(b.yes, 30);
    assert_eq!(b.no, 30);
    assert_eq!(b.escrow, 30);
}

// ---------- keep imports live ----------

/// Touch the unused-by-default imports so a future test edit doesn't have
/// to chase removed `use`s.
#[allow(dead_code)]
fn _imports_kept_live(_: TokenAccountState, _: SolanaAccount) {}
