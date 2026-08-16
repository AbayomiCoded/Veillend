import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';

import { AppController } from '../app.controller';
import { AppService } from '../app.service';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { createOriginCheckMiddleware } from '../middleware/origin-check';

// ── CORS origin-check middleware tests ────────────────────────────────────────

describe('createOriginCheckMiddleware', () => {
  const allowlist = ['http://localhost:3000', 'http://localhost:8081'];
  const middleware = createOriginCheckMiddleware(allowlist);

  it('blocks an unlisted origin with 403', () => {
    const req = { headers: { origin: 'http://evil.com' } } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Forbidden: Origin not allowed',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes requests with no Origin header', () => {
    const req = { headers: {} } as any;
    const res = {} as any;
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('passes requests from an allowlisted origin', () => {
    const req = { headers: { origin: 'http://localhost:3000' } } as any;
    const res = {} as any;
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

describe('CORS origin-check via supertest', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    app = module.createNestApplication();
    app.use(createOriginCheckMiddleware(['http://localhost:3000']));
    await app.init();
  });

  afterAll(() => app.close());

  it('returns 403 for requests from a non-allowlisted Origin', () => {
    return request(app.getHttpServer())
      .get('/')
      .set('Origin', 'http://attacker.example.com')
      .expect(403);
  });

  it('returns 200 for requests from an allowlisted Origin', () => {
    return request(app.getHttpServer())
      .get('/')
      .set('Origin', 'http://localhost:3000')
      .expect(200);
  });
});

// ── Rate-limiter tests on AuthController ──────────────────────────────────────

describe('ThrottlerGuard — AuthController nonce endpoint', () => {
  let app: INestApplication;

  const mockAuthService = {
    generateNonce: jest.fn().mockReturnValue('mock-nonce-value'),
    verifyWallet: jest.fn().mockResolvedValue({ accessToken: 'jwt' }),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: 'default',
            // Global limit is high; the @Throttle override on AuthController
            // caps nonce + verify at 15 per minute.
            ttl: 60000,
            limit: 200,
          },
        ]),
      ],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('returns 429 on the 16th rapid request to POST /auth/nonce', async () => {
    // Send 15 requests — all should succeed (201 Created by default for POST)
    for (let i = 0; i < 15; i++) {
      await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ walletAddress: 'GABC123' });
    }

    // 16th request must be throttled
    return request(app.getHttpServer())
      .post('/auth/nonce')
      .send({ walletAddress: 'GABC123' })
      .expect(429);
  });
});
