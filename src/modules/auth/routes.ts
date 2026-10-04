/**
 * ==============================================================================
 * auth — routes
 * ==============================================================================
 * Public paths (no auth middleware):
 *   POST /auth/otp/request   — send OTP
 *   POST /auth/otp/verify    — verify OTP → mint session
 *   POST /auth/refresh       — rotate tokens
 *   POST /auth/customer/onboard — NEW customer: submit details → account + session
 *                                 (authorised by the single-use onboarding token
 *                                 that /otp/verify returns)
 *
 * Protected paths (behind `authenticate`):
 *   GET  /auth/me            — server-authoritative identity for the session
 *   POST /auth/logout        — revoke current or all sessions
 *
 * NOTE on rate-limit stacking: the global rate limit runs first (in app.ts).
 * The stricter per-endpoint limiter added here layers on top — matches what
 * the failure matrix asks for on the auth surface.
 * ==============================================================================
 */
import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { validate } from '../../shared/http/middleware/validate.js';
import { authenticate } from '../../shared/http/middleware/authenticate.js';
import { ENV } from '../../config/env.js';
import {
  RequestOtpBody,
  VerifyOtpBody,
  RefreshBody,
  LogoutBody,
  CustomerOnboardBody,
} from './schemas.js';
import {
  postRequestOtp,
  postVerifyOtp,
  postCustomerOnboard,
  postRefresh,
  postLogout,
  getMe,
} from './controller.js';

const router = Router();

/**
 * Stricter limiter for the OTP surface — the global one is too permissive
 * for an endpoint that costs money per call.
 */
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: ENV.RATE_LIMIT_AUTH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  // Key by IP + phone-in-body — an attacker who rotates IP but hammers one
  // number still trips the limiter. Redis-backed per-mobile limits inside
  // the service catch phone-only enumeration.
  // NOTE: `ipKeyGenerator(req.ip)` is required by express-rate-limit v7 —
  // it normalises IPv6 to a /64 prefix so IPv6 users can't bypass by
  // rotating the interface identifier.
  keyGenerator: req => {
    const ipKey = ipKeyGenerator(req.ip ?? '');
    const phone = String((req.body as { phone?: string })?.phone ?? '');
    return `${ipKey}:${phone}`;
  },
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please wait and try again.',
    },
  },
});

router.post('/otp/request', otpLimiter, validate({ body: RequestOtpBody }), postRequestOtp);

router.post('/otp/verify', otpLimiter, validate({ body: VerifyOtpBody }), postVerifyOtp);

/** Onboarding: keyed by IP only (no phone in the body). The ticket itself is
 *  single-use, so this limiter only guards against token-guessing floods. */
const onboardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: ENV.RATE_LIMIT_AUTH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => ipKeyGenerator(req.ip ?? ''),
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please wait and try again.',
    },
  },
});

router.post(
  '/customer/onboard',
  onboardLimiter,
  validate({ body: CustomerOnboardBody }),
  postCustomerOnboard,
);

router.post('/refresh', validate({ body: RefreshBody }), postRefresh);

router.get('/me', authenticate, getMe);

router.post('/logout', authenticate, validate({ body: LogoutBody }), postLogout);

export default router;
