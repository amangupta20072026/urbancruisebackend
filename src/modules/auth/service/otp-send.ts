/**
 * ==============================================================================
 * auth.service — sendOtp
 * ==============================================================================
 * Orchestrates POST /auth/otp/request.
 *
 * ORDER OF CHECKS (matters — keep this order):
 *   1. Idempotency snapshot lookup    — cheap; fingerprinted by
 *                                       sha256(mobile|role) so a reused key
 *                                       with a different payload returns 409
 *                                       rather than replaying someone else's
 *                                       response.
 *   2. Mobile registry hard blocks    — admin block, lock, captcha.
 *   3. Rate limits                     — per-mobile + SMS-pumping caps
 *                                       (IP block, number prefix). Checked
 *                                       BEFORE the account lookup so the
 *                                       lookup itself is throttled.
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
 *   6. MSG91 dispatch — skipped for test mobiles.
 *   7. Insert otp_events row (via audit sink).
 *   8. Bump send counters.
 *   9. Snapshot response for idempotency.
 *  10. Best-effort mobile_registry touch.
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
import { ForbiddenError, RateLimitError, ConflictError } from '../../../shared/errors/index.js';
import { dispatchOtp } from '../../../shared/providers/msg91/otp.js';
import { normalizeMobile, maskMobile } from '../../../shared/utils/phone.js';
import { AUTH_ERROR } from '../types.js';
import type { OtpSession, RequestOtpResponseDto } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';
import type { AuthServiceDeps } from '../infrastructure/AuthContainer.js';
import { enforceSendRateLimits, incrementSendCounters } from './rate-limits.js';
import { hashOtp } from './otp-hash.js';
import { logDispatchFailure, throwDispatchError } from './dispatch-outcome.js';
import { audit } from './audit.js';

/* ==============================================================================
 * Public entry
 * ============================================================================== */

export type SendOtpParams = {
  phone: string; // 10-digit, validated upstream
  countryCode: '+91';
  role: UserRole;
  idempotencyKey: string | null;
  ip: string | null;
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

  // 3. Rate limits (before the account lookup, so probing is throttled)
  await enforceSendRateLimits(store, mobile, p.ip, isTest);

  // 4. Vendor / UC / Driver must be a pre-existing, active account.
  if (p.role !== 'customer') {
    const account = await repo.findUserByPhone(p.role, mobile);
    if (!account || account.status !== 'active') {
      const reason = account ? 'inactive' : 'not_provisioned';
      // Burn quota so this endpoint can't be used as a free lookup oracle.
      await incrementSendCounters(store, mobile, p.ip, isTest);
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

  // 8. Rate-limit counter bump
  await incrementSendCounters(store, mobile, p.ip, isTest);

  const response: RequestOtpResponseDto = {
    requestId,
    resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
    channel: 'sms',
    testMode: isTest,
  };

  // 9. Idempotency snapshot
  if (p.idempotencyKey) {
    const fp = sha256(`${mobile}|${p.role}`);
    await store.setIdempotencySnapshot(p.idempotencyKey, { fp, response }, IDEMPOTENCY_TTL_SECONDS);
  }

  // 10. Best-effort mobile registry touch
  void repo.touchMobileRegistry(mobile);

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

function generateOtp(): string {
  const max = Math.pow(10, OTP_LENGTH);
  const min = Math.pow(10, OTP_LENGTH - 1);
  return String(randomInt(min, max));
}
