import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { HorizonService } from '../stellar/horizon.service';
import { IndexerRepository } from '../indexer/indexer.repository';
import { ServiceResponse } from '../stellar/types';

export interface TransactionRecord {
  id: string;
  type: 'deposit' | 'withdraw' | 'borrow' | 'repay' | 'transfer';
  amount: number;
  asset: string;
  timestamp: string;
  status: string;
  txHash: string;
  ledger?: number;
}

export interface GetTransactionsOptions {
  cursor?: string;
  limit?: number;
}

export interface PaginatedTransactionsResponse {
  records: TransactionRecord[];
  nextCursor: string | null;
}

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly horizonService: HorizonService,
    private readonly indexerRepository: IndexerRepository,
  ) {}

  async getTransactions(
    walletAddress: string,
    options?: GetTransactionsOptions,
  ): Promise<ServiceResponse<PaginatedTransactionsResponse>> {
    try {
      const limit =
        typeof options?.limit === 'number' && !isNaN(options.limit)
          ? Math.min(Math.max(Math.floor(options.limit), 1), 200)
          : 50;

      let cursorPayload: { timestamp: string; id: string } | null = null;
      if (options?.cursor) {
        try {
          const json = Buffer.from(options.cursor, 'base64').toString('utf8');
          const parsed = JSON.parse(json) as unknown;
          if (
            parsed &&
            typeof parsed === 'object' &&
            'timestamp' in parsed &&
            'id' in parsed &&
            typeof (parsed as Record<string, unknown>).timestamp === 'string' &&
            typeof (parsed as Record<string, unknown>).id === 'string' &&
            !isNaN(
              Date.parse(
                (parsed as Record<string, unknown>).timestamp as string,
              ),
            )
          ) {
            cursorPayload = parsed as { timestamp: string; id: string };
          } else {
            throw new Error('Invalid cursor structure');
          }
        } catch {
          throw new BadRequestException('Invalid cursor');
        }
      }

      // Fetch authoritative protocol transactions from Indexer repository
      const indexerTxs =
        await this.indexerRepository.getTransactions(walletAddress);
      const indexerRecords: TransactionRecord[] = indexerTxs.map((tx) => ({
        id: tx.id,
        type: tx.type,
        amount: parseFloat(tx.amount) || 0,
        asset: tx.assetAddress,
        timestamp: tx.timestamp,
        status: 'success',
        txHash: tx.txHash,
        ledger: tx.ledger,
      }));

      const indexerTxHashes = new Set(
        indexerRecords.map((r) => r.txHash).filter(Boolean),
      );

      // Fetch raw Horizon payments/transfers as fallback on-chain activity
      let horizonRecords: TransactionRecord[] = [];
      try {
        const client = this.horizonService.getClient();
        const txs = await client
          .transactions()
          .forAccount(walletAddress)
          .limit(200)
          .order('desc')
          .call();

        horizonRecords = txs.records
          .filter((tx) => !indexerTxHashes.has(tx.hash))
          .map((tx) => {
            let type: TransactionRecord['type'] = 'transfer';
            let amount = 0;
            let asset = 'XLM';

            if (tx.operations && tx.operations.length > 0) {
              const op = tx.operations[0] as Record<string, unknown>;
              const opType = op.type as string | undefined;
              if (opType === 'payment') {
                type = 'transfer';
                const rawAmount = op.amount;
                amount =
                  typeof rawAmount === 'string' ? parseFloat(rawAmount) : 0;
                const rawAssetCode = op.asset_code;
                asset = typeof rawAssetCode === 'string' ? rawAssetCode : 'XLM';
              }
            }

            return {
              id: tx.id,
              type,
              amount,
              asset,
              timestamp: tx.created_at,
              status: tx.successful ? 'success' : 'failed',
              txHash: tx.hash,
            };
          });
      } catch (horizonError: unknown) {
        const msg =
          horizonError instanceof Error
            ? horizonError.message
            : String(horizonError);
        this.logger.warn(
          `Horizon transactions lookup omitted/failed for ${walletAddress}: ${msg}`,
        );
      }

      // Merge indexer rows and non-duplicate Horizon rows
      const merged = [...indexerRecords, ...horizonRecords];

      // Enforce stable sort key: (timestamp DESC, id ASC)
      merged.sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        if (timeB !== timeA) {
          return timeB - timeA;
        }
        return a.id.localeCompare(b.id);
      });

      // Apply cursor filtering if provided
      let filtered = merged;
      if (cursorPayload) {
        const cTime = new Date(cursorPayload.timestamp).getTime();
        filtered = merged.filter((item) => {
          const itemTime = new Date(item.timestamp).getTime();
          if (itemTime < cTime) return true;
          if (itemTime === cTime && item.id > cursorPayload.id) return true;
          return false;
        });
      }

      const hasMore = filtered.length > limit;
      const pageRecords = hasMore ? filtered.slice(0, limit) : filtered;

      let nextCursor: string | null = null;
      if (hasMore && pageRecords.length > 0) {
        const last = pageRecords[pageRecords.length - 1];
        nextCursor = Buffer.from(
          JSON.stringify({ timestamp: last.timestamp, id: last.id }),
          'utf8',
        ).toString('base64');
      }

      return {
        success: true,
        data: {
          records: pageRecords,
          nextCursor,
        },
      };
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      const message =
        error instanceof Error ? error.message : 'Failed to fetch transactions';
      this.logger.warn(
        `Transaction fetch failed for ${walletAddress}: ${message}`,
      );
      return {
        success: false,
        error: { message, code: 'TRANSACTIONS_FETCH_ERROR', rawError: error },
      };
    }
  }
}
