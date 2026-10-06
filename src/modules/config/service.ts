/**
 * ==============================================================================
 * config — service
 * ==============================================================================
 * Orchestrates /config/app:
 *
 *   1. Load the static base config.
 *   2. Compute per-caller version flags:
 *        - `updateRequired` = appVersion < minSupported
 *        - `updateAvailable` = appVersion < latest
 *   3. Fill in the platform-specific store URL.
 *
 * Returns the full DTO plus a strong ETag computed from the JSON body, so
 * the controller can short-circuit unchanged responses with 304.
 *
 * NO STORE PAGE ⇒ NO FORCED UPDATE (fix B4):
 *   When the caller's platform has no store link configured (app not yet
 *   published there — see STORE_LINKS), `updateUrl` is null and
 *   `updateRequired` / `updateAvailable` are forced to false. A forced
 *   update without a store page would lock every user of that platform on a
 *   screen whose only button goes nowhere. If a forced update WOULD have
 *   applied, an error is logged (`alarm: 'force_update_without_store_link'`)
 *   so the missing link gets fixed.
 *
 * DESIGN NOTES:
 *  - Version comparison uses semver.lt. Invalid inputs are already rejected
 *    at the schema layer.
 *  - We compute the ETag from the RESPONSE BODY, not just the static config.
 *    That way an old client asking with a stale appVersion gets its OWN
 *    correct ETag — a newer client won't accidentally reuse it.
 *  - No DB reads. Adding them later is fine — cache the DB result in Redis
 *    with a 60s TTL and swap the loader below.
 * ==============================================================================
 */
import { createHash } from 'node:crypto';
import { lt as semverLt } from 'semver';

import { logger } from '../../shared/logger/index.js';
import { getStaticAppConfig, STORE_LINKS } from './data/app-config.js';
import type { AppConfigContext, AppConfigData } from './types.js';

export type AppConfigResult = {
  data: AppConfigData;
  /** Strong ETag ("<hex>") — quoted per RFC 7232. */
  etag: string;
};

export async function getAppConfig(ctx: AppConfigContext): Promise<AppConfigResult> {
  const base = getStaticAppConfig();

  const updateUrl = STORE_LINKS[ctx.platform];

  // Version flags — inclusive: equal versions are neither required nor available.
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

  // Strong ETag from the exact bytes we're going to send. `JSON.stringify`
  // is stable for our shape because we build it ourselves (no Sets/Maps,
  // no key-order surprises).
  const etag = `"${createHash('sha1').update(JSON.stringify(data)).digest('hex')}"`;

  return { data, etag };
}
