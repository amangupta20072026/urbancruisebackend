/**
 * Static source for /config/app. Moving it to a DB later only changes the
 * loader in service.ts. Changes reach every client on its next cold start.
 * TODO(config) marks placeholder values to confirm before launch.
 * The version policy is validated at startup; a bad edit stops the app.
 */
import { valid as semverValid, lte as semverLte } from 'semver';
import type { AppConfigData } from '../types.js';

/**
 * Store pages for "Update now". null means not published on that store, so
 * no update is ever forced there (users would be stuck with nowhere to go).
 * TODO(config): set ios once live, e.g. 'https://apps.apple.com/app/id<Apple ID>'
 * (Apple ID is in App Store Connect → App Information).
 */
export const STORE_LINKS: Readonly<Record<'android' | 'ios', string | null>> = {
  android: 'https://play.google.com/store/apps/details?id=app.urbancruise', // TODO(config): confirm package id matches the published Play listing
  ios: null, // TODO(config): real App Store link — app not published yet
};

/** Force update below `min`, soft banner below `latest`. Semver, min <= latest. */
export const VERSION_POLICY = {
  min: '1.0.0', // TODO(config): raise when a critical fix lands
  latest: '1.0.0', // TODO(config): bump on every release
} as const;

/** Feature flags. Each needs a safe default in the app, since this endpoint can fail. */
export const FEATURE_FLAGS = {
  /**
   * Always false; kept so shipped apps still parse. Test mode is per number
   * (MSG91_TEST_MOBILES) and reported as testMode by /auth/otp/request.
   */
  otpTestMode: false,
  /** Customer referral programme. */
  referralsEnabled: false,
  /** In-app support chat. */
  supportChatEnabled: false,
} as const;

/** Help and legal links. termsVersion is a date; changing it prompts users to re-accept. */
export const SUPPORT = {
  phone: '+919355992138', // TODO(config): confirm this is the customer-support number
  whatsapp: '+919355992138', // TODO(config): confirm this is the WhatsApp support number
  email: 'support@urbancruise.in', // TODO(config): confirm the mailbox exists and is monitored
  helpUrl: 'https://urbancruise.in/help', // TODO(config): confirm the page exists
} as const;

export const LEGAL = {
  termsUrl: 'https://urbancruise.in/terms-conditions-2/', // TODO(config): confirm URL
  privacyUrl: 'https://urbancruise.in/privacy/', // TODO(config): confirm URL
  termsVersion: '2025-01-01', // TODO(config): set to the date the current terms took effect
} as const;

/** Live service cities. Empty means the client shows a coming-soon state. */
export const SERVICE_CITIES: readonly string[] = ['Delhi', 'Mumbai', 'Bengaluru']; // TODO(config): confirm the live service cities

/** Startup check: both versions valid semver and min <= latest. */
function assertVersionPolicy(): void {
  const { min, latest } = VERSION_POLICY;
  if (semverValid(min) === null) {
    throw new Error(`[config/app-config] VERSION_POLICY.min "${min}" is not valid semver.`);
  }
  if (semverValid(latest) === null) {
    throw new Error(`[config/app-config] VERSION_POLICY.latest "${latest}" is not valid semver.`);
  }
  if (!semverLte(min, latest)) {
    throw new Error(
      `[config/app-config] VERSION_POLICY.min "${min}" must be <= VERSION_POLICY.latest "${latest}".`,
    );
  }
}
assertVersionPolicy();

/** Static config. The service fills in the per-request update fields. */
export function getStaticAppConfig(): AppConfigData {
  return {
    version: {
      minSupported: VERSION_POLICY.min,
      latest: VERSION_POLICY.latest,
      updateRequired: false,
      updateAvailable: false,
      updateUrl: null,
    },
    maintenance: {
      active: false,
      message: null,
      estimatedEndAt: null,
    },
    featureFlags: { ...FEATURE_FLAGS },
    support: { ...SUPPORT },
    legal: { ...LEGAL },
    serviceCities: [...SERVICE_CITIES],
  };
}
