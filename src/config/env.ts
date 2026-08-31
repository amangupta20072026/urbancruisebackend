/**
 * ==========================================================================
 * Env — parsed process.env
 * --------------------------------------------------------------------------
 * Every environment variable the app reads is declared here as a Zod field.
 * The parse runs ONCE at process start (in `src/index.ts` before anything
 * else) and either:
 *
 *   - returns a fully-typed `ENV` object (fields are typed, coerced, and
 *     safe to read), or
 *   - throws with a formatted list of what's missing/malformed and the
 *     process exits before any other module loads.
 *
 * This is the ONLY place `process.env` is read. All other code imports
 * `ENV` from this module. Rationale:
 *
 *   - Type safety: `ENV.PORT` is `number`, not `string | undefined`.
 *   - Discoverability: one file lists every env var the app cares about.
 *   - Fail-fast: production incidents from "silent default" env vars stop
 *     at boot, not three hours later at 3 AM.
 *
 * Rules under `verbatimModuleSyntax`:
 *   - `import type` for pure type imports.
 * Rules under `noPropertyAccessFromIndexSignature`:
 *   - Read process.env via bracket syntax: process.env['NODE_ENV'].
 * ==========================================================================
 */

import 'dotenv/config';
import { z } from 'zod';

// --------------------------------------------------------------------------
// Schema
// --------------------------------------------------------------------------

const envSchema = z.object({
  // Runtime
  NODE_ENV: z
    .enum(['development', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Reverse proxy — number of hops Express should trust for req.ip
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(1),

  // MySQL
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),

  // JWT
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (openssl rand -base64 48)'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters (openssl rand -base64 48)'),
  JWT_ACCESS_TTL: z.string().default('1h'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // Password hashing
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(10),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  // Request timeout
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

// --------------------------------------------------------------------------
// Parse (runs at import time — index.ts imports this first)
// --------------------------------------------------------------------------

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Format Zod issues into a readable list. Cannot use the app logger yet —
  // it depends on ENV. Fall back to stderr, then die.
  const issues = parsed.error.issues
    .map(i => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

// Extra sanity: warn if is wide-open in a non-dev env.
if (parsed.data.NODE_ENV !== 'development') {
  console.error('outside development. Refusing to start.');
  process.exit(1);
}

// --------------------------------------------------------------------------
// Export
// --------------------------------------------------------------------------

export const ENV = Object.freeze(parsed.data);
export type Env = typeof ENV;

// Helpers
export const isProduction = (): boolean => ENV.NODE_ENV === 'production';
export const isDevelopment = (): boolean => ENV.NODE_ENV === 'development';