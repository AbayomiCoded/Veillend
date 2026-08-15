import { Injectable, NotImplementedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigureAssetDto } from './dto/configure-asset.dto';
import { SetOraclePriceDto } from './dto/set-oracle-price.dto';
import { SetMinCollateralRatioDto } from './dto/set-min-collateral-ratio.dto';
import { AddAdminDto } from './dto/add-admin.dto';
import { AdminAction } from '@prisma/client';
import { PageOptionsDto } from '../common/dto/page-options.dto';
import { PageDto } from '../common/dto/page.dto';
import { PageMetaDto } from '../common/dto/page-meta.dto';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  /**
   * Add a new admin and log the action
   */
  async addAdmin(dto: AddAdminDto, actorWallet: string) {
    return await this.prisma.$transaction(async (tx) => {
      const admin = await tx.admin.create({
        data: {
          walletAddress: dto.walletAddress,
        },
      });

      await tx.adminAuditLog.create({
        data: {
          actorWallet,
          action: AdminAction.ADD_ADMIN,
          target: dto.walletAddress,
          payload: dto,
        },
      });

      return admin;
    });
  }

  /**
   * Remove an admin and revoke all their sessions in a transaction
   */
  async removeAdmin(walletAddress: string, actorWallet: string) {
    return await this.prisma.$transaction(async (tx) => {
      // Find the user associated with this wallet address
      const user = await tx.user.findUnique({
        where: { walletAddress },
      });

      // Delete all sessions for this user (if they exist)
      if (user) {
        await tx.session.deleteMany({
          where: { userId: user.id },
        });
      }

      // Delete the admin record
      const admin = await tx.admin.delete({
        where: { walletAddress },
      });

      // Log the action
      await tx.adminAuditLog.create({
        data: {
          actorWallet,
          action: AdminAction.REMOVE_ADMIN,
          target: walletAddress,
          payload: {
            removedAdmin: walletAddress,
            sessionsRevoked: user !== null,
          },
        },
      });

      return admin;
    });
  }

  async listAdmins() {
    return await this.prisma.admin.findMany();
  }

  /**
   * Configure asset - NOT IMPLEMENTED
   * Throws NotImplementedException (HTTP 501) as per acceptance criteria
   */
  configureAsset(_dto: ConfigureAssetDto, _actorWallet: string) {
    throw new NotImplementedException(
      'Asset configuration is not yet implemented. This operation requires integration with the Stellar/Soroban contract layer.',
    );
  }

  /**
   * Set oracle price - NOT IMPLEMENTED
   * Throws NotImplementedException (HTTP 501) as per acceptance criteria
   */
  setOraclePrice(_dto: SetOraclePriceDto, _actorWallet: string) {
    throw new NotImplementedException(
      'Oracle price setting is not yet implemented. This operation requires integration with the Stellar/Soroban contract layer.',
    );
  }

  /**
   * Set minimum collateral ratio - NOT IMPLEMENTED
   * Throws NotImplementedException (HTTP 501) as per acceptance criteria
   */
  setMinCollateralRatio(_dto: SetMinCollateralRatioDto, _actorWallet: string) {
    throw new NotImplementedException(
      'Minimum collateral ratio configuration is not yet implemented. This operation requires integration with the Stellar/Soroban contract layer.',
    );
  }

  /**
   * Get paginated audit log
   */
  async getAuditLog(pageOptionsDto: PageOptionsDto) {
    const [logs, itemCount] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        take: pageOptionsDto.take,
        skip: pageOptionsDto.skip,
        orderBy: {
          createdAt: pageOptionsDto.order.toLowerCase() as 'asc' | 'desc',
        },
      }),
      this.prisma.adminAuditLog.count(),
    ]);

    const pageMetaDto = new PageMetaDto({ pageOptionsDto, itemCount });

    return new PageDto(logs, pageMetaDto);
  }
}
