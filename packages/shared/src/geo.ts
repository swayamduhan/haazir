import { GeoPoint } from './types';

/**
 * Distance on the ground, computed without a single transcendental function.
 *
 * ECMAScript specifies Math.sin, cos, tan, atan2, log, exp and pow as
 * *implementation-approximated*: any approximation conforms and correct
 * rounding is not required. Two endorsing peers on different Node builds may
 * therefore return results differing in the last ulp. Usually invisible — but
 * at a geofence boundary it flips accept to reject, endorsement fails, and no
 * peer is wrong. Haversine is not usable here. See ADR-018.
 *
 * Math.sqrt is the exception: IEEE-754 requires it to be correctly rounded,
 * so it is deterministic. It is used only for the human-readable distance,
 * never on the path that decides acceptance.
 *
 * Accuracy: an equirectangular approximation with a cosine correction, good
 * to well under a metre across the few hundred metres a classroom geofence
 * spans. It degrades over long distances and near the poles. Neither applies
 * to a lecture hall; both are real limits of this function.
 */

/** Millimetres per 1e-7 degree of latitude, times 1000 to stay integral. */
const MM_PER_MICRODEGREE_X1000 = 11_132;

const MICRODEGREES_PER_DEGREE = 10_000_000;

const COS_SCALE = 1_000_000;

/**
 * Offsets beyond this are outside any geofence this system models, and
 * rejecting them first keeps every later product inside the exact integer
 * range: 4e9 mm scaled by COS_SCALE is 4e15, under 2^53.
 */
const MAX_OFFSET_MM = 4_000_000_000;

/** cos(d degrees) x 1e6, for d = 0..90. Generated, never computed at runtime. */
const COS_SCALED: readonly number[] = [
  1000000, 999848, 999391, 998630, 997564, 996195, 994522, 992546,
  990268, 987688, 984808, 981627, 978148, 974370, 970296, 965926,
  961262, 956305, 951057, 945519, 939693, 933580, 927184, 920505,
  913545, 906308, 898794, 891007, 882948, 874620, 866025, 857167,
  848048, 838671, 829038, 819152, 809017, 798636, 788011, 777146,
  766044, 754710, 743145, 731354, 719340, 707107, 694658, 681998,
  669131, 656059, 642788, 629320, 615661, 601815, 587785, 573576,
  559193, 544639, 529919, 515038, 500000, 484810, 469472, 453990,
  438371, 422618, 406737, 390731, 374607, 358368, 342020, 325568,
  309017, 292372, 275637, 258819, 241922, 224951, 207912, 190809,
  173648, 156434, 139173, 121869, 104528, 87156, 69756, 52336,
  34899, 17452, 0,
];

/**
 * cos(latitude), scaled by 1e6, by linear interpolation between whole
 * degrees.
 *
 * The table is held to six places rather than four deliberately: at four,
 * rounding each entry costs up to 5e-5 and *dominates* the interpolation
 * error, so the accuracy claim in ADR-018 would have been false. At six the
 * interpolation error of at most 4e-5 is what remains.
 */
export function cosLatitudeScaled(latE7: number): number {
  const abs = Math.abs(latE7);
  const degree = Math.trunc(abs / MICRODEGREES_PER_DEGREE);
  if (degree >= 90) return 0;

  const remainder = abs - degree * MICRODEGREES_PER_DEGREE;
  const delta = COS_SCALED[degree + 1] - COS_SCALED[degree];
  return COS_SCALED[degree] + Math.trunc((delta * remainder) / MICRODEGREES_PER_DEGREE);
}

/** North-south and east-west offsets in whole millimetres, or null if implausibly far. */
function offsetsMm(a: GeoPoint, b: GeoPoint): { latMm: number; lngMm: number } | null {
  const latMm = Math.trunc(((a.latE7 - b.latE7) * MM_PER_MICRODEGREE_X1000) / 1000);
  const rawLngMm = Math.trunc(((a.lngE7 - b.lngE7) * MM_PER_MICRODEGREE_X1000) / 1000);

  if (Math.abs(latMm) > MAX_OFFSET_MM || Math.abs(rawLngMm) > MAX_OFFSET_MM) return null;

  // Scaled after the millimetre conversion, not before: the other order
  // reaches 2e17 for distant points and leaves the exact integer range.
  const cos = cosLatitudeScaled(Math.trunc((a.latE7 + b.latE7) / 2));

  return { latMm, lngMm: Math.trunc((rawLngMm * cos) / COS_SCALE) };
}

/**
 * True when `point` lies within `radiusM` of `centre`.
 *
 * The comparison is between squared millimetre distances, so no square root
 * is taken on the path that decides acceptance. Each axis is rejected first:
 * a single offset larger than the radius already puts the point outside, and
 * checking that before squaring keeps every operand an exact integer.
 */
export function isWithinRadius(point: GeoPoint, centre: GeoPoint, radiusM: number): boolean {
  if (!Number.isInteger(radiusM) || radiusM <= 0) {
    throw new Error(`isWithinRadius: radiusM must be a positive integer (got ${radiusM})`);
  }

  const offsets = offsetsMm(point, centre);
  if (offsets === null) return false;

  const radiusMm = radiusM * 1000;
  const { latMm, lngMm } = offsets;
  if (Math.abs(latMm) > radiusMm || Math.abs(lngMm) > radiusMm) return false;

  return latMm * latMm + lngMm * lngMm <= radiusMm * radiusMm;
}

/**
 * Distance in whole metres, for error messages and reports only.
 *
 * Never call this to decide whether a point is inside a geofence: use
 * isWithinRadius, which reaches its verdict without a square root at all.
 */
export function distanceMetres(a: GeoPoint, b: GeoPoint): number {
  const offsets = offsetsMm(a, b);
  if (offsets === null) return Number.MAX_SAFE_INTEGER;

  const { latMm, lngMm } = offsets;
  return Math.round(Math.sqrt(latMm * latMm + lngMm * lngMm) / 1000);
}
