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
 *
 * NOTE: `durationRegex` is imported from shared/utils/duration.ts — that
 * module also defines `ttlToSeconds` used by the auth service. One regex,
 * one parser: keeps the two in lockstep.
 * ==============================================================================
 */
import 'dotenv/config';
import { z } from 'zod';
import { durationRegex } from '../shared/utils/duration.js';

const secretSchema = z
  .string()
  .refine(s => Buffer.byteLength(s, 'utf8') >= 32, 'must be at least 32 bytes');

const schema = z.object({
  // ── App ─────────────────────────────────────────────────────────────────
  // REQUIRED — no default (fix N4). It used to default to 'development', so a
  // production box started without `--env production` silently ran in dev
  // mode: internal error messages (DB host, users, tables) were returned to
  // anonymous clients and every production safety check below switched off.
  // A missing value now stops the boot with a clear message instead.
  NODE_ENV: z.enum(['development', 'production'], {
    error: () =>
      "must be set to 'production' or 'development' (no default — e.g. NODE_ENV=production in .env or the PM2 config)",
  }),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
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

  // ── MSG91 (SMS-only OTP transport) ──────────────────────────────────────
  MSG91_AUTH_KEY: z.string().min(1),
  MSG91_SMS_SENDER_ID: z.string().min(3).max(11),
  MSG91_SMS_TEMPLATE_ID: z.string().min(1),
  MSG91_WEBHOOK_SECRET: z.string().min(32),
  MSG91_TEST_MOBILES: z.string().default(''),
  MSG91_TEST_OTP: z.string().regex(/^\d{6}$/),

  // ── JWT ─────────────────────────────────────────────────────────────────
  JWT_ACCESS_SECRET: secretSchema,
  JWT_REFRESH_SECRET: secretSchema,
  JWT_ACCESS_TTL: z.string().regex(durationRegex, 'format: 15m | 1h | 30s | 7d').default('1h'),
  JWT_REFRESH_TTL: z.string().regex(durationRegex, 'format: 15m | 1h | 30s | 7d').default('30d'),

  // ── Bcrypt ──────────────────────────────────────────────────────────────
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(10),

  // ── CAPTCHA (hCaptcha) ──────────────────────────────────────────────────
  // After a number trips the OTP brute-force lock, mobile_registry marks it
  // captcha_required_until (+1h). When HCAPTCHA_SECRET is set, /otp/request
  // for such a number must carry a valid hCaptcha token (body.captchaToken).
  //
  // Leave UNSET until the mobile app renders the hCaptcha widget — enforcing
  // before the app can send tokens would lock real users out for that hour.
  // While unset the gate is OFF (a production boot prints a warning).
  HCAPTCHA_SECRET: z.string().min(1).optional(),
  /** Optional: when set, tokens issued for any other site key are rejected. */
  HCAPTCHA_SITEKEY: z.string().min(1).optional(),

  // ── Role gate ──────────────────────────────────────────────────────────────────────────
  // Comma-separated list of UserRole values allowed through the authenticate
  // middleware. Any valid JWT whose role is NOT in this list is rejected with
  // 403 ROLE_NOT_ENABLED.
  //
  // Default: 'customer' only (MVP). When a new role's features ship, add it
  // here in the deployment config — no code change needed.
  //
  // Example .env entries:
  //   ENABLED_ROLES=customer
  //   ENABLED_ROLES=customer,vendor
  //   ENABLED_ROLES=customer,vendor,driver,uc
  ENABLED_ROLES: z
    .string()
    .default('customer')
    .transform(s =>
      s
        .split(',')
        .map(r => r.trim())
        .filter(Boolean),
    ),
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

/**
 * Test-mobile safety net. Numbers in MSG91_TEST_MOBILES skip SMS and accept
 * MSG91_TEST_OTP, so anyone who knows that code can log in as those numbers.
 * In production that is only acceptable for a dedicated store-review account
 * with a non-guessable code — never with a trivial code like 123456.
 */
if (parsed.data.NODE_ENV === 'production' && parsed.data.MSG91_TEST_MOBILES.trim() !== '') {
  const code = parsed.data.MSG91_TEST_OTP;
  const weak =
    /^(\d)\1{5}$/.test(code) || // 000000, 111111, ...
    '0123456789'.includes(code) || // 123456, 234567, ...
    '9876543210'.includes(code); // 654321, 987654, ...
  if (weak) {
    console.error(
      '\n❌ MSG91_TEST_MOBILES is set in production with a guessable MSG91_TEST_OTP.\n' +
        '   Anyone could log in as those numbers. Clear MSG91_TEST_MOBILES, or use a\n' +
        '   random 6-digit MSG91_TEST_OTP for a dedicated store-review number only.\n',
    );
    process.exit(1);
  }
  console.warn(
    `\n⚠️  ${parsed.data.MSG91_TEST_MOBILES.split(',').filter(Boolean).length} test mobile(s) ` +
      'enabled in production (fixed OTP, no SMS). Use only for store-review accounts.\n',
  );
}

/**
 * CAPTCHA gate visibility. The gate is a real control only when configured;
 * say so loudly in production so nobody assumes it is protecting them.
 */
if (parsed.data.NODE_ENV === 'production' && !parsed.data.HCAPTCHA_SECRET) {
  console.warn(
    '\n⚠️  HCAPTCHA_SECRET is not set — the post-lockout CAPTCHA gate is DISABLED.\n' +
      '   Numbers that trip the OTP brute-force lock are only protected by the\n' +
      '   lock itself. Set HCAPTCHA_SECRET once the mobile app renders hCaptcha.\n',
  );
}

export const ENV = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  isDev: parsed.data.NODE_ENV === 'development',
});

export type Env = typeof ENV;
