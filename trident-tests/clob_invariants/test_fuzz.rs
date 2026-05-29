//! Trident multi-instruction fuzz harness for the Meridian on-chain CLOB.
//!
//! Flows: randomized sequences of `mint_pair`, `burn_pair`,
//! `place_limit_order`, `place_market_order`, `cancel_order`, `buy_no`,
//! `sell_no`, plus two CONTROLLED probes (`flow_skip_probe`,
//! `flow_sweep_convergence`) described below.
//!
//! ## Program ABI this harness targets (1-account canonical-ATA, U1–U5)
//!
//! `place_limit_order` / `place_market_order` / `buy_no` / `sell_no` consume
//! **ONE** `remaining_accounts` entry per fill: the maker's CANONICAL
//! associated token account for the payout mint, in fill order. The payout
//! mint is fixed by the taker's side for the whole order:
//!
//!   * Bid taker (hits a resting ask) pays the maker USDC → canonical USDC ATA.
//!   * Ask taker (hits a resting bid) pays the maker Yes  → canonical Yes  ATA.
//!
//! The program requires `remaining.len() >= fill_count` and binds each slot to
//! `get_associated_token_address(maker_owner, payout_mint)`:
//!   * key ≠ canonical ATA → REVERT (`BadMakerAccount`). A non-canonical
//!     account is a malformed call; the taker can no longer force an honest
//!     maker into the skip path.
//!   * key = canonical ATA but un-receivable (closed / frozen / uninitialized
//!     / not SPL-owned) → SKIP the fill and restore the maker's resting order.
//!   * key = canonical ATA and receivable → pay.
//!
//! `settle_sweep` consumes ONE recipient `AccountMeta` per POP ATTEMPT (one
//! per entry dequeued this call, whether or not its refund lands), in pop
//! order (bids first, then asks). Bid pops refund the owner's canonical USDC
//! ATA, ask pops refund the owner's canonical Yes ATA. A non-canonical or
//! un-receivable recipient is SKIPPED (not reverted, because the cranker is an
//! untrusted public actor) and re-inserted at a FRESH seq.
//!
//! ## Invariants (asserted after each relevant flow step)
//!
//!   * **R13 — escrow reconciliation:** for every market,
//!     `usdc_escrow == sum(open_bid.qty * open_bid.price)` AND
//!     `yes_escrow == sum(open_ask.qty)`. Plus token conservation:
//!     `sum(USDC across all user ATAs + escrows) == initial total seeded`.
//!   * **R14 — pair supply:** `yes_mint.supply == no_mint.supply`.
//!   * **No book-entry duplication (`flow_skip_probe`):** across a
//!     skip-inducing fill — INCLUDING a partial-fill skip — the opposing
//!     side's entry count must NOT increase (one logical maker order stays
//!     one entry). This exercises the now-FIXED finding #2 (a skipped partial
//!     restores qty into the existing remnant rather than inserting a
//!     duplicate).
//!   * **Sweep convergence (`flow_sweep_convergence`):** a settled book drains
//!     to EMPTY under repeated `settle_sweep` cranks even when some recipients
//!     are FROZEN (skipped entries re-insert at a fresh seq and drain on a
//!     later crank once unfrozen; the crank never wedges). Forward progress is
//!     asserted on every call. This exercises the now-FIXED finding #4
//!     (fresh-seq re-insert prevents the skipped-order throttle/wedge).
//!
//! ## Skip-path coverage: freeze the CANONICAL account, never substitute
//!
//! Under the 1-account canonical-ATA ABI a SUBSTITUTED (non-canonical) account
//! now REVERTS (`BadMakerAccount`). The only way to drive the skip-and-continue
//! branch is to make the maker's CANONICAL ATA un-receivable. `flow_skip_probe`
//! does that by FREEZING the maker's canonical payout ATA — flipping the SPL
//! account-state byte at offset 108 to Frozen (2) via `set_account_custom` —
//! which trips the program's `token_account_receivable` pre-CPI gate. It
//! self-checks that the freeze persisted and that the skip actually fired, so
//! the no-dup assertion is never vacuous.
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

/// Mirror of `place_limit_order::MAX_FILLS_PER_TX`: a taker walks at most this
/// many opposing entries per tx. Under the 1-account canonical-ATA ABI,
/// `place_order_inner` reads ONE maker payout account per fill from
/// `remaining_accounts[i]` (the maker's canonical ATA for the payout mint).
/// Every "user" here is the admin keypair, so every maker's canonical payout
/// ATA is the admin's canonical USDC ATA (Bid taker) or this market's admin
/// canonical Yes ATA (Ask taker). We supply MAX_FILLS_PER_TX canonical payout
/// ATAs for the taker's side and the handler reads only `0..fill_count`.
const MAX_FILLS_PER_TX: usize = 4;

/// Mirror of `settle_sweep::MAX_SWEEP_PER_TX`.
const MAX_SWEEP_PER_TX: usize = 8;

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
    /// Set once the sweep-convergence probe has run this iteration (it settles
    /// a dedicated market, which is one-way, so it runs at most once).
    sweep_probe_done: bool,
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
            sweep_probe_done: false,
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
        self.sweep_probe_done = false;
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

    /// Skip-path probe — no-book-entry-duplication invariant (finding #2 guard).
    ///
    /// Under the 1-account canonical-ATA ABI the ONLY way a taker can reach the
    /// maker-payout skip-and-continue branch is for the maker's CANONICAL payout
    /// ATA to be un-receivable (a SUBSTITUTED non-canonical account now REVERTS
    /// with `BadMakerAccount`). This probe drives that branch by FREEZING the
    /// maker's canonical USDC ATA (the Bid-taker payout mint) — flipping the SPL
    /// account-state byte at offset 108 to Frozen (2) — so the program's
    /// `token_account_receivable` pre-CPI gate fails and the fill is skipped and
    /// the maker order restored.
    ///
    /// It exercises BOTH skip shapes, chosen randomly:
    ///   * FULL-fill skip: taker consumes the maker's whole resting ask. The
    ///     popped maker is re-inserted at a fresh seq — exactly ONE entry back.
    ///   * PARTIAL-fill skip: taker consumes only PART of the maker's ask. The
    ///     now-FIXED finding #2 means the unpaid qty folds back into the
    ///     existing remnant (no duplicate entry); the remnant stays one entry.
    ///
    /// The no-dup invariant is the same for both: the opposing (ask) side's
    /// entry count must NOT increase across the skip-inducing fill. The probe
    /// self-checks that the freeze persisted AND that the skip fired (the
    /// maker's ask survives), so the assertion is non-vacuous. Finally it thaws
    /// the ATA so later flows can pay normally.
    #[flow]
    fn flow_skip_probe(&mut self) {
        if !self.inited {
            return;
        }
        let market_idx = self.trident.random_from_range(0..NUM_MARKETS);
        // Maker = user 0 (all users share the admin key; the maker's canonical
        // USDC/Yes ATAs are user 0's canonical ATAs). Seed an exact resting ask
        // of `qty` Yes from the maker at MID_PRICE.
        let maker = 0usize;
        let qty: u64 = self.trident.random_from_range(2u64..1_000);
        if self.ensure_yes(maker, market_idx, qty) < qty {
            return;
        }
        if !self.do_place_limit(maker, market_idx, 1, MID_PRICE, qty) {
            return;
        }

        // Confirm the maker's MID/qty ask actually rested (it could have crossed
        // an existing resting bid on placement). Snapshot the ask side BEFORE
        // the crossing taker. A correct skip — full OR partial — leaves the ask
        // COUNT unchanged.
        let asks_before = self.read_resting(market_idx).asks.len();
        let matching_before = self
            .read_resting(market_idx)
            .asks
            .iter()
            .filter(|e| e.price == MID_PRICE && e.qty == qty)
            .count();
        if matching_before == 0 {
            return;
        }

        // A Bid taker hitting a resting ask pays the maker USDC (program:
        // `Side::Bid => USDC escrow -> maker canonical USDC ATA`), so the maker's
        // canonical USDC ATA is the receivable gate. Freeze it to fail
        // `token_account_receivable` and trip the skip branch — this is the
        // canonical account the program will derive, NOT a substitute.
        let maker_usdc = self.user_usdc[maker];
        self.set_token_frozen(&maker_usdc, true);
        // Self-check: confirm the freeze persisted to the SVM (guards against a
        // silent no-op that would make the no-dup assertion vacuous).
        assert!(
            self.is_token_frozen(&maker_usdc),
            "skip-probe setup error: maker USDC ATA did not freeze",
        );

        // Randomly choose FULL or PARTIAL consumption of the maker's ask. The
        // taker bids at 2*MID so it crosses every resting ask priced <= that
        // (all owned by the frozen maker → all skipped). For FULL we size the
        // taker to the total crossable qty; for PARTIAL we take a strict
        // fraction (>=1, < qty) so the maker's remnant stays resting and the
        // skip restores into it (finding #2 path).
        let taker = self.trident.random_from_range(0..NUM_USERS);
        let price = MID_PRICE * 2;
        let crossable_qty: u64 = crossable_ask_qty(&self.read_resting(market_idx), price);
        if crossable_qty == 0 {
            self.set_token_frozen(&maker_usdc, false);
            return;
        }
        let partial = self.trident.random_bool();
        let taker_qty = if partial {
            // Strictly less than the front ask's qty so that ask partially
            // fills (the front is the maker order we seeded at MID, qty `qty`).
            // 1..qty (qty >= 2 by construction above).
            self.trident.random_from_range(1u64..qty)
        } else {
            crossable_qty
        };
        if taker_qty == 0 {
            self.set_token_frozen(&maker_usdc, false);
            return;
        }
        // Cap the taker lock to the bankroll; bail if unaffordable (rare).
        if self.usdc_bal(taker) < taker_qty.saturating_mul(price) {
            self.set_token_frozen(&maker_usdc, false);
            return;
        }
        let _ = self.do_place_limit(taker, market_idx, 0, price, taker_qty);

        // Thaw so subsequent flows can pay this maker normally.
        self.set_token_frozen(&maker_usdc, false);

        // The fill was un-payable (frozen maker USDC), so the program SKIPS it.
        // Verify the skip fired so the no-dup assertion is non-vacuous: the
        // maker's ask must still be present on the ask side.
        let after = self.read_resting(market_idx);
        let matching_after = after
            .asks
            .iter()
            .filter(|e| e.price == MID_PRICE)
            .filter(|e| {
                // Full skip: a fresh-seq re-insert of the whole `qty`. Partial
                // skip: the remnant carries (qty - taker_qty) + restored unpaid.
                // Either way the maker's order persists at the MID price level.
                e.owner == solana_sdk::signer::Signer::pubkey(&self.users[maker]).to_bytes()
            })
            .count();
        assert!(
            matching_after >= 1,
            "skip-probe: expected the frozen maker's ask to survive the skip \
             (market {}, qty {}, partial={}), but it vanished — fill was not skipped",
            market_idx, qty, partial,
        );

        // No-dup invariant (finding #2 guard): the skip + restore must NOT
        // duplicate the maker's book entry. Across a skip-inducing fill —
        // full OR partial — the ask side's TOTAL entry count must not increase.
        // (A correct full skip pops one and re-inserts one: net zero. A correct
        // partial skip leaves the single remnant in place and folds the unpaid
        // qty back into it: net zero. A duplicate-entry regression would grow
        // the count.)
        assert!(
            after.asks.len() <= asks_before,
            "no-dup violated (market {}, partial={}): ask-side entries grew {} -> {} \
             across a skip-inducing fill",
            market_idx, partial, asks_before, after.asks.len(),
        );

        self.assert_all_invariants();
    }

    /// Sweep-convergence probe (finding #4 throttle/wedge guard).
    ///
    /// A settled book must drain to EMPTY under repeated `settle_sweep` calls
    /// EVEN WHEN some refund recipients are temporarily un-receivable. This
    /// probe stands up a DEDICATED market (so settling it doesn't freeze the
    /// two shared trading markets), seeds resting orders on both sides, FREEZES
    /// the bid owner's canonical USDC ATA so the first sweep crank must SKIP and
    /// re-insert those bids at a fresh seq, settles the market via a forged Pyth
    /// `PriceUpdateV2`, then cranks `settle_sweep` (8 orders/call). It asserts:
    ///   * forward progress on EVERY non-trivial call (the book strictly shrinks
    ///     OR a frozen recipient blocks only its own entries — never wedges the
    ///     whole crank), and
    ///   * once the frozen ATA is thawed mid-loop, the previously-skipped bids
    ///     drain and the book reaches EMPTY within a bounded number of calls.
    ///
    /// This is the finding #4 fix in action: skipped entries re-insert at a
    /// FRESH seq (back of the level), so they don't pin the front and burn the
    /// per-call attempt budget on every crank — the asks behind them still drain.
    ///
    /// Runs at most once per iteration (settling is one-way). The dedicated
    /// market's expiry is short so it expires soon; the warp lands far below the
    /// shared trading markets' expiry, so they stay tradeable.
    #[flow]
    fn flow_sweep_convergence(&mut self) {
        if !self.inited || self.sweep_probe_done {
            return;
        }
        self.sweep_probe_done = true;

        let admin_pk = solana_sdk::signer::Signer::pubkey(&self.admin);
        let now = self.trident.get_current_timestamp();
        // Dedicated market with a short horizon: tradeable now, expirable soon.
        let expiry: i64 = now + 1_000;
        let ticker = *b"SWEEP\0\0\0";
        let strike: u64 = 500_000_000;
        let feed_id = [0u8; 32];
        let mut m = self.create_market(ticker, strike, expiry, feed_id);
        // Record + create the dedicated market's Yes/No ATAs (owner = admin).
        // place_limit_order validates user_yes (token::mint = yes_mint), so a
        // default pubkey there fails — we must derive and create them.
        for u_idx in 0..NUM_USERS {
            let user_pk = solana_sdk::signer::Signer::pubkey(&self.users[u_idx]);
            m.user_yes_ata[u_idx] =
                self.trident.get_associated_token_address(&m.yes_mint, &user_pk, &token_program_id());
            m.user_no_ata[u_idx] =
                self.trident.get_associated_token_address(&m.no_mint, &user_pk, &token_program_id());
        }
        let yes_ix = self.trident.initialize_associated_token_account(&admin_pk, &m.yes_mint, &admin_pk);
        let no_ix = self.trident.initialize_associated_token_account(&admin_pk, &m.no_mint, &admin_pk);
        let res = self.trident.process_transaction(&[yes_ix, no_ix], Some("sweep_yes_no_ata"));
        if !res.is_success() {
            return;
        }
        let m_idx = self.markets.len();
        self.markets.push(m);

        // Seed resting orders on both sides (no crossing: bids strictly below
        // asks). Enough each side that the crank needs multiple calls (cap 8).
        let n_bids = 5u64;
        let n_asks = 6u64;
        for _ in 0..n_bids {
            let _ = self.do_place_limit(0, m_idx, 0, MID_PRICE, 3);
        }
        let _ = self.ensure_yes(0, m_idx, n_asks * 3);
        for _ in 0..n_asks {
            let _ = self.do_place_limit(0, m_idx, 1, MID_PRICE * 3, 3);
        }

        let resting = self.read_resting(m_idx);
        let total_resting = resting.bids.len() + resting.asks.len();
        if total_resting == 0 {
            self.assert_all_invariants();
            return;
        }

        // Warp just past expiry so settle is allowed; stays << trading expiry.
        self.trident.warp_to_timestamp(expiry + 2);

        // Forge and plant a Full-verified PriceUpdateV2 owned by the program
        // (config.pyth_receiver == meridian program id in bootstrap).
        let price_update = solana_sdk::signature::Keypair::new();
        let price_update_pk = solana_sdk::signer::Signer::pubkey(&price_update);
        self.plant_price_update(&price_update_pk, feed_id, expiry + 1);

        // Settle the dedicated market.
        let settle_ix = self.build_settle_market_ix(m_idx, price_update_pk);
        let res = self.trident.process_transaction(&[settle_ix], Some("settle_market"));
        assert!(
            res.is_success(),
            "settle_market failed for sweep probe: logs={}",
            res.logs()
        );

        // FREEZE the bid owner's canonical USDC ATA so the FIRST sweep crank
        // must skip the bids (un-receivable) and re-insert them at a fresh seq.
        // This exercises finding #4's fix: the skipped bids go to the BACK and
        // don't wedge the crank — the asks behind them still drain. We thaw
        // partway through so the bids eventually drain and the book empties.
        let maker_usdc = self.user_usdc[0];
        self.set_token_frozen(&maker_usdc, true);
        assert!(
            self.is_token_frozen(&maker_usdc),
            "sweep-probe setup error: bid-owner USDC ATA did not freeze",
        );

        // Crank settle_sweep until the book is empty. Bound generously; a
        // wedge/throttle regression (no forward progress) trips the bound.
        // Forward-progress rule per call: EITHER the total entry count strictly
        // drops, OR (while frozen) only the un-refundable bids remain and the
        // asks have all drained — i.e. the crank never gets permanently stuck.
        let max_calls = (total_resting as u64 + 8).max(8);
        let mut calls = 0u64;
        let mut thawed = false;
        loop {
            let r = self.read_resting(m_idx);
            if r.bids.is_empty() && r.asks.is_empty() {
                break;
            }
            assert!(
                calls < max_calls,
                "sweep convergence FAILED (market {}): book not empty after {} crank calls \
                 (bids={}, asks={}, thawed={})",
                m_idx, calls, r.bids.len(), r.asks.len(), thawed,
            );
            // Thaw once the asks have fully drained and only the (frozen) bids
            // remain — this proves the asks drained THROUGH the skipped bids
            // (no wedge), then lets the bids drain on the next crank.
            if !thawed && r.asks.is_empty() {
                self.set_token_frozen(&maker_usdc, false);
                thawed = true;
            }
            let before = r.bids.len() + r.asks.len();
            let sweep_ix = self.build_settle_sweep_ix(m_idx, &r);
            let res = self.trident.process_transaction(&[sweep_ix], Some("settle_sweep"));
            assert!(
                res.is_success(),
                "settle_sweep crank failed (market {}): logs={}",
                m_idx, res.logs()
            );
            let after_r = self.read_resting(m_idx);
            let after = after_r.bids.len() + after_r.asks.len();
            // Forward progress: while still frozen the bids can't drain, but the
            // crank must still make progress on the asks until none remain. Once
            // only the frozen bids are left (asks empty), a frozen crank legally
            // makes zero net progress (it pops, skips, re-inserts) — we thaw
            // above before that crank, so `after < before` must hold every call.
            assert!(
                after < before,
                "sweep made NO progress (market {}): {} -> {} entries (wedge/throttle \
                 regression; thawed={})",
                m_idx, before, after, thawed,
            );
            calls += 1;
        }

        // Defensive: ensure we actually unfroze (the loop thaws when asks
        // empty; if the book somehow emptied before that, thaw now to leave the
        // shared ATA in a clean state for later flows in this iteration).
        if !thawed {
            self.set_token_frozen(&maker_usdc, false);
        }

        // Escrow must be fully drained once the book is empty.
        let usdc_escrow = self.markets[m_idx].usdc_escrow;
        let yes_escrow = self.markets[m_idx].yes_escrow;
        let usdc_left = self.read_token_balance(&usdc_escrow);
        let yes_left = self.read_token_balance(&yes_escrow);
        assert_eq!(usdc_left, 0, "sweep market {} USDC escrow not drained: {}", m_idx, usdc_left);
        assert_eq!(yes_left, 0, "sweep market {} Yes escrow not drained: {}", m_idx, yes_left);

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
        // We use the program's own ID as pyth_receiver so the sweep probe can
        // plant a program-owned PriceUpdateV2 for settle_market.
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

    /// Forge and plant a Full-verified Pyth `PriceUpdateV2` account at `pk`,
    /// owned by the meridian program (which bootstrap pins as
    /// `config.pyth_receiver`). Borsh-serialize the vendored struct and
    /// prepend the Anchor account discriminator so `try_deserialize` in
    /// `settle_market` accepts it.
    fn plant_price_update(&mut self, pk: &Pubkey, feed_id: [u8; 32], publish_time: i64) {
        use anchor_lang::AnchorSerialize;
        use solana_sdk::account::{AccountSharedData, WritableAccount};

        // The meridian crate uses a different solana-program major (its
        // `Pubkey` != trident's `Pubkey`), so cross the boundary by bytes.
        let prog_pk_anchor =
            anchor_lang::prelude::Pubkey::new_from_array(meridian_program_id().to_bytes());
        let update = meridian::state::pyth::PriceUpdateV2 {
            write_authority: prog_pk_anchor,
            verification_level: meridian::state::pyth::VerificationLevel::Full,
            price_message: meridian::state::pyth::PriceFeedMessage {
                feed_id,
                price: 1,
                conf: 0,
                exponent: 0,
                publish_time,
                prev_publish_time: publish_time,
                ema_price: 1,
                ema_conf: 0,
            },
            posted_slot: 0,
        };
        let mut data =
            <meridian::state::pyth::PriceUpdateV2 as Discriminator>::DISCRIMINATOR.to_vec();
        update.serialize(&mut data).expect("serialize PriceUpdateV2");

        // Construct a fresh program-owned account sized to the forged data.
        let mut acct = AccountSharedData::new(1_000_000_000, data.len(), &meridian_program_id());
        acct.data_as_mut_slice().copy_from_slice(&data);
        self.trident.set_account_custom(pk, &acct);
    }

    fn build_settle_market_ix(&self, market_idx: usize, price_update: Pubkey) -> Instruction {
        let m = &self.markets[market_idx];
        let caller = solana_sdk::signer::Signer::pubkey(&self.admin);
        let mut data = Vec::with_capacity(8);
        data.extend_from_slice(&anchor_disc("settle_market"));
        Instruction {
            program_id: meridian_program_id(),
            accounts: vec![
                AccountMeta::new(caller, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(m.market, false),
                AccountMeta::new_readonly(price_update, false),
            ],
            data,
        }
    }

    /// Build a `settle_sweep` ix that drains up to `MAX_SWEEP_PER_TX` orders.
    /// The program drains bids first (USDC refund) then asks (Yes refund), one
    /// recipient `AccountMeta` per POP ATTEMPT in that order — INCLUDING entries
    /// it will skip. All owners are the admin keypair, so we supply the admin's
    /// canonical USDC ATA for each bid pop and the market's admin canonical Yes
    /// ATA for each ask pop, sized to the current resting book (capped at 8).
    fn build_settle_sweep_ix(&self, market_idx: usize, resting: &RestingState) -> Instruction {
        let m = &self.markets[market_idx];
        let caller = solana_sdk::signer::Signer::pubkey(&self.admin);
        let owner_usdc = self.user_usdc[0];
        let owner_yes = m.user_yes_ata[0];

        let mut data = Vec::with_capacity(8 + 4);
        data.extend_from_slice(&anchor_disc("settle_sweep"));
        data.extend_from_slice(&(MAX_SWEEP_PER_TX as u32).to_le_bytes());

        let mut accounts = vec![
            AccountMeta::new(caller, true),
            AccountMeta::new_readonly(self.config, false),
            AccountMeta::new(m.market, false),
            AccountMeta::new(m.book, false),
            AccountMeta::new(m.usdc_escrow, false),
            AccountMeta::new(m.yes_escrow, false),
            AccountMeta::new_readonly(m.yes_mint, false),
            AccountMeta::new_readonly(m.mint_authority, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ];
        // One recipient per pop attempt, capped at MAX_SWEEP_PER_TX, in pop
        // order (bids then asks). The program pops bids first while any remain,
        // then asks — and consumes a slot even for skipped (frozen) pops.
        let cap = MAX_SWEEP_PER_TX;
        let bids_this_call = resting.bids.len().min(cap);
        let asks_this_call = (cap - bids_this_call).min(resting.asks.len());
        for _ in 0..bids_this_call {
            accounts.push(AccountMeta::new(owner_usdc, false)); // canonical USDC ATA
        }
        for _ in 0..asks_this_call {
            accounts.push(AccountMeta::new(owner_yes, false)); // canonical Yes ATA
        }
        Instruction {
            program_id: meridian_program_id(),
            accounts,
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
        ix.accounts.extend(self.maker_remaining(market_idx, side));
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
        ix.accounts.extend(self.maker_remaining(market_idx, side));
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
        // buy_no's internal market-sell of the Yes leg is an ASK taker (it hits
        // resting bids and pays makers Yes), so its maker payout mint is Yes.
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
        // ASK taker → maker payout mint is Yes → canonical Yes ATA per fill.
        ix.accounts.extend(self.maker_remaining(market_idx, 1));
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
        // sell_no's internal market-buy of the Yes leg is a BID taker (it hits
        // resting asks and pays makers USDC), so its maker payout mint is USDC.
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
        // BID taker → maker payout mint is USDC → canonical USDC ATA per fill.
        ix.accounts.extend(self.maker_remaining(market_idx, 0));
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

    /// Flip an SPL token account's state byte to drive the maker-payout / sweep
    /// skip branch on a CANONICAL account (the task's "freeze the canonical ATA"
    /// strategy). `spl_token::state::Account` is 165 bytes with the `state` enum
    /// at offset 108: Initialized = 1, Frozen = 2. The program's
    /// `token_account_receivable` requires byte 108 == 1, so writing 2 makes the
    /// account un-receivable (skip) while keeping its address canonical and its
    /// balance intact; writing 1 thaws it. We mutate the on-chain bytes directly
    /// via `set_account_custom` rather than issuing a real `FreezeAccount` CPI —
    /// a byte flip is cheaper and avoids an extra signer tx.
    fn set_token_frozen(&mut self, ata: &Pubkey, frozen: bool) {
        use solana_sdk::account::WritableAccount;
        let mut acct = self.trident.get_account(ata);
        if acct.data().len() < spl_token_interface::state::Account::LEN {
            return; // not a live token account; nothing to do
        }
        acct.data_as_mut_slice()[108] = if frozen { 2 } else { 1 };
        self.trident.set_account_custom(ata, &acct);
    }

    /// True iff the SPL token account's state byte reads Frozen (2). Used by the
    /// probes to confirm the freeze persisted before relying on it.
    fn is_token_frozen(&mut self, ata: &Pubkey) -> bool {
        let acct = self.trident.get_account(ata);
        let data = acct.data();
        data.len() >= spl_token_interface::state::Account::LEN && data[108] == 2
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

    /// Maker payout accounts for fills (1-account canonical-ATA ABI).
    ///
    /// Every maker is the admin keypair, so each fill's payout account is the
    /// admin's CANONICAL ATA for the payout mint, which is fixed by the TAKER's
    /// side for the whole order:
    ///   * `side == 0` (Bid taker, hits resting asks) pays makers USDC →
    ///     canonical USDC ATA.
    ///   * `side == 1` (Ask taker, hits resting bids) pays makers Yes →
    ///     canonical Yes ATA.
    /// We supply `MAX_FILLS_PER_TX` canonical payout ATAs (one slot per possible
    /// fill); `place_order_inner` requires `remaining.len() >= fill_count` and
    /// reads only `0..fill_count`, ignoring the tail.
    ///
    /// These are ALWAYS the maker's CANONICAL ATA — passing a non-canonical
    /// account now REVERTS (`BadMakerAccount`), so the skip-and-continue branch
    /// is NOT driven from here. `flow_skip_probe` reaches it by FREEZING the
    /// canonical payout ATA (the only valid way under this ABI).
    fn maker_remaining(&mut self, market_idx: usize, taker_side: u8) -> Vec<AccountMeta> {
        // Payout mint is determined by the taker side:
        //   Bid taker (0) pays makers USDC; Ask taker (1) pays makers Yes.
        let payout_ata = if taker_side == 0 {
            self.user_usdc[0]
        } else {
            self.markets[market_idx].user_yes_ata[0]
        };
        let mut metas = Vec::with_capacity(MAX_FILLS_PER_TX);
        for _ in 0..MAX_FILLS_PER_TX {
            metas.push(AccountMeta::new(payout_ata, false));
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

/// Total resting ask quantity at prices a Bid taker priced `limit` can cross
/// (ask price <= limit). Used by `flow_skip_probe` to size a FULL-consumption
/// taker (every crossed ask consumed in whole).
fn crossable_ask_qty(resting: &RestingState, limit: u64) -> u64 {
    resting
        .asks
        .iter()
        .filter(|e| e.price <= limit)
        .map(|e| e.qty)
        .fold(0u64, |a, q| a.saturating_add(q))
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
    // The §U9 gate runs >= 100_000 ops:
    //   TRIDENT_ITERATIONS=100000 TRIDENT_FLOW_CALLS=10 trident fuzz run clob_invariants
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
