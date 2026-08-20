/**
 * HOSTILE SCENARIOS for `SAFE_BOUNDARY_OBSERVATION_LAYER`, the durable-store axis's
 * sixteenth boundary (roster entry and arms: task-120403f7).
 *
 * WHY THIS AXIS, recorded rather than assumed — the roster's SUBJECT-WINS rule admits a
 * real alternative here, and `PROVIDER_EFFECT_SETTLEMENT_LAYER` is the precedent for it
 * (`runtime-provider`, "answers for a provider RUN's evidence"). Three measurements decide
 * it the other way. The module owns no process, no platform and no provider invocation: it
 * READS one durable record and COMMITS another. Four of its five refusal codes —
 * RUN_UNREADABLE, OBSERVATION_ABSENT, OBSERVATION_UNREADABLE, COMMIT_CONFLICT — are durable
 * read/write facts. And its race is literally a `commitExpectedVersionDecision` conflict at
 * `expectedVersion 0`, which is the durable-store axis's signature race shape.
 *
 * NOT a `*.security.ts` file and it holds NO assertions: the lane collects that suffix, and
 * the slice that imports these scenarios is where every verdict is reached. This module only
 * ARRANGES durable state and calls production.
 *
 * NOTHING HERE IMPORTS THE PRODUCER'S `.test.ts`, and no part of its authority is restated.
 * The predicate is never recomputed — every boundary fact below is read back off what
 * production wrote. The activation body and the run record shape are a FIXTURE RECIPE, taken
 * from the canonical shape the attempt-reader suite owns, and every durable byte goes in
 * through `runEffectActivateCommand` and `commitProviderRunRecord`: a hand-written event
 * would let both sides drift together while staying green.
 */

import { join } from "node:path";

import type {
  ProviderFactUnknown, ProviderRunRef,
} from "../../packages/runner/src/providers/telemetry/provider-telemetry-contracts.js";
import { SqliteEventStore } from "../../packages/store/src/index.js";
import type { CommandDecisionKey } from "../../packages/store/src/index.js";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../../apps/daemon/src/activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../../apps/daemon/src/activation/activation-ingress.js";
import {
  PRINCIPAL_ID, PROJECT_ID, seedReadyProject,
} from "../../apps/daemon/src/recovery/restore-test-harness.js";
import { PROVIDER_RUN_RECORD_VERSION } from "../../apps/daemon/src/telemetry/provider-run-contracts.js";
import type { ProviderRunRecord } from "../../apps/daemon/src/telemetry/provider-run-contracts.js";
import { commitProviderRunRecord } from "../../apps/daemon/src/telemetry/provider-run-ledger.js";
import {
  SAFE_BOUNDARY_OBSERVATION_LAYER, readSafeBoundaryObservation, recordSafeBoundaryObservation,
} from "../../apps/daemon/src/work/safe-boundary-observation.js";
import { hostileRoot } from "./hostile-harness.js";

export { SAFE_BOUNDARY_OBSERVATION_LAYER };

const encoder = new TextEncoder();
const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-16T00:00:00.000Z";
/** Wall SECONDS; the scheduler's overdue rule is `seconds > deadline`. */
const LIVE_DEADLINE = Math.floor(Date.parse(DECIDED_AT) / 1_000) + 3_600;
const ATTEMPT = "attempt-safe-boundary";
const SESSION = "session-owner";
const EPOCH = 41;
const OBSERVATION_EVENT_TYPE = "SafeBoundaryObserved";

const openStores: SqliteEventStore[] = [];

/** A real file-backed store on a fresh hostile root, seeded to READY through the real
 *  bootstrap path. Registered for cleanup: an unregistered SQLite handle kills the worker. */
function openBoundaryStore(label: string): { path: string; store: SqliteEventStore } {
  const path = join(hostileRoot(`safe-boundary-${label}`), "project.db");
  const store = SqliteEventStore.openForProject(path, PROJECT_ID);
  openStores.push(store);
  seedReadyProject(store);
  return { path, store };
}

/** A SECOND connection to the same durable file. The race needs two real connections: one
 *  handle can serialise the interleaving away, and the property is about DURABLE state. */
function openSecondConnection(path: string): SqliteEventStore {
  const store = SqliteEventStore.openForProject(path, PROJECT_ID);
  openStores.push(store);
  return store;
}

/**
 * Close ONE store as soon as its scenario is finished with it, and drop it from the pending
 * list. Measured, not defensive: the reason sweep runs inside a `describe` BODY, i.e. at
 * COLLECTION, so its roots are the first ones `cleanupHostileRoots` reaches — and a root
 * whose SQLite handle is still open cannot be removed on win32 no matter how many times the
 * remover retries. Deferring every close to `afterAll` leaked exactly those four roots per
 * lane run; a scenario that has already read its answer has no reason to hold the file.
 */
function closeNow(store: SqliteEventStore): void {
  const pending = openStores.indexOf(store);
  if (pending >= 0) openStores.splice(pending, 1);
  try {
    store.close();
  } catch {
    // A double close is not a verdict; the root is removed by the harness either way.
  }
}

/** Handles first, roots after — the harness removes the roots. Safe twice. */
export function closeSafeBoundaryStores(): number {
  let closed = 0;
  for (const store of openStores.splice(0)) {
    try {
      store.close();
      closed += 1;
    } catch {
      // A double close is not a verdict; the root is removed by the harness either way.
    }
  }
  return closed;
}

interface ActivationSpec {
  readonly attemptId: string; readonly epoch: number;
  readonly sessionId: string; readonly slug: string;
}

/** The canonical `effect.activate` body. Restated as INPUT only — the ingress computes every
 *  grant, digest and aggregate id, which is what makes the committed bytes evidence. */
function activationBytes(spec: ActivationSpec): Uint8Array {
  const { attemptId, epoch, sessionId, slug } = spec;
  const lease = {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch, kind: "ASSIGNMENT",
    leaseId: `lease-${slug}`, leaseToken: `token-${slug}`, monotonicObservation: 500,
    ownerSessionRef: sessionId, serverWallDeadline: LIVE_DEADLINE, state: "ACTIVE", version: 7,
  } as const;
  const proof = {
    authorityHashRef: DIGEST, epoch, expectedVersion: 7, leaseToken: `token-${slug}`,
    ownerSessionRef: sessionId,
  } as const;
  const claim = {
    claimId: `claim-${slug}`, claimedAt: DECIDED_AT, intentId: `intent-${slug}`,
    lockIdentity: `lock-${slug}`, wrapperIdentity: `wrapper-${slug}`,
  } as const;
  return encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${slug}`, correlationId: `corr-${slug}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: {
        attempt: {
          aggregateId: `agg-${slug}`, attemptId, intentId: `intent-${slug}`,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
        lockIdentity: `lock-${slug}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
        tombstone: null, wrapperIdentity: `wrapper-${slug}`,
      },
      budget: {
        admission: {
          admissionRef: `adm-${slug}`,
          amounts: [
            { meter: "usd", purpose: "EXECUTION", quantity: 10 },
            { meter: "usd", purpose: "VERIFICATION", quantity: 5 },
            { meter: "usd", purpose: "INDEPENDENT_REVIEW", quantity: 5 },
            { meter: "usd", purpose: "FINAL_ACCEPTANCE", quantity: 5 },
            { meter: "usd", purpose: "CONTINGENCY", quantity: 5 },
          ],
          expectedVersion: 2,
        },
        gate: { allowance: { decisionRef: `dec-${slug}`, outcome: "ALLOW" }, approval: null },
        view: {
          accountId: `acct-${slug}`,
          meters: [{ available: 100, committed: 0, meter: "usd", quarantined: 0, reserved: 0 }],
          state: "OPEN", version: 2,
        },
      },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${slug}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${slug}`, inputBinding: DIGEST, intentId: `intent-${slug}`,
          leaseBinding: lease, predecessorCursor: `cursor-${slug}`,
          protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
          state: "PENDING", version: 0,
        },
      },
      lease: { proof, record: lease },
      liveClaims: [{ dimension: slug, slotRef: `held-${slug}`, state: "RESERVED" }],
      slot: {
        dimension: slug, requestId: `req-${slug}`, slotRef: `slot-${slug}`,
        rows: [{
          capacityUnits: 1, effectIntentRef: `intent-ref-${slug}`, epoch: 1, external: false,
          fenceable: true, resourceId: `res-${slug}`, state: "ACTIVE",
        }],
      },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

const blind: ProviderFactUnknown = {
  known: false, code: "TELEMETRY_USAGE_ABSENT", layer: "TELEMETRY_RESULT",
};

const refOf = (slug: string): ProviderRunRef => ({
  provider: "claude", runRef: `run-${slug}`, effectIntentId: `intent-${slug}`,
  attemptRef: ATTEMPT, epoch: EPOCH,
});

/** The base record: a legal run the host never saw terminate. Each variant narrows it. */
const recordOf = (slug: string, overrides: Partial<ProviderRunRecord> = {}): ProviderRunRecord => ({
  recordVersion: PROVIDER_RUN_RECORD_VERSION,
  providerRunRef: refOf(slug),
  launch: {
    kind: "REFUSED", truthClass: "UNKNOWN", reasonCode: null, reasonLayer: null, exit: null,
    effectDigest: null, activationDigest: null, runtimeBindingDigest: null,
    quotedRuntimeDigest: null, freshRuntimeDigest: null, pinnedClosureDigest: null,
    observationDigest: null, startedAt: DECIDED_AT, completedAt: null,
  },
  declared: blind,
  observedModel: { modelId: blind, snapshotKind: "UNKNOWN", snapshotEvidence: blind },
  terminal: "UNKNOWN",
  infrastructure: "EXIT_UNOBSERVED",
  tokens: {
    inputTokens: blind, outputTokens: blind, cacheCreationInputTokens: blind,
    cacheReadInputTokens: blind, coverage: "UNKNOWN",
  },
  steps: { turns: blind, coverage: "UNKNOWN" },
  sequence: { known: true, value: 3 },
  concurrency: { fact: "NO_CONCURRENCY_FACTS", declaredCeiling: blind, achieved: blind },
  observedStart: { serverWallSeconds: 1_700_000_000, bootId: "boot-1", monotonicObservation: 12 },
  observedEnd: null,
  usage: [], usageRefusals: [], upstreamRefusal: null,
  stdoutReceiptDigest: { known: true, value: `stdout-${slug}` },
  stderrReceiptDigest: { known: true, value: `stderr-${slug}` },
  recordDigest: "",
  ...overrides,
});

/** One clause of the predicate failing per variant, and NONE of them is a decoding failure:
 *  every record below is legal and committed, so what refuses the crossing is the clause the
 *  variant broke. The names are the ARRANGEMENT, never an expected answer — the reason code
 *  is read back off what production wrote. */
const launchOf = (
  slug: string, over: Partial<ProviderRunRecord["launch"]>,
): ProviderRunRecord["launch"] => ({ ...recordOf(slug).launch, ...over });

export const REASON_VARIANTS = Object.freeze([
  { arrangement: "truth class never reached PROVEN", slug: "truth" },
  { arrangement: "a non-null exit that denies observation", slug: "unobserved" },
  { arrangement: "a proven exit the terminal classifier never judged", slug: "terminal" },
  { arrangement: "a classified end with no completion instant", slug: "unended" },
] as const);

/** `slug` is IDENTITY — it names the activation, the intent and the run ref, and the reader
 *  binds the attempt to the intent before it reads any run page, so a record whose slug does
 *  not match the activation that seeded it is refused as a binding mismatch rather than
 *  reaching the predicate at all. `shape` selects which clause is broken. */
function variantRecord(slug: string, shape: string = slug): ProviderRunRecord {
  if (shape === "truth") return recordOf(slug);
  if (shape === "unobserved") {
    return recordOf(slug, {
      launch: launchOf(slug, {
        kind: "OBSERVED", truthClass: "PROVEN", exit: { kind: "UNOBSERVED" },
        completedAt: DECIDED_AT,
      }),
      terminal: "COMPLETED", infrastructure: "NONE",
    });
  }
  if (shape === "terminal") {
    return recordOf(slug, {
      launch: launchOf(slug, {
        kind: "OBSERVED", truthClass: "PROVEN", exit: { kind: "EXITED", code: 0 },
        completedAt: DECIDED_AT,
      }),
      infrastructure: "NONE",
    });
  }
  return recordOf(slug, {
    launch: launchOf(slug, {
      kind: "OBSERVED", truthClass: "PROVEN", exit: { kind: "EXITED", code: 0 },
      completedAt: null,
    }),
    terminal: "COMPLETED", infrastructure: "NONE",
  });
}

/** A run the host DID see cross its boundary: proven truth, a real exit, a classified end. */
const observedRecord = (slug: string): ProviderRunRecord => recordOf(slug, {
  launch: launchOf(slug, {
    kind: "OBSERVED", truthClass: "PROVEN", exit: { kind: "EXITED", code: 0 },
    completedAt: DECIDED_AT,
  }),
  terminal: "COMPLETED", infrastructure: "NONE",
});

/** Activation first: the run reader binds the attempt before it reads any run page. */
function seedRun(store: SqliteEventStore, slug: string, record: ProviderRunRecord): void {
  const activated = runEffectActivateCommand(store, activationBytes({
    attemptId: ATTEMPT, epoch: EPOCH, sessionId: SESSION, slug,
  }));
  if (!activated.ok) throw new Error(`safe-boundary fixture activation refused: ${activated.code}`);
  const key: CommandDecisionKey = {
    commandId: `cmd-run-${slug}`, principalId: SESSION, projectId: PROJECT_ID,
  };
  const committed = commitProviderRunRecord(store, {
    correlationId: `corr-run-${slug}`, decidedAt: DECIDED_AT, key, record,
    requestBytes: encoder.encode(`provider-run-request-${slug}`),
  });
  if (!committed.ok) throw new Error(`safe-boundary fixture run refused: ${committed.code}`);
}

/** Identity and decision metadata only: no clock, no boundary field, nothing to claim. */
const inputFor = (slug: string): Record<string, unknown> => ({
  attemptRef: ATTEMPT,
  correlationId: `corr-boundary-${slug}`,
  key: { commandId: `cmd-boundary-${slug}`, principalId: SESSION, projectId: PROJECT_ID },
  projectId: PROJECT_ID,
  requestBytes: encoder.encode(`safe-boundary-request-${slug}`),
});

/** Durable observations, counted off the committed event stream rather than off any value a
 *  refusal handed back: a returned refusal is not evidence that nothing was written. */
function observationCount(store: SqliteEventStore): number {
  return store.readEventsByTypeAfter(OBSERVATION_EVENT_TYPE, 0n, 100).items.length;
}

function observationsComplete(store: SqliteEventStore): boolean {
  return store.readEventsByTypeAfter(OBSERVATION_EVENT_TYPE, 0n, 100).items
    .every((event) => event.eventId.length > 0 && event.payload.byteLength > 0);
}

export interface SafeBoundaryOutcome {
  readonly durableComplete: boolean;
  readonly durableRecords: number;
  readonly refusal: unknown;
  /** What production RECORDED on the arm that wrote, read back off its own answer. */
  readonly recorded?: Readonly<{ reasonCode: unknown; safeBoundaryObserved: unknown }>;
  readonly upstreamCode?: unknown;
}

const upstreamOf = (refusal: unknown): unknown =>
  typeof refusal === "object" && refusal !== null
    ? (refusal as Record<string, unknown>)["upstreamCode"]
    : undefined;

/**
 * BEFORE — the hostile input this boundary exists for, refused before any durable authority
 * is consulted. The caller smuggles the one field an agent must never supply: its own
 * `safeBoundaryObserved` claim. The writer admits an EXACT key set, so the claim is REFUSED
 * rather than ignored — a dropped claim is indistinguishable from an honoured one at the
 * call site. Nothing is seeded: reaching the store at all would already be the defect.
 */
export function safeBoundaryBefore(): SafeBoundaryOutcome {
  const { store } = openBoundaryStore("before");
  const refusal = recordSafeBoundaryObservation(store, {
    ...inputFor("before"), safeBoundaryObserved: true,
  });
  return {
    durableComplete: observationsComplete(store), durableRecords: observationCount(store),
    refusal, upstreamCode: upstreamOf(refusal),
  };
}

/**
 * AFTER — a REAL observation committed through production, then claimed by another project.
 * Every earlier layer admits: the activation binds, the run decodes, the write lands. Only
 * the read-side project check can answer, and it answers ABSENT rather than handing the
 * record over: a durable fact about one project is not evidence for another.
 */
export function safeBoundaryAfter(): SafeBoundaryOutcome {
  const { store } = openBoundaryStore("after");
  seedRun(store, "after", variantRecord("after", "unobserved"));
  const written = recordSafeBoundaryObservation(store, inputFor("after"));
  if (!written.ok) throw new Error(`the lawful write this arm builds on refused: ${written.code}`);
  const refusal = readSafeBoundaryObservation(store, {
    observationRef: written.observation.observationRef, projectId: `${PROJECT_ID}-rival`,
  });
  return {
    durableComplete: observationsComplete(store), durableRecords: observationCount(store),
    recorded: Object.freeze({
      reasonCode: written.observation.reasonCode,
      safeBoundaryObserved: written.observation.safeBoundaryObserved,
    }),
    refusal, upstreamCode: upstreamOf(refusal),
  };
}

export interface SafeBoundaryRaceOutcome extends SafeBoundaryOutcome {
  readonly admittedSides: number;
  readonly sides: readonly [unknown, unknown];
}

/**
 * RACE — two independent callers, on two independent connections to one durable file,
 * deriving the SAME observation identity from the SAME durable run. The identity is a pure
 * function of the durable facts, so both land on one aggregate at `expectedVersion 0` and
 * exactly one may commit. The loser is refused with this layer's own COMMIT_CONFLICT rather
 * than a store code: flattening it would erase which authority answered.
 *
 * The two callers are NOT identical — different command ids, so the store cannot answer the
 * second as an idempotent replay of the first. That distinction is the whole race: a replay
 * would report success to both and prove nothing about exclusivity.
 */
export function safeBoundaryRace(): SafeBoundaryRaceOutcome {
  const { path, store } = openBoundaryStore("race");
  seedRun(store, "race", observedRecord("race"));
  const rival = openSecondConnection(path);
  const sides = [
    recordSafeBoundaryObservation(store, inputFor("race-left")),
    recordSafeBoundaryObservation(rival, inputFor("race-right")),
  ] as const;
  const refused = sides.filter((side) => !side.ok);
  return {
    admittedSides: sides.filter((side) => side.ok).length,
    durableComplete: observationsComplete(store), durableRecords: observationCount(store),
    refusal: refused[0], sides, upstreamCode: upstreamOf(refused[0]),
  };
}

export interface ReasonProof {
  readonly arrangement: string;
  readonly observed: unknown;
  readonly reasonCode: unknown;
}

/**
 * THE REASON SWEEP — the four ways a PRESENT record still fails to prove the crossing, each
 * arranged by breaking one clause. It is a positive control, not a refusal: these all WRITE,
 * and a durable `false` naming its clause is a fact the release path needs. The `unobserved`
 * variant is the subtle one — `{kind: "UNOBSERVED"}` is non-null, so an `exit !== null`
 * predicate answers TRUE on the one value that denies observation.
 */
export function safeBoundaryReasonSweep(): readonly ReasonProof[] {
  return REASON_VARIANTS.map(({ arrangement, slug }) => {
    const { store } = openBoundaryStore(`reason-${slug}`);
    try {
      seedRun(store, slug, variantRecord(slug));
      const written = recordSafeBoundaryObservation(store, inputFor(slug));
      if (!written.ok) throw new Error(`reason variant ${slug} refused: ${written.code}`);
      return {
        arrangement,
        observed: written.observation.safeBoundaryObserved,
        reasonCode: written.observation.reasonCode,
      };
    } finally {
      closeNow(store);
    }
  });
}

/** The TRUE control. Every arm above is a refusal or a recorded `false`, and a predicate that
 *  answers false to everything explains all of them equally well while holding no rule. */
export function safeBoundaryObservedControl(): ReasonProof {
  const { store } = openBoundaryStore("control");
  try {
    seedRun(store, "control", observedRecord("control"));
    const written = recordSafeBoundaryObservation(store, inputFor("control"));
    if (!written.ok) throw new Error(`the observed control refused: ${written.code}`);
    return {
      arrangement: "a run the host saw cross its boundary",
      observed: written.observation.safeBoundaryObserved,
      reasonCode: written.observation.reasonCode,
    };
  } finally {
    closeNow(store);
  }
}
