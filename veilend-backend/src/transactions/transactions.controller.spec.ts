import { Test, TestingModule } from '@nestjs/testing';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

describe('TransactionsController', () => {
  let controller: TransactionsController;
  let service: { getTransactions: jest.Mock };

  beforeEach(async () => {
    service = { getTransactions: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [{ provide: TransactionsService, useValue: service }],
    }).compile();

    controller = module.get<TransactionsController>(TransactionsController);
  });

  it('GET /transactions/:walletAddress delegates to TransactionsService with query params', async () => {
    service.getTransactions.mockResolvedValue({
      success: true,
      data: { records: [], nextCursor: null },
    });

    const result = await controller.getTransactions(
      'GABC',
      'some-cursor',
      '50',
    );

    expect(service.getTransactions).toHaveBeenCalledWith('GABC', {
      cursor: 'some-cursor',
      limit: 50,
    });
    expect(result).toEqual({
      success: true,
      data: { records: [], nextCursor: null },
    });
  });
});
