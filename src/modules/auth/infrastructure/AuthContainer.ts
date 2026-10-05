/**
 * ==============================================================================
 * AuthContainer — dependency wiring for the auth module
 * ==============================================================================
 * Creates and connects the production implementations of every auth port:
 *
 *   IAuthRepository   →  MysqlAuthRepository
 *   IOtpSessionStore  →  RedisOtpSessionStore
 *   IAuditSink        →  SqlAuditSink (wraps MysqlAuthRepository)
 *   ICaptchaVerifier  →  HCaptchaVerifier when HCAPTCHA_SECRET is set,
 *                        otherwise DisabledCaptchaVerifier (gate off)
 *
 * Then assembles the AuthServiceDeps bundle that every service function
 * receives instead of importing concrete singletons directly.
 *
 * SINGLE INSTANTIATION: `authDeps` is created once at module load and
 * exported as a frozen object. It behaves like a singleton but is mockable
 * at test time because it's injected, not imported directly by service files.
 *
 * TEST OVERRIDE: tests call `buildAuthDeps({ repo, store, audit })` with
 * in-memory fakes and pass the result directly to service functions.
 * Production code imports `authDeps` and passes it through.
 *
 * ==============================================================================
 */

import { MysqlAuthRepository } from './MysqlAuthRepository.js';
import { RedisOtpSessionStore } from './RedisOtpSessionStore.js';
import { SqlAuditSink } from './SqlAuditSink.js';
import { HCaptchaVerifier, DisabledCaptchaVerifier } from './HCaptchaVerifier.js';
import { ENV } from '../../../config/env.js';
import type { IAuthRepository } from '../ports/IAuthRepository.js';
import type { IOtpSessionStore } from '../ports/IOtpSessionStore.js';
import type { IAuditSink } from '../ports/IAuditSink.js';
import type { ICaptchaVerifier } from '../ports/ICaptchaVerifier.js';

/**
 * The complete set of dependencies injected into every auth service function.
 * Service files accept this type; callers (controller → service) pass authDeps.
 */
export type AuthServiceDeps = {
  readonly repo: IAuthRepository;
  readonly store: IOtpSessionStore;
  readonly audit: IAuditSink;
  readonly captcha: ICaptchaVerifier;
};

/**
 * Build an AuthServiceDeps from explicit implementations.
 * Used both here (production) and in tests (with in-memory fakes).
 */
export function buildAuthDeps(overrides: {
  repo?: IAuthRepository;
  store?: IOtpSessionStore;
  audit?: IAuditSink;
  captcha?: ICaptchaVerifier;
}): AuthServiceDeps {
  const repo = overrides.repo ?? new MysqlAuthRepository();
  const store = overrides.store ?? new RedisOtpSessionStore();
  const audit = overrides.audit ?? new SqlAuditSink(repo);
  const captcha =
    overrides.captcha ??
    (ENV.HCAPTCHA_SECRET
      ? new HCaptchaVerifier(ENV.HCAPTCHA_SECRET, ENV.HCAPTCHA_SITEKEY ?? null)
      : new DisabledCaptchaVerifier());
  return Object.freeze({ repo, store, audit, captcha });
}

/**
 * Production singleton — imported by the auth module's service index and
 * passed down to every service function.
 *
 * Not constructed at import time of individual service files — only when this
 * module is imported, which happens once at app startup via auth/index.ts.
 */
export const authDeps: AuthServiceDeps = buildAuthDeps({});
