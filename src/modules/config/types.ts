/**
 * config DTOs for GET /config/app. Every client reads this at cold start:
 * add fields freely, but never rename or remove one without a deprecation
 * cycle.
 */

export type Platform = 'ios' | 'android';

export type AppConfigVersion = {
  /** Below this the client must force-update. */
  minSupported: string;
  /** Below this the client shows a soft update banner. */
  latest: string;
  /** Caller is below minSupported. False when updateUrl is null. */
  updateRequired: boolean;
  /** Caller is below latest. False when updateUrl is null. */
  updateAvailable: boolean;
  /** Store page for the caller's platform; null if not published there yet. */
  updateUrl: string | null;
};

export type AppConfigMaintenance = {
  active: boolean;
  /** Shown on the maintenance screen. */
  message: string | null;
  /** Expected end (ISO-8601); the client shows a countdown. */
  estimatedEndAt: string | null;
};

export type AppConfigFeatureFlags = {
  /** Always false; kept for shipped clients. Use testMode from /auth/otp/request. */
  otpTestMode: boolean;
  referralsEnabled: boolean;
  supportChatEnabled: boolean;
};

export type AppConfigSupport = {
  phone: string;
  whatsapp: string;
  email: string;
  helpUrl: string;
};

export type AppConfigLegal = {
  termsUrl: string;
  privacyUrl: string;
  termsVersion: string;
};

/** GET /config/app payload. Some version fields are computed per request. */
export type AppConfigData = {
  version: AppConfigVersion;
  maintenance: AppConfigMaintenance;
  featureFlags: AppConfigFeatureFlags;
  support: AppConfigSupport;
  legal: AppConfigLegal;
  serviceCities: string[];
};

/** Validated caller context passed to the service. */
export type AppConfigContext = {
  platform: Platform;
  appVersion: string;
  buildNumber: number | null;
  locale: string | null;
};
