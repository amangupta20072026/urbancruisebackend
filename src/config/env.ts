/**
 * ==============================================================================
 * Environment configuration — Zod-parsed, fail-fast
 * ==============================================================================
 * Reads process.env ONCE at boot, validates it against a Zod schema, and exports
 * a strongly-typed `ENV` object for the rest of the app.
 *
 * On failure, the process exits IMMEDIATELY with a readable error listing every
 * missing / invalid variable. The alternative — booting with bad config and
 * crashing on first request — is a nightmare to debug in prod.
 *
 * `dotenv` reads `.env` in dev; in prod, PM2 / systemd inject env directly and
 * .env is not present.
 * ==============================================================================
 */
import 'dotenv/config';
import { z } from 'zod';

const durationRegex = /^\d+(ms|s|m|h|d)$/;

const secretSchema = z
  .string()
  .refine(s => Buffer.byteLength(s, 'utf8') >= 32, 'must be at least 32 bytes');

const schema = z.object({
  // ── App ─────────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // ── Reverse proxy ───────────────────────────────────────────────────────
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  // ── Rate limit ──────────────────────────────────────────────────────────
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(20),

  // ── Database ────────────────────────────────────────────────────────────
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().max(65535).default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  DB_POOL_LIMIT: z.coerce.number().int().positive().max(200).default(20),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ── Redis ───────────────────────────────────────────────────────────────
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive().max(65535).default(6379),
  REDIS_PASSWORD: z.string().min(1),

  // ── MSG91 ───────────────────────────────────────────────────────────────
  // MSG91_AUTH_KEY — server-side auth key. Never ship in the RN app.
  MSG91_AUTH_KEY: z.string().min(1),
  // WhatsApp template + integration for OTP flow. Approved by Meta in advance.
  MSG91_WA_INTEGRATED_NUMBER: z.string().min(1),
  MSG91_WA_TEMPLATE_NAME: z.string().min(1),
  // SMS fallback route (transactional). Sender ID must be pre-approved.
  MSG91_SMS_SENDER_ID: z.string().min(3).max(11),
  MSG91_SMS_TEMPLATE_ID: z.string().min(1),
  // HMAC secret used to verify MSG91 delivery-webhook signatures.
  MSG91_WEBHOOK_SECRET: z.string().min(16),
  // Comma-separated E.164 numbers that bypass MSG91 entirely and use
  // MSG91_TEST_OTP. Kept in env so QA can add/remove without a deploy.
  // Format: '919876543210,919000000001'
  MSG91_TEST_MOBILES: z.string().default(''),
  MSG91_TEST_OTP: z
    .string()
    .regex(/^\d{6}$/)
    .default('654321'),

  // ── JWT ─────────────────────────────────────────────────────────────────
  JWT_ACCESS_SECRET: secretSchema,
  JWT_REFRESH_SECRET: secretSchema,
  JWT_ACCESS_TTL: z.string().regex(durationRegex, 'format: 15m | 1h | 30s | 7d').default('1h'),
  JWT_REFRESH_TTL: z.string().regex(durationRegex, 'format: 15m | 1h | 30s | 7d').default('30d'),

  // ── Bcrypt ──────────────────────────────────────────────────────────────
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(10),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map(i => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(`\n❌ Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

/**
 * Cross-secret sanity check — silent misconfig if both secrets are the same.
 * The whole point of two secrets is that access-token compromise cannot
 * be used to mint refresh tokens.
 */
if (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_REFRESH_SECRET) {
  console.error('\n❌ JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be DIFFERENT values.\n');
  process.exit(1);
}

export const ENV = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  isDev: parsed.data.NODE_ENV === 'development',
});

export type Env = typeof ENV;
