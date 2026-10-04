/**
 * ==============================================================================
 * auth.service — public surface
 * ==============================================================================
 * Re-exports every service entry point. Each function now accepts
 * AuthServiceDeps as its first argument so the service layer has zero
 * hardwired infrastructure dependencies.
 *
 * The controller imports `authDeps` from the container and threads it
 * through. Tests build their own deps with in-memory fakes via
 * buildAuthDeps({ repo, store, audit }).
 * ==============================================================================
 */
export { sendOtp, type SendOtpParams } from './otp-send.js';
export { verifyOtp, type VerifyOtpParams } from './otp-verify.js';
export { completeCustomerOnboarding, type CompleteOnboardingParams } from './onboarding.js';
export { refreshSession, logout, getMe, type LogoutParams, type GetMeParams } from './session.js';
export { type AuditEventInput } from './audit.js';
