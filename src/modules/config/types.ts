/**
 * ==============================================================================
 * config — types
 * ==============================================================================
 * DTOs for /config/app. Keep these serialisable and boring — this endpoint
 * is called by every client at every cold start, so shape stability matters
 * a lot. Add fields, never rename/remove them; when removing, mark deprecated
 * for a full release cycle first.
 * ==============================================================================
 */

export type Platform = 'ios' | 'android';

export type AppConfigVersion = {
  /** Minimum supported version. Below this, client MUST force-upgrade. */
  minSupported: string;
  /** Latest released version. Above the client's current, show soft banner. */
  latest: string;
  /** Computed per-request: is the caller below `minSupported`? */
  updateRequired: boolean;
  /** Computed per-request: is the caller below `latest`? */
  updateAvailable: boolean;
  /** Platform-specific store URL to open. Null when caller platform is 'web'. */
  updateUrl: string | null;
};

export type AppConfigMaintenance = {
  active: boolean;
  /** Human-readable message shown on the maintenance screen. */
  message: string | null;
  /** ISO-8601 timestamp — when we expect to be back. Client shows countdown. */
  estimatedEndAt: string | null;
};

export type AppConfigFeatureFlags = {
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

/**
 * Full payload returned by GET /config/app.
 * `version` fields are partly computed per-request against `?appVersion=`.
 */
export type AppConfigData = {
  version: AppConfigVersion;
  maintenance: AppConfigMaintenance;
  featureFlags: AppConfigFeatureFlags;
  support: AppConfigSupport;
  legal: AppConfigLegal;
  serviceCities: string[];
};

/**
 * Input to the service — validated caller context. Kept separate from the
 * response so the loader is easy to swap.
 */
export type AppConfigContext = {
  platform: Platform;
  appVersion: string;
  buildNumber: number | null;
  locale: string | null;
};
