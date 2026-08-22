/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigService } from '../config/app-config.service';
import { IndexerService } from './indexer.service';
import { IndexerRepository } from './indexer.repository';
import { SorobanRpcService } from '../stellar/soroban-rpc.service';
import { scValToNative } from '@stellar/stellar-sdk';

// Mock the scValToNative helper from SDK
jest.mock('@stellar/stellar-sdk', () => {
  const original = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...original,
    scValToNative: jest.fn().mockImplementation((val) => val),
  };
});

describe('IndexerService', () => {
  let service: IndexerService;
  let mockRpcService: {
    getHealth: jest.Mock;
    getLatestLedger: jest.Mock;
    getEvents: jest.Mock;
  };
  let mockRepository: {
    getCheckpoint: jest.Mock;
    saveCheckpoint: jest.Mock;
    applyEvent: jest.Mock;
    processEventSafe: jest.Mock;
    processChunk: jest.Mock;
    cleanExpiredDedup: jest.Mock;
    setAssetSupported: jest.Mock;
    resetDatabase: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockRpcService = {
      getHealth: jest.fn().mockResolvedValue({
        oldestLedger: 10,
        latestLedger: 100,
        status: 'healthy',
      }),
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 50 }),
      getEvents: jest.fn().mockResolvedValue({ events: [], cursor: 'abc' }),
    };

    mockRepository = {
      getCheckpoint: jest.fn().mockResolvedValue({ lastIndexedLedger: 0 }),
      saveCheckpoint: jest.fn().mockResolvedValue(undefined),
      applyEvent: jest.fn().mockResolvedValue(true),
      processEventSafe: jest.fn().mockResolvedValue({ isNew: true }),
      processChunk: jest.fn().mockImplementation((events: unknown[]) =>
        Promise.resolve({
          inserted: Array.isArray(events) ? events.length : 0,
          alreadyProcessed: 0,
        }),
      ),
      cleanExpiredDedup: jest.fn().mockResolvedValue(0),
      setAssetSupported: jest.fn().mockResolvedValue(undefined),
      resetDatabase: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexerService,
        {
          provide: AppConfigService,
          useValue: {
            stellar: {
              sorobanRpcUrls: ['https://test'],
              horizonUrls: ['https://test'],
              networkPassphrase: 'Test SDF Network ; September 2015',
            },
            indexer: {
              contractId:
                'CCW57ZST4NV43YS7JZKMGLG62624NV43YS7JZKMGLG62624NV43YS7JZ',
              startLedger: 1,
              pollIntervalMs: 5000,
            },
          },
        },
        {
          provide: IndexerRepository,
          useValue: mockRepository,
        },
        {
          provide: SorobanRpcService,
          useValue: mockRpcService,
        },
      ],
    }).compile();

    service = module.get<IndexerService>(IndexerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('runIndexer', () => {
    it('should query RPC for events and process chunks inside transactions', async () => {
      mockRepository.getCheckpoint.mockResolvedValueOnce({
        lastIndexedLedger: 20,
      });
      mockRpcService.getLatestLedger.mockResolvedValueOnce({ sequence: 25 });

      const mockEvent = {
        id: 'evt-1',
        topic: ['veillend', 'deposit', 'user-addr', 'asset-addr'],
        value: 1000n,
        ledgerClosedAt: '2026-06-16T17:00:00Z',
        txHash: 'txhash123',
        ledger: 22,
      };

      mockRpcService.getEvents.mockResolvedValueOnce({
        events: [mockEvent],
        cursor: 'next-page-cursor',
      });

      const mockScValToNative = scValToNative as jest.Mock;
      mockScValToNative.mockImplementation((val) => val);

      await service.runIndexer();

      expect(mockRpcService.getLatestLedger).toHaveBeenCalled();
      expect(mockRpcService.getEvents).toHaveBeenCalled();
      expect(mockRepository.processChunk).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            tx: expect.objectContaining({
              id: 'evt-1',
              userAddress: 'user-addr',
              type: 'deposit',
              assetAddress: 'asset-addr',
              amount: '1000',
              ledger: 22,
              txHash: 'txhash123',
              timestamp: '2026-06-16T17:00:00Z',
            }),
            depositedDelta: 1000n,
            borrowedDelta: 0n,
          }),
        ],
        25,
      );
    });

    it('should forward checkpoint if lastIndexedLedger is older than RPC oldestLedger', async () => {
      mockRepository.getCheckpoint.mockResolvedValueOnce({
        lastIndexedLedger: 5,
      });
      mockRpcService.getHealth.mockResolvedValueOnce({
        oldestLedger: 20,
        latestLedger: 100,
      });
      mockRpcService.getLatestLedger.mockResolvedValueOnce({ sequence: 30 });
      mockRpcService.getEvents.mockResolvedValueOnce({ events: [] });

      await service.runIndexer();

      expect(mockRpcService.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          startLedger: 20,
          endLedger: 30,
        }),
      );
      expect(mockRepository.processChunk).toHaveBeenCalledWith([], 30);
    });
  });

  describe('replay', () => {
    it('replays ledger range in chunks with progress reporting and ETA', async () => {
      mockRpcService.getEvents.mockResolvedValue({
        events: [
          {
            id: 'evt-1',
            topic: ['veillend', 'borrow', 'user-addr', 'asset-addr'],
            value: 500n,
            ledger: 50,
          },
        ],
      });

      mockRepository.processChunk.mockResolvedValue({
        inserted: 1,
        alreadyProcessed: 0,
      });

      const result = await service.replay({
        fromLedger: 0,
        toLedger: 100,
        chunk: 50,
      });

      expect(result.success).toBe(true);
      expect(result.fromLedger).toBe(0);
      expect(result.toLedger).toBe(100);
      expect(result.chunk).toBe(50);
      expect(result.percent).toBe(100);
      expect(mockRepository.processChunk).toHaveBeenCalledTimes(3); // 0..49, 50..99, 100..100
    });

    it('returns inserted: 0 and already_processed on duplicate replay run', async () => {
      mockRpcService.getEvents.mockResolvedValue({
        events: [
          {
            id: 'evt-dup',
            topic: ['veillend', 'deposit', 'user-addr', 'asset-addr'],
            value: 100n,
            ledger: 10,
          },
        ],
      });

      // Simulate all events already processed
      mockRepository.processChunk.mockResolvedValue({
        inserted: 0,
        alreadyProcessed: 100,
      });

      const result = await service.replay({
        fromLedger: 0,
        toLedger: 100,
        chunk: 100,
      });

      expect(result.inserted).toBe(0);
      expect(result.already_processed).toBe(200); // chunk 0..99 and 100..100
      expect(result.alreadyProcessed).toBe(200);
      expect(result.currentLedger).toBe(100);
    });
  });

  describe('getSyncStats', () => {
    it('computes lag and status metrics', async () => {
      mockRepository.getCheckpoint.mockResolvedValue({
        lastIndexedLedger: 1500,
      });
      mockRpcService.getLatestLedger.mockResolvedValue({ sequence: 2600 });

      const stats = await service.getSyncStats();

      expect(stats.currentLedger).toBe(1500);
      expect(stats.latestLedger).toBe(2600);
      expect(stats.lag).toBe(1100);
      expect(stats.dedupCounter).toBe(0);
    });
  });

  describe('processEvent scenarios', () => {
    beforeEach(() => {
      mockRepository.getCheckpoint.mockResolvedValue({ lastIndexedLedger: 10 });
      mockRpcService.getLatestLedger.mockResolvedValue({ sequence: 15 });
    });

    it('should process borrow event', async () => {
      const mockEvent = {
        id: 'evt-2',
        topic: ['veillend', 'borrow', 'user-addr', 'asset-addr'],
        value: 500n,
        ledger: 12,
      };
      mockRpcService.getEvents.mockResolvedValueOnce({ events: [mockEvent] });

      await service.runIndexer();

      expect(mockRepository.processChunk).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            tx: expect.objectContaining({
              type: 'borrow',
              amount: '500',
            }),
            depositedDelta: 0n,
            borrowedDelta: 500n,
          }),
        ],
        15,
      );
    });

    it('should process withdraw event', async () => {
      const mockEvent = {
        id: 'evt-3',
        topic: ['veillend', 'withdraw', 'user-addr', 'asset-addr'],
        value: 200n,
        ledger: 13,
      };
      mockRpcService.getEvents.mockResolvedValueOnce({ events: [mockEvent] });

      await service.runIndexer();

      expect(mockRepository.processChunk).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            tx: expect.objectContaining({
              type: 'withdraw',
              amount: '200',
            }),
            depositedDelta: -200n,
            borrowedDelta: 0n,
          }),
        ],
        15,
      );
    });

    it('should process repay event', async () => {
      const mockEvent = {
        id: 'evt-4',
        topic: ['veillend', 'repay', 'user-addr', 'asset-addr'],
        value: 100n,
        ledger: 14,
      };
      mockRpcService.getEvents.mockResolvedValueOnce({ events: [mockEvent] });

      await service.runIndexer();

      expect(mockRepository.processChunk).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            tx: expect.objectContaining({
              type: 'repay',
              amount: '100',
            }),
            depositedDelta: 0n,
            borrowedDelta: -100n,
          }),
        ],
        15,
      );
    });

    it('should process asset_configured event', async () => {
      const mockEvent = {
        id: 'evt-5',
        topic: ['veillend', 'asset_configured', 'admin-addr', 'asset-addr'],
        value: true,
        ledger: 15,
      };
      mockRpcService.getEvents.mockResolvedValueOnce({ events: [mockEvent] });

      await service.runIndexer();

      expect(mockRepository.setAssetSupported).toHaveBeenCalledWith(
        'asset-addr',
        true,
      );
    });
  });
});
