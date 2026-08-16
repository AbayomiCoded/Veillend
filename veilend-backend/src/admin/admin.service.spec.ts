import { Test, TestingModule } from '@nestjs/testing';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotImplementedException } from '@nestjs/common';
import { AdminAction } from '@prisma/client';

describe('AdminService', () => {
  let service: AdminService;

  const mockPrismaService = {
    $transaction: jest.fn(),
    admin: {
      create: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    session: {
      deleteMany: jest.fn(),
    },
    adminAuditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('addAdmin', () => {
    it('should create admin and log the action in a transaction', async () => {
      const dto = { walletAddress: '0xABCD1234' };
      const actorWallet = '0xACTOR123';
      const mockAdmin = { id: 'admin-1', ...dto, createdAt: new Date() };

      mockPrismaService.$transaction.mockImplementation((callback: any) => {
        const txMock = {
          admin: {
            create: jest.fn().mockResolvedValue(mockAdmin),
          },
          adminAuditLog: {
            create: jest.fn().mockResolvedValue({}),
          },
        };
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
        return callback(txMock);
      });

      const result = await service.addAdmin(dto, actorWallet);

      expect(result).toEqual(mockAdmin);
      expect(mockPrismaService.$transaction).toHaveBeenCalled();
    });
  });

  describe('removeAdmin', () => {
    it('should delete admin, revoke sessions, and log action when user exists', async () => {
      const walletAddress = '0xABCD1234';
      const actorWallet = '0xACTOR123';
      const mockUser = { id: 'user-1', walletAddress };
      const mockAdmin = { id: 'admin-1', walletAddress, createdAt: new Date() };

      mockPrismaService.$transaction.mockImplementation((callback: any) => {
        const txMock = {
          user: {
            findUnique: jest.fn().mockResolvedValue(mockUser),
          },
          session: {
            deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
          },
          admin: {
            delete: jest.fn().mockResolvedValue(mockAdmin),
          },
          adminAuditLog: {
            create: jest.fn().mockResolvedValue({}),
          },
        };
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
        return callback(txMock);
      });

      const result = await service.removeAdmin(walletAddress, actorWallet);

      expect(result).toEqual(mockAdmin);
      expect(mockPrismaService.$transaction).toHaveBeenCalled();
    });

    it('should delete admin and log action even when user does not exist', async () => {
      const walletAddress = '0xABCD1234';
      const actorWallet = '0xACTOR123';
      const mockAdmin = { id: 'admin-1', walletAddress, createdAt: new Date() };

      mockPrismaService.$transaction.mockImplementation((callback: any) => {
        const txMock = {
          user: {
            findUnique: jest.fn().mockResolvedValue(null),
          },
          session: {
            deleteMany: jest.fn(),
          },
          admin: {
            delete: jest.fn().mockResolvedValue(mockAdmin),
          },
          adminAuditLog: {
            create: jest.fn().mockResolvedValue({}),
          },
        };
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
        return callback(txMock);
      });

      const result = await service.removeAdmin(walletAddress, actorWallet);

      expect(result).toEqual(mockAdmin);
      expect(mockPrismaService.$transaction).toHaveBeenCalled();
    });
  });

  describe('listAdmins', () => {
    it('should return all admins', async () => {
      const mockAdmins = [
        { id: 'admin-1', walletAddress: '0xABCD1234', createdAt: new Date() },
        { id: 'admin-2', walletAddress: '0xEFGH5678', createdAt: new Date() },
      ];

      mockPrismaService.admin.findMany.mockResolvedValue(mockAdmins);

      const result = await service.listAdmins();

      expect(result).toEqual(mockAdmins);
      expect(mockPrismaService.admin.findMany).toHaveBeenCalled();
    });
  });

  describe('configureAsset', () => {
    it('should throw NotImplementedException', () => {
      const dto = { assetContractId: 'asset-1', supported: true };
      const actorWallet = '0xACTOR123';

      expect(() => service.configureAsset(dto, actorWallet)).toThrow(
        NotImplementedException,
      );
    });
  });

  describe('setOraclePrice', () => {
    it('should throw NotImplementedException', () => {
      const dto = { assetContractId: 'asset-1', price: 100 };
      const actorWallet = '0xACTOR123';

      expect(() => service.setOraclePrice(dto, actorWallet)).toThrow(
        NotImplementedException,
      );
    });
  });

  describe('setMinCollateralRatio', () => {
    it('should throw NotImplementedException', () => {
      const dto = { minCollateralRatioBps: 15000 };
      const actorWallet = '0xACTOR123';

      expect(() => service.setMinCollateralRatio(dto, actorWallet)).toThrow(
        NotImplementedException,
      );
    });
  });

  describe('getAuditLog', () => {
    it('should return paginated audit logs', async () => {
      const pageOptionsDto = {
        page: 1,
        take: 10,
        skip: 0,
        order: 'DESC' as const,
      };

      const mockLogs = [
        {
          id: 'log-1',
          actorWallet: '0xACTOR123',
          action: AdminAction.ADD_ADMIN,
          target: '0xNEWADMIN',
          payload: {},
          createdAt: new Date(),
        },
      ];

      mockPrismaService.adminAuditLog.findMany.mockResolvedValue(mockLogs);
      mockPrismaService.adminAuditLog.count.mockResolvedValue(1);

      const result = await service.getAuditLog(pageOptionsDto);

      expect(result.data).toEqual(mockLogs);
      expect(result.meta.itemCount).toBe(1);
      expect(mockPrismaService.adminAuditLog.findMany).toHaveBeenCalledWith({
        take: 10,
        skip: 0,
        orderBy: { createdAt: 'desc' },
      });
    });
  });
});
