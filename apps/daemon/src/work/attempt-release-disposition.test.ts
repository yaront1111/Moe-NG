import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DRAIN_REASONS } from "@moe/runner";
import type { ProviderFactUnknown, ProviderRunRef } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { encodeActivationLedgerRecord } from "../activation/activation-ledger-codec.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { commitActivationLedgerRecord } from "../activation/activation-ledger-commit.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { runJournalAppendCommand } from "../journal/journal-append.js";
import {
  JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_SCHEMA_VERSION,
  deriveAttemptJournalAggregateId,
} from "../journal/journal-contracts.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject, trackHarnessRoot,
} from "../recovery/restore-test-harness.js";
import {
  PROVIDER_RUN_RECORD_VERSION, deriveProviderRunAggregateId,
} from "../telemetry/provider-run-contracts.js";
import type { ProviderRunRecord } from "../telemetry/provider-run-contracts.js";
import { commitProviderRunRecord } from "../telemetry/provider-run-ledger.js";
import {
  ATTEMPT_RELEASE_CODES, ATTEMPT_RELEASE_COMMAND_KIND, ATTEMPT_RELEASE_EVENT_TYPE,
  ATTEMPT_RELEASE_RECORD_VERSION, DAEMON_ATTEMPT_RELEASE, SCHEDULER_LEASE_DRAIN,
  SCHEDULER_PROVIDER_SLOT_RELEASE, deriveAttemptReleaseAggregateId, readAttemptRelease,
  recordAttemptRelease,
} from "./attempt-release-disposition.js";
import type { AttemptReleaseOutcome, AttemptReleaseRequest } from "./attempt-release-disposition.js";
import { deriveHandoffBinding } from "./attempt-release-handoff.js";
import {
  ATTEMPT_RELEASE_RESOURCE_FENCE_CODES,
} from "./attempt-release-resource-fence.js";
import { deriveReleaseTerminal } from "./attempt-release-terminal.js";
import {
  ATTEMPT_RESOURCE_BOUND_EVENT_TYPE, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
  applyAttemptResourceReport, bindAttemptResources, deriveAttemptResourceAggregateId,
  readAttemptResources,
} from "./attempt-resource-authority.js";
import {
  EFFECT_TERMINAL_EVENT_TYPE, deriveTerminalEffectAggregateId, recordTerminalEffect,
} from "./effect-terminal-ledger.js";
import {
  deriveDispatchAggregateId, encodeFoundationPayload,
} from "./foundation-attempt-codec.js";
import { buildReleaseHandoff } from "./release-handoff-builder.js";
import { deriveReleaseHandoffAggregateId } from "./release-handoff-binding.js";
import {
  HANDOFF_LAUNCH_SELECTION, handoffJournalEntry, seedReleaseHandoffSources,
} from "./release-handoff-test-harness.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import {
  RELEASE_TERMINAL_CODES, deriveReleaseTerminalEvidence,
} from "./release-terminal-evidence.js";
import { runResourceReconcileCommand } from "./resource-reconcile-command.js";
import { deriveAttemptStepAggregateId } from "./step-lifecycle-contracts.js";
import { SAFE_BOUNDARY_OBSERVATION_LAYER } from "./safe-boundary-observation.js";

/**
 * The attempt-level release disposition, over a REAL SqliteEventStore, a REAL
 * activation committed by the production ingress, and the REAL `releaseWork`
 * kernel reached through the bare `@moe/scheduler` root.
 *
 * NOTHING HERE HAND-FORGES AN ACTIVATION. `parseActivationGrant` demands a hex64
 * grantId derived from the whole successor intent, so the only coherent
 * activation is the one `runEffectActivateCommand` commits — which is also what
 * makes the durable lease and provider-slot facts below genuinely durable rather
 * than a fixture this suite wrote and then read back.
 *
 * TWO LAYERS CAN REFUSE THIS PATH, so every refusal case asserts WHICH one said
 * no as well as the exact code, and that NO durable row exists afterwards. A
 * handler that wrote a row and then refused sails through a return-value
 * assertion, and a daemon code standing in for a kernel refusal hides the fact
 * that the daemon no longer judges dispositions at all.
 */

const encoder = new TextEncoder();

afterEach(cleanupRestoreHarnesses);

const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const SESSION_ID = "session-1";
const NODE_KEY = "dev-done";
/** The attempt the activation below commits; both producers read by it. */
const ATTEMPT_REF = "attempt-1";
/** The terminality producer keeps its layer constant module-private on purpose —
 *  an exported column-zero `*_LAYER` is a declared boundary the security roster
 *  then demands a hostile trio for. Every case below still grades the carrier
 *  against the PRODUCER'S OWN answer for the same store; this literal only pins
 *  that answer to a name, so neither side is merely echoing the other. */
const RELEASE_TERMINAL_EVIDENCE = "RELEASE_TERMINAL_EVIDENCE";

const LEASE_RECORD = {
  authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT", leaseId: "lease-1",
  leaseToken: "token-1", monotonicObservation: 500, ownerSessionRef: SESSION_ID,
  serverWallDeadline: 1_000, state: "ACTIVE", version: 7,
} as const;
const LEASE_PROOF = {
  authorityHashRef: DIGEST, epoch: 3, expectedVersion: 7, leaseToken: "token-1",
  ownerSessionRef: SESSION_ID,
} as const;
const RESOURCE_ROW = {
  capacityUnits: 1, effectIntentRef: "intent-ref-1", epoch: 1, external: false, fenceable: true,
  resourceId: "res-1", state: "ACTIVE",
} as const;
const EFFECT_INTENT = {
  aggregateId: "agg-1", desiredState: "ACTIVE", expectedGraphEpoch: 4, idempotencyKey: "idem-1",
  inputBinding: DIGEST, intentId: "intent-1", leaseBinding: LEASE_RECORD,
  predecessorCursor: "cursor-1", protocolVersion: "moe-effect-intent/1",
  runtimeObservationDigest: DIGEST, state: "PENDING", version: 0,
} as const;
const CLAIM = {
  claimId: "claim-1", claimedAt: DECIDED_AT, intentId: "intent-1", lockIdentity: "lock-1",
  wrapperIdentity: "wrapper-1",
} as const;
const ACTIVATION_SECTION = {
  attempt: {
    aggregateId: "agg-1", attemptId: ATTEMPT_REF, intentId: "intent-1",
    state: "LAUNCH_REQUESTED", version: 0,
  },
  claim: CLAIM, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: LEASE_PROOF,
  lockIdentity: "lock-1", observedGraphEpoch: 4, observedRuntimeDigest: DIGEST, tombstone: null,
  wrapperIdentity: "wrapper-1",
} as const;

const ACTIVATION_AGGREGATE = deriveActivationAggregateId(
  EFFECT_INTENT.aggregateId, EFFECT_INTENT.idempotencyKey);

/** The slot rows the ingress binds. PARAMETERISED for exactly one case: an
 *  activation that declares NO resource, which is the only honest production
 *  route to a durably ABSENT set — `bindActivationResources` discards its bind
 *  refusal by design, and the reader then answers ATTEMPT_RESOURCE_RECORD_ABSENT. */
function activationBytes(rows: readonly unknown[] = [RESOURCE_ROW]): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId: "cmd-release-1", correlationId: "corr-release", decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: structuredClone({
      activation: ACTIVATION_SECTION,
      effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
      lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: { dimension: "default", requestId: "req-1", rows, slotRef: "slot-1" },
    }),
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

interface Fixture {
  readonly bound: FoundationAttemptBound;
  readonly record: ActivationLedgerRecord;
  readonly store: SqliteEventStore;
}

/**
 * WHAT THE HOST SAW, or the absence of it. `safeBoundaryObserved` has a durable
 * producer now (task-ded026d6), so the boundary a release records is DERIVED from
 * a committed provider-run record instead of relayed from this suite.
 *
 * `OBSERVED` satisfies every clause of that producer's predicate. `UNOBSERVED`
 * keeps a PROVEN, classified, completed run and denies ONLY the exit — the
 * `{kind:"UNOBSERVED"}` arm whose entire meaning is that the host never saw the
 * process cross its boundary. Denying the exit rather than the end keeps a real
 * `completedAt` on the record, so the derivation answers `false` on its own merits
 * rather than because no durable instant could be found.
 */
type BoundaryEvidence = "ABSENT" | "OBSERVED" | "UNOBSERVED";

const blindFact: ProviderFactUnknown = Object.freeze({
  known: false, code: "TELEMETRY_USAGE_ABSENT", layer: "TELEMETRY_RESULT",
});

function runRecord(ref: ProviderRunRef, evidence: "OBSERVED" | "UNOBSERVED"): ProviderRunRecord {
  const observed = evidence === "OBSERVED";
  return {
    concurrency: { achieved: blindFact, declaredCeiling: blindFact, fact: "NO_CONCURRENCY_FACTS" },
    declared: { known: true, selection: HANDOFF_LAUNCH_SELECTION },
    infrastructure: observed ? "NONE" : "EXIT_UNOBSERVED",
    launch: {
      activationDigest: null, completedAt: DECIDED_AT, effectDigest: null,
      exit: observed ? { code: 0, kind: "EXITED" } : { kind: "UNOBSERVED" },
      freshRuntimeDigest: null, kind: "OBSERVED", observationDigest: null,
      pinnedClosureDigest: null, quotedRuntimeDigest: null, reasonCode: null, reasonLayer: null,
      runtimeBindingDigest: null, startedAt: DECIDED_AT, truthClass: "PROVEN",
    },
    observedEnd: null,
    observedModel: { modelId: blindFact, snapshotEvidence: blindFact, snapshotKind: "UNKNOWN" },
    observedStart: { bootId: "boot-1", monotonicObservation: 12, serverWallSeconds: 1_700_000_000 },
    providerRunRef: ref,
    recordDigest: "",
    recordVersion: PROVIDER_RUN_RECORD_VERSION,
    sequence: { known: true, value: 3 },
    steps: { coverage: "UNKNOWN", turns: blindFact },
    stderrReceiptDigest: { known: true, value: "stderr-release" },
    stdoutReceiptDigest: { known: true, value: "stdout-release" },
    terminal: "COMPLETED",
    tokens: {
      cacheCreationInputTokens: blindFact, cacheReadInputTokens: blindFact, coverage: "UNKNOWN",
      inputTokens: blindFact, outputTokens: blindFact,
    },
    upstreamRefusal: null, usage: [], usageRefusals: [],
  };
}

/**
 * The run committed through the PRODUCTION ledger writer, with its ref read out
 * of the durable activation binding rather than hand-guessed: the run reader
 * cross-checks `effectIntentId` and `epoch` against that binding, and the commit
 * key's principal must be the lease's own owner session.
 */
function seedProviderRun(
  store: SqliteEventStore, label: string, evidence: "OBSERVED" | "UNOBSERVED",
): void {
  const binding = readFoundationActivationByAttempt(store, PROJECT_ID, ATTEMPT_REF);
  if (binding.status !== "BOUND") throw new Error(`attempt unbound: ${binding.status}/${binding.code}`);
  const outcome = commitProviderRunRecord(store, {
    correlationId: `corr-run-${label}`, decidedAt: DECIDED_AT,
    key: {
      commandId: `cmd-run-${label}`, principalId: binding.ownerSessionRef, projectId: PROJECT_ID,
    },
    record: runRecord({
      attemptRef: binding.attemptId, effectIntentId: binding.effectIntentId, epoch: binding.epoch,
      provider: "claude", runRef: `run-${label}`,
    }, evidence),
    requestBytes: encoder.encode(`provider-run-request-${label}`),
  });
  if (!outcome.ok) throw new Error(`provider run refused: ${outcome.code} at ${outcome.layer}`);
}

/**
 * WHAT THE DURABLE LEDGERS SAY ABOUT THIS ATTEMPT'S ITEMS. `effectsTerminal` and
 * `resourcesTerminal` have a durable producer now (task-6d400781), so a release
 * DERIVES both from these ledgers instead of relaying a caller's literal — and
 * the two families are driven INDEPENDENTLY here, so a case can make exactly one
 * of them answer false.
 */
interface Terminality {
  readonly effects: boolean;
  readonly resources: boolean;
}
/** Both families terminal: what every pre-existing RELEASED case assumed back
 *  when the flags were caller inputs pinned true. */
const SETTLED: Terminality = Object.freeze({ effects: true, resources: true });
/** No terminal effect record yet — a readable durable NO, not an unknown. */
const EFFECTS_PENDING: Terminality = Object.freeze({ effects: false, resources: true });
/** The resource set left ACTIVE, which the scheduler's own reducers still move. */
const RESOURCES_PENDING: Terminality = Object.freeze({ effects: true, resources: false });
/**
 * MEASURED, NOT CHOSEN. An `UNOBSERVED` run cannot carry a terminal effect at
 * all: the ledger PROJECTS its settlement from the durable run, and a run whose
 * exit the host never saw settles to nothing — `recordTerminalEffect` answers
 * EFFECT_TERMINAL_NOT_PROVEN. So every unobserved-boundary fixture is necessarily
 * accompanied by a pending effect, and `activated` THROWS rather than silently
 * seeding less than it was asked for if a case forgets.
 */
const UNOBSERVED_TERMINALITY: Terminality = EFFECTS_PENDING;

/** The terminal effect through the ledger's OWN writer, which derives the intent
 *  id from the activation's single effect intent — so nothing here can name an
 *  intent the binding does not carry. It is a PROJECTION of the durable provider
 *  run, which is why an attempt with no run cannot have one. */
function terminaliseEffect(store: SqliteEventStore, label = "attempt"): void {
  const outcome = recordTerminalEffect(store, {
    attemptRef: ATTEMPT_REF, projectId: PROJECT_ID,
  });
  if (!outcome.ok) throw new Error(`terminal effect refused for ${label}: ${outcome.code}`);
}

/** A FAILED report on the only (fenceable) member, which is what drives the set
 *  out of ACTIVE. The RESULTING state is the scheduler reducer's to decide — this
 *  fixture never names one, exactly as the producer never declares one. */
function terminaliseResources(store: SqliteEventStore, label: string): void {
  const outcome = applyAttemptResourceReport(store, {
    activationAggregateId: ACTIVATION_AGGREGATE, commandId: `cmd-resources-${label}`,
    correlationId: `corr-resources-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
  }, { disposition: "FAILED", epoch: 1, kind: "FAIL", resourceId: RESOURCE_ROW.resourceId });
  if (!outcome.ok) throw new Error(`resource report refused: ${outcome.code}`);
}

/** THROWS rather than seeding less than it was asked for: a fixture that quietly
 *  skipped a writer would make a derived-false case pass for the wrong reason. */
function seedTerminality(
  store: SqliteEventStore, label: string, terminality: Terminality,
): void {
  if (terminality.effects) terminaliseEffect(store, label);
  if (terminality.resources) terminaliseResources(store, label);
}

/** A committed activation, read BACK from the store rather than kept from the
 *  command result, so the record this suite calls "durable" really is. */
function activated(
  label: string, evidence: BoundaryEvidence = "OBSERVED", terminality: Terminality = SETTLED,
  rows: readonly unknown[] = [RESOURCE_ROW],
): Fixture {
  const root = trackHarnessRoot(mkdtempSync(join(tmpdir(), `moe-release-${label}-`)));
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  const outcome = runEffectActivateCommand(store, activationBytes(rows));
  if (!outcome.ok) throw new Error(`activation refused: ${outcome.code}`);
  if (evidence !== "ABSENT") seedProviderRun(store, label, evidence);
  seedTerminality(store, label, terminality);
  const history = readFoundationActivationHistory(
    ACTIVATION_AGGREGATE, store.readEvents(ACTIVATION_AGGREGATE), PROJECT_ID);
  if (!history.ok) throw new Error(`activation unreadable: ${history.result.status}`);
  const bound: FoundationAttemptBound = Object.freeze({
    aggregateId: ACTIVATION_AGGREGATE, claim: CLAIM, commandId: "cmd-release-1",
    correlationId: "corr-release", nodeKey: NODE_KEY, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, sessionId: SESSION_ID,
    // THE DISPATCH AGGREGATE, exactly as the production release path binds it:
    // `selectAttempt` (./attempt-finalization-sources.ts) sets
    // `target: deriveDispatchAggregateId(attemptAggregateId)`. It used to be the
    // RELEASE aggregate here, which no production caller ever produces — nothing on
    // this path read `bound.target`, so the inaccuracy was invisible. task-06835dfa
    // fences the dispatch stream as a decision leg BESIDE the release primary, and
    // two legs may not name the same aggregate (the store refuses a duplicate with
    // STORE_INPUT_INVALID), so the fixture now has to say what production says.
    target: deriveDispatchAggregateId(ACTIVATION_AGGREGATE),
  });
  const record = history.history.record;
  // THE FIVE HANDOFF SOURCES, seeded because task-a20e8ef6 made the scheduler
  // checkpoint SERVER-BUILT. This suite used to hand `releaseWork` a literal
  // `HANDOFF`; a caller can no longer speak one, so an attempt that never wrote a
  // step record, journal, capture context, context manifest or artifact roster now
  // has no releasable checkpoint at all — which is the correct fail-closed answer
  // and is asserted directly in `release-handoff-builder.test.ts`. Seeding them
  // here keeps every arm below testing the release behaviour it was written for.
  seedReleaseHandoffSources(store, {
    activationDigest: record.activationDigest, attemptAggregateId: ACTIVATION_AGGREGATE,
    attemptRef: record.attempt.attemptId, effectId: record.effectIntent.intentId,
    leaseRef: record.lease.leaseId, nodeKey: NODE_KEY, projectId: PROJECT_ID,
    sessionId: SESSION_ID,
  }, { providerRun: evidence !== "ABSENT" });
  return { bound, record, store };
}

/** The handoff the kernel demands before it will compose ANY transition: five
 *  digest families, a next safe action and a truth class. Its durable producer
 *  is task-af9454f4, so this suite supplies it as an INPUT. */
const HANDOFF = Object.freeze({
  activeProcessResourceFacts: Object.freeze([]),
  artifactDigest: DIGEST, completedSteps: Object.freeze(["step:1"]), contextDigest: DIGEST,
  inputDigest: DIGEST, journalDigest: DIGEST, nextSafeAction: "action:resume",
  truthClass: "DAEMON_VERIFIED", worktreeDigest: DIGEST,
});

/**
 * WHAT A RELEASE MAY STILL SAY: four keys, and not one of them is a terminality
 * fact.
 *
 * ALL THREE settle facts now have durable producers, so none of them has a key
 * here at all — `safeBoundaryObserved` was retired by task-78f38281 against
 * task-ded026d6's producer, and `effectsTerminal`/`resourcesTerminal` are retired
 * by THIS row against task-6d400781's. Each is DERIVED from what the host and the
 * ledgers durably recorded, and a request carrying one is refused rather than
 * obeyed. A caller may still say WHICH attempt is released and why; it may no
 * longer say that the release was safe.
 */
const settledRequest = (
  overrides: Partial<AttemptReleaseRequest> = {},
): AttemptReleaseRequest => ({
  disposition: null, intentRefs: ["intent:release"],
  reason: "WORK_RELEASE_OR_PAUSE",
  ...overrides,
});

/** EVERY key a caller may no longer speak, named once so the admission sweeps and
 *  the emptiness assertion cannot drift apart. `handoff` joined the list in
 *  task-a20e8ef6, when the nine-key scheduler checkpoint became server-built. */
const RETIRED_KEYS: readonly string[] = Object.freeze([
  "effectsTerminal", "handoff", "resourcesTerminal", "safeBoundaryObserved",
]);

/** A request carrying a retired key, built OUTSIDE the narrowed type because the
 *  type is exactly what stops an honest caller from composing one. */
const withRetiredKey = (key: string, value: unknown): AttemptReleaseRequest =>
  ({ ...settledRequest(), [key]: value }) as AttemptReleaseRequest;
const withBoundaryKey = (value: unknown): AttemptReleaseRequest =>
  withRetiredKey("safeBoundaryObserved", value);

function refusalOf(
  outcome: AttemptReleaseOutcome,
): { code: string; refusedBy: string } {
  if (outcome.ok) throw new Error("expected a refusal, received a recorded row");
  return { code: outcome.code, refusedBy: outcome.refusedBy };
}

function rowOf(outcome: AttemptReleaseOutcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`expected a recorded row, refused with ${outcome.code}`);
  return outcome.record;
}

/** Every refusal must leave the aggregate EMPTY. Read through the module's own
 *  reader, so a row written and then refused cannot hide behind a return value. */
function expectNoDurableRow(fixture: Fixture): void {
  const stored = readAttemptRelease(fixture.store, fixture.bound.aggregateId);
  expect(refusalOf(stored)).toEqual({
    code: "ATTEMPT_RELEASE_RECORD_ABSENT", refusedBy: DAEMON_ATTEMPT_RELEASE,
  });
}

/** Counts the rows OUT OF THE STORE rather than trusting a return value: "it did
 *  not throw the second time" is also exactly what a double write looks like. */
function durableRowCount(fixture: Fixture): number {
  return fixture.store.readEvents(deriveAttemptReleaseAggregateId(fixture.bound.aggregateId))
    .filter((event) => event.eventType === ATTEMPT_RELEASE_EVENT_TYPE).length;
}

/** The DECISIONS landed on the release aggregate, paged out of the store. A row
 *  count alone cannot see a decision committed with no event, and "zero release
 *  rows AND zero decisions" is what an all-or-none refusal has to mean. */
function releaseDecisionCount(fixture: Fixture): number {
  const target = deriveAttemptReleaseAggregateId(fixture.bound.aggregateId);
  let counted = 0;
  for (let cursor = 0n; ; ) {
    const page = fixture.store.readCommandDecisionsAfter(cursor, 100);
    counted += page.items.filter((item) => item.targetAggregateId === target).length;
    if (!page.hasMore || page.nextCursor === null) return counted;
    cursor = page.nextCursor;
  }
}

describe("attempt release disposition — frozen vocabulary", () => {
  it("publishes a closed code list with no duplicate member", () => {
    expect(ATTEMPT_RELEASE_CODES.length).toBeGreaterThan(0);
    expect(new Set(ATTEMPT_RELEASE_CODES).size).toBe(ATTEMPT_RELEASE_CODES.length);
    // Eight, not twelve. The five disposition and drain-reason codes were retired
    // with the daemon-side validator that raised them: `releaseWork` owns that
    // judgement now and refuses in its own words, under its own layer. The eighth
    // is REQUEST_MALFORMED, and it is a DAEMON code because the exact-record
    // admission is this module's own decision, taken before any kernel is reached.
    expect([...ATTEMPT_RELEASE_CODES].sort()).toEqual([
      "ATTEMPT_RELEASE_ACTIVATION_UNREADABLE", "ATTEMPT_RELEASE_BINDING_MISMATCH",
      "ATTEMPT_RELEASE_COMMIT_UNAVAILABLE", "ATTEMPT_RELEASE_RECORD_ABSENT",
      "ATTEMPT_RELEASE_RECORD_AMBIGUOUS", "ATTEMPT_RELEASE_RECORD_DRIFT",
      "ATTEMPT_RELEASE_RECORD_UNREADABLE", "ATTEMPT_RELEASE_REQUEST_MALFORMED",
    ].sort());
    for (const retired of ["ATTEMPT_RELEASE_REASON_UNKNOWN", "ATTEMPT_RELEASE_REASON_NOT_UNIONED",
      "ATTEMPT_RELEASE_DISPOSITION_MALFORMED", "ATTEMPT_RELEASE_DISPOSITION_DOWNGRADED",
      "ATTEMPT_RELEASE_TARGET_MISMATCH"]) {
      expect([...ATTEMPT_RELEASE_CODES]).not.toContain(retired);
    }
  });

  it("adds NO daemon code for the slot or BOUNDARY layers, which carry their own", () => {
    // The roster gained exactly ONE member and no more. `releaseProviderSlot`
    // refuses in the scheduler's words and the safe-boundary producer in its own,
    // so a daemon member for either would be a dead entry that no path raises and
    // that still reads as coverage. All four carried codes are asserted ABSENT.
    expect(ATTEMPT_RELEASE_CODES.length).toBe(8);
    for (const carried of ["AUTHORITY_MALFORMED_INPUT", "AUTHORITY_STALE_LEASE",
      "SAFE_BOUNDARY_RUN_UNREADABLE", "SAFE_BOUNDARY_INPUT_MALFORMED"]) {
      expect([...ATTEMPT_RELEASE_CODES]).not.toContain(carried);
    }
  });

  it("names all FOUR refusing layers, disjoint from the sibling dispatch layer", () => {
    expect(DAEMON_ATTEMPT_RELEASE).toBe("DAEMON_ATTEMPT_RELEASE");
    expect(SCHEDULER_LEASE_DRAIN).toBe("SCHEDULER_LEASE_DRAIN");
    expect(SCHEDULER_PROVIDER_SLOT_RELEASE).toBe("SCHEDULER_PROVIDER_SLOT_RELEASE");
    expect(SAFE_BOUNDARY_OBSERVATION_LAYER).toBe("DAEMON_SAFE_BOUNDARY_OBSERVATION");
    // Pairwise distinct, by hand. Two kernels refuse this path out of ONE
    // two-member code vocabulary, so the layer is the only thing that can tell a
    // slot that will not release from a lease that could not be fenced — and
    // DoD 3's "never restamped as a lease-drain refusal" rests on it. The safe
    // boundary producer is the FOURTH, and it is a layer for the same reason:
    // "the host never recorded a run" is not "this daemon composed a bad row".
    const layers = [
      DAEMON_ATTEMPT_RELEASE, SCHEDULER_LEASE_DRAIN, SCHEDULER_PROVIDER_SLOT_RELEASE,
      SAFE_BOUNDARY_OBSERVATION_LAYER,
    ];
    expect(new Set(layers).size).toBe(4);
    expect(SCHEDULER_PROVIDER_SLOT_RELEASE).not.toBe(SCHEDULER_LEASE_DRAIN);
    expect(SCHEDULER_PROVIDER_SLOT_RELEASE).not.toBe(DAEMON_ATTEMPT_RELEASE);
    expect(DAEMON_ATTEMPT_RELEASE).not.toBe(SCHEDULER_LEASE_DRAIN);
    expect(SAFE_BOUNDARY_OBSERVATION_LAYER).not.toBe(DAEMON_ATTEMPT_RELEASE);
    expect(DAEMON_ATTEMPT_RELEASE).not.toBe("DAEMON_FOUNDATION_ATTEMPT");
    expect([ATTEMPT_RELEASE_RECORD_VERSION, ATTEMPT_RELEASE_EVENT_TYPE,
      ATTEMPT_RELEASE_COMMAND_KIND]).toEqual(
      ["moe-attempt-release-record/1", "AttemptReleaseRecorded", "work.attempt_release"]);
  });

  it("derives a release aggregate distinct from the activation it reads", () => {
    const derived = deriveAttemptReleaseAggregateId(ACTIVATION_AGGREGATE);
    expect(derived).not.toBe(ACTIVATION_AGGREGATE);
    expect(derived).toBe(deriveAttemptReleaseAggregateId(ACTIVATION_AGGREGATE));
    expect(derived).not.toBe(deriveAttemptReleaseAggregateId(`${ACTIVATION_AGGREGATE}x`));
  });
});

describe("attempt release disposition — the kernel refuses, the daemon carries", () => {
  it("carries the KERNEL's refusal for a disposition it will not compose", () => {
    const fixture = activated("malformed");
    const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ disposition: { reasons: [], strongestReason: "WORK_RELEASE_OR_PAUSE" } }));
    // The layer is the discriminator: a DAEMON_ATTEMPT_RELEASE code here would
    // mean the daemon kept a second disposition validator of its own.
    expect(refusalOf(outcome)).toEqual({
      code: "AUTHORITY_MALFORMED_INPUT", refusedBy: SCHEDULER_LEASE_DRAIN,
    });
    expectNoDurableRow(fixture);
  });

  it("carries the KERNEL's refusal for a DOWNGRADED strongest reason", () => {
    const fixture = activated("downgraded");
    // URGENT_REVOKE is rank 70 and sits in the set, so WORK_RELEASE_OR_PAUSE
    // (rank 20) cannot honestly be the strongest one.
    const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ disposition: {
        reasons: ["URGENT_REVOKE", "WORK_RELEASE_OR_PAUSE"], resumable: true,
        strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
      } }));
    expect(refusalOf(outcome)).toEqual({
      code: "AUTHORITY_MALFORMED_INPUT", refusedBy: SCHEDULER_LEASE_DRAIN,
    });
    expectNoDurableRow(fixture);
  });

  it("refuses a reason the frozen drain vocabulary does not declare", () => {
    const fixture = activated("unknown-reason");
    const unknown = "WORK_RELEASE_OR_RESUME";
    // The case cannot go vacuous the day the vocabulary grows: if this string
    // ever became a real reason, THIS assertion fails before the refusal does.
    expect([...DRAIN_REASONS]).not.toContain(unknown);
    const outcome = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest({ reason: unknown }));
    expect(refusalOf(outcome)).toEqual({
      code: "AUTHORITY_MALFORMED_INPUT", refusedBy: SCHEDULER_LEASE_DRAIN,
    });
    expectNoDurableRow(fixture);
  });

  it("refuses a caller-spoken handoff at the DAEMON, above the kernel", () => {
    const fixture = activated("handoff");
    // THE LAYER MOVED, and that IS the deliverable of task-a20e8ef6. These three
    // shapes used to reach `releaseWork` and come back AUTHORITY_MALFORMED_INPUT @
    // SCHEDULER_LEASE_DRAIN. The checkpoint is server-built now, so a request that
    // merely SPELLS the key is a request fault, refused by this daemon's own
    // admission before any store read — including the well-formed value, because
    // agreement with the server is not authority over it.
    const spoken: readonly unknown[] =
      [null, { ...HANDOFF }, { ...HANDOFF, inputDigest: "not-a-digest" }];
    expect(spoken).toHaveLength(3);
    for (const handoff of spoken) {
      const outcome = recordAttemptRelease(
        fixture.store, fixture.bound, fixture.record,
        { ...settledRequest(), handoff } as AttemptReleaseRequest);
      expect(refusalOf(outcome)).toEqual({
        code: "ATTEMPT_RELEASE_REQUEST_MALFORMED", refusedBy: DAEMON_ATTEMPT_RELEASE,
      });
    }
    expectNoDurableRow(fixture);
  });

  it("has NO omitted-flag arm left, because no terminality fact is relayed", () => {
    // THE SWEEP DROPPED 2 -> 0. A sweep of zero arms passes vacuously forever, so
    // the drop is asserted against THE REQUEST ITSELF rather than against a list
    // this file maintains: a relay that came back would be a key on the request,
    // and an empty intersection is the only honest form of "nothing left to omit".
    const relayed = Object.keys(settledRequest()).filter((key) => RETIRED_KEYS.includes(key));
    expect(relayed).toEqual([]);
    // EXACT, not a subset: the THREE keys still the caller's to speak, so a fourth
    // arriving later cannot hide inside a containment check. It was four until
    // task-a20e8ef6 server-built the scheduler checkpoint and took `handoff` away.
    expect(Object.keys(settledRequest()).sort())
      .toEqual(["disposition", "intentRefs", "reason"]);
    // POSITIVE CONTROL. Omitting all three is now the ONLY way to call this
    // function, and it still releases — so the emptiness above is the contract
    // and not a fixture that quietly stopped reaching the kernel.
    const fixture = activated("no-relayed-flags");
    const outcome = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(outcome.ok && outcome.outcome).toBe("RELEASED");
  });

  it("refuses when the durable activation it must read is not there", () => {
    const fixture = activated("no-activation");
    const orphan: FoundationAttemptBound = Object.freeze({
      ...fixture.bound, aggregateId: `${ACTIVATION_AGGREGATE}-absent`,
      target: deriveDispatchAggregateId(`${ACTIVATION_AGGREGATE}-absent`),
    });
    const outcome =
      recordAttemptRelease(fixture.store, orphan, fixture.record, settledRequest());
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_ACTIVATION_UNREADABLE", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expect(refusalOf(readAttemptRelease(fixture.store, orphan.aggregateId)).code)
      .toBe("ATTEMPT_RELEASE_RECORD_ABSENT");
  });

  it("refuses a caller record whose IDENTITY contradicts the committed activation", () => {
    const fixture = activated("identity");
    const forged: ActivationLedgerRecord = {
      ...fixture.record, activationDigest: "f".repeat(64),
    };
    expect(forged.activationDigest).not.toBe(fixture.record.activationDigest);
    const outcome =
      recordAttemptRelease(fixture.store, fixture.bound, forged, settledRequest());
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_BINDING_MISMATCH", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expectNoDurableRow(fixture);
  });
});

/** The observations THIS release composed, paged out of the store by event type
 *  rather than by an aggregate id the suite would have to re-derive. A carrier
 *  that decided the boundary itself instead of composing the producer writes
 *  none of these, and every assertion over them goes red. */
function boundaryObservations(fixture: Fixture): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let cursor = 0n; ; ) {
    const page = fixture.store.readEventsByTypeAfter("SafeBoundaryObserved", cursor, 100);
    for (const event of page.items) {
      rows.push(JSON.parse(new TextDecoder().decode(event.payload)) as Record<string, unknown>);
    }
    if (!page.hasMore || page.nextCursor === null) return rows;
    cursor = page.nextCursor;
  }
}

describe("attempt release disposition — the safe boundary is DERIVED, never relayed", () => {
  it("derives a TRUE boundary from the durable run and releases on it", () => {
    const fixture = activated("derived-true");
    // No boundary key is passed, and none CAN be: the request type has none.
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("RELEASED");
    // The kernel saw a settled boundary — read back out of durable bytes.
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["outcome"], row["attemptState"], row["providerSlotState"], row["releasePending"]])
      .toEqual(["RELEASED", "RELEASED", "RELEASED", false]);
    // And the value came from the PRODUCER, which recorded its own durable
    // observation on the way past. A carrier that answered `true` on its own
    // authority leaves this list empty.
    const observations = boundaryObservations(fixture);
    expect(observations.length).toBe(1);
    expect([observations[0]?.["safeBoundaryObserved"], observations[0]?.["reasonCode"],
      observations[0]?.["attemptRef"]]).toEqual([true, null, ATTEMPT_REF]);
  });

  it("derives a FALSE boundary from an UNOBSERVED exit and drains on it", () => {
    // The run is PROVEN, classified COMPLETED and carries a real `completedAt`;
    // ONLY the exit is `{kind:"UNOBSERVED"}`. Everything the kernel needs to
    // release is present except the one fact that says the host watched the
    // process leave, which is exactly the manufactured-safe-boundary defect.
    const fixture = activated("derived-false", "UNOBSERVED", UNOBSERVED_TERMINALITY);
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("DRAINING");
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["outcome"], row["attemptState"], row["providerSlotState"], row["resumable"]])
      .toEqual(["DRAINING", "DRAINING", "ACTIVE", false]);
    const observations = boundaryObservations(fixture);
    expect(observations.length).toBe(1);
    // The REASON, not merely the false: a derivation that answered false for the
    // wrong clause would still drain, and this is what tells the two apart.
    expect([observations[0]?.["safeBoundaryObserved"], observations[0]?.["reasonCode"]])
      .toEqual([false, "SAFE_BOUNDARY_EXIT_UNOBSERVED"]);
  });

  it("refuses under the PRODUCER's own code and layer when no run was recorded", () => {
    // EFFECTS_PENDING is forced rather than chosen: a terminal effect is a
    // projection of a durable provider run, so an attempt with NO run cannot
    // carry one. The boundary is derived before terminality either way, which is
    // why this case still hears the boundary producer and not the other.
    const fixture = activated("boundary-absent", "ABSENT", EFFECTS_PENDING);
    const outcome = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    // BOTH layers asserted. A daemon code here would mean the carrier had formed
    // its own opinion about an absent run; a flattened message would lose which
    // of the producer's five refusals answered, and they demand different repairs.
    expect(refusalWithMessage(outcome)).toEqual({
      code: "SAFE_BOUNDARY_RUN_UNREADABLE", message: "PROVIDER_RUN_EVIDENCE_ABSENT",
      refusedBy: SAFE_BOUNDARY_OBSERVATION_LAYER,
    });
    // Refused BEFORE the kernel: no release row, no release decision, and the
    // producer recorded nothing either — an unknown never becomes a false.
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    expect(boundaryObservations(fixture)).toEqual([]);
    expectNoDurableRow(fixture);
  });

  it("REFUSES a caller-supplied boundary flag of any shape, never ignoring one", () => {
    // Silently dropping the key would be indistinguishable from honouring it at
    // the call site, so the field is unrepresentable rather than merely unused.
    const values: readonly unknown[] = [true, false, "OBSERVED", null, undefined];
    let driven = 0;
    for (const value of values) {
      const fixture = activated(`spoof-${String(value)}`);
      const outcome = recordAttemptRelease(
        fixture.store, fixture.bound, fixture.record, withBoundaryKey(value));
      expect(refusalOf(outcome), String(value)).toEqual({
        code: "ATTEMPT_RELEASE_REQUEST_MALFORMED", refusedBy: DAEMON_ATTEMPT_RELEASE,
      });
      // The admission runs before ANY store work, so not even an observation lands.
      expect(boundaryObservations(fixture), String(value)).toEqual([]);
      expectNoDurableRow(fixture);
      driven += 1;
    }
    // A sweep that generated nothing would pass every assertion above vacuously.
    expect(driven).toBe(5);
  });

  it("REFUSES a non-object request rather than crashing on the admission", () => {
    // The admission is the first statement of the release path, so it reads a
    // property off whatever it was handed. A raw read would throw on null — and a
    // crash is not a fail-closed refusal, it is an unhandled exception wearing one.
    const fixture = activated("malformed-request");
    let driven = 0;
    for (const shape of [null, undefined, "settled", 7]) {
      const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
        shape as unknown as AttemptReleaseRequest);
      expect(refusalOf(outcome), String(shape)).toEqual({
        code: "ATTEMPT_RELEASE_REQUEST_MALFORMED", refusedBy: DAEMON_ATTEMPT_RELEASE,
      });
      driven += 1;
    }
    expect(driven).toBe(4);
    expectNoDurableRow(fixture);
  });

  it("composes NO second truth when a SECOND releaser runs over the same attempt", () => {
    // Two callers, two command ids, ONE attempt. The observation aggregate is
    // written at expectedVersion 0 and its id is derived from the OBSERVATION, so
    // the second caller lands on the first caller's row.
    //
    // IT RE-DERIVES THAT ROW BYTE FOR BYTE AND REPLAYS ONTO IT (task-48c79a29).
    // The boundary is DERIVED from the durable provider-run record, never claimed
    // by whoever asked, so a second server-side path agreeing with it completely is
    // not borrowing anyone's authority -- and the two production paths that observe
    // one attempt, the dispatch-time release and the post-verification
    // finalization, cannot share a command id. The property this arm exists for is
    // that NO SECOND TRUTH is composed, and it is asserted directly below: one
    // release row, one observation row, and the FIRST release standing unchanged.
    const fixture = activated("second-releaser");
    const first = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(first.ok && first.outcome).toBe("RELEASED");
    const other: FoundationAttemptBound =
      Object.freeze({ ...fixture.bound, commandId: "cmd-release-2" });
    const second = recordAttemptRelease(
      fixture.store, other, fixture.record, settledRequest());
    // The kernel's own answer for a release that already happened.
    expect(second.ok && second.outcome).toBe("NO_OP");
    expect(second.ok && second.record["outcome"]).toBe("RELEASED");
    expect(second.ok && second.digest).toBe(first.ok && first.digest);
    // The first release stands, and no second row was appended over it.
    expect(durableRowCount(fixture)).toBe(1);
    expect(boundaryObservations(fixture).length).toBe(1);
  });

  it("refuses the caller's flag even when it AGREES with the durable observation", () => {
    // The point of the refusal is that the field is unrepresentable, not that it
    // is cross-checked: a carrier that only refused on MISMATCH would still be
    // letting an agreeing caller's flag reach the kernel as authority.
    for (const [evidence, agreeing, terminality] of [
      ["OBSERVED", true, SETTLED], ["UNOBSERVED", false, UNOBSERVED_TERMINALITY],
    ] as const) {
      const fixture = activated(`agreeing-${evidence}`, evidence, terminality);
      const control = recordAttemptRelease(
        fixture.store, fixture.bound, fixture.record, withBoundaryKey(agreeing));
      expect(refusalOf(control), evidence).toEqual({
        code: "ATTEMPT_RELEASE_REQUEST_MALFORMED", refusedBy: DAEMON_ATTEMPT_RELEASE,
      });
      expectNoDurableRow(fixture);
      // POSITIVE CONTROL, in the same store: the identical request WITHOUT the
      // key succeeds and reaches the outcome the durable run implies. Without it
      // the case above could be passing because the fixture was simply broken.
      const honest = recordAttemptRelease(
        fixture.store, fixture.bound, fixture.record, settledRequest());
      expect(honest.ok && honest.outcome, evidence).toBe(agreeing ? "RELEASED" : "DRAINING");
    }
  });
});

/**
 * An UNDECODABLE terminal-effect record, planted on the ledger aggregate this
 * attempt's OWN durable intent derives. PLANTED because no production writer can
 * make one — the ledger's writer encodes through the codec and derives the intent
 * from the activation's single effect intent — and a refusal arm no honest
 * fixture can reach is an arm nothing tests.
 */
function plantUndecodableTerminal(fixture: Fixture): void {
  const binding = readFoundationActivationByAttempt(fixture.store, PROJECT_ID, ATTEMPT_REF);
  if (binding.status !== "BOUND") throw new Error(`attempt unbound: ${binding.status}`);
  const aggregateId = deriveTerminalEffectAggregateId({
    attemptRef: ATTEMPT_REF, intentId: binding.effectIntentId, projectId: PROJECT_ID,
  });
  const payload = encoder.encode("{");
  fixture.store.commitExpectedVersionDecision({
    commandKind: "test.plant_terminal_effect", committedResultBytes: payload,
    correlationId: "plant-terminal", decidedAt: DECIDED_AT,
    events: [{ eventId: "plant-terminal", eventType: EFFECT_TERMINAL_EVENT_TYPE, payload }],
    // MEASURED, not assumed: the honest record already holds version 0 whenever
    // the fixture terminalised the effect, and a wrong expectation would plant
    // nothing at all while every assertion below still read as a pass.
    expectedVersion: fixture.store.readEvents(aggregateId).length,
    key: { commandId: "plant-terminal", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: payload, targetAggregateId: aggregateId,
  });
}

/**
 * TERMINALITY IS DERIVED, and this block asks the same three questions of it that
 * the boundary block above asks of `safeBoundaryObserved`: is the flag derived
 * from durable evidence, is a caller who speaks about it REFUSED rather than
 * ignored, and does an UNKNOWN block the release instead of draining it.
 */
describe("attempt release disposition — terminality is DERIVED, never relayed", () => {
  const selector = Object.freeze({ attemptRef: ATTEMPT_REF, projectId: PROJECT_ID });

  it("releases on the evidence the LEDGERS carry, with no terminality key sent", () => {
    const fixture = activated("terminal-derived-true");
    // THE PRODUCER'S OWN ANSWER for this very store, so the release below is
    // graded against the production surface rather than this file's belief.
    const evidence = deriveReleaseTerminalEvidence(fixture.store, selector);
    expect(evidence.ok && [evidence.effectsTerminal, evidence.resourcesTerminal])
      .toEqual([true, true]);
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    // The kernel ANDs the three settle facts, so RELEASED is reachable ONLY when
    // both derived flags arrived true. Read back from durable bytes, never from
    // the value just returned.
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([written.ok && written.outcome, row["outcome"], row["leaseState"]])
      .toEqual(["RELEASED", "RELEASED", "RELEASED"]);
  });

  it("drains rather than releases when ONE enumerated item is not terminal", () => {
    // Exactly one difference from the case above: no terminal record is durable
    // for the attempt's own effect intent, so the producer answers false for that
    // family and true for the other.
    const fixture = activated("terminal-one-pending", "OBSERVED", EFFECTS_PENDING);
    const evidence = deriveReleaseTerminalEvidence(fixture.store, selector);
    expect(evidence.ok && [evidence.effectsTerminal, evidence.resourcesTerminal])
      .toEqual([false, true]);
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("DRAINING");
  });

  it("BLOCKS on an evidence UNKNOWN, carrying the producer's own code and layer", () => {
    const fixture = activated("terminal-unknown");
    plantUndecodableTerminal(fixture);
    const produced = deriveReleaseTerminalEvidence(fixture.store, selector);
    if (produced.ok) throw new Error("the planted record was still readable");
    // PINNED AT THE PRODUCER: an exact member of its closed vocabulary, never
    // merely "some refusal happened".
    expect(produced.code).toBe("RELEASE_TERMINAL_EFFECT_ENUMERATION_UNREADABLE");
    expect(RELEASE_TERMINAL_CODES).toContain(produced.code);
    expect(produced.layer).toBe(RELEASE_TERMINAL_EVIDENCE);
    const outcome = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    // AND PINNED AT THE CARRIER, against the producer's OWN answer for the same
    // store rather than a literal this file also wrote: an UNKNOWN is carried,
    // never restamped into a daemon code and never collapsed into a false.
    expect(refusalWithMessage(outcome)).toEqual({
      code: produced.code, message: produced.upstream?.code ?? null,
      refusedBy: produced.layer,
    });
    // BEFORE THE KERNEL. An unknown terminality is not an unterminal one: the
    // release must not drain, and no row or decision may exist afterwards.
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    expectNoDurableRow(fixture);
  });

  it("hands the kernel a TWO-key record whose flags are not interchangeable", () => {
    // THE TRANSPOSITION GUARD, and the only place one can exist. `releaseWork`
    // ANDs the three settle facts and the durable row records NEITHER flag, so
    // swapping the two booleans on their way to the kernel changes no outcome and
    // no stored byte — it is invisible at every seam downstream of the derivation.
    // Two things make it catchable rather than unkillable: the pair travels as ONE
    // spread record, so the kernel seam holds no per-key write site to swap at,
    // and the derivation itself is asserted PER FAMILY right here.
    const effectsPending = activated("flags-effects", "OBSERVED", EFFECTS_PENDING);
    const resourcesPending = activated("flags-resources", "OBSERVED", RESOURCES_PENDING);
    const first = deriveReleaseTerminal(
      effectsPending.store, effectsPending.bound, effectsPending.record);
    const second = deriveReleaseTerminal(
      resourcesPending.store, resourcesPending.bound, resourcesPending.record);
    expect(first.ok && first.flags).toEqual({ effectsTerminal: false, resourcesTerminal: true });
    expect(second.ok && second.flags).toEqual({ effectsTerminal: true, resourcesTerminal: false });
    // EXACTLY two keys, because this record is SPREAD into a request the kernel
    // parses as exactly seven: a third member here would refuse every release as
    // malformed, and this is the assertion that would say so.
    expect(first.ok && Object.keys(first.flags).sort())
      .toEqual(["effectsTerminal", "resourcesTerminal"]);
  });

  it("REFUSES a caller-supplied terminality flag of any shape, never ignoring one", () => {
    // Silently dropping the key is, from the caller's side, the same call as
    // honouring it. Both keys, three value shapes — and `true` is the AGREEING
    // value for this fixture, which is the point: the field is unrepresentable,
    // not cross-checked.
    let driven = 0;
    for (const key of ["effectsTerminal", "resourcesTerminal"]) {
      for (const value of [true, false, "TERMINAL"]) {
        const fixture = activated(`terminal-spoof-${key}-${String(value)}`);
        const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
          withRetiredKey(key, value));
        expect(refusalOf(outcome), `${key}=${String(value)}`).toEqual({
          code: "ATTEMPT_RELEASE_REQUEST_MALFORMED", refusedBy: DAEMON_ATTEMPT_RELEASE,
        });
        // The admission runs before ANY store work, so not even an observation
        // lands on its way to being discarded.
        expect(boundaryObservations(fixture), `${key}=${String(value)}`).toEqual([]);
        expectNoDurableRow(fixture);
        driven += 1;
      }
    }
    // A sweep that generated nothing would pass every assertion above vacuously.
    expect(driven).toBe(6);
    // FOUR since task-a20e8ef6: `handoff` joined the three settle facts. This sweep
    // drives the two terminality keys only; `handoff` has its own arm above, and
    // `safeBoundaryObserved` its own in the boundary suite.
    expect(RETIRED_KEYS.length).toBe(4);
  });
});

/** The exact fields `ExpansionReleaseEvidence` names, read from durable bytes. */
const RELEASE_FIELDS = Object.freeze([
  "attemptState", "leaseRef", "leaseState", "providerSlotRef", "providerSlotState", "reason",
] as const);

function dispositionOf(row: Record<string, unknown>): Record<string, unknown> {
  const value = row["disposition"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("the recorded row carries no disposition record");
  }
  return value as Record<string, unknown>;
}

function leaseOf(row: Record<string, unknown>): Record<string, unknown> {
  const value = row["lease"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("the recorded row carries no lease record");
  }
  return value as Record<string, unknown>;
}

describe("attempt release disposition — a lease durably reaches RELEASED", () => {
  it("records leaseState RELEASED from durable bytes, which no path could reach before", () => {
    const fixture = activated("released");
    // THE PLAIN FACT THIS CASE EXISTS FOR: before this task the daemon recorded
    // the ACTIVATION-TIME lease state, so the row said "ACTIVE" forever and
    // `leaseState === "RELEASED"` was unreachable in the whole repository.
    expect(fixture.record.lease.state).toBe("ACTIVE");
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("RELEASED");
    // EVERY assertion below is against the READER's answer, never `written`.
    const answer = readAttemptRelease(fixture.store, fixture.bound.aggregateId);
    const row = rowOf(answer);
    expect(row["leaseState"]).toBe("RELEASED");
    expect(RELEASE_FIELDS.filter((field) => !(field in row))).toEqual([]);
    expect({
      attemptState: row["attemptState"], leaseRef: row["leaseRef"],
      providerSlotRef: row["providerSlotRef"], providerSlotState: row["providerSlotState"],
      reason: row["reason"],
    }).toEqual({
      // All three states are the SAFE-BOUNDARY TRANSACTION OUTCOME now, never the
      // activation slice: the slot ref is the one the kernel's successor names.
      attemptState: "RELEASED", leaseRef: fixture.record.lease.leaseId,
      providerSlotRef: fixture.record.providerSlot.slotRef,
      providerSlotState: "RELEASED", reason: "WORK_RELEASE_OR_PAUSE",
    });
    // The kernel's whole lease answer, not just the projection: the version was
    // bumped by the kernel and the daemon supplied neither field.
    expect([leaseOf(row)["state"], leaseOf(row)["version"], fixture.record.lease.version])
      .toEqual(["RELEASED", 8, 7]);
    expect(row["leaseState"]).toBe(leaseOf(row)["state"]);
    expect([row["outcome"], row["releasePending"], row["resumable"]])
      .toEqual(["RELEASED", false, true]);
    expect(dispositionOf(row)).toEqual({
      resumable: true, strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
    });
    expect([row["recordVersion"], row["truthClass"], row["attemptAggregateId"]]).toEqual(
      [ATTEMPT_RELEASE_RECORD_VERSION, "DAEMON_VERIFIED", ACTIVATION_AGGREGATE]);
    // THE ROW'S HANDOFF IS THE SERVER'S, not a caller literal. Asserted against the
    // BUILDER's own answer over the same store rather than against a constant in this
    // file: a hand-written expectation here would agree with itself and would keep
    // passing if the release path silently stopped consulting the builder at all.
    const rebuilt = buildReleaseHandoff(fixture.store, {
      attemptRef: fixture.record.attempt.attemptId, nodeKey: NODE_KEY,
      projectId: PROJECT_ID, sessionId: SESSION_ID,
    });
    if (!rebuilt.ok) throw new Error(`the builder refused the released world: ${rebuilt.code}`);
    expect(row["handoff"]).toEqual(rebuilt.handoff);
    // And it is NOT the literal this suite used to relay, which is what says the
    // assertion above is reading a derived value rather than an echo.
    expect(row["handoff"]).not.toEqual(HANDOFF);
  });

  it("records attempt, lease AND provider slot RELEASED in the ONE decision", () => {
    const fixture = activated("three-states");
    // THE DEFECT THIS CASE CORRECTS. The row used to copy the ACTIVATION SLICE
    // into two of these three fields, so a settled release durably claimed a
    // RUNNING attempt holding an ACTIVE provider slot. Stated as a premise
    // because it is also what stops the assertion below passing by echo: if
    // either slice ever equalled "RELEASED" this case would prove nothing.
    expect([fixture.record.attempt.state, fixture.record.providerSlot.state])
      .toEqual(["RUNNING", "ACTIVE"]);
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("RELEASED");
    // ONE decision, and every state below is read out of its canonical durable
    // bytes through the module's own reader. Nothing here consults `written`.
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect({
      attemptState: row["attemptState"], leaseState: row["leaseState"],
      providerSlotState: row["providerSlotState"],
    }).toEqual({
      attemptState: "RELEASED", leaseState: "RELEASED", providerSlotState: "RELEASED",
    });
    // Stated as a DIFFERENCE as well as a value: a body that reverted to the
    // activation slice would satisfy neither half.
    expect(row["attemptState"]).not.toBe(fixture.record.attempt.state);
    expect(row["providerSlotState"]).not.toBe(fixture.record.providerSlot.state);
    // The released row still names the SAME slot and attempt the activation
    // bound, so the transition happened to this attempt and not beside it.
    expect([row["providerSlotRef"], row["attemptRef"]]).toEqual([
      fixture.record.providerSlot.slotRef, fixture.record.attempt.attemptId,
    ]);
  });

  it("records a NON-RESUMABLE release under a different drain reason", () => {
    const fixture = activated("non-resumable");
    const other = "WORK_CANCEL";
    // The two reasons really are different members of the same frozen list, so
    // this case cannot pass by accidentally re-driving the resumable one.
    expect(other).not.toBe("WORK_RELEASE_OR_PAUSE");
    expect([...DRAIN_REASONS]).toContain(other);
    const written = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ reason: other }));
    expect(written.ok && written.outcome).toBe("RELEASED");
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["reason"], row["leaseState"], row["resumable"]])
      .toEqual([other, "RELEASED", false]);
    expect(dispositionOf(row)).toEqual({
      resumable: false, strongestReason: other, terminalTarget: "RELEASED",
    });
    // Stated as a difference, not just as a value: the resumable path must be
    // unreachable by default rather than merely unselected here.
    expect(dispositionOf(row)).not.toEqual({
      resumable: true, strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
    });
  });

  it("lets the DURABLE lease and slot state win over a contradicting caller record", () => {
    const fixture = activated("contradiction");
    const claimed: ActivationLedgerRecord = {
      ...fixture.record,
      lease: { ...fixture.record.lease, state: "REVOKED", version: 99 },
      providerSlot: {
        ...fixture.record.providerSlot, slotRef: "slot-forged", state: "RESERVED",
      },
    };
    // The premise: the caller really is claiming something the store denies. A
    // REVOKED lease would make the kernel answer NO_OP and write nothing at all,
    // and a RESERVED slot is one the slot kernel REFUSES to release — so if the
    // caller's copy reached either the command or the row, this case could not
    // end in a released row naming the durable slot.
    expect([fixture.record.lease.state, fixture.record.providerSlot.state]).toEqual(
      ["ACTIVE", "ACTIVE"]);
    expect([claimed.lease.state, claimed.providerSlot.state]).toEqual(["REVOKED", "RESERVED"]);
    expect(claimed.providerSlot.slotRef).not.toBe(fixture.record.providerSlot.slotRef);
    const written =
      recordAttemptRelease(fixture.store, fixture.bound, claimed, settledRequest());
    // No layer refuses: the claim is not rejected, it is never consulted. The
    // identity is unchanged, so the binding guard has nothing to answer.
    expect(written.ok && written.outcome).toBe("RELEASED");
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    // RELEASED because the DURABLE slot was ACTIVE and the kernel transitioned
    // it — not because the caller claimed RELEASED. The caller's copy reached
    // neither the command nor the row: the identical value is a coincidence the
    // slot-refusal cases below break apart.
    expect([row["leaseState"], row["providerSlotState"]]).toEqual(["RELEASED", "RELEASED"]);
    expect([leaseOf(row)["version"], row["providerSlotRef"]]).toEqual(
      [8, fixture.record.providerSlot.slotRef]);
  });

  it("reads the reason set through validated bytes, not the caller's own array", () => {
    const fixture = activated("hostile-reasons");
    // A plain array carrying an own `includes` that lies and an own iterator that
    // would smuggle an unvalidated member into the durable row. The kernel's
    // `stringList` reads own INDEX properties and then composes a fresh frozen
    // array, so neither override is ever consulted.
    const reasons: string[] = ["WORK_RELEASE_OR_PAUSE"];
    Object.defineProperty(reasons, "includes", { value: () => true });
    Object.defineProperty(reasons, Symbol.iterator, {
      value: function* smuggle(): Generator<string> { yield "NOT_A_DRAIN_REASON"; },
    });
    const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ disposition: {
        reasons, resumable: true, strongestReason: "WORK_RELEASE_OR_PAUSE",
        terminalTarget: "RELEASED",
      } }));
    expect(rowOf(outcome)["reasons"]).toEqual(["WORK_RELEASE_OR_PAUSE"]);
  });
});

describe("attempt release disposition — DRAINING is its own outcome", () => {
  /** One unsettled DERIVED fact and nothing else different. Every arm calls the
   *  release with the SAME four-key request; only the durable evidence differs,
   *  which is the whole contract change this row landed. */
  function drainedBy(
    label: string, evidence: BoundaryEvidence, terminality: Terminality,
    expected: readonly [boolean, boolean],
  ): Fixture {
    const fixture = activated(`draining-${label}`, evidence, terminality);
    // THE PRODUCER'S OWN ANSWER for this arm's store, asserted per family: it is
    // what makes the three arms genuinely different fixtures rather than three
    // spellings of one, and a seeding slip would otherwise pass as a pass.
    const produced = deriveReleaseTerminalEvidence(fixture.store, {
      attemptRef: ATTEMPT_REF, projectId: PROJECT_ID,
    });
    expect(produced.ok && [produced.effectsTerminal, produced.resourcesTerminal], label)
      .toEqual(expected);
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome, label).toBe("DRAINING");
    expect(durableRowCount(fixture), label).toBe(1);
    return fixture;
  }

  const rowFrom = (fixture: Fixture): Record<string, unknown> =>
    rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));

  /** No terminal record for the attempt's own effect intent. */
  const drainedByEffects = (): Record<string, unknown> =>
    rowFrom(drainedBy("effects", "OBSERVED", EFFECTS_PENDING, [false, true]));
  /**
   * THE RESOURCES ARM IS GONE FROM THIS SWEEP, and its absence is the change this
   * row landed rather than an omission. A non-terminal RESOURCE set no longer
   * drains: `commitRelease` pins expectedVersion 0, so the DRAINING row this arm
   * used to assert could never be upgraded once the reconcile command terminalised
   * the set. It is DEFERRED instead, with zero rows and zero decisions, by the
   * resource-fence block below — which also owns this arm's replacement.
   *
   * THE TWO ARMS THAT REMAIN ARE THE NEGATIVE CONTROL for that fence: both carry
   * `resourcesTerminal: true`, so their DRAINING rows must be untouched. A fence
   * that silently killed DRAINING altogether would red right here.
   */

  /** A durable run the host never saw exit — the boundary's only route now. Its
   *  effect is necessarily pending too (see `UNOBSERVED_TERMINALITY`), so this arm
   *  asserts the BOUNDARY's own recorded reason instead of resting on the outcome:
   *  without it a lost boundary derivation would hide behind the effects arm. */
  function drainedByBoundary(): Record<string, unknown> {
    const fixture = drainedBy("boundary", "UNOBSERVED", UNOBSERVED_TERMINALITY, [false, true]);
    const observations = boundaryObservations(fixture);
    expect([observations.length, observations[0]?.["safeBoundaryObserved"],
      observations[0]?.["reasonCode"]]).toEqual([1, false, "SAFE_BOUNDARY_EXIT_UNOBSERVED"]);
    return rowFrom(fixture);
  }

  it("records DRAINING with resumable false for each unsettled boundary fact", () => {
    // TWO DERIVED ARMS, ZERO RELAYED, and two rather than three because the
    // resources arm is now FENCED before any write (see the fence block below).
    // They are counted apart because each is reached through a DIFFERENT durable
    // shape: a sweep that quietly lost one would still show two rows if the other
    // double-counted, and both are driven by evidence rather than by a caller
    // literal this suite chose.
    const effects = [drainedByEffects()];
    const boundary = [drainedByBoundary()];
    expect([effects.length, boundary.length]).toEqual([1, 1]);
    const rows = [...effects, ...boundary];
    // A sweep that generated nothing passes every assertion below vacuously.
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect([row["outcome"], row["leaseState"], row["resumable"], row["releasePending"]])
        .toEqual(["DRAINING", "DRAINING", false, true]);
      expect(leaseOf(row)["state"]).toBe("DRAINING");
      // DRAINING NEVER UPGRADES THE ATTEMPT OR THE SLOT. The attempt records the
      // kernel's own DRAINING outcome, and the provider slot is RETAINED exactly
      // as the activation left it — a slot transition is never attempted on an
      // unsettled boundary, so a DRAINING row cannot claim safe release.
      expect(row["attemptState"]).toBe("DRAINING");
      expect(row["providerSlotState"]).not.toBe("RELEASED");
      expect(row["providerSlotState"]).toBe("ACTIVE");
      expect(row["intentRefs"]).toEqual(["intent:release"]);
      expect(row["handoff"]).toBeNull();
      // THE NON-EQUIVALENT HALF. The reason set still composes a RESUMABLE
      // disposition — design 765 says WORK_RELEASE_OR_PAUSE is resumable — yet
      // THIS release is not, because the boundary was never observed. A daemon
      // that re-derived `resumable` from the disposition would print true here.
      expect(dispositionOf(row)["resumable"]).toBe(true);
      expect(row["resumable"]).toBe(false);
    }
  });

  it("differs from the released row FIELD BY FIELD, never merely 'not released'", () => {
    const fixture = activated("released-for-diff");
    recordAttemptRelease(fixture.store, fixture.bound, fixture.record, settledRequest());
    const released = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    const draining = drainedByBoundary();
    const differing = Object.keys(released)
      .filter((key) => JSON.stringify(released[key]) !== JSON.stringify(draining[key]));
    expect(differing.sort()).toEqual([
      // `attemptState` and `providerSlotState` belong in this list and did not
      // before: while they copied the activation slice the two rows agreed on
      // them, which is exactly the bug — a DRAINING and a RELEASED row cannot
      // honestly describe the same attempt and slot state.
      "attemptState", "handoff", "intentRefs", "lease", "leaseState", "outcome",
      "providerSlotState", "releasePending", "resumable",
    ]);
    expect([released["attemptState"], released["providerSlotState"]])
      .toEqual(["RELEASED", "RELEASED"]);
    expect([draining["attemptState"], draining["providerSlotState"]])
      .toEqual(["DRAINING", "ACTIVE"]);
    // And every OTHER field is genuinely identical, so the two rows describe the
    // same attempt rather than two unrelated releases that happen to disagree.
    expect([draining["attemptAggregateId"], draining["reason"], draining["attemptRef"],
      draining["providerSlotRef"]]).toEqual([released["attemptAggregateId"],
      released["reason"], released["attemptRef"], released["providerSlotRef"]]);
  });
});

/**
 * A REAL production activation whose PROVIDER-SLOT FACT ALONE has drifted,
 * resealed through the production codec and committed as sequence 1 of a fresh
 * store's activation aggregate.
 *
 * The production activation path always leaves the slot ACTIVE and bound to the
 * attempt, so no honest fixture can reach the slot kernel's refusing guards at
 * all. Nothing here is invented to get there: the grant, the digest, the lease,
 * the attempt and both version arithmetics come from `runEffectActivateCommand`
 * and are carried verbatim, so the strict activation reader accepts the planted
 * event and `releaseWork` fences against a genuine lease. The CONTROL case below
 * drifts nothing and releases cleanly, which is what proves a refusal here is
 * the slot guard's answer and not the planting's.
 */
function plantedSlot(
  label: string, providerSlot: unknown, evidence: "OBSERVED" | "UNOBSERVED" = "OBSERVED",
  terminality: Terminality = SETTLED,
): Fixture {
  const source = activated(`${label}-source`);
  // The drift is deliberately UNTYPED at the seam: the case's whole purpose is a
  // slot shape the contract forbids, and the production codec is what judges it.
  const drifted =
    { ...source.record, providerSlot } as unknown as ActivationLedgerRecord;
  const encoded = encodeActivationLedgerRecord(drifted);
  if (!encoded.ok) throw new Error(`the production codec refused the drift: ${encoded.code}`);
  const root = trackHarnessRoot(mkdtempSync(join(tmpdir(), `moe-release-${label}-`)));
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  // Planted through the PRODUCTION ledger writer rather than a hand-composed
  // decision. It stamps the `activation.commit` command kind and copies the event
  // id from the grant, both of which the strict by-attempt reader cross-checks —
  // and that reader is what the safe-boundary producer binds through, so a plant
  // the production writer would not have made can no longer be released at all.
  const committed = commitActivationLedgerRecord(store, {
    correlationId: `corr-plant-${label}`, decidedAt: DECIDED_AT,
    key: { commandId: `cmd-plant-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    record: drifted, requestBytes: encoded.bytes,
  });
  if (!committed.ok) throw new Error(`planting refused: ${committed.code}`);
  const history = readFoundationActivationHistory(
    ACTIVATION_AGGREGATE, store.readEvents(ACTIVATION_AGGREGATE), PROJECT_ID);
  if (!history.ok) {
    throw new Error(`the planted activation is unreadable: ${history.result.status}`);
  }
  // The plant lives in its OWN store, so the evidence every derivation reads has
  // to be committed here too — the source fixture's ledgers are unreachable.
  seedProviderRun(store, label, evidence);
  // The RESOURCE SET as well, through the same production binder the ingress
  // drives. `commitActivationLedgerRecord` plants the activation alone, and an
  // attempt holding no durable set is answered non-terminal with a zero count —
  // so without this bind every planted case would drain for the wrong reason.
  const bound = bindAttemptResources(store, {
    activationAggregateId: ACTIVATION_AGGREGATE, commandId: `cmd-bind-${label}`,
    correlationId: `corr-plant-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
  }, [{ ...RESOURCE_ROW }]);
  if (!bound.ok) throw new Error(`the planted resource bind refused: ${bound.code}`);
  seedTerminality(store, label, terminality);
  // AND THE FIVE HANDOFF SOURCES, for exactly the reason above: this store is its own
  // world, and without them every planted case would refuse at the checkpoint instead
  // of reaching the slot guard it was written to exercise.
  const planted = history.history.record;
  seedReleaseHandoffSources(store, {
    activationDigest: planted.activationDigest, attemptAggregateId: ACTIVATION_AGGREGATE,
    attemptRef: planted.attempt.attemptId, effectId: planted.effectIntent.intentId,
    leaseRef: planted.lease.leaseId, nodeKey: NODE_KEY, projectId: PROJECT_ID,
    sessionId: SESSION_ID,
  });
  return { bound: source.bound, record: planted, store };
}

/** The slot the production activation actually commits: ACTIVE and attempt-bound. */
const ACTIVATED_SLOT = Object.freeze({
  attemptRef: "attempt-1", dimension: "default", requestId: "req-1", slotRef: "slot-1",
  state: "ACTIVE",
});

function refusalWithMessage(
  outcome: AttemptReleaseOutcome,
): { code: string; message: string | null; refusedBy: string } {
  if (outcome.ok) throw new Error("expected a refusal, received a recorded row");
  return { code: outcome.code, message: outcome.message, refusedBy: outcome.refusedBy };
}

describe("attempt release disposition — the slot transition is all-or-none", () => {
  it("releases the planted CONTROL, so a refusal below is the SLOT guard's", () => {
    const fixture = plantedSlot("slot-control", { ...ACTIVATED_SLOT });
    // The premise the whole planting rests on: an undrifted plant is byte-for-byte
    // the activation the production path commits.
    expect(fixture.record.providerSlot).toEqual(ACTIVATED_SLOT);
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("RELEASED");
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["attemptState"], row["leaseState"], row["providerSlotState"]])
      .toEqual(["RELEASED", "RELEASED", "RELEASED"]);
  });

  it("derives the slot identity from the DURABLE slot, not from a constant", () => {
    // Drifting the slot ref alone still RELEASES, because the command follows the
    // durable slot. A daemon that named the slot any other way would refuse here
    // — and the recorded ref is the drifted one, read back out of durable bytes.
    const fixture = plantedSlot("slot-identity", { ...ACTIVATED_SLOT, slotRef: "slot-moved" });
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("RELEASED");
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["providerSlotRef"], row["providerSlotState"]])
      .toEqual(["slot-moved", "RELEASED"]);
  });

  it("ACCEPTS an already-RELEASED slot, which is the kernel's NO_OP arm", () => {
    // The slot kernel is three-way like `releaseWork`: a settled slot REPLAYS as
    // an acceptance rather than an error. A daemon that tightened DoD 3's
    // refusal list into "only an ACTIVE slot may be released" would refuse a
    // perfectly honest replay and strand the release — so the accepting arm is
    // pinned as deliberately as the refusing ones.
    const fixture = plantedSlot("slot-settled", { ...ACTIVATED_SLOT, state: "RELEASED" });
    expect(fixture.record.providerSlot.state).toBe("RELEASED");
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("RELEASED");
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["attemptState"], row["leaseState"], row["providerSlotState"]])
      .toEqual(["RELEASED", "RELEASED", "RELEASED"]);
  });

  /** Every refusing drift, with the SCHEDULER's own words. `refuse()` stamps
   *  AUTHORITY_STALE_LEASE on all four of its guards, so the code alone would be
   *  the same assertion written four times: the message is the discriminator. */
  const SLOT_REFUSALS = [
    {
      code: "AUTHORITY_MALFORMED_INPUT",
      message: "releaseProviderSlot received a malformed slot record or command",
      name: "a slot state outside the frozen vocabulary", slot: { state: "SUSPENDED" },
    },
    {
      code: "AUTHORITY_STALE_LEASE",
      message: "release names a different attempt than the provider slot binding",
      name: "a slot bound to a DIFFERENT attempt", slot: { attemptRef: "attempt-other" },
    },
    {
      code: "AUTHORITY_STALE_LEASE",
      message: "release names a different attempt than the provider slot binding",
      // `null` is a real parsed value on a never-activated slot, and the kernel
      // treats it as a binding, not a wildcard.
      name: "an UNBOUND slot, whose null attemptRef is not a wildcard",
      slot: { attemptRef: null },
    },
    {
      code: "AUTHORITY_STALE_LEASE",
      message: "a provider slot in state RESERVED cannot be released",
      name: "a slot still RESERVED", slot: { state: "RESERVED" },
    },
  ] as const;

  it.each(SLOT_REFUSALS)("refuses under the slot layer for $name", (arm) => {
    // SLUGGED, and it has to be: the label reaches a provider RUN REF, and the
    // settlement the terminal-effect ledger projects refuses a ref carrying
    // whitespace with PROVIDER_SETTLEMENT_RUN_REF_MALFORMED.
    const fixture = plantedSlot(`slot-refuse-${arm.name.slice(0, 12).replace(/\W+/gu, "-")}`,
      { ...ACTIVATED_SLOT, ...arm.slot });
    const outcome = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    // THE LAYER IS THE DISCRIMINATOR. `releaseWork` returns the SAME two codes,
    // so a slot refusal restamped as a lease-drain refusal would be invisible in
    // the code alone — and it demands the opposite repair.
    expect(refusalWithMessage(outcome)).toEqual({
      code: arm.code, message: arm.message, refusedBy: SCHEDULER_PROVIDER_SLOT_RELEASE,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusedBy).not.toBe(SCHEDULER_LEASE_DRAIN);
    // ALL-OR-NONE. A handler that wrote the row and then refused is identical to
    // a clean refusal from the return value alone, so both are counted out of
    // the store — and a decision with no event would escape the row count.
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    expectNoDurableRow(fixture);
  });

  it("drives every refusing drift and keeps their messages apart", () => {
    // A table that generated nothing passes `it.each` vacuously.
    expect(SLOT_REFUSALS.length).toBe(4);
    // Three DISTINCT messages over four arms: the two attempt-binding arms are
    // different inputs reaching one guard, and the other two guards are separate.
    expect(new Set(SLOT_REFUSALS.map((arm) => arm.message)).size).toBe(3);
    // The code cannot tell the state guard from the binding guard.
    expect(new Set(SLOT_REFUSALS.map((arm) => arm.code)).size).toBe(2);
  });
});

describe("attempt release disposition — replay and cardinality", () => {
  it("answers the kernel's NO_OP on replay and leaves EXACTLY ONE durable row", () => {
    const fixture = activated("replay");
    const first = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(first.ok && first.outcome).toBe("RELEASED");
    // The RAW counts before the replay: events on the aggregate and decisions
    // targeting it. "The second call did not throw" is also what a double write
    // looks like, and a decision landed with no event escapes a row count.
    const before = [durableRowCount(fixture), releaseDecisionCount(fixture)];
    expect(before).toEqual([1, 1]);
    // A DIFFERENT disposition, so a second row would be observable rather than an
    // idempotent repeat. The recorded lease is already RELEASED, so `releaseWork`
    // answers NO_OP and the daemon writes nothing.
    const replay = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ reason: "WORK_CANCEL" }));
    expect(replay.ok && replay.outcome).toBe("NO_OP");
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual(before);
    // The FIRST release still stands, unchanged, and is still the durable answer.
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["reason"], row["outcome"], row["leaseState"]])
      .toEqual(["WORK_RELEASE_OR_PAUSE", "RELEASED", "RELEASED"]);
    // Including the three states this task composes: a replay that recomposed
    // them would answer the SECOND call's slot transition, not the first's.
    expect([row["attemptState"], row["providerSlotState"]]).toEqual(["RELEASED", "RELEASED"]);
    expect(rowOf(replay)).toEqual(row);
  });

  it("refuses a LATER DIVERGENT slot fact before it can write a second row", () => {
    // A durable slot that is still RESERVED, with a first release that never
    // reached it: an unsettled boundary drains the lease and leaves the slot
    // alone, so the row records the RESERVED fact honestly.
    const fixture = plantedSlot(
      "divergent-slot", { ...ACTIVATED_SLOT, state: "RESERVED" }, "OBSERVED", EFFECTS_PENDING);
    // The unsettled fact is a DERIVED one: no terminal record exists yet for the
    // attempt's effect intent. The run stays OBSERVED so the boundary is settled,
    // and TERMINALITY is what lets the second call settle — it is re-read from the
    // ledgers on every call, where a committed run can never be upgraded.
    const first = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(first.ok && first.outcome).toBe("DRAINING");
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);
    expect(rowOf(first)["providerSlotState"]).toBe("RESERVED");
    terminaliseEffect(fixture.store);

    // DRAINING is not terminal, so `releaseWork` composes a real RELEASED
    // transition on the second call — and the slot it would have to release is
    // one the slot kernel refuses. The refusal must land BEFORE the commit.
    const second = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    // THIS CODE IS THE ORDERING PROOF. Committing first and releasing the slot
    // afterwards would answer ATTEMPT_RELEASE_COMMIT_UNAVAILABLE under the daemon
    // layer instead — the aggregate is written at expectedVersion 0, so the
    // second commit fails for its own unrelated reason and buries this one.
    expect(refusalWithMessage(second)).toEqual({
      code: "AUTHORITY_STALE_LEASE",
      message: "a provider slot in state RESERVED cannot be released",
      refusedBy: SCHEDULER_PROVIDER_SLOT_RELEASE,
    });
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);
    // The FIRST row survives untouched: no partial authority outlived the refusal.
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["outcome"], row["attemptState"], row["providerSlotState"]])
      .toEqual(["DRAINING", "DRAINING", "RESERVED"]);
  });

  it("keeps ABSENT and AMBIGUOUS distinct, because they demand opposite repairs", () => {
    const fixture = activated("cardinality");
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId)).code)
      .toBe("ATTEMPT_RELEASE_RECORD_ABSENT");
    expect(recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest()).ok).toBe(true);
    plantReleaseEvent(fixture, encoder.encode(JSON.stringify({ duplicate: true })), 1);
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId))).toEqual({
      code: "ATTEMPT_RELEASE_RECORD_AMBIGUOUS", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
  });

  it("refuses stored bytes that no longer re-encode, under a third distinct code", () => {
    const fixture = activated("drift");
    // Canonical encoding sorts keys, so a row whose keys are stored out of order
    // decodes cleanly and then fails the re-encode byte compare — unreadable in
    // the only sense that matters, and not the same repair as absent or two.
    plantReleaseEvent(fixture, encoder.encode('{"b":1,"a":2}'), 0);
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId))).toEqual({
      code: "ATTEMPT_RELEASE_RECORD_DRIFT", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
  });

  it("refuses a SECOND transition over a DRAINING row rather than appending one", () => {
    const fixture = activated("draining-then-settled", "OBSERVED", EFFECTS_PENDING);
    // First release: no terminal effect is durable yet, so the DERIVED flag is
    // false and the row records DRAINING with the lease reaching DRAINING rather
    // than a terminal state. Recording the terminal effect between the calls is
    // what lets the second settle — terminality is re-read from the ledgers every
    // call, where the boundary comes from one committed run that cannot change.
    const first = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(first.ok && first.outcome).toBe("DRAINING");
    terminaliseEffect(fixture.store);
    // DRAINING is NOT terminal, so `releaseWork` composes a real RELEASED
    // transition on the replay — and the aggregate, written at expectedVersion 0,
    // has nowhere to put it. Refused, not silently dropped and not a second row.
    const second = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(refusalOf(second)).toEqual({
      code: "ATTEMPT_RELEASE_COMMIT_UNAVAILABLE", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expect(durableRowCount(fixture)).toBe(1);
    expect(rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId))["outcome"])
      .toBe("DRAINING");
  });

  it("refuses to fence against a stored lease the scheduler's parser will not accept", () => {
    const fixture = activated("lease-drift");
    // Canonically encoded and carrying a declared outcome, so the byte compare
    // and the outcome guard both pass and ONLY the lease parse can refuse. A
    // daemon that fell back to the activation lease here would fence against a
    // state the release had already left, and write a second truth.
    plantReleaseEvent(
      fixture, encoder.encode('{"lease":{"leaseId":"lease-1"},"outcome":"RELEASED"}'), 0);
    expect(readAttemptRelease(fixture.store, fixture.bound.aggregateId).ok).toBe(true);
    const outcome = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_RECORD_DRIFT", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    // Conflicting bytes refuse BEFORE a second write, decisions included.
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);
  });

  it("refuses an UNREADABLE store separately from an absent row", () => {
    const fixture = activated("unreadable");
    fixture.store.close();
    // Absent and unreadable demand opposite repairs: one says write the release,
    // the other says the durable history cannot be consulted at all.
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId))).toEqual({
      code: "ATTEMPT_RELEASE_RECORD_UNREADABLE", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expect(refusalOf(recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest())).code)
      .toBe("ATTEMPT_RELEASE_ACTIVATION_UNREADABLE");
  });

  it("carries the kernel's EXHAUSTED-COUNTER refusal instead of releasing over it", () => {
    // `fenceAuthority` refuses a lease at MAX_AUTHORITY_COUNT as MALFORMED: a
    // successor above the ceiling would never parse again, leaving the lease
    // unrevocable. Planted through the PRODUCTION codec, so the bytes are the
    // canonical ones the reader demands rather than a hand-sorted guess.
    const CEILING = Number.MAX_SAFE_INTEGER - 1_000_000;
    const plant = (fixture: Fixture, version: number): void => {
      const encoded = encodeFoundationPayload({
        lease: {
          authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT",
          leaseId: "lease-1", leaseToken: "token-1", monotonicObservation: 500,
          ownerSessionRef: SESSION_ID, serverWallDeadline: 1_000, state: "RELEASED", version,
        },
        outcome: "RELEASED",
      });
      if (!encoded.ok) throw new Error("the production codec refused the planted row");
      plantReleaseEvent(fixture, encoded.bytes, 0);
    };
    // CONTROL first, the SAME planted shape one counter below the ceiling: it
    // fences cleanly and answers NO_OP, so the refusal below is the counter and
    // not merely "a planted row is rejected".
    const control = activated("counter-control");
    plant(control, CEILING - 1);
    const fenced =
      recordAttemptRelease(control.store, control.bound, control.record, settledRequest());
    expect(fenced.ok && fenced.outcome).toBe("NO_OP");

    const fixture = activated("counter-exhausted");
    plant(fixture, CEILING);
    expect(refusalOf(recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest()))).toEqual({
      code: "AUTHORITY_MALFORMED_INPUT", refusedBy: SCHEDULER_LEASE_DRAIN,
    });
    expect(durableRowCount(fixture)).toBe(1);
  });

  it("refuses a row whose recorded outcome is outside the frozen vocabulary", () => {
    const fixture = activated("outcome-drift");
    // Canonically encoded, so the byte compare passes and ONLY the outcome guard
    // can refuse it. A reader that trusted the stored string would hand a caller
    // an outcome no kernel ever answered.
    plantReleaseEvent(fixture, encoder.encode('{"outcome":"SUCCEEDED"}'), 0);
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId))).toEqual({
      code: "ATTEMPT_RELEASE_RECORD_DRIFT", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
  });
});

/** Writes a row this module did not compose, so the reader's cardinality and
 *  byte-identity guards are reached by evidence rather than by a stub. */
function plantReleaseEvent(fixture: Fixture, payload: Uint8Array, expectedVersion: number): void {
  const committed = fixture.store.commitExpectedVersionDecision({
    commandKind: ATTEMPT_RELEASE_COMMAND_KIND, committedResultBytes: payload,
    correlationId: `corr-plant-${expectedVersion}`, decidedAt: DECIDED_AT,
    events: [{
      eventId: `planted-${expectedVersion}`, eventType: ATTEMPT_RELEASE_EVENT_TYPE, payload,
    }],
    expectedVersion,
    key: {
      commandId: `cmd-plant-${expectedVersion}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    },
    requestBytes: payload,
    // NAMED DIRECTLY rather than through `bound.target`: that field is the DISPATCH
    // stream, and this helper has always meant the RELEASE aggregate.
    targetAggregateId: deriveAttemptReleaseAggregateId(fixture.bound.aggregateId),
  });
  if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`planting refused: ${committed.decision.effectDisposition}`);
  }
}

/**
 * THE PRE-RELEASE RESOURCE FENCE.
 *
 * `commitRelease` pins `expectedVersion: 0`, so the FIRST row an attempt's release
 * aggregate ever receives is the only one it can hold. A release taken while the
 * durable resource set is still non-terminal therefore strands the attempt in
 * DRAINING FOREVER: the reconcile command can terminalise the set a second later
 * and no later write can upgrade that row. The fence refuses BEFORE the handoff
 * binding is derived and before the kernel is asked anything, so a deferral leaves
 * zero rows AND zero decisions.
 *
 * WHAT THIS BLOCK DOES NOT OWN: the post-verification retry that turns a deferral
 * into a release once reconciliation lands (task-48c79a29) and the scheduler
 * nine-key handoff builder (task-a20e8ef6).
 */
describe("attempt release disposition — the resource fence stands before any write", () => {
  const selector = Object.freeze({ attemptRef: ATTEMPT_REF, projectId: PROJECT_ID });
  /** The fence's own stable code, written as a LITERAL rather than read off the
   *  production constant: an operand derived from the subject cannot constrain it. */
  const UNPROVEN = "ATTEMPT_RELEASE_RESOURCES_UNPROVEN";

  const deferral = Object.freeze({ code: UNPROVEN, refusedBy: DAEMON_ATTEMPT_RELEASE });

  /** A member the scheduler's own reducer moved to QUARANTINED, through the SAME
   *  production authority the reconcile ingress drives — an UNKNOWN adapter failure
   *  on the member itself, which `adapterFail` quarantines rather than releases. It
   *  is a THIRD durable shape: neither ACTIVE nor absent, and still movable. */
  function quarantineResources(fixture: Fixture, label: string): void {
    const outcome = applyAttemptResourceReport(fixture.store, {
      activationAggregateId: ACTIVATION_AGGREGATE, commandId: `cmd-quarantine-${label}`,
      correlationId: `corr-quarantine-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    }, { disposition: "UNKNOWN", epoch: 1, kind: "FAIL", resourceId: RESOURCE_ROW.resourceId });
    if (!outcome.ok) throw new Error(`quarantine refused: ${outcome.code}`);
  }

  /** The durable states of THIS attempt's set, so the sweep below can prove its
   *  three cases are genuinely different fixtures and not three spellings of one. */
  function resourceStates(fixture: Fixture): readonly string[] | string {
    const current = readAttemptResources(fixture.store, ACTIVATION_AGGREGATE, PROJECT_ID);
    return current.ok ? current.members.map((member) => member.state) : current.code;
  }

  /**
   * An UNDECODABLE resource record, planted on the aggregate this attempt's set
   * derives. PLANTED because no production writer can make one — both the bind and
   * the transition arms encode through the codec — and a refusal arm no honest
   * fixture can reach is an arm nothing tests.
   */
  function plantUndecodableResources(fixture: Fixture): void {
    const aggregateId = deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE);
    const payload = encoder.encode("{");
    fixture.store.commitExpectedVersionDecision({
      commandKind: "test.plant_resources", committedResultBytes: payload,
      correlationId: "plant-resources", decidedAt: DECIDED_AT,
      events: [{
        eventId: "plant-resources", eventType: ATTEMPT_RESOURCE_BOUND_EVENT_TYPE, payload,
      }],
      // MEASURED, not assumed: the honest bind already holds version 1, and a wrong
      // expectation would plant nothing while every assertion below read as a pass.
      expectedVersion: fixture.store.readEvents(aggregateId).length,
      key: { commandId: "plant-resources", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
      requestBytes: payload, targetAggregateId: aggregateId,
    });
  }

  const release = (fixture: Fixture): AttemptReleaseOutcome =>
    recordAttemptRelease(fixture.store, fixture.bound, fixture.record, settledRequest());

  it("publishes ONE fence code, outside the daemon's closed release vocabulary", () => {
    expect([...ATTEMPT_RELEASE_RESOURCE_FENCE_CODES]).toEqual([UNPROVEN]);
    // NOT a member of the closed array: its header forbids daemon-only additions
    // and a sibling test is coupled to that membership, so the fence rides the
    // refusal union instead — the same seam the three foreign vocabularies use.
    expect([...ATTEMPT_RELEASE_CODES]).not.toContain(UNPROVEN);
  });

  it("DEFERS a release whose resource set the reducers can still move", () => {
    const fixture = activated("fence-active", "OBSERVED", RESOURCES_PENDING);
    // THE PRODUCER'S OWN ANSWER for this store, per family: the effects side is
    // terminal, so nothing else on the path can be what refuses below.
    const produced = deriveReleaseTerminalEvidence(fixture.store, selector);
    expect(produced.ok && [produced.effectsTerminal, produced.resourcesTerminal])
      .toEqual([true, false]);
    expect(refusalOf(release(fixture))).toEqual(deferral);
    // ZERO ROWS AND ZERO DECISIONS. A handler that wrote a DRAINING row and then
    // refused would sail through a return-value assertion alone.
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    expectNoDurableRow(fixture);
  });

  it("carries FIXED prose, so a refusal leaks no durable identifier", () => {
    const fixture = activated("fence-message", "OBSERVED", RESOURCES_PENDING);
    const refused = refusalWithMessage(release(fixture));
    // The literal, not a shape test: `message` is the one free-text field a
    // refusal may carry, so an interpolated resource id, member count or
    // aggregate id would reach every caller that can see a deferral.
    expect(refused).toEqual({
      code: UNPROVEN, message: "the attempt's durable resource set is not proven terminal",
      refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expect(refused.message).not.toContain(RESOURCE_ROW.resourceId);
    expect(refused.message).not.toContain(ACTIVATION_AGGREGATE);
    expect(refused.message).not.toContain(ATTEMPT_REF);
  });

  it("DEFERS every non-terminal resource SHAPE under one code, writing nothing", () => {
    const cases = [
      {
        // A DURABLY ABSENT SET, reached with no planting at all. The ingress
        // ADMITS a slot declaring the same resource twice, and `admitBind` then
        // refuses it — ATTEMPT_RESOURCE_MEMBER_DUPLICATE. A bind refusal is not an
        // activation refusal by design (`activation-resource-binding.ts`), so the
        // activation is durable while the resource reader answers
        // ATTEMPT_RESOURCE_RECORD_ABSENT. That is the production route to a zero
        // set, and `shapes` below is what proves this fixture really took it.
        fixture: activated(
          "fence-absent", "OBSERVED", RESOURCES_PENDING, [RESOURCE_ROW, { ...RESOURCE_ROW }]),
        label: "absent",
      },
      { fixture: activated("fence-sweep-active", "OBSERVED", RESOURCES_PENDING), label: "active" },
      {
        fixture: activated("fence-quarantined", "OBSERVED", RESOURCES_PENDING),
        label: "quarantined", quarantine: true,
      },
    ];
    // A SWEEP THAT GENERATED NOTHING passes every assertion below vacuously.
    expect(cases.length).toBe(3);
    const shapes: (readonly string[] | string)[] = [];
    for (const { fixture, label, quarantine } of cases) {
      if (quarantine === true) quarantineResources(fixture, label);
      shapes.push(resourceStates(fixture));
      const produced = deriveReleaseTerminalEvidence(fixture.store, selector);
      expect(produced.ok && [produced.effectsTerminal, produced.resourcesTerminal], label)
        .toEqual([true, false]);
      expect(refusalOf(release(fixture)), label).toEqual(deferral);
      expect([durableRowCount(fixture), releaseDecisionCount(fixture)], label).toEqual([0, 0]);
      expectNoDurableRow(fixture);
    }
    // THREE DURABLE SHAPES, not three spellings of one: an absent record, an ACTIVE
    // member and a QUARANTINED one. Without this a seeding slip would collapse the
    // sweep into one case repeated and still pass.
    expect(shapes).toEqual([
      "ATTEMPT_RESOURCE_RECORD_ABSENT", ["ACTIVE"], ["QUARANTINED"],
    ]);
  });

  it("carries an UNREADABLE set under the PRODUCER's code and layer, not the fence's", () => {
    const fixture = activated("fence-unknown", "OBSERVED", RESOURCES_PENDING);
    plantUndecodableResources(fixture);
    const produced = deriveReleaseTerminalEvidence(fixture.store, selector);
    if (produced.ok) throw new Error("the planted resource record was still readable");
    // PINNED AT THE PRODUCER: an exact member of its closed vocabulary.
    expect(produced.code).toBe("RELEASE_TERMINAL_RESOURCE_UNKNOWN");
    expect(RELEASE_TERMINAL_CODES).toContain(produced.code);
    expect(produced.layer).toBe(RELEASE_TERMINAL_EVIDENCE);
    const outcome = release(fixture);
    // AND PINNED AT THE CARRIER, against the producer's own answer for the same
    // store. "One stable outcome" means one outcome SHAPE — never one code
    // collapsing four layers into the fence's, which is what would happen if the
    // fence read `resourcesTerminal` off a coerced UNKNOWN.
    expect(refusalWithMessage(outcome)).toEqual({
      code: produced.code, message: produced.upstream?.code ?? null,
      refusedBy: produced.layer,
    });
    expect(refusalOf(outcome).code).not.toBe(UNPROVEN);
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    expectNoDurableRow(fixture);
  });

  /** An unreadable journal for THIS attempt: an event of the wrong type on the
   *  aggregate the journal reader walks, which `currentEvent` rejects outright.
   *  It exists to give the LATER seam a refusal of its own. */
  function plantUnreadableJournal(fixture: Fixture): void {
    const aggregateId = deriveAttemptJournalAggregateId(fixture.record.activationDigest);
    const payload = encoder.encode("{}");
    fixture.store.commitExpectedVersionDecision({
      commandKind: "test.plant_journal", committedResultBytes: payload,
      correlationId: "plant-journal", decidedAt: DECIDED_AT,
      events: [{ eventId: "plant-journal", eventType: "NotAJournalAppend", payload }],
      expectedVersion: fixture.store.readEvents(aggregateId).length,
      key: { commandId: "plant-journal", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
      requestBytes: payload, targetAggregateId: aggregateId,
    });
  }

  it("answers under the FENCE's layer, not a LATER seam's, when both would refuse", () => {
    // ORDERING IS OTHERWISE INVISIBLE on a deferred path, and that is a measured
    // claim rather than an assumption: `deriveHandoffBinding` writes nothing when
    // the journal is ABSENT (`recordReleaseHandoffBinding` answers written:false),
    // and `releaseWork` and `releaseProviderSlot` are pure kernels. A fence moved
    // past any of them would return the SAME code over the SAME zero rows. This
    // fixture removes that ambiguity by giving the later seam a refusal of its own.
    const fixture = activated("fence-order-handoff", "OBSERVED", RESOURCES_PENDING);
    plantUnreadableJournal(fixture);
    // THE LATER SEAM REALLY WOULD REFUSE — asserted against the production surface
    // for this very store, not against a literal this file chose.
    const handoff = deriveHandoffBinding(fixture.store, fixture.bound, fixture.record);
    expect(handoff.ok).toBe(false);
    expect(!handoff.ok && [handoff.code, handoff.refusedBy])
      .toEqual(["JOURNAL_RECORD_MALFORMED", "DAEMON_JOURNAL_APPEND"]);
    // AND THE FENCE ANSWERS FIRST. DoD 3's other half: this row must not convert an
    // unrelated later refusal into a release outcome, and must not let one stand in
    // for the deferral either.
    expect(refusalOf(release(fixture))).toEqual(deferral);
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    expectNoDurableRow(fixture);
  });

  it("LIFTS once the REAL reconcile command terminalises the set, then releases", () => {
    const fixture = activated("fence-lift", "OBSERVED", RESOURCES_PENDING);
    expect(refusalOf(release(fixture))).toEqual(deferral);
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    // THE AUTHENTICATED PRODUCTION INGRESS, not this suite's direct authority call:
    // the fence must lift for the command a real operator runs.
    const reconciled = runResourceReconcileCommand(fixture.store, {
      commandId: "cmd-reconcile-lift", correlationId: "corr-reconcile-lift",
      payload: {
        activationAggregateId: ACTIVATION_AGGREGATE, disposition: "FAILED", epoch: 1,
        kind: "FAIL", resourceId: RESOURCE_ROW.resourceId,
      },
      principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    });
    expect(reconciled.ok).toBe(true);
    const produced = deriveReleaseTerminalEvidence(fixture.store, selector);
    expect(produced.ok && [produced.effectsTerminal, produced.resourcesTerminal])
      .toEqual([true, true]);
    // AND THE SAME SEAM proceeds to its EXISTING downstream checks with no
    // caller-supplied terminal flag anywhere: the request is the same four keys.
    const released = release(fixture);
    expect(rowOf(released)["outcome"]).toBe("RELEASED");
    expect(rowOf(released)["providerSlotState"]).toBe("RELEASED");
    expect(durableRowCount(fixture)).toBe(1);
  });

  it("leaves a deferred attempt side-effect free however often it is repeated", () => {
    const fixture = activated("fence-idempotent", "OBSERVED", RESOURCES_PENDING);
    const first = refusalOf(release(fixture));
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    const second = refusalOf(release(fixture));
    // IDENTICAL, and identical to the fence's own answer: a second deferral must
    // not drift into a replay, a NO_OP or a row.
    expect(second).toEqual(first);
    expect(second).toEqual(deferral);
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    expectNoDurableRow(fixture);
  });

  it("does NOT weaken the non-resumable cleanup path: the fence is resource-scoped", () => {
    // The fence reads `resourcesTerminal` and NOTHING else. An attempt whose
    // resources are terminal but whose EFFECTS are not still reaches the kernel and
    // still drains — which is also what proves the fence did not silently become a
    // fence over `releasable`. The DRAINING block above is the fuller control.
    const fixture = activated("fence-scope-effects", "OBSERVED", EFFECTS_PENDING);
    const produced = deriveReleaseTerminalEvidence(fixture.store, selector);
    expect(produced.ok && [produced.effectsTerminal, produced.resourcesTerminal])
      .toEqual([false, true]);
    const written = release(fixture);
    expect(rowOf(written)["outcome"]).toBe("DRAINING");
    expect(durableRowCount(fixture)).toBe(1);
  });
});

/**
 * THE VERSION FENCE, over a store that really does move under the release.
 *
 * `recordAttemptRelease` is fully synchronous, so no in-process interleaving is
 * possible between the terminality derivation and `commitRelease`. The residual
 * window belongs to a SECOND CONNECTION on the file-backed store — another daemon,
 * a concurrent `resource.reconcile`, a replay — and this block interposes exactly
 * that: a real durable append to the attempt's own resource aggregate, landed
 * between the fence's version capture and the commit it guards.
 */
describe("attempt release disposition — a stale terminal read authorises nothing", () => {
  const selector = Object.freeze({ attemptRef: ATTEMPT_REF, projectId: PROJECT_ID });
  const RESOURCE_AGGREGATE = deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE);

  /**
   * A store that DELEGATES every call to the real file-backed one and, after
   * answering the FIRST `getAggregateVersion` for the resource aggregate, lets a
   * second writer in. The order is load-bearing: the capture must return the
   * PRE-write version, exactly as a concurrent connection would leave it, or the
   * re-read would see the same number and the arm would test nothing.
   *
   * `Reflect.get` with the real store as the receiver keeps its private fields
   * reachable; nothing here stubs a version number or fabricates a state.
   */
  function interposing(store: SqliteEventStore, onCaptured: () => void): SqliteEventStore {
    let fired = false;
    return new Proxy(store, {
      get(base: SqliteEventStore, key: string | symbol): unknown {
        const value: unknown = Reflect.get(base, key, base);
        if (typeof value !== "function") return value;
        if (key !== "getAggregateVersion") return value.bind(base);
        return (aggregateId: string): number => {
          const version = base.getAggregateVersion(aggregateId);
          if (!fired && aggregateId === RESOURCE_AGGREGATE) { fired = true; onCaptured(); }
          return version;
        };
      },
    });
  }

  /** A durable append onto the resource aggregate, committed through the store's
   *  own decision writer. It is PLANTED rather than reconciled for a MEASURED
   *  reason, asserted by the arm below: once the set is proven terminal every
   *  reducer the `resource.reconcile` wire can reach refuses it, so no production
   *  command can move that aggregate. The guard still has to hold against a writer
   *  this row cannot enumerate — a second daemon, a replay, a later producer. */
  function appendResourceEvent(store: SqliteEventStore): void {
    const payload = encoder.encode("{}");
    store.commitExpectedVersionDecision({
      commandKind: "test.interposed_resource_write", committedResultBytes: payload,
      correlationId: "corr-interposed", decidedAt: DECIDED_AT,
      events: [{
        eventId: "interposed-resources", eventType: ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
        payload,
      }],
      expectedVersion: store.readEvents(RESOURCE_AGGREGATE).length,
      key: { commandId: "cmd-interposed", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
      requestBytes: payload, targetAggregateId: RESOURCE_AGGREGATE,
    });
  }

  it("REFUSES when the resource aggregate moves between the read and the commit", () => {
    const fixture = activated("fence-version-race");
    // THE PREMISE: this attempt is fully terminal, so nothing else on the path
    // refuses and the release would otherwise land a RELEASED row.
    const produced = deriveReleaseTerminalEvidence(fixture.store, selector);
    expect(produced.ok && [produced.effectsTerminal, produced.resourcesTerminal])
      .toEqual([true, true]);
    const before = fixture.store.getAggregateVersion(RESOURCE_AGGREGATE);
    let reconciled: unknown = null;
    const raced = interposing(fixture.store, () => {
      // A REAL production command is attempted in the window FIRST, and its answer
      // is asserted below: this is the measurement that says a proven-terminal set
      // is frozen against the reconcile wire, kept in the committed suite rather
      // than in a transcript.
      reconciled = runResourceReconcileCommand(fixture.store, {
        commandId: "cmd-reconcile-race", correlationId: "corr-reconcile-race",
        payload: {
          activationAggregateId: ACTIVATION_AGGREGATE, disposition: "FAILED", epoch: 1,
          kind: "FAIL", resourceId: RESOURCE_ROW.resourceId,
        },
        principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
      });
      appendResourceEvent(fixture.store);
    });
    const outcome = recordAttemptRelease(
      raced, fixture.bound, fixture.record, settledRequest());
    // THE PRODUCTION COMMAND REALLY RAN AND REALLY REFUSED — a terminal member is
    // neither confirmable nor failable, so `applyAttemptResourceReport` carries the
    // scheduler's own rejection.
    expect(reconciled).not.toBeNull();
    expect((reconciled as { ok: boolean }).ok).toBe(false);
    expect((reconciled as { code: string }).code).toBe("ATTEMPT_RESOURCE_SET_REFUSED");
    // THE AGGREGATE REALLY MOVED, read out of the store rather than assumed.
    expect(fixture.store.getAggregateVersion(RESOURCE_AGGREGATE)).toBe(before + 1);
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_RESOURCES_UNPROVEN", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    // AND NOTHING WAS WRITTEN. The guard is the last statement before the commit,
    // so an all-or-none refusal has to mean zero rows AND zero decisions.
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    expectNoDurableRow(fixture);
  });

  it("RELEASES over the SAME delegating store when nothing moves — the control", () => {
    // Without this, a proxy that broke every store call would produce the refusal
    // above for the wrong reason, and the arm would read as a pass.
    const fixture = activated("fence-version-control");
    const before = fixture.store.getAggregateVersion(RESOURCE_AGGREGATE);
    const quiet = interposing(fixture.store, () => undefined);
    const outcome = recordAttemptRelease(
      quiet, fixture.bound, fixture.record, settledRequest());
    expect(rowOf(outcome)["outcome"]).toBe("RELEASED");
    expect(fixture.store.getAggregateVersion(RESOURCE_AGGREGATE)).toBe(before);
    expect(durableRowCount(fixture)).toBe(1);
  });
});

/**
 * task-06835dfad0aa4ecd9801d760fc559ee8 — THE WINDOW THE RECHECK CANNOT SEE.
 *
 * The block above interposes BEFORE the recheck at `attempt-release-disposition.ts`
 * :258-260, so the recheck catches it and the arm is green with a single-leg commit.
 * That arm proves nothing about R3-8 and is not cited as coverage here. The window
 * the third human review measured is the one AFTER the recheck and BEFORE the commit:
 * the release builds its handoff, reads the source and resource versions, rechecks
 * them, and only THEN commits the release aggregate alone at expectedVersion 0. A
 * second connection on the file-backed store that moves any of those sources in that
 * window produces a DAEMON_VERIFIED row over stale evidence — permanently, because
 * expectedVersion 0 means the row can never be corrected.
 *
 * EVERY ARM HOOKS THE COMMIT CALL, NOT A READ. A read-shaped interposer placed after
 * the handoff build cannot fire: the builder's sequence is initial capture, journal
 * reader, final horizon capture, and disposition's next read is the RESOURCE, so a
 * hook phrased as "the first journal read after the build" never runs and its arm
 * passes vacuously. The proxy below fires when the store is asked to commit the
 * RELEASE aggregate — under either commit shape, so the same body is red before the
 * fence legs land and green after — and every arm asserts the hook actually fired.
 */
describe("attempt release disposition — task-06835dfa fences the post-recheck window", () => {
  const selector = Object.freeze({ attemptRef: ATTEMPT_REF, projectId: PROJECT_ID });
  const RESOURCE_AGGREGATE = deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE);
  const DISPATCH_AGGREGATE = deriveDispatchAggregateId(ACTIVATION_AGGREGATE);
  const BINDING_AGGREGATE = deriveReleaseHandoffAggregateId(ACTIVATION_AGGREGATE);
  const RELEASE_AGGREGATE = deriveAttemptReleaseAggregateId(ACTIVATION_AGGREGATE);
  const FENCE_LAYER = "DAEMON_ATTEMPT_RELEASE_FENCE";

  /** Fired counter, so an arm can prove its window really opened. A silent no-op
   *  interposer produces a green arm that tested nothing at all. */
  interface Hook { fired: number }

  /**
   * A store that DELEGATES everything and, immediately before the RELEASE commit is
   * handed to the real store, lets a second writer in. Both commit shapes are
   * recognised on purpose: the single-leg call names the release aggregate in
   * `targetAggregateId`, the multi-leg call names it in `legs[0].aggregateId`. The
   * arm is therefore identical before and after the fix, and its red is the finding.
   */
  function atCommit(
    store: SqliteEventStore, hook: Hook, interpose: () => void,
  ): SqliteEventStore {
    const targets = (input: unknown): boolean => {
      if (typeof input !== "object" || input === null) return false;
      const record = input as Record<string, unknown>;
      if (record["targetAggregateId"] === RELEASE_AGGREGATE) return true;
      const legs: unknown = record["legs"];
      if (!Array.isArray(legs)) return false;
      const primary: unknown = legs[0];
      return typeof primary === "object" && primary !== null
        && (primary as Record<string, unknown>)["aggregateId"] === RELEASE_AGGREGATE;
    };
    return new Proxy(store, {
      get(base: SqliteEventStore, key: string | symbol): unknown {
        const value: unknown = Reflect.get(base, key, base);
        if (typeof value !== "function") return value;
        if (key !== "commitExpectedVersionDecision"
          && key !== "commitExpectedVersionDecisionLegs") return value.bind(base);
        return (input: unknown): unknown => {
          if (targets(input)) { hook.fired += 1; interpose(); }
          return (value as (given: unknown) => unknown).call(base, input);
        };
      },
    });
  }

  /** A durable append onto the attempt's own resource aggregate, committed through
   *  the store's own decision writer. PLANTED for the measured reason the block above
   *  asserts: once the set is proven terminal every reducer `resource.reconcile` can
   *  reach refuses it, so no production command can move that aggregate — and the
   *  fence still has to hold against a writer this row cannot enumerate. */
  function moveResource(store: SqliteEventStore): void {
    const payload = encoder.encode("{}");
    store.commitExpectedVersionDecision({
      commandKind: "test.post_recheck_resource_write", committedResultBytes: payload,
      correlationId: "corr-post-recheck-resource", decidedAt: DECIDED_AT,
      events: [{
        eventId: "post-recheck-resources", eventType: ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
        payload,
      }],
      expectedVersion: store.readEvents(RESOURCE_AGGREGATE).length,
      key: {
        commandId: "cmd-post-recheck-resource", principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
      },
      requestBytes: payload, targetAggregateId: RESOURCE_AGGREGATE,
    });
  }

  /**
   * WHAT THE REGISTERED JOURNAL INGRESS ANSWERED, recorded rather than thrown.
   *
   * `commitRelease` wraps its store call in a blanket `catch`, so an interposer that
   * THROWS inside the window is swallowed whole and the arm then fails on a later
   * assertion for the wrong reason — an ingress refusal reads exactly like a fence
   * that did not fire. Measured here: a `decidedAt` outside the lease window came
   * back FOUNDATION_BINDING_LEASE_EXPIRED and the arm saw only an unmoved aggregate.
   */
  let journalIngress = "NEVER_CALLED";

  /** A REAL production journal append through the REGISTERED `journal.append` ingress
   *  — never a planted event, so the source really moves the way a second daemon
   *  would move it. `decidedAt` is DERIVED from the durable lease deadline, which is
   *  the only instant the effect-session binding admits. */
  function moveJournal(fixture: Fixture): void {
    const decidedAt =
      new Date(fixture.record.lease.serverWallDeadline * 1_000).toISOString();
    const outcome = runJournalAppendCommand(fixture.store, encoder.encode(JSON.stringify({
      commandId: "cmd-post-recheck-journal", correlationId: "corr-post-recheck-journal",
      decidedAt, expectedVersion: 0, kind: JOURNAL_APPEND_COMMAND_KIND,
      payload: {
        attemptAggregateId: ACTIVATION_AGGREGATE,
        effectId: fixture.record.effectIntent.intentId,
        entries: [handoffJournalEntry("dead-end-post-recheck")],
      },
      principalId: SESSION_ID, projectId: PROJECT_ID,
      schemaVersion: JOURNAL_APPEND_SCHEMA_VERSION,
    })));
    journalIngress = outcome.ok ? "ACCEPTED" : `${outcome.code}@${outcome.refusedBy}`;
  }

  /** A durable append onto the DISPATCH stream this attempt is pinned to. */
  function moveDispatch(store: SqliteEventStore): void {
    const payload = encoder.encode("{}");
    store.commitExpectedVersionDecision({
      commandKind: "test.post_recheck_dispatch_write", committedResultBytes: payload,
      correlationId: "corr-post-recheck-dispatch", decidedAt: DECIDED_AT,
      events: [{
        eventId: "post-recheck-dispatch", eventType: "TestPostRecheckDispatchMoved", payload,
      }],
      expectedVersion: store.readEvents(DISPATCH_AGGREGATE).length,
      key: {
        commandId: "cmd-post-recheck-dispatch", principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
      },
      requestBytes: payload, targetAggregateId: DISPATCH_AGGREGATE,
    });
  }

  /** A SECOND release caller's handoff binding, appended after this call derived its
   *  own. The binding aggregate is appendable (`expectedVersion: readEvents().length`)
   *  and its reader is LATEST WINS, so two releases can both land a binding before
   *  either wins the release primary at expectedVersion 0 — the live authority hole
   *  the approved plan's fence subset would have shipped. */
  function moveBinding(fixture: Fixture): void {
    const rival: FoundationAttemptBound = Object.freeze({
      ...fixture.bound, commandId: "cmd-rival-release", correlationId: "corr-rival-release",
    });
    const derived = deriveHandoffBinding(fixture.store, rival, fixture.record);
    if (!derived.ok) throw new Error(`rival binding refused: ${derived.code}`);
  }

  /** The DECISIONS this command landed anywhere, keyed by command kind rather than by
   *  the release target: a REJECTED multi-leg decision records the STALE LEG in
   *  `targetAggregateId`, so a release-target filter reads zero for exactly the case
   *  these arms are about. */
  function releaseCommandDecisions(
    fixture: Fixture,
  ): readonly { readonly resultCode: string; readonly targetAggregateId: string }[] {
    const found: { resultCode: string; targetAggregateId: string }[] = [];
    for (let cursor = 0n; ; ) {
      const page = fixture.store.readCommandDecisionsAfter(cursor, 100);
      for (const item of page.items) {
        if (item.commandKind !== ATTEMPT_RELEASE_COMMAND_KIND) continue;
        found.push({ resultCode: item.resultCode, targetAggregateId: item.targetAggregateId });
      }
      if (!page.hasMore || page.nextCursor === null) return found;
      cursor = page.nextCursor;
    }
  }

  /** Every window arm demands the same things, so a partial claim cannot pass: the
   *  hook fired, the aggregate really moved, the refusal is THIS code from the fence
   *  layer, and the release aggregate holds zero rows and zero decisions. */
  function expectFenced(
    fixture: Fixture, hook: Hook, outcome: AttemptReleaseOutcome, code: string,
    aggregateId: string, movedTo: number,
  ): void {
    expect(hook.fired).toBe(1);
    expect(fixture.store.getAggregateVersion(aggregateId)).toBe(movedTo);
    expect(refusalOf(outcome)).toEqual({ code, refusedBy: FENCE_LAYER });
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    expectNoDurableRow(fixture);
    // The store REJECTED under its own conflict code, naming the STALE leg as the
    // decision's target — the aggregate that moved, never the release primary.
    const rejected = releaseCommandDecisions(fixture)
      .filter((decision) => decision.resultCode === "EXPECTED_VERSION_CONFLICT");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.targetAggregateId).toBe(aggregateId);
  }

  it("W1 REFUSES when the RESOURCE aggregate moves after the recheck", () => {
    const fixture = activated("post-recheck-resource");
    const produced = deriveReleaseTerminalEvidence(fixture.store, selector);
    expect(produced.ok && [produced.effectsTerminal, produced.resourcesTerminal])
      .toEqual([true, true]);
    const before = fixture.store.getAggregateVersion(RESOURCE_AGGREGATE);
    const hook: Hook = { fired: 0 };
    const raced = atCommit(fixture.store, hook, () => { moveResource(fixture.store); });
    const outcome = recordAttemptRelease(raced, fixture.bound, fixture.record, settledRequest());
    expectFenced(fixture, hook, outcome, "ATTEMPT_RELEASE_RESOURCE_FENCE_STALE",
      RESOURCE_AGGREGATE, before + 1);
  });

  it("W2 REFUSES when a HANDOFF SOURCE moves after the build", () => {
    const fixture = activated("post-recheck-journal");
    const journal = deriveAttemptJournalAggregateId(fixture.record.activationDigest);
    const before = fixture.store.getAggregateVersion(journal);
    const hook: Hook = { fired: 0 };
    const raced = atCommit(fixture.store, hook, () => { moveJournal(fixture); });
    const outcome = recordAttemptRelease(raced, fixture.bound, fixture.record, settledRequest());
    // THE INGRESS REALLY ACCEPTED. Without this the arm cannot tell a fired fence
    // from a refused append whose throw `commitRelease` swallowed.
    expect(journalIngress).toBe("ACCEPTED");
    // A DISTINCT code from W1's: a moved evidence source and a moved resource set
    // demand different repairs, so they may not collapse into one answer.
    expectFenced(fixture, hook, outcome, "ATTEMPT_RELEASE_SOURCE_FENCE_STALE",
      journal, before + 1);
  });

  it("W3 REFUSES when the DISPATCH stream moves after its read", () => {
    const fixture = activated("post-recheck-dispatch");
    const before = fixture.store.getAggregateVersion(DISPATCH_AGGREGATE);
    const hook: Hook = { fired: 0 };
    const raced = atCommit(fixture.store, hook, () => { moveDispatch(fixture.store); });
    const outcome = recordAttemptRelease(raced, fixture.bound, fixture.record, settledRequest());
    expectFenced(fixture, hook, outcome, "ATTEMPT_RELEASE_ATTEMPT_FENCE_STALE",
      DISPATCH_AGGREGATE, before + 1);
  });

  it("W4 REFUSES when a SECOND caller appends a handoff BINDING after this one", () => {
    const fixture = activated("post-recheck-binding");
    const hook: Hook = { fired: 0 };
    const raced = atCommit(fixture.store, hook, () => { moveBinding(fixture); });
    const outcome = recordAttemptRelease(raced, fixture.bound, fixture.record, settledRequest());
    // TWO bindings now stand and the reader takes the LATEST, so the {digest, ref}
    // this release derived is no longer the one a consumer would read.
    expectFenced(fixture, hook, outcome, "ATTEMPT_RELEASE_BINDING_FENCE_STALE",
      BINDING_AGGREGATE, 2);
  });
});

/**
 * task-06835dfad0aa4ecd9801d760fc559ee8 — THE CONTROL, THE REPLAY, AND THE ROSTER.
 *
 * WHY THE ROSTER IS GRADED HERE AND NOT READ BACK OUT OF THE STORE. @moe/store
 * publishes no leg-roster reader: `SqliteEventStore` exposes `getCommandDecision`
 * only, `CommandDecisionRecord` omits the roster, and `loadVerifiedDecisionLegRoster`
 * is internal and unexported. This row does not add one — a second authority API
 * bought purely to be asserted is scope, not proof. What is asserted instead is the
 * PAIR: the legs that ACTUALLY REACHED the store (captured off the production call,
 * so no test helper reimplements the composition) AND the store's own acceptance of
 * that decision through `getCommandDecision`. Together they establish what a roster
 * read was meant to — this exact fence set was composed, and the store committed
 * under it. The composer's own contract is graded separately and directly in
 * `attempt-release-fence-legs.test.ts`.
 */
describe("attempt release disposition — task-06835dfa composes exactly seven fences", () => {
  const RELEASE_AGGREGATE = deriveAttemptReleaseAggregateId(ACTIVATION_AGGREGATE);

  interface Seen {
    /** Every multi-leg commit aimed at the release aggregate, in call order. */
    readonly legs: { aggregateId: string; events: readonly unknown[]; expectedVersion: number }[][];
  }

  /** A store that DELEGATES everything and copies out the legs of each release
   *  commit. It moves nothing: this is the quiet control the window arms need beside
   *  them, since a proxy that broke every call would produce refusals for the wrong
   *  reason and the whole block would read as a pass. */
  function watching(store: SqliteEventStore, seen: Seen): SqliteEventStore {
    return new Proxy(store, {
      get(base: SqliteEventStore, key: string | symbol): unknown {
        const value: unknown = Reflect.get(base, key, base);
        if (typeof value !== "function") return value;
        if (key !== "commitExpectedVersionDecisionLegs") return value.bind(base);
        return (input: unknown): unknown => {
          const legs = (input as { legs?: unknown }).legs;
          if (Array.isArray(legs) && (legs[0] as { aggregateId?: unknown } | undefined)
            ?.aggregateId === RELEASE_AGGREGATE) {
            seen.legs.push(legs as Seen["legs"][number]);
          }
          return (value as (given: unknown) => unknown).call(base, input);
        };
      },
    });
  }

  /**
   * THE SEVEN AGGREGATES THIS RELEASE MUST FENCE, each derived HERE through its own
   * production derivation from durable facts — never copied out of the legs the
   * composer produced. An expectation read off the value under test is a fixed point
   * that no mis-mapping can fail.
   */
  function expectedFences(fixture: Fixture, label: string): ReadonlySet<string> {
    const binding = readFoundationActivationByAttempt(fixture.store, PROJECT_ID, ATTEMPT_REF);
    if (binding.status !== "BOUND") throw new Error(`attempt unbound: ${binding.status}`);
    const digest = fixture.record.activationDigest;
    return new Set([
      ACTIVATION_AGGREGATE,
      deriveDispatchAggregateId(ACTIVATION_AGGREGATE),
      deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE),
      deriveAttemptStepAggregateId(digest),
      deriveAttemptJournalAggregateId(digest),
      deriveProviderRunAggregateId({
        attemptRef: binding.attemptId, effectIntentId: binding.effectIntentId,
        epoch: binding.epoch, provider: "claude", runRef: `run-${label}`,
      }),
      deriveReleaseHandoffAggregateId(ACTIVATION_AGGREGATE),
    ]);
  }

  it("CONTROL: releases over the same delegating store and fences all seven", () => {
    const label = "fence-roster-control";
    const fixture = activated(label);
    const seen: Seen = { legs: [] };
    const quiet = watching(fixture.store, seen);
    const outcome = recordAttemptRelease(quiet, fixture.bound, fixture.record, settledRequest());
    expect(rowOf(outcome)["outcome"]).toBe("RELEASED");
    // ONE ROW AND ONE ACCEPTED DECISION on the release aggregate. A row count alone
    // cannot see a decision committed with no event.
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);

    // EXACTLY ONE multi-leg commit was issued, and it carried EIGHT legs.
    expect(seen.legs).toHaveLength(1);
    const legs = seen.legs[0] ?? [];
    expect(legs).toHaveLength(8);
    // legs[0] APPENDS at version zero; the release aggregate stays single-row.
    expect(legs[0]?.aggregateId).toBe(RELEASE_AGGREGATE);
    expect(legs[0]?.expectedVersion).toBe(0);
    expect(legs[0]?.events).toHaveLength(1);
    // legs[1..7] are READ-ONLY FENCES: exactly-empty events, which is the form the
    // store documents as granting no receipt authority.
    const fences = legs.slice(1);
    expect(fences).toHaveLength(7);
    let swept = 0;
    for (const fence of fences) {
      swept += 1;
      expect(fence.events).toEqual([]);
      // AND EVERY FENCE CARRIES THE VERSION THAT AGGREGATE ACTUALLY STANDS AT — the
      // version this call READ. A roster with the right ids and wrong versions passes
      // a presence check and fences nothing.
      expect(fixture.store.getAggregateVersion(fence.aggregateId), fence.aggregateId)
        .toBe(fence.expectedVersion);
    }
    // THE SWEEP REALLY GENERATED SEVEN CASES. A zero-case loop passes vacuously.
    expect(swept).toBe(7);

    // SET-EQUALITY IN BOTH DIRECTIONS against ids derived independently above.
    // Forward alone would stay green while a fence silently vanished; reverse alone
    // would stay green while one was quietly added.
    const composed = new Set(fences.map(({ aggregateId }) => aggregateId));
    const expected = expectedFences(fixture, label);
    expect(composed.size).toBe(7);
    for (const aggregateId of expected) expect(composed.has(aggregateId), aggregateId).toBe(true);
    for (const aggregateId of composed) expect(expected.has(aggregateId), aggregateId).toBe(true);
    // NO FENCE MAY NAME THE PRIMARY: the store refuses a duplicate leg outright.
    expect(composed.has(RELEASE_AGGREGATE)).toBe(false);

    // AND THE STORE ACCEPTED THAT DECISION, read back through the ONE public surface
    // that exists. This is the half a composer-only assertion cannot supply.
    const decision = fixture.store.getCommandDecision({
      commandId: `${fixture.bound.commandId}:RELEASED`,
      principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    });
    expect(decision?.effectDisposition).toBe("EFFECTS_COMMITTED");
    expect(decision?.commandKind).toBe(ATTEMPT_RELEASE_COMMAND_KIND);
    expect(decision?.targetAggregateId).toBe(RELEASE_AGGREGATE);
    expect(decision?.expectedVersion).toBe(0);
  });

  it("REPLAY: answers NO_OP from the standing row and adds zero events and zero fences", () => {
    const fixture = activated("fence-roster-replay");
    const first = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(rowOf(first)["outcome"]).toBe("RELEASED");
    const seen: Seen = { legs: [] };
    const quiet = watching(fixture.store, seen);
    const again = recordAttemptRelease(quiet, fixture.bound, fixture.record,
      settledRequest({ reason: "WORK_CANCEL" }));
    // THE ANSWER is NO_OP while the ROW keeps saying RELEASED: the standing row is
    // returned untouched, so no second truth about one release is composed. Reading
    // the row's own field for the answer would confuse the two.
    expect(again.ok && again.outcome).toBe("NO_OP");
    expect(rowOf(again)["outcome"]).toBe("RELEASED");
    expect(rowOf(again)["reason"]).toBe("WORK_RELEASE_OR_PAUSE");
    // ZERO FENCES because the kernel answered NO_OP BEFORE any commit was composed —
    // a replay that re-fenced would refuse on a source that legitimately moved since.
    expect(seen.legs).toEqual([]);
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);
  });

  it("REFUSES under the FENCE layer when a fence head cannot be READ", () => {
    // A head this daemon could not read is a DIFFERENT fault from a resource set
    // that is not proven terminal, and the terminality code would send an operator
    // to the wrong ledger. Nothing moved here — the store simply would not answer —
    // so the code names an incomposable roster rather than a race.
    const fixture = activated("fence-head-unreadable");
    const dispatch = deriveDispatchAggregateId(ACTIVATION_AGGREGATE);
    let denied = 0;
    const blind = new Proxy(fixture.store, {
      get(base: SqliteEventStore, key: string | symbol): unknown {
        const value: unknown = Reflect.get(base, key, base);
        if (typeof value !== "function") return value;
        if (key !== "getAggregateVersion") return value.bind(base);
        return (aggregateId: string): number => {
          if (aggregateId === dispatch) { denied += 1; throw new Error("HEAD_UNREADABLE"); }
          return base.getAggregateVersion(aggregateId);
        };
      },
    });
    const outcome = recordAttemptRelease(blind, fixture.bound, fixture.record, settledRequest());
    // THE STORE REALLY REFUSED THE READ; a proxy that never fired would leave this
    // arm asserting a refusal it did not cause.
    expect(denied).toBeGreaterThan(0);
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT", refusedBy: "DAEMON_ATTEMPT_RELEASE_FENCE",
    });
    // FAIL-CLOSED: no row, no decision, and no handoff binding composed either,
    // because the heads are read BEFORE the binding is derived.
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    expect(fixture.store.getAggregateVersion(
      deriveReleaseHandoffAggregateId(ACTIVATION_AGGREGATE))).toBe(0);
  });

  it("DRAINING stays a distinct outcome and still lands exactly one row", () => {
    // The fourth outcome, BINDING_WRITTEN_RELEASE_REFUSED, belongs to the
    // finalization service and is re-asserted against this commit shape in
    // `attempt-finalization-service.test.ts`.
    const fixture =
      activated("fence-roster-draining", "UNOBSERVED", UNOBSERVED_TERMINALITY);
    const seen: Seen = { legs: [] };
    const quiet = watching(fixture.store, seen);
    const outcome = recordAttemptRelease(quiet, fixture.bound, fixture.record, settledRequest());
    expect(outcome.ok && outcome.outcome).toBe("DRAINING");
    expect(rowOf(outcome)["outcome"]).toBe("DRAINING");
    // A DRAINING release is committed through the SAME one-decision shape, so it is
    // fenced exactly as a RELEASED one is.
    expect(seen.legs).toHaveLength(1);
    expect(seen.legs[0]).toHaveLength(8);
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);
  });
});
