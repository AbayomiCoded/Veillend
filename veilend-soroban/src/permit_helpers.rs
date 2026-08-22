//! Permit helper functions for the Veilend contract.

use crate::permit::{compute_permit_digest, DomainSeparator, Permit};
use crate::DataKey;
use soroban_sdk::{contracttype, Address, Bytes, Env, Symbol};

/// A verified permit that has passed signature, deadline, and nonce checks.
///
/// This struct is returned by `verify_and_consume_permit` and contains
/// the validated permit data ready for execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedPermit {
    pub user: Address,
    pub action: Symbol,
    pub asset: Address,
    pub amount: i128,
    pub nonce: u64,
}

/// Verifies a permit and advances the nonce if valid.
///
/// This is the main entry point for permit verification. It:
/// 1. Validates the domain separator
/// 2. Verifies the signature
/// 3. Checks the deadline
/// 4. Checks the nonce
/// 5. Advances the nonce
/// 6. Emits a permit executed event
///
/// # Arguments
/// * `env` - The Soroban environment
/// * `domain` - The domain separator for this contract
/// * `permit` - The permit to verify
/// * `signature` - The ed25519 signature
///
/// # Returns
/// * `Ok(VerifiedPermit)` if verification succeeds
/// * `Err(VeilLendError)` if verification fails
pub fn verify_and_consume_permit(
    env: &Env,
    domain: &DomainSeparator,
    permit: &Permit,
    signature: &Bytes,
) -> Result<VerifiedPermit, crate::VeilLendError> {
    use crate::VeilLendError;
    use crate::permit::{validate_permit, verify_permit, advance_nonce, emit_permit_executed};

    // Verify the signature
    verify_permit(env, domain, permit, signature)?;

    // Get the current nonce
    let current_nonce = get_current_nonce(env, &permit.user);

    // Validate deadline and nonce
    validate_permit(env, permit, current_nonce)?;

    // Advance the nonce (consume the permit)
    let new_nonce = advance_nonce(env, &permit.user);

    // Emit permit executed event
    emit_permit_executed(env, &permit.user, &permit.action, &permit.asset, permit.amount, new_nonce);

    Ok(VerifiedPermit {
        user: permit.user.clone(),
        action: permit.action.clone(),
        asset: permit.asset.clone(),
        amount: permit.amount,
        nonce: new_nonce,
    })
}

/// Gets the current nonce for a user.
pub fn get_current_nonce(env: &Env, user: &Address) -> u64 {
    let key = DataKey::PermitNonce(user.clone());
    env.storage().persistent().get(&key).unwrap_or(0)
}