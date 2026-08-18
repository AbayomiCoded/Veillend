import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { formatRawAmount } from '../common/utils/format-raw-amount';
import {
  PortfolioResponseDto,
  PositionSummaryDto,
} from './dto/portfolio-response.dto';

@Injectable()
export class PortfoliosService {
  private readonly logger = new Logger(PortfoliosService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Builds a portfolio snapshot from the indexer's Position table, rather
   * than reading live Horizon balances. Positions are the source of truth
   * for VeilLend protocol collateral/debt; Horizon only knows Stellar
   * classic balances, which are unrelated to the protocol's lending state.
   *
   * The snapshot is taken inside a RepeatableRead transaction so the caller
   * always sees a consistent view of all positions — no phantom rows can
   * appear mid-read between the User lookup and the Position scan.
   */
  async getPortfolio(walletAddress: string): Promise<PortfolioResponseDto> {
    return this.prisma.withRepeatableRead(async (db) => {
      const user = await db.user.findUnique({
        where: { walletAddress },
      });

      if (!user) {
        throw new NotFoundException(
          `No indexed data found for wallet ${walletAddress}`,
        );
      }

      const positions = await db.position.findMany({
        where: { userId: user.id },
        include: { asset: true },
      });

      let collateralValue = 0;
      let borrowedValue = 0;

      const positionSummaries: PositionSummaryDto[] = positions.map((p) => {
        const depositedUsd = Number(p.depositedUsd);
        const borrowedUsd = Number(p.borrowedUsd);
        collateralValue += depositedUsd;
        borrowedValue += borrowedUsd;

        return {
          assetId: p.assetId,
          assetCode: p.asset.code,
          assetSymbol: p.asset.symbol,
          deposited: formatRawAmount(p.depositedRaw, p.asset.decimals),
          borrowed: formatRawAmount(p.borrowedRaw, p.asset.decimals),
          depositedUsd,
          borrowedUsd,
          healthFactor: p.healthFactor === null ? null : Number(p.healthFactor),
          privacyMode: p.privacyMode,
          isStale: p.isStale,
        };
      });

      const availableToBorrow = Math.max(collateralValue - borrowedValue, 0);
      const healthFactor =
        borrowedValue > 0 ? collateralValue / borrowedValue : Infinity;

      this.logger.debug(
        `Portfolio computed for ${walletAddress}: ${positionSummaries.length} position(s)`,
      );

      return {
        walletAddress,
        collateralValue,
        borrowedValue,
        availableToBorrow,
        healthFactor,
        positions: positionSummaries,
      };
    });
  }

  /**
   * Applies a deposit delta to a user's position for one asset under
   * Serializable isolation with a row-level FOR UPDATE lock, ensuring no
   * concurrent write-skew or lost-update is possible.
   *
   * Uses `{ increment }` Prisma mutations so Prisma pushes the arithmetic
   * to Postgres rather than reading the value to JS and writing it back.
   *
   * This method is the accounting-critical path for deposit events that
   * originate from the API layer (as opposed to the indexer path which goes
   * through IndexerRepository.applyEvent).
   */
  async applyDeposit(
    walletAddress: string,
    assetId: string,
    depositedRawDelta: bigint,
    borrowedRawDelta: bigint,
  ): Promise<void> {
    await this.prisma.withSerializable(async (db) => {
      const user = await db.user.findUnique({
        where: { walletAddress },
      });
      if (!user) {
        throw new NotFoundException(
          `No indexed data found for wallet ${walletAddress}`,
        );
      }

      // Ensure the Position row exists before locking.
      await db.$executeRaw(Prisma.sql`
        INSERT INTO "Position" ("id", "userId", "assetId", "updatedAt")
        VALUES (gen_random_uuid(), ${user.id}, ${assetId}, CURRENT_TIMESTAMP)
        ON CONFLICT ("userId", "assetId") DO NOTHING
      `);

      // Acquire a row-level write lock so no concurrent transaction can read
      // and modify this row until we commit.
      await db.$executeRaw(Prisma.sql`
        SELECT 1 FROM "Position"
        WHERE "userId" = ${user.id} AND "assetId" = ${assetId}
        FOR UPDATE
      `);

      // Use atomic increment/decrement — no read-modify-write round-trip.
      await db.position.update({
        where: { userId_assetId: { userId: user.id, assetId } },
        data: {
          depositedRaw: { increment: depositedRawDelta },
          borrowedRaw: { increment: borrowedRawDelta },
          isStale: false,
        },
      });
    });
  }
}
