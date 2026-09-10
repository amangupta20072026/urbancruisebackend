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

import { getStaticAppConfig, STORE_LINKS } from './data/app-config.js';
import type { AppConfigContext, AppConfigData } from './types.js';

export type AppConfigResult = {
  data: AppConfigData;
  /** Strong ETag ("<hex>") — quoted per RFC 7232. */
  etag: string;
};

export async function getAppConfig(ctx: AppConfigContext): Promise<AppConfigResult> {
  const base = getStaticAppConfig();

  // Version flags — inclusive: equal versions are neither required nor available.
  const updateRequired = semverLt(ctx.appVersion, base.version.minSupported);
  const updateAvailable = semverLt(ctx.appVersion, base.version.latest);

  const updateUrl =
    ctx.platform === 'android'
      ? STORE_LINKS.android
      : ctx.platform === 'ios'
        ? STORE_LINKS.ios
        : null;

  const data: AppConfigData = {
    ...base,
    version: {
      ...base.version,
      updateRequired,
      updateAvailable,
      updateUrl,
    },
  };

  // Strong ETag from the exact bytes we're going to send. `JSON.stringify`
  // is stable for our shape because we build it ourselves (no Sets/Maps,
  // no key-order surprises).
  const etag = `"${createHash('sha1').update(JSON.stringify(data)).digest('hex')}"`;

  return { data, etag };
}
