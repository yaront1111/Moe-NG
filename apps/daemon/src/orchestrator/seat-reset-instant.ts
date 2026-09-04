/**
 * WHEN a provider limit lifts, read off the provider's own reset text.
 *
 * Split out of the seat-exit classifier so each module stays inside the per-file line cap: the
 * roster answers WHICH limit was hit, this answers WHEN it clears. Pure — the exit instant is an
 * input, never a clock read, so a reset that straddles a DST boundary is testable.
 */

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

/**
 * The claude form: `[Sep 8, ]10:46am (Asia/Jerusalem)`. The parentheses are optional because the
 * build captured on 2026-09-03 rendered the zone bare while 2.1.260 parenthesises it — both are
 * real provider bytes, so both must parse.
 */
const CLAUDE_WALL_CLOCK =
  /(?:([A-Za-z]{3})[a-z]* (\d{1,2}),\s*)?(\d{1,2}):(\d{2})\s*(am|pm)\s+\(?([A-Za-z_]+(?:\/[A-Za-z_+-]+)+)\)?/iu;

/** The codex form: `try again at Sep 8th, 2026 10:46 AM.` — a wall clock with a year and no zone. */
const CODEX_DATED =
  /\b([A-Za-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/iu;

/** A bare calendar date, resolved to its midnight UTC. */
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/u;

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);
}

function hour24(hour: number, meridiem: string): number {
  const base = hour % 12;
  return meridiem.toLowerCase() === "pm" ? base + 12 : base;
}

/** Node ships full ICU, but the roster must still refuse a zone this engine cannot resolve. */
function knownZone(zone: string): boolean {
  const supported = (Intl as { supportedValuesOf?: (key: string) => readonly string[] })
    .supportedValuesOf;
  if (typeof supported === "function") {
    try {
      if (supported("timeZone").includes(zone)) return true;
    } catch {
      // An engine carrying the method but not the timeZone key falls through to the probe below.
    }
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone's wall-clock fields at an instant: [year, month, day, hour, minute, second]. */
function zoneFields(zone: string, instantMs: number): readonly number[] | null {
  let parts: readonly Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit",
      second: "2-digit", timeZone: zone, year: "numeric",
    }).formatToParts(new Date(instantMs));
  } catch {
    return null;
  }
  const found = new Map<string, string>();
  for (const part of parts) found.set(part.type, part.value);
  const fields = ["year", "month", "day", "hour", "minute", "second"]
    .map((key) => Number(found.get(key)));
  return fields.some((value) => !Number.isFinite(value)) ? null : fields;
}

/** Milliseconds this zone is EAST of UTC at that instant, DST included. */
function zoneOffsetMs(zone: string, instantMs: number): number | null {
  const fields = zoneFields(zone, instantMs);
  if (fields === null) return null;
  const [year, month, day, hour, minute, second] =
    fields as [number, number, number, number, number, number];
  return Date.UTC(year, month - 1, day, hour, minute, second) - instantMs;
}

/**
 * The instant a wall clock names in a zone. Two passes: the first offset is read at the naive
 * guess, the second at the instant that guess resolved to, so a reset landing on the far side of a
 * DST change is converted with ITS OWN offset rather than the exit's.
 */
function wallClockToUtc(
  zone: string, year: number, month: number, day: number, hour: number, minute: number,
): number | null {
  const naive = Date.UTC(year, month, day, hour, minute, 0, 0);
  const first = zoneOffsetMs(zone, naive);
  if (first === null) return null;
  const second = zoneOffsetMs(zone, naive - first);
  if (second === null) return null;
  return naive - second;
}

function resolveClaudeWallClock(match: RegExpExecArray, exitMs: number): string | null {
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = match as unknown as string[];
  if (zone === undefined || !knownZone(zone)) return null;
  const local = zoneFields(zone, exitMs);
  if (local === null) return null;
  const hour = hour24(Number(hourText), meridiem as string);
  const minute = Number(minuteText);
  if (monthName !== undefined && dayText !== undefined) {
    const month = monthIndex(monthName);
    if (month < 0) return null;
    // The renderer omits the year while it equals the current one, so read it off the exit and
    // roll a whole year only when that would otherwise place the reset in the past.
    return firstFutureInstant(
      [0, 1].map((bump) => wallClockToUtc(
        zone, (local[0] as number) + bump, month, Number(dayText), hour, minute,
      )),
      exitMs,
    );
  }
  // No date: the NEXT occurrence of that wall clock — today's, unless today's has already passed.
  return firstFutureInstant(
    [0, 1].map((bump) => wallClockToUtc(
      zone, local[0] as number, (local[1] as number) - 1, (local[2] as number) + bump, hour, minute,
    )),
    exitMs,
  );
}

function firstFutureInstant(candidates: readonly (number | null)[], exitMs: number): string | null {
  for (const candidate of candidates) {
    if (candidate === null) return null;
    if (candidate > exitMs) return new Date(candidate).toISOString();
  }
  return null;
}

/**
 * The reset instant a provider line names, as ISO, or null when it names none this module reads.
 *
 * The codex form carries no zone — codex renders it in the HOST's local wall clock. Reading it as
 * UTC is deliberate: for any zone east of UTC that moves the instant LATER, so the pause outlasts
 * the limit rather than expiring early into another refusal.
 */
export function resolveResetInstant(text: string, exitAt: string): string | null {
  const exitMs = Date.parse(exitAt);
  if (!Number.isFinite(exitMs) || text === "") return null;
  const wall = CLAUDE_WALL_CLOCK.exec(text);
  if (wall !== null) return resolveClaudeWallClock(wall, exitMs);
  const dated = CODEX_DATED.exec(text);
  if (dated !== null) {
    const month = monthIndex(dated[1] as string);
    if (month < 0) return null;
    const utc = Date.UTC(
      Number(dated[3]), month, Number(dated[2]), hour24(Number(dated[4]), dated[6] as string),
      Number(dated[5]), 0, 0,
    );
    return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
  }
  const iso = ISO_DATE.exec(text);
  if (iso === null) return null;
  const utc = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 0, 0, 0, 0);
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}
