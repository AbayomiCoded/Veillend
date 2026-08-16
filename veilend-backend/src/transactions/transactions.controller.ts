import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  TransactionsService,
  PaginatedTransactionsResponse,
} from './transactions.service';
import { ServiceResponse } from '../stellar/types';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get(':walletAddress')
  async getTransactions(
    @Param('walletAddress') walletAddress: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ServiceResponse<PaginatedTransactionsResponse>> {
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    return this.transactionsService.getTransactions(walletAddress, {
      cursor,
      limit: isNaN(parsedLimit!) ? undefined : parsedLimit,
    });
  }
}
