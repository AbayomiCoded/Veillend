/**
 * Soroban transaction builders for VeilLend lending actions.
 *
 * Each builder constructs an **unsigned** Stellar V1 transaction envelope
 * (base64 XDR) ready to be signed and submitted to Soroban RPC.
 *
 * Design:
 *  - Uses `@stellar/stellar-base` (already in package.json) — no need for
 *    the heavier `@stellar/stellar-sdk`.
 *  - Fetches the current account sequence number from Horizon REST API so
 *    the transaction is immediately broadcastable.
 *  - Sets a 5-minute timeout (300 ledgers ≈ 300 s at ~5 s/ledger).
 *  - Normalises the human-readable amount to a Soroban i128 ScVal using
 *    per-asset decimals (e.g. XLM = 7 decimals → multiply by 10^7).
 */

/** Transaction timeout in seconds (5 minutes). */
const TX_TIMEOUT_SECONDS = 300;

/** Stellar network passphrase.  Defaults to testnet. */
function getNetworkPassphrase(): string {
  return (
    (process.env.STELLAR_NETWORK_PASSPHRASE as string | undefined) ??
    'Test SDF Network ; September 2015'
  );
}

/** Horizon base URL. Defaults to testnet. */
function getHorizonUrl(): string {
  return (
    (process.env.STELLAR_HORIZON_URL as string | undefined) ??
    'https://horizon-testnet.stellar.org'
  );
}

// ──────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────

/**
 * Fetch the current sequence number for a Stellar account from Horizon.
 * Returns the sequence as a string so `stellar-base` `Account` can consume it.
 */
async function fetchAccountSequence(address: string): Promise<string> {
  const horizonUrl = getHorizonUrl();
  const res = await fetch(`${horizonUrl}/accounts/${address}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch account from Horizon (${res.status}): ${res.statusText}`);
  }
  const data = (await res.json()) as { sequence: string };
  return data.sequence;
}

/**
 * Convert a human-readable decimal amount to a bigint scaled by `decimals`.
 * E.g. amount = "1.5", decimals = 7 → 15_000_000n.
 */
export function toScaledBigInt(amount: string, decimals: number): bigint {
  const [intPart = '0', fracPart = ''] = amount.split('.');
  const paddedFrac = fracPart.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(intPart) * BigInt(10 ** decimals) + BigInt(paddedFrac);
}

// ──────────────────────────────────────────────────────────────
// Transaction params
// ──────────────────────────────────────────────────────────────

export interface LendingTxParams {
  /** Human-readable amount (e.g. "1.5"). */
  amount: string;
  /** Asset decimals (e.g. 7 for XLM, 6 for USDC). */
  decimals: number;
  /** Sender / user Stellar address. */
  fromAddress: string;
  /** VeilLend Soroban contract ID (Stellar C… address). */
  contractId: string;
  /** Asset contract ID for SEP-41 tokens (null for XLM native). */
  assetContractId: string | null;
}

// ──────────────────────────────────────────────────────────────
// Core builder
// ──────────────────────────────────────────────────────────────

/**
 * Internal builder: constructs an unsigned V1 transaction for any of the
 * four lending operations (deposit / withdraw / borrow / repay).
 *
 * @param fnName   Soroban contract function name.
 * @param params   Lending parameters.
 * @returns        Base64-encoded unsigned transaction XDR.
 */
async function buildLendingTx(
  fnName: 'deposit' | 'withdraw' | 'borrow' | 'repay',
  params: LendingTxParams,
): Promise<string> {
  const {
    Keypair,
    Contract,
    TransactionBuilder,
    Account,
    Networks,
    nativeToScVal,
    xdr,
  } = require('@stellar/stellar-base') as typeof import('@stellar/stellar-base');

  const { amount, decimals, fromAddress, contractId, assetContractId } = params;

  // 1. Fetch account sequence from Horizon.
  const sequence = await fetchAccountSequence(fromAddress);
  const account = new Account(fromAddress, sequence);

  // 2. Scale amount to i128 ScVal.
  const scaledAmount = toScaledBigInt(amount, decimals);
  const amountScVal = nativeToScVal(scaledAmount, { type: 'i128' });

  // 3. Build asset ScVal:
  //    - Native XLM → ScVal address of the user's account (protocol uses it
  //      as a proxy for the native asset identifier)
  //    - SEP-41 token → ScVal address of the token contract
  const assetScVal = assetContractId
    ? nativeToScVal(assetContractId, { type: 'address' })
    : nativeToScVal(fromAddress, { type: 'address' });

  // 4. Caller address ScVal (used as the `from` / `user` argument).
  const callerScVal = nativeToScVal(fromAddress, { type: 'address' });

  // 5. Build the contract call operation.
  const contract = new Contract(contractId);
  const operation = contract.call(fnName, callerScVal, assetScVal, amountScVal);

  // 6. Assemble the transaction.
  const networkPassphrase = getNetworkPassphrase();
  const tx = new TransactionBuilder(account, {
    fee: '100000', // 0.01 XLM base fee — sufficient for Soroban ops on testnet
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  return tx.toEnvelope().toXDR('base64');
}

// ──────────────────────────────────────────────────────────────
// Public builders
// ──────────────────────────────────────────────────────────────

/**
 * Build an unsigned `deposit` transaction.
 * The caller must sign the returned XDR before broadcasting.
 */
export async function buildDepositTx(params: LendingTxParams): Promise<string> {
  return buildLendingTx('deposit', params);
}

/**
 * Build an unsigned `withdraw` transaction.
 */
export async function buildWithdrawTx(params: LendingTxParams): Promise<string> {
  return buildLendingTx('withdraw', params);
}

/**
 * Build an unsigned `borrow` transaction.
 */
export async function buildBorrowTx(params: LendingTxParams): Promise<string> {
  return buildLendingTx('borrow', params);
}

/**
 * Build an unsigned `repay` transaction.
 */
export async function buildRepayTx(params: LendingTxParams): Promise<string> {
  return buildLendingTx('repay', params);
}

/** Lookup table to select the correct builder by kind. */
export const TX_BUILDERS = {
  deposit: buildDepositTx,
  withdraw: buildWithdrawTx,
  borrow: buildBorrowTx,
  repay: buildRepayTx,
} as const;
