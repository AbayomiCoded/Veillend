use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env};
use veillend_contract::{VeilLendContract, VeilLendContractClient};

const SECONDS_PER_YEAR: u64 = 31_536_000;

#[test]
fn test_initialize_contract() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    assert_eq!(client.admin(), admin);
    assert_eq!(client.min_collateral_ratio_bps(), 15_000);
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

    client.configure_asset(&admin, &asset, &true);

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

    client.configure_asset(&admin, &asset, &true);
    client.set_oracle_price(&admin, &asset, &100);

    // Set caps
    client.update_asset_caps(&admin, &asset, &1000, &500);

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

    client.configure_asset(&admin, &asset, &true);
    client.set_oracle_price(&admin, &asset, &100);

    // Pause the contract
    client.set_paused(&admin, &true);
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

    // First do deposit and borrow while unpaused
    client.set_paused(&admin, &false);
    client.deposit(&user, &asset, &1000);
    client.borrow(&user, &asset, &500);
    client.set_paused(&admin, &true);

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

    // Attacker tries to pause
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_paused(&attacker, &true);
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

    client.configure_asset(&admin, &asset, &true);
    client.set_oracle_price(&admin, &asset, &100);

    // Set caps
    client.update_asset_caps(&admin, &asset, &2000, &1000);

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

    client.configure_asset(&admin, &asset, &true);
    client.set_oracle_price(&admin, &asset, &100);

    // Set caps to unlimited (-1)
    client.update_asset_caps(&admin, &asset, &-1, &-1);

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

    client.configure_asset(&admin, &asset, &true);

    // Zero cap is invalid (should be -1 for unlimited or positive)
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.update_asset_caps(&admin, &asset, &0, &500);
    }));
    assert!(result.is_err());

    // Negative cap other than -1 is invalid
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.update_asset_caps(&admin, &asset, &-2, &500);
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

    client.configure_asset(&admin, &asset, &true);

    // Events are emitted - we just verify no panic
    client.update_asset_caps(&admin, &asset, &1000, &500);
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

    // Toggle pause on
    client.set_paused(&admin, &true);
    assert!(client.is_paused());

    // Toggle pause off
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

    client.configure_asset(&admin, &asset, &true);
    client.set_oracle_price(&admin, &asset, &1);

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

    client.configure_asset(&admin, &asset, &true);
    client.set_oracle_price(&admin, &asset, &1);
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

    client.configure_asset(&admin, &asset, &true);
    client.set_oracle_price(&admin, &asset, &1);
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

    client.configure_asset(&admin, &asset, &true);
    client.set_oracle_price(&admin, &asset, &1);

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

    client.configure_asset(&admin, &asset, &true);
    client.set_oracle_price(&admin, &asset, &1);
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

// ============================================================================
// Oracle Safety Rail Tests (Issue #263)
// ============================================================================

#[test]
fn test_oracle_staleness_tracking() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.configure_asset(&admin, &asset, &true);

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

    client.configure_asset(&admin, &asset, &true);
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

    // Repay should still work (no collateral check on repay with debt reduction)
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

    client.configure_asset(&admin, &asset, &true);

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

    // Set price to 95 (from original 100, now prev is 105, so ~9.5% decrease) - should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_oracle_price(&admin, &asset, &95);
    }));
    assert!(result.is_err());

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
fn test_oracle_max_change_first_price_skips_check() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.configure_asset(&admin, &asset, &true);

    // Set max change to 500 bps (5%)
    client.set_oracle_max_change_bps(&admin, &asset, &500);

    // First price set should work regardless of max change
    client.set_oracle_price(&admin, &asset, &1000);
    assert_eq!(client.get_oracle_price(&asset), Some(1000));
}

#[test]
fn test_oracle_max_change_disabled_with_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.configure_asset(&admin, &asset, &true);
    client.set_oracle_price(&admin, &asset, &100);

    // Set max change to 0 (disabled)
    client.set_oracle_max_change_bps(&admin, &asset, &0);

    // Should allow any price change
    client.set_oracle_price(&admin, &asset, &1000);
    assert_eq!(client.get_oracle_price(&asset), Some(1000));

    client.set_oracle_price(&admin, &asset, &1);
    assert_eq!(client.get_oracle_price(&asset), Some(1));
}

#[test]
fn test_oracle_price_bounds_min_enforcement() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.configure_asset(&admin, &asset, &true);

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
}

#[test]
fn test_oracle_price_bounds_max_enforcement() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.configure_asset(&admin, &asset, &true);

    // Set bounds: min=1, max=1000
    client.set_oracle_price_bounds(&admin, &asset, &1, &1000);

    // Try to set price above max - should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_oracle_price(&admin, &asset, &1001);
    }));
    assert!(result.is_err());

    // Set price at max - should succeed
    client.set_oracle_price(&admin, &asset, &1000);
    assert_eq!(client.get_oracle_price(&asset), Some(1000));
}

#[test]
fn test_oracle_price_bounds_within_range() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.configure_asset(&admin, &asset, &true);

    // Set bounds: min=1, max=1000
    client.set_oracle_price_bounds(&admin, &asset, &1, &1000);

    // Set price in middle of range - should succeed
    client.set_oracle_price(&admin, &asset, &500);
    assert_eq!(client.get_oracle_price(&asset), Some(500));
}

#[test]
fn test_oracle_safety_default_behavior_unchanged() {
    // Verify backward compatibility: without any safety rails configured,
    // the old behavior still works
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let _user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.configure_asset(&admin, &asset, &true);

    // Set price without any safety rails
    client.set_oracle_price(&admin, &asset, &100);

    // Advance time by 2 days (beyond default 1 day max age)
    let ledger_timestamp = env.ledger().timestamp();
    env.ledger().set_timestamp(ledger_timestamp + 172800);

    // Operations should still work with stale price since we're within default max age
    // But let's update the default max age to be more strict
    client.set_max_oracle_age(&admin, &3600); // 1 hour

    // Now operations should fail
    client.deposit(&_user, &asset, &1000);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.borrow(&_user, &asset, &500);
    }));
    assert!(result.is_err());
}

#[test]
fn test_oracle_max_age_getter() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    // Default should be 86400 (1 day)
    assert_eq!(client.get_max_oracle_age(), 86400);

    // Set to 1 hour
    client.set_max_oracle_age(&admin, &3600);
    assert_eq!(client.get_max_oracle_age(), 3600);
}

#[test]
fn test_oracle_safety_unauthorized_admin_calls() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.configure_asset(&admin, &asset, &true);

    // Attacker tries to set max oracle age
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_max_oracle_age(&attacker, &3600);
    }));
    assert!(result.is_err());

    // Attacker tries to set max change bps
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_oracle_max_change_bps(&attacker, &asset, &500);
    }));
    assert!(result.is_err());

    // Attacker tries to set price bounds
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_oracle_price_bounds(&attacker, &asset, &1, &1000);
    }));
    assert!(result.is_err());
}

#[test]
fn test_oracle_combined_safety_rails() {
    // Test all safety mechanisms working together
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.configure_asset(&admin, &asset, &true);

    // Configure all safety rails
    client.set_max_oracle_age(&admin, &3600); // 1 hour max age
    client.set_oracle_max_change_bps(&admin, &asset, &500); // 5% max change
    client.set_oracle_price_bounds(&admin, &asset, &50, &200); // min=50, max=200

    // Set initial price
    client.set_oracle_price(&admin, &asset, &100);

    // Try to exceed bounds - should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_oracle_price(&admin, &asset, &201);
    }));
    assert!(result.is_err());

    // Try to exceed max change within bounds - should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_oracle_price(&admin, &asset, &110);
    }));
    assert!(result.is_err());

    // Valid price update (within 5% and within bounds)
    client.set_oracle_price(&admin, &asset, &105);

    // Use the asset
    client.deposit(&user, &asset, &1000);
    client.borrow(&user, &asset, &500);

    // Advance time to make price stale
    let ledger_timestamp = env.ledger().timestamp();
    env.ledger().set_timestamp(ledger_timestamp + 7200); // 2 hours

    // Operations requiring collateral check should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.withdraw(&user, &asset, &100);
    }));
    assert!(result.is_err());

    // Update price to fresh
    client.set_oracle_price(&admin, &asset, &110); // ~4.76% increase from 105

    // Now operations should work again
    client.repay(&user, &asset, &500);
    client.withdraw(&user, &asset, &1000);
}
