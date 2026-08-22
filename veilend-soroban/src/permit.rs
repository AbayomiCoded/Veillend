//! Permit-style meta-transaction verification.
//!
//! This module provides ed25519 signature verification for off-chain signed
//! permits, enabling relayers to submit transactions on behalf of users who
//! have signed a structured permit message.

use crate::{DataKey, VeilLendError};
use soroban_sdk::{
    contracttype, panic_with_error, Address, Bytes, Env, String, Symbol, Vec,
};

/// Domain separator for permit signatures.
///
/// This ensures signatures are bound to this specific contract and version,
/// preventing replay across different contracts or versions.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct DomainSeparator {
    pub contract_id: Address,
    pub version: u32,
    pub chain_id: u64,
}

/// Permit structure for meta-transactions.
///
/// Users sign this struct off-chain, and relayers submit it on-chain.
/// All fields are included in the signature digest to prevent tampering.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Permit {
    /// The user who authorizes the action (signer)
    pub user: Address,
    /// The action to perform (deposit, withdraw, borrow, repay)
    pub action: Symbol,
    /// The asset address for the operation
    pub asset: Address,
    /// The amount for the operation
    pub amount: i128,
    /// The current nonce for this user (must match expected value)
    pub nonce: u64,
    /// Timestamp deadline (ledger timestamp) after which this permit expires
    pub deadline: u64,
    /// Chain ID to prevent cross-chain replay
    pub chain_id: u64,
    /// Contract ID to prevent cross-contract replay
    pub contract_id: Address,
}

/// Additional parameters for withdraw and borrow permits.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PermitWithExtra {
    pub permit: Permit,
    /// For withdraw: the debt asset to check against
    /// For borrow: the collateral asset to use
    pub extra_asset: Address,
}

/// Computes the digest to be signed for a permit.
///
/// The digest is a hash of the domain separator and the permit fields,
/// following the EIP-712 style pattern.
pub fn compute_permit_digest(
    env: &Env,
    domain: &DomainSeparator,
    permit: &Permit,
) -> Result<Bytes, VeilLendError> {
    use soroban_sdk::crypto::Hash;

    // Encode domain separator
    let domain_encoded = encode_domain(env, domain);

    // Encode permit fields
    let permit_encoded = encode_permit(env, permit);

    // Combine and hash
    let mut combined = Vec::new(env);
    combined.append(&domain_encoded);
    combined.append(&permit_encoded);

    let hash = Hash::from_bytes(env, &combined);
    Ok(Bytes::from_array(env, &hash.to_array()))
}

/// Encodes the domain separator for hashing.
fn encode_domain(env: &Env, domain: &DomainSeparator) -> Vec<u8> {
    let mut encoded = Vec::new(env);

    // Encode contract_id as bytes
    let contract_bytes = domain.contract_id.to_bytes(env);
    for b in contract_bytes.iter() {
        encoded.push_back(b);
    }

    // Encode version as u32 bytes (big endian)
    encoded.push_back(((domain.version >> 24) & 0xFF) as u8);
    encoded.push_back(((domain.version >> 16) & 0xFF) as u8);
    encoded.push_back(((domain.version >> 8) & 0xFF) as u8);
    encoded.push_back((domain.version & 0xFF) as u8);

    // Encode chain_id as u64 bytes (big endian)
    encoded.push_back(((domain.chain_id >> 56) & 0xFF) as u8);
    encoded.push_back(((domain.chain_id >> 48) & 0xFF) as u8);
    encoded.push_back(((domain.chain_id >> 40) & 0xFF) as u8);
    encoded.push_back(((domain.chain_id >> 32) & 0xFF) as u8);
    encoded.push_back(((domain.chain_id >> 24) & 0xFF) as u8);
    encoded.push_back(((domain.chain_id >> 16) & 0xFF) as u8);
    encoded.push_back(((domain.chain_id >> 8) & 0xFF) as u8);
    encoded.push_back((domain.chain_id & 0xFF) as u8);

    encoded
}

/// Encodes the permit fields for hashing.
fn encode_permit(env: &Env, permit: &Permit) -> Vec<u8> {
    let mut encoded = Vec::new(env);

    // Encode user address
    let user_bytes = permit.user.to_bytes(env);
    for b in user_bytes.iter() {
        encoded.push_back(b);
    }

    // Encode action as Symbol bytes
    let action_bytes = permit.action.to_bytes(env);
    for b in action_bytes.iter() {
        encoded.push_back(b);
    }

    // Encode asset address
    let asset_bytes = permit.asset.to_bytes(env);
    for b in asset_bytes.iter() {
        encoded.push_back(b);
    }

    // Encode amount as i128 bytes (big endian)
    let amount = permit.amount;
    encoded.push_back(((amount >> 120) & 0xFF) as u8);
    encoded.push_back(((amount >> 112) & 0xFF) as u8);
    encoded.push_back(((amount >> 104) & 0xFF) as u8);
    encoded.push_back(((amount >> 96) & 0xFF) as u8);
    encoded.push_back(((amount >> 88) & 0xFF) as u8);
    encoded.push_back(((amount >> 80) & 0xFF) as u8);
    encoded.push_back(((amount >> 72) & 0xFF) as u8);
    encoded.push_back(((amount >> 64) & 0xFF) as u8);
    encoded.push_back(((amount >> 56) & 0xFF) as u8);
    encoded.push_back(((amount >> 48) & 0xFF) as u8);
    encoded.push_back(((amount >> 40) & 0xFF) as u8);
    encoded.push_back(((amount >> 32) & 0xFF) as u8);
    encoded.push_back(((amount >> 24) & 0xFF) as u8);
    encoded.push_back(((amount >> 16) & 0xFF) as u8);
    encoded.push_back(((amount >> 8) & 0xFF) as u8);
    encoded.push_back((amount & 0xFF) as u8);

    // Encode nonce as u64 bytes (big endian)
    let nonce = permit.nonce;
    encoded.push_back(((nonce >> 56) & 0xFF) as u8);
    encoded.push_back(((nonce >> 48) & 0xFF) as u8);
    encoded.push_back(((nonce >> 40) & 0xFF) as u8);
    encoded.push_back(((nonce >> 32) & 0xFF) as u8);
    encoded.push_back(((nonce >> 24) & 0xFF) as u8);
    encoded.push_back(((nonce >> 16) & 0xFF) as u8);
    encoded.push_back(((nonce >> 8) & 0xFF) as u8);
    encoded.push_back((nonce & 0xFF) as u8);

    // Encode deadline as u64 bytes (big endian)
    let deadline = permit.deadline;
    encoded.push_back(((deadline >> 56) & 0xFF) as u8);
    encoded.push_back(((deadline >> 48) & 0xFF) as u8);
    encoded.push_back(((deadline >> 40) & 0xFF) as u8);
    encoded.push_back(((deadline >> 32) & 0xFF) as u8);
    encoded.push_back(((deadline >> 24) & 0xFF) as u8);
    encoded.push_back(((deadline >> 16) & 0xFF) as u8);
    encoded.push_back(((deadline >> 8) & 0xFF) as u8);
    encoded.push_back((deadline & 0xFF) as u8);

    // Encode chain_id as u64 bytes (big endian)
    let chain_id = permit.chain_id;
    encoded.push_back(((chain_id >> 56) & 0xFF) as u8);
    encoded.push_back(((chain_id >> 48) & 0xFF) as u8);
    encoded.push_back(((chain_id >> 40) & 0xFF) as u8);
    encoded.push_back(((chain_id >> 32) & 0xFF) as u8);
    encoded.push_back(((chain_id >> 24) & 0xFF) as u8);
    encoded.push_back(((chain_id >> 16) & 0xFF) as u8);
    encoded.push_back(((chain_id >> 8) & 0xFF) as u8);
    encoded.push_back((chain_id & 0xFF) as u8);

    // Encode contract_id
    let contract_bytes = permit.contract_id.to_bytes(env);
    for b in contract_bytes.iter() {
        encoded.push_back(b);
    }

    encoded
}

/// Verifies a signature against a permit.
///
/// # Arguments
/// * `env` - The Soroban environment
/// * `domain` - The domain separator for this contract
/// * `permit` - The permit to verify
/// * `signature` - The ed25519 signature (64 bytes)
///
/// # Returns
/// * `Ok(())` if the signature is valid
/// * `Err(VeilLendError::InvalidSignature)` if verification fails
pub fn verify_permit(
    env: &Env,
    domain: &DomainSeparator,
    permit: &Permit,
    signature: &Bytes,
) -> Result<(), VeilLendError> {
    // Validate signature length (ed25519 signatures are 64 bytes)
    if signature.len() != 64 {
        return Err(VeilLendError::InvalidSignature);
    }

    // Compute the digest
    let digest = compute_permit_digest(env, domain, permit)?;

    // Verify the signature
    let is_valid = env
        .crypto()
        .ed25519_verify(&permit.user, &digest, signature);

    if !is_valid {
        return Err(VeilLendError::InvalidSignature);
    }

    Ok(())
}

/// Validates a permit's deadline and nonce.
///
/// # Arguments
/// * `env` - The Soroban environment
/// * `permit` - The permit to validate
/// * `current_nonce` - The current nonce for the user
///
/// # Returns
/// * `Ok(())` if the permit is valid
/// * `Err(VeilLendError::PermitExpired)` if the deadline has passed
/// * `Err(VeilLendError::PermitNonceMismatch)` if the nonce doesn't match
pub fn validate_permit(
    env: &Env,
    permit: &Permit,
    current_nonce: u64,
) -> Result<(), VeilLendError> {
    // Check deadline
    let now = env.ledger().timestamp();
    if now > permit.deadline {
        return Err(VeilLendError::PermitExpired);
    }

    // Check nonce (must be exactly the current expected value)
    if permit.nonce != current_nonce {
        return Err(VeilLendError::PermitNonceMismatch);
    }

    Ok(())
}

/// Advances the nonce for a user.
///
/// # Arguments
/// * `env` - The Soroban environment
/// * `user` - The user whose nonce to advance
///
/// # Returns
/// * The new nonce value
pub fn advance_nonce(env: &Env, user: &Address) -> u64 {
    let key = DataKey::PermitNonce(user.clone());
    let current: u64 = env.storage().persistent().get(&key).unwrap_or(0);
    let next = current + 1;
    env.storage().persistent().set(&key, &next);
    // Bump TTL
    env.storage()
        .persistent()
        .extend_ttl(&key, crate::storage::MIN_TTL, crate::storage::BUMP_TTL);
    next
}

/// Gets the current nonce for a user.
///
/// # Arguments
/// * `env` - The Soroban environment
/// * `user` - The user whose nonce to query
///
/// # Returns
/// * The current nonce value
pub fn get_current_nonce(env: &Env, user: &Address) -> u64 {
    let key = DataKey::PermitNonce(user.clone());
    let nonce: u64 = env.storage().persistent().get(&key).unwrap_or(0);
    // Bump TTL on read
    env.storage()
        .persistent()
        .extend_ttl(&key, crate::storage::MIN_TTL, crate::storage::BUMP_TTL);
    nonce
}

/// Emits a permit executed event.
pub fn emit_permit_executed(
    env: &Env,
    user: &Address,
    action: &Symbol,
    asset: &Address,
    amount: i128,
    nonce: u64,
) {
    #[contractevent(topics = ["veillend", "permit_executed"])]
    #[derive(Clone, Debug, Eq, PartialEq)]
    struct PermitExecuted {
        #[topic]
        pub user: Address,
        #[topic]
        pub action: Symbol,
        pub asset: Address,
        pub amount: i128,
        pub nonce: u64,
        pub timestamp: u64,
    }

    let event = PermitExecuted {
        user: user.clone(),
        action: action.clone(),
        asset: asset.clone(),
        amount,
        nonce,
        timestamp: env.ledger().timestamp(),
    };
    event.publish(env);
}

/// Emits a permit failed event.
pub fn emit_permit_failed(
    env: &Env,
    user: &Address,
    action: &Symbol,
    error_code: u32,
) {
    #[contractevent(topics = ["veillend", "permit_failed"])]
    #[derive(Clone, Debug, Eq, PartialEq)]
    struct PermitFailed {
        #[topic]
        pub user: Address,
        #[topic]
        pub action: Symbol,
        pub error_code: u32,
        pub timestamp: u64,
    }

    let event = PermitFailed {
        user: user.clone(),
        action: action.clone(),
        error_code,
        timestamp: env.ledger().timestamp(),
    };
    event.publish(env);
}