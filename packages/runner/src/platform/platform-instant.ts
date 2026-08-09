import { isCanonicalUtcTimestamp } from "../canonical.js";

/**
 * Instant arithmetic for platform freshness comparison.
 *
 * Deliberately not `Date` in any form — not `Date.now`, not `new Date`, not
 * `Date.parse`. This area must stay a pure function of its arguments so a
 * verdict is reproducible off-host, and a module that already knows how to read
 * a clock is one edit away from reading one.
 */
const CANONICAL_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u;

/** Milliseconds since 1970-01-01T00:00:00Z, or null for anything non-canonical. */
export function canonicalEpochMillis(value: unknown): number | null {
  if (!isCanonicalUtcTimestamp(value)) {
    return null;
  }
  const match = CANONICAL_INSTANT.exec(value);
  if (match === null) {
    return null;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const millis = match[7] === undefined ? 0 : Number(match[7]);
  const days = daysFromCivil(year, month, day);
  return ((days * 24 + hour) * 60 + minute) * 60_000 + second * 1_000 + millis;
}

/** Proleptic Gregorian days since the epoch; Howard Hinnant's `days_from_civil`. */
function daysFromCivil(year: number, month: number, day: number): number {
  const shifted = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}
