//! Trident multi-instruction fuzz harness for the Meridian on-chain CLOB.
//!
//! Per plan §U9:
//!   * #[flow] randomized sequences of `mint_pair`, `burn_pair`,
//!     `place_limit_order`, `place_market_order`, `cancel_order`, `buy_no`,
//!     `sell_no`.
//!   * After every flow step, assert invariants:
//!       - R13: usdc_escrow == sum(open_bid.qty * open_bid.price)
//!              AND yes_escrow == sum(open_ask.qty)
//!       - R14: yes_mint.supply == no_mint.supply
//!       - Token conservation: sum(USDC across all named accounts) ==
//!         initial total seeded.
//!
//! ## Deviation from plan: settle / sweep / redeem are out-of-scope here
//!
//! Plan §U9's instruction list includes `settle_market`, `settle_sweep`, and
//! `redeem`. Planting a fake `PriceUpdateV2` account for `settle_market`
//! requires (a) the meridian program as account owner and (b) the vendored
//! `PriceUpdateV2` Borsh layout — both doable but expensive in Trident's
//! flow API, and crucially `settle_market` is the *only* instruction here
//! that needs that machinery. The plan explicitly authorizes scoping this
//! out: U9's value is the *non*-settle invariants (R13/R14/conservation)
//! that ride through the matching/escrow code paths. Settle-race scenarios
//! are already covered by the LiteSVM `settle_race_test.rs` in U8.
//!
//! ## Layout note
//!
//! Trident's `trident init` scaffolded into `trident-tests/` (its own
//! convention) rather than the plan's `tests/trident/` path. The Trident
//! CLI insists on its own directory; we follow Trident's convention.

use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
// types.rs is the trident-generated instruction shape file — kept as
// documentation of the wire ABI even though we hand-build instructions
// against the meridian crate's seed constants. The `_types_kept_live`
// helper below imports one type to keep the module from being pruned.
#[allow(unused_imports)]
mod types;

use anchor_lang::Discriminator;
use sha2::Digest;
use solana_sdk::program_pack::Pack;

// ---------------------------------------------------------------------------
// Layout constants matching the meridian on-chain program
// ---------------------------------------------------------------------------

const ANCHOR_DISCRIMINATOR: usize = 8;

/// Per `state::book::Book`: market(32) + bids(1800) + asks(1800) + next_seq(8).
const BOOK_DATA_SIZE: usize = 3640;
const BOOK_DEPTH: usize = 32;
/// `OrderEntry`: OrderKey(16) + owner(32) + qty(8).
const ORDER_ENTRY_SIZE: usize = 56;
/// `BookSide<32>`: len(8) + entries(32 * 56 = 1792). Total 1800.
const BOOK_SIDE_SIZE: usize = 8 + BOOK_DEPTH * ORDER_ENTRY_SIZE;

// Sanity-check the layout at compile time against the runtime sizes above.
const _: () = assert!(BOOK_SIDE_SIZE == 1800);
const _: () = assert!(BOOK_DATA_SIZE == 32 + 2 * BOOK_SIDE_SIZE + 8);

/// USDC seeded per user at init. 1_000_000 USDC microunits = $1.00.
/// Each of the 3 users gets a healthy bankroll so the fuzzer has room to
/// place orders without hitting trivial insufficient-funds reverts.
const INITIAL_USDC_PER_USER: u64 = 10_000_000_000; // 10_000 USDC

const NUM_USERS: usize = 3;
const NUM_MARKETS: usize = 2;

/// Mirror of `place_limit_order::MAX_FILLS_PER_TX`: a taker walks at most
/// this many opposing entries per tx. `place_order_inner` reads the maker
/// payout accounts from `remaining_accounts[i*2]` (maker USDC) and
/// `[i*2 + 1]` (maker Yes) for each fill `i`. Every "user" here is the
/// admin keypair, so every maker's payout ATAs are the admin's USDC + this
/// market's Yes ATA; we always supply MAX_FILLS_PER_TX pairs and the
/// handler ignores any tail slots beyond the actual fill count.
const MAX_FILLS_PER_TX: usize = 4;

/// Mid price used for liquidity-seeding orders, in USDC microunits per Yes
/// token. Deliberately small so `qty * price` locks stay affordable from
/// the shared bankroll even at large qty — the R13 invariant uses the same
/// `qty * price` product, so economic realism is irrelevant to correctness.
const MID_PRICE: u64 = 1_000;

// Token program ID (classic SPL Token). Matches the program's
// declare_id! in spl_token_interface.
fn token_program_id() -> Pubkey {
    pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
}

// Re-derive the meridian program id at the same address the program
// declares in `lib.rs` / `Anchor.toml`.
fn meridian_program_id() -> Pubkey {
    pubkey!("6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX")
}

// ---------------------------------------------------------------------------
// Setup state shared across flows in one iteration
// ---------------------------------------------------------------------------

struct MarketCtx {
    market: Pubkey,
    book: Pubkey,
    yes_mint: Pubkey,
    no_mint: Pubkey,
    mint_authority: Pubkey,
    usdc_escrow: Pubkey,
    yes_escrow: Pubkey,
    /// user_idx -> (yes_ata, no_ata) for this market.
    user_yes_ata: [Pubkey; NUM_USERS],
    user_no_ata: [Pubkey; NUM_USERS],
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    // Persistent across iterations within the same FuzzTest::fuzz call.
    inited: bool,
    admin: solana_sdk::signature::Keypair,
    users: Vec<solana_sdk::signature::Keypair>,
    user_usdc: Vec<Pubkey>,
    usdc_mint: Pubkey,
    config: Pubkey,
    markets: Vec<MarketCtx>,
    initial_total_usdc: u64,
}

impl Default for FuzzTest {
    fn default() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            inited: false,
            admin: solana_sdk::signature::Keypair::new(),
            users: Vec::new(),
            user_usdc: Vec::new(),
            usdc_mint: Pubkey::default(),
            config: Pubkey::default(),
            markets: Vec::new(),
            initial_total_usdc: 0,
        }
    }
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self::default()
    }

    #[init]
    fn start(&mut self) {
        // Trident resets the SVM between iterations; we rebuild fixtures.
        self.inited = false;
        self.users.clear();
        self.user_usdc.clear();
        self.markets.clear();
        self.initial_total_usdc = 0;
        self.bootstrap();
    }

    // -------------------------------------------------------------------
    // Flows — one #[flow] per instruction.
    // -------------------------------------------------------------------

    #[flow]
    fn flow_mint_pair(&mut self) {
        if !self.inited {
            return;
        }
        let user_idx = self.trident.random_from_range(0..NUM_USERS);
        let market_idx = self.trident.random_from_range(0..NUM_MARKETS);
        // Mint locks `amount` USDC. Bound to a quarter of the live (shared)
        // bankroll so the mint clears and leaves room for other flows.
        let cap = (self.usdc_bal(user_idx) / 4).max(1);
        if cap < 2 {
            return;
        }
        let amount = self.trident.random_from_range(1u64..cap);
        let _ = self.do_mint_pair(user_idx, market_idx, amount);
        self.assert_all_invariants();
    }

    #[flow]
    fn flow_burn_pair(&mut self) {
        if !self.inited {
            return;
        }
        let user_idx = self.trident.random_from_range(0..NUM_USERS);
        let market_idx = self.trident.random_from_range(0..NUM_MARKETS);
        // burn_pair needs `amount` of BOTH Yes and No on hand. If the user
        // holds neither, mint a pair first so the burn path actually runs.
        let mut cap = self
            .yes_bal(user_idx, market_idx)
            .min(self.no_bal(user_idx, market_idx));
        if cap == 0 {
            let mint_cap = (self.usdc_bal(user_idx) / 4).max(1);
            if mint_cap >= 2 {
                let a = self.trident.random_from_range(1u64..mint_cap);
                let _ = self.do_mint_pair(user_idx, market_idx, a);
            }
            cap = self
                .yes_bal(user_idx, market_idx)
                .min(self.no_bal(user_idx, market_idx));
        }
        if cap == 0 {
            return;
        }
        let amount = if cap == 1 {
            1
        } else {
            self.trident.random_from_range(1u64..cap.saturating_add(1))
        };
        let _ = self.do_burn_pair(user_idx, market_idx, amount);
        self.assert_all_invariants();
    }

    #[flow]
    fn flow_place_limit(&mut self) {
        if !self.inited {
            return;
        }
        let user_idx = self.trident.random_from_range(0..NUM_USERS);
        let market_idx = self.trident.random_from_range(0..NUM_MARKETS);
        // Price band straddles MID_PRICE so bids and asks overlap and
        // genuinely cross sometimes (exercising the fill path) and rest
        // otherwise. Strictly inside (0, $1).
        let price = self.trident.random_from_range(1u64..(4 * MID_PRICE));
        if self.trident.random_bool() {
            // Bid (buy Yes): up-front lock = qty * price. Clamp qty so the
            // lock fits an eighth of the live bankroll.
            let usdc = self.usdc_bal(user_idx);
            let qmax = (usdc / 8 / price).clamp(1, 2_000_000);
            let qty = if qmax <= 1 {
                1
            } else {
                self.trident.random_from_range(1u64..qmax.saturating_add(1))
            };
            let _ = self.do_place_limit(user_idx, market_idx, 0, price, qty);
        } else {
            // Ask (sell Yes): up-front lock = qty Yes. Ensure the user holds
            // some Yes (mint a pair if empty), then clamp qty to holdings.
            let mut yes = self.yes_bal(user_idx, market_idx);
            if yes == 0 {
                let mc = (self.usdc_bal(user_idx) / 8).max(1);
                if mc >= 2 {
                    let a = self.trident.random_from_range(1u64..mc);
                    let _ = self.do_mint_pair(user_idx, market_idx, a);
                }
                yes = self.yes_bal(user_idx, market_idx);
            }
            if yes == 0 {
                return;
            }
            let qmax = yes.min(2_000_000);
            let qty = if qmax <= 1 {
                1
            } else {
                self.trident.random_from_range(1u64..qmax.saturating_add(1))
            };
            let _ = self.do_place_limit(user_idx, market_idx, 1, price, qty);
        }
        self.assert_all_invariants();
    }

    #[flow]
    fn flow_place_market(&mut self) {
        if !self.inited {
            return;
        }
        let user_idx = self.trident.random_from_range(0..NUM_USERS);
        let market_idx = self.trident.random_from_range(0..NUM_MARKETS);
        // slippage_bound is the worst acceptable price; for a Bid taker the
        // up-front lock = qty * slippage_bound, for an Ask taker = qty Yes.
        let slippage_bound = self.trident.random_from_range(1u64..(4 * MID_PRICE));
        if self.trident.random_bool() {
            let usdc = self.usdc_bal(user_idx);
            let qmax = (usdc / 8 / slippage_bound).clamp(1, 2_000_000);
            let qty = if qmax <= 1 {
                1
            } else {
                self.trident.random_from_range(1u64..qmax.saturating_add(1))
            };
            let _ = self.do_place_market(user_idx, market_idx, 0, qty, slippage_bound);
        } else {
            let mut yes = self.yes_bal(user_idx, market_idx);
            if yes == 0 {
                let mc = (self.usdc_bal(user_idx) / 8).max(1);
                if mc >= 2 {
                    let a = self.trident.random_from_range(1u64..mc);
                    let _ = self.do_mint_pair(user_idx, market_idx, a);
                }
                yes = self.yes_bal(user_idx, market_idx);
            }
            if yes == 0 {
                return;
            }
            let qmax = yes.min(2_000_000);
            let qty = if qmax <= 1 {
                1
            } else {
                self.trident.random_from_range(1u64..qmax.saturating_add(1))
            };
            let _ = self.do_place_market(user_idx, market_idx, 1, qty, slippage_bound);
        }
        self.assert_all_invariants();
    }

    #[flow]
    fn flow_cancel(&mut self) {
        if !self.inited {
            return;
        }
        let market_idx = self.trident.random_from_range(0..NUM_MARKETS);
        // Pick a random resting order to cancel. If the book is empty,
        // skip. We have to read the book each time because flows can have
        // cleared it.
        let resting = self.read_resting(market_idx);
        if resting.bids.is_empty() && resting.asks.is_empty() {
            return;
        }
        let side: u8 = if !resting.bids.is_empty() && (resting.asks.is_empty() || self.trident.random_bool()) {
            0
        } else {
            1
        };
        let entries = if side == 0 { &resting.bids } else { &resting.asks };
        if entries.is_empty() {
            return;
        }
        let idx = self.trident.random_from_range(0..entries.len());
        let entry = entries[idx];
        // owner is the user keypair — find which user has this pubkey.
        let owner_pk = Pubkey::from(entry.owner);
        let user_idx = match self
            .users
            .iter()
            .position(|kp| solana_sdk::signer::Signer::pubkey(kp) == owner_pk)
        {
            Some(i) => i,
            None => return,
        };
        let _ = self.do_cancel(user_idx, market_idx, side, entry.price, entry.seq);
        self.assert_all_invariants();
    }

    #[flow]
    fn flow_buy_no(&mut self) {
        if !self.inited {
            return;
        }
        let user_idx = self.trident.random_from_range(0..NUM_USERS);
        let market_idx = self.trident.random_from_range(0..NUM_MARKETS);
        // buy_no mints `amount` (locks `amount` USDC) then market-sells the
        // Yes leg, which MUST fully fill against resting bids or the whole
        // tx reverts. Bound amount so both the mint and a seeded MID-priced
        // bid (lock = amount * MID_PRICE) fit the bankroll.
        let usdc = self.usdc_bal(user_idx);
        let cap = (usdc / 8 / MID_PRICE).clamp(1, 1_000_000);
        if cap < 1 {
            return;
        }
        let amount = if cap <= 1 {
            1
        } else {
            self.trident.random_from_range(1u64..cap.saturating_add(1))
        };
        // Best-effort: guarantee a crossable bid of at least `amount`. A
        // MID-priced bid crosses any Ask taker with limit price <= MID.
        if self.side_qty(market_idx, true) < amount {
            let _ = self.seed_bid(user_idx, market_idx, amount);
        }
        // min_yes_sell_price = 1 so the MID-priced maker bid always crosses.
        let _ = self.do_buy_no(user_idx, market_idx, amount, 1);
        self.assert_all_invariants();
    }

    #[flow]
    fn flow_sell_no(&mut self) {
        if !self.inited {
            return;
        }
        let user_idx = self.trident.random_from_range(0..NUM_USERS);
        let market_idx = self.trident.random_from_range(0..NUM_MARKETS);
        // sell_no buys `amount` Yes (Bid taker, lock = amount * max_price)
        // then burns the pair, so the user must hold `amount` No. Mint a
        // pair first if the user holds no No.
        let mut no = self.no_bal(user_idx, market_idx);
        if no == 0 {
            let mc = (self.usdc_bal(user_idx) / 8).max(1);
            if mc >= 2 {
                let a = self.trident.random_from_range(1u64..mc);
                let _ = self.do_mint_pair(user_idx, market_idx, a);
            }
            no = self.no_bal(user_idx, market_idx);
        }
        if no == 0 {
            return;
        }
        // Buy the Yes leg at up to MID_PRICE; clamp amount by No held and by
        // the Bid-taker lock (amount * MID_PRICE).
        let max_price = MID_PRICE;
        let aff = (self.usdc_bal(user_idx) / 8 / max_price).max(1);
        let cap = no.min(aff).min(1_000_000);
        if cap < 1 {
            return;
        }
        let amount = if cap <= 1 {
            1
        } else {
            self.trident.random_from_range(1u64..cap.saturating_add(1))
        };
        // Best-effort: guarantee a crossable ask of at least `amount`. A
        // MID-priced ask crosses a Bid taker with limit price >= MID.
        if self.side_qty(market_idx, false) < amount {
            let _ = self.seed_ask(user_idx, market_idx, amount);
        }
        let _ = self.do_sell_no(user_idx, market_idx, amount, max_price);
        self.assert_all_invariants();
    }

    #[end]
    fn end(&mut self) {
        if self.inited {
            self.assert_all_invariants();
        }
    }

    // ===================================================================
    // Bootstrap
    // ===================================================================

    fn bootstrap(&mut self) {
        // Trident's `process_transaction` always signs with the default
        // payer keypair — the harness has no per-transaction signer set.
        // Make the admin the same as the default payer so admin-only
        // instructions (`initialize_config`, `create_strike_market`) sign
        // correctly without extra wiring.
        self.admin = self.trident.payer();
        let admin_pk = solana_sdk::signer::Signer::pubkey(&self.admin);
        self.trident.airdrop(&admin_pk, 1_000 * LAMPORTS_PER_SOL);

        // USDC mint — fresh keypair per iteration.
        let usdc_mint_kp = solana_sdk::signature::Keypair::new();
        let usdc_mint = solana_sdk::signer::Signer::pubkey(&usdc_mint_kp);
        let ixs = self
            .trident
            .initialize_mint(&admin_pk, &usdc_mint, 6, &admin_pk, None);
        let res = self.trident.process_transaction(&ixs, Some("usdc_mint_init"));
        assert!(res.is_success(), "initialize USDC mint failed: logs={}", res.logs());
        self.usdc_mint = usdc_mint;

        // Create users. NOTE: the program signs with the user as the
        // `Signer<'info>`. Trident only uses `payer()` as signer in
        // process_transaction. To work around this, the users are *all*
        // the same default payer key — they are distinguished by their
        // own ATAs. This is a simplifying choice: we lose cross-user
        // ownership distinction (cancel-by-owner can't trip on a wrong
        // owner because all users are the same key), but R13/R14/
        // conservation invariants are independent of ownership identity.
        //
        // Cancel-by-non-owner is already covered by U5/U8 LiteSVM tests.
        let user_kp = self.admin.insecure_clone();
        for _ in 0..NUM_USERS {
            self.users.push(user_kp.insecure_clone());
        }

        // Create user USDC ATAs. With all users equal to admin, only one
        // ATA exists; but we still keep NUM_USERS slots in `user_usdc`
        // for indexing symmetry.
        let ata = self
            .trident
            .get_associated_token_address(&usdc_mint, &admin_pk, &token_program_id());
        let create_ata_ix = self
            .trident
            .initialize_associated_token_account(&admin_pk, &usdc_mint, &admin_pk);
        let res = self
            .trident
            .process_transaction(&[create_ata_ix], Some("usdc_ata_init"));
        assert!(res.is_success(), "create USDC ATA failed: logs={}", res.logs());
        for _ in 0..NUM_USERS {
            self.user_usdc.push(ata);
        }

        // Mint INITIAL_USDC_PER_USER * NUM_USERS into the shared ATA.
        let total_usdc = INITIAL_USDC_PER_USER * NUM_USERS as u64;
        let mint_ix = self.trident.mint_to(&ata, &usdc_mint, &admin_pk, total_usdc);
        let res = self
            .trident
            .process_transaction(&[mint_ix], Some("usdc_seed"));
        assert!(res.is_success(), "mint USDC failed: logs={}", res.logs());
        self.initial_total_usdc = total_usdc;

        // initialize_config
        let (config_pda, _) = Pubkey::find_program_address(
            &[meridian::state::Config::SEED],
            &meridian_program_id(),
        );
        self.config = config_pda;
        let init_cfg_ix = self.build_initialize_config_ix(config_pda);
        let res = self
            .trident
            .process_transaction(&[init_cfg_ix], Some("initialize_config"));
        assert!(
            res.is_success(),
            "initialize_config failed: logs={}",
            res.logs()
        );

        // Two markets with distinct strike prices and tickers.
        let market_specs: [([u8; 8], u64); NUM_MARKETS] = [
            (*b"META\0\0\0\0", 680_000_000),
            (*b"AAPL\0\0\0\0", 200_000_000),
        ];
        let expiry_unix: i64 = 2_000_000_000;
        let pyth_feed_id = [0u8; 32];

        for (ticker, strike) in market_specs.iter().copied() {
            let mctx = self.create_market(ticker, strike, expiry_unix, pyth_feed_id);
            self.markets.push(mctx);
        }

        // Create each user's Yes / No ATAs for each market. Same ATA per
        // user since all "users" are the admin keypair, but we compute
        // and create them per market.
        for m_idx in 0..NUM_MARKETS {
            let m = &mut self.markets[m_idx];
            for u_idx in 0..NUM_USERS {
                let user_pk = solana_sdk::signer::Signer::pubkey(&self.users[u_idx]);
                let yes_ata = self.trident.get_associated_token_address(
                    &m.yes_mint,
                    &user_pk,
                    &token_program_id(),
                );
                let no_ata = self.trident.get_associated_token_address(
                    &m.no_mint,
                    &user_pk,
                    &token_program_id(),
                );
                m.user_yes_ata[u_idx] = yes_ata;
                m.user_no_ata[u_idx] = no_ata;
            }
            // Create the ATAs only once (since all users share the admin key).
            let yes_ix = self.trident.initialize_associated_token_account(
                &admin_pk,
                &m.yes_mint,
                &admin_pk,
            );
            let no_ix = self.trident.initialize_associated_token_account(
                &admin_pk,
                &m.no_mint,
                &admin_pk,
            );
            let res = self
                .trident
                .process_transaction(&[yes_ix, no_ix], Some("yes_no_ata"));
            assert!(res.is_success(), "create yes/no ATA failed: logs={}", res.logs());
        }

        self.inited = true;
    }

    fn create_market(
        &mut self,
        ticker: [u8; 8],
        strike: u64,
        expiry_unix: i64,
        pyth_feed_id: [u8; 32],
    ) -> MarketCtx {
        let pid = meridian_program_id();
        let (market_pda, _) = Pubkey::find_program_address(
            &[
                meridian::state::Market::SEED_PREFIX,
                ticker.as_ref(),
                &strike.to_le_bytes(),
                &expiry_unix.to_le_bytes(),
            ],
            &pid,
        );
        let (book_pda, _) = Pubkey::find_program_address(
            &[meridian::state::Book::SEED_PREFIX, market_pda.as_ref()],
            &pid,
        );
        let (yes_mint_pda, _) =
            Pubkey::find_program_address(&[b"yes_mint", market_pda.as_ref()], &pid);
        let (no_mint_pda, _) =
            Pubkey::find_program_address(&[b"no_mint", market_pda.as_ref()], &pid);
        let (mint_auth_pda, _) = Pubkey::find_program_address(
            &[meridian::state::Market::MINT_AUTH_SEED_PREFIX, market_pda.as_ref()],
            &pid,
        );
        let (usdc_escrow_pda, _) = Pubkey::find_program_address(
            &[
                meridian::state::Market::USDC_ESCROW_SEED_PREFIX,
                market_pda.as_ref(),
            ],
            &pid,
        );
        let (yes_escrow_pda, _) = Pubkey::find_program_address(
            &[
                meridian::state::Market::YES_ESCROW_SEED_PREFIX,
                market_pda.as_ref(),
            ],
            &pid,
        );

        let admin_pk = solana_sdk::signer::Signer::pubkey(&self.admin);
        let ix = self.build_create_strike_market_ix(
            admin_pk,
            self.config,
            market_pda,
            book_pda,
            yes_mint_pda,
            no_mint_pda,
            mint_auth_pda,
            usdc_escrow_pda,
            yes_escrow_pda,
            self.usdc_mint,
            ticker,
            strike,
            expiry_unix,
            pyth_feed_id,
        );
        let res = self
            .trident
            .process_transaction(&[ix], Some("create_strike_market"));
        assert!(
            res.is_success(),
            "create_strike_market failed: logs={}",
            res.logs()
        );

        MarketCtx {
            market: market_pda,
            book: book_pda,
            yes_mint: yes_mint_pda,
            no_mint: no_mint_pda,
            mint_authority: mint_auth_pda,
            usdc_escrow: usdc_escrow_pda,
            yes_escrow: yes_escrow_pda,
            user_yes_ata: [Pubkey::default(); NUM_USERS],
            user_no_ata: [Pubkey::default(); NUM_USERS],
        }
    }

    // ===================================================================
    // Instruction builders
    // ===================================================================

    fn build_initialize_config_ix(&self, config: Pubkey) -> Instruction {
        let admin_pk = solana_sdk::signer::Signer::pubkey(&self.admin);
        // Anchor wire: discriminator || borsh(fee_authority: Pubkey, pyth_receiver: Pubkey)
        // pyth_receiver gained a second arg in 4785807 (Pyth Full-verification).
        // settle is out-of-scope for this harness, so any valid pubkey works;
        // use the program's own ID (the LiteSVM/test-fixture convention).
        let mut data = Vec::with_capacity(8 + 32 + 32);
        data.extend_from_slice(&anchor_disc("initialize_config"));
        data.extend_from_slice(admin_pk.as_ref());
        data.extend_from_slice(meridian_program_id().as_ref());
        Instruction {
            program_id: meridian_program_id(),
            accounts: vec![
                AccountMeta::new(admin_pk, true),                      // payer
                AccountMeta::new(config, false),                       // config
                AccountMeta::new_readonly(self.usdc_mint, false),      // usdc_mint
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn build_create_strike_market_ix(
        &self,
        admin: Pubkey,
        config: Pubkey,
        market: Pubkey,
        book: Pubkey,
        yes_mint: Pubkey,
        no_mint: Pubkey,
        mint_authority: Pubkey,
        usdc_escrow: Pubkey,
        yes_escrow: Pubkey,
        usdc_mint: Pubkey,
        ticker: [u8; 8],
        strike: u64,
        expiry_unix: i64,
        pyth_feed_id: [u8; 32],
    ) -> Instruction {
        // Args: CreateStrikeMarketArgs { ticker, strike_price, expiry_unix, pyth_feed_id }
        let mut data = Vec::with_capacity(8 + 8 + 8 + 8 + 32);
        data.extend_from_slice(&anchor_disc("create_strike_market"));
        data.extend_from_slice(&ticker);
        data.extend_from_slice(&strike.to_le_bytes());
        data.extend_from_slice(&expiry_unix.to_le_bytes());
        data.extend_from_slice(&pyth_feed_id);
        Instruction {
            program_id: meridian_program_id(),
            accounts: vec![
                AccountMeta::new(admin, true),
                AccountMeta::new_readonly(config, false),
                AccountMeta::new(market, false),
                AccountMeta::new(book, false),
                AccountMeta::new(yes_mint, false),
                AccountMeta::new(no_mint, false),
                AccountMeta::new_readonly(mint_authority, false),
                AccountMeta::new(usdc_escrow, false),
                AccountMeta::new(yes_escrow, false),
                AccountMeta::new_readonly(usdc_mint, false),
                AccountMeta::new_readonly(token_program_id(), false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
                AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
            ],
            data,
        }
    }

    fn do_mint_pair(&mut self, user_idx: usize, market_idx: usize, amount: u64) -> bool {
        let m = &self.markets[market_idx];
        let user_pk = solana_sdk::signer::Signer::pubkey(&self.users[user_idx]);
        let user_usdc = self.user_usdc[user_idx];
        let user_yes = m.user_yes_ata[user_idx];
        let user_no = m.user_no_ata[user_idx];
        let mut data = Vec::with_capacity(16);
        data.extend_from_slice(&anchor_disc("mint_pair"));
        data.extend_from_slice(&amount.to_le_bytes());
        let ix = Instruction {
            program_id: meridian_program_id(),
            accounts: vec![
                AccountMeta::new(user_pk, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(m.market, false),
                AccountMeta::new(user_usdc, false),
                AccountMeta::new(m.usdc_escrow, false),
                AccountMeta::new(m.yes_mint, false),
                AccountMeta::new(m.no_mint, false),
                AccountMeta::new(user_yes, false),
                AccountMeta::new(user_no, false),
                AccountMeta::new_readonly(m.mint_authority, false),
                AccountMeta::new_readonly(token_program_id(), false),
            ],
            data,
        };
        self.trident
            .process_transaction(&[ix], Some("mint_pair"))
            .is_success()
    }

    fn do_burn_pair(&mut self, user_idx: usize, market_idx: usize, amount: u64) -> bool {
        let m = &self.markets[market_idx];
        let user_pk = solana_sdk::signer::Signer::pubkey(&self.users[user_idx]);
        let user_usdc = self.user_usdc[user_idx];
        let user_yes = m.user_yes_ata[user_idx];
        let user_no = m.user_no_ata[user_idx];
        let mut data = Vec::with_capacity(16);
        data.extend_from_slice(&anchor_disc("burn_pair"));
        data.extend_from_slice(&amount.to_le_bytes());
        let ix = Instruction {
            program_id: meridian_program_id(),
            accounts: vec![
                AccountMeta::new(user_pk, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(m.market, false),
                AccountMeta::new(user_usdc, false),
                AccountMeta::new(m.usdc_escrow, false),
                AccountMeta::new(m.yes_mint, false),
                AccountMeta::new(m.no_mint, false),
                AccountMeta::new(user_yes, false),
                AccountMeta::new(user_no, false),
                AccountMeta::new_readonly(m.mint_authority, false),
                AccountMeta::new_readonly(token_program_id(), false),
            ],
            data,
        };
        self.trident
            .process_transaction(&[ix], Some("burn_pair"))
            .is_success()
    }

    fn do_place_limit(
        &mut self,
        user_idx: usize,
        market_idx: usize,
        side: u8,
        price: u64,
        qty: u64,
    ) -> bool {
        let m = &self.markets[market_idx];
        let user_pk = solana_sdk::signer::Signer::pubkey(&self.users[user_idx]);
        let user_usdc = self.user_usdc[user_idx];
        let user_yes = m.user_yes_ata[user_idx];
        let mut data = Vec::with_capacity(8 + 1 + 8 + 8);
        data.extend_from_slice(&anchor_disc("place_limit_order"));
        data.push(side);
        data.extend_from_slice(&price.to_le_bytes());
        data.extend_from_slice(&qty.to_le_bytes());
        let mut ix = Instruction {
            program_id: meridian_program_id(),
            accounts: vec![
                AccountMeta::new(user_pk, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(m.market, false),
                AccountMeta::new(m.book, false),
                AccountMeta::new(m.usdc_escrow, false),
                AccountMeta::new(m.yes_escrow, false),
                AccountMeta::new_readonly(m.yes_mint, false),
                AccountMeta::new(user_usdc, false),
                AccountMeta::new(user_yes, false),
                AccountMeta::new_readonly(m.mint_authority, false),
                AccountMeta::new_readonly(token_program_id(), false),
            ],
            data,
        };
        ix.accounts.extend(self.maker_remaining(market_idx));
        self.trident
            .process_transaction(&[ix], Some("place_limit_order"))
            .is_success()
    }

    fn do_place_market(
        &mut self,
        user_idx: usize,
        market_idx: usize,
        side: u8,
        qty: u64,
        slippage_bound: u64,
    ) -> bool {
        let m = &self.markets[market_idx];
        let user_pk = solana_sdk::signer::Signer::pubkey(&self.users[user_idx]);
        let user_usdc = self.user_usdc[user_idx];
        let user_yes = m.user_yes_ata[user_idx];
        let mut data = Vec::with_capacity(8 + 1 + 8 + 8);
        data.extend_from_slice(&anchor_disc("place_market_order"));
        data.push(side);
        data.extend_from_slice(&qty.to_le_bytes());
        data.extend_from_slice(&slippage_bound.to_le_bytes());
        let mut ix = Instruction {
            program_id: meridian_program_id(),
            accounts: vec![
                AccountMeta::new(user_pk, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(m.market, false),
                AccountMeta::new(m.book, false),
                AccountMeta::new(m.usdc_escrow, false),
                AccountMeta::new(m.yes_escrow, false),
                AccountMeta::new_readonly(m.yes_mint, false),
                AccountMeta::new(user_usdc, false),
                AccountMeta::new(user_yes, false),
                AccountMeta::new_readonly(m.mint_authority, false),
                AccountMeta::new_readonly(token_program_id(), false),
            ],
            data,
        };
        ix.accounts.extend(self.maker_remaining(market_idx));
        self.trident
            .process_transaction(&[ix], Some("place_market_order"))
            .is_success()
    }

    fn do_cancel(
        &mut self,
        user_idx: usize,
        market_idx: usize,
        side: u8,
        price: u64,
        seq: u64,
    ) -> bool {
        let m = &self.markets[market_idx];
        let user_pk = solana_sdk::signer::Signer::pubkey(&self.users[user_idx]);
        let user_usdc = self.user_usdc[user_idx];
        let user_yes = m.user_yes_ata[user_idx];
        let mut data = Vec::with_capacity(8 + 1 + 8 + 8);
        data.extend_from_slice(&anchor_disc("cancel_order"));
        data.push(side);
        data.extend_from_slice(&price.to_le_bytes());
        data.extend_from_slice(&seq.to_le_bytes());
        let ix = Instruction {
            program_id: meridian_program_id(),
            accounts: vec![
                AccountMeta::new(user_pk, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(m.market, false),
                AccountMeta::new(m.book, false),
                AccountMeta::new(m.usdc_escrow, false),
                AccountMeta::new(m.yes_escrow, false),
                AccountMeta::new_readonly(m.yes_mint, false),
                AccountMeta::new(user_usdc, false),
                AccountMeta::new(user_yes, false),
                AccountMeta::new_readonly(m.mint_authority, false),
                AccountMeta::new_readonly(token_program_id(), false),
            ],
            data,
        };
        self.trident
            .process_transaction(&[ix], Some("cancel_order"))
            .is_success()
    }

    fn do_buy_no(
        &mut self,
        user_idx: usize,
        market_idx: usize,
        amount: u64,
        min_yes_sell_price: u64,
    ) -> bool {
        let m = &self.markets[market_idx];
        let user_pk = solana_sdk::signer::Signer::pubkey(&self.users[user_idx]);
        let user_usdc = self.user_usdc[user_idx];
        let user_yes = m.user_yes_ata[user_idx];
        let user_no = m.user_no_ata[user_idx];
        let mut data = Vec::with_capacity(8 + 8 + 8);
        data.extend_from_slice(&anchor_disc("buy_no"));
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&min_yes_sell_price.to_le_bytes());
        let mut ix = Instruction {
            program_id: meridian_program_id(),
            accounts: vec![
                AccountMeta::new(user_pk, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(m.market, false),
                AccountMeta::new(m.book, false),
                AccountMeta::new(m.usdc_escrow, false),
                AccountMeta::new(m.yes_escrow, false),
                AccountMeta::new(m.yes_mint, false),
                AccountMeta::new(m.no_mint, false),
                AccountMeta::new(user_usdc, false),
                AccountMeta::new(user_yes, false),
                AccountMeta::new(user_no, false),
                AccountMeta::new_readonly(m.mint_authority, false),
                AccountMeta::new_readonly(token_program_id(), false),
            ],
            data,
        };
        ix.accounts.extend(self.maker_remaining(market_idx));
        self.trident
            .process_transaction(&[ix], Some("buy_no"))
            .is_success()
    }

    fn do_sell_no(
        &mut self,
        user_idx: usize,
        market_idx: usize,
        amount: u64,
        max_yes_buy_price: u64,
    ) -> bool {
        let m = &self.markets[market_idx];
        let user_pk = solana_sdk::signer::Signer::pubkey(&self.users[user_idx]);
        let user_usdc = self.user_usdc[user_idx];
        let user_yes = m.user_yes_ata[user_idx];
        let user_no = m.user_no_ata[user_idx];
        let mut data = Vec::with_capacity(8 + 8 + 8);
        data.extend_from_slice(&anchor_disc("sell_no"));
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&max_yes_buy_price.to_le_bytes());
        let mut ix = Instruction {
            program_id: meridian_program_id(),
            accounts: vec![
                AccountMeta::new(user_pk, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(m.market, false),
                AccountMeta::new(m.book, false),
                AccountMeta::new(m.usdc_escrow, false),
                AccountMeta::new(m.yes_escrow, false),
                AccountMeta::new(m.yes_mint, false),
                AccountMeta::new(m.no_mint, false),
                AccountMeta::new(user_usdc, false),
                AccountMeta::new(user_yes, false),
                AccountMeta::new(user_no, false),
                AccountMeta::new_readonly(m.mint_authority, false),
                AccountMeta::new_readonly(token_program_id(), false),
            ],
            data,
        };
        ix.accounts.extend(self.maker_remaining(market_idx));
        self.trident
            .process_transaction(&[ix], Some("sell_no"))
            .is_success()
    }

    // ===================================================================
    // Invariants
    // ===================================================================

    fn assert_all_invariants(&mut self) {
        for m_idx in 0..self.markets.len() {
            self.assert_market_invariants(m_idx);
        }
        // Token conservation: USDC across all known accounts equals
        // initial seed. All user USDC ATAs are the same address (since
        // users share a key), so we deduplicate via collection-into-set.
        let mut seen_usdc = std::collections::HashSet::new();
        let mut sum: u128 = 0;
        for ata in &self.user_usdc {
            seen_usdc.insert(*ata);
        }
        for m in &self.markets {
            seen_usdc.insert(m.usdc_escrow);
        }
        for addr in &seen_usdc {
            let acct = self.trident.get_account(addr);
            if acct.data().len() < spl_token_interface::state::Account::LEN {
                continue;
            }
            if let Ok(state) = spl_token_interface::state::Account::unpack(
                &acct.data()[..spl_token_interface::state::Account::LEN],
            ) {
                sum = sum.checked_add(state.amount as u128).expect("USDC sum overflow");
            }
        }
        assert_eq!(
            sum as u64, self.initial_total_usdc,
            "USDC conservation violated: observed {}, expected {}",
            sum, self.initial_total_usdc,
        );
    }

    fn assert_market_invariants(&mut self, market_idx: usize) {
        let (yes_mint, no_mint, usdc_escrow, yes_escrow, book) = {
            let m = &self.markets[market_idx];
            (m.yes_mint, m.no_mint, m.usdc_escrow, m.yes_escrow, m.book)
        };

        // R14: Yes mint supply == No mint supply.
        let yes_supply = self.read_mint_supply(&yes_mint);
        let no_supply = self.read_mint_supply(&no_mint);
        assert_eq!(
            yes_supply, no_supply,
            "R14 violated for market {}: yes_supply={} no_supply={}",
            market_idx, yes_supply, no_supply,
        );

        // R13: book-side open notional == escrow balances.
        let resting = self.read_book_raw(&book);
        let open_bid_notional: u128 = resting
            .bids
            .iter()
            .map(|e| (e.qty as u128) * (e.price as u128))
            .sum();
        let open_ask_qty: u128 = resting.asks.iter().map(|e| e.qty as u128).sum();
        let usdc_in_escrow = self.read_token_balance(&usdc_escrow) as u128;
        let yes_in_escrow = self.read_token_balance(&yes_escrow) as u128;
        assert_eq!(
            usdc_in_escrow, open_bid_notional,
            "R13 USDC-escrow violated for market {}: escrow={} sum(bid.qty*price)={}",
            market_idx, usdc_in_escrow, open_bid_notional,
        );
        assert_eq!(
            yes_in_escrow, open_ask_qty,
            "R13 Yes-escrow violated for market {}: escrow={} sum(ask.qty)={}",
            market_idx, yes_in_escrow, open_ask_qty,
        );
    }

    // ===================================================================
    // Account-data readers
    // ===================================================================

    fn read_mint_supply(&mut self, mint: &Pubkey) -> u64 {
        let acct = self.trident.get_account(mint);
        if acct.data().len() < spl_token_interface::state::Mint::LEN {
            return 0;
        }
        let state = spl_token_interface::state::Mint::unpack(
            &acct.data()[..spl_token_interface::state::Mint::LEN],
        )
        .expect("unpack mint");
        state.supply
    }

    fn read_token_balance(&mut self, account: &Pubkey) -> u64 {
        let acct = self.trident.get_account(account);
        if acct.data().len() < spl_token_interface::state::Account::LEN {
            return 0;
        }
        let state = spl_token_interface::state::Account::unpack(
            &acct.data()[..spl_token_interface::state::Account::LEN],
        )
        .expect("unpack token account");
        state.amount
    }

    fn read_resting(&mut self, market_idx: usize) -> RestingState {
        let book = self.markets[market_idx].book;
        self.read_book_raw(&book)
    }

    // -------------------------------------------------------------------
    // Liveness helpers — keep flows inside the feasible region so the
    // matching / fund-movement paths actually execute (rather than
    // bouncing off insufficient-funds / empty-book reverts).
    // -------------------------------------------------------------------

    fn usdc_bal(&mut self, user_idx: usize) -> u64 {
        let a = self.user_usdc[user_idx];
        self.read_token_balance(&a)
    }

    fn yes_bal(&mut self, user_idx: usize, market_idx: usize) -> u64 {
        let a = self.markets[market_idx].user_yes_ata[user_idx];
        self.read_token_balance(&a)
    }

    fn no_bal(&mut self, user_idx: usize, market_idx: usize) -> u64 {
        let a = self.markets[market_idx].user_no_ata[user_idx];
        self.read_token_balance(&a)
    }

    /// Ensure the user holds at least `want` Yes (and, since mint_pair is a
    /// pair mint, at least `want` No too) in this market. Mints a pair if
    /// short, clamped to a quarter of the shared bankroll. Returns the
    /// resulting Yes balance.
    fn ensure_yes(&mut self, user_idx: usize, market_idx: usize, want: u64) -> u64 {
        let have = self.yes_bal(user_idx, market_idx);
        if have >= want {
            return have;
        }
        let need = want - have;
        let usdc = self.usdc_bal(user_idx);
        let mint_amt = need.min((usdc / 4).max(1));
        if mint_amt > 0 && usdc >= mint_amt {
            let _ = self.do_mint_pair(user_idx, market_idx, mint_amt);
        }
        self.yes_bal(user_idx, market_idx)
    }

    /// Total resting qty on a side of the book.
    fn side_qty(&mut self, market_idx: usize, bids: bool) -> u64 {
        let r = self.read_resting(market_idx);
        let entries = if bids { r.bids } else { r.asks };
        entries.iter().map(|e| e.qty).fold(0u64, |a, e| a.saturating_add(e))
    }

    /// Seed a resting bid (buy Yes) at `MID_PRICE` so a later Ask-side
    /// taker (e.g. `buy_no`) has something to cross. Affordable-guarded.
    fn seed_bid(&mut self, user_idx: usize, market_idx: usize, qty: u64) -> bool {
        if qty == 0 {
            return false;
        }
        let usdc = self.usdc_bal(user_idx);
        let lock = qty.saturating_mul(MID_PRICE);
        if lock == 0 || lock > usdc / 2 {
            return false;
        }
        self.do_place_limit(user_idx, market_idx, 0, MID_PRICE, qty)
    }

    /// Seed a resting ask (sell Yes) at `MID_PRICE` so a later Bid-side
    /// taker (e.g. `sell_no`) has something to cross. Mints Yes first.
    fn seed_ask(&mut self, user_idx: usize, market_idx: usize, qty: u64) -> bool {
        if qty == 0 {
            return false;
        }
        if self.ensure_yes(user_idx, market_idx, qty) < qty {
            return false;
        }
        self.do_place_limit(user_idx, market_idx, 1, MID_PRICE, qty)
    }

    /// Maker payout accounts for fills. Every maker is the admin keypair,
    /// so each fill pays the admin's USDC + this market's Yes ATA. We
    /// supply `MAX_FILLS_PER_TX` writable pairs; `place_order_inner` reads
    /// only `0..fill_count` and ignores the rest. Appending these to any
    /// order that might cross is what lets fills actually settle — without
    /// them every crossing order reverts on the first fill.
    ///
    /// Roughly 1 in 7 calls, we deliberately corrupt the FIRST pair by
    /// swapping the USDC/Yes slots, so the USDC slot carries the Yes mint.
    /// That fails the `usdc_ok` mint check (place_limit_order.rs:410) and
    /// drives the ATA-close skip-and-continue branch (line 415): the taker
    /// treats the first fill as un-payable, folds its qty into the residual,
    /// and re-inserts the skipped maker with a fresh seq. Slot 0 is the one
    /// read whenever any crossing happens (fill_count >= 1), so corrupting
    /// it reliably exercises the skip path. This is the reworked P1
    /// fund-movement code; fuzzing it under random sequences is the point of
    /// the U9 gate, and the R13/R14/conservation asserts catch any escrow
    /// mis-accounting in the skip + re-insert + residual-fold logic.
    fn maker_remaining(&mut self, market_idx: usize) -> Vec<AccountMeta> {
        let maker_usdc = self.user_usdc[0];
        let maker_yes = self.markets[market_idx].user_yes_ata[0];
        let corrupt_first = self.trident.random_from_range(0u64..7) == 0;
        let mut metas = Vec::with_capacity(MAX_FILLS_PER_TX * 2);
        for i in 0..MAX_FILLS_PER_TX {
            if corrupt_first && i == 0 {
                // USDC slot now holds a Yes-mint account → usdc_ok == false → skip.
                metas.push(AccountMeta::new(maker_yes, false));
                metas.push(AccountMeta::new(maker_usdc, false));
            } else {
                metas.push(AccountMeta::new(maker_usdc, false));
                metas.push(AccountMeta::new(maker_yes, false));
            }
        }
        metas
    }

    /// Parse the zero-copy `Book` account by raw bytes — we can't borsh-
    /// deserialize because the generated types.rs `Book` referenced an
    /// inaccessible path. The layout is hand-verified above with
    /// `BOOK_DATA_SIZE` / `BOOK_SIDE_SIZE` / `ORDER_ENTRY_SIZE` consts.
    fn read_book_raw(&mut self, book: &Pubkey) -> RestingState {
        let acct = self.trident.get_account(book);
        let data = acct.data();
        if data.len() < ANCHOR_DISCRIMINATOR + BOOK_DATA_SIZE {
            return RestingState::default();
        }
        let body = &data[ANCHOR_DISCRIMINATOR..ANCHOR_DISCRIMINATOR + BOOK_DATA_SIZE];
        // body layout: market(32) | bids(1800) | asks(1800) | next_seq(8)
        let bids_start = 32usize;
        let asks_start = 32 + BOOK_SIDE_SIZE;
        let bids = parse_side(&body[bids_start..bids_start + BOOK_SIDE_SIZE]);
        let asks = parse_side(&body[asks_start..asks_start + BOOK_SIDE_SIZE]);
        RestingState { bids, asks }
    }
}

#[derive(Default, Debug)]
struct RestingState {
    bids: Vec<RestingEntry>,
    asks: Vec<RestingEntry>,
}

#[derive(Clone, Copy, Debug)]
struct RestingEntry {
    price: u64,
    seq: u64,
    owner: [u8; 32],
    qty: u64,
}

fn parse_side(slice: &[u8]) -> Vec<RestingEntry> {
    // BookSide<32>: u64 len + [OrderEntry; 32]. OrderEntry layout:
    //   OrderKey { price: u64, seq: u64 } | owner: [u8;32] | qty: u64.
    let len = u64::from_le_bytes(slice[0..8].try_into().unwrap()) as usize;
    let entries_start = 8usize;
    let mut out = Vec::with_capacity(len.min(BOOK_DEPTH));
    for i in 0..len.min(BOOK_DEPTH) {
        let off = entries_start + i * ORDER_ENTRY_SIZE;
        let price = u64::from_le_bytes(slice[off..off + 8].try_into().unwrap());
        let seq = u64::from_le_bytes(slice[off + 8..off + 16].try_into().unwrap());
        let mut owner = [0u8; 32];
        owner.copy_from_slice(&slice[off + 16..off + 48]);
        let qty = u64::from_le_bytes(slice[off + 48..off + 56].try_into().unwrap());
        out.push(RestingEntry { price, seq, owner, qty });
    }
    out
}

/// Anchor wire discriminator: first 8 bytes of sha256("global:<method>").
fn anchor_disc(method: &str) -> [u8; 8] {
    let preimage = format!("global:{method}");
    let hash = sha2::Sha256::digest(preimage.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&hash[..8]);
    out
}

// Unused trident-generated import suppression — we hand-build instructions
// because the meridian crate gives us the seed constants directly. The
// generated `meridian::*` types stay as documentation of the wire shape.
#[allow(dead_code)]
fn _types_kept_live() {
    let _ = std::marker::PhantomData::<crate::types::meridian::MintPairInstruction>;
    let _ = <meridian::state::Config as Discriminator>::DISCRIMINATOR;
}

fn main() {
    // Default: 1_000 iterations * 50 flow calls = 50_000 randomized
    // instructions. Each flow runs invariant checks (R13/R14/conservation)
    // immediately after the call, so violations surface fast.
    //
    // CI runs `cases >= 100_000` per plan §U9 verification:
    //   FuzzTest::fuzz(2_000, 50)   # 100_000 ops total
    //
    // Override at runtime by editing this `fuzz(...)` call; Trident v0.12
    // does not expose `--cases` as a CLI flag (run -h shows TARGET + SEED
    // only). The plan's `--cases 100000` syntax is aspirational for a
    // future Trident release — for now CI bumps the literals here.
    let iterations: u64 = std::env::var("TRIDENT_ITERATIONS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1_000);
    let flow_calls: u64 = std::env::var("TRIDENT_FLOW_CALLS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50);
    FuzzTest::fuzz(iterations, flow_calls);
}
