/**
 * config DTOs for GET /config/app and GET /config/brochures. Shipped clients
 * read these: add fields freely, but never rename or remove one without a
 * deprecation cycle.
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

/* ---------- Vehicle brochures (GET /config/brochures) ---------- */

/** Same keys as the app's vehicleTierOptions.ts. */
export type VehicleTier = 'economy' | 'premium' | 'royal' | 'royal_vip';

/**
 * Comparison facts for the app's Compare screen. null means "not provided";
 * the app shows a dash. Values are short display strings set by ops.
 */
export type BrochureSpecs = {
  modelYear: string | null;
  airConditioning: string | null;
  seatType: string | null;
  chargingPoint: string | null;
  musicSystem: string | null;
  sofaBed: string | null;
  tv: string | null;
  panoramicWindow: string | null;
};

/**
 * One tier inside a vehicle group. A group (groupKey) is one vehicle type at
 * one seater count, e.g. "Force Traveller 13 Seater", and maps to one
 * Unlisted YouTube playlist. Each tier of that group is one entry.
 */
export type BrochureEntry = {
  /** Stable id of the group, shared by all tiers of the group. */
  groupKey: string;
  /** Top grouping level, e.g. "Force Traveller". */
  vehicleType: string;
  /** Second grouping level. */
  seater: number;
  tier: VehicleTier;
  /** Card title, e.g. "Force Traveller 13 Seater — Royal". */
  title: string;
  /** The group's playlist; null until ops creates it. */
  youtubePlaylistId: string | null;
  /** Videos for this tier, in display order. Empty means "Coming soon". */
  videoIds: string[];
  /** Facilities checklist shown under the video. */
  features: string[];
  specs: BrochureSpecs;
};

/** GET /config/brochures payload. Entries keep the catalog's order. */
export type BrochureCatalogData = {
  brochures: BrochureEntry[];
};
