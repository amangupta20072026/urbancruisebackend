/**
 * POST /auth/otp/request. The order of checks matters; see the step comments.
 * Customers always get an OTP (new or existing), so this endpoint never
 * reveals whether a customer account exists. Vendor, driver and uc numbers
 * must already have an active account, or no SMS is sent.
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

export type SendOtpParams = {
  phone: string; // 10 digits, validated
  countryCode: '+91';
  role: UserRole;
  idempotencyKey: string | null;
  ip: string | null;
  /** Required only inside a post-lockout CAPTCHA window. */
  captchaToken?: string;
};

/** Numbers that skip MSG91 and accept MSG91_TEST_OTP. */
const TEST_MOBILES: ReadonlySet<string> = new Set(
  ENV.MSG91_TEST_MOBILES.split(',')
    .map(s => s.trim())
    .filter(Boolean),
);

export async function sendOtp(
  deps: AuthServiceDeps,
  p: SendOtpParams,
): Promise<RequestOtpResponseDto> {
  // 0. Role enabled? First, so a disabled role costs nothing.
  assertRoleEnabled(deps.enabledRoles, p.role);

  const { store, repo } = deps;
  const mobile = normalizeMobile(p.phone, p.countryCode);
  const isTest = TEST_MOBILES.has(mobile);

  // 1. Idempotent replay. A key reused for another mobile or role → 409.
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

  // 2. Admin block or brute-force lock.
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

  // 2b. Post-lockout CAPTCHA (when configured; test mobiles exempt).
  if (
    !isTest &&
    deps.captcha.enabled &&
    flags?.captcha_required_until &&
    flags.captcha_required_until > new Date()
  ) {
    await enforceCaptcha(deps, p, mobile);
  }

  // 3. Reserve quota atomically: before the account lookup (throttles
  //    probing) and before any SMS (parallel requests can't race past).
  let reserved: { ipBlock: string | null };
  try {
    reserved = await reserveSendQuota(store, mobile, p.ip, isTest);
  } catch (err) {
    if (err instanceof RateLimitError) {
      // Record refusals so quota-exhaustion attacks show up in otp_events.
      await audit(deps.audit, {
        mobile,
        role: p.role,
        event: 'rate_limited',
        ip: p.ip,
        msg: err.code,
        // No idempotencyKey: the column is UNIQUE, and a refusal row would
        // block the success row of a later retry with the same key.
      });
      if (err.code === 'send_limit_day') {
        logger.warn(
          { alarm: 'otp_daily_cap_reached', mobile: maskMobile(mobile), role: p.role, ip: p.ip },
          'otp send: daily OTP limit reached for this number — new logins blocked until it resets',
        );
      }
    }
    throw err;
  }

  // 4. Vendor, driver and uc accounts must exist and be active.
  if (p.role !== 'customer') {
    const account = await repo.findUserByPhone(p.role, mobile);
    if (!account || account.status !== 'active') {
      const reason = account ? 'inactive' : 'not_provisioned';
      // Quota is not refunded, so number lookups aren't free.
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

  // 5. Generate the OTP and store its HMAC.
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
    ipBlock: reserved.ipBlock,
  };

  await store.setOtpSession(session, OTP_SESSION_TTL_SECONDS);

  // 6. Send (skipped for test mobiles).
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
      // Nothing sent: drop the session and refund the user's quota.
      await Promise.all([
        store.deleteOtpSession(requestId),
        refundSendQuota(store, mobile, reserved.ipBlock),
      ]);
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

  // 7. Audit.
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

  // 8. Save the response for idempotent replay.
  if (p.idempotencyKey) {
    const fp = sha256(`${mobile}|${p.role}`);
    await store.setIdempotencySnapshot(p.idempotencyKey, { fp, response }, IDEMPOTENCY_TTL_SECONDS);
  }

  // 9. Best-effort registry touch. Must catch: an unhandled rejection
  //    shuts the worker down (server.ts).
  repo.touchMobileRegistry(mobile).catch((err: unknown) => {
    logger.warn({ err, mobile: maskMobile(mobile) }, 'otp send: mobile_registry touch failed');
  });

  return response;
}

const ROLE_LABEL: Record<Exclude<UserRole, 'customer'>, string> = {
  vendor: 'a vendor',
  driver: 'a driver',
  uc: 'Urban Cruise staff',
};

/**
 * Throws unless the CAPTCHA token is valid. Runs before quota is reserved,
 * so a bot can't send SMS or burn the owner's quota.
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
    // Fail closed: only numbers that just tripped the lock reach this gate.
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
