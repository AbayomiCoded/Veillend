import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import express from 'express';
import { AppModule } from './app.module';
import { createOriginCheckMiddleware } from './middleware/origin-check';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const configService = app.get(ConfigService);

  // ── CORS allowlist ────────────────────────────────────────────────────────
  const envOrigins = configService.get<string>('CORS_ORIGINS', '');
  const allowlist: string[] = [
    'http://localhost:3000',
    'http://localhost:8081',
    ...(envOrigins
      ? envOrigins
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean)
      : []),
  ];

  // Reject cross-origin requests whose Origin is not in the allowlist (403)
  app.use(createOriginCheckMiddleware(allowlist));

  app.enableCors({
    origin: allowlist,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-CSRF-Token'],
    maxAge: 600,
  });

  // ── Security headers ──────────────────────────────────────────────────────
  const isProduction = configService.get<string>('NODE_ENV') === 'production';
  app.use(
    helmet({
      // CSP is intentionally disabled — handled by the frontend reverse-proxy layer
      contentSecurityPolicy: false,
      // HSTS only on production (mainnet); disable for local dev
      hsts: isProduction
        ? { maxAge: 31536000, includeSubDomains: true }
        : false,
      // Remaining defaults (xContentTypeOptions, referrerPolicy, xFrameOptions, etc.)
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
    }),
  );

  // Permissions-Policy (not yet shipped by helmet as a default)
  app.use(
    (
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=()',
      );
      next();
    },
  );

  // ── Body size limits ──────────────────────────────────────────────────────
  // Indexer replay routes may carry large event arrays — allow 5 MB
  app.use('/indexer/replay', express.json({ limit: '5mb' }));
  // All other routes — explicit 100 KB cap
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);
}
void bootstrap();
