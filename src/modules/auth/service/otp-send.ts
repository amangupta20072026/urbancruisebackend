/**
 * ==============================================================================
 * auth.service — sendOtp
 * ==============================================================================
 * Orchestrates POST /auth/otp/request.
 *
 * ORDER OF CHECKS (matters — keep this order):
 *   0. Role enabled on this environment? (fix H2) — FIRST, so a disabled
 *                                       role costs nothing: no Redis quota,
 *                                       no DB lookup, no SMS, and no replay
 *                                       of a snapshot taken while the role
 *                                       was still enabled.
 *   1. Idempotency snapshot lookup    — cheap; fingerprinted by
 *                                       sha256(mobile|role) so a reused key
 *                                       with a different payload returns 409
 *                                       rather than replaying someone else's
 *                                       response.
 *   2. Mobile registry hard blocks    — admin block, lock.
 *   2b. Post-lockout CAPTCHA gate     — while captcha_required_until is in
 *                                       the future, a valid CAPTCHA token is
 *                                       required (audit fix #10). Only when
 *                                       HCAPTCHA_SECRET is configured; test
 *                                       mobiles are exempt. Fails CLOSED if
 *                                       the CAPTCHA provider is unreachable.
 *   3. Reserve rate-limit quota        — ATOMIC: cooldown via SET NX, then
 *                                       INCR every bucket and compare the
 *                                       post-increment value. Done BEFORE
 *                                       the account lookup (so the lookup is
 *                                       throttled) and BEFORE any SMS (so
 *                                       parallel requests cannot all slip
 *                                       through — audit fix #1).
 *   4. Vendor / UC / Driver gate       — the account MUST already exist in
 *                                       its table and be active. Otherwise
 *                                       403 ACCOUNT_NOT_PROVISIONED /
 *                                       ACCOUNT_SUSPENDED with a clear
 *                                       message, and NO SMS is sent. The
 *                                       rejected attempt still burns rate-
 *                                       limit quota, which caps how fast
 *                                       anyone can probe which numbers are
 *                                       registered.
 *                                       Customers are NOT checked here: new
 *                                       and existing customers both receive
 *                                       an OTP, so this endpoint reveals
 *                                       nothing about customer accounts.
 *   5. Generate OTP, HMAC it, store the session.
 *   6. MSG91 dispatch — skipped for test mobiles. On a definitive provider
 *      failure the per-mobile quota is refunded (user may retry at once).
 *   7. Insert otp_events row (via audit sink).
 *   8. Snapshot response for idempotency.
 *   9. Best-effort mobile_registry touch.
 *
 * DESIGN CHANGE (DIP fix):
 *   Accepts AuthServiceDeps instead of importing the concrete redis /
 *   repo singletons. All infrastructure access goes through:
 *     deps.store  — IOtpSessionStore  (was: redis + key builders)
 *     deps.repo   — IAuthRepository   (was: import * as repo)
 *     deps.audit  — IAuditSink        (was: import { audit } + repo.insertOtpEvent)
 * ==============================================================================
 */
import { randomInt } from 'node:crypto';
import {
  OTP_LENGTH,
  OTP_SESSION_TTL_SECONDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  IDEMPOTENCY_TTL_SECONDS,
} from '../../../config/constants.js';
import { ENV } from '../../../config/env.js';
import { sha256 } from '../../../shared/utils/crypto.js';
import { newId } from '../../../shared/utils/id.js';
import { logger } from '../../../shared/logger/index.js';
import {
  AppError,
  ForbiddenError,
  RateLimitError,
  ConflictError,
  ServiceUnavailableError,
} from '../../../shared/errors/index.js';
import { dispatchOtp } from '../../../shared/providers/msg91/otp.js';
import { normalizeMobile, maskMobile } from '../../../shared/utils/phone.js';
import { AUTH_ERROR } from '../types.js';
import type { OtpSession, RequestOtpResponseDto } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';
import type { AuthServiceDeps } from '../infrastructure/AuthContainer.js';
import { reserveSendQuota, refundSendQuota } from './rate-limits.js';
import { hashOtp } from './otp-hash.js';
import { logDispatchFailure, throwDispatchError } from './dispatch-outcome.js';
import { audit } from './audit.js';
import { assertRoleEnabled } from '../../../shared/rbac/enabled-roles.js';

/* ==============================================================================
 * Public entry
 * ============================================================================== */

export type SendOtpParams = {
  phone: string; // 10-digit, validated upstream
  countryCode: '+91';
  role: UserRole;
  idempotencyKey: string | null;
  ip: string | null;
  /** hCaptcha token — required only inside a post-lockout CAPTCHA window. */
  captchaToken?: string;
};

/** Numbers that bypass MSG91 entirely and receive `MSG91_TEST_OTP`. */
const TEST_MOBILES: ReadonlySet<string> = new Set(
  ENV.MSG91_TEST_MOBILES.split(',')
    .map(s => s.trim())
    .filter(Boolean),
);

export async function sendOtp(
  deps: AuthServiceDeps,
  p: SendOtpParams,
): Promise<RequestOtpResponseDto> {
  // 0. Role gate (fix H2) — before anything else is touched.
  assertRoleEnabled(deps.enabledRoles, p.role);

  const { store, repo } = deps;
  const mobile = normalizeMobile(p.phone, p.countryCode);
  const isTest = TEST_MOBILES.has(mobile);

  // 1. Idempotency snapshot
  if (p.idempotencyKey) {
    const snap = await store.getIdempotencySnapshot(p.idempotencyKey);
    if (snap) {
      const expectedFp = sha256(`${mobile}|${p.role}`);
      if (snap.fp !== expectedFp) {
        logger.warn(
          {
            alarm: 'idempotency_key_mismatch',
            key: p.idempotencyKey,
            role: p.role,
            ip: p.ip,
          },
          'otp send: idempotency key reused with a different (mobile, role)',
        );
        throw new ConflictError(
          'Idempotency key was already used for a different request.',
          'IDEMPOTENCY_KEY_MISMATCH',
        );
      }
      logger.info({ key: p.idempotencyKey }, 'otp send: idempotent replay');
      return snap.response;
    }
  }

  // 2. Mobile registry hard blocks
  const flags = await repo.getMobileFlags(mobile);
  if (flags?.admin_blocked === 1) {
    await audit(deps.audit, {
      mobile,
      role: p.role,
      event: 'send_failed',
      ip: p.ip,
      msg: 'admin_blocked',
    });
    throw new ForbiddenError('This number cannot use the service.', AUTH_ERROR.MOBILE_BLOCKED);
  }
  if (flags?.verify_locked_until && flags.verify_locked_until > new Date()) {
    const retryAfter = Math.ceil((flags.verify_locked_until.getTime() - Date.now()) / 1000);
    await audit(deps.audit, { mobile, role: p.role, event: 'rate_limited', ip: p.ip });
    throw new RateLimitError(
      'This number is locked after too many wrong attempts.',
      AUTH_ERROR.ACCOUNT_LOCKED,
      { retryAfter },
    );
  }

  // 2b. Post-lockout CAPTCHA gate (only when configured; test mobiles exempt).
  if (
    !isTest &&
    deps.captcha.enabled &&
    flags?.captcha_required_until &&
    flags.captcha_required_until > new Date()
  ) {
    await enforceCaptcha(deps, p, mobile);
  }

  // 3. Reserve quota atomically (before the account lookup, so probing is
  //    throttled, and before any SMS, so parallel requests can't race past).
  await reserveSendQuota(store, mobile, p.ip, isTest);

  // 4. Vendor / UC / Driver must be a pre-existing, active account.
  if (p.role !== 'customer') {
    const account = await repo.findUserByPhone(p.role, mobile);
    if (!account || account.status !== 'active') {
      const reason = account ? 'inactive' : 'not_provisioned';
      // Quota was already consumed in step 3 and is deliberately NOT refunded,
      // so this endpoint can't be used as a free lookup oracle.
      await audit(deps.audit, {
        mobile,
        role: p.role,
        event: 'account_not_provisioned',
        ip: p.ip,
        msg: reason,
      });
      logger.info(
        { role: p.role, mobile: maskMobile(mobile), reason },
        'otp send: rejected — no active account for this role',
      );
      if (!account) {
        throw new ForbiddenError(
          `This number is not registered as ${ROLE_LABEL[p.role]} with Urban Cruise. ` +
            'Please contact your Urban Cruise administrator.',
          AUTH_ERROR.ACCOUNT_NOT_PROVISIONED,
          { role: p.role },
        );
      }
      throw new ForbiddenError(
        'This account is not active. Please contact your Urban Cruise administrator.',
        AUTH_ERROR.ACCOUNT_SUSPENDED,
        { role: p.role },
      );
    }
  }

  // 5. Generate OTP + session
  const requestId = newId();
  const otp = isTest ? ENV.MSG91_TEST_OTP : generateOtp();

  const session: OtpSession = {
    requestId,
    mobile,
    otpHash: hashOtp(requestId, otp),
    role: p.role,
    channel: 'sms',
    isTest,
    attempts: 0,
    sentAt: Date.now(),
  };

  await store.setOtpSession(session, OTP_SESSION_TTL_SECONDS);

  // 6. Dispatch
  let providerRequestId: string | null = null;
  let attemptNumber = 1;

  if (isTest) {
    logger.warn({ mobile: maskMobile(mobile) }, 'otp send: TEST MODE (no real SMS)');
  } else {
    const dispatch = await dispatchOtp(mobile, otp);
    providerRequestId = dispatch.providerRequestId ?? null;
    attemptNumber = dispatch.attempts > 0 ? dispatch.attempts : 1;

    if (!dispatch.ok) {
      logDispatchFailure(mobile, p.role, dispatch);
      // Nothing was sent: drop the now-useless OTP session and give the user
      // their quota back so an MSG91 outage doesn't lock them out.
      await Promise.all([store.deleteOtpSession(requestId), refundSendQuota(store, mobile)]);
      await audit(deps.audit, {
        mobile,
        role: p.role,
        event: 'send_failed',
        channel: 'sms',
        attemptNumber,
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(dispatch.errorCode ? { code: dispatch.errorCode } : {}),
        ...(dispatch.errorMessage ? { msg: dispatch.errorMessage } : {}),
        idempotencyKey: p.idempotencyKey,
        ip: p.ip,
      });
      throwDispatchError(dispatch);
    }

    if (attemptNumber > 1) {
      logger.warn(
        {
          alarm: 'msg91_retry_succeeded',
          attemptNumber,
          providerRequestId,
          mobile: maskMobile(mobile),
        },
        'msg91 send succeeded on retry',
      );
    }
  }

  // 7. Audit event
  await audit(deps.audit, {
    mobile,
    role: p.role,
    event: 'send_succeeded',
    channel: isTest ? 'test' : 'sms',
    providerRequestId,
    attemptNumber,
    idempotencyKey: p.idempotencyKey,
    isTest,
    ip: p.ip,
  });

  const response: RequestOtpResponseDto = {
    requestId,
    resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
    channel: 'sms',
    testMode: isTest,
  };

  // 8. Idempotency snapshot
  if (p.idempotencyKey) {
    const fp = sha256(`${mobile}|${p.role}`);
    await store.setIdempotencySnapshot(p.idempotencyKey, { fp, response }, IDEMPOTENCY_TTL_SECONDS);
  }

  // 9. Best-effort mobile registry touch
  // MUST catch: server.ts treats an unhandled rejection as fatal, so an
  // uncaught DB blip here would take the whole worker down.
  repo.touchMobileRegistry(mobile).catch((err: unknown) => {
    logger.warn({ err, mobile: maskMobile(mobile) }, 'otp send: mobile_registry touch failed');
  });

  return response;
}

/* ==============================================================================
 * Local helpers
 * ============================================================================== */

const ROLE_LABEL: Record<Exclude<UserRole, 'customer'>, string> = {
  vendor: 'a vendor',
  driver: 'a driver',
  uc: 'Urban Cruise staff',
};

/**
 * Throws unless the request carries a CAPTCHA token the provider accepts.
 * Runs BEFORE quota is reserved, so a bot without a solved CAPTCHA can
 * neither send an SMS nor burn the real owner's quota.
 */
async function enforceCaptcha(
  deps: AuthServiceDeps,
  p: SendOtpParams,
  mobile: string,
): Promise<void> {
  if (!p.captchaToken) {
    await audit(deps.audit, {
      mobile,
      role: p.role,
      event: 'send_failed',
      ip: p.ip,
      msg: 'captcha_missing',
    });
    throw new AppError({
      statusCode: 400,
      code: AUTH_ERROR.CAPTCHA_REQUIRED,
      message: 'Please complete the verification challenge to continue.',
    });
  }

  const verdict = await deps.captcha.verify(p.captchaToken, p.ip);
  if (verdict.ok) return;

  if (verdict.reason === 'unavailable') {
    // Fail CLOSED: this gate is only demanded from numbers that just tripped
    // the brute-force lock, so refusing for a few minutes is the safe side.
    logger.error(
      { alarm: 'captcha_provider_unavailable', mobile: maskMobile(mobile) },
      'otp send: CAPTCHA provider unreachable — refusing send for a captcha-gated number',
    );
    throw new ServiceUnavailableError(
      'Verification is temporarily unavailable. Please try again shortly.',
      AUTH_ERROR.SERVICE_UNAVAILABLE,
    );
  }

  await audit(deps.audit, {
    mobile,
    role: p.role,
    event: 'send_failed',
    ip: p.ip,
    msg: `captcha_invalid:${verdict.providerCodes.join(',')}`.slice(0, 255),
  });
  throw new AppError({
    statusCode: 400,
    code: AUTH_ERROR.CAPTCHA_REQUIRED,
    message: 'Verification failed. Please complete the challenge again.',
  });
}

function generateOtp(): string {
  const max = Math.pow(10, OTP_LENGTH);
  const min = Math.pow(10, OTP_LENGTH - 1);
  return String(randomInt(min, max));
}
