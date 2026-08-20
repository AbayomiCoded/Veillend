/**
 * Unit tests for the Soroban lending infrastructure (issue #313).
 *
 * Tests cover:
 *  - contractErrors: code → message mapping and XDR parse guard
 *  - transactions: toScaledBigInt helper
 *  - rpc: sendTransaction and pollTransaction behaviour
 *  - store: runLending integration (asset resolution, double-tap guard,
 *    success path, user-rejection path, network-error path)
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

// ── contractErrors ────────────────────────────────────────────────────────────
import {
  getContractErrorMessage,
  parseContractErrorCode,
  UNKNOWN_CONTRACT_ERROR,
} from './contractErrors';

describe('getContractErrorMessage', () => {
  it('returns the correct message for known codes', () => {
    assert.equal(getContractErrorMessage(5), 'Insufficient collateral to borrow or withdraw.');
    assert.equal(getContractErrorMessage(10), 'Amount cannot be zero.');
    assert.equal(getContractErrorMessage(12), 'Protocol is currently paused.');
  });

  it('returns the fallback message for unknown codes', () => {
    assert.equal(getContractErrorMessage(9999), UNKNOWN_CONTRACT_ERROR);
    assert.equal(getContractErrorMessage(0), UNKNOWN_CONTRACT_ERROR);
  });
});

describe('parseContractErrorCode', () => {
  it('returns null for invalid / non-base64 XDR without throwing', () => {
    assert.equal(parseContractErrorCode('not-valid-xdr'), null);
    assert.equal(parseContractErrorCode(''), null);
  });
});

// ── toScaledBigInt ────────────────────────────────────────────────────────────
import { toScaledBigInt } from './transactions';

describe('toScaledBigInt', () => {
  it('scales an integer amount', () => {
    assert.equal(toScaledBigInt('1', 7), 10_000_000n);
    assert.equal(toScaledBigInt('100', 6), 100_000_000n);
  });

  it('scales a decimal amount', () => {
    assert.equal(toScaledBigInt('1.5', 7), 15_000_000n);
    assert.equal(toScaledBigInt('0.000001', 6), 1n);
  });

  it('handles amounts with fewer decimal places than decimals', () => {
    assert.equal(toScaledBigInt('1.1', 7), 11_000_000n);
  });

  it('truncates extra decimal places beyond decimals', () => {
    // 1.123456789 with 7 decimals → 1.1234567 → 11_234_567
    assert.equal(toScaledBigInt('1.123456789', 7), 11_234_567n);
  });

  it('handles zero', () => {
    assert.equal(toScaledBigInt('0', 7), 0n);
    assert.equal(toScaledBigInt('0.0', 7), 0n);
  });
});

// ── rpc: sendTransaction ──────────────────────────────────────────────────────
import { sendTransaction, pollTransaction } from './rpc';

describe('sendTransaction', () => {
  it('returns PENDING status with hash on success', async () => {
    // Stub global fetch
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({
        result: { status: 'PENDING', hash: 'abc123' },
      }),
    });

    const result = await sendTransaction('signed-xdr==', 'http://rpc.test');
    assert.equal(result.status, 'PENDING');
    assert.equal((result as any).hash, 'abc123');
  });

  it('returns ERROR status when node rejects', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({
        result: { status: 'ERROR', errorResultXdr: 'some-xdr' },
      }),
    });

    const result = await sendTransaction('bad-xdr==', 'http://rpc.test');
    assert.equal(result.status, 'ERROR');
  });

  it('returns ERROR when fetch throws', async () => {
    (globalThis as any).fetch = async () => {
      throw new Error('network down');
    };

    const result = await sendTransaction('xdr==', 'http://rpc.test');
    assert.equal(result.status, 'ERROR');
    assert.ok((result as any).error.includes('network down'));
  });

  it('returns ERROR on non-ok HTTP response', async () => {
    (globalThis as any).fetch = async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const result = await sendTransaction('xdr==', 'http://rpc.test');
    assert.equal(result.status, 'ERROR');
  });
});

describe('pollTransaction', () => {
  it('resolves immediately on SUCCESS', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ result: { status: 'SUCCESS', ledger: 42 } }),
    });

    const result = await pollTransaction('hash-abc', {
      intervalMs: 10,
      timeoutMs: 5_000,
      rpcUrl: 'http://rpc.test',
    });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.ledger, 42);
  });

  it('resolves with FAILED when transaction fails on-chain', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({
        result: { status: 'FAILED', resultXdr: 'fail-xdr' },
      }),
    });

    const result = await pollTransaction('hash-fail', {
      intervalMs: 10,
      timeoutMs: 5_000,
      rpcUrl: 'http://rpc.test',
    });
    assert.equal(result.status, 'FAILED');
  });

  it('throws timeout error when NOT_FOUND persists beyond timeoutMs', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ result: { status: 'NOT_FOUND' } }),
    });

    await assert.rejects(
      () =>
        pollTransaction('hash-timeout', {
          intervalMs: 10,
          timeoutMs: 50, // very short so the test doesn't hang
          rpcUrl: 'http://rpc.test',
        }),
      /timeout|please retry/i,
    );
  });
});

// ── store: runLending integration ─────────────────────────────────────────────
import { useStore } from '../store/store';
import api from '../utils/api';
import * as SecureStoreShim from '../utils/secureStoreShim';

// Stub api network calls
(api as any).get = async () => ({ data: {} });
(api as any).post = async () => ({ data: {} });

const MOCK_ASSET = {
  code: 'XLM',
  symbol: 'XLM',
  name: 'Stellar Lumens',
  decimals: 7,
  issuer: null,
  contractId: null,
  logoUrl: null,
  isNative: true,
  isSupported: true,
};

const MOCK_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

// Minimal stellar-base stub so the test never needs the real module.
function stubStellarBase() {
  const require_orig = (globalThis as any).__orig_require;
  // We can't easily stub require in Node test runner without module mocking,
  // so instead we stub the soroban modules directly via monkey-patching the
  // imported functions where they are called from the store.
  // The store calls TX_BUILDERS[kind], signTransaction, sendTransaction,
  // and pollTransaction — we stub those at the module level below.
}

describe('store runLending (issue #313)', () => {
  beforeEach(async () => {
    await SecureStoreShim.clearAllAsync();
    (api as any).get = async () => ({ data: {} });
    (api as any).post = async () => ({ data: {} });
    // Reset store to a known connected state
    useStore.setState({
      address: 'GABC123',
      authToken: 'jwt-token',
      sessionId: 'sid-1',
      lendingLoading: false,
      balance: 100,
      pendingTransactions: [],
      lastLendingTx: null,
      supportedAssets: [MOCK_ASSET],
    } as any);
    // Set the contract ID env var
    (process.env as any).VEIL_LEND_CONTRACT_ID = MOCK_CONTRACT_ID;
    (process.env as any).STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
  });

  it('rejects with asset-not-supported error for unknown assets', async () => {
    await assert.rejects(
      () => useStore.getState().deposit({ amount: '1', asset: 'FAKECOIN' }),
      /not supported/i,
    );
    assert.equal(useStore.getState().lendingLoading, false);
    assert.equal(useStore.getState().pendingTransactions.length, 0);
  });

  it('rejects with double-tap guard when lendingLoading is already true', async () => {
    useStore.setState({ lendingLoading: true } as any);
    await assert.rejects(
      () => useStore.getState().deposit({ amount: '1', asset: 'XLM' }),
      /already in progress/i,
    );
  });

  it('rejects when VEIL_LEND_CONTRACT_ID is not set', async () => {
    (process.env as any).VEIL_LEND_CONTRACT_ID = '';
    await assert.rejects(
      () => useStore.getState().deposit({ amount: '1', asset: 'XLM' }),
      /contract id/i,
    );
    assert.equal(useStore.getState().lendingLoading, false);
  });

  it('rolls back optimistic state and sets FAILED on UserRejectedError', async () => {
    // Stub TX_BUILDERS to succeed, signer to reject
    const txMod = await import('./transactions');
    const signerMod = await import('./signer');
    const origBuilder = txMod.TX_BUILDERS.deposit;
    const origSign = signerMod.signTransaction;

    (txMod.TX_BUILDERS as any).deposit = async () => 'unsigned-xdr==';
    (signerMod as any).signTransaction = async () => {
      const { UserRejectedError: URE } = await import('./signer');
      throw new URE();
    };

    const initialBalance = useStore.getState().balance;

    await assert.rejects(
      () => useStore.getState().deposit({ amount: '1', asset: 'XLM' }),
      /rejected/i,
    );

    const s = useStore.getState();
    assert.equal(s.lendingLoading, false);
    assert.equal(s.balance, initialBalance);
    const failed = s.pendingTransactions.find((t) => t.status === 'FAILED');
    assert.ok(failed, 'Should have a FAILED tx record');
    assert.equal(failed!.errorReason, 'Transaction rejected');

    // Restore
    (txMod.TX_BUILDERS as any).deposit = origBuilder;
    (signerMod as any).signTransaction = origSign;
  });

  it('rolls back and sets FAILED with network error message on timeout', async () => {
    const txMod = await import('./transactions');
    const signerMod = await import('./signer');
    const rpcMod = await import('./rpc');

    const origBuilder = txMod.TX_BUILDERS.deposit;
    const origSign = signerMod.signTransaction;
    const origSend = rpcMod.sendTransaction;
    const origPoll = rpcMod.pollTransaction;

    (txMod.TX_BUILDERS as any).deposit = async () => 'unsigned-xdr==';
    (signerMod as any).signTransaction = async () => 'signed-xdr==';
    (rpcMod as any).sendTransaction = async () => ({ status: 'PENDING', hash: 'h1' });
    (rpcMod as any).pollTransaction = async () => {
      throw new Error('Network error, please retry — transaction confirmation timed out.');
    };

    await assert.rejects(
      () => useStore.getState().deposit({ amount: '1', asset: 'XLM' }),
      /network error/i,
    );

    const s = useStore.getState();
    assert.equal(s.lendingLoading, false);
    const failed = s.pendingTransactions.find((t) => t.status === 'FAILED');
    assert.ok(failed);
    assert.match(failed!.errorReason ?? '', /network error/i);

    // Restore
    (txMod.TX_BUILDERS as any).deposit = origBuilder;
    (signerMod as any).signTransaction = origSign;
    (rpcMod as any).sendTransaction = origSend;
    (rpcMod as any).pollTransaction = origPoll;
  });

  it('confirms tx and refreshes portfolio on success', async () => {
    const txMod = await import('./transactions');
    const signerMod = await import('./signer');
    const rpcMod = await import('./rpc');

    (txMod.TX_BUILDERS as any).deposit = async () => 'unsigned-xdr==';
    (signerMod as any).signTransaction = async () => 'signed-xdr==';
    (rpcMod as any).sendTransaction = async () => ({ status: 'PENDING', hash: 'confirmedhash' });
    (rpcMod as any).pollTransaction = async () => ({ status: 'SUCCESS', ledger: 99 });

    const portfolioCalls: string[] = [];
    (api as any).get = async (url: string) => {
      portfolioCalls.push(url);
      return { data: {} };
    };

    const result = await useStore.getState().deposit({ amount: '1', asset: 'XLM' });

    assert.equal(result.status, 'CONFIRMED');
    assert.equal(result.txHash, 'confirmedhash');

    const s = useStore.getState();
    assert.equal(s.lendingLoading, false);
    assert.equal(s.lastLendingTx?.status, 'CONFIRMED');
    // portfolio + positions + transactions refresh must fire
    assert.ok(portfolioCalls.some((u) => u.includes('portfolios')));
  });
});
