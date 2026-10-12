/**
 * auth routes, mounted at /api/v1/auth.
 *   POST /otp/request        send OTP                       (public)
 *   POST /otp/verify         verify OTP, start session      (public)
 *   POST /customer/onboard   create new customer + session  (public, onboarding token)
 *   POST /refresh            rotate tokens                  (public)
 *   GET  /me                 current identity               (authenticated)
 *   POST /logout             revoke this or all sessions    (authenticated)
 * Limiters here stack on the global one and are Redis-backed, so they hold
 * across PM2 workers.
 */
import { Router } from 'express';
import { validate } from '../../shared/http/middleware/validate.js';
import { authenticate } from '../../shared/http/middleware/authenticate.js';
import { clientIpKey, createRateLimiter } from '../../shared/http/middleware/rateLimit.js';
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

/** OTP limiter: each send costs money, so stricter than the global limit. */
const otpLimiter = createRateLimiter({
  name: 'auth-otp',
  windowMs: 15 * 60 * 1000,
  limit: ENV.RATE_LIMIT_AUTH_MAX,
  message: 'Too many requests. Please wait and try again.',
  // Keyed by IP (IPv6 grouped by /64) + phone. The service has its own
  // per-mobile limits for attackers that rotate IPs.
  keyGenerator: req => {
    const ipKey = clientIpKey(req);
    // Runs before validate(): cap the raw phone, it becomes part of a Redis key.
    const phone = String((req.body as { phone?: unknown })?.phone ?? '').slice(0, 16);
    return `${ipKey}:${phone}`;
  },
});

router.post('/otp/request', otpLimiter, validate({ body: RequestOtpBody }), postRequestOtp);

router.post('/otp/verify', otpLimiter, validate({ body: VerifyOtpBody }), postVerifyOtp);

/** Onboarding limiter, by IP. Tickets are single-use; this stops token-guessing floods. */
const onboardLimiter = createRateLimiter({
  name: 'auth-onboard',
  windowMs: 15 * 60 * 1000,
  limit: ENV.RATE_LIMIT_AUTH_MAX,
  message: 'Too many requests. Please wait and try again.',
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
