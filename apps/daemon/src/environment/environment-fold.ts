import type { StoredEvent } from "@moe/store";

/**
 * The read half of the environment composition: every committed event on one environment's
 * aggregate, folded into the CURRENT variable set.
 *
 * WHY THE FOLD IS ITS OWN MODULE. It is the only code that decodes bytes this slice wrote, and it
 * is the only code the canary suite needs in order to walk the raw event stream. Keeping it out
 * of `environment-store.ts` also keeps the module that HOLDS THE KEY free of parsing logic: the
 * fold never sees a credential and cannot open anything, so no decode path here can leak a value.
 *
 * WHY A MALFORMED RECORD DROPS THE VARIABLE RATHER THAN BEING IGNORED. Ignoring a corrupt SET
 * would silently resurrect whatever the PREVIOUS set had put there, which is the more dangerous
 * reading: the operator believes they updated a secret and the old one stays current. Dropping
 * the name means the variable reads as absent, which is visible and safe. A corrupt UNSET already
 * drops it, so both malformed cases land on the same conservative answer.
 */

/**
 * The two event types, declared HERE rather than in the store so the fold can match them by
 * exact equality instead of by a suffix rule. A suffix rule is how `...variable.unset` gets
 * mistaken for a set the day someone renames an event.
 */
export const ENVIRONMENT_VARIABLE_SET_EVENT = "moe.environment.variable.set" as const;
export const ENVIRONMENT_VARIABLE_UNSET_EVENT = "moe.environment.variable.unset" as const;

export interface EnvironmentVariableState {
  readonly fingerprintSha256: string;
  readonly sealed: Uint8Array;
  readonly updatedAt: string;
}

const decoder = new TextDecoder();

function parseRecord(payload: Uint8Array): Readonly<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payload)) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Readonly<Record<string, unknown>>;
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decodeSealed(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const bytes = Buffer.from(value, "base64");
  // `Buffer.from(_, "base64")` is lenient: it drops what it cannot decode rather than throwing,
  // so a round-trip comparison is what actually proves the field was base64.
  return bytes.toString("base64") === value ? new Uint8Array(bytes) : null;
}

/**
 * Folds `events` in aggregate order into the current variable set. Later events win; an UNSET
 * removes the name. Nothing here is decrypted - the sealed bytes are carried through opaquely.
 * An event of an UNRECOGNISED type is skipped without disturbing state: this aggregate is this
 * slice's alone, so a foreign type is not a fact about any variable.
 */
export function foldEnvironmentEvents(
  events: readonly StoredEvent[],
): ReadonlyMap<string, EnvironmentVariableState> {
  const current = new Map<string, EnvironmentVariableState>();
  for (const event of events) {
    if (
      event.eventType !== ENVIRONMENT_VARIABLE_SET_EVENT
      && event.eventType !== ENVIRONMENT_VARIABLE_UNSET_EVENT
    ) continue;
    const record = parseRecord(event.payload);
    const name = record === null ? null : readString(record, "name");
    if (record === null || name === null) continue;
    if (event.eventType === ENVIRONMENT_VARIABLE_UNSET_EVENT) {
      current.delete(name);
      continue;
    }
    const sealed = decodeSealed(record["sealed"]);
    const fingerprintSha256 = readString(record, "fingerprintSha256");
    const updatedAt = readString(record, "updatedAt");
    if (sealed === null || fingerprintSha256 === null || updatedAt === null) {
      current.delete(name);
      continue;
    }
    current.set(name, Object.freeze({ fingerprintSha256, sealed, updatedAt }));
  }
  return current;
}
