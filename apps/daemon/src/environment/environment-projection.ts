import type { SqliteEventStore } from "@moe/store";

import { environmentRefusal, environmentValueFingerprintOfBytes, isEnvironmentName } from
  "./environment-contracts.js";
import type {
  EnvironmentName,
  EnvironmentRefusal,
  EnvironmentVariableRead,
} from "./environment-contracts.js";
import { openEnvironmentValue } from "./environment-cipher.js";
import { foldEnvironmentEvents } from "./environment-fold.js";
import type { EnvironmentVariableState } from "./environment-fold.js";

/**
 * The read side: resolve the key, fold the aggregate, open every seal, project the read shape.
 *
 * WHY A READ OPENS THE SEAL AND THEN THROWS THE PLAINTEXT AWAY. It would be cheaper to report
 * "a variable exists" straight from the fold without touching the key. Two things break if we do.
 * First, `isSet` would mean "some bytes are on disk" rather than "the daemon can actually recover
 * this value" - the operator would see a healthy list for a store they can no longer decrypt.
 * Second, and this is the requirement the slice exists to satisfy: a store COPIED WITHOUT THE
 * DAEMON CREDENTIAL would happily list its variables. Opening on read is what makes the copy
 * useless rather than merely undelivered. The recovered plaintext derives the returned
 * fingerprint and is then dropped; it is never returned, logged or attached to a refusal.
 *
 * WHY THE RETURNED FINGERPRINT IS DERIVED, NOT READ BACK. The event payload also carries the
 * fingerprint - that is the durable evidence a value was written - but the payload is NOT covered
 * by the seal's authentication tag, so a tampered payload could carry any fingerprint at all. The
 * answer is therefore computed from the plaintext GCM actually authenticated. The stored copy is
 * evidence; the derived copy is the answer.
 */

const KEY_UNAVAILABLE = "ENV_STORE_KEY_UNAVAILABLE" as const;

/**
 * Resolves the daemon credential. May THROW - a credential that exists but cannot be read (an
 * EACCES on its file, say) is a real case, and this converts it to a refusal rather than letting
 * it escape as an exception carrying a path.
 */
export type EnvironmentCredentialSource = () => string | null;

export interface EnvironmentStoreConfig {
  readonly credential: EnvironmentCredentialSource;
  readonly now: () => string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export interface EnvironmentReadOk {
  readonly environment: EnvironmentName;
  readonly ok: true;
  readonly variables: readonly EnvironmentVariableRead[];
}

/**
 * Every entry point answers this ONE shape, mutations included: a write reports the environment's
 * state AFTER it lands. One shape means the "no value on any path" property is proved once rather
 * than once per entry point, and it hands the operator the fingerprint - their only evidence the
 * update took - in the same breath as the write.
 */
export type EnvironmentReadResult = EnvironmentReadOk | EnvironmentRefusal;

export function environmentAggregateId(projectId: string, environment: EnvironmentName): string {
  return `environment/${projectId}/${environment}`;
}

/** Empty counts as ABSENT: `daemon-main.ts:166` defaults the unset env var to `""`. */
export function resolveCredential(config: EnvironmentStoreConfig): string | null {
  let credential: string | null;
  try {
    credential = config.credential();
  } catch {
    // Swallowed on purpose: the thrown error can name a credential path, and a refusal that
    // relays it publishes where the secret lives.
    return null;
  }
  return typeof credential === "string" && credential.length > 0 ? credential : null;
}

export function readEnvironmentState(
  config: EnvironmentStoreConfig,
  environment: EnvironmentName,
): ReadonlyMap<string, EnvironmentVariableState> {
  return foldEnvironmentEvents(
    config.store.readEvents(environmentAggregateId(config.projectId, environment)),
  );
}

/**
 * Opens every current seal under `credential` and projects the read shape, or null when any one
 * of them will not open. A single unopenable record fails the WHOLE read: reporting the openable
 * subset would let a partially-unreadable store look healthy, and the caller could not tell
 * which of the two readings they had been given.
 */
export function projectEnvironmentVariables(
  state: ReadonlyMap<string, EnvironmentVariableState>,
  credential: string,
): readonly EnvironmentVariableRead[] | null {
  const variables: EnvironmentVariableRead[] = [];
  for (const [name, record] of [...state.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const opened = openEnvironmentValue(credential, record.sealed);
    if (!opened.ok) return null;
    variables.push(Object.freeze({
      // Hashed as BYTES: the plaintext is never turned into a string on the read path.
      fingerprintSha256: environmentValueFingerprintOfBytes(opened.plaintext),
      isSet: true as const,
      name,
      updatedAt: record.updatedAt,
    }));
  }
  return Object.freeze(variables);
}

export interface AdmittedEnvironment {
  readonly credential: string;
  readonly environment: EnvironmentName;
}

/**
 * The shared preamble: scope, then key, then a proof that the EXISTING state is openable. That
 * last check is what makes a write under the wrong credential refuse BEFORE it commits, instead
 * of landing bytes nobody can open and failing only when the post-write listing is built. Name
 * and value checks belong to their own entry points because a read has neither.
 */
export function admitEnvironment(
  config: EnvironmentStoreConfig,
  environment: string,
): AdmittedEnvironment | EnvironmentRefusal {
  if (!isEnvironmentName(environment)) return environmentRefusal("ENV_ENVIRONMENT_UNKNOWN");
  const credential = resolveCredential(config);
  if (credential === null) return environmentRefusal(KEY_UNAVAILABLE);
  if (projectEnvironmentVariables(readEnvironmentState(config, environment), credential) === null) {
    return environmentRefusal(KEY_UNAVAILABLE);
  }
  return { credential, environment };
}

export function isEnvironmentRefusal(
  value: AdmittedEnvironment | EnvironmentRefusal,
): value is EnvironmentRefusal {
  return "ok" in value && value.ok === false;
}

/** Re-reads and projects, so a mutation's answer comes from the durable log, not from memory. */
export function answerEnvironmentRead(
  config: EnvironmentStoreConfig,
  environment: EnvironmentName,
  credential: string,
): EnvironmentReadResult {
  const variables = projectEnvironmentVariables(
    readEnvironmentState(config, environment), credential,
  );
  if (variables === null) return environmentRefusal(KEY_UNAVAILABLE);
  return Object.freeze({ environment, ok: true as const, variables });
}
