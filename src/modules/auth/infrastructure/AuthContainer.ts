/**
 * Wires the auth dependencies: MySQL repository, Redis store, SQL audit sink,
 * hCaptcha verifier (disabled when HCAPTCHA_SECRET is unset) and the enabled
 * roles. Production passes authDeps to every service call; tests build their
 * own with buildAuthDeps({ ...fakes }).
 */

import { MysqlAuthRepository } from './MysqlAuthRepository.js';
import { RedisOtpSessionStore } from './RedisOtpSessionStore.js';
import { SqlAuditSink } from './SqlAuditSink.js';
import { HCaptchaVerifier, DisabledCaptchaVerifier } from './HCaptchaVerifier.js';
import { ENV } from '../../../config/env.js';
import { ENABLED_ROLE_SET } from '../../../shared/rbac/enabled-roles.js';
import type { UserRole } from '../../../shared/rbac/roles.js';
import type { IAuthRepository } from '../ports/IAuthRepository.js';
import type { IOtpSessionStore } from '../ports/IOtpSessionStore.js';
import type { IAuditSink } from '../ports/IAuditSink.js';
import type { ICaptchaVerifier } from '../ports/ICaptchaVerifier.js';

/** Dependencies passed to every auth service function. */
export type AuthServiceDeps = {
  readonly repo: IAuthRepository;
  readonly store: IOtpSessionStore;
  readonly audit: IAuditSink;
  readonly captcha: ICaptchaVerifier;
  /** Roles allowed to request OTPs, log in and refresh. */
  readonly enabledRoles: ReadonlySet<UserRole>;
};

/** Builds deps, defaulting each missing one to the production implementation. */
export function buildAuthDeps(overrides: {
  repo?: IAuthRepository;
  store?: IOtpSessionStore;
  audit?: IAuditSink;
  captcha?: ICaptchaVerifier;
  enabledRoles?: ReadonlySet<UserRole>;
}): AuthServiceDeps {
  const repo = overrides.repo ?? new MysqlAuthRepository();
  const store = overrides.store ?? new RedisOtpSessionStore();
  const audit = overrides.audit ?? new SqlAuditSink(repo);
  const captcha =
    overrides.captcha ??
    (ENV.HCAPTCHA_SECRET
      ? new HCaptchaVerifier(ENV.HCAPTCHA_SECRET, ENV.HCAPTCHA_SITEKEY ?? null)
      : new DisabledCaptchaVerifier());
  const enabledRoles = overrides.enabledRoles ?? ENABLED_ROLE_SET;
  return Object.freeze({ repo, store, audit, captcha, enabledRoles });
}

/** Production deps, created once when this module is first imported. */
export const authDeps: AuthServiceDeps = buildAuthDeps({});
