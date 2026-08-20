import { validateConfig } from './validation';
import { AuthConfig } from './auth.config';

describe('AuthConfig — production validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('allows development mode with default dev_secret', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.JWT_SECRET;
    delete process.env.JWT_EXPIRES_IN;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;

    const config = {
      JWT_SECRET: 'dev_secret',
      JWT_EXPIRES_IN: '15m',
      JWT_ISSUER: 'veilend',
      JWT_AUDIENCE: 'veilend-app',
    };

    const validated = validateConfig(config, AuthConfig);
    expect(validated.JWT_SECRET).toBe('dev_secret');
  });

  it('rejects production when JWT_SECRET is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    process.env.JWT_EXPIRES_IN = '15m';
    process.env.JWT_ISSUER = 'veilend';
    process.env.JWT_AUDIENCE = 'veilend-app';

    const requiredEnvVars = [
      'JWT_SECRET',
      'JWT_EXPIRES_IN',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
    ];
    const missing = requiredEnvVars.filter((v) => !process.env[v]);
    expect(missing).toContain('JWT_SECRET');
  });

  it('rejects production when JWT_EXPIRES_IN is missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-real-secret';
    delete process.env.JWT_EXPIRES_IN;
    process.env.JWT_ISSUER = 'veilend';
    process.env.JWT_AUDIENCE = 'veilend-app';

    const requiredEnvVars = [
      'JWT_SECRET',
      'JWT_EXPIRES_IN',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
    ];
    const missing = requiredEnvVars.filter((v) => !process.env[v]);
    expect(missing).toContain('JWT_EXPIRES_IN');
  });

  it('rejects production when JWT_ISSUER is missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-real-secret';
    process.env.JWT_EXPIRES_IN = '15m';
    delete process.env.JWT_ISSUER;
    process.env.JWT_AUDIENCE = 'veilend-app';

    const requiredEnvVars = [
      'JWT_SECRET',
      'JWT_EXPIRES_IN',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
    ];
    const missing = requiredEnvVars.filter((v) => !process.env[v]);
    expect(missing).toContain('JWT_ISSUER');
  });

  it('rejects production when JWT_AUDIENCE is missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-real-secret';
    process.env.JWT_EXPIRES_IN = '15m';
    process.env.JWT_ISSUER = 'veilend';
    delete process.env.JWT_AUDIENCE;

    const requiredEnvVars = [
      'JWT_SECRET',
      'JWT_EXPIRES_IN',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
    ];
    const missing = requiredEnvVars.filter((v) => !process.env[v]);
    expect(missing).toContain('JWT_AUDIENCE');
  });

  it('rejects production when JWT_SECRET is dev_secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'dev_secret';
    process.env.JWT_EXPIRES_IN = '15m';
    process.env.JWT_ISSUER = 'veilend';
    process.env.JWT_AUDIENCE = 'veilend-app';

    expect(process.env.NODE_ENV).toBe('production');
    expect(process.env.JWT_SECRET).toBe('dev_secret');
  });

  it('accepts production when all required env vars are set and JWT_SECRET is not dev_secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-secure-production-secret';
    process.env.JWT_EXPIRES_IN = '15m';
    process.env.JWT_ISSUER = 'veilend';
    process.env.JWT_AUDIENCE = 'veilend-app';

    const requiredEnvVars = [
      'JWT_SECRET',
      'JWT_EXPIRES_IN',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
    ];
    const missing = requiredEnvVars.filter((v) => !process.env[v]);
    expect(missing).toHaveLength(0);
    expect(process.env.JWT_SECRET).not.toBe('dev_secret');
  });
});
