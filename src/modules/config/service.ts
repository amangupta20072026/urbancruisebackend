/**
 * config service. Adds per-caller update flags and the store URL to the
 * static config, and returns a strong ETag of the response body.
 * With no store link for the platform, no update is required or offered;
 * if a forced update was due, it logs alarm 'force_update_without_store_link'.
 */
import { createHash } from 'node:crypto';
import { lt as semverLt } from 'semver';

import { logger } from '../../shared/logger/index.js';
import { getStaticAppConfig, STORE_LINKS } from './data/app-config.js';
import type { AppConfigContext, AppConfigData } from './types.js';

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
