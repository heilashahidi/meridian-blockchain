//! Test fixtures shared across the LiteSVM scenarios in `tests/*.rs`.
//!
//! Per U3 plan §"Files": `common.rs` provides test fixtures that deploy the
//! Meridian program, mint test USDC, and run `initialize_config`. At U3 we
//! only need the program-deploy + USDC-mint helpers; U4-U8 will extend
//! this module as more instructions land.

use std::path::PathBuf;

use anchor_lang::Discriminator;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_interface::{
    instruction as token_instruction,
    state::{Account as TokenAccountState, Mint as MintState},
};

pub use meridian;

/// The on-chain program id declared in `programs/meridian/src/lib.rs`.
pub const MERIDIAN_PROGRAM_ID: Address = solana_address::address!(
    "6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX"
);

/// SPL Token program id — duplicated here so the test crate stays
/// independent of the full `spl-token` crate (we only need its state
/// types from `spl-token-interface`).
pub const TOKEN_PROGRAM_ID: Address = solana_address::address!(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

/// System program id.
pub const SYSTEM_PROGRAM_ID: Address = solana_address::address!(
    "11111111111111111111111111111111"
);

/// Rent sysvar id.
pub const RENT_SYSVAR_ID: Address = solana_address::address!(
    "SysvarRent111111111111111111111111111111111"
);

/// A `LiteSVM` instance with the Meridian program preloaded, plus a
/// freshly-airdropped admin/payer keypair and a USDC mint owned by the
/// admin.
pub struct Fixture {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub usdc_mint: Keypair,
}

impl Fixture {
    /// Build a fixture: deploy `meridian.so` into a new SVM, airdrop the
    /// admin, and create a 6-decimals USDC mint controlled by the admin.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = read_meridian_so();
        svm.add_program(MERIDIAN_PROGRAM_ID, &so)
            .expect("add meridian program");

        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000_000_000)
            .expect("airdrop admin");

        let usdc_mint = Keypair::new();
        create_usdc_mint(&mut svm, &admin, &usdc_mint);

        Self {
            svm,
            admin,
            usdc_mint,
        }
    }

    /// PDA for the singleton Config account.
    pub fn config_pda(&self) -> (Address, u8) {
        Address::find_program_address(
            &[meridian::state::Config::SEED],
            &MERIDIAN_PROGRAM_ID,
        )
    }

    /// PDA for a Market account given `(ticker, strike, expiry)`.
    pub fn market_pda(&self, ticker: &[u8; 8], strike: u64, expiry: i64) -> (Address, u8) {
        Address::find_program_address(
            &[
                meridian::state::Market::SEED_PREFIX,
                ticker.as_ref(),
                &strike.to_le_bytes(),
                &expiry.to_le_bytes(),
            ],
            &MERIDIAN_PROGRAM_ID,
        )
    }

    /// PDA for the Book account of the given market.
    pub fn book_pda(&self, market: &Address) -> (Address, u8) {
        Address::find_program_address(
            &[meridian::state::Book::SEED_PREFIX, market.as_ref()],
            &MERIDIAN_PROGRAM_ID,
        )
    }

    /// PDA for the mint-authority of the given market.
    pub fn mint_authority_pda(&self, market: &Address) -> (Address, u8) {
        Address::find_program_address(
            &[
                meridian::state::Market::MINT_AUTH_SEED_PREFIX,
                market.as_ref(),
            ],
            &MERIDIAN_PROGRAM_ID,
        )
    }

    /// PDA for the Yes mint.
    pub fn yes_mint_pda(&self, market: &Address) -> (Address, u8) {
        Address::find_program_address(&[b"yes_mint", market.as_ref()], &MERIDIAN_PROGRAM_ID)
    }

    /// PDA for the No mint.
    pub fn no_mint_pda(&self, market: &Address) -> (Address, u8) {
        Address::find_program_address(&[b"no_mint", market.as_ref()], &MERIDIAN_PROGRAM_ID)
    }

    /// PDA for the USDC escrow token account.
    pub fn usdc_escrow_pda(&self, market: &Address) -> (Address, u8) {
        Address::find_program_address(
            &[
                meridian::state::Market::USDC_ESCROW_SEED_PREFIX,
                market.as_ref(),
            ],
            &MERIDIAN_PROGRAM_ID,
        )
    }

    /// PDA for the Yes-token escrow account.
    pub fn yes_escrow_pda(&self, market: &Address) -> (Address, u8) {
        Address::find_program_address(
            &[
                meridian::state::Market::YES_ESCROW_SEED_PREFIX,
                market.as_ref(),
            ],
            &MERIDIAN_PROGRAM_ID,
        )
    }

    /// Build + sign + submit a transaction with a single instruction
    /// signed by the admin. Returns the transaction metadata.
    pub fn submit_admin_ix(&mut self, ix: Instruction) -> litesvm::types::TransactionMetadata {
        self.submit_ix_with_signers(ix, &[&self.admin.insecure_clone()])
    }

    pub fn submit_ix_with_signers(
        &mut self,
        ix: Instruction,
        signers: &[&Keypair],
    ) -> litesvm::types::TransactionMetadata {
        let blockhash = self.svm.latest_blockhash();
        let payer = signers[0].pubkey();
        let msg = Message::new_with_blockhash(&[ix], Some(&payer), &blockhash);
        let tx = Transaction::new(signers, msg, blockhash);
        self.svm
            .send_transaction(tx)
            .expect("transaction succeeds (use try_submit_* for failure cases)")
    }

    /// Variant that surfaces the inner `TransactionError` so error-path
    /// tests can assert on the failure mode.
    pub fn try_submit_ix_with_signers(
        &mut self,
        ix: Instruction,
        signers: &[&Keypair],
    ) -> Result<
        litesvm::types::TransactionMetadata,
        litesvm::types::FailedTransactionMetadata,
    > {
        let blockhash = self.svm.latest_blockhash();
        let payer = signers[0].pubkey();
        let msg = Message::new_with_blockhash(&[ix], Some(&payer), &blockhash);
        let tx = Transaction::new(signers, msg, blockhash);
        self.svm.send_transaction(tx)
    }
}

impl Default for Fixture {
    fn default() -> Self {
        Self::new()
    }
}

fn read_meridian_so() -> Vec<u8> {
    // The build runs `anchor build` (or `cargo-build-sbf`) which drops
    // `target/deploy/meridian.so` at the workspace root.
    let mut path = workspace_root();
    path.push("target/deploy/meridian.so");
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "failed to read {} ({e}). Run `anchor build` before `cargo test -p meridian-litesvm-tests`.",
            path.display()
        )
    })
}

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR for this crate is `<repo>/tests/litesvm`.
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // -> `<repo>/tests`
    path.pop(); // -> `<repo>`
    path
}

fn create_usdc_mint(svm: &mut LiteSVM, payer: &Keypair, mint: &Keypair) {
    // Rent for a Mint account: 82 bytes is the SPL Token Mint size; pay
    // a generous rent-exempt balance (LiteSVM has a fixed rent schedule).
    let mint_len: usize = <MintState as solana_program_pack::Pack>::LEN;
    let mint_rent = svm.minimum_balance_for_rent_exemption(mint_len);
    let create_account_ix = solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        mint_rent,
        mint_len as u64,
        &TOKEN_PROGRAM_ID,
    );
    let init_mint_ix = token_instruction::initialize_mint(
        &TOKEN_PROGRAM_ID,
        &mint.pubkey(),
        &payer.pubkey(),
        None,
        6,
    )
    .expect("build init_mint ix");

    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(
        &[create_account_ix, init_mint_ix],
        Some(&payer.pubkey()),
        &blockhash,
    );
    let tx = Transaction::new(&[payer, mint], msg, blockhash);
    svm.send_transaction(tx).expect("create USDC mint");
}

/// Build a raw `Instruction` for an Anchor program method, given the
/// snake_case method name and Borsh-serialized arg payload.
///
/// Anchor's wire layout for an instruction is `discriminator (8 bytes) ||
/// borsh(args)`. The discriminator is the first 8 bytes of
/// `sha256("global:<method>")`. We compute it host-side to avoid pulling
/// in `anchor-syn` (a build-time crate).
pub fn anchor_ix(
    program_id: Address,
    method: &str,
    args: &[u8],
    accounts: Vec<AccountMeta>,
) -> Instruction {
    let discriminator = anchor_method_discriminator(method);
    let mut data = Vec::with_capacity(8 + args.len());
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(args);
    Instruction {
        program_id,
        accounts,
        data,
    }
}

/// First 8 bytes of `sha256("global:<method>")` — the discriminator
/// Anchor emits on the wire for any `#[program]`-attributed method.
pub fn anchor_method_discriminator(method: &str) -> [u8; 8] {
    use sha2::{Digest, Sha256};
    let preimage = format!("global:{method}");
    let mut hasher = Sha256::new();
    hasher.update(preimage.as_bytes());
    let hash = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&hash[..8]);
    out
}

/// Helper that reads an Anchor account's data and Borsh-deserializes it,
/// stripping the 8-byte discriminator prefix.
pub fn load_anchor_account<T>(svm: &LiteSVM, address: &Address) -> T
where
    T: anchor_lang::AccountDeserialize + Discriminator,
{
    let account = svm
        .get_account(address)
        .unwrap_or_else(|| panic!("account {address} not found"));
    let mut data: &[u8] = &account.data;
    T::try_deserialize(&mut data).expect("deserialize anchor account")
}

/// Read a zero-copy Anchor account by `bytemuck`-casting the data slice
/// past the 8-byte discriminator. Returns an owned copy.
pub fn load_zero_copy_account<T>(svm: &LiteSVM, address: &Address) -> T
where
    T: bytemuck::Pod + Copy,
{
    let account = svm
        .get_account(address)
        .unwrap_or_else(|| panic!("account {address} not found"));
    let data = &account.data[8..]; // skip discriminator
    let view: &T = bytemuck::from_bytes(&data[..std::mem::size_of::<T>()]);
    *view
}

/// Read an SPL Token state struct from a LiteSVM account.
pub fn read_token_account(svm: &LiteSVM, address: &Address) -> TokenAccountState {
    let account = svm
        .get_account(address)
        .unwrap_or_else(|| panic!("token account {address} not found"));
    solana_program_pack::Pack::unpack(&account.data).expect("unpack SPL Token Account")
}

/// Read an SPL Token Mint state struct from a LiteSVM account.
pub fn read_mint(svm: &LiteSVM, address: &Address) -> MintState {
    let account = svm
        .get_account(address)
        .unwrap_or_else(|| panic!("mint {address} not found"));
    solana_program_pack::Pack::unpack(&account.data).expect("unpack SPL Mint")
}

/// Plant a fake Pyth `PriceUpdateV2` account at `address` so `settle_market`
/// can read it. Used by U7 LiteSVM tests where the real Pyth Hermes /
/// Wormhole posting path isn't available.
///
/// The byte layout matches what Pyth's on-chain receiver writes — see
/// `programs/meridian/src/state/pyth.rs` module docs. We construct the
/// payload by calling our vendored `PriceUpdateV2::try_serialize`, which
/// emits Anchor's 8-byte discriminator (matching upstream) + Borsh body.
pub fn set_pyth_price(
    svm: &mut LiteSVM,
    address: Address,
    feed_id: [u8; 32],
    price: i64,
    conf: u64,
    exponent: i32,
    publish_time: i64,
) {
    use anchor_lang::AccountSerialize;
    use meridian::state::pyth::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};

    let pu = PriceUpdateV2 {
        // `write_authority` and `posted_slot` aren't checked by our
        // `settle_market`; any valid Pubkey / u64 works.
        write_authority: anchor_lang::prelude::Pubkey::default(),
        verification_level: VerificationLevel::Full,
        price_message: PriceFeedMessage {
            feed_id,
            price,
            conf,
            exponent,
            publish_time,
            prev_publish_time: publish_time.saturating_sub(1),
            ema_price: price,
            ema_conf: conf,
        },
        posted_slot: 0,
    };
    let mut data: Vec<u8> = Vec::with_capacity(256);
    pu.try_serialize(&mut data).expect("serialize PriceUpdateV2");

    // Anchor's `Account<'info, T>` requires the account be owned by the
    // declaring program. Our vendored `PriceUpdateV2` has `#[account]`
    // applied **inside** the meridian crate, so its owner check is
    // `owner == meridian::ID`. Real-world deployments would have the
    // pyth_solana_receiver program as owner, but our `settle_market`
    // happily reads any account whose discriminator + body match — and
    // Anchor's `Account::try_from` does check the owner. The simplest
    // path: own the account by the meridian program (this is the only
    // place the vendored discriminator is meaningful anyway).
    let rent = svm.minimum_balance_for_rent_exemption(data.len());
    let account = solana_account::Account {
        lamports: rent,
        data,
        owner: MERIDIAN_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    };
    svm.set_account(address, account)
        .expect("set_account PriceUpdateV2");
}

/// Plant a `PriceUpdateV2` with `VerificationLevel::Partial` (owned by
/// `MERIDIAN_PROGRAM_ID`). Used to test `Config.require_full_verification`:
/// settle must reject this when the flag is on, accept it when relaxed.
#[allow(clippy::too_many_arguments)]
pub fn set_pyth_price_partial(
    svm: &mut LiteSVM,
    address: Address,
    feed_id: [u8; 32],
    price: i64,
    conf: u64,
    exponent: i32,
    publish_time: i64,
) {
    use anchor_lang::AccountSerialize;
    use meridian::state::pyth::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};

    let pu = PriceUpdateV2 {
        write_authority: anchor_lang::prelude::Pubkey::default(),
        verification_level: VerificationLevel::Partial { num_signatures: 1 },
        price_message: PriceFeedMessage {
            feed_id,
            price,
            conf,
            exponent,
            publish_time,
            prev_publish_time: publish_time.saturating_sub(1),
            ema_price: price,
            ema_conf: conf,
        },
        posted_slot: 0,
    };
    let mut data: Vec<u8> = Vec::with_capacity(256);
    pu.try_serialize(&mut data).expect("serialize PriceUpdateV2");
    let rent = svm.minimum_balance_for_rent_exemption(data.len());
    let account = solana_account::Account {
        lamports: rent,
        data,
        owner: MERIDIAN_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    };
    svm.set_account(address, account)
        .expect("set_account PriceUpdateV2");
}

/// Plant a `PriceUpdateV2` account owned by `owner` instead of the default
/// `MERIDIAN_PROGRAM_ID`. Used by regression tests that verify
/// `settle_market`'s owner check rejects accounts owned by anything other
/// than `config.pyth_receiver`.
pub fn set_pyth_price_with_owner(
    svm: &mut LiteSVM,
    address: Address,
    owner: Address,
    feed_id: [u8; 32],
    price: i64,
    conf: u64,
    exponent: i32,
    publish_time: i64,
) {
    use anchor_lang::AccountSerialize;
    use meridian::state::pyth::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};

    let pu = PriceUpdateV2 {
        write_authority: anchor_lang::prelude::Pubkey::default(),
        verification_level: VerificationLevel::Full,
        price_message: PriceFeedMessage {
            feed_id,
            price,
            conf,
            exponent,
            publish_time,
            prev_publish_time: publish_time.saturating_sub(1),
            ema_price: price,
            ema_conf: conf,
        },
        posted_slot: 0,
    };
    let mut data: Vec<u8> = Vec::with_capacity(256);
    pu.try_serialize(&mut data).expect("serialize PriceUpdateV2");
    let rent = svm.minimum_balance_for_rent_exemption(data.len());
    let account = solana_account::Account {
        lamports: rent,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    };
    svm.set_account(address, account)
        .expect("set_account PriceUpdateV2");
}

/// Advance the LiteSVM `Clock` sysvar's `unix_timestamp` to `new_ts`.
/// Doesn't change the slot — slot-based fees and rent still tick on
/// `expire_blockhash`, but block time is independent.
pub fn set_clock_unix_ts(svm: &mut LiteSVM, new_ts: i64) {
    let mut clock = svm.get_sysvar::<solana_clock::Clock>();
    clock.unix_timestamp = new_ts;
    svm.set_sysvar(&clock);
}

/// Helper to enforce a no-op use of `Account` to keep the import live
/// when test scenarios don't directly reference it.
#[allow(dead_code)]
fn _account_kept_live(_: Account) {}

// ============================================================================
// Cross-cutting invariant helper (U8)
// ============================================================================
//
// Per plan §U8 verification:
//   "escrow reconciliation invariant asserted in test teardown via helper."
//
// Rust's test framework doesn't expose teardown hooks; tests call
// `assert_invariants(...)` explicitly at end-of-test (or after key
// transitions) instead. The helper is opt-in by design.
//
// The invariants we assert are the cross-cutting ones from the plan's
// Requirements ledger that survive mid-trade states:
//
//   R14:  yes_mint.supply == no_mint.supply
//         Every mint_pair creates one Yes + one No; every burn_pair burns
//         one of each. The supplies must always match.
//
//   USDC conservation (the $1.00 invariant precondition):
//         sum(user_usdc) + sum(escrow_usdc) == initial_total
//         No USDC is ever created or destroyed by program instructions —
//         it only moves between user wallets and escrow PDAs. After settle
//         + sweep + redeem, the same total is preserved.
//
// Mid-trade USDC-vs-open-bid-notional reconciliation is *not* asserted
// here: that invariant holds only when no order is currently being
// matched, and pinning it down requires the test to know the exact book
// state, which is scenario-specific. We keep the helper minimal and
// scenario-agnostic so it can be called at any logical breakpoint.

/// USDC + supply invariants asserted across the test environment.
///
/// Pass every USDC-holding address (user ATAs + escrows + settlement
/// vault) that should be counted toward the conservation sum. The
/// `expected_total_usdc` argument is the total USDC seeded into the test
/// at fixture time (admin minted into user wallets); the helper asserts
/// nothing escaped.
///
/// `yes_mint` / `no_mint` are read for R14 (`supply_yes == supply_no`).
pub fn assert_invariants(
    svm: &LiteSVM,
    usdc_holders: &[Address],
    expected_total_usdc: u64,
    yes_mint: &Address,
    no_mint: &Address,
) {
    // R14: Yes and No supplies match.
    let yes_supply = read_mint(svm, yes_mint).supply;
    let no_supply = read_mint(svm, no_mint).supply;
    assert_eq!(
        yes_supply, no_supply,
        "R14 violated: Yes supply {yes_supply} != No supply {no_supply}",
    );

    // USDC conservation: sum across the named accounts equals the seeded
    // total. This catches both creation (program-side mint) and
    // destruction (program-side burn or stuck-in-orphan-account) bugs.
    let mut sum: u64 = 0;
    for addr in usdc_holders {
        // Some addresses may not exist as token accounts in a given
        // scenario (e.g., a second-market escrow that's empty); treat
        // missing accounts as zero so the helper composes cleanly across
        // sub-tests that touch different account sets.
        if let Some(account) = svm.get_account(addr) {
            if account.owner == TOKEN_PROGRAM_ID && !account.data.is_empty() {
                let state: spl_token_interface::state::Account =
                    solana_program_pack::Pack::unpack(&account.data)
                        .expect("unpack token account in assert_invariants");
                sum = sum
                    .checked_add(state.amount)
                    .expect("USDC sum overflow — test seeded too much?");
            }
        }
    }
    assert_eq!(
        sum, expected_total_usdc,
        "USDC conservation violated: observed {sum} across {n} accounts, expected {expected_total_usdc}",
        n = usdc_holders.len(),
    );
}
