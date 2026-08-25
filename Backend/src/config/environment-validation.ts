import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ConfigDto } from './config.dto';

/**
 * Validate environment values before Nest creates any dependency clients.
 * This function deliberately has no Nest or application-service dependencies
 * so it can be used by ConfigModule.forRoot's pre-bootstrap validate hook.
 */
export function validateEnvironment(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const config = plainToInstance(ConfigDto, values, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(config, {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
  const messages = errors.flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );

  const hasRedisUrl = Boolean(values.REDIS_URL);
  const hasRedisHost = Boolean(values.REDIS_HOST);
  if (!hasRedisUrl && !hasRedisHost) {
    messages.push(
      'Redis configuration missing: set REDIS_URL or (REDIS_HOST + REDIS_PORT)',
    );
  }

  const portValues = ['PORT', 'DB_PORT', 'REDIS_PORT'];
  for (const key of portValues) {
    const value = values[key];
    if (value !== undefined && (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535)) {
      messages.push(`${key} must be between 1 and 65535`);
    }
  }

  const queueConcurrencyKeys = [
    'QUEUE_DEPLOY_CONTRACT_CONCURRENCY',
    'QUEUE_PROCESS_TTS_CONCURRENCY',
    'QUEUE_INDEX_MARKET_NEWS_CONCURRENCY',
  ];
  for (const key of queueConcurrencyKeys) {
    const value = values[key];
    if (value !== undefined && (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 50)) {
      messages.push(`${key} must be between 1 and 50`);
    }
  }

  if (messages.length > 0) {
    throw new Error(`Configuration validation failed: ${messages.join('; ')}`);
  }

  return values;
}