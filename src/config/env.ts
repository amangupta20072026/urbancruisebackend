/**
 * Reads and validates process.env once at startup, then exports a typed ENV.
 * Any missing or invalid value stops the process with a list of every problem.
 * In development, values come from .env; in production, PM2 injects them.
 */
import 'dotenv/config';
import { accessSync, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { durationRegex } from '../shared/utils/duration.js';

const secretSchema = z
  .string()
  .refine(s => Buffer.byteLength(s, 'utf8') >= 32, 'must be at least 32 bytes');

const schema = z.object({
  // App. NODE_ENV has no default so a server can never start in dev mode by accident.
  NODE_ENV: z.enum(['development', 'production'], {
    error: () =>
      "must be set to 'production' or 'development' (no default — e.g. NODE_ENV=production in .env or the PM2 config)",
  }),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Number of reverse proxies (e.g. Nginx) in front of the app; used for client IPs.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  // Rate limits
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(20),

  // MySQL
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().max(65535).default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  DB_POOL_LIMIT: z.coerce.number().int().positive().max(200).default(20),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Redis
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive().max(65535).default(6379),
  REDIS_PASSWORD: z.string().min(1),

  // MSG91 (SMS OTP). Test mobiles skip SMS and accept MSG91_TEST_OTP.
  MSG91_AUTH_KEY: z.string().min(1),
  MSG91_SMS_SENDER_ID: z.string().min(3).max(11),
  MSG91_SMS_TEMPLATE_ID: z.string().min(1),
  MSG91_WEBHOOK_SECRET: z.string().min(32),
  MSG91_TEST_MOBILES: z.string().default(''),
  MSG91_TEST_OTP: z.string().regex(/^\d{6}$/),

  // Firebase service-account JSON path (absolute path recommended on servers).
  // The file itself is checked below by checkFirebaseServiceAccount().
  FIREBASE_SERVICE_ACCOUNT_PATH: z
    .string({
      error: () =>
        'is required — set it to the path of the Firebase service-account JSON file ' +
        '(e.g. FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json)',
    })
    .trim()
    .min(1, 'must point to the Firebase service-account JSON file'),

  // HTTP server timeouts, applied in server.ts. Request/headers timeouts limit
  // how long a client may take to send a request, not how long a handler runs.
  // Keep-alive must be longer than Nginx's upstream keepalive_timeout, or
  // Node may close a connection Nginx is reusing (502s).
  HTTP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  HTTP_HEADERS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(20_000),
  HTTP_KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(65_000),

  // Hourly OTP-send caps per IPv4 /24 and IPv6 /64 (see ip-block-guard.ts).
  // Up to the soft cap: allowed. Between soft and hard: allowed only while the
  // block's verify rate is at least OTP_IP_BLOCK_MIN_CONVERSION. Above hard:
  // refused. IPv4 is higher because carrier CGNAT shares one /24 across many
  // users. Defaults are starting values; tune them from production data.
  OTP_IPV4_BLOCK_SOFT_CAP_PER_HOUR: z.coerce.number().int().positive().default(100),
  OTP_IPV4_BLOCK_HARD_CAP_PER_HOUR: z.coerce.number().int().positive().default(1000),
  OTP_IPV6_BLOCK_SOFT_CAP_PER_HOUR: z.coerce.number().int().positive().default(20),
  OTP_IPV6_BLOCK_HARD_CAP_PER_HOUR: z.coerce.number().int().positive().default(200),
  OTP_IP_BLOCK_MIN_CONVERSION: z.coerce.number().min(0).max(1).default(0.25),

  // JWT
  JWT_ACCESS_SECRET: secretSchema,
  JWT_REFRESH_SECRET: secretSchema,
  JWT_ACCESS_TTL: z.string().regex(durationRegex, 'format: 15m | 1h | 30s | 7d').default('1h'),
  JWT_REFRESH_TTL: z.string().regex(durationRegex, 'format: 15m | 1h | 30s | 7d').default('30d'),

  // hCaptcha. When set, a number locked for too many wrong OTPs needs a valid
  // captcha token for the next hour. Leave unset until the mobile app shows
  // the hCaptcha widget, or locked numbers cannot log in for that hour.
  HCAPTCHA_SECRET: z.string().min(1).optional(),
  // Optional: reject tokens issued for any other site key.
  HCAPTCHA_SITEKEY: z.string().min(1).optional(),

  // Roles allowed on this environment, comma-separated (e.g. "customer,vendor").
  // Allowed values: customer, vendor, driver, uc. See shared/rbac/enabled-roles.ts.
  ENABLED_ROLES: z
    .string()
    .default('customer')
    .transform(s =>
      s
        .split(',')
        .map(r => r.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(
          z.enum(['customer', 'vendor', 'driver', 'uc'], {
            error: issue =>
              `unknown role "${String(issue.input)}" — allowed: customer, vendor, driver, uc`,
          }),
        )
        .min(1, 'must list at least one role (e.g. ENABLED_ROLES=customer)'),
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

// Separate secrets so a leaked access secret cannot mint refresh tokens.
if (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_REFRESH_SECRET) {
  console.error('\n❌ JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be DIFFERENT values.\n');
  process.exit(1);
}

// A headers timeout above the request timeout would never take effect.
if (parsed.data.HTTP_HEADERS_TIMEOUT_MS > parsed.data.HTTP_REQUEST_TIMEOUT_MS) {
  console.error(
    `\n❌ HTTP_HEADERS_TIMEOUT_MS (${parsed.data.HTTP_HEADERS_TIMEOUT_MS}) must be <= ` +
      `HTTP_REQUEST_TIMEOUT_MS (${parsed.data.HTTP_REQUEST_TIMEOUT_MS}).\n`,
  );
  process.exit(1);
}

// A hard cap below the soft cap would make the conversion check unreachable.
for (const fam of ['IPV4', 'IPV6'] as const) {
  const soft = parsed.data[`OTP_${fam}_BLOCK_SOFT_CAP_PER_HOUR`];
  const hard = parsed.data[`OTP_${fam}_BLOCK_HARD_CAP_PER_HOUR`];
  if (hard < soft) {
    console.error(
      `\n❌ OTP_${fam}_BLOCK_HARD_CAP_PER_HOUR (${hard}) must be >= ` +
        `OTP_${fam}_BLOCK_SOFT_CAP_PER_HOUR (${soft}).\n`,
    );
    process.exit(1);
  }
}

// Anyone who knows MSG91_TEST_OTP can log in as a test mobile, so production
// refuses guessable codes (repeated or sequential digits).
if (parsed.data.NODE_ENV === 'production' && parsed.data.MSG91_TEST_MOBILES.trim() !== '') {
  const code = parsed.data.MSG91_TEST_OTP;
  const weak =
    /^(\d)\1{5}$/.test(code) || // e.g. 111111
    '0123456789'.includes(code) || // e.g. 123456
    '9876543210'.includes(code); // e.g. 654321
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

// Make it visible in production logs when the captcha gate is off.
if (parsed.data.NODE_ENV === 'production' && !parsed.data.HCAPTCHA_SECRET) {
  console.warn(
    '\n⚠️  HCAPTCHA_SECRET is not set — the post-lockout CAPTCHA gate is DISABLED.\n' +
      '   Numbers that trip the OTP brute-force lock are only protected by the\n' +
      '   lock itself. Set HCAPTCHA_SECRET once the mobile app renders hCaptcha.\n',
  );
}

/**
 * Fails startup with a clear message if the Firebase key file is missing,
 * unreadable, or not a service-account key. Never prints the file's values
 * (it contains a private key).
 */
function checkFirebaseServiceAccount(rawPath: string): void {
  const fullPath = resolve(rawPath);
  const fail = (reason: string): never => {
    console.error(
      `\n❌ FIREBASE_SERVICE_ACCOUNT_PATH: ${reason}\n` +
        `   Configured value: ${rawPath}\n` +
        `   Resolved to:      ${fullPath}\n`,
    );
    process.exit(1);
  };

  let isFile: boolean;
  try {
    isFile = statSync(fullPath).isFile();
  } catch {
    return fail('file not found.');
  }
  if (!isFile) fail('path exists but is not a file.');

  try {
    accessSync(fullPath, fsConstants.R_OK);
  } catch {
    fail('file exists but is not readable by the user running the app (check permissions).');
  }

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch {
    return fail('file is not valid JSON.');
  }

  const required = ['project_id', 'client_email', 'private_key'] as const;
  const obj = (json ?? {}) as Record<string, unknown>;
  const missing = required.filter(k => typeof obj[k] !== 'string' || obj[k] === '');
  if (missing.length > 0) {
    fail(
      `file is not a Firebase service-account key (missing: ${missing.join(', ')}). ` +
        'Download it from Firebase console → Project settings → Service accounts.',
    );
  }
}

checkFirebaseServiceAccount(parsed.data.FIREBASE_SERVICE_ACCOUNT_PATH);

export const ENV = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  isDev: parsed.data.NODE_ENV === 'development',
});
