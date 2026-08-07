/**
 * DEVELOPMENT_ONLY / NOT_CONFIRMATORY injected-port fakes for the foundation
 * fault schedules.
 *
 * These are the seam that keeps the testkit honest: the foundation modules
 * import `@moe/contracts` and nothing else, so the landed reducers, store and
 * scheduler reach the schedules only through ports the fault tests construct
 * here and fill in themselves. Nothing in this file imports a production
 * package other than the shared contracts vocabulary.
 *
 * Every port is pure and caller-driven. There is no wall clock and no
 * randomness anywhere: time is a list of instants the caller supplies, so two
 * runs of the same schedule are byte-identical.
 */

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandKind } from "@moe/contracts";

import { canonicalize } from "../canonical-json.js";

export const FOUNDATION_FAKE_KIND = "DEVELOPMENT_ONLY/NOT_CONFIRMATORY" as const;

/** A 64-hex placeholder digest. Fixed, so envelopes stay reproducible. */
export const FAKE_REQUEST_DIGEST =
  "1111111111111111111111111111111111111111111111111111111111111111" as const;

export interface FoundationClockPort {
  /** Returns the next caller-supplied instant, or throws once they run out. */
  readonly next: () => string;
}

/**
 * A clock with no clock in it. Exhaustion throws rather than repeating: a
 * schedule that reads more instants than it declared has changed shape, and
 * silently recycling the last value would hide that.
 */
export function createFixedClock(instants: readonly string[]): FoundationClockPort {
  let index = 0;
  return Object.freeze({
    next: (): string => {
      const instant = instants[index];
      if (instant === undefined) {
        throw new RangeError(`Fixed clock exhausted after ${String(index)} instants`);
      }
      index += 1;
      return instant;
    },
  });
}

export interface FakeLeaseAuthority {
  readonly attemptBindingVersion: number;
  readonly authorityHash: string;
  readonly epoch: number;
  readonly graphEpoch: number;
  readonly leaseToken: string;
}

export function buildLeaseAuthority(epoch: number, graphEpoch = 1): FakeLeaseAuthority {
  return Object.freeze({
    attemptBindingVersion: 1,
    authorityHash: FAKE_REQUEST_DIGEST,
    epoch,
    graphEpoch,
    leaseToken: `lease-${String(epoch)}`,
  });
}

export interface CommandEnvelopeOverrides {
  readonly commandId?: string;
  readonly correlationId?: string;
  readonly expectedVersion?: number;
  readonly leaseAuthority?: FakeLeaseAuthority;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly requestDigest?: string;
  readonly schemaVersion?: string;
  readonly sessionCredential?: string;
  readonly targetAggregateId?: string;
}

/**
 * Builds a record shaped exactly like a `RuntimeCommandEnvelope`. Defaults are
 * valid, so a schedule states only the one field it is making hostile.
 */
export function buildCommandEnvelopeRecord(
  commandKind: RuntimeCommandKind,
  overrides: CommandEnvelopeOverrides = {},
): Readonly<Record<string, unknown>> {
  const record: Record<string, unknown> = {
    commandId: overrides.commandId ?? "command-1",
    commandKind,
    correlationId: overrides.correlationId ?? "correlation-1",
    expectedVersion: overrides.expectedVersion ?? 0,
    payload: overrides.payload ?? {},
    requestDigest: overrides.requestDigest ?? FAKE_REQUEST_DIGEST,
    schemaVersion: overrides.schemaVersion ?? RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: overrides.sessionCredential ?? "session-1",
    targetAggregateId: overrides.targetAggregateId ?? "aggregate-1",
  };
  if (overrides.leaseAuthority !== undefined) {
    record["leaseAuthority"] = { ...overrides.leaseAuthority };
  }
  return Object.freeze(record);
}

/** Canonical bytes, so the same record always produces the same input. */
export function encodeCanonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/**
 * The observation port a fault test fills with the REAL export names of a
 * production package. The testkit never imports the package; it only compares
 * the names it is handed against what a probe declared absent.
 */
export interface FoundationExportSurfacePort {
  readonly exportNamesOf: (packageName: string) => readonly string[];
}

export function createExportSurfacePort(
  surfaces: Readonly<Record<string, readonly string[]>>,
): FoundationExportSurfacePort {
  return Object.freeze({
    exportNamesOf: (packageName: string): readonly string[] => {
      const names = surfaces[packageName];
      if (names === undefined) {
        throw new ReferenceError(`No export surface supplied for ${packageName}`);
      }
      return Object.freeze([...names].sort());
    },
  });
}

/** Sorted runtime export names of a module namespace object. */
export function exportNames(namespace: object): readonly string[] {
  return Object.freeze(Object.keys(namespace).sort());
}

export interface RecordedDispatch {
  readonly commandKind: string;
  readonly outcome: string;
}

export interface FoundationDispatchPort {
  readonly dispatch: (commandKind: string) => string;
  readonly recorded: () => readonly RecordedDispatch[];
}

/**
 * A dispatch port with no dispatcher behind it. The caller supplies the outcome
 * for each command kind; an unlisted kind throws rather than defaulting, so a
 * schedule can never accidentally read a green it never declared.
 */
export function createRecordingDispatchPort(
  outcomes: Readonly<Record<string, string>>,
): FoundationDispatchPort {
  const recorded: RecordedDispatch[] = [];
  return Object.freeze({
    dispatch: (commandKind: string): string => {
      const outcome = outcomes[commandKind];
      if (outcome === undefined) {
        throw new ReferenceError(`No fake outcome declared for ${commandKind}`);
      }
      recorded.push(Object.freeze({ commandKind, outcome }));
      return outcome;
    },
    recorded: (): readonly RecordedDispatch[] => Object.freeze([...recorded]),
  });
}
