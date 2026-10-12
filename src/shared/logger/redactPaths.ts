/**
 * Log fields pino replaces with '[REDACTED]'. Add any new secret field here
 * instead of logging it. Syntax: https://getpino.io/#/docs/redaction
 */

export const REDACT_PATHS: readonly string[] = [
  // Request headers
  'req.headers.authorization',
  'req.headers["set-cookie"]',
  'req.headers.cookie',
  'req.headers["x-api-key"]',

  // Response headers
  'res.headers["set-cookie"]',

  // One level deep, under any key.
  '*.password',
  '*.passwordHash',
  '*.otp',
  '*.otpCode',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
  '*.privateKey',

  // Top level.
  'password',
  'otp',
  'token',
  'accessToken',
  'refreshToken',
];
