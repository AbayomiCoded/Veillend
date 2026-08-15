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

// ---------------------------------------------------------------------------
// Admin safety: constructor auth ordering, two-step admin transfer, timelock
// ---------------------------------------------------------------------------

#[test]
fn test_constructor_requires_admin_auth() {
    // No mock_all_auths: the constructor must authenticate `admin` before
    // touching storage, so registration without the admin signature fails.
    let env = Env::default();
    let admin = Address::generate(&env);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(VeilLendContract, (admin.clone(), 15_000u32));
    }));
    assert!(result.is_err());
}

#[test]
fn test_two_step_admin_transfer_success() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    // Nothing is pending until the current admin proposes.
    assert_eq!(client.pending_admin(), None);

    client.propose_admin(&admin, &new_admin);
    assert_eq!(client.pending_admin(), Some(new_admin.clone()));

    // The proposed address accepts and becomes the new admin.
    let old_admin = client.accept_admin(&new_admin);
    assert_eq!(old_admin, admin);
    assert_eq!(client.admin(), new_admin);
    assert_eq!(client.pending_admin(), None);
}

#[test]
fn test_accept_admin_wrong_address_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.propose_admin(&admin, &new_admin);

    // An unrelated address cannot accept the transfer.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.accept_admin(&attacker);
    }));
    assert!(result.is_err());

    // Admin unchanged and the proposal is still pending.
    assert_eq!(client.admin(), admin);
    assert_eq!(client.pending_admin(), Some(new_admin));
}

#[test]
fn test_accept_admin_with_no_pending_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    // No proposal exists — accepting anything must panic.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.accept_admin(&new_admin);
    }));
    assert!(result.is_err());

    assert_eq!(client.admin(), admin);
}

#[test]
fn test_propose_admin_overwrites_pending() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.propose_admin(&admin, &first);
    client.propose_admin(&admin, &second);

    // Only the most recent proposal can accept.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.accept_admin(&first);
    }));
    assert!(result.is_err());

    let old_admin = client.accept_admin(&second);
    assert_eq!(old_admin, admin);
    assert_eq!(client.admin(), second);
}

#[test]
fn test_post_transfer_old_admin_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.propose_admin(&admin, &new_admin);
    client.accept_admin(&new_admin);

    // The old admin loses all privileged access after the transfer.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_paused(&admin, &true);
    }));
    assert!(result.is_err());

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.configure_asset(&admin, &asset, &true);
    }));
    assert!(result.is_err());

    // The new admin is fully empowered.
    client.set_paused(&new_admin, &true);
    assert!(client.is_paused());
}

#[test]
fn test_min_collateral_ratio_immediate_by_default() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    // Timelock defaults to 0 (immediate application, backward compatible).
    assert_eq!(client.admin_timelock_seconds(), 0);

    client.set_min_collateral_ratio(&admin, &20_000);
    assert_eq!(client.min_collateral_ratio_bps(), 20_000);
    assert_eq!(client.pending_min_collateral_ratio(), None);
}

#[test]
fn test_min_collateral_ratio_rejects_below_minimum() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_min_collateral_ratio(&admin, &9_999);
    }));
    assert!(result.is_err());
    assert_eq!(client.min_collateral_ratio_bps(), 15_000);
}

#[test]
fn test_min_collateral_ratio_timelock() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    client.set_timelock(&admin, &3600);
    assert_eq!(client.admin_timelock_seconds(), 3600);

    let start = env.ledger().timestamp();
    client.set_min_collateral_ratio(&admin, &20_000);

    // Scheduled, not applied yet.
    assert_eq!(client.min_collateral_ratio_bps(), 15_000);
    let pending = client.pending_min_collateral_ratio().unwrap();
    assert_eq!(pending.new_ratio_bps, 20_000);
    assert_eq!(pending.executable_timestamp, start + 3600);

    // One second before the timelock elapses: execution fails.
    env.ledger().set_timestamp(start + 3599);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_pending_collateral_ratio();
    }));
    assert!(result.is_err());
    assert_eq!(client.min_collateral_ratio_bps(), 15_000);

    // Timelock elapsed: execution succeeds and clears the pending change.
    env.ledger().set_timestamp(start + 3600);
    client.execute_pending_collateral_ratio();
    assert_eq!(client.min_collateral_ratio_bps(), 20_000);
    assert_eq!(client.pending_min_collateral_ratio(), None);

    // Nothing pending — executing again panics.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_pending_collateral_ratio();
    }));
    assert!(result.is_err());
}

#[test]
fn test_timelock_and_ratio_changes_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let contract_id = env.register(VeilLendContract, (admin.clone(), 15_000u32));
    let client = VeilLendContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_min_collateral_ratio(&attacker, &20_000);
    }));
    assert!(result.is_err());

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_timelock(&attacker, &3600);
    }));
    assert!(result.is_err());

    assert_eq!(client.min_collateral_ratio_bps(), 15_000);
    assert_eq!(client.admin_timelock_seconds(), 0);
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
