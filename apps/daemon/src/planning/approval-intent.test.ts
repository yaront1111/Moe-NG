import { RUNTIME_COMMAND_ENVELOPE_VERSION, decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import { validateApprovalRecord } from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { humanReviewWitness, readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import type { HumanReviewWitness } from "../bootstrap/bootstrap-ledger.js";
import { legacyProposedStore } from "../bootstrap/bootstrap-journey-fixtures.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import { deriveBudgetAggregateId } from "../budget/budget-ledger-contracts.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { runApprovalIntentEdge } from "../daemon-command-edges.js";
import { isSessionDigest } from "../identity/session-authority-protocol.js";
import { buildReplayMarkerDecisionLeg } from "../identity/session-authority-replay-marker.js";
import { replayAggregateId } from "../identity/session-authority-store.js";
import { burnStepUpAuthRef, deriveStepUpAuthRef } from "./approval-step-up.js";
import {
  GRAPH_REVISION_REF,
  BUDGET_ACCOUNT_REF,
  GOAL_ID,
  PROJECT_ID,
  RUN_ID,
  bootstrapSequence,
  closeStores,
  driveThrough,
  envelope,
  finalizeChain,
  openStore,
  sealedPlanningChain,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { planningAuthorityAggregateId } from "./planning-authority-persistence.js";
import { activeGraphSlotAggregateId } from "./active-graph-slot.js";
import {
  assembleActivationInput,
  commitIntentActivation,
  composeIntentApprovalRecord,
} from "./approval-intent-activation.js";
import { observeApprovalIntentSourceFences }
  from "./approval-intent-source-fences.js";
import {
  APPROVAL_INTENT_PAYLOAD_KEYS,
  APPROVAL_MISSING_FACT_CODES,
  readApprovalIntent,
  readApprovalIntentSources,
  runApprovalIntentCommand,
} from "./approval-intent.js";
import { readApprovalRecordFacts } from "./approval-record-facts.js";
import { runPolicyAggregateId } from "./run-policy-record.js";

/**
 * `approval.decide_intent` — the daemon-owned approval seam (task-6646f888).
 *
 * WHAT THIS SUITE IS THE OPERAND OF. The shipped `approval.decide` path takes the ACTIVATION
 * WITNESS and the APPROVAL RECORD off the caller's payload (`daemon-command-graph-approve.ts:94-98`,
 * `planning-services.ts:230-234`), so the caller authors the very bytes that say a human approved.
 * Task rail 1 — "human authority is not delegable" — makes that an inversion, and this seam is
 * where it is closed: the caller supplies INTENT ONLY and the daemon derives the rest from the
 * durable PLAN_REVIEW run and the authenticated operator session.
 *
 * WHY THE ARMS RUN UNDER SPEED APPROVAL MODE, and it is a divergence fixture rather than a
 * convenience. `bootstrap-test-fixtures.ts:34-35` sets `MOE_APPROVAL_MODE=SPEED` with a stated
 * zero delay, so `decideApprovalAuthority` returns PROCEED for a gate-free run and the POLICY
 * cannot be what refuses a witness-less request. Under that mode this seam's own human-witness
 * fence is the ONLY mechanism that can answer, which is exactly the condition epic rail 7(A)
 * asks for: loosen that fence by one and the AGENT arm goes green while nothing else notices.
 * Under REQUIRE_HUMAN the policy would emit the same tuple and the arm would prove only that
 * the system refuses, not that this seam refuses.
 */

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const BODIES_EVENT_TYPE = "PlanningAuthorityBodiesSealed";
const SECOND_RUN_ID = "run-2";

afterEach(() => {
  closeStores();
});

/** A plain own-property read: no getter runs and a hostile prototype contributes nothing. */
const own = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

interface Refusal {
  readonly code: string;
  readonly layer: string;
}

const refusalOf = (outcome: unknown): Refusal => ({
  code: String(own(outcome, "code")),
  layer: String(own(outcome, "refusedBy")),
});

/** The world the shipped journey leaves just BEFORE its approval: sealed, PLAN_REVIEW, undecided. */
function reviewableStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "approval.decide");
  return store;
}

const OPERATOR = "principal-1";

/** The registry-minted witness, in the exact shape `daemon-command-registry.ts:200-202` freezes. */
const witness = Object.freeze({ principalId: OPERATOR });

/** The server facts the seam hands the burn: identity of the approving principal and project. */
const BURN_FACTS = Object.freeze({
  decidedAt: "2026-08-08T00:00:00.000Z", principalId: OPERATOR, projectId: PROJECT_ID,
});

const INTENT = Object.freeze({
  decision: "APPROVE",
  decisionReason: "the plan is sound",
  dependencyChanges: { additions: [], challenges: [], removals: [] },
  runId: RUN_ID,
});

function dispatch(
  store: SqliteEventStore,
  payload: JsonObject,
  overrides: {
    commandId?: string;
    expectedVersion?: number;
    humanReview?: HumanReviewWitness | undefined;
    principalId?: string;
    targetAggregateId?: string;
  } = {},
): ReturnType<typeof runApprovalIntentCommand> {
  const commandId = overrides.commandId ?? "cmd-approval.decide_intent";
  const runId = own(payload, "runId");
  const targetAggregateId = overrides.targetAggregateId
    ?? (typeof runId === "string" ? runId : RUN_ID);
  return runApprovalIntentCommand({
    commandId,
    correlationId: "corr-1",
    decidedAt: "2026-08-08T00:00:00.000Z",
    expectedVersion: overrides.expectedVersion
      ?? store.getAggregateVersion(typeof runId === "string" ? runId : RUN_ID),
    humanReview: "humanReview" in overrides ? overrides.humanReview : witness,
    payload,
    principalId: overrides.principalId ?? OPERATOR,
    projectId: PROJECT_ID,
    store,
    targetAggregateId,
  });
}

function reviewedDispatch(
  store: SqliteEventStore,
  commandId: string,
  payload: JsonObject = { ...INTENT },
): ReturnType<typeof runApprovalIntentCommand> {
  return dispatch(store, payload, {
    commandId,
    humanReview: humanReviewWitness(OPERATOR, commandId),
  });
}

function replayRef(commandId: string): string {
  const derived = deriveStepUpAuthRef(humanReviewWitness(OPERATOR, commandId), RUN_ID);
  if (!derived.ok) throw new Error(`replay reference refused: ${derived.code}`);
  return derived.stepUpAuthRef;
}

function durableApprovalRecords(store: SqliteEventStore) {
  return store.readEvents(GOAL_ID)
    .filter((event) => event.eventType === "GoalExecutionEnabled")
    .map((event) => {
      const decoded = decodeBoundedJsonBytes(event.payload);
      if (!decoded.ok) throw new Error(`durable activation payload refused: ${decoded.code}`);
      const record = validateApprovalRecord(own(decoded.value, "approval"));
      if (record === undefined) throw new Error("durable approval did not pass the public reader");
      return record;
    });
}

function withStoreFacade(
  store: SqliteEventStore,
  override: (property: PropertyKey) => unknown,
): SqliteEventStore {
  return new Proxy(store, {
    get(target, property) {
      const replacement = override(property);
      if (replacement !== undefined) return replacement;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function unreadableSources(store: SqliteEventStore) {
  let reads = 0;
  const facade = withStoreFacade(store, (property) => property === "readEvents"
    ? (_aggregateId: string) => {
        reads += 1;
        return [];
      }
    : undefined);
  return { reads: () => reads, store: facade };
}

/**
 * Nth-read transient fault injection: storage still supplies real bytes and every production
 * reader/validator runs. A stable SQLite tamper is correctly stopped earlier as STORE_CORRUPT by
 * the decision-leg roster, so it cannot isolate the validator fence this arm grades.
 */
function criteriaValidatorFault(store: SqliteEventStore) {
  const authorityId = planningAuthorityAggregateId(RUN_ID);
  let reads = 0;
  const facade = withStoreFacade(store, (property) => property === "readEvents"
    ? (aggregateId: string) => {
        const events = store.readEvents(aggregateId);
        if (aggregateId !== authorityId || ++reads !== 4) return events;
        return events.map((event) => event.eventType !== BODIES_EVENT_TYPE
          ? event
          : {
              ...event,
              payload: encoder.encode(JSON.stringify({
                ...(JSON.parse(decoder.decode(event.payload)) as Record<string, unknown>),
                criteriaDigest: "not-a-digest",
              })),
            });
      }
    : undefined);
  return { reads: () => reads, store: facade };
}

/**
 * Nth-read transient drift between decide-time derivation and activation bind-back. A stable
 * world cannot differ here: both production sides read the same immutable GoalCreated record.
 */
function budgetCommitmentDrift(store: SqliteEventStore) {
  let reads = 0;
  const facade = withStoreFacade(store, (property) => property === "readEvents"
    ? (aggregateId: string) => {
        const events = store.readEvents(aggregateId);
        if (aggregateId !== GOAL_ID || ++reads !== 2) return events;
        return events.map((event) => {
          if (event.eventType !== "GoalCreated") return event;
          const decoded = JSON.parse(decoder.decode(event.payload)) as unknown;
          const entries = Array.isArray(decoded) ? decoded : [decoded];
          const drifted = entries.map((entry) => own(entry, "kind") !== "GoalCreated"
            ? entry
            : { ...(entry as Record<string, unknown>), budgetAccountRef: "budget-account-drift" });
          return { ...event, payload: encoder.encode(JSON.stringify(
            Array.isArray(decoded) ? drifted : drifted[0],
          )) };
        });
      }
    : undefined);
  return { reads: () => reads, store: facade };
}

function stalePrimaryLeg(store: SqliteEventStore) {
  let calls = 0;
  const facade = withStoreFacade(store, (property) =>
    property === "commitExpectedVersionDecisionLegs"
      ? (input: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0]) => {
          calls += 1;
          const [primary, ...tail] = input.legs;
          if (primary === undefined) throw new Error("decision has no primary leg");
          return store.commitExpectedVersionDecisionLegs({
            ...input,
            legs: [{ ...primary, expectedVersion: primary.expectedVersion + 1 }, ...tail],
          });
        }
      : undefined);
  return { calls: () => calls, store: facade };
}

function appendSourceAdvance(
  store: SqliteEventStore, aggregateId: string, eventId: string,
): void {
  store.commit({
    aggregateId,
    commandBytes: encoder.encode(eventId),
    commandId: eventId,
    committedAt: "2026-08-30T00:00:00.000Z",
    events: [{
      eventId,
      eventType: "IntentApprovalSourceAdvanced",
      payload: encoder.encode(JSON.stringify({ aggregateId })),
    }],
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
}

function advanceSourceAtCommit(store: SqliteEventStore, aggregateId: string) {
  let calls = 0;
  const facade = withStoreFacade(store, (property) =>
    property === "commitExpectedVersionDecisionLegs"
      ? (input: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0]) => {
          calls += 1;
          appendSourceAdvance(store, aggregateId, `intent-source-race-${calls}`);
          return store.commitExpectedVersionDecisionLegs(input);
        }
      : undefined);
  return { calls: () => calls, store: facade };
}

function advanceRunOnFirstLedgerRead(store: SqliteEventStore) {
  let reads = 0;
  const facade = withStoreFacade(store, (property) => property === "readCommandDecisionsAfter"
    ? (...args: Parameters<SqliteEventStore["readCommandDecisionsAfter"]>) => {
        const page = store.readCommandDecisionsAfter(...args);
        reads += 1;
        if (reads === 1) appendSourceAdvance(store, RUN_ID, "intent-source-read-race");
        return page;
      }
    : undefined);
  return { reads: () => reads, store: facade };
}

function capturedDecisionLegs(store: SqliteEventStore) {
  type CommitInput = Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0];
  const commits: CommitInput[] = [];
  const facade = withStoreFacade(store, (property) =>
    property === "commitExpectedVersionDecisionLegs"
      ? (input: CommitInput) => {
          commits.push(input);
          return store.commitExpectedVersionDecisionLegs(input);
        }
      : undefined);
  return { commits, store: facade };
}

function durableEventCount(databasePath: string): number {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare("SELECT count(*) AS value FROM domain_events").get();
    return Number(own(row, "value"));
  } finally {
    database.close();
  }
}

/**
 * The SAME dispatch through the production EDGE, so the registry-owned mint conditional is in
 * the call path and the registry's own operator gate is not. Every field below is a server fact
 * the ingress resolves; the payload is the honest intent, so nothing here can be what refuses.
 */
function edgeDecision(store: SqliteEventStore, principalId: string) {
  return runApprovalIntentEdge({
    decidedAt: "2026-08-08T00:00:00.000Z",
    envelope: {
      commandId: "cmd-approval-intent-edge",
      commandKind: "approval.decide_intent",
      correlationId: "corr-edge-1",
      expectedVersion: store.getAggregateVersion(RUN_ID),
      payload: { ...INTENT },
      requestDigest: "a".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: "edge-credential",
      targetAggregateId: RUN_ID,
    },
    eventSubscriberId: undefined,
    operatorPrincipalId: OPERATOR,
    principal: { capabilities: ["planning.write"], principalId, projectId: PROJECT_ID },
    projectId: PROJECT_ID,
    store,
  });
}

function edgeRefusalOf(store: SqliteEventStore, principalId: string): Refusal {
  try {
    edgeDecision(store, principalId);
  } catch (error) {
    if (error instanceof DomainRefusal) return { code: error.code, layer: error.layer };
    throw error;
  }
  throw new Error("expected the approval intent edge to refuse");
}

/** The run's own durable record, read through the committed production reader. */
function runRecord(store: SqliteEventStore): unknown {
  const run = readDurableLedger(store, PROJECT_ID).aggregates.get(RUN_ID);
  if (run === undefined) throw new Error(`no durable decision for ${RUN_ID}`);
  return run.result;
}

/** `criteriaDigest` from its only durable home, selected BY TYPE and never by index. */
function sealedCriteriaDigest(store: SqliteEventStore): unknown {
  const events = store.readEvents(planningAuthorityAggregateId(RUN_ID));
  const bodies = events.find((event) => event.eventType === BODIES_EVENT_TYPE);
  if (bodies === undefined) throw new Error("the authority aggregate holds no bodies event");
  return own(JSON.parse(decoder.decode(bodies.payload)) as unknown, "criteriaDigest");
}

const RECORD_KEYS = Object.freeze([
  "actor", "actorKind", "applicablePolicyRef", "approvalRef", "approvedNodeScope", "budgetRef",
  "criteriaRef", "decision", "decisionReason", "dependencyChanges", "exactRevisionHash",
  "lifecycle", "planQualityAssessmentRef", "policyDecisionRef", "riskTier", "stepUpAuthRef",
  "truthClass", "validity",
] as const);

const SOURCE_FENCE_AGGREGATES = Object.freeze([
  ["planning run", RUN_ID],
  ["planning authority", planningAuthorityAggregateId(RUN_ID)],
  ["project policy", policyAggregateId(PROJECT_ID)],
  ["run policy", runPolicyAggregateId(RUN_ID)],
  ["active graph slot", activeGraphSlotAggregateId(PROJECT_ID)],
] as const);

function compositionFixture(
  store: SqliteEventStore,
  commandId = "cmd-approval.decide_intent",
) {
  const intent = readApprovalIntent({ ...INTENT });
  if (intent === null) throw new Error("the exact human intent must be admitted");
  const sourceFences = observeApprovalIntentSourceFences(store, PROJECT_ID, RUN_ID);
  const sources = readApprovalIntentSources(store, PROJECT_ID, RUN_ID);
  if (!sources.ok) throw new Error(`fixture sources refused: ${sources.code}`);
  if (!sources.binding.ok) throw new Error(`fixture binding refused: ${sources.binding.code}`);
  const transported = humanReviewWitness(OPERATOR, commandId);
  const stepUp = deriveStepUpAuthRef(transported, RUN_ID);
  if (!stepUp.ok) throw new Error(`fixture step-up refused: ${stepUp.code}`);
  const facts = readApprovalRecordFacts(
    store,
    { projectId: PROJECT_ID, runId: RUN_ID },
    { stepUpAuthRef: stepUp.stepUpAuthRef },
  );
  if (!facts.ok) throw new Error(`fixture facts refused: ${facts.missing}`);
  return {
    binding: sources.binding.binding, facts, intent, sourceFences, sources, witness: transported,
  };
}

function composedRecord(store: SqliteEventStore, commandId?: string) {
  const fixture = compositionFixture(store, commandId);
  const record = composeIntentApprovalRecord(fixture);
  if (record === undefined) throw new Error("the complete server facts must compose a record");
  return { fixture, record };
}

function proposedStore(): SqliteEventStore {
  const store = openStore();
  for (const request of bootstrapSequence()) {
    if (request.commandId === "cmd-finalize") return store;
    const outcome = send(store, request);
    if (!outcome.ok) throw new Error(`fixture setup refused: ${outcome.code}`);
  }
  throw new Error("bootstrap sequence has no finalize boundary");
}

function proposeSecondReviewRun(store: SqliteEventStore): void {
  const chain = sealedPlanningChain().map((command, index) => index === 0
    ? { ...command, commandId: "intent-second-chain-create", runId: SECOND_RUN_ID }
    : { ...command, commandId: `intent-second-chain-${String(index)}` });
  const proposed = send(store, envelope(
    "plan.propose", 0, { commands: chain, runId: SECOND_RUN_ID }, "cmd-intent-propose-second",
  ));
  if (!proposed.ok) throw new Error(`second propose refused: ${proposed.code}`);
  const finalized = send(store, envelope("plan.propose", 0, {
    commands: finalizeChain().map((command) => ({
      ...command, commandId: "intent-second-chain-finalize",
    })),
    runId: SECOND_RUN_ID,
  }, "cmd-intent-finalize-second"));
  if (!finalized.ok) throw new Error(`second finalize refused: ${finalized.code}`);
}

function unsealedStore(): SqliteEventStore {
  const store = legacyProposedStore();
  const finalize = finalizeChain()[0];
  if (finalize === undefined) throw new Error("finalizeChain is empty");
  const outcome = send(store, envelope("plan.propose", 0, {
    commands: [finalize], runId: RUN_ID,
  }, "cmd-finalize"));
  if (!outcome.ok) throw new Error(`unsealed finalize refused: ${outcome.code}`);
  return store;
}

function activationRequest(
  fixture: ReturnType<typeof compositionFixture>,
  record: ReturnType<typeof composedRecord>["record"],
) {
  return {
    humanReview: fixture.witness,
    intent: fixture.intent,
    projectId: PROJECT_ID,
    record,
    runId: RUN_ID,
    sourceFences: fixture.sourceFences,
  };
}

describe("the server-owned approval and activation assembly", () => {
  it("composes the exact validated ApprovalDecisionRecord without writing", () => {
    const store = reviewableStore();
    const before = readDurableLedger(store, PROJECT_ID).decisionCount;
    const { record } = composedRecord(store);

    expect(validateApprovalRecord(record)).toEqual(record);
    expect(Object.keys(record).sort()).toEqual([...RECORD_KEYS]);
    expect(record).toMatchObject({
      actor: OPERATOR,
      actorKind: "HUMAN",
      lifecycle: "DECIDED",
      policyDecisionRef: null,
      truthClass: "HUMAN_APPROVED",
      validity: "CURRENT",
    });
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(before);
  });

  it("pins CURRENT and null policy authority against caller-shaped extras", () => {
    const store = reviewableStore();
    const fixture = compositionFixture(store);
    const record = composeIntentApprovalRecord({
      ...fixture,
      policyDecisionRef: "f".repeat(64),
      validity: "SUPERSEDED",
    } as typeof fixture);

    expect(record?.validity).toBe("CURRENT");
    expect(record?.policyDecisionRef).toBeNull();
  });

  it("is deterministic for the same server facts", () => {
    const store = reviewableStore();
    const fixture = compositionFixture(store);
    const first = composeIntentApprovalRecord(fixture);

    expect(first).toBeDefined();
    expect(composeIntentApprovalRecord(fixture)).toEqual(first);
  });

  it("deep-freezes a detached record before it can ride a durable commit", () => {
    const fixture = compositionFixture(reviewableStore());
    const additions = ["node-added"];
    const approvedNodeScope = ["node-approved"];
    const record = composeIntentApprovalRecord({
      ...fixture,
      intent: {
        ...fixture.intent,
        dependencyChanges: { additions, challenges: [], removals: [] },
      },
      sources: { ...fixture.sources, approvedNodeScope },
    });
    if (record === undefined) throw new Error("mutable inputs should still validate");
    const bytes = JSON.stringify(record);

    additions[0] = "node-poisoned";
    approvedNodeScope[0] = "node-poisoned";
    expect(Reflect.set(record, "actor", "principal-poisoned")).toBe(false);
    expect(Reflect.set(record.dependencyChanges.additions, "0", "node-poisoned")).toBe(false);
    expect(JSON.stringify(record)).toBe(bytes);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.dependencyChanges.additions)).toBe(true);
  });

  it("lets the published validator reject malformed server facts", () => {
    const store = reviewableStore();
    const fixture = compositionFixture(store);

    expect(composeIntentApprovalRecord({
      ...fixture,
      witness: humanReviewWitness("", "cmd-approval.decide_intent"),
    })).toBeUndefined();
  });

  it("derives every ActivationInput field from durable state and omits budgetHash", () => {
    const store = reviewableStore();
    const ledger = readDurableLedger(store, PROJECT_ID);
    const { fixture, record } = composedRecord(store);
    const request = activationRequest(fixture, record);
    const result = assembleActivationInput(store, ledger, request);
    if (!result.ok) throw new Error(`assembly refused: ${result.code}@${result.layer}`);
    const goal = ledger.aggregates.get(result.input.goalId)?.result;

    expect(result.input).toMatchObject({
      approval: record,
      binding: fixture.binding,
      goalId: fixture.sources.goalRef,
      graphRevisionRef: fixture.sources.graphRevisionRef,
      humanReview: fixture.witness,
    });
    expect(result.input.activation).toEqual({
      expectedGoalVersion: own(goal, "version"),
      truthClass: "HUMAN_APPROVED",
    });
    expect(result.input.activation).not.toHaveProperty("budgetHash");
    expect(assembleActivationInput(store, ledger, request)).toEqual(result);
  });

  it("recomposes instead of accepting a valid record for another authority", () => {
    const store = reviewableStore();
    const ledger = readDurableLedger(store, PROJECT_ID);
    const { fixture, record } = composedRecord(store);
    const poison = {
      ...record,
      actor: "principal-foreign",
      approvalRef: "approval:foreign-run",
      exactRevisionHash: "f".repeat(64),
    };
    const result = assembleActivationInput(store, ledger, activationRequest(fixture, poison));
    if (!result.ok) throw new Error(`assembly refused: ${result.code}@${result.layer}`);

    expect(result.input.approval).toEqual(record);
    expect(result.input.approval).not.toEqual(poison);
    expect(result.input.activation["truthClass"]).toBe("HUMAN_APPROVED");
  });

  it("maps the published validator's undefined answer to the daemon seam", () => {
    const store = reviewableStore();
    const ledger = readDurableLedger(store, PROJECT_ID);
    const { fixture, record } = composedRecord(store);
    const malformed = {
      ...activationRequest(fixture, record),
      intent: { ...fixture.intent, decisionReason: "" },
    };

    expect(assembleActivationInput(store, ledger, malformed)).toEqual({
      code: "APPROVAL_INTENT_RECORD_INVALID", layer: "DAEMON_APPROVAL_INTENT", ok: false,
    });
  });

  it("forwards a missing run source with its exact code and layer", () => {
    const validStore = reviewableStore();
    const { fixture, record } = composedRecord(validStore);
    const empty = openStore();

    expect(assembleActivationInput(
      empty, readDurableLedger(empty, PROJECT_ID), activationRequest(fixture, record),
    )).toEqual({
      code: "BOOTSTRAP_PREREQUISITE_MISSING", layer: "DAEMON_PREREQUISITE", ok: false,
    });
  });

  it("forwards an unreviewable binding source with its exact code and layer", () => {
    const validStore = reviewableStore();
    const { fixture, record } = composedRecord(validStore);
    const proposed = proposedStore();

    expect(assembleActivationInput(
      proposed, readDurableLedger(proposed, PROJECT_ID), activationRequest(fixture, record),
    )).toEqual({
      code: "APPROVAL_RUN_NOT_REVIEWABLE", layer: "APPROVAL_RUN_BINDING", ok: false,
    });
  });

  it("forwards an unsealed authority source with its exact code and layer", () => {
    const validStore = reviewableStore();
    const { fixture, record } = composedRecord(validStore);
    const unsealed = unsealedStore();

    expect(assembleActivationInput(
      unsealed, readDurableLedger(unsealed, PROJECT_ID), activationRequest(fixture, record),
    )).toEqual({
      code: "APPROVAL_AUTHORITY_UNSEALED", layer: "APPROVAL_RUN_BINDING", ok: false,
    });
  });

  it("refuses when the supplied ledger has no durable goal state", () => {
    const store = reviewableStore();
    const { fixture, record } = composedRecord(store);
    const empty = openStore();

    expect(assembleActivationInput(
      store, readDurableLedger(empty, PROJECT_ID), activationRequest(fixture, record),
    )).toEqual({
      code: "BOOTSTRAP_PREREQUISITE_MISSING", layer: "DAEMON_PREREQUISITE", ok: false,
    });
  });

  it("binds the atomic replay leg to the assembled record instead of a supplied leg", () => {
    const store = reviewableStore();
    const commandId = "cmd-intent-hostile-replay-leg";
    const ledger = readDurableLedger(store, PROJECT_ID);
    const { fixture, record } = composedRecord(store, commandId);
    const assembled = assembleActivationInput(store, ledger, activationRequest(fixture, record));
    if (!assembled.ok) throw new Error(`assembly refused: ${assembled.code}@${assembled.layer}`);
    const recordDigest = record.stepUpAuthRef;
    if (typeof recordDigest !== "string") throw new Error("validated record has no replay digest");
    const hostileDigest = recordDigest === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    const hostile = buildReplayMarkerDecisionLeg({
      decidedAt: BURN_FACTS.decidedAt,
      principalId: OPERATOR,
      projectId: PROJECT_ID,
      replayDigest: hostileDigest,
    });
    if (hostile === null) throw new Error("hostile digest should build a structurally valid leg");
    const hostileLeg = hostile.leg;
    type CommitArgs = Parameters<typeof commitIntentActivation>;
    const legacyCommit = commitIntentActivation as unknown as (
      store: CommitArgs[0], ledger: CommitArgs[1], command: CommitArgs[2],
      input: CommitArgs[3], suppliedLeg: typeof hostileLeg,
    ) => ReturnType<typeof commitIntentActivation>;

    const outcome = legacyCommit(store, ledger, {
      commandId,
      correlationId: "corr-hostile-replay-leg",
      decidedAt: BURN_FACTS.decidedAt,
      expectedVersion: 0,
      payload: { ...INTENT },
      principalId: OPERATOR,
      projectId: PROJECT_ID,
    }, assembled.input, hostileLeg);

    expect(outcome.ok).toBe(true);
    expect(store.readEvents(replayAggregateId(recordDigest))).toHaveLength(1);
    expect(store.readEvents(replayAggregateId(hostileDigest))).toHaveLength(0);
  });
});

describe("the intent seam admits EXACTLY intent and refuses caller-supplied authority", () => {
  it("advertises exactly the four human-authored intent keys", () => {
    expect([...APPROVAL_INTENT_PAYLOAD_KEYS].sort())
      .toEqual(["decision", "decisionReason", "dependencyChanges", "runId"]);
  });

  it("admits the exact intent shape past the shape fence", () => {
    const outcome = reviewedDispatch(reviewableStore(), "cmd-approval.decide_intent");

    expect(outcome).toMatchObject({ kind: "approval.decide_intent", ok: true });
  });

  it.each([
    ["empty", { additions: [], challenges: [], removals: [] }],
    ["nonempty", {
      additions: ["node-added"], challenges: ["challenge-reviewed"], removals: ["node-removed"],
    }],
  ] satisfies readonly (readonly [string, JsonObject])[])(
    "admits an explicit %s dependency tuple byte-equal to the human payload",
    (_label, dependencyChanges) => {
      const admitted = readApprovalIntent({ ...INTENT, dependencyChanges });
      const carried = own(admitted, "dependencyChanges");

      expect(carried).toEqual(dependencyChanges);
      expect(JSON.stringify(carried)).toBe(JSON.stringify(dependencyChanges));
    },
  );

  it("isolates two admissions with detached deeply frozen dependency snapshots", () => {
    const dependencyChanges = {
      additions: ["node-added"],
      challenges: ["challenge-reviewed"],
      removals: ["node-removed"],
    };
    const admitted = readApprovalIntent({ ...INTENT, dependencyChanges });
    const sibling = readApprovalIntent({ ...INTENT, dependencyChanges });
    const carried = own(admitted, "dependencyChanges");
    const siblingCarried = own(sibling, "dependencyChanges");
    const carriedAdditions = own(carried, "additions");
    const carriedChallenges = own(carried, "challenges");
    const carriedRemovals = own(carried, "removals");

    expect(carried).toEqual(dependencyChanges);
    expect(carried).not.toBe(dependencyChanges);
    expect(siblingCarried).not.toBe(dependencyChanges);
    expect(siblingCarried).not.toBe(carried);
    expect(carriedAdditions).not.toBe(dependencyChanges.additions);
    expect(carriedChallenges).not.toBe(dependencyChanges.challenges);
    expect(carriedRemovals).not.toBe(dependencyChanges.removals);
    expect([
      Object.isFrozen(carried), Object.isFrozen(carriedAdditions),
      Object.isFrozen(carriedChallenges), Object.isFrozen(carriedRemovals),
    ]).toEqual([true, true, true, true]);

    dependencyChanges.additions.push("mutated-addition");
    dependencyChanges.challenges.push("mutated-challenge");
    dependencyChanges.removals.push("mutated-removal");
    expect(carried).toEqual({
      additions: ["node-added"],
      challenges: ["challenge-reviewed"],
      removals: ["node-removed"],
    });
    expect(siblingCarried).toEqual(carried);
  });

  it("refuses absent dependencyChanges with the seam's exact tuple", () => {
    const outcome = dispatch(reviewableStore(), {
      decision: INTENT.decision,
      decisionReason: INTENT.decisionReason,
      runId: INTENT.runId,
    });

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
  });

  it("refuses an exact nonzero sweep of malformed dependency tuples", () => {
    const getterBacked: Record<string, unknown> = { challenges: [], removals: [] };
    Object.defineProperty(getterBacked, "additions", {
      enumerable: true,
      get: () => [],
    });
    const cyclic: Record<string, unknown> = {
      additions: [], challenges: [], removals: [],
    };
    cyclic["additions"] = [cyclic];
    const cases: readonly { readonly name: string; readonly value: unknown }[] = [
      { name: "missing sub-key", value: { additions: [], challenges: [] } },
      { name: "extra sub-key", value: {
        additions: [], challenges: [], extra: [], removals: [],
      } },
      { name: "non-array member", value: {
        additions: "node-added", challenges: [], removals: [],
      } },
      { name: "empty-string ref", value: { additions: [""], challenges: [], removals: [] } },
      { name: "null", value: null },
      { name: "nested object", value: {
        additions: [{ ref: "nested" }], challenges: [], removals: [],
      } },
      { name: "getter-backed key", value: getterBacked },
      { name: "cycle", value: cyclic },
    ];
    expect(cases).toHaveLength(8);

    const store = reviewableStore();
    let swept = 0;
    for (const testCase of cases) {
      const answer = refusalOf(dispatch(store, {
        ...INTENT,
        dependencyChanges: testCase.value,
      } as JsonObject));
      expect(answer, testCase.name)
        .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
      swept += 1;
    }

    expect(swept).toBe(cases.length);
    expect(cases.length).toBeGreaterThan(0);
  });

  it("isolates the nested dependency validator from the top-level roster fence", () => {
    const transported = humanReviewWitness(OPERATOR, "cmd-approval.decide_intent");
    const outcome = dispatch(reviewableStore(), {
      ...INTENT,
      dependencyChanges: {
        additions: [], challenges: [], extra: [], removals: [],
      },
    }, { humanReview: transported });

    // DIVERGENCE TELL: all four top-level keys are present and every durable fact resolves.
    // Bypassing only validateApprovalDependencyChanges would therefore make this command
    // succeed; leaving the validator intact is the only route to this exact refusal.
    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
  });

  it("gets the identical valid dependency fixture past the nested shape fence", () => {
    const transported = humanReviewWitness(OPERATOR, "cmd-approval.decide_intent");
    const outcome = dispatch(
      reviewableStore(),
      { ...INTENT, dependencyChanges: { additions: [], challenges: [], removals: [] } },
      { humanReview: transported },
    );

    expect(outcome).toMatchObject({ kind: "approval.decide_intent", ok: true });
  });

  it("refuses a caller-supplied `activation` beside intent, naming code AND layer", () => {
    const outcome = dispatch(reviewableStore(), {
      ...INTENT,
      activation: { activationRef: "activation-1", truthClass: "HUMAN_APPROVED" },
    });

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
  });

  it("refuses a caller-supplied `record` beside intent, naming code AND layer", () => {
    const outcome = dispatch(reviewableStore(), {
      ...INTENT,
      record: { actor: OPERATOR, actorKind: "HUMAN", truthClass: "HUMAN_APPROVED" },
    });

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
  });

  /**
   * The generated sweep. Every one of these keys is a fact the caller must not be able to
   * present, and the seam REFUSES an unlisted key rather than trimming it — trimming is how a
   * caller-chosen authority gets in while every "it refused" arm above stays green.
   */
  it("refuses every authority-bearing extra key, over a nonzero generated roster", () => {
    const forbidden = [
      "activation", "actor", "actorKind", "applicablePolicyRef", "approvalRef", "budgetRef",
      "command", "criteriaRef", "decidedAt", "graphHash", "graphRevisionRef", "policyHash",
      "principalId", "qualityHash", "record", "riskTier", "stepUpAuthRef", "truthClass",
      // NEVER FROM BYTES, re-asserted for the two names the server-derived step-up fact
      // introduced (task-3b61860f): the witness's transport identity is assembled at the
      // composition root from the ingress's own authentication result, so a payload offering
      // either is a fifth key and is refused as a set rather than trimmed.
      "sessionRef", "transport",
    ] as const;
    // A sweep that silently produces zero cases passes. Pinned, with the denominator stated.
    expect(forbidden.length).toBe(20);

    const store = reviewableStore();
    const answers = forbidden.map((key) =>
      refusalOf(dispatch(store, { ...INTENT, [key]: "anything at all" })));

    expect(answers).toHaveLength(forbidden.length);
    for (const answer of answers) {
      expect(answer)
        .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
    }
  });

  it("refuses a MISSING intent key at the same fence, over a nonzero generated roster", () => {
    const store = reviewableStore();
    const requiredKeys = [
      "decision", "decisionReason", "dependencyChanges", "runId",
    ] as const;
    const cases = requiredKeys.map((omitted) => {
      const payload = Object.fromEntries(
        Object.entries(INTENT).filter(([key]) => key !== omitted),
      ) as JsonObject;
      return refusalOf(dispatch(store, payload));
    });

    expect(requiredKeys).toHaveLength(4);
    expect(cases.length).toBeGreaterThan(0);
    for (const answer of cases) {
      expect(answer)
        .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
    }
  });
});

describe("the human grant comes from the authenticated session, never from the payload", () => {
  /**
   * THE AGENT ARM. A dispatch with no server-assembled witness is an AGENT or otherwise
   * non-operator session, and this seam mints a HUMAN_APPROVED record — so it must refuse.
   *
   * The tuple is the EXISTING vocabulary verbatim (`approval-policy.ts:111`), not a local
   * invention: an operator repairs "a human must review this" the same way whichever layer
   * says it. See the file header for why SPEED mode makes this fence the only mechanism that
   * can answer here.
   */
  it("refuses a witness-less dispatch with the human-authority tuple unchanged", () => {
    const outcome = dispatch(reviewableStore(), { ...INTENT }, { humanReview: undefined });

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_HUMAN_REVIEW_REQUIRED", layer: "APPROVAL_POLICY" });
  });

  /**
   * A witness whose principal is not the dispatching principal is not this human's act. The
   * registry cannot mint one — it copies the authenticated principal — so this arm guards the
   * seam against a future caller that assembles its own.
   */
  it("refuses a witness that names a principal other than the authenticated one", () => {
    const outcome = dispatch(
      reviewableStore(),
      { ...INTENT },
      { humanReview: { principalId: "someone-else" } },
    );

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_HUMAN_REVIEW_REQUIRED", layer: "APPROVAL_POLICY" });
  });

  /**
   * THE MINTING CONDITION ITSELF, exercised at the production edge that owns it
   * (`daemon-command-edges.ts:55`) rather than through the registry.
   *
   * The registry's paired-HUMAN fence is covered by its landed slice. This fixture calls the edge
   * directly to isolate its mint condition: an unpaired agent receives no witness while the
   * configured operator does. SPEED mode keeps policy from duplicating that distinction.
   */
  it("withholds the witness at the edge for an unpaired non-operator principal", () => {
    expect(edgeRefusalOf(reviewableStore(), "agent-session-1"))
      .toEqual({ code: "APPROVAL_HUMAN_REVIEW_REQUIRED", layer: "APPROVAL_POLICY" });
  });

  it("mints it at the edge for the operator and reaches the durable decision", () => {
    expect(edgeDecision(reviewableStore(), OPERATOR)).toEqual({
      commandId: "cmd-approval-intent-edge",
      disposition: "DECIDED",
      effectId: "cmd-approval-intent-edge",
      resultCode: "DURABLE_DECISION",
    });
  });

  it("forwards the durable replay disposition at the production edge", () => {
    const store = reviewableStore();
    expect(edgeDecision(store, OPERATOR).disposition).toBe("DECIDED");
    expect(edgeDecision(store, OPERATOR).disposition).toBe("REPLAYED");
  });
});

describe("the step-up reference is server-derived and burns exactly once", () => {
  /**
   * DoD-3 (derivation) and DoD-4 (one-shot), against `approval-step-up.ts`.
   *
   * WHY THE ARMS LIVE IN THIS FILE. The module is the seam's own derivation half; splitting it
   * into a sibling suite would put the plan over its distinct-file cap while proving nothing the
   * shared `reviewableStore()` harness does not already reach.
   */
  const BURN = BURN_FACTS;
  const mint = (commandId: string) => humanReviewWitness(OPERATOR, commandId);

  const derivedRef = (commandId: string, runId: string = RUN_ID): string => {
    const derived = deriveStepUpAuthRef(mint(commandId), runId);
    if (!derived.ok) throw new Error(`expected a derivation, got ${derived.code}`);
    return derived.stepUpAuthRef;
  };

  it("refuses with the seam's EXISTING code and layer when the witness carries no transport", () => {
    // The witness the registry minted BEFORE this row: a principal and nothing else. Not a
    // fabricated shape -- it is exactly what every pre-transport mint site produced.
    expect(deriveStepUpAuthRef(Object.freeze({ principalId: OPERATOR }), RUN_ID)).toEqual({
      code: "APPROVAL_INTENT_STEP_UP_UNAVAILABLE",
      layer: "DAEMON_APPROVAL_INTENT",
      ok: false,
    });
    // The code is the seam's ROSTER entry, not a literal that merely happens to match today.
    expect(deriveStepUpAuthRef(undefined, RUN_ID)).toEqual({
      code: APPROVAL_MISSING_FACT_CODES[1],
      layer: "DAEMON_APPROVAL_INTENT",
      ok: false,
    });
  });

  it("derives a reference the PRODUCTION digest guard accepts", () => {
    const reference = derivedRef("cmd-derive-1");

    // `isSessionDigest` is the guard `observeReplayMarker` itself applies before burning, so
    // this asserts the production fence rather than a regex reimplementing one. Core's own
    // `validRef` (policy-validation.ts:106 -- `typeof value === "string" && value.length > 0`)
    // is satisfied a fortiori and is NOT importable here: it is not on the core barrel, and a
    // deep import fails TS6059.
    expect(isSessionDigest(reference)).toBe(true);
    expect(reference.length).toBeGreaterThan(0);
  });

  it("is DETERMINISTIC, which is the only thing that makes a replay detectable", () => {
    expect(derivedRef("cmd-same")).toBe(derivedRef("cmd-same"));
  });

  it("binds all three server facts, so changing any one changes the reference", () => {
    const base = derivedRef("cmd-bind", RUN_ID);
    const otherCommand = derivedRef("cmd-bind-other", RUN_ID);
    const otherRun = derivedRef("cmd-bind", `${RUN_ID}-other`);
    const otherSession = deriveStepUpAuthRef(humanReviewWitness("operator-elsewhere", "cmd-bind"), RUN_ID);
    if (!otherSession.ok) throw new Error("expected a derivation for a different session");

    expect(new Set([base, otherCommand, otherRun, otherSession.stepUpAuthRef]).size).toBe(4);
  });

  /**
   * THE ONE-SHOT (DoD-4). DIVERGENCE: only the burn can answer `SESSION_REPLAYED` -- nothing
   * else in the module or the seam emits that code, so deleting the burn call reddens exactly
   * this arm and leaves every other arm in this file green.
   */
  it("admits the first burn and refuses the second with the ledger's own code AND layer", () => {
    const store = reviewableStore();
    const stepUpAuthRef = derivedRef("cmd-one-shot");

    const first = burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef });
    const second = burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef });

    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual({ code: "SESSION_REPLAYED", layer: "REPLAY", ok: false });
  });

  it("holds EXACTLY ONE replay observation for the digest after two attempts", () => {
    const store = reviewableStore();
    const stepUpAuthRef = derivedRef("cmd-count-once");

    burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef });
    burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef });

    const first = burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef });
    if (first.ok) throw new Error("expected the third attempt to be refused too");
    const observed = store
      .readEvents(replayAggregateId(stepUpAuthRef))
      .filter((event) => event.eventType === "SessionAuthorityReplayObserved");

    // The denominator matters: a fixture that produced zero events would satisfy "no duplicate".
    expect(observed).toHaveLength(1);
  });

  it("admits a FRESH request identity, so an honest second approval is not locked out", () => {
    const store = reviewableStore();

    expect(burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef: derivedRef("cmd-fresh-a") }))
      .toMatchObject({ ok: true });
    expect(burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef: derivedRef("cmd-fresh-b") }))
      .toMatchObject({ ok: true });
  });

  it("refuses a malformed reference under the evidence pair rather than reaching the store", () => {
    expect(burnStepUpAuthRef(reviewableStore(), { ...BURN, stepUpAuthRef: "not-a-digest" }))
      .toEqual({ code: "AUTHENTICATION_FAILED", layer: "REPLAY", ok: false });
  });
});

describe("run state refusals carry the existing layers' own codes", () => {
  it("refuses an unknown run as a MISSING prerequisite, not a hash disagreement", () => {
    const outcome = dispatch(reviewableStore(), { ...INTENT, runId: "run-never-proposed" });

    expect(refusalOf(outcome))
      .toEqual({ code: "BOOTSTRAP_PREREQUISITE_MISSING", layer: "DAEMON_PREREQUISITE" });
  });

  /**
   * A run that EXISTS but never reached PLAN_REVIEW — proposed, never finalized.
   *
   * It cannot be built with `driveThrough`: the shipped sequence carries TWO `plan.propose`
   * envelopes and `driveThrough` stops at the first kind match, leaving no run at all and an
   * answer of BOOTSTRAP_PREREQUISITE_MISSING. That is a different defect, and an arm satisfied by
   * it would never exercise the lifecycle check — measured, not assumed: this arm caught exactly
   * that ordering bug in the seam on its first run.
   */
  it("refuses a run short of PLAN_REVIEW with the run-binding layer's own code", () => {
    const store = openStore();
    for (const request of bootstrapSequence()) {
      if (request.commandId === "cmd-finalize") break;
      const outcome = send(store, request);
      if (!outcome.ok) throw new Error(`setup failed at ${request.kind}: ${outcome.code}`);
    }
    // The subject exists and is short of the lifecycle — asserted, so the arm cannot be satisfied
    // by the missing-run answer it was written to be distinguishable from.
    expect(own(own(runRecord(store), "state"), "lifecycle")).not.toBe("PLAN_REVIEW");

    const outcome = dispatch(store, { ...INTENT });

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_RUN_NOT_REVIEWABLE", layer: "APPROVAL_RUN_BINDING" });
  });
});

describe("every derived fact traces to durable state, never to the request", () => {
  it("reads the revision, quality and criteria facts off the run's own durable records", () => {
    const store = reviewableStore();
    const sources = readApprovalIntentSources(store, PROJECT_ID, RUN_ID);
    if (!sources.ok) throw new Error(`sources refused: ${sources.code}`);

    const state = own(runRecord(store), "state");
    // Copied from the durable record, never restated here: two hand-authored operands agreeing
    // would prove only that this file agrees with itself.
    expect(sources.exactRevisionHash).toBe(own(state, "submissionHash"));
    expect(sources.planQualityAssessmentRef)
      .toBe(own(own(state, "sealedHashes"), "qualityHash"));
    expect(sources.criteriaRef).toBe(sealedCriteriaDigest(store));
    expect(sources.graphRevisionRef).toBe(own(state, "graphRevisionRef"));
    expect(sources.graphRevisionRef).toBe(GRAPH_REVISION_REF);
  });

  it("derives the approval ref from the durably verified run identity", () => {
    const store = reviewableStore();
    const sources = readApprovalIntentSources(store, PROJECT_ID, RUN_ID);
    if (!sources.ok) throw new Error(`sources refused: ${sources.code}`);

    // The run identity is the only thing a caller names, and it names it as INTENT.
    expect(sources.approvalRef).toContain(RUN_ID);
  });

  it("refuses rather than answering for a run that has no durable record", () => {
    const sources = readApprovalIntentSources(reviewableStore(), PROJECT_ID, "run-absent");

    expect(sources.ok).toBe(false);
  });
});

describe("a missing derived fact is REFUSED, never defaulted", () => {
  /**
   * `riskTier` decides whether step-up human authority is required — `approval-invalidation.ts:73`
   * special-cases R3 — so a defaulted tier silently decides an authority question. The durable
   * producer is now live; this arm still pins the next missing fact and the no-default ordering.
   */
  it("advances past riskTier to the step-up, naming the fact in its own code and layer", () => {
    const outcome = dispatch(reviewableStore(), { ...INTENT });

    // MOVED BY task-f42d5165. The tier now has a durable producer — the run's own
    // PolicyEvaluated — so the roster's FIRST code no longer answers and an operator is sent to
    // the next producer that actually owes something. Without a transported witness that is the
    // step-up. This arm reds if the tier's producer regresses, because the answer falls back.
    expect(refusalOf(outcome)).toEqual({
      code: "APPROVAL_INTENT_STEP_UP_UNAVAILABLE", layer: "DAEMON_APPROVAL_INTENT",
    });
  });

  /**
   * ORDER PRESERVATION (risk 6) with the transport fact PRESENT, and the BURN-PLACEMENT proof.
   *
   * The seam derives a step-up reference from the composition-root witness before consulting the
   * fact reader. Complete facts must mint, while any later refusal must leave NOTHING durable.
   */
  it("mints when every roster fact is established", () => {
    const outcome = dispatch(reviewableStore(), { ...INTENT }, {
      humanReview: humanReviewWitness(OPERATOR, "cmd-approval.decide_intent"),
    });

    expect(outcome).toMatchObject({ kind: "approval.decide_intent", ok: true });
  });

  it("burns exactly once only when the record and activation commit", () => {
    const store = reviewableStore();
    const transported = humanReviewWitness(OPERATOR, "cmd-approval.decide_intent");
    const derived = deriveStepUpAuthRef(transported, RUN_ID);
    if (!derived.ok) throw new Error("expected the transported witness to derive a reference");

    expect(dispatch(store, { ...INTENT }, { humanReview: transported })).toMatchObject({
      kind: "approval.decide_intent", ok: true,
    });
    expect(durableApprovalRecords(store)).toHaveLength(1);
    expect(store.readEvents(replayAggregateId(derived.stepUpAuthRef))).toHaveLength(1);
    expect(burnStepUpAuthRef(store, { ...BURN_FACTS, stepUpAuthRef: derived.stepUpAuthRef }))
      .toEqual({ code: "SESSION_REPLAYED", layer: "REPLAY", ok: false });
  });

  it("names one code per missing fact, over a nonzero roster", () => {
    expect(APPROVAL_MISSING_FACT_CODES.length).toBeGreaterThan(0);
    expect([...APPROVAL_MISSING_FACT_CODES].sort()).toEqual([
      "APPROVAL_INTENT_BUDGET_REF_UNAVAILABLE",
      "APPROVAL_INTENT_POLICY_REF_UNAVAILABLE",
      "APPROVAL_INTENT_RISK_TIER_UNAVAILABLE",
      "APPROVAL_INTENT_STEP_UP_UNAVAILABLE",
    ]);
  });

  /**
   * SILENT DEGRADATION. `createRuntimeError` (runtime-error-factory.ts:93-104) answers
   * `UNKNOWN_ERROR` and does NOT throw when a code is unknown or a descriptor does not list the
   * aggregate — so a wrong code compiles, runs, still refuses, and quietly loses its identity
   * while every "it refused" arm above stays green. This sampled arm checks the common
   * pre-commit exits; dedicated exact-tuple arms below cover the remaining reachable paths.
   */
  it("keeps sampled pre-commit refusal codes out of UNKNOWN_ERROR", () => {
    const store = reviewableStore();
    const probes: JsonObject[] = [
      { ...INTENT },
      { ...INTENT, record: {} },
      { ...INTENT, runId: "run-never-proposed" },
      { ...INTENT, decision: "NOT_A_DECISION" },
    ];
    expect(probes.length).toBeGreaterThan(0);

    const codes = probes.map((payload) => refusalOf(dispatch(store, payload)).code);
    const witnessLess = refusalOf(
      dispatch(store, { ...INTENT }, { humanReview: undefined })).code;

    for (const code of [...codes, witnessLess]) expect(code).not.toBe("UNKNOWN_ERROR");

    // NOT-UNKNOWN_ERROR is weaker than exact identity, so sampled answers are also graded against
    // a HAND-TRANSCRIBED allowlist rather than one imported from the module under test. Dedicated
    // tests pin the additional record, target, version, replay, and store tuples they generate.
    const SAMPLED_ALLOWED = [
      "APPROVAL_HUMAN_REVIEW_REQUIRED",
      "APPROVAL_INTENT_BUDGET_REF_UNAVAILABLE",
      "APPROVAL_INTENT_POLICY_REF_UNAVAILABLE",
      "APPROVAL_INTENT_RECORD_INVALID",
      "APPROVAL_INTENT_RISK_TIER_UNAVAILABLE",
      "APPROVAL_INTENT_SHAPE_INVALID",
      "APPROVAL_INTENT_STEP_UP_UNAVAILABLE",
      "APPROVAL_INTENT_TARGET_MISMATCH",
      "APPROVAL_AUTHORITY_UNSEALED",
      "BOOTSTRAP_EXPECTED_VERSION_STALE",
      "BOOTSTRAP_PREREQUISITE_MISSING",
    ];
    for (const code of [...codes, witnessLess]) {
      expect({ code, emittable: SAMPLED_ALLOWED.includes(code) })
        .toEqual({ code, emittable: true });
    }
  });
});

describe("one approval intent decision activates, records, and burns atomically", () => {
  it("refuses REJECT before looking up a durable run", () => {
    const store = openStore();
    const commandId = "cmd-intent-reject-before-run";
    expect(refusalOf(reviewedDispatch(store, commandId, {
      ...INTENT, decision: "REJECT",
    }))).toEqual({
      code: "BOOTSTRAP_PAYLOAD_INVALID", layer: "DAEMON_PREREQUISITE",
    });
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(0);
    expect(store.readEvents(replayAggregateId(replayRef(commandId)))).toHaveLength(0);
  });

  it("commits one decision carrying one public-readable record and one replay marker", () => {
    const store = reviewableStore();
    const commandId = "cmd-intent-atomic-success";
    const replayDigest = replayRef(commandId);
    const before = readDurableLedger(store, PROJECT_ID);
    const expectedRecord = composedRecord(store, commandId).record;
    const outcome = reviewedDispatch(store, commandId);
    if (!outcome.ok) throw new Error(`intent approval refused: ${outcome.code}`);

    const after = readDurableLedger(store, PROJECT_ID);
    const records = durableApprovalRecords(store);
    const markers = store.readEvents(replayAggregateId(replayDigest))
      .filter((event) => event.eventType === "SessionAuthorityReplayObserved");
    expect(after.decisionCount).toBe(before.decisionCount + 1);
    expect(outcome).toMatchObject({
      disposition: "DECIDED",
      kind: "approval.decide_intent",
      ok: true,
    });
    expect(outcome.decision).toMatchObject({
      commandKind: "approval.decide_intent",
      targetAggregateId: GOAL_ID,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(expectedRecord);
    expect(Object.keys(records[0] ?? {}).sort()).toEqual([...RECORD_KEYS]);
    expect(records[0]).toMatchObject({
      actor: OPERATOR,
      decision: "APPROVE",
      decisionReason: INTENT.decisionReason,
      lifecycle: "DECIDED",
      truthClass: "HUMAN_APPROVED",
    });
    expect(markers).toHaveLength(1);
    expect(JSON.parse(decoder.decode(markers[0]?.payload))).toEqual({ replayDigest });
    expect(own(after.aggregates.get(GOAL_ID)?.result, "lifecycle"))
      .toBe("EXECUTION_ENABLED");

    const seeded = reviewableStore();
    const approval = bootstrapSequence().find((request) => request.kind === "approval.decide");
    if (approval === undefined) throw new Error("seeded journey has no approval.decide");
    const seededOutcome = send(seeded, approval);
    if (!seededOutcome.ok) throw new Error(`seeded approval refused: ${seededOutcome.code}`);
    expect(after.aggregates.get(GOAL_ID)).toEqual(
      readDurableLedger(seeded, PROJECT_ID).aggregates.get(GOAL_ID),
    );
  });

  it("submits exactly one multi-leg commit with the bound replay observation last", () => {
    const store = reviewableStore();
    const commandId = "cmd-intent-captured-leg-order";
    const replayDigest = replayRef(commandId);
    const captured = capturedDecisionLegs(store);
    const sourceVersions = SOURCE_FENCE_AGGREGATES.map((entry) =>
      store.getAggregateVersion(entry[1]));

    expect(reviewedDispatch(captured.store, commandId).ok).toBe(true);
    expect(captured.commits).toHaveLength(1);
    const legs = captured.commits[0]?.legs;
    expect(SOURCE_FENCE_AGGREGATES).toHaveLength(5);
    expect(legs).toHaveLength(8);
    expect(legs?.[0]?.aggregateId).toBe(GOAL_ID);
    expect(legs?.slice(-6, -1).map((leg) => leg.aggregateId))
      .toEqual(SOURCE_FENCE_AGGREGATES.map((entry) => entry[1]));
    expect(legs?.slice(-6, -1).map((leg) => leg.expectedVersion)).toEqual(sourceVersions);
    expect(legs?.slice(-6, -1).every((leg) => leg.events.length === 0)).toBe(true);
    expect(legs?.at(-1)).toMatchObject({
      aggregateId: replayAggregateId(replayDigest),
      expectedVersion: 0,
    });
    expect(legs?.at(-1)?.events.map((event) => event.eventType))
      .toEqual(["SessionAuthorityReplayObserved"]);
  });

  it("refuses a stale browser-observed run version before minting or burning", () => {
    const store = reviewableStore();
    const commandId = "cmd-intent-stale-browser-version";
    const replayDigest = replayRef(commandId);
    const current = store.getAggregateVersion(RUN_ID);
    expect(current).toBeGreaterThan(0);

    expect(refusalOf(dispatch(store, { ...INTENT }, {
      commandId,
      expectedVersion: current - 1,
      humanReview: humanReviewWitness(OPERATOR, commandId),
    }))).toEqual({
      code: "BOOTSTRAP_EXPECTED_VERSION_STALE", layer: "DAEMON_PREREQUISITE",
    });
    expect(durableApprovalRecords(store)).toHaveLength(0);
    expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(0);
  });

  it("refuses an equal-version envelope targeted at a different reviewable run", () => {
    const store = reviewableStore();
    proposeSecondReviewRun(store);
    const commandId = "cmd-intent-target-substitution";
    const replayDigest = replayRef(commandId);
    const firstVersion = store.getAggregateVersion(RUN_ID);
    const secondVersion = store.getAggregateVersion(SECOND_RUN_ID);
    expect([firstVersion, secondVersion]).toEqual([firstVersion, firstVersion]);
    expect(firstVersion).toBeGreaterThan(0);

    expect(refusalOf(dispatch(store, { ...INTENT }, {
      commandId,
      expectedVersion: secondVersion,
      humanReview: humanReviewWitness(OPERATOR, commandId),
      targetAggregateId: SECOND_RUN_ID,
    }))).toEqual({
      code: "APPROVAL_INTENT_TARGET_MISMATCH", layer: "DAEMON_APPROVAL_INTENT",
    });
    expect(durableApprovalRecords(store)).toHaveLength(0);
    expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(0);
  });

  it("checks the target binding before an accepted command can replay", () => {
    const store = reviewableStore();
    proposeSecondReviewRun(store);
    const commandId = "cmd-intent-replay-target-substitution";
    const replayDigest = replayRef(commandId);
    expect(reviewedDispatch(store, commandId).ok).toBe(true);
    const decided = readDurableLedger(store, PROJECT_ID).decisionCount;

    expect(refusalOf(dispatch(store, { ...INTENT }, {
      commandId,
      expectedVersion: store.getAggregateVersion(SECOND_RUN_ID),
      humanReview: humanReviewWitness(OPERATOR, commandId),
      targetAggregateId: SECOND_RUN_ID,
    }))).toEqual({
      code: "APPROVAL_INTENT_TARGET_MISMATCH", layer: "DAEMON_APPROVAL_INTENT",
    });
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(decided);
    expect(durableApprovalRecords(store)).toHaveLength(1);
    expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(1);
  });

  it("captures the run fence before the first durable ledger page is read", () => {
    const store = reviewableStore();
    const commandId = "cmd-intent-source-read-race";
    const replayDigest = replayRef(commandId);
    const raced = advanceRunOnFirstLedgerRead(store);

    expect(refusalOf(reviewedDispatch(raced.store, commandId))).toEqual({
      code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE",
    });
    expect(raced.reads()).toBeGreaterThan(0);
    expect(durableApprovalRecords(store)).toHaveLength(0);
    expect(store.readEvents(deriveBudgetAggregateId(PROJECT_ID, BUDGET_ACCOUNT_REF)))
      .toHaveLength(0);
    expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(0);
  });

  it.each(SOURCE_FENCE_AGGREGATES)(
    "refuses when the %s source advances after validation and burns nothing",
    (_label, aggregateId) => {
      const store = reviewableStore();
      const commandId = `cmd-intent-source-race-${aggregateId}`;
      const replayDigest = replayRef(commandId);
      const raced = advanceSourceAtCommit(store, aggregateId);

      expect(refusalOf(reviewedDispatch(raced.store, commandId))).toEqual({
        code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE",
      });
      expect(raced.calls()).toBe(1);
      expect(durableApprovalRecords(store)).toHaveLength(0);
      expect(store.readEvents(deriveBudgetAggregateId(PROJECT_ID, BUDGET_ACCOUNT_REF)))
        .toHaveLength(0);
      expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(0);
    },
  );

  it("rolls every leg back on a primary append fault and proves it after reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-intent-primary-fault-"));
    const databasePath = join(directory, "store.sqlite");
    const commandId = "cmd-intent-primary-fault";
    const replayDigest = replayRef(commandId);
    let store: SqliteEventStore | undefined = SqliteEventStore.openForProject(
      databasePath, PROJECT_ID,
    );
    try {
      driveThrough(store, "approval.decide");
      const before = readDurableLedger(store, PROJECT_ID);
      const injection = new DatabaseSync(databasePath);
      try {
        injection.exec(`CREATE TRIGGER intent_primary_fault BEFORE INSERT ON domain_events
          WHEN NEW.aggregate_id = '${GOAL_ID}' AND NEW.event_type = 'GoalExecutionEnabled'
          BEGIN SELECT RAISE(ABORT, 'intent-primary-fault'); END`);
        let fault: unknown;
        try {
          reviewedDispatch(store, commandId);
        } catch (error) {
          fault = error;
        }
        expect(fault).toMatchObject({ code: "STORE_UNAVAILABLE" });
      } finally {
        injection.exec("DROP TRIGGER intent_primary_fault");
        injection.close();
      }
      store.close();
      store = SqliteEventStore.openForProject(databasePath, PROJECT_ID);

      const reopened = readDurableLedger(store, PROJECT_ID);
      expect(reopened.decisionCount).toBe(before.decisionCount);
      expect(reopened.aggregates.get(GOAL_ID)).toEqual(before.aggregates.get(GOAL_ID));
      expect(durableApprovalRecords(store)).toHaveLength(0);
      expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(0);
      expect(store.getCommandDecision({ commandId, principalId: OPERATOR, projectId: PROJECT_ID }))
        .toBeNull();

      const retry = reviewedDispatch(store, commandId);
      expect(retry.ok).toBe(true);
      expect(durableApprovalRecords(store)).toHaveLength(1);
      expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(1);
    } finally {
      store?.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rolls prior legs back when the final replay append faults after the goal insert", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-intent-replay-fault-"));
    const databasePath = join(directory, "store.sqlite");
    const commandId = "cmd-intent-final-replay-fault";
    const replayDigest = replayRef(commandId);
    const replayId = replayAggregateId(replayDigest);
    let store: SqliteEventStore | undefined = SqliteEventStore.openForProject(
      databasePath, PROJECT_ID,
    );
    try {
      driveThrough(store, "approval.decide");
      const before = readDurableLedger(store, PROJECT_ID);
      const beforeEventCount = durableEventCount(databasePath);
      const injection = new DatabaseSync(databasePath);
      try {
        injection.exec(`CREATE TRIGGER intent_replay_fault BEFORE INSERT ON domain_events
          WHEN NEW.aggregate_id = '${replayId}'
            AND NEW.event_type = 'SessionAuthorityReplayObserved'
            AND EXISTS (SELECT 1 FROM domain_events
              WHERE aggregate_id = '${GOAL_ID}' AND event_type = 'GoalExecutionEnabled')
          BEGIN SELECT RAISE(ABORT, 'intent-replay-fault'); END`);
        let fault: unknown;
        try {
          reviewedDispatch(store, commandId);
        } catch (error) {
          fault = error;
        }
        expect(fault).toMatchObject({ code: "STORE_UNAVAILABLE" });
      } finally {
        injection.exec("DROP TRIGGER intent_replay_fault");
        injection.close();
      }
      store.close();
      store = SqliteEventStore.openForProject(databasePath, PROJECT_ID);

      const reopened = readDurableLedger(store, PROJECT_ID);
      expect(reopened).toEqual(before);
      expect(durableEventCount(databasePath)).toBe(beforeEventCount);
      expect(durableApprovalRecords(store)).toHaveLength(0);
      expect(store.readEvents(replayId)).toHaveLength(0);
      expect(store.getCommandDecision({ commandId, principalId: OPERATOR, projectId: PROJECT_ID }))
        .toBeNull();

      expect(reviewedDispatch(store, commandId).ok).toBe(true);
      expect(durableApprovalRecords(store)).toHaveLength(1);
      expect(store.readEvents(replayId)).toHaveLength(1);
    } finally {
      store?.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "malformed payload",
      { ...INTENT, record: {} },
      humanReviewWitness(OPERATOR, "cmd-intent-refuse-malformed"),
      "APPROVAL_INTENT_SHAPE_INVALID",
      "DAEMON_APPROVAL_INTENT",
    ],
    [
      "rejected intent",
      { ...INTENT, decision: "REJECT" },
      humanReviewWitness(OPERATOR, "cmd-intent-refuse-reject"),
      "BOOTSTRAP_PAYLOAD_INVALID",
      "DAEMON_PREREQUISITE",
    ],
    [
      "missing step-up fact",
      { ...INTENT },
      { principalId: OPERATOR },
      "APPROVAL_INTENT_STEP_UP_UNAVAILABLE",
      "DAEMON_APPROVAL_INTENT",
    ],
  ] as const)("leaves the reference reusable after %s", (
    label, payload, humanReview, code, layer,
  ) => {
    const store = reviewableStore();
    const commandId = `cmd-intent-refuse-${label === "malformed payload"
      ? "malformed" : label === "rejected intent" ? "reject" : "missing"}`;
    const replayDigest = replayRef(commandId);
    const before = readDurableLedger(store, PROJECT_ID).decisionCount;
    const outcome = dispatch(store, payload, { commandId, humanReview });

    expect(refusalOf(outcome)).toEqual({ code, layer });
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(before);
    expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(0);
    expect(durableApprovalRecords(store)).toHaveLength(0);
    expect(reviewedDispatch(store, commandId).ok).toBe(true);
    expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(1);
  });

  it("leaves the reference reusable after an nth-read public-validator fault", () => {
    const store = reviewableStore();
    const commandId = "cmd-intent-validator-reject";
    const replayDigest = replayRef(commandId);
    const faulted = criteriaValidatorFault(store);
    const before = readDurableLedger(store, PROJECT_ID).decisionCount;

    expect(refusalOf(reviewedDispatch(faulted.store, commandId))).toEqual({
      code: "APPROVAL_INTENT_RECORD_INVALID", layer: "DAEMON_APPROVAL_INTENT",
    });
    expect(faulted.reads()).toBe(6);
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(before);
    expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(0);
    expect(reviewedDispatch(faulted.store, commandId).ok).toBe(true);
  });

  it("leaves the reference reusable after nth-read budget commitment drift", () => {
    const store = reviewableStore();
    const commandId = "cmd-intent-budget-mismatch";
    const replayDigest = replayRef(commandId);
    const faulted = budgetCommitmentDrift(store);
    const before = readDurableLedger(store, PROJECT_ID).decisionCount;

    expect(refusalOf(reviewedDispatch(faulted.store, commandId))).toEqual({
      code: "BOOTSTRAP_BUDGET_COMMITMENT_MISMATCH", layer: "DAEMON_PREREQUISITE",
    });
    expect(faulted.reads()).toBe(4);
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(before);
    expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(0);
    expect(reviewedDispatch(faulted.store, commandId).ok).toBe(true);
  });

  it("leaves the replay leg empty after a goal-version conflict and admits a fresh retry", () => {
    const store = reviewableStore();
    const commandId = "cmd-intent-goal-conflict";
    const replayDigest = replayRef(commandId);
    const faulted = stalePrimaryLeg(store);

    expect(refusalOf(reviewedDispatch(faulted.store, commandId))).toEqual({
      code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE",
    });
    expect(faulted.calls()).toBe(1);
    expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(0);
    expect(durableApprovalRecords(store)).toHaveLength(0);
    expect(burnStepUpAuthRef(store, { ...BURN_FACTS, stepUpAuthRef: replayDigest }))
      .toMatchObject({ ok: true });
    expect(reviewedDispatch(store, "cmd-intent-goal-conflict-retry").ok).toBe(true);
  });

  it("refuses a second decision at the activation fence without consuming its fresh reference", () => {
    const store = reviewableStore();
    expect(reviewedDispatch(store, "cmd-intent-first").ok).toBe(true);
    const before = readDurableLedger(store, PROJECT_ID).decisionCount;
    const secondCommandId = "cmd-intent-second";
    const secondRef = replayRef(secondCommandId);

    expect(refusalOf(reviewedDispatch(store, secondCommandId))).toEqual({
      code: "ILLEGAL_TRANSITION", layer: "CORE_REDUCER",
    });
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(before);
    expect(durableApprovalRecords(store)).toHaveLength(1);
    expect(store.readEvents(replayAggregateId(secondRef))).toHaveLength(0);
    expect(burnStepUpAuthRef(store, { ...BURN_FACTS, stepUpAuthRef: secondRef }))
      .toMatchObject({ ok: true });
  });

  it("replays the identical command without a second decision, record, or marker", () => {
    const store = reviewableStore();
    const commandId = "cmd-intent-identical-replay";
    const replayDigest = replayRef(commandId);
    const first = reviewedDispatch(store, commandId);
    if (!first.ok) throw new Error(`first intent refused: ${first.code}`);
    const decided = readDurableLedger(store, PROJECT_ID).decisionCount;

    const replayed = reviewedDispatch(store, commandId);
    expect(replayed).toMatchObject({ disposition: "REPLAYED", ok: true });
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(decided);
    expect(durableApprovalRecords(store)).toHaveLength(1);
    expect(store.readEvents(replayAggregateId(replayDigest))).toHaveLength(1);
  });

  it("answers an identical replay before rereading sources that later became unavailable", () => {
    const store = reviewableStore();
    const commandId = "cmd-intent-replay-before-sources";
    expect(reviewedDispatch(store, commandId).ok).toBe(true);
    const unavailable = unreadableSources(store);

    expect(reviewedDispatch(unavailable.store, commandId)).toMatchObject({
      disposition: "REPLAYED", ok: true,
    });
    expect(unavailable.reads()).toBe(0);
    expect(durableApprovalRecords(store)).toHaveLength(1);
  });

  it("refuses changed intent bytes under an accepted command id instead of replaying authority", () => {
    const store = reviewableStore();
    const commandId = "cmd-intent-replay-bytes-conflict";
    expect(reviewedDispatch(store, commandId).ok).toBe(true);
    const decided = readDurableLedger(store, PROJECT_ID).decisionCount;

    expect(refusalOf(reviewedDispatch(store, commandId, {
      ...INTENT, decisionReason: "different human intent",
    }))).toEqual({
      code: "BOOTSTRAP_COMMAND_BYTES_CONFLICT", layer: "DAEMON_PREREQUISITE",
    });
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(decided);
    expect(durableApprovalRecords(store)).toHaveLength(1);
  });
});
