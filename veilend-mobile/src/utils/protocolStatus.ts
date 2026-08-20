export type ProtocolStatusInput = {
  expectedNetwork: string;
  currentNetwork?: string | null;
  walletConnected: boolean;
  lastSyncedAt?: number | null;
  now?: number;
  maxSyncLagMs?: number;
  isOnline?: boolean;
  // True while the backend has timed out on a dashboard fetch and the user
  // hasn't dismissed the notice (issue #344) — distinct from `sync-lag`,
  // which reflects a stale-but-successful sync rather than a hung request.
  backendSlow?: boolean;
};

export type ProtocolStatusBannerId =
  | 'wallet-disconnected'
  | 'network-mismatch'
  | 'sync-lag'
  | 'offline'
  | 'backend-slow';

export type ProtocolStatusBanner = {
  id: ProtocolStatusBannerId;
  severity: 'warning' | 'danger';
  title: string;
  message: string;
  actionLabel?: string;
  // When true, the banner shows a dismiss (×) control instead of/alongside
  // its action button and disappears once the caller acknowledges it.
  dismissible?: boolean;
};

const DEFAULT_SYNC_LAG_MS = 120_000;

/**
 * Builds the ordered set of protocol health warnings shown in the mobile app.
 * Keep this pure so status-priority rules can be tested without rendering React Native.
 */
export function getProtocolStatusBanners({
  expectedNetwork,
  currentNetwork,
  walletConnected,
  lastSyncedAt,
  now = Date.now(),
  maxSyncLagMs = DEFAULT_SYNC_LAG_MS,
  isOnline = true,
  backendSlow = false,
}: ProtocolStatusInput): ProtocolStatusBanner[] {
  const banners: ProtocolStatusBanner[] = [];
  const normalizedExpected = expectedNetwork.trim().toLowerCase();
  const normalizedCurrent = currentNetwork?.trim().toLowerCase();

  if (!isOnline) {
    banners.push({
      id: 'offline',
      severity: 'danger',
      title: 'No Internet Connection',
      message: 'You are offline. Reconnect to refresh live balances and submit transactions.',
    });
  }

  if (!walletConnected) {
    banners.push({
      id: 'wallet-disconnected',
      severity: 'danger',
      title: 'Wallet disconnected',
      message: 'Reconnect your wallet to continue lending and repayment actions.',
      actionLabel: 'Reconnect',
    });
  }

  if (normalizedCurrent && normalizedCurrent !== normalizedExpected) {
    banners.push({
      id: 'network-mismatch',
      severity: 'warning',
      title: 'Wrong Stellar network',
      message: `Connected to ${currentNetwork}; VeilLend expects ${expectedNetwork}.`,
      actionLabel: 'Check network',
    });
  }

  if (typeof lastSyncedAt === 'number' && now - lastSyncedAt > maxSyncLagMs) {
    banners.push({
      id: 'sync-lag',
      severity: 'warning',
      title: 'Sync delayed',
      message: 'Protocol data may be stale. Refresh status before making a lending decision.',
      actionLabel: 'Retry sync',
    });
  }

  if (backendSlow) {
    banners.push({
      id: 'backend-slow',
      severity: 'warning',
      title: 'Backend is responding slowly',
      message: 'A recent request timed out. Your data may be out of date — retry when ready.',
      dismissible: true,
    });
  }

  return banners;
}
