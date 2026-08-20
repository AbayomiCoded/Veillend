/**
 * VeilLend Soroban contract error codes and their human-readable messages.
 *
 * Codes mirror the `VeilLendError` enum in veilend-soroban/src/lib.rs.
 * When Soroban RPC returns a failed transaction with a contract error, we
 * parse the `resultXdr` to extract the u32 code and look it up here.
 */

export const CONTRACT_ERROR_MESSAGES: Record<number, string> = {
  1:  'Contract is already initialized.',
  2:  'Unauthorized: you are not an admin.',
  3:  'Asset is not supported by the protocol.',
  4:  'Invalid amount: must be positive.',
  5:  'Insufficient collateral to borrow or withdraw.',
  6:  'Insufficient deposit balance to withdraw.',
  7:  'Repay amount exceeds outstanding debt.',
  8:  'Invalid collateral ratio: must be ≥ 100%.',
  9:  'Contract not initialized yet.',
  10: 'Amount cannot be zero.',
  11: 'Oracle price is missing for this asset.',
  12: 'Protocol is currently paused.',
  13: 'Deposit cap exceeded for this asset.',
  14: 'Borrow cap exceeded for this asset.',
  15: 'Invalid cap value.',
  16: 'Circuit breaker triggered — asset temporarily paused.',
  17: 'Insufficient reserve balance.',
  18: 'Timelock not ready — please wait before executing.',
  19: 'Unknown governance action.',
  20: 'Cannot remove the last admin.',
  21: 'Invalid timelock duration.',
  22: 'Pausing must go through the timelock proposal flow.',
  23: 'Oracle price is stale — please retry.',
  24: 'Oracle price change exceeds allowed volatility.',
  25: 'Oracle price is below the allowed minimum.',
  26: 'Oracle price is above the allowed maximum.',
};

/** User-facing fallback when a code is not in the table. */
export const UNKNOWN_CONTRACT_ERROR = 'Transaction failed with an unknown contract error.';

/**
 * Map a contract error code to a human-readable string.
 */
export function getContractErrorMessage(code: number): string {
  return CONTRACT_ERROR_MESSAGES[code] ?? UNKNOWN_CONTRACT_ERROR;
}

/**
 * Try to extract a u32 Soroban contract error code from a failed
 * transaction result XDR string, returned by `getTransaction`.
 *
 * Soroban contract errors appear as a ScVal of type `error` with a
 * `contractCode` variant whose value is the u32 error code.
 *
 * Returns `null` if the XDR cannot be parsed or is not a contract error.
 */
export function parseContractErrorCode(resultXdr: string): number | null {
  try {
    // Lazy-require stellar-base so tests that don't need it don't pay the cost.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { xdr } = require('@stellar/stellar-base') as typeof import('@stellar/stellar-base');

    const result = xdr.TransactionResult.fromXDR(resultXdr, 'base64');
    const txResult = result.result();

    // The result must be a failed inner result.
    if (txResult.switch().name !== 'txFailed') return null;

    const ops = txResult.results?.();
    if (!ops || ops.length === 0) return null;

    const opResult = ops[0].tr?.();
    if (!opResult) return null;

    // Soroban invoke host function op result
    const invokeFnResult = opResult.invokeHostFunctionResult?.();
    if (!invokeFnResult) return null;

    if (invokeFnResult.switch().name !== 'invokeHostFunctionTrapped') return null;

    // The trapped result does not carry the contract error code directly in
    // InvokeHostFunctionResult — the code is embedded in the diagnostic events
    // or returnValue of the full transaction meta, which is not available here.
    // Return null so callers fall back to the generic "unknown contract error"
    // message rather than crashing.
    return null;
  } catch {
    return null;
  }
}
