//! Permit-style meta-transaction verification.
//!
//! This module provides ed25519 signature verification for off-chain signed
//! permits, enabling relayers to submit transactions on behalf of users who
//! have signed a structured permit message.

use crate::{DataKey, VeilLendError};
use soroban_sdk::{
    address_payload::AddressPayload, contractevent, contracttype, xdr::ToXdr, Address, Bytes,
    BytesN, Env, Symbol,
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
/// Users sign this struct off-chain, and relayers submit it on-chain. All
/// fields are included in the signature digest (via XDR serialization) to
/// prevent tampering.
///
/// The signer is identified by `public_key`, an Ed25519 public key, rather
/// than a Soroban `Address`: a contract cannot safely extract a raw signing
/// key from an arbitrary `Address` (it may be a contract address, or an
/// account whose signers have since been rotated away from its master key).
/// Instead, the acting `Address` is derived deterministically from
/// `public_key` (see [`signer_address`]), so the two can never disagree.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Permit {
    /// The Ed25519 public key that must have signed this permit.
    pub public_key: BytesN<32>,
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

/// Derives the Address controlled by an Ed25519 public key.
///
/// This is the account `Address` whose master key is `public_key`. A
/// successfully verified permit is only authoritative for accounts where
/// that master key is actually the authorizing signer, i.e. simple,
/// non-multisig accounts (the common case for regular wallets).
pub fn signer_address(env: &Env, public_key: &BytesN<32>) -> Address {
    Address::from_payload(
        env,
        AddressPayload::AccountIdPublicKeyEd25519(public_key.clone()),
    )
}

/// Computes the digest to be signed for a permit.
///
/// The digest is the SHA-256 hash of the XDR encoding of the domain
/// separator followed by the XDR encoding of the permit, following an
/// EIP-712-style domain-separation pattern.
pub fn compute_permit_digest(env: &Env, domain: &DomainSeparator, permit: &Permit) -> Bytes {
    let mut combined = Bytes::new(env);
    combined.append(&domain.clone().to_xdr(env));
    combined.append(&permit.clone().to_xdr(env));
    Bytes::from(env.crypto().sha256(&combined))
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
/// * `Ok(())` if the signature is well-formed (verification failure aborts
///   the transaction directly, see below)
/// * `Err(VeilLendError::InvalidSignature)` if the signature is not 64 bytes
///
/// # Panics
/// The host's `ed25519_verify` traps the transaction if the signature does
/// not match `permit.public_key` over the computed digest; there is no way
/// to recover from this within the contract, so an invalid signature never
/// returns an `Err` — it aborts execution outright.
pub fn verify_permit(
    env: &Env,
    domain: &DomainSeparator,
    permit: &Permit,
    signature: &Bytes,
) -> Result<(), VeilLendError> {
    let signature: BytesN<64> = signature
        .try_into()
        .map_err(|_| VeilLendError::InvalidSignature)?;

    let digest = compute_permit_digest(env, domain, permit);

    env.crypto()
        .ed25519_verify(&permit.public_key, &digest, &signature);

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
    env.storage().persistent().get(&key).unwrap_or(0)
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
pub fn emit_permit_failed(env: &Env, user: &Address, action: &Symbol, error_code: u32) {
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
