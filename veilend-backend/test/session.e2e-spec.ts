import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { WalletService } from './../src/wallet/wallet.service';
import { PrismaService } from './../src/prisma/prisma.service';

// A syntactically valid Stellar Ed25519 public key, needed now that
// walletAddress is validated with @IsStellarAddress() at the API boundary.
const VALID_WALLET_ADDRESS =
  'GBJEI2M7C3VCWLNGMVIUCA5MNNJICYGKRPS75OZHNUCX33RTRJNQK6MH';

// Real Stellar signature verification and a live Postgres connection are
// unnecessary weight for exercising the session lifecycle end-to-end, so
// both are replaced with lightweight in-memory stubs scoped to this spec.
class FakePrismaService {
  private users = new Map<string, { id: string; walletAddress: string }>();
  private sessions = new Map<
    string,
    { id: string; userId: string; token: string; expiresAt: Date }
  >();
  private nonces = new Map<
    string,
    { id: string; walletAddress: string; nonce: string; used: boolean; expiresAt: Date }
  >();
  private idCounter = 0;

  private nextId(): string {
    this.idCounter += 1;
    return `id-${this.idCounter}`;
  }

  user = {
    upsert: ({
      where,
    }: {
      where: { walletAddress: string };
    }): Promise<{ id: string; walletAddress: string }> => {
      const existing = this.users.get(where.walletAddress);
      if (existing) return Promise.resolve(existing);
      const created = { id: this.nextId(), walletAddress: where.walletAddress };
      this.users.set(where.walletAddress, created);
      return Promise.resolve(created);
    },
  };

  session = {
    create: ({
      data,
    }: {
      data: { userId: string; token: string; expiresAt: Date };
    }) => {
      const record = { id: this.nextId(), ...data };
      this.sessions.set(record.token, record);
      return Promise.resolve(record);
    },
    findUnique: ({ where }: { where: { token: string } }) => {
      const session = this.sessions.get(where.token);
      if (!session) return Promise.resolve(null);
      const user = [...this.users.values()].find((u) => u.id === session.userId) ?? null;
      return Promise.resolve({ ...session, user });
    },
    delete: ({ where }: { where: { id: string } }) => {
      const entry = [...this.sessions.values()].find((s) => s.id === where.id);
      if (!entry) {
        const err = Object.assign(new Error('not found'), { code: 'P2025' });
        throw err;
      }
      this.sessions.delete(entry.token);
      return Promise.resolve(entry);
    },
  };

  walletNonce = {
    updateMany: ({
      where,
      data,
    }: {
      where: { walletAddress: string; used?: boolean; nonce?: string; expiresAt?: { gt: Date } };
      data: { used: boolean };
    }) => {
      let count = 0;
      for (const [key, record] of this.nonces.entries()) {
        if (record.walletAddress !== where.walletAddress) continue;
        if (where.used !== undefined && record.used !== where.used) continue;
        if (where.nonce !== undefined && record.nonce !== where.nonce) continue;
        if (where.expiresAt?.gt !== undefined && record.expiresAt <= where.expiresAt.gt) continue;
        this.nonces.set(key, { ...record, used: data.used });
        count += 1;
      }
      return Promise.resolve({ count });
    },
    create: ({ data }: { data: { walletAddress: string; nonce: string; expiresAt: Date } }) => {
      const id = this.nextId();
      const record = { id, ...data, used: false };
      this.nonces.set(id, record);
      return Promise.resolve(record);
    },
    findFirst: ({
      where,
    }: {
      where: { walletAddress: string; nonce: string };
    }) => {
      const match = [...this.nonces.values()]
        .filter((n) => n.walletAddress === where.walletAddress && n.nonce === where.nonce)
        .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0];
      return Promise.resolve(match ?? null);
    },
    update: ({ where, data }: { where: { id: string }; data: { used: boolean } }) => {
      const record = this.nonces.get(where.id);
      if (!record) return Promise.resolve(null);
      const updated = { ...record, ...data };
      this.nonces.set(where.id, updated);
      return Promise.resolve(updated);
    },
  };
}

describe('Session lifecycle (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(WalletService)
      .useValue({ verifySignature: () => true })
      .overrideProvider(PrismaService)
      .useValue(new FakePrismaService())
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  async function login(): Promise<string> {
    const nonceRes = await request(app.getHttpServer())
      .post('/auth/nonce')
      .send({ walletAddress: VALID_WALLET_ADDRESS });
    const nonceBody = nonceRes.body as { nonce: string };

    const verifyRes = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({
        walletAddress: VALID_WALLET_ADDRESS,
        nonce: nonceBody.nonce,
        signature: 'stubbed',
      });
    const verifyBody = verifyRes.body as { accessToken: string };

    return verifyBody.accessToken;
  }

  it('returns the wallet context for an active session', async () => {
    const token = await login();

    const res = await request(app.getHttpServer())
      .get('/auth/session')
      .set('Authorization', `Bearer ${token}`);
    const body = res.body as { walletAddress: string; sessionId: string };

    expect(res.status).toBe(200);
    expect(body.walletAddress).toBe(VALID_WALLET_ADDRESS);
    expect(typeof body.sessionId).toBe('string');
  });

  it('rejects session introspection without a token', async () => {
    const res = await request(app.getHttpServer()).get('/auth/session');
    const body = res.body as { success: boolean };

    expect(res.status).toBe(401);
    expect(body.success).toBe(false);
  });

  it('invalidates the session on logout', async () => {
    const token = await login();

    const logoutRes = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    expect(logoutRes.status).toBe(201);
    expect(logoutRes.body).toEqual({ revoked: true });

    const sessionRes = await request(app.getHttpServer())
      .get('/auth/session')
      .set('Authorization', `Bearer ${token}`);

    expect(sessionRes.status).toBe(401);
  });

  it('rejects an invalid walletAddress on nonce request', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/nonce')
      .send({ walletAddress: 'not-a-key' });
    const body = res.body as {
      success: boolean;
      error: { message: string };
    };

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.message).toContain(
      'Must be a valid Stellar public key (G...)',
    );
  });

  /**
   * AC: login → confirm authToken present → logout → token absent
   * from server perspective → attempting a portfolio call returns 401,
   * not 200 with stale data.
   */
  it('stale token is rejected after logout — portfolio returns 401, not 200', async () => {
    // 1. Login and confirm a token was issued.
    const token = await login();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    // 2. Confirm the session is live (auth/session returns 200).
    const preLogout = await request(app.getHttpServer())
      .get('/auth/session')
      .set('Authorization', `Bearer ${token}`);
    expect(preLogout.status).toBe(200);

    // 3. Logout — server revokes the session.
    const logoutRes = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(logoutRes.status).toBe(201);
    expect((logoutRes.body as { revoked: boolean }).revoked).toBe(true);

    // 4. The same token must no longer be accepted by the JWT strategy
    //    (because the session row was deleted from the DB).
    const postLogoutSession = await request(app.getHttpServer())
      .get('/auth/session')
      .set('Authorization', `Bearer ${token}`);
    expect(postLogoutSession.status).toBe(401);

    // 5. Attempting a portfolio read with the stale token must return 401,
    //    not 200 with potentially cached data.
    const portfolioRes = await request(app.getHttpServer())
      .get(`/portfolios/${VALID_WALLET_ADDRESS}`)
      .set('Authorization', `Bearer ${token}`);
    expect(portfolioRes.status).toBe(401);
  });

  /**
   * AC: two verify() calls sharing the same signed payload →
   * second is rejected by backend (nonce already used).
   */
  it('second verify with the same nonce is rejected (nonce replay protection)', async () => {
    // Step 1: obtain a fresh nonce.
    const nonceRes = await request(app.getHttpServer())
      .post('/auth/nonce')
      .send({ walletAddress: VALID_WALLET_ADDRESS });
    expect(nonceRes.status).toBe(201);
    const { nonce } = nonceRes.body as { nonce: string };

    // Step 2: first verify succeeds.
    const firstVerify = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({
        walletAddress: VALID_WALLET_ADDRESS,
        nonce,
        signature: 'stubbed',
      });
    expect(firstVerify.status).toBe(201);
    expect(
      (firstVerify.body as { accessToken: string }).accessToken,
    ).toBeTruthy();

    // Step 3: second verify with the SAME nonce+signature must be rejected.
    const secondVerify = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({
        walletAddress: VALID_WALLET_ADDRESS,
        nonce,
        signature: 'stubbed',
      });
    expect(secondVerify.status).toBe(401);
  });
});
