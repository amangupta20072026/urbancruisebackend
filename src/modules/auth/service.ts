/**
 * ==============================================================================
 * auth — service layer
 * ==============================================================================
 * Orchestrates the OTP request/verify/refresh/logout flows. Every function
 * here is pure business logic — no Express types leak in.
 *
 * ORDER-OF-CHECKS matters (send flow):
 *   1. Idempotency snapshot lookup    (cheap, avoids re-sending on retry)
 *   2. Mobile registry hard blocks    (admin, lock, captcha)
 *   3. For non-customer roles: pre-check account exists (avoid burning MSG91
 *      credit on a number that will 403 at verify anyway)
 *   4. Per-mobile rate limits          (Redis counters)
 *   5. Generate OTP, hash, store in Redis session
 *   6. MSG91 dispatch (WhatsApp with SMS fallback)
 *   7. Snapshot response for idempotency
 *   8. Insert otp_events row
 *
 * ORDER-OF-CHECKS matters (verify flow):
 *   1. Mobile locked?
 *   2. Load Redis session by requestId  (or by mobile fallback)
 *   3. Verify OTP hash — safe-equal
 *   4. On success: single-use — DELETE session immediately
 *   5. Resolve user (create-if-customer / require-if-else)
 *   6. Check status
 *   7. Mint session + tokens (transactional)
 *   8. Load profile
 *   9. Insert login_events row
 * ==============================================================================
 */
import { randomInt } from 'node:crypto';
import { redis } from '../../shared/redis/client.js';
import {
  otpSession,
  otpRateMobile10m,
  otpRateMobileDay,
  otpLastSent,
  otpVerifyFail,
  idempotencySnapshot,
  jwtDeny,
  sessionsActive,
} from '../../shared/redis/keys.js';
import {
  OTP_LENGTH,
  OTP_SESSION_TTL_SECONDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_SEND_MAX_PER_10M,
  OTP_SEND_MAX_PER_DAY,
  OTP_SEND_MIN_INTERVAL_SECONDS,
  IDEMPOTENCY_TTL_SECONDS,
  VERIFY_FAIL_WINDOW_SECONDS,
  VERIFY_FAIL_LOCK_THRESHOLD,
  VERIFY_LOCK_DURATION_SECONDS,
} from '../../config/constants.js';
import { ENV } from '../../config/env.js';
import { sha256, safeEqual } from '../../shared/utils/crypto.js';
import { newId } from '../../shared/utils/id.js';
import { logger } from '../../shared/logger/index.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../shared/auth/jwt.js';
import { hashForStorage } from '../../shared/auth/tokens.js';
import {
  AuthError,
  ForbiddenError,
  RateLimitError,
  ConflictError,
  AppError,
} from '../../shared/errors/index.js';
import { dispatchOtp } from '../../shared/providers/msg91/otp.js';
import * as repo from './repository.js';
import { AUTH_ERROR } from './types.js';
import type {
  OtpSession,
  ResolvedUser,
  RequestOtpResponseDto,
  VerifyOtpResponseDto,
  RefreshResponseDto,
  MeResponseDto,
  DeviceMeta,
} from './types.js';
import type { UserRole, SubRole } from '../../shared/rbac/roles.js';

/* ==============================================================================
 * PUBLIC — SEND OTP
 * ============================================================================== */

export type SendOtpParams = {
  phone: string; // 10-digit, validated upstream
  countryCode: '+91';
  role: UserRole;
  idempotencyKey: string | null;
  ip: string | null;
};

export async function sendOtp(p: SendOtpParams): Promise<RequestOtpResponseDto> {
  const mobile = normalizeMobile(p.phone, p.countryCode);
  const isTest = TEST_MOBILES.has(mobile);

  // 1. Idempotency snapshot — replay identical response for 24h
  if (p.idempotencyKey) {
    const snap = await redis.get(idempotencySnapshot(p.idempotencyKey));
    if (snap) {
      logger.info({ key: p.idempotencyKey }, 'otp send: idempotent replay');
      return JSON.parse(snap) as RequestOtpResponseDto;
    }
  }

  // 2. Mobile registry hard blocks
  const flags = await repo.getMobileFlags(mobile);
  if (flags?.admin_blocked === 1) {
    await audit({ mobile, role: p.role, event: 'send_failed', ip: p.ip, msg: 'admin_blocked' });
    throw new ForbiddenError('This number cannot use the service.', AUTH_ERROR.MOBILE_BLOCKED);
  }
  if (flags?.verify_locked_until && flags.verify_locked_until > new Date()) {
    const retry = Math.ceil((flags.verify_locked_until.getTime() - Date.now()) / 1000);
    await audit({ mobile, role: p.role, event: 'rate_limited', ip: p.ip });
    throw new RateLimitErrorWith(
      'This number is locked after too many wrong attempts.',
      AUTH_ERROR.ACCOUNT_LOCKED,
      retry,
    );
  }

  // 3. Non-customer roles must be pre-provisioned. Fail-fast so we don't burn
  //    an OTP credit on a number that will be rejected at verify anyway.
  if (p.role !== 'customer') {
    const exists = await lookupUser(p.role, mobile);
    if (!exists) {
      await audit({
        mobile,
        role: p.role,
        event: 'account_not_provisioned',
        ip: p.ip,
      });
      throw new ForbiddenError(
        `No ${p.role} account exists for this number.`,
        AUTH_ERROR.ACCOUNT_NOT_PROVISIONED,
      );
    }
    if (exists.status === 'suspended' || exists.status === 'deleted') {
      throw new ForbiddenError('This account has been suspended.', AUTH_ERROR.ACCOUNT_SUSPENDED);
    }
  }

  // 4. Per-mobile rate limits
  await enforceSendRateLimits(mobile, p.ip);

  // 5. Generate OTP + Redis session
  const requestId = newId();
  const otp = isTest ? ENV.MSG91_TEST_OTP : generateOtp();
  const otpHash = sha256(otp);

  const session: OtpSession = {
    requestId,
    mobile,
    otpHash,
    role: p.role,
    channel: 'whatsapp', // may be updated to 'sms' after dispatch
    isTest,
    attempts: 0,
    sentAt: Date.now(),
  };

  await redis.set(otpSession(requestId), JSON.stringify(session), 'EX', OTP_SESSION_TTL_SECONDS);

  // 6. Dispatch — test mobiles skip MSG91 entirely
  let channel: 'whatsapp' | 'sms' = 'whatsapp';
  let providerRequestId: string | null = null;

  if (isTest) {
    logger.warn({ mobile: maskMobile(mobile) }, 'otp send: TEST MODE (no real SMS)');
  } else {
    const dispatch = await dispatchOtp(mobile, otp);
    channel = dispatch.channel;
    providerRequestId = dispatch.providerRequestId ?? null;

    if (!dispatch.ok) {
      const failCode = mapDispatchFailure(dispatch.failure);
      await touchMobileOnFailure(mobile, dispatch.failure, dispatch.errorCode);
      await audit({
        mobile,
        role: p.role,
        event: 'send_failed',
        channel,
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(dispatch.errorCode ? { code: dispatch.errorCode } : {}),
        ...(dispatch.errorMessage ? { msg: dispatch.errorMessage } : {}),
        idempotencyKey: p.idempotencyKey,
        ip: p.ip,
      });
      throw new ConflictErrorWith(dispatch.errorMessage ?? 'OTP send failed.', failCode);
    }

    // Update session's channel — verify path reads this back if needed
    session.channel = channel;
    await redis.set(otpSession(requestId), JSON.stringify(session), 'EX', OTP_SESSION_TTL_SECONDS);
  }

  // 7. Insert audit event
  await audit({
    mobile,
    role: p.role,
    event: 'send_succeeded',
    channel: isTest ? 'test' : channel,
    providerRequestId,
    idempotencyKey: p.idempotencyKey,
    isTest,
    ip: p.ip,
  });

  // 8. Update rate-limit counters (only on success)
  await incrementSendCounters(mobile);

  const response: RequestOtpResponseDto = {
    requestId,
    resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
    channel,
    testMode: isTest,
  };

  // 9. Idempotency snapshot
  if (p.idempotencyKey) {
    await redis.set(
      idempotencySnapshot(p.idempotencyKey),
      JSON.stringify(response),
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
    );
  }

  // 10. Best-effort mobile registry touch
  void repo.touchMobileRegistry(mobile);

  return response;
}

/* ==============================================================================
 * PUBLIC — VERIFY OTP
 * ============================================================================== */

export type VerifyOtpParams = {
  phone: string;
  countryCode: '+91';
  role: UserRole;
  otp: string;
  requestId?: string;
  device: DeviceMeta;
  ip: string | null;
  userAgent: string | null;
};

export async function verifyOtp(p: VerifyOtpParams): Promise<VerifyOtpResponseDto> {
  const mobile = normalizeMobile(p.phone, p.countryCode);

  // 1. Mobile locked?
  const flags = await repo.getMobileFlags(mobile);
  if (flags?.verify_locked_until && flags.verify_locked_until > new Date()) {
    const retry = Math.ceil((flags.verify_locked_until.getTime() - Date.now()) / 1000);
    throw new RateLimitErrorWith(
      'This number is locked after too many wrong attempts.',
      AUTH_ERROR.ACCOUNT_LOCKED,
      retry,
    );
  }

  // 2. Load session (by requestId, or fall back to mobile-scan)
  if (!p.requestId) {
    throw new AuthError('Missing OTP session — request a new code.', AUTH_ERROR.OTP_EXPIRED);
  }
  const raw = await redis.get(otpSession(p.requestId));
  if (!raw) {
    throw new AuthError('This OTP has expired.', AUTH_ERROR.OTP_EXPIRED);
  }
  const session = JSON.parse(raw) as OtpSession;
  if (session.mobile !== mobile || session.role !== p.role) {
    // Session was for a different (mobile, role) — treat as invalid
    throw new AuthError('That code doesn\u2019t match.', AUTH_ERROR.OTP_INVALID);
  }

  // 3. Compare
  const otpHash = sha256(p.otp);
  const match = safeEqual(otpHash, session.otpHash);

  if (!match) {
    // Increment counters. Redis fast counter first — actual lock happens in DB
    // once we cross threshold within the DB-tracked window.
    const fails = await redis.incr(otpVerifyFail(mobile));
    if (fails === 1) await redis.expire(otpVerifyFail(mobile), VERIFY_FAIL_WINDOW_SECONDS);
    const dbFails = await repo.incrementVerifyFailure(mobile);
    if (dbFails >= VERIFY_FAIL_LOCK_THRESHOLD) {
      const until = new Date(Date.now() + VERIFY_LOCK_DURATION_SECONDS * 1000);
      const captchaUntil = new Date(Date.now() + 60 * 60 * 1000); // 1h
      await repo.lockMobile(mobile, until, captchaUntil);
      await redis.del(otpVerifyFail(mobile));
    }
    await audit({ mobile, role: p.role, event: 'verify_failed', ip: p.ip });
    throw new AuthError('That code doesn\u2019t match.', AUTH_ERROR.OTP_INVALID);
  }

  // 4. Single-use — delete session before we mint tokens
  await redis.del(otpSession(p.requestId));

  // 5. Resolve user
  let user = await lookupUser(p.role, mobile);
  if (!user) {
    if (p.role === 'customer') {
      // Auto-create shell on first login
      user = await repo.createCustomerShell(mobile);
    } else {
      throw new ForbiddenError(
        `No ${p.role} account exists for this number.`,
        AUTH_ERROR.ACCOUNT_NOT_PROVISIONED,
      );
    }
  }

  // 6. Status check
  if (user.status === 'suspended' || user.status === 'deleted') {
    await audit({ mobile, role: p.role, event: 'verify_succeeded', ip: p.ip });
    await repo.insertLoginEvent({
      role: p.role,
      entityId: user.entityId,
      mobile,
      outcome: 'account_suspended',
      device: p.device,
      ip: p.ip,
      userAgent: p.userAgent,
    });
    throw new ForbiddenError('This account has been suspended.', AUTH_ERROR.ACCOUNT_SUSPENDED);
  }

  // 7. Mint tokens + create session row
  const jti = newId();
  const refresh = signRefreshToken({ sub: user.userId, jti });
  const access = signAccessToken({
    sub: user.userId,
    role: user.role,
    subRole: user.subRole,
    entityId: user.entityId,
    sid: jti,
  });
  const refreshHash = hashForStorage(refresh);
  const expiresAt = expiryFromTtl(ENV.JWT_REFRESH_TTL);

  await repo.createSession({
    jti,
    role: user.role,
    entityId: user.entityId,
    subRole: user.subRole,
    refreshTokenHash: refreshHash,
    previousJti: null,
    device: p.device,
    ip: p.ip,
    userAgent: p.userAgent,
    expiresAt,
  });
  await redis.sadd(sessionsActive(user.role, user.entityId), jti);

  // 8. Load profile
  const profile = await repo.loadProfile(user.role, user.entityId);

  // 9. Audit + reset fail counters
  await Promise.all([
    audit({ mobile, role: p.role, event: 'verify_succeeded', ip: p.ip }),
    repo.resetVerifyFailure(mobile),
    redis.del(otpVerifyFail(mobile)),
    repo.insertLoginEvent({
      role: user.role,
      entityId: user.entityId,
      mobile,
      outcome: 'success',
      device: p.device,
      ip: p.ip,
      userAgent: p.userAgent,
    }),
  ]);

  return {
    accessToken: access,
    refreshToken: refresh,
    userId: user.userId,
    role: user.role,
    subRole: user.subRole,
    entityId: user.entityId,
    requiresProfileSetup: user.requiresProfileSetup,
    profile,
  };
}

/* ==============================================================================
 * PUBLIC — REFRESH
 * ============================================================================== */

export async function refreshSession(
  refreshTokenStr: string,
  device: DeviceMeta,
  ip: string | null,
  userAgent: string | null,
): Promise<RefreshResponseDto> {
  const claims = verifyRefreshToken(refreshTokenStr); // throws AuthError on bad token

  const row = await repo.findSessionByJti(claims.jti);
  if (!row) {
    throw new AuthError('Session not found.', AUTH_ERROR.SESSION_REVOKED);
  }

  // Reuse detection — a revoked jti being presented means the entire chain
  // is compromised. Nuclear response: revoke every session for this entity.
  if (row.revoked_at !== null) {
    const revokedJtis = await repo.revokeAllForEntity(row.role, row.entity_id, 'reuse_detected');
    // Add each revoked sid to deny-list (best-effort — access tokens expire soon)
    await Promise.all(
      revokedJtis.map(sid => redis.set(jwtDeny(sid), '1', 'EX', ttlToSeconds(ENV.JWT_ACCESS_TTL))),
    );
    logger.warn(
      { role: row.role, entityId: row.entity_id, jti: row.jti },
      'refresh token reuse detected — all sessions revoked',
    );
    throw new AuthError('Session has been revoked.', AUTH_ERROR.SESSION_REVOKED);
  }

  // Verify hash matches
  if (!safeEqual(hashForStorage(refreshTokenStr), row.refresh_token_hash)) {
    throw new AuthError('Refresh token invalid.', AUTH_ERROR.REFRESH_INVALID);
  }

  // Rotate: new jti + tokens
  const newJti = newId();
  const newRefresh = signRefreshToken({ sub: claims.sub as string, jti: newJti });
  const newAccess = signAccessToken({
    sub: claims.sub as string,
    role: row.role,
    subRole: (row.sub_role ?? null) as ResolvedUser['subRole'],
    entityId: row.entity_id,
    sid: newJti,
  });
  const newHash = hashForStorage(newRefresh);
  const expiresAt = expiryFromTtl(ENV.JWT_REFRESH_TTL);

  await repo.rotateSession(claims.jti, {
    jti: newJti,
    role: row.role,
    entityId: row.entity_id,
    subRole: (row.sub_role ?? null) as ResolvedUser['subRole'],
    refreshTokenHash: newHash,
    previousJti: claims.jti,
    device,
    ip,
    userAgent,
    expiresAt,
  });

  await Promise.all([
    redis.srem(sessionsActive(row.role, row.entity_id), claims.jti),
    redis.sadd(sessionsActive(row.role, row.entity_id), newJti),
    // Deny the OLD access sid until it naturally expires
    redis.set(jwtDeny(claims.jti), '1', 'EX', ttlToSeconds(ENV.JWT_ACCESS_TTL)),
  ]);

  return { accessToken: newAccess, refreshToken: newRefresh };
}

/* ==============================================================================
 * PUBLIC — LOGOUT
 * ============================================================================== */

export type LogoutParams = {
  identityRole: UserRole;
  identityEntityId: string;
  identitySessionId: string;
  scope: 'current' | 'all';
};

export async function logout(p: LogoutParams): Promise<void> {
  if (p.scope === 'all') {
    const revoked = await repo.revokeAllForEntity(
      p.identityRole,
      p.identityEntityId,
      'all_devices',
    );
    await Promise.all([
      ...revoked.map(sid => redis.set(jwtDeny(sid), '1', 'EX', ttlToSeconds(ENV.JWT_ACCESS_TTL))),
      redis.del(sessionsActive(p.identityRole, p.identityEntityId)),
    ]);
    return;
  }

  await repo.markSessionRevoked(p.identitySessionId, 'logout');
  await Promise.all([
    redis.srem(sessionsActive(p.identityRole, p.identityEntityId), p.identitySessionId),
    redis.set(jwtDeny(p.identitySessionId), '1', 'EX', ttlToSeconds(ENV.JWT_ACCESS_TTL)),
  ]);
}

/* ==============================================================================
 * PUBLIC — GET IDENTITY (/auth/me)
 * ============================================================================== */

export type GetMeParams = {
  identityUserId: string;
  identityRole: UserRole;
  identitySubRole: SubRole;
  identityEntityId: string;
  identitySessionId: string;
};

/**
 * Server-authoritative identity for the currently attached session.
 *
 * Fires on every mobile cold-start (bootstrap step). Kept intentionally
 * cheap — one indexed lookup by primary key. No writes on the happy path.
 *
 * Orphan handling: if the entity row is gone (admin deletion, GDPR erase,
 * merged customer) we deny-list the sid so the token is dead on this and
 * every other instance, then throw AuthError so the client re-auths. The
 * JWT alone is still cryptographically valid — the deny-list is what
 * closes that gap in real time.
 */
export async function getMe(p: GetMeParams): Promise<MeResponseDto> {
  const details = await repo.loadIdentityDetails(p.identityRole, p.identityEntityId);

  if (!details) {
    // Session is valid but its owning row vanished. Revoke and reject.
    // Reason 'admin' is used because 'orphan' isn't in the auth_sessions
    // revoked_reason enum; audit intent is the same — a server-side
    // forced revoke, not a user action.
    await Promise.all([
      repo.markSessionRevoked(p.identitySessionId, 'admin').catch(() => {
        // best-effort — the deny-list is what actually protects the API
      }),
      redis.set(jwtDeny(p.identitySessionId), '1', 'EX', ttlToSeconds(ENV.JWT_ACCESS_TTL)),
      redis.srem(sessionsActive(p.identityRole, p.identityEntityId), p.identitySessionId),
    ]);
    throw new AuthError('Your account is no longer available.', AUTH_ERROR.SESSION_ORPHANED);
  }

  return {
    userId: p.identityUserId,
    role: p.identityRole,
    subRole: p.identitySubRole,
    entityId: p.identityEntityId,
    requiresProfileSetup: details.requiresProfileSetup,
    profile: details.profile,
  };
}

/* ==============================================================================
 * INTERNALS
 * ============================================================================== */

const TEST_MOBILES: ReadonlySet<string> = new Set(
  ENV.MSG91_TEST_MOBILES.split(',')
    .map(s => s.trim())
    .filter(Boolean),
);

function normalizeMobile(phone: string, countryCode: string): string {
  // '9812345678' + '+91' -> '919812345678'
  return `${countryCode.replace('+', '')}${phone}`;
}

function generateOtp(): string {
  // crypto.randomInt is cryptographically secure. Pad to OTP_LENGTH.
  const max = Math.pow(10, OTP_LENGTH);
  const min = Math.pow(10, OTP_LENGTH - 1);
  return String(randomInt(min, max));
}

function maskMobile(mobile: string): string {
  return mobile.length < 8 ? '****' : `${mobile.slice(0, 4)}****${mobile.slice(-2)}`;
}

async function lookupUser(role: UserRole, mobile: string): Promise<ResolvedUser | null> {
  switch (role) {
    case 'customer':
      return repo.findCustomerByPhone(mobile);
    case 'vendor':
      return repo.findVendorByPhone(mobile);
    case 'driver':
      return repo.findDriverByPhone(mobile);
    case 'uc':
      return repo.findUcStaffByPhone(mobile);
  }
}

async function enforceSendRateLimits(mobile: string, _ip: string | null): Promise<void> {
  // Cooldown between sends
  const last = await redis.get(otpLastSent(mobile));
  if (last) {
    const elapsed = (Date.now() - Number(last)) / 1000;
    if (elapsed < OTP_SEND_MIN_INTERVAL_SECONDS) {
      const retry = Math.ceil(OTP_SEND_MIN_INTERVAL_SECONDS - elapsed);
      throw new RateLimitErrorWith(
        'Please wait before requesting another code.',
        'send_cooldown',
        retry,
      );
    }
  }

  // 10-minute window
  const c10 = await redis.get(otpRateMobile10m(mobile));
  if (c10 && Number(c10) >= OTP_SEND_MAX_PER_10M) {
    throw new RateLimitErrorWith(
      'Too many requests for this number. Wait a few minutes.',
      'send_limit_10m',
      600,
    );
  }

  // Daily
  const cd = await redis.get(otpRateMobileDay(mobile));
  if (cd && Number(cd) >= OTP_SEND_MAX_PER_DAY) {
    throw new RateLimitErrorWith(
      'Daily OTP limit reached for this number.',
      'send_limit_day',
      86_400,
    );
  }
}

async function incrementSendCounters(mobile: string): Promise<void> {
  const now = String(Date.now());
  await Promise.all([
    redis.set(otpLastSent(mobile), now, 'EX', OTP_SEND_MIN_INTERVAL_SECONDS + 5),
    (async () => {
      const k = otpRateMobile10m(mobile);
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, 600);
    })(),
    (async () => {
      const k = otpRateMobileDay(mobile);
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, 86_400);
    })(),
  ]);
}

async function touchMobileOnFailure(
  mobile: string,
  outcome: string | undefined,
  code: string | undefined,
): Promise<void> {
  if (outcome === 'phone_not_wa') {
    // WhatsApp not deliverable → future sends skip WA
    await repo.markWhatsappUndeliverable(mobile, code ?? '131026');
  }
  if (outcome === 'user_blocked') {
    await repo.markWhatsappUndeliverable(mobile, code ?? 'user_blocked');
  }
}

function mapDispatchFailure(f: string | undefined): string {
  switch (f) {
    case 'wallet_low':
      return AUTH_ERROR.SIGNUPS_DISABLED;
    case 'rate_limited':
      return 'provider_rate_limited';
    case 'waba_suspended':
    case 'template_bad':
      return AUTH_ERROR.OTP_SEND_FAILED;
    default:
      return AUTH_ERROR.OTP_SEND_FAILED;
  }
}

/**
 * Best-effort audit — never throws (audit failure must not block auth).
 */
async function audit(a: {
  mobile: string;
  role: UserRole;
  event:
    | 'send_requested'
    | 'send_succeeded'
    | 'send_failed'
    | 'verify_succeeded'
    | 'verify_failed'
    | 'rate_limited'
    | 'account_not_provisioned';
  channel?: 'whatsapp' | 'sms' | 'voice' | 'test';
  providerRequestId?: string | null;
  code?: string;
  msg?: string;
  idempotencyKey?: string | null;
  isTest?: boolean;
  ip?: string | null;
}): Promise<void> {
  try {
    await repo.insertOtpEvent({
      mobile: a.mobile,
      roleRequested: a.role,
      purpose: 'login',
      eventType: a.event,
      channel: a.channel ?? 'whatsapp',
      provider: 'msg91',
      msg91RequestId: a.providerRequestId ?? null,
      msg91ErrorCode: a.code ?? null,
      msg91ErrorMessage: a.msg ?? null,
      idempotencyKey: a.idempotencyKey ?? null,
      ip: a.ip ?? null,
      isTest: a.isTest ?? false,
    });
  } catch (err) {
    logger.error({ err }, 'otp_events insert failed (non-blocking)');
  }
}

function expiryFromTtl(ttl: string): Date {
  return new Date(Date.now() + ttlToSeconds(ttl) * 1000);
}

/**
 * '15m' | '1h' | '30d' | '30s' | '500ms' -> seconds
 */
function ttlToSeconds(ttl: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(ttl);
  if (!m) throw new AppError({ code: 'BAD_TTL', message: `invalid TTL: ${ttl}`, statusCode: 500 });
  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms':
      return Math.ceil(n / 1000);
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86_400;
    default:
      return n;
  }
}

/* Tiny wrappers so we can attach retryAfter without a new subclass. */
class RateLimitErrorWith extends RateLimitError {
  constructor(
    message: string,
    code: string,
    public readonly retryAfter: number,
  ) {
    super(message, code, { retryAfter });
  }
}
class ConflictErrorWith extends ConflictError {
  constructor(message: string, code: string) {
    super(message, code);
  }
}
