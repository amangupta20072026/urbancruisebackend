/**
 * ==============================================================================
 * auth.service — public surface
 * ==============================================================================
 * The controller still writes:
 *
 *   import * as service from './service/index.js';
 *   await service.sendOtp(...)
 *
 * The one-function-per-file split behind this barrel is an implementation
 * detail. If a caller only needs one entry point (e.g. a background job that
 * only refreshes sessions), it's fine to import directly from the leaf file
 * instead of pulling the whole barrel.
 *
 * Types are re-exported for consumers who want to type their call payloads
 * without a second import path.
 * ==============================================================================
 */
export { sendOtp, type SendOtpParams } from './otp-send.js';
export { verifyOtp, type VerifyOtpParams } from './otp-verify.js';
export { refreshSession, logout, getMe, type LogoutParams, type GetMeParams } from './session.js';
