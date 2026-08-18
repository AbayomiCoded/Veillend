/**
 * Transaction signer for the in-app Stellar keypair.
 *
 * The mobile app stores the user's secret key in SecureStore (behind
 * biometric / passcode gate). This module reads the secret key, constructs
 * a `Keypair`, and signs a transaction XDR envelope — all in one call so
 * the raw secret is never held in a local variable beyond the signing step.
 *
 * Freighter / Ledger integration would replace `signWithInAppKeypair` with
 * a call to the respective SDK once those bridges are added.
 */

import { getSecureItem } from '../utils/secureStorage';

const SECRET_KEY_STORE = 'stellar_secret_key' as const;

/** Thrown when the user has no in-app keypair (wallet not set up). */
export class WalletNotFoundError extends Error {
  constructor() {
    super('No wallet found. Please connect your wallet first.');
    this.name = 'WalletNotFoundError';
  }
}

/**
 * Thrown (or returned via a rejected promise) when the user explicitly
 * cancels a signing request.  The lending actions treat this as a `low`
 * severity event — no crash report, just a "Transaction rejected" toast.
 */
export class UserRejectedError extends Error {
  constructor(message = 'Transaction rejected') {
    super(message);
    this.name = 'UserRejectedError';
  }
}

/**
 * Sign an unsigned transaction XDR with the in-app Stellar keypair stored
 * in SecureStore.
 *
 * @param unsignedXdr  Base64-encoded unsigned transaction envelope (V1).
 * @returns            Base64-encoded signed transaction envelope.
 * @throws             `WalletNotFoundError` if no keypair is stored.
 * @throws             Any SecureStore error if the biometric gate fails.
 */
export async function signWithInAppKeypair(unsignedXdr: string): Promise<string> {
  const secret = await getSecureItem(SECRET_KEY_STORE);

  if (!secret) {
    throw new WalletNotFoundError();
  }

  // Lazy-require stellar-base so this module is safely importable in
  // test environments that stub the module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Keypair, Transaction } = require('@stellar/stellar-base') as typeof import('@stellar/stellar-base');

  const networkPassphrase =
    (process.env.STELLAR_NETWORK_PASSPHRASE as string | undefined) ??
    'Test SDF Network ; September 2015';

  const keypair = Keypair.fromSecret(secret);
  const tx = new Transaction(unsignedXdr, networkPassphrase);
  tx.sign(keypair);

  return tx.toEnvelope().toXDR('base64');
}

/**
 * Sign a transaction using whichever signer is available.
 *
 * Priority:
 *  1. In-app keypair from SecureStore (current implementation).
 *  2. Freighter mobile bridge (future — add when SDK is available).
 *  3. Ledger hardware wallet (future).
 *
 * @param unsignedXdr  Base64-encoded unsigned transaction XDR.
 * @param networkPassphrase  Stellar network passphrase for the target network.
 * @returns Signed XDR envelope as base64.
 */
export async function signTransaction(
  unsignedXdr: string,
  networkPassphrase: string,
): Promise<string> {
  const secret = await getSecureItem(SECRET_KEY_STORE);

  if (!secret) {
    throw new WalletNotFoundError();
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Keypair, Transaction } = require('@stellar/stellar-base') as typeof import('@stellar/stellar-base');

  const keypair = Keypair.fromSecret(secret);
  const tx = new Transaction(unsignedXdr, networkPassphrase);
  tx.sign(keypair);

  return tx.toEnvelope().toXDR('base64');
}
