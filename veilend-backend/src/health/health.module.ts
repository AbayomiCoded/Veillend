import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { StellarModule } from '../stellar/stellar.module';
import { IndexerModule } from '../indexer/indexer.module';

@Module({
  imports: [StellarModule, IndexerModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
