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
 * ==============================================================================
 */
import type { AppConfigData } from '../types.js';

/**
 * Play Store / App Store deep-link templates. Client interpolates
 * `{package}` for Android and `{appId}` for iOS at render time.
 * TODO(config): put real bundle ids + store links here before Play/App
 * store submission.
 */
export const STORE_LINKS = {
  android: 'https://play.google.com/store/apps/details?id=in.urbancruise.app', // TODO(config)
  ios: 'https://apps.apple.com/app/urbancruise/id0000000000', // TODO(config): replace 0000000000 with real App Store id
} as const;

/**
 * Version policy. `min` gates the "you MUST update" force-upgrade
 * screen; `latest` gates the softer "an update is available" banner.
 *
 * KEEP `min` <= `latest`. Semver-valid strings only — the service
 * validates on boot in dev.
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
  /** OTPs served in test mode (accept fixed code). Wire this to ENV later. */
  otpTestMode: true, // TODO(config): flip false once MSG91+DLT are live
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
  phone: '+919355992138', // TODO(config)
  whatsapp: '+919355992138', // TODO(config)
  email: 'support@urbancruise.in', // TODO(config)
  helpUrl: 'https://urbancruise.in/help', // TODO(config)
} as const;

export const LEGAL = {
  termsUrl: 'https://urbancruise.in/terms-conditions-2/', // TODO(config)
  privacyUrl: 'https://urbancruise.in/privacy/', // TODO(config)
  termsVersion: '2025-01-01', // TODO(config): bump ISO-date when terms change
} as const;

/**
 * Cities we serve. Client shows/hides the "book a ride" CTA against
 * this list. Empty array => "no cities live yet" — client should show
 * a coming-soon state.
 */
export const SERVICE_CITIES: readonly string[] = ['Delhi', 'Mumbai', 'Bengaluru']; // TODO(config)

/**
 * Assembles the raw static config. The service adds computed fields
 * (updateRequired / updateAvailable) per-request based on the caller's
 * appVersion, so this stays pure data.
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
