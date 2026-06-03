# Audit triage — C/H/M findings

Human triage of the audit-agent's 13 findings against the actual source, escrow
invariants, and the shared matching kernel. The agent verifies each lead with a
**grep probe** (structural evidence), so several findings are leads that don't
survive reading the code one layer deeper. That's expected — the value is in
the triage.

## Verdicts (critical / high / medium)

| # | Finding | Verdict | Why |
|---|---------|---------|-----|
| **C1** | `initialize_config` first-caller-wins admin | ✅ **REAL** | No binding to the program upgrade authority — a front-runner can seize admin between deploy and bootstrap. Deploy-time only; current devnet init is already done. |
| **M2** | `create_strike_market` no future-expiry check | ✅ **REAL** (minor, admin-gated) | An admin could mint an already-expired, dead-on-arrival market. **Fixed** (`expiry_unix > now`). |
| H1/M3 | `settle_market` unvalidated `pyth_feed_id` | ⚠️ By design | Admin supplies the feed id at market creation; settle binds the price account to it. Risk is admin-trust. Mitigation = a config feed allowlist (see below). |
| H2 | Admin centralization, no timelock/multisig | ⚠️ By design | Single-admin devnet protocol. Production hardening = governance/timelock. |
| M1 | `burn_pair` no expiry check | ❌ False | A *balanced* Yes+No pair is worth exactly $1 until settlement flips the outcome. `burn_pair` is intentionally open between expiry and settle so positions can unwind; the `!settled` gate is correct and sufficient. |
| M4 | `place_limit_order` `+=` not `checked_add` | ❌ False | Accumulators are `u128`; fills are bounded by book depth (≤32) × `u64`, ~5.8e26 ≪ `u128::MAX`. `filled_qty_total ≤ taker qty ≤ u64::MAX`, so the cast is safe. Hygiene at most. |
| M5 | `sell_no` trades after expiry | ❌ False | `sell_no` composes `place_order_inner`, which gates every trading path on `now < expiry` (the agent only grepped `sell_no.rs`'s own body). |
| M6 | `sell_no` maker ATA not bound | ❌ False | The canonical-ATA binding lives in `place_order_inner`'s fill-settlement, which `sell_no` composes. |
| M7 | `settle_market` `saturating_mul` bypass | ❌ False | Inputs are `u64`/`i64`; `u64 × 10_000` and `i64 × MAX_CONF_BPS` fit in `u128` with ~15 orders of magnitude of headroom, so saturation is impossible. |
| M8 | `settle_sweep` over-drain | ❌ False | `amt` is `u128`, so `require!(amt <= u64::MAX)` is a real bound (not a no-op). The bid refund `qty × price` equals exactly what was escrowed at placement — no over-drain. |

**Tally:** 2 actionable, 2 accepted-by-design, 5 false positives. (M2 fixed; C1 patch below.)

## C1 — the fix (NOT applied; needs redeploy + caller updates)

Constrain `initialize_config` to the program's upgrade authority. **Why not auto-applied:** it changes the instruction's accounts, so all 7 litesvm tests, the
Trident fuzzer, and the deploy/init script must pass the two new accounts; and it
only matters at bootstrap, which on devnet is already done. Apply it before the
next fresh deploy.

```rust
// add to `struct InitializeConfig<'info>`:

/// The program account — its programdata holds the upgrade authority.
#[account(
    constraint = program.programdata_address()? == Some(program_data.key())
        @ MeridianError::Unauthorized
)]
pub program: Program<'info, crate::program::Meridian>,

/// Only the program's upgrade authority may bootstrap Config.
#[account(
    constraint = program_data.upgrade_authority_address == Some(payer.key())
        @ MeridianError::Unauthorized
)]
pub program_data: Account<'info, ProgramData>,
```

Callers then pass `program = <program id>` and `program_data = <BPFLoaderUpgradeable
program-data PDA>`. This closes the front-run window: only the deployer's upgrade
authority can take the admin slot.

## H1 — optional hardening (config feed allowlist)

If you don't want to fully trust the admin to set a correct `pyth_feed_id`, store
an allowlist of accepted feed ids on `Config` and `require!` membership in
`create_strike_market`. Heavier change (new Config field + admin instruction to
manage the list). Reasonable to defer for a devnet demo.

## Deploy note

M2 is in source but **not live** — the deployed devnet program is unchanged. It
takes effect only on the next `anchor build` + `anchor deploy` (which is
disruptive to the running app, so it's a deliberate step).
