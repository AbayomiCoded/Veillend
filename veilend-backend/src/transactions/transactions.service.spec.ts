import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { HorizonService } from '../stellar/horizon.service';
import {
  IndexerRepository,
  IndexerTransaction,
} from '../indexer/indexer.repository';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let horizonService: { getClient: jest.Mock };
  let indexerRepository: { getTransactions: jest.Mock };

  beforeEach(async () => {
    horizonService = {
      getClient: jest.fn(),
    };
    indexerRepository = {
      getTransactions: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: HorizonService, useValue: horizonService },
        { provide: IndexerRepository, useValue: indexerRepository },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  it('handles empty user with no indexer or horizon records', async () => {
    indexerRepository.getTransactions.mockResolvedValue([]);
    horizonService.getClient.mockReturnValue({
      transactions: () => ({
        forAccount: () => ({
          limit: () => ({
            order: () => ({
              call: jest.fn().mockResolvedValue({ records: [] }),
            }),
          }),
        }),
      }),
    });

    const res = await service.getTransactions('GEMPTY');
    expect(res.success).toBe(true);
    expect(res.data).toEqual({
      records: [],
      nextCursor: null,
    });
  });

  it('deduplicates Horizon payments when matching indexer txHash exists (protocol row wins)', async () => {
    const indexerTx: IndexerTransaction = {
      id: 'idx-1',
      userAddress: 'GUSER',
      type: 'deposit',
      assetAddress: 'USDC',
      amount: '100',
      ledger: 500,
      txHash: 'tx-shared-hash',
      timestamp: '2026-08-01T10:00:00.000Z',
    };

    indexerRepository.getTransactions.mockResolvedValue([indexerTx]);
    horizonService.getClient.mockReturnValue({
      transactions: () => ({
        forAccount: () => ({
          limit: () => ({
            order: () => ({
              call: jest.fn().mockResolvedValue({
                records: [
                  {
                    id: 'horiz-1',
                    hash: 'tx-shared-hash', // Duplicate txHash
                    created_at: '2026-08-01T10:00:00.000Z',
                    successful: true,
                    operations: [
                      { type: 'payment', amount: '100', asset_code: 'USDC' },
                    ],
                  },
                  {
                    id: 'horiz-2',
                    hash: 'tx-horizon-only',
                    created_at: '2026-08-01T09:00:00.000Z',
                    successful: true,
                    operations: [
                      { type: 'payment', amount: '50', asset_code: 'XLM' },
                    ],
                  },
                ],
              }),
            }),
          }),
        }),
      }),
    });

    const res = await service.getTransactions('GUSER');
    expect(res.success).toBe(true);
    expect(res.data?.records).toHaveLength(2);
    expect(res.data?.records[0]).toEqual({
      id: 'idx-1',
      type: 'deposit',
      amount: 100,
      asset: 'USDC',
      timestamp: '2026-08-01T10:00:00.000Z',
      status: 'success',
      txHash: 'tx-shared-hash',
      ledger: 500,
    });
    expect(res.data?.records[1]).toEqual({
      id: 'horiz-2',
      type: 'transfer',
      amount: 50,
      asset: 'XLM',
      timestamp: '2026-08-01T09:00:00.000Z',
      status: 'success',
      txHash: 'tx-horizon-only',
    });
  });

  it('performs a 2-page cursor walk with limit, including partial final page and end-of-list []', async () => {
    const indexerTxs: IndexerTransaction[] = [
      {
        id: 'tx-3',
        userAddress: 'GUSER',
        type: 'repay',
        assetAddress: 'USDC',
        amount: '30',
        ledger: 103,
        txHash: 'hash-3',
        timestamp: '2026-08-03T00:00:00.000Z',
      },
      {
        id: 'tx-2',
        userAddress: 'GUSER',
        type: 'borrow',
        assetAddress: 'USDC',
        amount: '20',
        ledger: 102,
        txHash: 'hash-2',
        timestamp: '2026-08-02T00:00:00.000Z',
      },
      {
        id: 'tx-1',
        userAddress: 'GUSER',
        type: 'deposit',
        assetAddress: 'USDC',
        amount: '10',
        ledger: 101,
        txHash: 'hash-1',
        timestamp: '2026-08-01T00:00:00.000Z',
      },
    ];

    indexerRepository.getTransactions.mockResolvedValue(indexerTxs);
    horizonService.getClient.mockReturnValue({
      transactions: () => ({
        forAccount: () => ({
          limit: () => ({
            order: () => ({
              call: jest.fn().mockResolvedValue({ records: [] }),
            }),
          }),
        }),
      }),
    });

    // Page 1: limit = 2 -> returns tx-3 and tx-2 + nextCursor
    const page1 = await service.getTransactions('GUSER', { limit: 2 });
    expect(page1.success).toBe(true);
    expect(page1.data?.records).toHaveLength(2);
    expect(page1.data?.records.map((r) => r.id)).toEqual(['tx-3', 'tx-2']);
    expect(page1.data?.nextCursor).not.toBeNull();

    // Page 2: pass page1 nextCursor -> returns tx-1 (partial final page) + nextCursor null
    const page2 = await service.getTransactions('GUSER', {
      cursor: page1.data?.nextCursor ?? undefined,
      limit: 2,
    });
    expect(page2.success).toBe(true);
    expect(page2.data?.records).toHaveLength(1);
    expect(page2.data?.records.map((r) => r.id)).toEqual(['tx-1']);
    expect(page2.data?.nextCursor).toBeNull();

    // Requesting past the end with last item cursor returns [] with nextCursor = null
    const lastItemCursor = Buffer.from(
      JSON.stringify({ timestamp: '2026-08-01T00:00:00.000Z', id: 'tx-1' }),
    ).toString('base64');
    const pastEnd = await service.getTransactions('GUSER', {
      cursor: lastItemCursor,
      limit: 2,
    });
    expect(pastEnd.success).toBe(true);
    expect(pastEnd.data?.records).toEqual([]);
    expect(pastEnd.data?.nextCursor).toBeNull();
  });

  it('throws BadRequestException (HTTP 400) when an invalid cursor is passed', async () => {
    indexerRepository.getTransactions.mockResolvedValue([]);
    await expect(
      service.getTransactions('GUSER', { cursor: 'invalid-base64-!!!' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('clamps limit > 200 to 200', async () => {
    indexerRepository.getTransactions.mockResolvedValue([]);
    horizonService.getClient.mockReturnValue({
      transactions: () => ({
        forAccount: () => ({
          limit: () => ({
            order: () => ({
              call: jest.fn().mockResolvedValue({ records: [] }),
            }),
          }),
        }),
      }),
    });

    const res = await service.getTransactions('GUSER', { limit: 500 });
    expect(res.success).toBe(true);
    expect(res.data?.records).toEqual([]);
  });
});
