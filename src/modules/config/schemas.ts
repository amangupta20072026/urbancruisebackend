/**
 * config request schemas. platform and appVersion are required (400 if
 * missing) so client integration bugs surface instead of getting a
 * generic config.
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
  buildNumber: z.coerce.number().int().nonnegative().optional(),
  // BCP-47 shape only, no fixed list.
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
