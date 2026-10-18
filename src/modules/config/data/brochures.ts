/**
 * Static source for GET /config/brochures (vehicle brochure videos).
 *
 * Grouping: vehicle type → seater → tier. A group (groupKey) is one vehicle
 * type at one seater count and maps to one Unlisted YouTube playlist on the
 * Urban Cruise channel. Each tier of a group is one entry. Entry order here
 * is the order the app shows.
 *
 * Groups, tiers, features and specs are copied from the customer app's
 * vehicleTierOptions.ts. specs fields the description does not mention are
 * null; the app shows a dash for them.
 *
 * To add or change a video: upload it as Unlisted, put its id in videoIds,
 * deploy the backend. An entry with no videoIds shows as "Coming soon".
 * Moving this to a database later only changes the loader in service.ts.
 *
 * TODO(ops): fill youtubePlaylistId and videoIds once the playlists exist.
 * TODO(data): confirm every feature and spec value with ops.
 *
 * The catalog is validated when this file loads; a bad edit stops the
 * server at startup (see assertBrochureCatalog in ../schemas.ts).
 */
import { assertBrochureCatalog } from '../schemas.js';
import type { BrochureEntry, BrochureSpecs } from '../types.js';

const ROYAL_TRAVELLER_FEATURES = [
  '2021-23 Model',
  'Modified Vehicle',
  'Good A/C',
  'Recline Seat',
  'Charging Point',
  'BT Music + Speaker',
  'Sofa/Bed',
] as const;

const ROYAL_TRAVELLER_SPECS: BrochureSpecs = {
  modelYear: '2021-23',
  airConditioning: 'Good',
  seatType: 'Recline',
  chargingPoint: 'Yes',
  musicSystem: 'BT music + speaker',
  sofaBed: 'Yes',
  tv: null,
  panoramicWindow: null,
};

export const BROCHURES: readonly BrochureEntry[] = [
  /* ---------------- Force Traveller 12 Seater ---------------- */
  {
    groupKey: 'force-traveller-12',
    vehicleType: 'Force Traveller',
    seater: 12,
    tier: 'royal_vip',
    title: 'Force Traveller 12 Seater — Royal VIP',
    youtubePlaylistId: null,
    videoIds: [],
    features: [
      'A/C',
      '1x1 VIP Maharaja Seat',
      'More Legroom',
      'Custom Designed Vehicle',
      'Charging Points',
      'Personal A/C Vent',
      'BT Touch Music + Good Speakers',
      'HD TV',
    ],
    specs: {
      modelYear: null,
      airConditioning: 'Yes + personal vent',
      seatType: '1x1 VIP Maharaja',
      chargingPoint: 'Yes',
      musicSystem: 'BT touch music + good speakers',
      sofaBed: null,
      tv: 'HD TV',
      panoramicWindow: null,
    },
  },

  /* ---------------- Force Traveller 13 Seater ---------------- */
  {
    groupKey: 'force-traveller-13',
    vehicleType: 'Force Traveller',
    seater: 13,
    tier: 'economy',
    title: 'Force Traveller 13 Seater — Economy',
    youtubePlaylistId: null,
    videoIds: [],
    // TODO(data): the source description ends with just "Basic" (the app's
    // chip shows it as the music system). Confirm the wording with ops.
    features: ['Basic A/C', 'Non-Recline Seat', 'Basic'],
    specs: {
      modelYear: null,
      airConditioning: 'Basic',
      seatType: 'Non-recline',
      chargingPoint: null,
      musicSystem: 'Basic',
      sofaBed: null,
      tv: null,
      panoramicWindow: null,
    },
  },
  {
    groupKey: 'force-traveller-13',
    vehicleType: 'Force Traveller',
    seater: 13,
    tier: 'premium',
    title: 'Force Traveller 13 Seater — Premium',
    youtubePlaylistId: null,
    videoIds: [],
    features: ['2018-20 Model', 'A/C', 'Recline Seat', 'Charging Point', 'Music System + Speaker'],
    specs: {
      modelYear: '2018-20',
      airConditioning: 'Yes',
      seatType: 'Recline',
      chargingPoint: 'Yes',
      musicSystem: 'Music system + speaker',
      sofaBed: null,
      tv: null,
      panoramicWindow: null,
    },
  },
  {
    groupKey: 'force-traveller-13',
    vehicleType: 'Force Traveller',
    seater: 13,
    tier: 'royal',
    title: 'Force Traveller 13 Seater — Royal',
    youtubePlaylistId: null,
    videoIds: [],
    features: [...ROYAL_TRAVELLER_FEATURES],
    specs: { ...ROYAL_TRAVELLER_SPECS },
  },

  /* ---------------- Force Traveller 26 Seater ---------------- */
  {
    groupKey: 'force-traveller-26',
    vehicleType: 'Force Traveller',
    seater: 26,
    tier: 'royal',
    title: 'Force Traveller 26 Seater — Royal',
    youtubePlaylistId: null,
    videoIds: [],
    // TODO(data): the app copies this description from the 13-seat Royal.
    // Confirm the 26-seat facilities with ops.
    features: [...ROYAL_TRAVELLER_FEATURES],
    specs: { ...ROYAL_TRAVELLER_SPECS },
  },

  /* ---------------- Force Urbania 15 Seater ---------------- */
  // The app lists this vehicle twice with identical data (marked TODO(data)
  // there). The catalog is keyed by tier, so it holds one entry.
  {
    groupKey: 'force-urbania-15',
    vehicleType: 'Force Urbania',
    seater: 15,
    tier: 'royal_vip',
    title: 'Force Urbania 15 Seater — Royal VIP',
    youtubePlaylistId: null,
    videoIds: [],
    features: [
      'A/C',
      '2x1 Recline Seat',
      'Comfortable & Silent Cabin',
      'Panoramic Window',
      'Charging Points',
      'Personal A/C Vents',
      'BT Music + Speaker',
    ],
    specs: {
      modelYear: null,
      airConditioning: 'Yes + personal vents',
      seatType: '2x1 Recline',
      chargingPoint: 'Yes',
      musicSystem: 'BT music + speaker',
      sofaBed: null,
      tv: null,
      panoramicWindow: 'Yes',
    },
  },
];

assertBrochureCatalog(BROCHURES);

/** Fresh copies, so callers can never mutate the catalog. */
export function getStaticBrochures(): BrochureEntry[] {
  return BROCHURES.map(e => ({
    ...e,
    videoIds: [...e.videoIds],
    features: [...e.features],
    specs: { ...e.specs },
  }));
}
