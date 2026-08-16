import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { IndexerModule } from '../indexer/indexer.module';
import { StellarModule } from '../stellar/stellar.module';

@Module({
  imports: [StellarModule, IndexerModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
