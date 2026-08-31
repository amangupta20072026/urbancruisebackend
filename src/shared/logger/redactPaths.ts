/**
 * ==============================================================================
 * Log redaction paths
 * ==============================================================================
 * Centralized list of JSON paths that Pino replaces with '[REDACTED]' before
 * writing. If you catch yourself thinking "I'll just log the auth header once
 * to debug" — DON'T. Add it here and confirm the debug path works with '[REDACTED]'.
 *
 * Pino's `redact` uses a subset of JSONPath. See:
 * https://getpino.io/#/docs/redaction
 * ==============================================================================
 */

export const REDACT_PATHS: readonly string[] = [
  // Request headers
  'req.headers.authorization',
  'req.headers["set-cookie"]',
  'req.headers.cookie',
  'req.headers["x-api-key"]',

  // Response headers
  'res.headers["set-cookie"]',

  // Common body fields — Pino walks nested objects.
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

  // Direct-level (not under a nested key)
  'password',
  'otp',
  'token',
  'accessToken',
  'refreshToken',
];
