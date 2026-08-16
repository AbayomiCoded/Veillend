import { DashboardData, HfBreakdownItem, ActivityActionType, AssetBalance } from '../types/dashboard';
import { backendFetch } from '@/lib/server/backendFetch';
import {
  buildAssetRegistry,
  registryDecimals,
  registrySymbol,
  registryName,
  registryMcr,
  warnRegistryUnavailable,
} from './assetRegistry';

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

interface IndexerPosition {
  assetAddress: string;
  depositedAmount: string | number;
  borrowedAmount: string | number;
}

interface IndexerTransaction {
  id: string;
  type: string;
  amount: string | number;
  assetAddress: string;
  timestamp: string;
  txHash: string;
}

interface OraclePrice {
  [assetAddress: string]: number;
}

interface RawAssetDto {
  symbol?: string;
  code?: string;
  name?: string;
  decimals?: number;
  contractId?: string | null;
  isNative?: boolean;
  logoUrl?: string | null;
  minCollateralRatio?: number | null;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Fetches live dashboard data for a specific wallet address.
 * Uses per-asset decimals and MCR from the /assets registry (falls back
 * to hardcoded table when endpoint is unavailable).
 */
export async function fetchDashboardData(address: string): Promise<DashboardData> {
  if (!address || !address.startsWith('G')) {
    throw new Error('Invalid Stellar address provided. Address must start with "G".');
  }

  try {
    // Fetch all four in parallel; /assets is non-fatal (5-min revalidate)
    const [positionsRes, transactionsRes, pricesRes, assetsRes] = await Promise.all([
      backendFetch(`/indexer/positions/${address}`, {
        next: { revalidate: 10 },
        headers: { 'Cache-Control': 'no-cache' },
      }),
      backendFetch(`/indexer/transactions/${address}`, {
        next: { revalidate: 10 },
        headers: { 'Cache-Control': 'no-cache' },
      }),
      backendFetch(`/oracle/prices`, {
        next: { revalidate: 10 },
        headers: { 'Cache-Control': 'no-cache' },
      }),
      // Non-fatal: registry miss → fallback table
      backendFetch(`/assets`, { next: { revalidate: 300 } }).catch(() => null),
    ]);

    if (!positionsRes.ok || !transactionsRes.ok || !pricesRes.ok) {
      throw new Error(
        `Failed to fetch data from indexer: ${JSON.stringify({
          positions: positionsRes.status,
          transactions: transactionsRes.status,
          prices: pricesRes.status,
        })}`,
      );
    }

    // ── Parse asset registry ──────────────────────────────────────────────
    const rawAssetsJson = assetsRes?.ok
      ? (await assetsRes.json() as { data?: RawAssetDto[]; assets?: RawAssetDto[] } | RawAssetDto[])
      : null;

    let rawAssets: RawAssetDto[] = [];
    if (rawAssetsJson) {
      if (Array.isArray(rawAssetsJson)) {
        rawAssets = rawAssetsJson;
      } else {
        rawAssets = rawAssetsJson.data ?? rawAssetsJson.assets ?? [];
      }
    } else {
      warnRegistryUnavailable();
    }
    const registry = buildAssetRegistry(rawAssets);

    // ── Parse core data ───────────────────────────────────────────────────
    const positionsData = await positionsRes.json() as { positions: IndexerPosition[] };
    const transactionsData = await transactionsRes.json() as { transactions: IndexerTransaction[] };
    const pricesData = await pricesRes.json() as { prices: OraclePrice };

    if (!positionsData.positions || !Array.isArray(positionsData.positions)) {
      throw new Error('Invalid positions data format received from indexer');
    }

    const positions = positionsData.positions;
    const transactions = transactionsData.transactions ?? [];
    const prices = pricesData.prices ?? {};

    // ── Process positions ─────────────────────────────────────────────────
    let totalDepositedUsd = 0;
    let totalBorrowedUsd = 0;
    const depositedAssets: AssetBalance[] = [];
    const borrowedAssets: AssetBalance[] = [];
    const hfBreakdown: HfBreakdownItem[] = [];
    let weightedCollateral = 0;
    let missingMcrSymbol: string | null = null;

    for (const pos of positions) {
      const decimals = registryDecimals(registry, pos.assetAddress);
      const deposited = Number(pos.depositedAmount) / (10 ** decimals);
      const borrowed  = Number(pos.borrowedAmount)  / (10 ** decimals);
      const symbol    = registrySymbol(registry, pos.assetAddress);
      const name      = registryName(registry, pos.assetAddress);
      const price     = prices[pos.assetAddress] ?? 0;
      const logoUrl   = registry.get(pos.assetAddress)?.logoUrl ?? undefined;
      const mcr       = registryMcr(registry, pos.assetAddress);

      if (deposited > 0 && price > 0) {
        const usdValue = deposited * price;
        totalDepositedUsd += usdValue;
        depositedAssets.push({
          assetSymbol: symbol,
          assetName: name,
          balance: deposited,
          usdValue,
          decimals,
          minCollateralRatio: mcr ?? undefined,
          logoUrl,
        });
        if (mcr != null) {
          const weighted = usdValue * mcr;
          weightedCollateral += weighted;
          hfBreakdown.push({ symbol, depositedUsd: usdValue, minCollateralRatio: mcr, weightedUsd: weighted });
        } else if (usdValue > 0 && !missingMcrSymbol) {
          missingMcrSymbol = symbol;
        }
      }

      if (borrowed > 0 && price > 0) {
        const usdValue = borrowed * price;
        totalBorrowedUsd += usdValue;
        borrowedAssets.push({
          assetSymbol: symbol,
          assetName: name,
          balance: borrowed,
          usdValue,
          decimals,
          logoUrl,
        });
      }
    }

    // ── Health factor (per-asset MCR weighted) ────────────────────────────
    let healthFactor: number;
    let hfWarning: string | undefined;

    if (totalBorrowedUsd === 0) {
      healthFactor = Infinity;
    } else if (missingMcrSymbol) {
      healthFactor = -1; // sentinel — UI should show hfWarning instead
      hfWarning = 'Asset registry not loaded — refresh';
    } else {
      healthFactor = Math.min(weightedCollateral / totalBorrowedUsd, 99.99);
    }

    const totalBalanceUsd = totalDepositedUsd - totalBorrowedUsd;

    // ── Process transactions ──────────────────────────────────────────────
    const recentActivity = Array.isArray(transactions)
      ? transactions
          .map((tx: IndexerTransaction) => {
            const decimals = registryDecimals(registry, tx.assetAddress);
            const amount   = Number(tx.amount) / (10 ** decimals);
            const price    = prices[tx.assetAddress] ?? 0;
            return {
              id: tx.id,
              action: mapTransactionType(tx.type),
              assetSymbol: registrySymbol(registry, tx.assetAddress),
              amount,
              usdValue: amount * price,
              timestamp: tx.timestamp,
              status: 'COMPLETED' as const,
              txHash: tx.txHash,
            };
          })
          .filter((activity) => activity.usdValue > 0)
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, 50)
      : [];

    return {
      portfolio: {
        totalBalanceUsd,
        healthFactor,
        totalDepositedUsd,
        totalBorrowedUsd,
        depositedAssets,
        borrowedAssets,
        lastUpdated: new Date().toISOString(),
        hfBreakdown,
        hfWarning,
      },
      recentActivity,
    };
  } catch (error) {
    console.error('Dashboard API Error:', error);
    if (error instanceof Error) {
      throw new Error(`Failed to load dashboard data: ${error.message}`);
    }
    throw new Error('Could not load live dashboard data. Please check your connection.');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapTransactionType(type: string): ActivityActionType {
  const normalizedType = type.toUpperCase();
  switch (normalizedType) {
    case 'DEPOSIT':
    case 'SUPPLY':
      return 'DEPOSIT';
    case 'BORROW':
      return 'BORROW';
    case 'REPAY':
    case 'REPAYMENT':
      return 'REPAY';
    case 'WITHDRAW':
    case 'WITHDRAWAL':
      return 'WITHDRAW';
    default:
      console.warn(`Unknown transaction type: ${type}, defaulting to DEPOSIT`);
      return 'DEPOSIT';
  }
}
