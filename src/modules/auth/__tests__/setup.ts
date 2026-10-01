/**
 * vitest global setup — runs once before any test file is loaded.
 *
 * Sets the minimum env vars that env.ts requires so the Zod parser
 * doesn't call process.exit(). Every value here is fake/test-only.
 * Tests that need specific values override them inside the test file.
 */

// ── App ──────────────────────────────────────────────────────────────────────
process.env['NODE_ENV'] = 'development';
process.env['PORT'] = '4000';
process.env['LOG_LEVEL'] = 'error';

// ── Reverse proxy ─────────────────────────────────────────────────────────────
process.env['TRUST_PROXY_HOPS'] = '1';

// ── Database (values won't be used — InMemoryAuthRepository replaces MySQL) ──
process.env['DB_HOST'] = 'localhost';
process.env['DB_USER'] = 'test';
process.env['DB_PASSWORD'] = 'test';
process.env['DB_NAME'] = 'test';

// ── Redis (values won't be used — InMemoryOtpSessionStore replaces Redis) ────
process.env['REDIS_HOST'] = 'localhost';
process.env['REDIS_PASSWORD'] = 'test';

// ── MSG91 ─────────────────────────────────────────────────────────────────────
process.env['MSG91_AUTH_KEY'] = 'test-auth-key';
process.env['MSG91_SMS_SENDER_ID'] = 'TESTID';
process.env['MSG91_SMS_TEMPLATE_ID'] = 'test-template';
process.env['MSG91_WEBHOOK_SECRET'] = 'a'.repeat(32); // min 32 chars
process.env['MSG91_TEST_MOBILES'] = '919000000000'; // canonical test mobile
process.env['MSG91_TEST_OTP'] = '123456';

// ── JWT — use distinct secrets, both at least 32 bytes ───────────────────────
process.env['JWT_ACCESS_SECRET'] = 'test-access-secret-that-is-at-least-32-bytes-long';
process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-that-is-at-least-32-bytes-long';
process.env['JWT_ACCESS_TTL'] = '1h';
process.env['JWT_REFRESH_TTL'] = '30d';

// ── Bcrypt ────────────────────────────────────────────────────────────────────
process.env['BCRYPT_COST'] = '10';

// ── Role gate ──────────────────────────────────────────────────────────────────────────────
process.env['ENABLED_ROLES'] = 'customer';
