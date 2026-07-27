import { useState, useEffect, useCallback, useRef } from 'react';
import { DashboardData } from '../types/dashboard';
import { getDashboardClient } from '../api/dashboard-client';

export interface UseDashboardDataOptions {
  address: string | null;
  enabled?: boolean;
  refreshInterval?: number;
  retryOnError?: boolean;
  maxRetries?: number;
}

export interface UseDashboardDataResult {
  data: DashboardData | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  isStale: boolean;
  refetch: () => Promise<void>;
  lastUpdated: Date | null;
}

export function useDashboardData(options: UseDashboardDataOptions): UseDashboardDataResult {
  const {
    address,
    enabled = true,
    refreshInterval = 30000,
    retryOnError = true,
    maxRetries = 3
  } = options;

  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isError, setIsError] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const [isStale, setIsStale] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const retryCount = useRef<number>(0);
  const timeoutId = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const client = getDashboardClient();

  const fetchData = useCallback(async (): Promise<void> => {
    // Validate address
    if (!address || !address.startsWith('G')) {
      setData(null);
      setIsLoading(false);
      setIsError(true);
      setError(new Error('Invalid wallet address'));
      return;
    }

    // Cancel any ongoing fetch
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    abortControllerRef.current = new AbortController();

    setIsLoading(true);
    setIsError(false);
    setError(null);
    setIsStale(false);

    try {
      const dashboardData = await client.fetchDashboardData(
        address,
        abortControllerRef.current.signal
      );

      setData(dashboardData);
      setLastUpdated(new Date());
      retryCount.current = 0;
      setIsStale(false);
    } catch (err) {
      // Handle abort errors gracefully
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }

      const errorObj = err instanceof Error ? err : new Error('Failed to fetch dashboard data');
      setError(errorObj);
      setIsError(true);

      // Handle retry logic
      if (retryOnError && retryCount.current < maxRetries) {
        retryCount.current += 1;
        const backoffDelay = Math.min(1000 * Math.pow(2, retryCount.current - 1), 10000);
        setTimeout(() => {
          if (enabled && address) {
            fetchData();
          }
        }, backoffDelay);
      }
    } finally {
      setIsLoading(false);
    }
  }, [address, client, retryOnError, maxRetries, enabled]);

  // Initial fetch and refresh setup
  useEffect(() => {
    if (!enabled || !address) {
      setData(null);
      setIsLoading(false);
      return;
    }

    fetchData();

    // Set up refresh interval
    if (refreshInterval > 0) {
      timeoutId.current = setInterval(() => {
        if (enabled && address) {
          setIsStale(true);
          fetchData();
        }
      }, refreshInterval);
    }

    // Cleanup
    return () => {
      if (timeoutId.current) {
        clearInterval(timeoutId.current);
        timeoutId.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [address, enabled, refreshInterval, fetchData]);

  const refetch = useCallback(async (): Promise<void> => {
    if (!enabled || !address) return;
    await fetchData();
  }, [address, enabled, fetchData]);

  // Reset stale state when component becomes active again
  useEffect(() => {
    if (document.hidden) {
      setIsStale(true);
    }
  }, []);

  // Handle visibility change for stale state
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && isStale) {
        fetchData();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isStale, fetchData]);

  return {
    data,
    isLoading,
    isError,
    error,
    isStale,
    refetch,
    lastUpdated
  };
}