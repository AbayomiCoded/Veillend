import { validateProductionJwtConfig } from '../src/config/config.module';

/**
 * Bootstrap test: proves that invalid production JWT configuration
 * prevents the Nest application from starting.
 *
 * The validateProductionJwtConfig() function is called both from the
 * ConfigModule validate callback and from main.ts before
 * NestFactory.create().  Testing it directly proves the validation
 * logic rejects invalid production config.
 */
describe('Bootstrap — production JWT configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('fails when NODE_ENV=production and JWT_SECRET=dev_secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'dev_secret';
    process.env.JWT_EXPIRES_IN = '15m';
    process.env.JWT_ISSUER = 'veilend';
    process.env.JWT_AUDIENCE = 'veilend-app';

    expect(() => validateProductionJwtConfig()).toThrow(
      /JWT_SECRET cannot be dev_secret in production/,
    );
  });

  it('fails when NODE_ENV=production and JWT_SECRET is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    process.env.JWT_EXPIRES_IN = '15m';
    process.env.JWT_ISSUER = 'veilend';
    process.env.JWT_AUDIENCE = 'veilend-app';

    expect(() => validateProductionJwtConfig()).toThrow(
      /Missing required environment variable.*JWT_SECRET/,
    );
  });

  it('fails when NODE_ENV=production and JWT_EXPIRES_IN is missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-secure-secret';
    delete process.env.JWT_EXPIRES_IN;
    process.env.JWT_ISSUER = 'veilend';
    process.env.JWT_AUDIENCE = 'veilend-app';

    expect(() => validateProductionJwtConfig()).toThrow(
      /Missing required environment variable.*JWT_EXPIRES_IN/,
    );
  });

  it('fails when NODE_ENV=production and JWT_ISSUER is missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-secure-secret';
    process.env.JWT_EXPIRES_IN = '15m';
    delete process.env.JWT_ISSUER;
    process.env.JWT_AUDIENCE = 'veilend-app';

    expect(() => validateProductionJwtConfig()).toThrow(
      /Missing required environment variable.*JWT_ISSUER/,
    );
  });

  it('fails when NODE_ENV=production and JWT_AUDIENCE is missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-secure-secret';
    process.env.JWT_EXPIRES_IN = '15m';
    process.env.JWT_ISSUER = 'veilend';
    delete process.env.JWT_AUDIENCE;

    expect(() => validateProductionJwtConfig()).toThrow(
      /Missing required environment variable.*JWT_AUDIENCE/,
    );
  });

  it('succeeds when NODE_ENV=production and all required env vars are properly set', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-secure-production-secret';
    process.env.JWT_EXPIRES_IN = '15m';
    process.env.JWT_ISSUER = 'veilend';
    process.env.JWT_AUDIENCE = 'veilend-app';

    expect(() => validateProductionJwtConfig()).not.toThrow();
  });

  it('allows dev_secret when NODE_ENV is not production', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'dev_secret';

    expect(() => validateProductionJwtConfig()).not.toThrow();
  });

  it('allows missing env vars when NODE_ENV is not production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.JWT_SECRET;
    delete process.env.JWT_EXPIRES_IN;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;

    expect(() => validateProductionJwtConfig()).not.toThrow();
  });
});
