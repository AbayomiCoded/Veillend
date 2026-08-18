import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';

import { WalletService } from '../wallet/wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

import { randomBytes } from 'crypto';

/** How long a nonce remains valid (5 minutes) */
const NONCE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private walletService: WalletService,
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  /**
   * Generate a cryptographic nonce, persist it in the WalletNonce table with
   * an expiry timestamp, and return it to the caller for signing.
   *
   * Any previously issued unused nonces for this wallet are invalidated
   * so that only the latest challenge can be used (prevents nonce stacking).
   *
   * The invalidate-then-create pair runs under Serializable isolation so
   * concurrent nonce-generation requests for the same wallet cannot both
   * commit active nonces simultaneously.
   */
  async generateNonce(
    walletAddress: string,
    ip?: string,
    userAgent?: string,
    correlationId?: string,
  ) {
    const nonce = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

    await this.prisma.withSerializable(async (tx) => {
      // Invalidate any prior unused nonces for this wallet
      await tx.walletNonce.updateMany({
        where: { walletAddress, used: false },
        data: { used: true },
      });

      // Persist the new nonce
      await tx.walletNonce.create({
        data: {
          walletAddress,
          nonce,
          expiresAt,
        },
      });
    });

    await this.prisma.authAuditLog.create({
      data: {
        walletAddress,
        event: 'NONCE_GENERATED',
        ip,
        userAgent,
        correlationId,
      },
    });

    this.logger.log(`Nonce created for: ${walletAddress}`);

    return nonce;
  }

  /**
   * Verify a signed nonce and issue a session.
   *
   * Replay protection:
   *  1. The signature over the nonce must be valid (invalid signatures do
   *     not burn nonces).
   *  2. The nonce is claimed inside a Serializable transaction with a
   *     conditional update that gates on `used = false AND expiresAt > NOW`.
   *     Under concurrency only one request can claim the nonce; the rest
   *     observe zero affected rows and are rejected.
   *  3. A claimed nonce is used to upsert the user and create a session,
   *     all within the same atomic Serializable transaction.
   */
  async verifyWallet(
    walletAddress: string,
    nonce: string,
    signature: string,
    ip?: string,
    userAgent?: string,
    correlationId?: string,
  ) {
    // 1. Signature must be valid before we consume the nonce.
    const valid = this.walletService.verifySignature(
      walletAddress,
      nonce,
      signature,
    );

    if (!valid) {
      this.logger.warn(`Verify failed: invalid signature for ${walletAddress}`);
      await this.logAuthFailure(
        walletAddress,
        'Invalid signature',
        ip,
        userAgent,
        correlationId,
      );
      throw new UnauthorizedException('Authentication failed');
    }

    // 2 + 3. Atomically claim nonce, upsert user, and create session under
    //        Serializable so concurrent claim attempts serialize correctly.
    let sessionResult: { accessToken: string; sessionId: string; expiresAt: string } | null = null;

    try {
      sessionResult = await this.prisma.withSerializable(async (tx) => {
        // Atomically claim the nonce. The WHERE clause is the authoritative
        // used/expiry gate, eliminating the TOCTOU race in a read-then-write.
        const { count } = await tx.walletNonce.updateMany({
          where: {
            walletAddress,
            nonce,
            used: false,
            expiresAt: { gt: new Date() },
          },
          data: { used: true },
        });

        if (count === 0) {
          // Run diagnostic outside the serializable tx to avoid blocking it.
          // The tx will be rolled back by throwing here.
          throw Object.assign(new Error('NONCE_CLAIM_FAILED'), { __nonce_failed: true });
        }

        // Upsert user & create session within the same transaction.
        const user = await tx.user.upsert({
          where: { walletAddress },
          create: { walletAddress },
          update: {},
        });

        const token = this.jwtService.sign({
          walletAddress,
          sub: user.id,
        });

        const { exp } = this.jwtService.decode<{ exp: number }>(token);

        const session = await tx.session.create({
          data: {
            userId: user.id,
            token,
            expiresAt: new Date(exp * 1000),
          },
        });

        return {
          accessToken: token,
          sessionId: session.id,
          expiresAt: session.expiresAt.toISOString(),
        };
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error as { __nonce_failed?: boolean }).__nonce_failed
      ) {
        // Determine why and log appropriately.
        await this.handleNonceClaimFailure(
          walletAddress,
          nonce,
          ip,
          userAgent,
          correlationId,
        );
      }
      throw error;
    }

    await this.prisma.authAuditLog.create({
      data: {
        walletAddress,
        event: 'LOGIN_SUCCESS',
        ip,
        userAgent,
        correlationId,
      },
    });

    this.logger.log(`Session created for ${walletAddress} (id: ${sessionResult!.sessionId})`);

    return sessionResult!;
  }

  /**
   * Classify why an atomic nonce claim affected zero rows and throw the
   * appropriate error. Runs only after the atomic update, so it is purely
   * diagnostic — it never gates authentication.
   */
  private async handleNonceClaimFailure(
    walletAddress: string,
    nonce: string,
    ip?: string,
    userAgent?: string,
    correlationId?: string,
  ): Promise<never> {
    const storedNonce = await this.prisma.walletNonce.findFirst({
      where: { walletAddress, nonce },
      orderBy: { expiresAt: 'desc' },
    });

    if (!storedNonce) {
      this.logger.warn(`Verify failed: unknown nonce for ${walletAddress}`);
      await this.logAuthFailure(
        walletAddress,
        'Unknown nonce',
        ip,
        userAgent,
        correlationId,
      );
      throw new UnauthorizedException('Authentication failed');
    }

    if (storedNonce.used) {
      this.logger.warn(
        `Replay attempt detected for ${walletAddress} (nonce already used)`,
      );
      await this.logAuthFailure(
        walletAddress,
        'Nonce already used',
        ip,
        userAgent,
        correlationId,
      );
      throw new UnauthorizedException('Authentication failed');
    }

    // Expired — mark it used so it can't be retried even if the clock changes.
    await this.prisma.walletNonce.update({
      where: { id: storedNonce.id },
      data: { used: true },
    });
    await this.logAuthFailure(
      walletAddress,
      'Nonce expired',
      ip,
      userAgent,
      correlationId,
    );
    throw new UnauthorizedException('Authentication failed');
  }

  private async logAuthFailure(
    walletAddress: string,
    reason: string,
    ip?: string,
    userAgent?: string,
    correlationId?: string,
  ) {
    await this.prisma.authAuditLog.create({
      data: {
        walletAddress,
        event: 'LOGIN_FAILED',
        reason,
        ip,
        userAgent,
        correlationId,
      },
    });
  }

  /**
   * Validate an active session by its JWT token.
   * Returns session info if the session exists and hasn't expired.
   * Throws if the session has been revoked or is not found.
   */
  async validateSession(token: string) {
    const session = await this.prisma.session.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!session) {
      throw new UnauthorizedException('Session not found or revoked');
    }

    if (new Date() > session.expiresAt) {
      throw new UnauthorizedException('Session has expired');
    }

    // Touch lastSeenAt
    await this.prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });

    return {
      sessionId: session.id,
      walletAddress: session.user.walletAddress,
      userId: session.userId,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Revoke a session by its ID. Idempotent - safe to call multiple times.
   */
  async revokeSession(
    sessionId: string,
    walletAddress?: string,
    ip?: string,
    userAgent?: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.prisma.session.delete({ where: { id: sessionId } });
      if (walletAddress) {
        await this.prisma.authAuditLog.create({
          data: {
            walletAddress,
            event: 'LOGOUT',
            ip,
            userAgent,
            correlationId,
          },
        });
      }
    } catch (error) {
      // Already revoked/gone - logout is idempotent. Anything else is a real failure.
      if (!(
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      )) {
        throw error;
      }
    }
  }

  /**
   * Admin-only query to fetch the recent audit logs for a given wallet address.
   */
  async getAuditLogs(walletAddress: string) {
    return this.prisma.authAuditLog.findMany({
      where: { walletAddress },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
