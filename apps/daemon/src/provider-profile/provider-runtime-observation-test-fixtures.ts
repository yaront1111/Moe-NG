/**
 * Shared request fixtures for the runtime-observation codec and reader suites.
 *
 * This module builds inputs and drives the PRODUCTION pipeline; it reimplements no rule. The
 * observation sections come from @moe/runner's own `buildProviderRuntimeObservation` with an
 * INJECTED FIXED clock, so the daemon is exercised against the shape the observing adapter
 * actually emits rather than a hand-written lookalike — and an identical re-probe is
 * byte-identical rather than merely equal. No `Date`, no randomness: `observedAt` is admitted
 * content, never sampled here.
 */

import { buildProviderRuntimeObservation } from "@moe/runner";
import { SqliteEventStore } from "@moe/store";

import type { ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import { PROJECT_ID, envelope, openStore, send } from "../bootstrap/bootstrap-test-fixtures.js";
import type { Envelope } from "../bootstrap/bootstrap-test-fixtures.js";

export const CODEC_LAYER = "PROVIDER_RUNTIME_OBSERVATION_CODEC";
export const READER_LAYER = "PROVIDER_RUNTIME_OBSERVATION_READER";
export const REGISTRATION_LAYER = "PROVIDER_PROFILE_REGISTRATION";
export const REVISION_ID = "profile-revision-1";
export const PROVIDER_AGGREGATE = `${PROJECT_ID}-provider`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const foreignStores: SqliteEventStore[] = [];

export type Json = Record<string, unknown>;

export function validDraft(revisionId: string = REVISION_ID): Json {
  return {
    capabilitySchemaDigest: "a1".repeat(32),
    concurrencyCeiling: 4,
    limits: { stderrBytes: 65_536, stdoutBytes: 131_072, tailBytes: 4_096, timeoutMs: 900_000 },
    modelSnapshotEvidence: "claude --version -> 2.0.14 (claude-opus-5-20260514)",
    modelSnapshotKind: "DATED_SNAPSHOT",
    profileRevisionId: revisionId,
    provider: "claude",
    providerMinimumProfileRef: "provider-profile-1",
    reasoningEffort: "high",
    selectedModelId: "claude-opus-5",
    selection: {
      modelRef: "model-ref-1",
      profileRef: "profile-ref-1",
      providerRef: "provider-ref-1",
      reasoningEffortRef: "reasoning-effort-ref-1",
      runtimeRef: "runtime-ref-1",
      snapshotRef: "snapshot-ref-1",
      structuredOutputSchemaRef: "structured-output-schema-ref-1",
    },
  };
}

/** The observation as the RUNNER builds it, flattened through JSON exactly as the wire would. */
export function runtimeSection(options: { closureSha?: string } = {}): Json {
  const built = buildProviderRuntimeObservation({
    adapterCapabilitySchemaDigest: "a1".repeat(32),
    clock: { observedAt: () => "2026-08-20T00:00:00.000Z" },
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
    reportedVersion: "2.0.14",
    resolvedRuntimeClosure: [
      { kind: "EXECUTABLE", path: "/opt/claude/bin/claude", sha256: options.closureSha ?? "b2".repeat(32) },
    ],
  });
  if (!built.ok) throw new Error(`fixture observation refused: ${built.code}`);
  return JSON.parse(JSON.stringify(built.observation)) as Json;
}

/**
 * A runner-built observation with an EXACT closure entry count and path width, so a size-boundary
 * case addresses the product the adapter really emits rather than a hand-shaped lookalike. Paths
 * carry a zero-padded index prefix, which keeps them strictly ascending after the runner sorts.
 */
export function sizedRuntimeSection(entries: number, pathChars: number): Json {
  const built = buildProviderRuntimeObservation({
    adapterCapabilitySchemaDigest: "a1".repeat(32),
    clock: { observedAt: () => "2026-08-20T00:00:00.000Z" },
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
    reportedVersion: "2.0.14",
    resolvedRuntimeClosure: Array.from({ length: entries }, (_unused, index) => ({
      kind: "EXECUTABLE" as const,
      path: `/opt/claude/${String(index).padStart(4, "0")}/`.padEnd(pathChars, "x"),
      sha256: "b2".repeat(32),
    })),
  });
  if (!built.ok) throw new Error(`sized fixture observation refused: ${built.code}`);
  return JSON.parse(JSON.stringify(built.observation)) as Json;
}

/** A weak-truth observation: no closure and no reported version classify as UNKNOWN. */
export function unknownTruthSection(): Json {
  const built = buildProviderRuntimeObservation({
    adapterCapabilitySchemaDigest: "a1".repeat(32),
    clock: { observedAt: () => "2026-08-20T00:00:00.000Z" },
    pinningMethod: "UNSUPPORTED",
    platformIdentity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
    reportedVersion: null,
    resolvedRuntimeClosure: [],
  });
  if (!built.ok) throw new Error(`fixture observation refused: ${built.code}`);
  return JSON.parse(JSON.stringify(built.observation)) as Json;
}

export interface ProbeOptions {
  readonly commandId?: string;
  readonly expectedVersion?: number;
  readonly profile?: Json;
  /** `null` sends a LEGACY probe with no section at all; `undefined` sends the default one. */
  readonly runtime?: Json | null;
  readonly truthClass?: string;
}

export function probeFor(options: ProbeOptions = {}): Envelope {
  const observation: Json = {
    profile: options.profile ?? validDraft(),
    providerMinimumProfileRef: "provider-profile-1",
    truthClass: options.truthClass ?? "DAEMON_VERIFIED",
  };
  if (options.runtime !== null) observation.runtime = options.runtime ?? runtimeSection();
  return envelope(
    "provider.probe",
    options.expectedVersion ?? 0,
    { observation },
    options.commandId ?? "probe-1",
  );
}

export function registeredStore(projectId: string = PROJECT_ID): SqliteEventStore {
  let store: SqliteEventStore;
  if (projectId === PROJECT_ID) {
    store = openStore();
  } else {
    store = SqliteEventStore.openEphemeralForProjectTest(projectId);
    foreignStores.push(store);
  }
  const registered = send(store, {
    ...envelope("project.register", 0, { owner: "owner-1" }),
    projectId,
  });
  if (!registered.ok) throw new Error(`fixture register failed: ${registered.code}`);
  return store;
}

export function closeForeignStores(): void {
  while (foreignStores.length > 0) foreignStores.pop()?.close();
}

export function accepted(outcome: ServiceOutcome): Json {
  if (!outcome.ok) throw new Error(`expected acceptance, got ${outcome.code}`);
  return JSON.parse(decoder.decode(outcome.decision.resultBytes)) as Json;
}

export function refused(outcome: ServiceOutcome): { code: string; refusedBy: string } {
  if (outcome.ok) throw new Error("expected a refusal, got an accepted decision");
  return { code: outcome.code, refusedBy: outcome.refusedBy };
}

export function probedEvents(
  store: SqliteEventStore,
  aggregateId: string = PROVIDER_AGGREGATE,
): readonly Json[] {
  return store
    .readEvents(aggregateId)
    .filter((event) => event.eventType === "ProviderProbed")
    .map((event) => JSON.parse(decoder.decode(event.payload)) as Json);
}

/** The bytes as committed. `toEqual` on a parsed value is key-order blind; this is not. */
export function probedEventText(store: SqliteEventStore): readonly string[] {
  return store
    .readEvents(PROVIDER_AGGREGATE)
    .filter((event) => event.eventType === "ProviderProbed")
    .map((event) => decoder.decode(event.payload));
}

/** Plants a payload the production writer would never emit, through the store's own API. */
export function plantProbe(store: SqliteEventStore, payload: Json, eventId: string): void {
  store.commit({
    aggregateId: PROVIDER_AGGREGATE,
    commandBytes: encoder.encode(`plant-${eventId}`),
    commandId: `cmd-plant-${eventId}`,
    committedAt: "2026-08-20T21:00:00.000Z",
    events: [{
      eventId,
      eventType: "ProviderProbed",
      payload: encoder.encode(JSON.stringify(payload)),
    }],
    expectedVersion: store.getAggregateVersion(PROVIDER_AGGREGATE),
  });
}

export function omit(value: Json, key: string): Json {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
