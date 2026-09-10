/**
 * ==============================================================================
 * config — request schemas
 * ==============================================================================
 * Validates the caller context. Fields are `platform` (required so we can
 * pick the right store URL), `appVersion` (required so we can compute
 * update flags), and two optional hints (`buildNumber`, `locale`) that
 * future policies can key on without an API break.
 *
 * `platform` and `appVersion` are REQUIRED. Callers that omit them get a
 * 400 with a clear message — this is deliberate: silently returning a
 * generic config would mask client integration bugs.
 * ==============================================================================
 */
import { z } from 'zod';
import { valid as semverValid } from 'semver';

export const AppConfigQuery = z.object({
  platform: z.enum(['ios', 'android']),
  appVersion: z
    .string()
    .min(1)
    .refine(v => semverValid(v) !== null, {
      message: 'appVersion must be a valid semver string (e.g. 1.2.3)',
    }),
  // Query strings are always strings — coerce buildNumber if present.
  buildNumber: z.coerce.number().int().nonnegative().optional(),
  // BCP-47 style; we don't enforce a specific list, just a shape.
  locale: z
    .string()
    .min(2)
    .max(35)
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, {
      message: 'locale must be a BCP-47 tag like "en" or "en-IN"',
    })
    .optional(),
});

export type AppConfigQuery = z.infer<typeof AppConfigQuery>;
