import 'reflect-metadata';
import { validateEnvironment } from './environment-validation';

describe('validateEnvironment', () => {
  const validEnvironment = {
    NODE_ENV: 'test',
    JWT_SECRET: 'a-very-secure-secret-key-that-is-at-least-32-chars',
    DB_HOST: 'localhost',
    DB_PASSWORD: 'a-very-secure-db-password-16chars',
    REDIS_URL: 'redis://localhost:6379',
    PORT: '3000',
    DB_PORT: '5432',
    QUEUE_DEPLOY_CONTRACT_CONCURRENCY: '2',
    QUEUE_PROCESS_TTS_CONCURRENCY: '4',
    QUEUE_INDEX_MARKET_NEWS_CONCURRENCY: '3',
  };

  it('accepts a valid startup environment', () => {
    expect(validateEnvironment(validEnvironment)).toBe(validEnvironment);
  });

  it('rejects missing required configuration before bootstrap', () => {
    const { JWT_SECRET: _, ...missingSecret } = validEnvironment;

    expect(() => validateEnvironment(missingSecret)).toThrow(
      'Configuration validation failed',
    );
  });

  it('rejects invalid queue configuration before bootstrap', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        QUEUE_PROCESS_TTS_CONCURRENCY: '0',
      }),
    ).toThrow('QUEUE_PROCESS_TTS_CONCURRENCY must be between 1 and 50');
  });
});