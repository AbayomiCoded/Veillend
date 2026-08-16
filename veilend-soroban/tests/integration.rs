use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env};
use veillend_contract::{VeilLendContract, VeilLendContractClient};

const SECONDS_PER_YEAR: u64 = 31_536_000;
const DEFAULT_TIMELOCK: u32 = 50;

fn advance_ledgers(env: &Env, n: u32) {
    let current = env.ledger().sequence();
    env.ledger().set_sequence_number(current.saturating_add(n));
}

/// Proposes and executes `configure_asset(true)`, advancing past the default
/// timelock so the action becomes executable.
fn configure_asset(env: &Env, client: &VeilLendContractClient, admin: &Address, asset: &Address) {
    let action_id = client.propose_configure_asset(admin, asset, &true);
    advance_ledgers(env, DEFAULT_TIMELOCK);
    client.execute_configure_asset(admin, &action_id);
}

fn set_oracle_price(
    env: &Env,
    client: &VeilLendContractClient,
    admin: &Address,
    asset: &Address,
    price: &i128,
) {
    let action_id = client.propose_set_oracle_price(admin, asset, price);
    advance_ledgers(env, DEFAULT_TIMELOCK);
    client.execute_set_oracle_price(admin, &action_id);
}

fn update_asset_caps(
    env: &Env,
    client: &VeilLendContractClient,
    admin: &Address,
    asset: &Address,
    deposit_cap: &i128,
    borrow_cap: &i128,
) {
    let action_id = client.propose_update_asset_caps(admin, asset, deposit_cap, borrow_cap);
    advance_ledgers(env, DEFAULT_TIMELOCK);
    client.execute_update_asset_caps(admin, &action_id);
}

fn pause(env: &Env, client: &VeilLendContractClient, admin: &Address) {
    let action_id = client.propose_set_paused(admin);
    advance_ledgers(env, DEFAULT_TIMELOCK);
    client.execute_set_paused(admin, &action_id);
}

#[test]
fn test_initialize_contract() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    let admins = client.get_admins();
    assert_eq!(admins.len(), 1);
    assert_eq!(admins.get(0), Some(admin));
    assert_eq!(client.min_collateral_ratio_bps(), 15_000);
    assert_eq!(client.get_timelock_ledgers(), DEFAULT_TIMELOCK);
    assert!(!client.is_paused());
}

#[test]
fn test_configure_asset() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    let action_id = client.propose_configure_asset(&admin, &asset, &true);
    advance_ledgers(&env, DEFAULT_TIMELOCK);
    client.execute_configure_asset(&admin, &action_id);

    assert!(client.is_asset_supported(&asset));

    let caps = client.get_asset_caps(&asset);
    assert_eq!(caps.deposit_cap, -1);
    assert_eq!(caps.borrow_cap, -1);

    assert_eq!(client.get_total_deposited(&asset), 0);
    assert_eq!(client.get_total_borrowed(&asset), 0);
}

#[test]
fn test_update_asset_caps() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);
    set_oracle_price(&env, &client, &admin, &asset, &100);

    // Set caps
    update_asset_caps(&env, &client, &admin, &asset, &1000, &500);

    let caps = client.get_asset_caps(&asset);
    assert_eq!(caps.deposit_cap, 1000);
    assert_eq!(caps.borrow_cap, 500);

    // Test deposit cap
    client.deposit(&user, &asset, &500);
    assert_eq!(client.get_total_deposited(&asset), 500);

    // This should succeed (500 + 500 = 1000, at cap)
    client.deposit(&user, &asset, &500);
    assert_eq!(client.get_total_deposited(&asset), 1000);

    // This should fail (exceeds cap)
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.deposit(&user, &asset, &1);
    }));
    assert!(result.is_err());

    // Test borrow cap
    client.borrow(&user, &asset, &500);
    assert_eq!(client.get_total_borrowed(&asset), 500);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.borrow(&user, &asset, &1);
    }));
    assert!(result.is_err());
}

#[test]
fn test_circuit_breaker_pause() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);
    set_oracle_price(&env, &client, &admin, &asset, &100);

    // Pause the contract (timelocked)
    pause(&env, &client, &admin);
    assert!(client.is_paused());

    // Deposit should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.deposit(&user, &asset, &100);
    }));
    assert!(result.is_err());

    // Borrow should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.borrow(&user, &asset, &100);
    }));
    assert!(result.is_err());

    // Unpause is immediate, then deposit and borrow
    client.set_paused(&admin, &false);
    client.deposit(&user, &asset, &1000);
    client.borrow(&user, &asset, &500);
    pause(&env, &client, &admin);

    // Repay should still work (user can reduce debt)
    client.repay(&user, &asset, &500);
    assert_eq!(client.get_total_borrowed(&asset), 0);

    // Withdraw should still work (user can remove collateral)
    client.withdraw(&user, &asset, &1000);
    assert_eq!(client.get_total_deposited(&asset), 0);
}

#[test]
fn test_circuit_breaker_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    // Attacker tries to pause (propose)
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.propose_set_paused(&attacker);
    }));
    assert!(result.is_err());

    // Attacker tries to unpause
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_paused(&attacker, &false);
    }));
    assert!(result.is_err());

    // Should still be unpaused
    assert!(!client.is_paused());
}

#[test]
fn test_deposit_and_borrow_with_caps() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);
    set_oracle_price(&env, &client, &admin, &asset, &100);

    // Set caps
    update_asset_caps(&env, &client, &admin, &asset, &2000, &1000);

    // User1 deposits 1000
    client.deposit(&user1, &asset, &1000);
    assert_eq!(client.get_total_deposited(&asset), 1000);

    // User2 deposits 1000 (now at 2000 cap)
    client.deposit(&user2, &asset, &1000);
    assert_eq!(client.get_total_deposited(&asset), 2000);

    // User2 tries to deposit more - should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.deposit(&user2, &asset, &1);
    }));
    assert!(result.is_err());

    // User1 borrows 500
    client.borrow(&user1, &asset, &500);
    assert_eq!(client.get_total_borrowed(&asset), 500);

    // User2 borrows 500 (now at 1000 cap)
    client.borrow(&user2, &asset, &500);
    assert_eq!(client.get_total_borrowed(&asset), 1000);

    // User2 tries to borrow more - should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.borrow(&user2, &asset, &1);
    }));
    assert!(result.is_err());
}

#[test]
fn test_unlimited_caps() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);
    set_oracle_price(&env, &client, &admin, &asset, &100);

    // Set caps to unlimited (-1)
    update_asset_caps(&env, &client, &admin, &asset, &-1, &-1);

    // Should be able to deposit large amounts
    client.deposit(&user, &asset, &1000000);
    assert_eq!(client.get_total_deposited(&asset), 1000000);

    // Should be able to borrow large amounts (if collateral allows)
    client.borrow(&user, &asset, &500000);
    assert_eq!(client.get_total_borrowed(&asset), 500000);
}

#[test]
fn test_invalid_caps() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);

    // Zero cap is invalid (should be -1 for unlimited or positive)
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.propose_update_asset_caps(&admin, &asset, &0, &500);
    }));
    assert!(result.is_err());

    // Negative cap other than -1 is invalid
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.propose_update_asset_caps(&admin, &asset, &-2, &500);
    }));
    assert!(result.is_err());

    // Should still have default caps
    let caps = client.get_asset_caps(&asset);
    assert_eq!(caps.deposit_cap, -1);
    assert_eq!(caps.borrow_cap, -1);
}

#[test]
fn test_cap_update_events() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);

    // Events are emitted - we just verify no panic
    update_asset_caps(&env, &client, &admin, &asset, &1000, &500);
    let caps = client.get_asset_caps(&asset);
    assert_eq!(caps.deposit_cap, 1000);
    assert_eq!(caps.borrow_cap, 500);
}

#[test]
fn test_circuit_breaker_events() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    // Pause on (timelocked)
    pause(&env, &client, &admin);
    assert!(client.is_paused());

    // Pause off (immediate)
    client.set_paused(&admin, &false);
    assert!(!client.is_paused());
}

#[test]
fn test_deposit_then_borrow_then_time_advances_grows_debt_matching_formula() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);
    set_oracle_price(&env, &client, &admin, &asset, &1);

    // 50% utilization: borrow_rate = 200 + (5000 * 2000 / 10000) = 1200 bps (12% APR)
    // supply_rate = 1200 * 5000 / 10000 = 600 bps (6% APR)
    client.deposit(&user, &asset, &1_000_000);
    client.borrow(&user, &asset, &500_000);

    let ledger_timestamp = env.ledger().timestamp();
    env.ledger()
        .set_timestamp(ledger_timestamp + SECONDS_PER_YEAR);

    let position = client.get_position(&user, &asset);

    assert_eq!(position.borrowed, 560_000);
    assert_eq!(position.deposited, 1_060_000);
}

#[test]
fn test_accrue_interest_grows_indexes_with_no_position_touch() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);
    set_oracle_price(&env, &client, &admin, &asset, &1);
    client.deposit(&user, &asset, &1_000_000);
    client.borrow(&user, &asset, &500_000);

    let before = client.get_interest_state(&asset);
    assert_eq!(before.supply_index, 1_000_000_000);
    assert_eq!(before.borrow_index, 1_000_000_000);

    let ledger_timestamp = env.ledger().timestamp();
    env.ledger()
        .set_timestamp(ledger_timestamp + SECONDS_PER_YEAR);

    // No position is touched here - purely a reserve-level refresh.
    client.accrue_interest(&asset);

    let after = client.get_interest_state(&asset);
    assert_eq!(after.borrow_index, 1_120_000_000);
    assert_eq!(after.supply_index, 1_060_000_000);
    assert_eq!(client.get_total_borrowed(&asset), 560_000);
    assert_eq!(client.get_total_deposited(&asset), 1_060_000);
}

#[test]
fn test_repay_and_withdraw_operate_on_accrued_amounts() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);
    set_oracle_price(&env, &client, &admin, &asset, &1);
    client.deposit(&user, &asset, &1_000_000);
    client.borrow(&user, &asset, &500_000);

    let ledger_timestamp = env.ledger().timestamp();
    env.ledger()
        .set_timestamp(ledger_timestamp + SECONDS_PER_YEAR);

    // Repaying more than the accrued debt should fail.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.repay(&user, &asset, &560_001);
    }));
    assert!(result.is_err());

    // Repaying exactly the accrued debt succeeds.
    client.repay(&user, &asset, &560_000);
    let position = client.get_position(&user, &asset);
    assert_eq!(position.borrowed, 0);

    // With no outstanding debt, the full accrued deposit can be withdrawn.
    client.withdraw(&user, &asset, &1_060_000);
    let position = client.get_position(&user, &asset);
    assert_eq!(position.deposited, 0);
}

#[test]
fn test_conservation_of_value_between_suppliers_and_borrower() {
    // Interest accrued to the borrower's debt must exactly equal interest
    // credited to suppliers' deposits in aggregate (100% pass-through, no
    // protocol fee skim in this accrual model) — verified here across two
    // distinct suppliers and a separately-collateralized borrower, at 40%
    // utilization (not the round 50%/100% cases covered elsewhere).
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let supplier = Address::generate(&env);
    let borrower = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);
    set_oracle_price(&env, &client, &admin, &asset, &1);

    // Pure supplier: deposits only, never borrows.
    client.deposit(&supplier, &asset, &500_000);

    // Borrower: deposits their own collateral, then borrows against it
    // (750_000 * 10_000 >= 500_000 * 15_000, exactly at the 150% minimum).
    client.deposit(&borrower, &asset, &750_000);
    client.borrow(&borrower, &asset, &500_000);

    let total_deposited_before = client.get_total_deposited(&asset);
    let total_borrowed_before = client.get_total_borrowed(&asset);

    let ledger_timestamp = env.ledger().timestamp();
    env.ledger()
        .set_timestamp(ledger_timestamp + SECONDS_PER_YEAR);

    client.accrue_interest(&asset);

    let total_deposited_growth = client.get_total_deposited(&asset) - total_deposited_before;
    let total_borrowed_growth = client.get_total_borrowed(&asset) - total_borrowed_before;

    assert_eq!(total_deposited_growth, 50_000);
    assert_eq!(total_borrowed_growth, 50_000);
}

#[test]
fn test_two_accrual_calls_at_same_timestamp_are_idempotent() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);
    set_oracle_price(&env, &client, &admin, &asset, &1);
    client.deposit(&user, &asset, &1_000_000);
    client.borrow(&user, &asset, &500_000);

    let ledger_timestamp = env.ledger().timestamp();
    env.ledger()
        .set_timestamp(ledger_timestamp + SECONDS_PER_YEAR);

    client.accrue_interest(&asset);
    let after_first = client.get_interest_state(&asset);
    let total_deposited_after_first = client.get_total_deposited(&asset);
    let total_borrowed_after_first = client.get_total_borrowed(&asset);

    // Same timestamp, no time elapsed - must be a no-op.
    client.accrue_interest(&asset);
    let after_second = client.get_interest_state(&asset);

    assert_eq!(after_first, after_second);
    assert_eq!(
        client.get_total_deposited(&asset),
        total_deposited_after_first
    );
    assert_eq!(
        client.get_total_borrowed(&asset),
        total_borrowed_after_first
    );
}

// ---------------------------------------------------------------------------
// Multi-admin + timelock acceptance tests (issue #312)
// ---------------------------------------------------------------------------

#[test]
fn test_two_admin_set_propose_execute_timelock() {
    let env = Env::default();
    env.mock_all_auths();
    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin1.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    // admin1 adds admin2 -> 2-admin set
    client.add_admin(&admin1, &admin2);
    let admins = client.get_admins();
    assert!(admins.contains(&admin1));
    assert!(admins.contains(&admin2));

    // admin1 proposes configure_asset
    let action_id = client.propose_configure_asset(&admin1, &asset, &true);

    // execute before timelock -> TimelockNotReady (panics)
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_configure_asset(&admin1, &action_id);
    }));
    assert!(result.is_err());

    // wait ledgers -> execute succeeds
    advance_ledgers(&env, DEFAULT_TIMELOCK);
    client.execute_configure_asset(&admin1, &action_id);
    assert!(client.is_asset_supported(&asset));
}

#[test]
fn test_second_admin_can_execute_proposal() {
    let env = Env::default();
    env.mock_all_auths();
    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin1.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.add_admin(&admin1, &admin2);

    // admin1 proposes, admin2 executes after timelock
    let action_id = client.propose_configure_asset(&admin1, &asset, &true);
    advance_ledgers(&env, DEFAULT_TIMELOCK);
    client.execute_configure_asset(&admin2, &action_id);
    assert!(client.is_asset_supported(&asset));
}

#[test]
fn test_remove_admin_last_admin_required() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    // Removing the only remaining admin must panic (LastAdminRequired)
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.remove_admin(&admin, &admin);
    }));
    assert!(result.is_err());

    // Admin set is unchanged
    let admins = client.get_admins();
    assert_eq!(admins.len(), 1);
    assert_eq!(admins.get(0), Some(admin));
}

#[test]
fn test_add_remove_admin_roundtrip() {
    let env = Env::default();
    env.mock_all_auths();
    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin1.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.add_admin(&admin1, &admin2);
    assert!(client.get_admins().contains(&admin2));

    // admin2 (now an admin) can remove admin1
    client.remove_admin(&admin2, &admin1);
    let admins = client.get_admins();
    assert_eq!(admins.len(), 1);
    assert_eq!(admins.get(0), Some(admin2));
}

#[test]
fn test_propose_then_cancel_execute_returns_unknown_action() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    let action_id = client.propose_configure_asset(&admin, &asset, &true);

    // cancel (past the timelock so it would otherwise be executable)
    advance_ledgers(&env, DEFAULT_TIMELOCK);
    client.cancel_configure_asset(&admin, &action_id);

    // execute now returns UnknownAction (panics)
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_configure_asset(&admin, &action_id);
    }));
    assert!(result.is_err());

    // Nothing was configured
    assert!(!client.is_asset_supported(&asset));
}

#[test]
fn test_unpause_immediate_even_with_timelock_configured() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    // Configure a long timelock
    client.set_timelock_ledgers(&admin, &100_000);
    assert_eq!(client.get_timelock_ledgers(), 100_000);

    // Pausing still requires the timelock
    let action_id = client.propose_set_paused(&admin);
    advance_ledgers(&env, 100_000);
    client.execute_set_paused(&admin, &action_id);
    assert!(client.is_paused());

    // Unpause executes immediately even with timelock configured
    client.set_paused(&admin, &false);
    assert!(!client.is_paused());
}

#[test]
fn test_set_timelock_ledgers_bounds() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    // Below minimum (1)
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_timelock_ledgers(&admin, &0);
    }));
    assert!(result.is_err());

    // Above maximum (100_000)
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_timelock_ledgers(&admin, &100_001);
    }));
    assert!(result.is_err());

    // Boundary values are accepted
    client.set_timelock_ledgers(&admin, &1);
    assert_eq!(client.get_timelock_ledgers(), 1);
    client.set_timelock_ledgers(&admin, &100_000);
    assert_eq!(client.get_timelock_ledgers(), 100_000);
}

#[test]
fn test_set_min_collateral_ratio_timelocked() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    // Invalid ratio (< 10_000 bps) rejected at propose time
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.propose_set_min_collateral_ratio(&admin, &9_999);
    }));
    assert!(result.is_err());

    // Valid ratio proposed and executed after timelock
    let action_id = client.propose_set_min_collateral_ratio(&admin, &20_000);
    advance_ledgers(&env, DEFAULT_TIMELOCK);
    client.execute_set_min_collateral_ratio(&admin, &action_id);

    assert_eq!(client.min_collateral_ratio_bps(), 20_000);
}

#[test]
fn test_record_protocol_fee_timelocked() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);

    let action_id = client.propose_record_protocol_fee(&admin, &asset, &100);
    advance_ledgers(&env, DEFAULT_TIMELOCK);
    client.execute_record_protocol_fee(&admin, &action_id);

    let reserve = client.get_asset_reserve(&asset);
    assert_eq!(reserve.total_balance, 100);
    assert_eq!(reserve.protocol_fees, 100);
}

// ---------------------------------------------------------------------------
// Constructor auth ordering (from #264): the founding admin must sign before
// any storage is touched, so unauthenticated callers cannot probe init state.
// ---------------------------------------------------------------------------

#[test]
fn test_constructor_requires_admin_auth() {
    // No mock_all_auths: the constructor must authenticate `admin`, so
    // registration without the admin signature fails.
    let env = Env::default();
    let admin = Address::generate(&env);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(VeilLendContract, (admin.clone(), 15_000u32));
    }));
    assert!(result.is_err());
}

// ============================================================================
// Oracle Safety Rail Tests (Issue #263)
// ============================================================================

#[test]
fn test_oracle_staleness_tracking() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.add_admin(&admin, &admin);
    configure_asset(&env, &client, &admin, &asset);

    // Set initial price
    client.set_oracle_price(&admin, &asset, &100);

    // Check price with age - should be 0 seconds old
    let (price, age) = client.get_oracle_price_with_age(&asset).unwrap();
    assert_eq!(price, 100);
    assert_eq!(age, 0);

    // Advance time by 1 hour
    let ledger_timestamp = env.ledger().timestamp();
    env.ledger().set_timestamp(ledger_timestamp + 3600);

    // Check again - should be 3600 seconds old
    let (price, age) = client.get_oracle_price_with_age(&asset).unwrap();
    assert_eq!(price, 100);
    assert_eq!(age, 3600);
}

#[test]
fn test_oracle_staleness_blocks_collateral_check() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.add_admin(&admin, &admin);
    configure_asset(&env, &client, &admin, &asset);
    client.set_oracle_price(&admin, &asset, &100);

    // Set max age to 1 hour
    client.set_max_oracle_age(&admin, &3600);

    // Deposit and borrow should work initially
    client.deposit(&user, &asset, &1000);
    client.borrow(&user, &asset, &500);

    // Advance time beyond max age (2 hours)
    let ledger_timestamp = env.ledger().timestamp();
    env.ledger().set_timestamp(ledger_timestamp + 7200);

    // Try to withdraw - should fail due to stale price
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.withdraw(&user, &asset, &100);
    }));
    assert!(result.is_err());

    // Try to borrow more - should also fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.borrow(&user, &asset, &100);
    }));
    assert!(result.is_err());

    // Repay should still work
    client.repay(&user, &asset, &500);
}

#[test]
fn test_oracle_max_change_bps_blocks_excessive_volatility() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.add_admin(&admin, &admin);
    configure_asset(&env, &client, &admin, &asset);

    // Set initial price to 100
    client.set_oracle_price(&admin, &asset, &100);

    // Set max change to 500 bps (5%)
    client.set_oracle_max_change_bps(&admin, &asset, &500);

    // Try to set price to 106 (6% increase) - should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_oracle_price(&admin, &asset, &106);
    }));
    assert!(result.is_err());

    // Set price to 105 (5% increase) - should succeed
    client.set_oracle_price(&admin, &asset, &105);
    assert_eq!(client.get_oracle_price(&asset), Some(105));

    // Set price to 100 (from 105, ~4.76% decrease) - should succeed
    client.set_oracle_price(&admin, &asset, &100);
    assert_eq!(client.get_oracle_price(&asset), Some(100));

    // Set price to 94 (6% decrease) - should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_oracle_price(&admin, &asset, &94);
    }));
    assert!(result.is_err());

    // Set price to 95 (5% decrease) - should succeed
    client.set_oracle_price(&admin, &asset, &95);
    assert_eq!(client.get_oracle_price(&asset), Some(95));
}

#[test]
fn test_oracle_price_bounds() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.add_admin(&admin, &admin);
    configure_asset(&env, &client, &admin, &asset);

    // Set bounds: min=1, max=1000
    client.set_oracle_price_bounds(&admin, &asset, &1, &1000);

    // Try to set price below min - should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_oracle_price(&admin, &asset, &0);
    }));
    assert!(result.is_err());

    // Set price at min - should succeed
    client.set_oracle_price(&admin, &asset, &1);
    assert_eq!(client.get_oracle_price(&asset), Some(1));

    // Try to set price above max - should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_oracle_price(&admin, &asset, &1001);
    }));
    assert!(result.is_err());

    // Set price at max - should succeed
    client.set_oracle_price(&admin, &asset, &1000);
    assert_eq!(client.get_oracle_price(&asset), Some(1000));

    // Set price in middle - should succeed
    client.set_oracle_price(&admin, &asset, &500);
    assert_eq!(client.get_oracle_price(&asset), Some(500));
}

#[test]
fn test_accrue_interest_syncs_reserve_total_balance() {
    // Regression test for issue #260: interest accrual must keep
    // AssetReserve.total_balance in sync with suppliers' growing claim,
    // otherwise the reserve balance drifts stale relative to
    // TotalDeposited - TotalBorrowed.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);
    set_oracle_price(&env, &client, &admin, &asset, &1);

    // 50% utilization: borrow_rate = 12% APR, supply_rate = 6% APR.
    client.deposit(&user, &asset, &1_000_000);
    client.borrow(&user, &asset, &500_000);

    let ledger_timestamp = env.ledger().timestamp();
    env.ledger()
        .set_timestamp(ledger_timestamp + SECONDS_PER_YEAR);

    client.accrue_interest(&asset);

    assert_eq!(client.get_total_deposited(&asset), 1_060_000);
    assert_eq!(client.get_total_borrowed(&asset), 560_000);

    let reserve = client.get_asset_reserve(&asset);
    // 1_000_000 deposited - 500_000 borrowed out + 60_000 interest credited
    // to suppliers = 560_000. Borrower-side interest (60_000 owed on top of
    // the 500_000 debt) must NOT add to the reserve balance since it never
    // left/entered the reserve as tokens.
    assert_eq!(reserve.total_balance, 560_000);

    assert!(
        reserve.total_balance
            >= client.get_total_deposited(&asset) - client.get_total_borrowed(&asset)
    );
}

#[test]
fn test_withdraw_after_implicit_accrual_uses_synced_reserve() {
    // The implicit accrual inside withdraw() must update the reserve before
    // the InsufficientReserve check runs, or a legitimate full withdrawal of
    // the post-accrual supplier claim would incorrectly be blocked.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);
    set_oracle_price(&env, &client, &admin, &asset, &1);

    client.deposit(&user, &asset, &1_000_000);
    client.borrow(&user, &asset, &500_000);

    let ledger_timestamp = env.ledger().timestamp();
    env.ledger()
        .set_timestamp(ledger_timestamp + SECONDS_PER_YEAR);

    // No explicit accrue_interest call - withdraw() must accrue internally
    // and sync the reserve before its balance check.
    client.repay(&user, &asset, &560_000);
    client.withdraw(&user, &asset, &1_060_000);

    let position = client.get_position(&user, &asset);
    assert_eq!(position.deposited, 0);
}

#[test]
fn test_repay_then_withdraw_full_claim_after_accrual() {
    // After a full year of accrual, repaying the full accrued debt and then
    // withdrawing the full accrued deposit must both succeed against a
    // reserve balance that has been kept in sync throughout.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    configure_asset(&env, &client, &admin, &asset);
    set_oracle_price(&env, &client, &admin, &asset, &1);

    client.deposit(&user, &asset, &1_000_000);
    client.borrow(&user, &asset, &500_000);

    let ledger_timestamp = env.ledger().timestamp();
    env.ledger()
        .set_timestamp(ledger_timestamp + SECONDS_PER_YEAR);

    client.repay(&user, &asset, &560_000);

    // Reserve was 560_000 (1_000_000 deposited - 500_000 lent out + 60_000
    // supplier interest) before repay; the full 560_000 debt repayment
    // returns those tokens to the reserve.
    let reserve_after_repay = client.get_asset_reserve(&asset);
    assert_eq!(reserve_after_repay.total_balance, 1_120_000);
    assert!(reserve_after_repay.total_balance >= 1_060_000);

    client.withdraw(&user, &asset, &1_060_000);

    let position = client.get_position(&user, &asset);
    assert_eq!(position.deposited, 0);
    assert_eq!(position.borrowed, 0);

    let reserve_after_withdraw = client.get_asset_reserve(&asset);
    assert_eq!(reserve_after_withdraw.total_balance, 60_000);
}
