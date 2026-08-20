import { create } from 'zustand';
import { Clipboard } from 'react-native';
import api, { fetchWithRetry } from '../utils/api';
import { getSecureItem, setSecureItem, deleteSecureItem } from '../utils/secureStorage';
import { TX_BUILDERS } from '../lib/soroban/transactions';
import { signTransaction, UserRejectedError } from '../lib/soroban/signer';
import { sendTransaction, pollTransaction } from '../lib/soroban/rpc';
import { parseContractErrorCode, getContractErrorMessage } from '../lib/soroban/contractErrors';
import { reportError } from '../utils/errorReporting';

type Nullable<T> = T | null;

// Keys used for SecureStore persistence
const PERSIST_KEYS = {
  authToken: 'authToken',
  address: 'address',
  isPrivacyMode: 'isPrivacyMode',
  profileName: 'profileName',
  profileImage: 'profileImage',
  secretKey: 'stellar_secret_key',
  currency: 'currency',
  notificationsEnabled: 'notificationsEnabled',
  backupConfirmed: 'wallet_backup_confirmed',
  sessionId: 'sessionId',

} as const;

type AuthState = {
  address: Nullable<string>;
  authToken: Nullable<string>;
  /** Server-issued session ID returned by POST /auth/verify. Used to call
   *  POST /auth/logout so the server-side session is revoked on logout. */
  sessionId: Nullable<string>;
  setAddress: (address: string | null) => void;
  setAuthToken: (token: string | null) => void;
  logout: () => Promise<void>;
  requestNonce: (walletAddress: string) => Promise<string>;
  verify: (payload: { walletAddress: string; nonce: string; signature: string }) => Promise<string>;
  authLoading: boolean;
  sessionRestored: boolean;
};

type UiState = {
  isPrivacyMode: boolean;
  profileName: Nullable<string>;
  profileImage: Nullable<string>;
  setProfileName: (name: string | null) => void;
  setProfileImage: (uri: string | null) => void;
  togglePrivacyMode: () => void;
  currency: string;
  notificationsEnabled: boolean;
  setCurrency: (currency: string) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  expectedNetwork: string;
  currentNetwork: string | null;
  lastProtocolSyncAt: number | null;
  protocolStatusLoading: boolean;
  protocolStatusError: string | null;
  refreshProtocolStatus: () => Promise<void>;
  shieldedLoading: boolean;
  // Connectivity reported by NetworkProvider (NetInfo). `isOnline` defaults
  // to true so the UI does not flash an offline banner before NetInfo resolves.
  isOnline: boolean;
  networkType: string | null;
  isInternetReachable: boolean | null;
  setNetworkState: (state: {
    isOnline: boolean;
    networkType: string | null;
    isInternetReachable: boolean | null;
  }) => void;
};

type LendingKind = 'deposit' | 'withdraw' | 'borrow' | 'repay';

type LendingState = {
  lastLendingTx: Nullable<any>;
  lendingLoading: boolean;
  deposit: (params: { amount: string; asset: string }) => Promise<any>;
  withdraw: (params: { amount: string; asset: string }) => Promise<any>;
  borrow: (params: { amount: string; asset: string }) => Promise<any>;
  repay: (params: { amount: string; asset: string }) => Promise<any>;
};

export type TransactionRecord = {
  id: string;
  type: 'deposit' | 'withdraw' | 'borrow' | 'repay' | 'transfer';
  amount: number;
  asset: string;
  timestamp: string;
  status: string;
  txHash: string;
  errorReason?: string;
};

/** Asset metadata as returned by GET /assets?supported=true (backend B9). */
export type SupportedAsset = {
  code: string;
  symbol: string;
  name: string;
  decimals: number;
  issuer: string | null;
  contractId: string | null;
  logoUrl: string | null;
  isNative: boolean;
  isSupported: boolean;
};

/** Per-asset protocol position from the indexer (deposited/borrowed in human units). */
export type Position = {
  userAddress: string;
  assetAddress: string;
  deposited: number;
  borrowed: number;
  updatedAt: string;
};

export type AssetBalance = {
  asset: string;
  balance: number;
};

type PortfolioState = {
  balance: number;
  collateralValue: number;
  borrowedValue: number;
  availableToBorrow: number;
  healthFactor: number;
  portfolioLoading: boolean;
  portfolioError: string | null;
  assetBalances: AssetBalance[];
  transactions: TransactionRecord[];
  transactionsLoading: boolean;
  transactionsError: string | null;
  supportedAssets: SupportedAsset[];
  assetsLoading: boolean;
  assetsError: string | null;
  positions: Position[];
  positionsLoading: boolean;
  positionsError: string | null;
  // One-shot dashboard hydration: single loading flag + aggregate error state.
  dashboardLoading: boolean;
  dashboardError: string | null;
  // Optimistically-inserted lending transactions (PENDING / CONFIRMED / FAILED).
  pendingTransactions: TransactionRecord[];
  fetchPortfolio: (signal?: AbortSignal) => Promise<void>;
  fetchTransactions: (signal?: AbortSignal) => Promise<void>;
  fetchSupportedAssets: () => Promise<void>;
  fetchPositions: () => Promise<void>;
  hydrateDashboard: () => Promise<void>;
  // Pull-to-refresh: refetches portfolio + transactions concurrently and is
  // abortable so screens can cancel in-flight work on unmount.
  refreshDashboard: (signal?: AbortSignal) => Promise<void>;
};

type StoreState = AuthState & UiState & LendingState & PortfolioState;

/**
 * Indexer amounts are stored as raw 7-decimal-scaled integers; convert to
 * human units the same way the web dashboard does (divide by 1e7).
 */
const parseRawAmount = (raw: string | number | null | undefined): number => {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n / 1e7 : 0;
};

export const useStore = create<StoreState>(
  (set: (partial: Partial<StoreState> | ((state: StoreState) => Partial<StoreState>)) => void, get: () => StoreState) => {
    /**
     * Shared optimistic lending runner used by deposit/withdraw/borrow/repay.
     *
     * Flow:
     *  1. Validate inputs and resolve asset metadata from the supported-assets list.
     *  2. Push a PENDING transaction + apply the optimistic balance delta.
     *  3. Build unsigned XDR via the soroban/transactions module.
     *  4. Sign the XDR with the in-app keypair (or Freighter when bridge is added).
     *  5. Broadcast via Soroban RPC sendTransaction.
     *  6. Poll getTransaction every 2 s up to 60 s.
     *  7. On confirmation: mark CONFIRMED, refresh portfolio/positions/transactions.
     *  8. On any failure: roll back the optimistic delta atomically, mark FAILED.
     */
    const runLending = async (
      kind: LendingKind,
      { amount, asset }: { amount: string; asset: string },
    ): Promise<any> => {
      const numericAmount = parseFloat(amount);
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        throw new Error('Enter a valid amount greater than zero');
      }
      const addr = get().address;
      if (!addr || !get().authToken) {
        throw new Error('Connect your wallet before submitting transactions');
      }

      // ── (a) Resolve asset metadata from the already-loaded supported assets ──
      const supportedAssets = get().supportedAssets;
      const assetMeta = supportedAssets.find(
        (a) => a.symbol.toUpperCase() === asset.toUpperCase(),
      );
      if (!assetMeta) {
        throw new Error(`Asset "${asset}" is not supported by the protocol.`);
      }
      if (!assetMeta.contractId && !assetMeta.isNative) {
        throw new Error(`Asset "${asset}" has no contract ID configured.`);
      }

      // VeilLend contract ID is injected from env; fall back to a sentinel so
      // the build/test path doesn't hard-crash.
      const veilLendContractId =
        (process.env.VEIL_LEND_CONTRACT_ID as string | undefined) ?? '';
      if (!veilLendContractId) {
        throw new Error('VeilLend contract ID is not configured (VEIL_LEND_CONTRACT_ID).');
      }

      // Double-tap guard: reject if a lending action is already in flight.
      if (get().lendingLoading) {
        throw new Error('A transaction is already in progress. Please wait.');
      }

      const pendingTx: TransactionRecord = {
        id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: kind,
        amount: numericAmount,
        asset,
        timestamp: new Date().toISOString(),
        status: 'PENDING',
        txHash: '',
      };

      // Optimistic mutation: surface the tx immediately + bump the balance.
      set((s) => ({
        pendingTransactions: [pendingTx, ...s.pendingTransactions],
        balance: s.balance + optimisticDelta(kind, numericAmount),
        lendingLoading: true,
      }));

      try {
        // ── (b) Build unsigned XDR ───────────────────────────────────────────
        const networkPassphrase =
          (process.env.STELLAR_NETWORK_PASSPHRASE as string | undefined) ??
          'Test SDF Network ; September 2015';

        const unsignedXdr = await TX_BUILDERS[kind]({
          amount,
          decimals: assetMeta.decimals,
          fromAddress: addr,
          contractId: veilLendContractId,
          assetContractId: assetMeta.contractId,
        });

        // ── (c) Sign with in-app keypair (or Freighter when bridge is added) ─
        const signedXdr = await signTransaction(unsignedXdr, networkPassphrase);

        // ── (d) Broadcast to Soroban RPC ─────────────────────────────────────
        const sendResult = await sendTransaction(signedXdr);
        if (sendResult.status === 'ERROR') {
          throw new Error(sendResult.error ?? 'Transaction rejected by node');
        }
        const txHash = sendResult.hash;

        // Update the pending row with the real hash.
        set((s) => ({
          pendingTransactions: s.pendingTransactions.map((t) =>
            t.id === pendingTx.id ? { ...t, txHash } : t,
          ),
        }));

        // ── (e) Poll for confirmation (every 2 s, up to 60 s) ────────────────
        const pollResult = await pollTransaction(txHash);

        if (pollResult.status === 'FAILED') {
          // Try to extract a human-readable contract error.
          const xdrToCheck = pollResult.resultXdr ?? pollResult.errorResultXdr ?? '';
          const errorCode = xdrToCheck ? parseContractErrorCode(xdrToCheck) : null;
          const errorMsg = errorCode !== null
            ? getContractErrorMessage(errorCode)
            : 'Transaction failed on-chain.';
          throw new Error(errorMsg);
        }

        const confirmedTx: TransactionRecord = {
          ...pendingTx,
          status: 'CONFIRMED',
          txHash,
        };

        set((s) => ({
          pendingTransactions: s.pendingTransactions.map((t) =>
            t.id === pendingTx.id ? confirmedTx : t,
          ),
          lastLendingTx: confirmedTx,
          lendingLoading: false,
        }));

        // Upgrade the optimistic delta to the authoritative indexer value.
        // Best-effort: a refresh failure must not fail an already-confirmed tx.
        try {
          await get().fetchPortfolio();
          await get().fetchPositions();
          await get().fetchTransactions();
          await get().refreshProtocolStatus();
        } catch (_e) {
          // authoritative refresh is best-effort
        }

        return confirmedTx;
      } catch (err: any) {
        // Classify the error for appropriate severity + toast messaging.
        const isUserRejection = err instanceof UserRejectedError ||
          err?.name === 'UserRejectedError';
        const isNetworkError =
          !isUserRejection &&
          (err?.message?.toLowerCase().includes('timeout') ||
           err?.message?.toLowerCase().includes('network error') ||
           err?.message?.toLowerCase().includes('fetch'));

        const errorMessage = isUserRejection
          ? 'Transaction rejected'
          : isNetworkError
          ? 'Network error, please retry'
          : (err?.message ?? 'Transaction failed');

        // Report non-rejection errors (user rejections are low severity).
        if (!isUserRejection) {
          reportError(err, {
            severity: isNetworkError ? 'high' : 'medium',
            component: 'runLending',
            metadata: { kind, asset, amount },
          }).catch(() => {});
        }

        // Atomic rollback of the optimistic mutation + FAILED row.
        set((s) => ({
          pendingTransactions: s.pendingTransactions.map((t) =>
            t.id === pendingTx.id
              ? { ...t, status: 'FAILED', errorReason: errorMessage }
              : t,
          ),
          balance: s.balance - optimisticDelta(kind, numericAmount),
          lastLendingTx: { ...pendingTx, status: 'FAILED', errorReason: errorMessage },
          lendingLoading: false,
        }));
        throw Object.assign(err, { message: errorMessage });
      }
    };

    return {
    // Auth
    address: null,
    authToken: null,
    sessionId: null,
    authLoading: false,
    sessionRestored: false,
    setAddress: (address: string | null) => {
      set({ address });
      try {
        if (address) setSecureItem(PERSIST_KEYS.address, address);
        else deleteSecureItem(PERSIST_KEYS.address);
      } catch (e) {
        // ignore persistence errors
      }
    },
    setAuthToken: (token: string | null) => {
      set({ authToken: token });
      try {
        if (token) setSecureItem(PERSIST_KEYS.authToken, token);
        else deleteSecureItem(PERSIST_KEYS.authToken);
      } catch (e) {
        // ignore persistence errors
      }
    },
    logout: async () => {
      // Attempt to revoke the server-side session before clearing local state.
      // Fire-and-forget: a network failure must NOT block the local logout so
      // the user is never stuck with a locally-live session they cannot clear.
      const { authToken } = get();
      if (authToken) {
        try {
          await api.post('/auth/logout');
        } catch (_e) {
          // Backend revocation is best-effort. The JWT strategy also checks DB
          // session existence, so an un-revoked token simply expires naturally.
        }
      }
      // Clear in-memory state
      set({
        address: null,
        authToken: null,
        sessionId: null,
        isPrivacyMode: false,
        profileName: null,
        profileImage: null,
        currency: 'USD',
        notificationsEnabled: true,
        sessionRestored: true,
        authLoading: false,
        lendingLoading: false,
        shieldedLoading: false,
      });
      // Clear ALL persisted keys to prevent stale data on next launch
      try {
        deleteSecureItem(PERSIST_KEYS.authToken);
        deleteSecureItem(PERSIST_KEYS.address);
        deleteSecureItem(PERSIST_KEYS.sessionId);
        deleteSecureItem(PERSIST_KEYS.isPrivacyMode);
        deleteSecureItem(PERSIST_KEYS.profileName);
        deleteSecureItem(PERSIST_KEYS.profileImage);
        deleteSecureItem(PERSIST_KEYS.secretKey);
        deleteSecureItem(PERSIST_KEYS.currency);
        deleteSecureItem(PERSIST_KEYS.notificationsEnabled);
        deleteSecureItem(PERSIST_KEYS.backupConfirmed);
      } catch (e) {
        // ignore persistence errors
      }
      try {
        Clipboard.setString('');
      } catch (e) {}
    },

    // UI
    isPrivacyMode: false,
    profileName: null,
    profileImage: null,
    setProfileName: (name: string | null) => {
      set({ profileName: name });
      try {
        if (name) setSecureItem(PERSIST_KEYS.profileName, name);
        else deleteSecureItem(PERSIST_KEYS.profileName);
      } catch (e) {
        // ignore persistence errors
      }
    },
    setProfileImage: (uri: string | null) => {
      set({ profileImage: uri });
      try {
        if (uri) setSecureItem(PERSIST_KEYS.profileImage, uri);
        else deleteSecureItem(PERSIST_KEYS.profileImage);
      } catch (e) {
        // ignore persistence errors
      }
    },
    togglePrivacyMode: () => {
      const next = !get().isPrivacyMode;
      set({ isPrivacyMode: next });
      try {
        if (next) {
          setSecureItem(PERSIST_KEYS.isPrivacyMode, 'true');
        } else {
          deleteSecureItem(PERSIST_KEYS.isPrivacyMode);
        }
      } catch (e) {
        // ignore persistence errors
      }
    },
    currency: 'USD',
    notificationsEnabled: true,
    setCurrency: (currency: string) => {
      set({ currency });
      try {
        setSecureItem(PERSIST_KEYS.currency, currency);
      } catch (e) {
        // ignore persistence errors
      }
    },
    setNotificationsEnabled: (enabled: boolean) => {
      set({ notificationsEnabled: enabled });
      try {
        setSecureItem(
          PERSIST_KEYS.notificationsEnabled,
          enabled ? 'true' : 'false',
        );
      } catch (e) {
        // ignore persistence errors
      }
    },
    expectedNetwork: 'testnet',
    currentNetwork: 'testnet',
    lastProtocolSyncAt: Date.now(),
    protocolStatusLoading: false,
    protocolStatusError: null,
    shieldedLoading: false,
    isOnline: true,
    networkType: null,
    isInternetReachable: null,
    setNetworkState: (state) => set(state),
    refreshProtocolStatus: async () => {
      set({ protocolStatusLoading: true, protocolStatusError: null });
      try {
        const res = await api.get('/health');
        const network = res.data?.network ?? get().currentNetwork ?? get().expectedNetwork;
        set({
          currentNetwork: network,
          lastProtocolSyncAt: Date.now(),
          protocolStatusLoading: false,
        });
      } catch (err: any) {
        set({
          protocolStatusError: err?.message ?? 'Unable to refresh protocol status',
          protocolStatusLoading: false,
        });
        throw err;
      }
    },

    // Async helpers (Auth)
    requestNonce: async (walletAddress: string) => {
      const res = await api.post('/auth/nonce', { walletAddress });
      return res.data?.nonce;
    },
    verify: async ({ walletAddress, nonce, signature }: { walletAddress: string; nonce: string; signature: string }) => {
      set({ authLoading: true });
      try {
        const res = await api.post('/auth/verify', { walletAddress, nonce, signature });
        const token = res.data?.accessToken || null;
        const sid = res.data?.sessionId || null;
        set({ authLoading: false, authToken: token, address: walletAddress, sessionId: sid });
        try {
          if (token) setSecureItem(PERSIST_KEYS.authToken, token);
          if (sid) setSecureItem(PERSIST_KEYS.sessionId, sid);
        } catch (e) {}
        return token;
      } catch (err: any) {
        set({ authLoading: false });
        // Surface 401/403 as a human-readable error so ConnectWalletScreen
        // can display an inline banner instead of crashing or swallowing it.
        const status = err?.response?.status;
        if (status === 401) {
          throw new Error('Signature verification failed. Please try again.');
        }
        if (status === 403) {
          throw new Error('Access denied. Wallet not authorized.');
        }
        // Nonce already used / expired — friendly message for replay case.
        if (status === 410) {
          throw new Error('Challenge expired. Please request a new one.');
        }
        throw err;
      }
    },

    // Lending — optimistic updates with atomic rollback on failure
    lastLendingTx: null,
    lendingLoading: false,
    deposit: (params) => runLending('deposit', params),
    withdraw: (params) => runLending('withdraw', params),
    borrow: (params) => runLending('borrow', params),
    repay: (params) => runLending('repay', params),

    // Portfolio state
    balance: 0,
    collateralValue: 0,
    borrowedValue: 0,
    availableToBorrow: 0,
    healthFactor: 0,
    portfolioLoading: false,
    portfolioError: null,
    assetBalances: [],
    transactions: [],
    transactionsLoading: false,
    transactionsError: null,
    supportedAssets: [],
    assetsLoading: false,
    assetsError: null,
    positions: [],
    positionsLoading: false,
    positionsError: null,
    dashboardLoading: false,
    dashboardError: null,
    pendingTransactions: [],
    fetchPortfolio: async (signal?: AbortSignal) => {
      const addr = get().address;
      if (!addr) return;
      set({ portfolioLoading: true, portfolioError: null });
      try {
        const res = await fetchWithRetry(`/portfolios/${addr}`, undefined, { signal });
        const data = res.data?.data ?? res.data;
        set({
          balance: data?.balance ?? 0,
          collateralValue: data?.collateralValue ?? 0,
          borrowedValue: data?.borrowedValue ?? 0,
          availableToBorrow: data?.availableToBorrow ?? 0,
          healthFactor: data?.healthFactor ?? 0,
          assetBalances: Array.isArray(data?.balances) ? data.balances : [],
          portfolioLoading: false,
        });
      } catch (err: any) {
        if (err?.name === 'AbortError' || err?.name === 'CanceledError') {
          set({ portfolioLoading: false });
          throw err;
        }
        set({
          portfolioError: err?.message ?? 'Failed to load portfolio',
          portfolioLoading: false,
        });
        throw err;
      }
    },
    fetchTransactions: async (signal?: AbortSignal) => {
      const addr = get().address;
      if (!addr) return;
      set({ transactionsLoading: true, transactionsError: null });
      try {
        const res = await fetchWithRetry(`/transactions/${addr}`, undefined, { signal });
        const data = res.data?.data ?? res.data;
        set({
          transactions: Array.isArray(data) ? data : [],
          transactionsLoading: false,
        });
      } catch (err: any) {
        if (err?.name === 'AbortError' || err?.name === 'CanceledError') {
          set({ transactionsLoading: false });
          throw err;
        }
        set({
          transactionsError: err?.message ?? 'Failed to load transactions',
          transactionsLoading: false,
        });
        throw err;
      }
    },
    fetchSupportedAssets: async () => {
      set({ assetsLoading: true, assetsError: null });
      try {
        // Backend B9: supported (configured) assets.
        const res = await api.get('/assets', { params: { supported: true } });
        const data = res.data?.data ?? res.data;
        set({
          supportedAssets: Array.isArray(data) ? data : [],
          assetsLoading: false,
        });
      } catch (err: any) {
        set({
          assetsError: err?.message ?? 'Failed to load supported assets',
          assetsLoading: false,
        });
        throw err;
      }
    },
    fetchPositions: async () => {
      const addr = get().address;
      if (!addr) return;
      set({ positionsLoading: true, positionsError: null });
      try {
        const res = await api.get(`/indexer/positions/${addr}`);
        const data = res.data?.positions ?? res.data?.data?.positions;
        const rows = Array.isArray(data) ? data : [];
        const positions: Position[] = rows.map((p: any) => ({
          userAddress: p.userAddress ?? addr,
          assetAddress: p.assetAddress ?? '',
          deposited: parseRawAmount(p.deposited ?? p.depositedAmount),
          borrowed: parseRawAmount(p.borrowed ?? p.borrowedAmount),
          updatedAt: p.updatedAt ?? new Date().toISOString(),
        }));
        set({ positions, positionsLoading: false });
      } catch (err: any) {
        set({
          positionsError: err?.message ?? 'Failed to load positions',
          positionsLoading: false,
        });
        throw err;
      }
    },
    hydrateDashboard: async () => {
      const addr = get().address;
      if (!addr) {
        set({ dashboardLoading: false });
        return;
      }
      set({ dashboardLoading: true, dashboardError: null });
      const errors: string[] = [];
      await Promise.all([
        get().fetchSupportedAssets().catch((e: any) => errors.push(e?.message ?? 'assets')),
        get().fetchPortfolio().catch((e: any) => errors.push(e?.message ?? 'portfolio')),
        get().fetchPositions().catch((e: any) => errors.push(e?.message ?? 'positions')),
        get().fetchTransactions().catch((e: any) => errors.push(e?.message ?? 'transactions')),
      ]);
      set({
        dashboardLoading: false,
        dashboardError: errors.length ? errors.join('; ') : null,
      });
    },
    refreshDashboard: async (signal?: AbortSignal) => {
      const addr = get().address;
      if (!addr) {
        set({ dashboardLoading: false });
        return;
      }
      set({ dashboardLoading: true, dashboardError: null });
      let aborted = false;
      const errors: string[] = [];
      await Promise.all([
        get().fetchPortfolio(signal).catch((e: any) => {
          if (e?.name === 'AbortError' || e?.name === 'CanceledError') {
            aborted = true;
            return;
          }
          errors.push(e?.message ?? 'portfolio');
        }),
        get().fetchTransactions(signal).catch((e: any) => {
          if (e?.name === 'AbortError' || e?.name === 'CanceledError') {
            aborted = true;
            return;
          }
          errors.push(e?.message ?? 'transactions');
        }),
      ]);
      set({
        dashboardLoading: false,
        dashboardError: errors.length && !aborted ? errors.join('; ') : null,
      });
    },
  };
  });

/** Optimistic balance delta per lending kind. */
const optimisticDelta = (kind: LendingKind, amount: number): number => {
  switch (kind) {
    case 'deposit':
    case 'borrow':
      return amount;
    case 'withdraw':
    case 'repay':
      return -amount;
  }
};

// ──────────────────────────────────────────────
// Session restore: hydrate Zustand from SecureStore on app launch.
// Uses `sessionRestored` flag so the UI can show a splash until ready.
// ──────────────────────────────────────────────
(async () => {
  try {
    const [token, address, privacyMode, profileName, profileImage, currency, notificationsEnabled, sessionId] =
      await Promise.all([
        getSecureItem(PERSIST_KEYS.authToken),
        getSecureItem(PERSIST_KEYS.address),
        getSecureItem(PERSIST_KEYS.isPrivacyMode),
        getSecureItem(PERSIST_KEYS.profileName),
        getSecureItem(PERSIST_KEYS.profileImage),
        getSecureItem(PERSIST_KEYS.currency),
        getSecureItem(PERSIST_KEYS.notificationsEnabled),
        getSecureItem(PERSIST_KEYS.sessionId),
      ]);

    const patch: Partial<AuthState & UiState> = { sessionRestored: true };
    if (token) patch.authToken = token;
    if (address) patch.address = address;
    if (sessionId) (patch as any).sessionId = sessionId;
    if (privacyMode === 'true') patch.isPrivacyMode = true;
    if (profileName) patch.profileName = profileName;
    if (profileImage) patch.profileImage = profileImage;
    if (currency) patch.currency = currency;
    if (notificationsEnabled !== null) patch.notificationsEnabled = notificationsEnabled === 'true';

    useStore.setState(patch);
  } catch (e) {
    // If hydration fails, still mark session as restored so the app doesn't hang
    useStore.setState({ sessionRestored: true });
  }
})();
