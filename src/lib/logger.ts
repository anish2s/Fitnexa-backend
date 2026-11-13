import pino from 'pino';

/**
 * Structured JSON logger. Sensitive fields are redacted at the logger level so a careless
 * log statement can't leak credentials or tokens.
 */
export function createLogger(level: string) {
  return pino({
    level,
    base: { service: 'gym-api' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.refreshToken',
        '*.otp',
      ],
      censor: '[REDACTED]',
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
