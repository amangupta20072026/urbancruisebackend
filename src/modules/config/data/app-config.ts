/**
 * ==============================================================================
 * config — static app-config source
 * ==============================================================================
 * The single source of truth for /config/app right now. When we later move
 * this to a DB table + admin UI, only the loader (config/service.ts) needs
 * to change — the shape stays.
 *
 * Placeholders are marked `TODO(config)`; every one of them is safe to ship
 * (the client falls back gracefully) but wants a real value before launch.
 *
 * Editing note: bumping any value here changes what every logged-in AND
 * logged-out client sees at their next cold start (subject to CDN/edge
 * caching — see service.ts for the Cache-Control policy).
 *
 * BOOT CHECK (fix B4): the version policy below is validated when this
 * module loads — both values must be valid semver and `min` <= `latest`.
 * A bad edit stops the app at startup instead of shipping a broken policy.
 * ==============================================================================
 */
import { valid as semverValid, lte as semverLte } from 'semver';
import type { AppConfigData } from '../types.js';

/**
 * Store pages the client opens for "Update now".
 *
 * `null` = the app is NOT published on that store yet. The service then
 * sends `updateUrl: null` and never forces an update on that platform —
 * forcing one with no store page would trap users on a screen whose only
 * button leads nowhere (fix B4: the old iOS link used the placeholder id
 * `id0000000000`, which opens an App Store error page).
 *
 * TODO(config): set `ios` to the real link once the app is live, e.g.
 *   'https://apps.apple.com/app/id1234567890'
 * The numeric id is shown in App Store Connect → App Information → Apple ID.
 */
export const STORE_LINKS: Readonly<Record<'android' | 'ios', string | null>> = {
  android: 'https://play.google.com/store/apps/details?id=app.urbancruise', // TODO(config): confirm package id matches the published Play listing
  ios: null, // TODO(config): real App Store link — app not published yet
};

/**
 * Version policy. `min` gates the "you MUST update" force-upgrade
 * screen; `latest` gates the softer "an update is available" banner.
 *
 * KEEP `min` <= `latest`. Semver-valid strings only — checked at boot below.
 */
export const VERSION_POLICY = {
  min: '1.0.0', // TODO(config): raise when a critical fix lands
  latest: '1.0.0', // TODO(config): bump on every release
} as const;

/**
 * Feature flags exposed to the client. Any flag added here MUST have a
 * safe default on the client side too — this endpoint 404s or returns
 * stale data during outages, so the client can never assume flags loaded.
 */
export const FEATURE_FLAGS = {
  /**
   * Global OTP test mode — FALSE (fix B4).
   *
   * Real SMS is sent through MSG91 for every number. Test mode exists only
   * per number (MSG91_TEST_MOBILES, e.g. a store-review account), and the
   * server already reports it for each request in the `testMode` field of
   * POST /auth/otp/request. Clients must rely on that field, not on this
   * flag. Kept in the payload (always false) so shipped apps that read it
   * keep parsing the response.
   */
  otpTestMode: false,
  /** Customer referral programme. */
  referralsEnabled: false,
  /** In-app support chat surface. */
  supportChatEnabled: false,
} as const;

/**
 * Contact + legal endpoints. Client uses these for the "Get help" and
 * "Terms/Privacy" links. `termsVersion` is dated (ISO-8601) so the
 * client can prompt users to re-accept when it changes.
 */
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

/**
 * Cities we serve. Client shows/hides the "book a ride" CTA against
 * this list. Empty array => "no cities live yet" — client should show
 * a coming-soon state.
 */
export const SERVICE_CITIES: readonly string[] = ['Delhi', 'Mumbai', 'Bengaluru']; // TODO(config): confirm the live service cities

/* --------------------------------------------------------------------------
 * Boot check — version policy (fix B4)
 * -------------------------------------------------------------------------- */
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

/**
 * Assembles the raw static config. The service adds computed fields
 * (updateRequired / updateAvailable / updateUrl) per-request based on the
 * caller's appVersion and platform, so this stays pure data.
 */
export function getStaticAppConfig(): AppConfigData {
  return {
    version: {
      minSupported: VERSION_POLICY.min,
      latest: VERSION_POLICY.latest,
      // updateRequired/updateAvailable/updateUrl are per-request — filled in service.
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
