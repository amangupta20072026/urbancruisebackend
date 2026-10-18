/**
 * config schemas.
 * AppConfigQuery: GET /config/app query. platform and appVersion are
 * required (400 if missing) so client integration bugs surface instead of
 * getting a generic config.
 * BrochureCatalogSchema: the static brochure catalog, checked at startup.
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

/* ---------- Vehicle brochure catalog (static data, checked at startup) ---------- */

/**
 * YouTube video and playlist ids are used only inside URLs the app builds.
 * YouTube does not publish a fixed format, so this checks a URL-safe
 * character set and a sane length instead of an exact shape.
 */
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Lowercase words joined by single hyphens, e.g. "force-traveller-13". */
const GROUP_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Not empty and no leading or trailing whitespace. */
const NOT_PADDED_RE = /^\S(?:[\s\S]*\S)?$/;

const displayText = (max: number) =>
  z.string().max(max).regex(NOT_PADDED_RE, 'must not be empty or start/end with spaces');

const SpecValue = displayText(80).nullable();

export const BrochureEntrySchema = z.strictObject({
  groupKey: z.string().max(64).regex(GROUP_KEY_RE, 'must look like "force-traveller-13"'),
  vehicleType: displayText(60),
  seater: z.number().int().min(1).max(100),
  tier: z.enum(['economy', 'premium', 'royal', 'royal_vip']),
  title: displayText(120),
  youtubePlaylistId: z.string().regex(YOUTUBE_ID_RE, 'invalid YouTube playlist id').nullable(),
  videoIds: z.array(z.string().regex(YOUTUBE_ID_RE, 'invalid YouTube video id')).max(20),
  features: z.array(displayText(60)).max(30),
  specs: z.strictObject({
    modelYear: SpecValue,
    airConditioning: SpecValue,
    seatType: SpecValue,
    chargingPoint: SpecValue,
    musicSystem: SpecValue,
    sofaBed: SpecValue,
    tv: SpecValue,
    panoramicWindow: SpecValue,
  }),
});

/**
 * The whole catalog. Besides each entry's own shape it checks the rules the
 * app relies on to find the right brochure:
 *   - one entry per (groupKey, tier);
 *   - every entry of a group has the same vehicleType, seater and playlist;
 *   - one groupKey per (vehicleType, seater), so a vehicle maps to one group;
 *   - no repeated video id inside an entry.
 */
export const BrochureCatalogSchema = z
  .array(BrochureEntrySchema)
  .min(1)
  .superRefine((entries, ctx) => {
    const seenTier = new Map<string, number>();
    const groupHead = new Map<string, number>();
    const groupForVehicle = new Map<string, string>();

    entries.forEach((e, i) => {
      const tierKey = `${e.groupKey}|${e.tier}`;
      const firstTier = seenTier.get(tierKey);
      if (firstTier !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'tier'],
          message: `duplicate tier "${e.tier}" in group "${e.groupKey}" (first at index ${firstTier})`,
        });
      } else {
        seenTier.set(tierKey, i);
      }

      const headIndex = groupHead.get(e.groupKey);
      if (headIndex === undefined) {
        groupHead.set(e.groupKey, i);
      } else {
        const head = entries[headIndex]!;
        for (const field of ['vehicleType', 'seater', 'youtubePlaylistId'] as const) {
          if (e[field] !== head[field]) {
            ctx.addIssue({
              code: 'custom',
              path: [i, field],
              message: `group "${e.groupKey}" has ${field} ${JSON.stringify(head[field])} at index ${headIndex} but ${JSON.stringify(e[field])} here`,
            });
          }
        }
      }

      const vehicleKey = `${e.vehicleType}|${e.seater}`;
      const otherGroup = groupForVehicle.get(vehicleKey);
      if (otherGroup === undefined) {
        groupForVehicle.set(vehicleKey, e.groupKey);
      } else if (otherGroup !== e.groupKey) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'groupKey'],
          message: `"${e.vehicleType}" ${e.seater} seater already uses group "${otherGroup}"`,
        });
      }

      const seenVideo = new Set<string>();
      e.videoIds.forEach((id, j) => {
        if (seenVideo.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: [i, 'videoIds', j],
            message: `video id "${id}" is listed twice`,
          });
        }
        seenVideo.add(id);
      });
    });
  });

/**
 * Throws with every problem listed if the catalog is invalid. Called when
 * data/brochures.ts is loaded, so a bad edit stops the server at startup.
 */
export function assertBrochureCatalog(entries: unknown): void {
  const result = BrochureCatalogSchema.safeParse(entries);
  if (result.success) return;
  const issues = result.error.issues
    .map(i => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`[config/brochures] invalid brochure catalog:\n${issues}`);
}
