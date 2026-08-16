#![no_std]

mod interest;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Env, Symbol, Vec,
};

/// Increment this only when a contract interface change requires consumers to adapt.
pub const CONTRACT_VERSION: u32 = 3;

/// Increment this only when the serialized `DataKey` or stored value layout changes.
pub const STORAGE_SCHEMA_VERSION: u32 = 3;

/// A compact, stable identifier for the current `DataKey` storage layout.
const STORAGE_SCHEMA_ID: Symbol = symbol_short!("VLENDV3");

/// Queryable metadata describing the contract interface and its storage layout.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ContractMetadata {
    pub contract_version: u32,
    pub storage_schema_version: u32,
    pub storage_schema_id: Symbol,
}

/// Keys and value shapes that make up storage schema `VLENDV3`.
///
/// Instance storage: `AdminSet: Map<Address, bool>`, `MinCollateralRatioBps: u32`,
/// `TimelockLedgers: u64`, `NextActionId: u64`,
/// `PendingAction(u64): PendingAction`, `MaxOracleAge: u64`.
/// Persistent storage: `SupportedAsset(Address): bool`,
/// `Position(Address, Address): Position`, `OraclePrice(Address): i128`,
/// `DepositCap(Address)`/`BorrowCap(Address): i128`,
/// `TotalDeposited(Address)`/`TotalBorrowed(Address): i128`, `Paused: bool`,
/// `InterestState(Address): InterestState`, `OracleLastUpdated(Address): u64`,
/// `OraclePrevPrice(Address): i128`, `OracleMaxChangeBps(Address): u32`,
/// `OracleMinPrice(Address): i128`, and `OracleMaxPrice(Address): i128`.
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    /// The set of privileged addresses; any one of them may act as admin.
    AdminSet,
    /// Timelock delay in ledgers applied to privileged mutations.
    TimelockLedgers,
    /// Monotonic counter that allocates pending-action ids.
    NextActionId,
    /// A proposed, not-yet-executed privileged action, keyed by its id.
    PendingAction(u64),
    MinCollateralRatioBps,
    SupportedAsset(Address),
    AssetReserve(Address),
    Position(Address, Address),
    OraclePrice(Address),
    /// Per-asset deposit cap (max total deposits for this asset)
    DepositCap(Address),
    /// Per-asset borrow cap (max total borrows for this asset)
    BorrowCap(Address),
    /// Total deposited amount for an asset across all users
    TotalDeposited(Address),
    /// Total borrowed amount for an asset across all users
    TotalBorrowed(Address),
    /// Circuit breaker state - paused or not
    Paused,
    /// Time-based interest accrual indexes for an asset
    InterestState(Address),
    /// Timestamp when oracle price was last updated for an asset
    OracleLastUpdated(Address),
    /// Previous oracle price for volatility checking
    OraclePrevPrice(Address),
    /// Maximum allowed price change in basis points per update
    OracleMaxChangeBps(Address),
    /// Minimum allowed oracle price for an asset
    OracleMinPrice(Address),
    /// Maximum allowed oracle price for an asset
    OracleMaxPrice(Address),
    /// Protocol-wide maximum oracle age in seconds
    MaxOracleAge,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Position {
    pub deposited: i128,
    pub borrowed: i128,
    /// interest.rs `supply_index` at this position's last realization
    pub supply_index_snapshot: i128,
    /// interest.rs `borrow_index` at this position's last realization
    pub borrow_index_snapshot: i128,
}

/// Time-based interest accrual state for one asset. See `interest.rs` for
/// the accrual math. `supply_index`/`borrow_index` are fixed-point
/// (interest::RATE_SCALE = 1.0x).
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct InterestState {
    pub supply_index: i128,
    pub borrow_index: i128,
    pub last_accrual_timestamp: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AssetCaps {
    pub deposit_cap: i128,
    pub borrow_cap: i128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AssetReserve {
    pub total_balance: i128,
    pub protocol_fees: i128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum ReserveUpdateKind {
    ConfigureAsset,
    Deposit,
    Borrow,
    Repay,
    Withdraw,
    FeeAccrual,
    InterestAccrual,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VeilLendError {
    /// Contract has already been initialized
    AlreadyInitialized = 1,
    /// Caller is not the admin
    Unauthorized = 2,
    /// Asset is not supported by the protocol
    UnsupportedAsset = 3,
    /// Amount must be positive (non-zero)
    InvalidAmount = 4,
    /// Collateral ratio below minimum after operation
    InsufficientCollateral = 5,
    /// Withdraw amount exceeds deposited balance
    InsufficientDeposit = 6,
    /// Repay amount exceeds outstanding borrowed balance
    RepayTooLarge = 7,
    /// Minimum collateral ratio is below 100% (10_000 bps)
    InvalidCollateralRatio = 8,
    /// Contract has not been initialized yet
    NotInitialized = 9,
    /// Amount of zero is not allowed
    ZeroAmount = 10,
    /// Oracle price not configured for the asset
    OraclePriceMissing = 11,
    /// Operation blocked: contract is paused
    ContractPaused = 12,
    /// Deposit cap would be exceeded
    DepositCapExceeded = 13,
    /// Borrow cap would be exceeded
    BorrowCapExceeded = 14,
    /// Invalid cap value (must be positive or -1 for unlimited)
    InvalidCap = 15,
    /// Circuit breaker triggered - asset temporarily paused
    CircuitBreakerTriggered = 16,
    /// Reserve balance is too low for the requested action
    InsufficientReserve = 17,
    /// Pending action's timelock window has not elapsed yet
    TimelockNotReady = 18,
    /// No pending action with the given id (or wrong kind)
    UnknownAction = 19,
    /// Cannot remove the last remaining admin
    LastAdminRequired = 20,
    /// Timelock value is outside the allowed range
    InvalidTimelock = 21,
    /// Pausing requires a timelocked proposal (use propose/execute)
    TimelockRequired = 22,
    /// Oracle price is stale (exceeded maximum age)
    OraclePriceStale = 23,
    /// Oracle price change exceeds maximum allowed change
    OraclePriceChangeExceedsLimit = 24,
    /// Oracle price is below minimum allowed price
    OraclePriceBelowMin = 25,
    /// Oracle price is above maximum allowed price
    OraclePriceAboveMax = 26,
}

#[contractevent(topics = ["veillend", "asset_configured"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetConfigured {
    #[topic]
    pub admin: Address,
    #[topic]
    pub asset: Address,
    pub supported: bool,
}

#[contractevent(topics = ["veillend", "deposit"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DepositEvent {
    #[topic]
    pub user: Address,
    #[topic]
    pub asset: Address,
    pub amount: i128,
}

#[contractevent(topics = ["veillend", "borrow"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BorrowEvent {
    #[topic]
    pub user: Address,
    #[topic]
    pub asset: Address,
    pub amount: i128,
}

#[contractevent(topics = ["veillend", "repay"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepayEvent {
    #[topic]
    pub user: Address,
    #[topic]
    pub asset: Address,
    pub amount: i128,
}

#[contractevent(topics = ["veillend", "withdraw"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawEvent {
    #[topic]
    pub user: Address,
    #[topic]
    pub asset: Address,
    pub amount: i128,
}

#[contractevent(topics = ["veillend", "caps_updated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapsUpdated {
    #[topic]
    pub admin: Address,
    #[topic]
    pub asset: Address,
    pub deposit_cap: i128,
    pub borrow_cap: i128,
}

#[contractevent(topics = ["veillend", "circuit_breaker"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CircuitBreakerEvent {
    #[topic]
    pub admin: Address,
    pub paused: bool,
}

#[contractevent(topics = ["veillend", "asset_reserve_updated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetReserveUpdated {
    #[topic]
    pub asset: Address,
    pub total_balance: i128,
    pub protocol_fees: i128,
    pub kind: ReserveUpdateKind,
}

#[contractevent(topics = ["veillend", "admin_added"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminAdded {
    #[topic]
    pub admin: Address,
    #[topic]
    pub new_admin: Address,
}

#[contract]
pub struct VeilLendContract;

#[contractimpl]
impl VeilLendContract {
    /// Returns the interface and storage metadata for this deployed contract shape.
    ///
    /// Clients should read this before assuming a storage layout during migrations.
    pub fn contract_metadata(_env: Env) -> ContractMetadata {
        ContractMetadata {
            contract_version: CONTRACT_VERSION,
            storage_schema_version: STORAGE_SCHEMA_VERSION,
            storage_schema_id: STORAGE_SCHEMA_ID,
        }
    }

    pub fn __constructor(env: Env, admin: Address, min_collateral_ratio_bps: u32) {
        // Authenticate first, before any storage read or write, so random
        // callers cannot probe initialization state without signing as the
        // admin they claim to be.
        admin.require_auth();

        if env.storage().instance().has(&DataKey::AdminSet) {
            panic_with_error!(&env, VeilLendError::AlreadyInitialized);
        }
        if min_collateral_ratio_bps < 10_000 {
            panic_with_error!(&env, VeilLendError::InvalidCollateralRatio);
        }

        // Founding admin is written into a single-element AdminSet.
        let mut admins = Vec::new(&env);
        admins.push_back(admin);
        env.storage().instance().set(&DataKey::AdminSet, &admins);

        env.storage()
            .instance()
            .set(&DataKey::MinCollateralRatioBps, &min_collateral_ratio_bps);

        // Initialize circuit breaker as not paused
        env.storage().persistent().set(&DataKey::Paused, &false);

        // Initialize default max oracle age to 86400 seconds (1 day)
        env.storage()
            .instance()
            .set(&DataKey::MaxOracleAge, &86400u64);
    }

    /// Adds `new_admin` to the admin set. Callable only by a current admin.
    pub fn add_admin(env: Env, caller: Address, new_admin: Address) {
        Self::require_admin(&env, &caller);
        caller.require_auth();

        let mut admins = Self::read_admin_set(&env);
        if !admins.contains(&new_admin) {
            admins.push_back(new_admin.clone());
            Self::write_admin_set(&env, &admins);
        }

        AdminAdded {
            admin: caller,
            new_admin,
        }
        .publish(&env);
    }

    pub fn configure_asset(env: Env, admin: Address, asset: Address, supported: bool) {
        Self::require_admin(&env, &admin);
        admin.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::SupportedAsset(asset.clone()), &supported);

        // Initialize caps to unlimited (-1) when adding new asset
        if supported {
            env.storage()
                .persistent()
                .set(&DataKey::DepositCap(asset.clone()), &-1i128);
            env.storage()
                .persistent()
                .set(&DataKey::BorrowCap(asset.clone()), &-1i128);

            // Initialize totals to 0
            env.storage()
                .persistent()
                .set(&DataKey::TotalDeposited(asset.clone()), &0i128);
            env.storage()
                .persistent()
                .set(&DataKey::TotalBorrowed(asset.clone()), &0i128);
        }

        AssetConfigured {
            admin,
            asset: asset.clone(),
            supported,
        }
        .publish(&env);

        if supported {
            let reserve = Self::read_asset_reserve(&env, &asset);
            Self::write_asset_reserve(&env, &asset, &reserve);
            Self::publish_asset_reserve_updated(
                &env,
                &asset,
                &reserve,
                ReserveUpdateKind::ConfigureAsset,
            );
        }
    }

    /// Set the oracle price for a supported asset (admin only)
    ///
    /// This function allows the admin to set the price of an asset as reported by an oracle.
    /// The price is used in collateral calculations to determine borrowing power.
    /// Enforces staleness tracking, volatility limits, and absolute bounds.
    ///
    /// # Arguments
    /// * `admin` - The admin address (must be in admin set)
    /// * `asset` - The asset address to set the price for
    /// * `price` - The oracle price (must be positive, in base units e.g., cents)
    pub fn set_oracle_price(env: Env, admin: Address, asset: Address, price: i128) {
        Self::require_admin(&env, &admin);
        admin.require_auth();

        if price <= 0 {
            panic_with_error!(&env, VeilLendError::InvalidAmount);
        }

        // Get current price for volatility checking
        let current_price_opt = env
            .storage()
            .persistent()
            .get::<DataKey, i128>(&DataKey::OraclePrice(asset.clone()));

        // Check max change if configured (before bounds, check against current price)
        if let Some(max_change_bps) = env
            .storage()
            .persistent()
            .get::<DataKey, u32>(&DataKey::OracleMaxChangeBps(asset.clone()))
        {
            if max_change_bps > 0 {
                if let Some(current_price) = current_price_opt {
                    if current_price > 0 {
                        let change = if price > current_price {
                            price - current_price
                        } else {
                            current_price - price
                        };
                        let change_bps = (change * 10_000) / current_price;
                        if change_bps > max_change_bps as i128 {
                            panic_with_error!(&env, VeilLendError::OraclePriceChangeExceedsLimit);
                        }
                    }
                }
            }
        }

        // Check absolute price bounds if configured (after volatility check)
        if let Some(min_price) = env
            .storage()
            .persistent()
            .get::<DataKey, i128>(&DataKey::OracleMinPrice(asset.clone()))
        {
            if price < min_price {
                panic_with_error!(&env, VeilLendError::OraclePriceBelowMin);
            }
        }

        if let Some(max_price) = env
            .storage()
            .persistent()
            .get::<DataKey, i128>(&DataKey::OracleMaxPrice(asset.clone()))
        {
            if price > max_price {
                panic_with_error!(&env, VeilLendError::OraclePriceAboveMax);
            }
        }

        // Store previous price for audit trail
        if let Some(current_price) = current_price_opt {
            env.storage()
                .persistent()
                .set(&DataKey::OraclePrevPrice(asset.clone()), &current_price);
        }

        // Set the new price
        env.storage()
            .persistent()
            .set(&DataKey::OraclePrice(asset.clone()), &price);

        // Update timestamp
        let now = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::OracleLastUpdated(asset.clone()), &now);
    }

    /// Get the oracle price for an asset
    ///
    /// Returns the oracle price for the specified asset if set, otherwise None.
    ///
    /// # Arguments
    /// * `asset` - The asset address to get the price for
    ///
    /// # Returns
    /// * `Option<i128>` - The oracle price if set, None otherwise
    pub fn get_oracle_price(env: Env, asset: Address) -> Option<i128> {
        env.storage().persistent().get(&DataKey::OraclePrice(asset))
    }

    /// Get the oracle price with age in seconds
    ///
    /// Returns both the oracle price and how many seconds ago it was last updated.
    ///
    /// # Arguments
    /// * `asset` - The asset address to get the price for
    ///
    /// # Returns
    /// * `Option<(i128, u64)>` - Tuple of (price, age_in_seconds) if price is set, None otherwise
    pub fn get_oracle_price_with_age(env: Env, asset: Address) -> Option<(i128, u64)> {
        let price = env
            .storage()
            .persistent()
            .get(&DataKey::OraclePrice(asset.clone()))?;
        let last_updated = env
            .storage()
            .persistent()
            .get(&DataKey::OracleLastUpdated(asset.clone()))
            .unwrap_or(0);
        let now = env.ledger().timestamp();
        let age = if now > last_updated {
            now - last_updated
        } else {
            0
        };
        Some((price, age))
    }

    /// Set the protocol-wide maximum oracle age (admin only)
    ///
    /// Sets how old an oracle price can be before it's considered stale.
    /// Default is 86400 seconds (1 day).
    ///
    /// # Arguments
    /// * `admin` - The admin address (must be in admin set)
    /// * `seconds` - Maximum age in seconds
    pub fn set_max_oracle_age(env: Env, admin: Address, seconds: u64) {
        Self::require_admin(&env, &admin);
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::MaxOracleAge, &seconds);
    }

    /// Get the protocol-wide maximum oracle age
    ///
    /// # Returns
    /// * `u64` - Maximum age in seconds (default 86400)
    pub fn get_max_oracle_age(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::MaxOracleAge)
            .unwrap_or(86400)
    }

    /// Set maximum allowed price change per update for an asset (admin only)
    ///
    /// Sets a volatility breaker to prevent extreme price swings.
    /// A value of 0 disables the check.
    ///
    /// # Arguments
    /// * `admin` - The admin address (must be in admin set)
    /// * `asset` - The asset address
    /// * `max_bps` - Maximum change in basis points (0 to disable)
    pub fn set_oracle_max_change_bps(env: Env, admin: Address, asset: Address, max_bps: u32) {
        Self::require_admin(&env, &admin);
        Self::require_supported_asset(&env, &asset);
        admin.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::OracleMaxChangeBps(asset.clone()), &max_bps);
    }

    /// Set absolute price bounds for an asset (admin only)
    ///
    /// Sets minimum and maximum allowed prices for an asset.
    ///
    /// # Arguments
    /// * `admin` - The admin address (must be in admin set)
    /// * `asset` - The asset address
    /// * `min` - Minimum allowed price
    /// * `max` - Maximum allowed price
    pub fn set_oracle_price_bounds(
        env: Env,
        admin: Address,
        asset: Address,
        min: i128,
        max: i128,
    ) {
        Self::require_admin(&env, &admin);
        Self::require_supported_asset(&env, &asset);
        admin.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::OracleMinPrice(asset.clone()), &min);
        env.storage()
            .persistent()
            .set(&DataKey::OracleMaxPrice(asset.clone()), &max);
    }

    /// Update per-asset deposit and borrow caps (admin only)
    ///
    /// Sets the maximum total deposits and borrows allowed for a specific asset.
    /// A value of -1 means unlimited (no cap).
    ///
    /// # Arguments
    /// * `admin` - The admin address (must match stored admin)
    /// * `asset` - The asset address to update caps for
    /// * `deposit_cap` - Maximum total deposits allowed (-1 for unlimited)
    /// * `borrow_cap` - Maximum total borrows allowed (-1 for unlimited)
    pub fn update_asset_caps(
        env: Env,
        admin: Address,
        asset: Address,
        deposit_cap: i128,
        borrow_cap: i128,
    ) {
        Self::require_admin(&env, &admin);

        // Validate caps: must be -1 (unlimited) or positive
        if deposit_cap != -1 && deposit_cap <= 0 {
            panic_with_error!(&env, VeilLendError::InvalidCap);
        }
        if borrow_cap != -1 && borrow_cap <= 0 {
            panic_with_error!(&env, VeilLendError::InvalidCap);
        }

        // Ensure asset is supported
        Self::require_supported_asset(&env, &asset);

        admin.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::DepositCap(asset.clone()), &deposit_cap);
        env.storage()
            .persistent()
            .set(&DataKey::BorrowCap(asset.clone()), &borrow_cap);

        CapsUpdated {
            admin,
            asset,
            deposit_cap,
            borrow_cap,
        }
        .publish(&env);
    }

    /// Get the current caps for an asset
    ///
    /// # Arguments
    /// * `asset` - The asset address to get caps for
    ///
    /// # Returns
    /// * `AssetCaps` - Struct containing deposit_cap and borrow_cap (-1 for unlimited)
    pub fn get_asset_caps(env: Env, asset: Address) -> AssetCaps {
        let deposit_cap = env
            .storage()
            .persistent()
            .get(&DataKey::DepositCap(asset.clone()))
            .unwrap_or(-1);
        let borrow_cap = env
            .storage()
            .persistent()
            .get(&DataKey::BorrowCap(asset.clone()))
            .unwrap_or(-1);

        AssetCaps {
            deposit_cap,
            borrow_cap,
        }
    }

    /// Get total deposited amount for an asset
    ///
    /// # Arguments
    /// * `asset` - The asset address to get total deposits for
    ///
    /// # Returns
    /// * `i128` - Total deposited amount
    pub fn get_total_deposited(env: Env, asset: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalDeposited(asset))
            .unwrap_or(0)
    }

    /// Get total borrowed amount for an asset
    ///
    /// # Arguments
    /// * `asset` - The asset address to get total borrows for
    ///
    /// # Returns
    /// * `i128` - Total borrowed amount
    pub fn get_total_borrowed(env: Env, asset: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalBorrowed(asset))
            .unwrap_or(0)
    }

    /// Toggle circuit breaker (pause/unpause the contract)
    ///
    /// When paused, all deposit and borrow operations are blocked.
    /// Withdraw and repay operations remain available.
    ///
    /// # Arguments
    /// * `admin` - The admin address (must match stored admin)
    /// * `paused` - true to pause, false to unpause
    pub fn set_paused(env: Env, admin: Address, paused: bool) {
        Self::require_admin(&env, &admin);
        admin.require_auth();
        env.storage().persistent().set(&DataKey::Paused, &paused);

        CircuitBreakerEvent { admin, paused }.publish(&env);
    }

    /// Check if the contract is paused
    ///
    /// # Returns
    /// * `bool` - true if paused, false otherwise
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // This scaffold tracks protocol state first; token transfers and privacy proofs
    // can be layered on top once the Stellar asset integrations are finalized.
    pub fn deposit(env: Env, user: Address, asset: Address, amount: i128) {
        Self::require_not_paused(&env);
        Self::require_supported_asset(&env, &asset);
        Self::require_positive_amount(&env, amount);
        user.require_auth();

        // Accrue interest first so both the cap check below and the totals
        // we write reflect up-to-date, time-aware values.
        let interest_state = Self::accrue_and_persist_interest(&env, &asset);

        // Check deposit cap
        Self::check_deposit_cap(&env, &asset, amount);

        let mut position = interest::compute_accrued_position(
            &Self::read_position(&env, &user, &asset),
            &interest_state,
        );
        let mut reserve = Self::read_asset_reserve(&env, &asset);
        position.deposited += amount;
        reserve.total_balance += amount;
        Self::write_position(&env, &user, &asset, &position);
        Self::write_asset_reserve(&env, &asset, &reserve);

        // Update total deposits
        let total = Self::get_total_deposited(env.clone(), asset.clone()) + amount;
        env.storage()
            .persistent()
            .set(&DataKey::TotalDeposited(asset.clone()), &total);

        DepositEvent {
            user,
            asset: asset.clone(),
            amount,
        }
        .publish(&env);
        Self::publish_asset_reserve_updated(&env, &asset, &reserve, ReserveUpdateKind::Deposit);
    }

    pub fn borrow(env: Env, user: Address, asset: Address, amount: i128) {
        Self::require_not_paused(&env);
        Self::require_supported_asset(&env, &asset);
        Self::require_positive_amount(&env, amount);
        user.require_auth();

        // Accrue interest first so both the cap check below and the totals
        // we write reflect up-to-date, time-aware values.
        let interest_state = Self::accrue_and_persist_interest(&env, &asset);

        // Check borrow cap
        Self::check_borrow_cap(&env, &asset, amount);

        let mut position = interest::compute_accrued_position(
            &Self::read_position(&env, &user, &asset),
            &interest_state,
        );
        let mut reserve = Self::read_asset_reserve(&env, &asset);
        if amount > reserve.total_balance {
            panic_with_error!(&env, VeilLendError::InsufficientReserve);
        }
        position.borrowed += amount;
        reserve.total_balance -= amount;
        Self::assert_collateralized(&env, &user, &asset, &position);
        Self::write_position(&env, &user, &asset, &position);
        Self::write_asset_reserve(&env, &asset, &reserve);

        // Update total borrows
        let total = Self::get_total_borrowed(env.clone(), asset.clone()) + amount;
        env.storage()
            .persistent()
            .set(&DataKey::TotalBorrowed(asset.clone()), &total);

        BorrowEvent {
            user,
            asset: asset.clone(),
            amount,
        }
        .publish(&env);
        Self::publish_asset_reserve_updated(&env, &asset, &reserve, ReserveUpdateKind::Borrow);
    }

    pub fn repay(env: Env, user: Address, asset: Address, amount: i128) {
        // Repay is allowed even when paused (users can always reduce debt)
        Self::require_supported_asset(&env, &asset);
        Self::require_positive_amount(&env, amount);
        user.require_auth();

        let interest_state = Self::accrue_and_persist_interest(&env, &asset);

        let mut position = interest::compute_accrued_position(
            &Self::read_position(&env, &user, &asset),
            &interest_state,
        );
        let mut reserve = Self::read_asset_reserve(&env, &asset);
        if amount > position.borrowed {
            panic_with_error!(&env, VeilLendError::RepayTooLarge);
        }

        position.borrowed -= amount;
        reserve.total_balance += amount;
        Self::write_position(&env, &user, &asset, &position);
        Self::write_asset_reserve(&env, &asset, &reserve);

        // Update total borrows
        let total = Self::get_total_borrowed(env.clone(), asset.clone()) - amount;
        env.storage()
            .persistent()
            .set(&DataKey::TotalBorrowed(asset.clone()), &total);

        RepayEvent {
            user,
            asset: asset.clone(),
            amount,
        }
        .publish(&env);
        Self::publish_asset_reserve_updated(&env, &asset, &reserve, ReserveUpdateKind::Repay);
    }

    pub fn withdraw(env: Env, user: Address, asset: Address, amount: i128) {
        // Withdraw is allowed even when paused (users can always remove collateral)
        Self::require_supported_asset(&env, &asset);
        Self::require_positive_amount(&env, amount);
        user.require_auth();

        let interest_state = Self::accrue_and_persist_interest(&env, &asset);

        let mut position = interest::compute_accrued_position(
            &Self::read_position(&env, &user, &asset),
            &interest_state,
        );
        let mut reserve = Self::read_asset_reserve(&env, &asset);
        if amount > position.deposited {
            panic_with_error!(&env, VeilLendError::InsufficientDeposit);
        }
        if amount > reserve.total_balance {
            panic_with_error!(&env, VeilLendError::InsufficientReserve);
        }

        position.deposited -= amount;
        reserve.total_balance -= amount;
        Self::assert_collateralized(&env, &user, &asset, &position);
        Self::write_position(&env, &user, &asset, &position);
        Self::write_asset_reserve(&env, &asset, &reserve);

        // Update total deposits
        let total = Self::get_total_deposited(env.clone(), asset.clone()) - amount;
        env.storage()
            .persistent()
            .set(&DataKey::TotalDeposited(asset.clone()), &total);

        WithdrawEvent {
            user,
            asset: asset.clone(),
            amount,
        }
        .publish(&env);
        Self::publish_asset_reserve_updated(&env, &asset, &reserve, ReserveUpdateKind::Withdraw);
    }

    /// Returns a user's position with any interest accrued since their last
    /// interaction simulated in, without persisting anything. The official
    /// on-chain indexes only advance when a mutating entrypoint (deposit,
    /// borrow, repay, withdraw, or accrue_interest) is called.
    pub fn get_position(env: Env, user: Address, asset: Address) -> Position {
        let state = Self::simulate_accrued_interest_state(&env, &asset);
        interest::compute_accrued_position(&Self::read_position(&env, &user, &asset), &state)
    }

    pub fn get_asset_reserve(env: Env, asset: Address) -> AssetReserve {
        Self::require_supported_asset(&env, &asset);
        Self::read_asset_reserve(&env, &asset)
    }

    /// Returns this asset's time-based interest accrual state (indexes and
    /// last-accrual timestamp) with interest simulated up to the current
    /// ledger time, without persisting anything.
    pub fn get_interest_state(env: Env, asset: Address) -> InterestState {
        Self::simulate_accrued_interest_state(&env, &asset)
    }

    /// Forces a reserve-level interest accrual and persists it, without
    /// touching any individual position. Callable by anyone — accrual is a
    /// pure function of elapsed time and current state, not a privileged
    /// action.
    pub fn accrue_interest(env: Env, asset: Address) {
        Self::require_supported_asset(&env, &asset);
        Self::accrue_and_persist_interest(&env, &asset);

        let reserve = Self::read_asset_reserve(&env, &asset);
        Self::publish_asset_reserve_updated(
            &env,
            &asset,
            &reserve,
            ReserveUpdateKind::InterestAccrual,
        );
    }

    pub fn is_asset_supported(env: Env, asset: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::SupportedAsset(asset))
            .unwrap_or(false)
    }

    pub fn record_protocol_fee(env: Env, admin: Address, asset: Address, amount: i128) {
        Self::require_admin(&env, &admin);

        Self::require_supported_asset(&env, &asset);
        Self::require_positive_amount(&env, amount);
        admin.require_auth();

        // Keep the interest clock fresh even on admin-only fee recording.
        Self::accrue_and_persist_interest(&env, &asset);

        let mut reserve = Self::read_asset_reserve(&env, &asset);
        reserve.total_balance += amount;
        reserve.protocol_fees += amount;
        Self::write_asset_reserve(&env, &asset, &reserve);
        Self::publish_asset_reserve_updated(&env, &asset, &reserve, ReserveUpdateKind::FeeAccrual);
    }

    pub fn min_collateral_ratio_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MinCollateralRatioBps)
            .unwrap_or(15_000)
    }
}

impl VeilLendContract {
    fn read_admin_set(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::AdminSet)
            .unwrap_or_else(|| Vec::new(env))
    }

    fn write_admin_set(env: &Env, admins: &Vec<Address>) {
        env.storage().instance().set(&DataKey::AdminSet, admins);
    }

    /// Panics with `Unauthorized` if `caller` is not in the admin set.
    fn require_admin(env: &Env, caller: &Address) {
        if !Self::read_admin_set(env).contains(caller) {
            panic_with_error!(env, VeilLendError::Unauthorized);
        }
    }

    fn read_asset_reserve(env: &Env, asset: &Address) -> AssetReserve {
        env.storage()
            .persistent()
            .get(&DataKey::AssetReserve(asset.clone()))
            .unwrap_or(AssetReserve {
                total_balance: 0,
                protocol_fees: 0,
            })
    }

    fn write_asset_reserve(env: &Env, asset: &Address, reserve: &AssetReserve) {
        env.storage()
            .persistent()
            .set(&DataKey::AssetReserve(asset.clone()), reserve);
    }

    fn publish_asset_reserve_updated(
        env: &Env,
        asset: &Address,
        reserve: &AssetReserve,
        kind: ReserveUpdateKind,
    ) {
        AssetReserveUpdated {
            asset: asset.clone(),
            total_balance: reserve.total_balance,
            protocol_fees: reserve.protocol_fees,
            kind,
        }
        .publish(env);
    }

    fn read_position(env: &Env, user: &Address, asset: &Address) -> Position {
        env.storage()
            .persistent()
            .get(&DataKey::Position(user.clone(), asset.clone()))
            .unwrap_or(Position {
                deposited: 0,
                borrowed: 0,
                supply_index_snapshot: interest::RATE_SCALE,
                borrow_index_snapshot: interest::RATE_SCALE,
            })
    }

    fn read_interest_state(env: &Env, asset: &Address) -> InterestState {
        env.storage()
            .persistent()
            .get(&DataKey::InterestState(asset.clone()))
            .unwrap_or(InterestState {
                supply_index: interest::RATE_SCALE,
                borrow_index: interest::RATE_SCALE,
                last_accrual_timestamp: env.ledger().timestamp(),
            })
    }

    fn write_interest_state(env: &Env, asset: &Address, state: &InterestState) {
        env.storage()
            .persistent()
            .set(&DataKey::InterestState(asset.clone()), state);
    }

    /// Accrues time-based interest for `asset`'s reserve, persisting the
    /// updated interest indexes and applying accrued interest to the
    /// aggregate `TotalDeposited`/`TotalBorrowed` totals. Does not touch any
    /// individual position — callers that need a specific position's
    /// balances to reflect accrual must additionally realize that position
    /// via `interest::compute_accrued_position` against the returned state.
    ///
    /// Must be called before any cap check or balance mutation in every
    /// entrypoint that reads/writes reserve state, so caps are enforced
    /// against up-to-date totals and totals never drift from reality.
    fn accrue_and_persist_interest(env: &Env, asset: &Address) -> InterestState {
        let state = Self::read_interest_state(env, asset);
        let total_supplied = Self::get_total_deposited(env.clone(), asset.clone());
        let total_borrowed = Self::get_total_borrowed(env.clone(), asset.clone());
        let now = env.ledger().timestamp();

        let result = interest::compute_accrual(&state, total_supplied, total_borrowed, now);

        Self::write_interest_state(env, asset, &result.state);
        if result.interest_to_suppliers != 0 {
            env.storage().persistent().set(
                &DataKey::TotalDeposited(asset.clone()),
                &(total_supplied + result.interest_to_suppliers),
            );
        }
        if result.interest_to_borrowers != 0 {
            env.storage().persistent().set(
                &DataKey::TotalBorrowed(asset.clone()),
                &(total_borrowed + result.interest_to_borrowers),
            );
        }

        result.state
    }

    /// Like `accrue_and_persist_interest`, but purely computed — does not
    /// write anything to storage. Used by read-only view functions so
    /// callers always see live, accurate current state between transactions.
    fn simulate_accrued_interest_state(env: &Env, asset: &Address) -> InterestState {
        let state = Self::read_interest_state(env, asset);
        let total_supplied = Self::get_total_deposited(env.clone(), asset.clone());
        let total_borrowed = Self::get_total_borrowed(env.clone(), asset.clone());
        let now = env.ledger().timestamp();

        interest::compute_accrual(&state, total_supplied, total_borrowed, now).state
    }

    fn write_position(env: &Env, user: &Address, asset: &Address, position: &Position) {
        env.storage()
            .persistent()
            .set(&DataKey::Position(user.clone(), asset.clone()), position);
    }

    fn require_supported_asset(env: &Env, asset: &Address) {
        let is_supported = env
            .storage()
            .persistent()
            .get(&DataKey::SupportedAsset(asset.clone()))
            .unwrap_or(false);

        if !is_supported {
            panic_with_error!(env, VeilLendError::UnsupportedAsset);
        }
    }

    fn require_positive_amount(env: &Env, amount: i128) {
        if amount == 0 {
            panic_with_error!(env, VeilLendError::ZeroAmount);
        }
        if amount < 0 {
            panic_with_error!(env, VeilLendError::InvalidAmount);
        }
    }

    fn require_not_paused(env: &Env) {
        let paused: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            panic_with_error!(env, VeilLendError::ContractPaused);
        }
    }

    fn check_deposit_cap(env: &Env, asset: &Address, amount: i128) {
        let cap = env
            .storage()
            .persistent()
            .get(&DataKey::DepositCap(asset.clone()))
            .unwrap_or(-1);

        // -1 means unlimited
        if cap == -1 {
            return;
        }

        let current_total = env
            .storage()
            .persistent()
            .get(&DataKey::TotalDeposited(asset.clone()))
            .unwrap_or(0);

        if current_total + amount > cap {
            panic_with_error!(env, VeilLendError::DepositCapExceeded);
        }
    }

    fn check_borrow_cap(env: &Env, asset: &Address, amount: i128) {
        let cap = env
            .storage()
            .persistent()
            .get(&DataKey::BorrowCap(asset.clone()))
            .unwrap_or(-1);

        // -1 means unlimited
        if cap == -1 {
            return;
        }

        let current_total = env
            .storage()
            .persistent()
            .get(&DataKey::TotalBorrowed(asset.clone()))
            .unwrap_or(0);

        if current_total + amount > cap {
            panic_with_error!(env, VeilLendError::BorrowCapExceeded);
        }
    }

    fn assert_collateralized(env: &Env, _user: &Address, asset: &Address, position: &Position) {
        if position.borrowed == 0 {
            return;
        }

        let collateral_ratio_bps = Self::min_collateral_ratio_bps(env.clone()) as i128;

        // Get oracle price for the asset — fail explicitly if not set
        let price: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::OraclePrice(asset.clone()))
            .unwrap_or_else(|| panic_with_error!(env, VeilLendError::OraclePriceMissing));

        // Check price staleness
        if let Some(last_updated) = env
            .storage()
            .persistent()
            .get::<DataKey, u64>(&DataKey::OracleLastUpdated(asset.clone()))
        {
            let now = env.ledger().timestamp();
            let max_age = env
                .storage()
                .instance()
                .get(&DataKey::MaxOracleAge)
                .unwrap_or(86400u64);

            if now > last_updated && (now - last_updated) > max_age {
                panic_with_error!(env, VeilLendError::OraclePriceStale);
            }
        }

        // Calculate collateral value using oracle price
        let collateral_value = position.deposited * price;
        let borrowed_value = position.borrowed * price;

        if collateral_value * 10_000 < borrowed_value * collateral_ratio_bps {
            panic_with_error!(env, VeilLendError::InsufficientCollateral);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_position_creation() {
        let position = Position {
            deposited: 1000,
            borrowed: 500,
            supply_index_snapshot: interest::RATE_SCALE,
            borrow_index_snapshot: interest::RATE_SCALE,
        };
        assert_eq!(position.deposited, 1000);
        assert_eq!(position.borrowed, 500);
    }

    #[test]
    fn test_asset_reserve_creation() {
        let reserve = AssetReserve {
            total_balance: 1000,
            protocol_fees: 25,
        };
        assert_eq!(reserve.total_balance, 1000);
        assert_eq!(reserve.protocol_fees, 25);
    }

    #[test]
    fn test_error_codes() {
        assert_eq!(VeilLendError::AlreadyInitialized as u32, 1);
        assert_eq!(VeilLendError::Unauthorized as u32, 2);
        assert_eq!(VeilLendError::UnsupportedAsset as u32, 3);
        assert_eq!(VeilLendError::InvalidAmount as u32, 4);
        assert_eq!(VeilLendError::InsufficientCollateral as u32, 5);
        assert_eq!(VeilLendError::InsufficientDeposit as u32, 6);
        assert_eq!(VeilLendError::RepayTooLarge as u32, 7);
        assert_eq!(VeilLendError::InvalidCollateralRatio as u32, 8);
        assert_eq!(VeilLendError::NotInitialized as u32, 9);
        assert_eq!(VeilLendError::ZeroAmount as u32, 10);
        assert_eq!(VeilLendError::OraclePriceMissing as u32, 11);
        assert_eq!(VeilLendError::ContractPaused as u32, 12);
        assert_eq!(VeilLendError::DepositCapExceeded as u32, 13);
        assert_eq!(VeilLendError::BorrowCapExceeded as u32, 14);
        assert_eq!(VeilLendError::InvalidCap as u32, 15);
        assert_eq!(VeilLendError::CircuitBreakerTriggered as u32, 16);
        assert_eq!(VeilLendError::InsufficientReserve as u32, 17);
        assert_eq!(VeilLendError::TimelockNotReady as u32, 18);
        assert_eq!(VeilLendError::UnknownAction as u32, 19);
        assert_eq!(VeilLendError::LastAdminRequired as u32, 20);
        assert_eq!(VeilLendError::InvalidTimelock as u32, 21);
        assert_eq!(VeilLendError::TimelockRequired as u32, 22);
        assert_eq!(VeilLendError::OraclePriceStale as u32, 23);
        assert_eq!(VeilLendError::OraclePriceChangeExceedsLimit as u32, 24);
        assert_eq!(VeilLendError::OraclePriceBelowMin as u32, 25);
        assert_eq!(VeilLendError::OraclePriceAboveMax as u32, 26);
    }

    #[test]
    fn test_contract_metadata_identifies_current_storage_shape() {
        let metadata = VeilLendContract::contract_metadata(Env::default());

        assert_eq!(metadata.contract_version, 3);
        assert_eq!(metadata.storage_schema_version, 3);
        assert_eq!(metadata.storage_schema_id, symbol_short!("VLENDV3"));
    }

    #[test]
    fn test_error_variants_are_unique() {
        // Ensure no two variants share the same code
        let codes = [
            VeilLendError::AlreadyInitialized as u32,
            VeilLendError::Unauthorized as u32,
            VeilLendError::UnsupportedAsset as u32,
            VeilLendError::InvalidAmount as u32,
            VeilLendError::InsufficientCollateral as u32,
            VeilLendError::InsufficientDeposit as u32,
            VeilLendError::RepayTooLarge as u32,
            VeilLendError::InvalidCollateralRatio as u32,
            VeilLendError::NotInitialized as u32,
            VeilLendError::ZeroAmount as u32,
            VeilLendError::OraclePriceMissing as u32,
            VeilLendError::ContractPaused as u32,
            VeilLendError::DepositCapExceeded as u32,
            VeilLendError::BorrowCapExceeded as u32,
            VeilLendError::InvalidCap as u32,
            VeilLendError::CircuitBreakerTriggered as u32,
            VeilLendError::InsufficientReserve as u32,
            VeilLendError::TimelockNotReady as u32,
            VeilLendError::UnknownAction as u32,
            VeilLendError::LastAdminRequired as u32,
            VeilLendError::InvalidTimelock as u32,
            VeilLendError::TimelockRequired as u32,
            VeilLendError::OraclePriceStale as u32,
            VeilLendError::OraclePriceChangeExceedsLimit as u32,
            VeilLendError::OraclePriceBelowMin as u32,
            VeilLendError::OraclePriceAboveMax as u32,
        ];
        let mut sorted = codes.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), codes.len(), "Duplicate error codes detected");
    }

    #[test]
    fn test_zero_amount_distinct_from_invalid() {
        // Zero and negative amounts should produce different errors
        assert_ne!(
            VeilLendError::ZeroAmount as u32,
            VeilLendError::InvalidAmount as u32,
            "ZeroAmount and InvalidAmount must be distinct error codes"
        );
    }

    #[test]
    fn test_not_initialized_distinct_from_unauthorized() {
        // NotInitialized and Unauthorized serve different purposes
        assert_ne!(
            VeilLendError::NotInitialized as u32,
            VeilLendError::Unauthorized as u32,
            "NotInitialized and Unauthorized must be distinct error codes"
        );
    }
}
