/**
 * config service.
 * getAppConfig: adds per-caller update flags and the store URL to the
 * static config, and returns a strong ETag of the response body.
 * With no store link for the platform, no update is required or offered;
 * if a forced update was due, it logs alarm 'force_update_without_store_link'.
 * getBrochures: the vehicle brochure catalog and its strong ETag.
 */
import { createHash } from 'node:crypto';
import { lt as semverLt } from 'semver';

import { logger } from '../../shared/logger/index.js';
import { getStaticAppConfig, STORE_LINKS } from './data/app-config.js';
import { getStaticBrochures } from './data/brochures.js';
import type {
  AppConfigContext,
  AppConfigData,
  BrochureCatalogData,
  BrochureEntry,
} from './types.js';

export type AppConfigResult = {
  data: AppConfigData;
  /** Strong, quoted ETag. */
  etag: string;
};

export async function getAppConfig(ctx: AppConfigContext): Promise<AppConfigResult> {
  const base = getStaticAppConfig();

  const updateUrl = STORE_LINKS[ctx.platform];

  // Equal versions need no update.
  const belowMin = semverLt(ctx.appVersion, base.version.minSupported);
  const belowLatest = semverLt(ctx.appVersion, base.version.latest);

  if (updateUrl === null && belowMin) {
    logger.error(
      {
        alarm: 'force_update_without_store_link',
        platform: ctx.platform,
        appVersion: ctx.appVersion,
        minSupported: base.version.minSupported,
      },
      'forced update suppressed — no store link configured for this platform (set STORE_LINKS in config/data/app-config.ts)',
    );
  }

  const data: AppConfigData = {
    ...base,
    version: {
      ...base.version,
      updateRequired: updateUrl !== null && belowMin,
      updateAvailable: updateUrl !== null && belowLatest,
      updateUrl,
    },
  };

  // Hash of the exact body sent. Stable because we build the object ourselves.
  const etag = `"${createHash('sha1').update(JSON.stringify(data)).digest('hex')}"`;

  return { data, etag };
}

/* ---------- Vehicle brochures ---------- */

export type BrochureCatalogResult = {
  data: BrochureCatalogData;
  /** Strong, quoted ETag. */
  etag: string;
};

/**
 * The only place that knows where brochure entries come from. Moving the
 * catalog to a database changes this function (and drops the cache below)
 * and nothing else.
 */
async function loadBrochureEntries(): Promise<BrochureEntry[]> {
  return getStaticBrochures();
}

// The static catalog cannot change while the process runs, so the body and
// its ETag are built once instead of on every request.
let brochureCache: BrochureCatalogResult | null = null;

export async function getBrochures(): Promise<BrochureCatalogResult> {
  if (brochureCache) return brochureCache;
  const data: BrochureCatalogData = { brochures: await loadBrochureEntries() };
  const etag = `"${createHash('sha1').update(JSON.stringify(data)).digest('hex')}"`;
  brochureCache = { data, etag };
  return brochureCache;
}
