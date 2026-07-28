'use client'

import * as React from 'react';
import { DashboardData } from '@/lib/types/dashboard';
import { fetchDashboardData } from '@/lib/api/dashboard';

/** Discrete sync states the UI can branch on. */
export type SyncStatus = 'idle' | 'loading' | 'live' | 'stale' | 'empty' | 'error';

export interface PositionSyncState {
  status: SyncStatus;
  data: DashboardData | null;
  /** When the data was last successfully refreshed (ms epoch), null until first load */
  lastSyncedAt: number | null;
  error: string | null;
  /** Manually trigger a refresh */
  refresh: () => void;
}

interface UsePositionSyncOptions {
  address?: string;
  /** Poll interval in ms (default 10s, matching the indexer revalidate window) */
  intervalMs?: number;
  /** How long before data is considered stale and flagged in the UI (default 30s) */
  staleAfterMs?: number;
  /** Pause polling (e.g. when the tab is hidden or wallet disconnected) */
  enabled?: boolean;
}

/**
 * Keeps positions, collateral and borrowed values in sync with live protocol
 * state by polling the indexer. Exposes explicit loading / empty / stale / error
 * states so the dashboard can represent each clearly. Privacy mode is orthogonal:
 * this hook only manages the values; masking is handled at render time.
 */
export function usePositionSync(
  options: UsePositionSyncOptions = {},
): PositionSyncState {
  const {
    address,
    intervalMs = 10_000,
    staleAfterMs = 30_000,
    enabled = true,
  } = options;

  const [data, setData] = React.useState<DashboardData | null>(null);
  const [status, setStatus] = React.useState<SyncStatus>('idle');
  const [lastSyncedAt, setLastSyncedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Guards against state updates after unmount / overlapping requests
  const inFlight = React.useRef<boolean>(false);
  const mounted = React.useRef<boolean>(true);
  const abortControllerRef = React.useRef<AbortController | null>(null);

  const load = React.useCallback(async () => {
    // Validate address before attempting to fetch
    if (!address || !address.startsWith('G')) {
      setStatus('idle');
      setError('No valid wallet address provided');
      return;
    }

    if (inFlight.current) return;
    inFlight.current = true;

    // Cancel any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Only show the full loading state on the very first fetch; subsequent
    // polls refresh in the background without flickering the UI.
    setStatus((prev) => (prev === 'idle' ? 'loading' : prev));

    try {
      const result = await fetchDashboardData(address);
      
      if (!mounted.current) return;

      const isEmpty =
        result.portfolio.depositedAssets.length === 0 &&
        result.portfolio.borrowedAssets.length === 0 &&
        result.recentActivity.length === 0;

      setData(result);
      setLastSyncedAt(Date.now());
      setError(null);
      setStatus(isEmpty ? 'empty' : 'live');
    } catch (err) {
      if (!mounted.current) return;
      
      // Handle abort errors gracefully
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      
      const errorMessage = err instanceof Error ? err.message : 'Failed to sync positions.';
      setError(errorMessage);
      
      // Keep stale data visible if we have it; otherwise surface the error.
      setStatus(data ? 'stale' : 'error');
    } finally {
      inFlight.current = false;
      abortControllerRef.current = null;
    }
  }, [address, data]);

  // Initial load + interval polling
  React.useEffect(() => {
    mounted.current = true;
    
    // Reset state when address changes
    if (address) {
      setStatus('idle');
      setData(null);
      setError(null);
      setLastSyncedAt(null);
    }

    if (!enabled || !address) {
      setStatus('idle');
      return;
    }

    // Intentional fetch-on-mount: load() flips status to 'loading' before the
    // first await, which the rule flags; that initial transition is the point.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    
    const id = setInterval(() => {
      if (mounted.current && enabled && address) {
        load();
      }
    }, intervalMs);

    return () => {
      mounted.current = false;
      clearInterval(id);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, address, load]);

  // Independent staleness ticker: flags data as stale if a poll hasn't
  // succeeded within staleAfterMs, even while requests keep failing.
  React.useEffect(() => {
    if (lastSyncedAt === null) return;
    
    const id = setInterval(() => {
      if (!mounted.current) return;
      
      setStatus((prev) => {
        // Only transition from live or empty to stale
        if (prev !== 'live' && prev !== 'empty') return prev;
        
        const isStale = Date.now() - lastSyncedAt > staleAfterMs;
        return isStale ? 'stale' : prev;
      });
    }, Math.min(staleAfterMs, 5_000));
    
    return () => clearInterval(id);
  }, [lastSyncedAt, staleAfterMs]);

  // Clean up on unmount
  React.useEffect(() => {
    return () => {
      mounted.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  return {
    status,
    data,
    lastSyncedAt,
    error,
    refresh: load,
  };
}