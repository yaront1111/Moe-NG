/**
 * The approve path's budget half (task-1de7b81a): a durable root, an atomic commit, and a
 * budgetHash nobody supplied.
 *
 * `approval-activation.ts` had no suite of its own, so these arms are ADDITIVE — nothing here
 * edits another suite's world. Every arm drives the SHIPPED command path through
 * `runBootstrapCommand`, so what is asserted is what an operator's approval actually writes.
 *
 * The two arms the governor's Option-B ruling required to be PROVEN rather than argued are named
 * ARM A (atomicity) and ARM B (reader visibility) below.
 */

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject, RuntimeCommandEnvelope } from "@moe/contracts";
import type { ApprovalDecisionRecord } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readDurableLedger, stateOf, versionOf } from "../bootstrap/bootstrap-ledger.js";
import type { HumanReviewWitness } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID,
  PROJECT_ID,
  SEALED_SUBMISSION_HASH,
  approvalPayload,
  approvalRecord,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  planningActivation,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import type { Envelope } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  seedActivationGraph,
  seedActivationWorldWithGatePolicy,
} from "../activation/activation-world-fixtures.js";
import {
  budgetCommitmentDigest,
  budgetCommitmentMaterial,
} from "../budget/budget-commitment.js";
import { encodeBudgetLedgerRecord } from "../budget/budget-ledger-codec.js";
import { decodeBudgetLedgerRecord } from "../budget/budget-ledger-codec.js";
import {
  BUDGET_LEDGER_EVENT_TYPE,
  deriveBudgetAggregateId,
} from "../budget/budget-ledger-contracts.js";
import {
  POLICY_RISK_EVENT_TYPE,
  POLICY_RISK_RECORD_KEYS,
  decodePolicyRiskRecord,
  policyRiskAggregateIdFor,
} from "../bootstrap/policy-risk-record.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import type {
  AuthenticatedPrincipal,
  DecisionPortResult,
} from "../http/http-contract.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import {
  buildActiveGraphSlotLeg,
  observeActiveGraphSlot,
} from "./active-graph-slot.js";
import {
  APPROVAL_MODE_ENV_KEY,
  SPEED_MODE_DELAY_ENV_KEY,
} from "./approval-policy-settings.js";
import { activateInitialGraph } from "./approval-activation.js";
import type { ActivationInput } from "./approval-activation.js";
import {
  closeStores as closeGraphStores,
  commitSeamFacade,
  contextFor,
  decidedApproval,
  inputFor,
  openEmptyFileStore,
  requestFor,
  twoHandles,
} from "./graph-activation-test-fixtures.js";
import { POLICY_RISK_APPROVAL_ACTION, buildPolicyRiskLeg } from "./policy-risk-leg.js";
import type { PolicyRiskLegInput } from "./policy-risk-leg.js";

const BUDGET_ACCOUNT_REF = "budget-account-1";
const BUDGET_AGGREGATE = deriveBudgetAggregateId(PROJECT_ID, BUDGET_ACCOUNT_REF);
const ACTIVATION_EVENT_TYPE = "GoalExecutionEnabled";
const DECIDED_AT = "2026-08-08T00:00:00.000Z";
const OPERATOR_PRINCIPAL_ID = "principal-1";
const POLICY_DECISION_REF = "1".repeat(64);
const REQUEST_DIGEST = "d".repeat(64);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllEnvs();
  closeGraphStores();
  closeStores();
});

interface RiskSubject {
  readonly subjectRef: string;
  readonly subjectRevision: number;
}

type ActivationWithReview = ActivationInput & {
  readonly humanReview?: HumanReviewWitness;
};

const OPERATOR: AuthenticatedPrincipal = Object.freeze({
  capabilities: Object.freeze(["planning.write"]),
  principalId: OPERATOR_PRINCIPAL_ID,
  projectId: PROJECT_ID,
});

function qualifyingPayload(
  recordOverrides: Record<string, unknown> = {},
): JsonObject {
  return approvalPayload({
    record: {
      ...approvalRecord(SEALED_SUBMISSION_HASH),
      policyDecisionRef: POLICY_DECISION_REF,
      ...recordOverrides,
    },
  }) as JsonObject;
}

function runtimeApprovalEnvelope(
  payload: JsonObject,
  commandId = "cmd-policy-risk-approval",
): RuntimeCommandEnvelope {
  return {
    commandId,
    commandKind: "approval.decide",
    correlationId: `corr-${commandId}`,
    expectedVersion: 0,
    payload,
    requestDigest: REQUEST_DIGEST,
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: "credential-policy-risk-approval",
    targetAggregateId: GOAL_ID,
  };
}

function registryApprovalDispatcher(
  store: SqliteEventStore,
): (payload: JsonObject, commandId?: string) => DecisionPortResult {
  const ports = createDaemonCommandPorts({
    clock: () => DECIDED_AT,
    operatorPrincipalId: OPERATOR_PRINCIPAL_ID,
    projectId: PROJECT_ID,
    store,
  });
  const entry = ports.registry.get("approval.decide");
  if (entry === undefined) throw new Error("approval.decide is absent from the production registry");
  return (payload, commandId = "cmd-policy-risk-approval") => ports.decisions.decide(
    { commandId, principalId: OPERATOR_PRINCIPAL_ID, projectId: PROJECT_ID },
    REQUEST_DIGEST,
    () => entry.handler({ envelope: runtimeApprovalEnvelope(payload, commandId), principal: OPERATOR }),
  );
}

function qualifyingApproval(
  overrides: Partial<ApprovalDecisionRecord> = {},
): ApprovalDecisionRecord {
  return {
    ...decidedApproval(),
    policyDecisionRef: POLICY_DECISION_REF,
    ...overrides,
  };
}

function currentRiskSubject(store: SqliteEventStore): RiskSubject {
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  expect(active.ok, active.ok ? "" : `${active.code}@${active.layer}`).toBe(true);
  if (!active.ok) throw new Error(`${active.code}@${active.layer}`);
  return Object.freeze({
    subjectRef: active.graphContentHash,
    subjectRevision: active.graphEpoch,
  });
}

function riskAggregateId(subject: RiskSubject): string {
  return policyRiskAggregateIdFor({
    actionKind: POLICY_RISK_APPROVAL_ACTION,
    projectId: PROJECT_ID,
    subjectRef: subject.subjectRef,
  });
}

function riskRows(store: SqliteEventStore, subject: RiskSubject) {
  return store.readEvents(riskAggregateId(subject));
}

function policyRiskInput(
  approvalDecision: ApprovalDecisionRecord,
  approvedBy: string | null,
  subject: RiskSubject,
  commandId = "cmd-policy-risk-approval",
): PolicyRiskLegInput {
  return {
    actionKind: POLICY_RISK_APPROVAL_ACTION,
    approval: approvalDecision,
    approvedBy,
    assessedAt: DECIDED_AT,
    commandId,
    projectId: PROJECT_ID,
    subject,
  };
}

function expectPolicyRiskRefusal(
  store: SqliteEventStore,
  approvalDecision: ApprovalDecisionRecord,
  approvedBy: string | null,
  subject: RiskSubject,
  expectedCode: string,
): void {
  expect(buildPolicyRiskLeg(
    store,
    policyRiskInput(approvalDecision, approvedBy, subject, "cmd-refusal-probe"),
  )).toEqual({ code: expectedCode, layer: "DAEMON_POLICY_RISK", ok: false });
}

function expectOnePolicyRiskRecord(store: SqliteEventStore, subject: RiskSubject): void {
  const rows = riskRows(store, subject);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.eventType).toBe(POLICY_RISK_EVENT_TYPE);
  const decoded = decodePolicyRiskRecord(rows[0]?.payload ?? new Uint8Array());
  expect(decoded.ok, decoded.ok ? "" : `${decoded.code}@${decoded.layer}`).toBe(true);
  if (!decoded.ok) throw new Error(`${decoded.code}@${decoded.layer}`);
  expect(Object.keys(decoded.record)).toEqual([...POLICY_RISK_RECORD_KEYS]);
  expect(decoded.record).toEqual({
    actionKind: "plan.approve",
    approvedBy: OPERATOR_PRINCIPAL_ID,
    assessedAt: DECIDED_AT,
    decisionRef: POLICY_DECISION_REF,
    projectId: PROJECT_ID,
    subjectRef: subject.subjectRef,
    subjectRevision: subject.subjectRevision,
    tier: "R2",
  });
}

function activationInputWithReview(
  store: SqliteEventStore,
  approvalDecision: ApprovalDecisionRecord,
): ActivationWithReview {
  const base = inputFor(store);
  return Object.freeze({
    activation: base.activation,
    approval: approvalDecision,
    binding: base.binding,
    goalId: base.goalId,
    graphRevisionRef: base.graphRevisionRef,
    humanReview: Object.freeze({ principalId: OPERATOR_PRINCIPAL_ID }),
  });
}

function useRequireHumanPolicy(): void {
  vi.stubEnv(APPROVAL_MODE_ENV_KEY, "REQUIRE_HUMAN");
  vi.stubEnv(SPEED_MODE_DELAY_ENV_KEY, undefined);
}

function useImmediateSpeedPolicy(): void {
  vi.stubEnv(APPROVAL_MODE_ENV_KEY, "SPEED");
  vi.stubEnv(SPEED_MODE_DELAY_ENV_KEY, "0");
}

function advanceActiveGraphSlot(store: SqliteEventStore): void {
  const commandId = "cmd-competing-active-graph-slot";
  const observed = observeActiveGraphSlot(store, PROJECT_ID);
  const response = store.commitExpectedVersionDecisionLegs({
    commandKind: "test.active_graph_slot_seed",
    committedResultBytes: encoder.encode("{}"),
    correlationId: "corr-competing-active-graph-slot",
    decidedAt: DECIDED_AT,
    key: { commandId, principalId: OPERATOR_PRINCIPAL_ID, projectId: PROJECT_ID },
    legs: [buildActiveGraphSlotLeg({
      commandId,
      graphEpoch: 2,
      observed,
      projectId: PROJECT_ID,
      reason: "SUPERSEDE",
      revisionId: "graph-revision-competing",
    })],
    requestBytes: encoder.encode("active-graph-slot/competing"),
  });
  expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

function expectRegistryDisposition(
  result: DecisionPortResult,
  disposition: "DECIDED" | "REPLAYED",
): void {
  expect(result.outcome).toBe("DECIDED");
  if (result.outcome !== "DECIDED") throw new Error(`${result.refusal.code}@${result.refusal.layer}`);
  expect(result.decision.disposition).toBe(disposition);
}

/** A store driven to the point where the next command is the approval itself. */
function approvableStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "approval.decide");
  return store;
}

const approval = (activationOverrides?: Record<string, unknown>): Envelope =>
  envelope("approval.decide", 0, activationOverrides === undefined
    ? approvalPayload()
    : approvalPayload({ activation: planningActivation(activationOverrides) }));

/** The ROOT record as the store holds it, decoded and re-digested exactly as production does. */
function durableRoot(store: SqliteEventStore): { digest: string; record: ReturnType<typeof decode> } {
  const [first] = store.readEvents(BUDGET_AGGREGATE);
  if (first === undefined) throw new Error("no budget root on the aggregate");
  expect(first.eventType).toBe(BUDGET_LEDGER_EVENT_TYPE);
  const record = decode(first.payload);
  const reencoded = encodeBudgetLedgerRecord(record);
  if (!reencoded.ok) throw new Error(`root does not re-encode: ${reencoded.code}`);
  return { digest: reencoded.digest, record };
}

function decode(payload: Uint8Array) {
  const decoded = decodeBudgetLedgerRecord(payload);
  if (!decoded.ok) throw new Error(`root undecodable: ${decoded.code}`);
  return decoded.record;
}

/** The `activation` section of the goal's single `GoalExecutionEnabled`. */
function activationSection(store: SqliteEventStore): Record<string, unknown> {
  const rows = store.readEvents(GOAL_ID).filter((row) => row.eventType === ACTIVATION_EVENT_TYPE);
  expect(rows).toHaveLength(1);
  const payload = JSON.parse(decoder.decode(rows[0]?.payload)) as Record<string, unknown>;
  return payload["activation"] as Record<string, unknown>;
}

/** The decision key the approval fixture always commits under. */
const APPROVAL_DECISION_KEY = Object.freeze({
  commandId: "cmd-approval.decide", principalId: "principal-1", projectId: PROJECT_ID,
});

/**
 * Pre-collapse identity digests, captured on the tree where `approval-activation.ts` still chose
 * `commitAccepted` for the existing-root branch. They are literals rather than a value read from
 * the module under test, so a shape change in the decision record cannot move the expectation
 * along with the behaviour.
 *
 * ROTATED ONCE, DELIBERATELY, BY task-61a2e8ad, and this is the whole reason the pins exist. The
 * fixture's `budgetRef` stopped being the placeholder `hex64("bb")` and became the DERIVED
 * decide-time commitment (`fixtureBudgetCommitment()`), and that value is INSIDE the approval
 * record these decisions commit — so the committed bytes necessarily moved. What did NOT move is
 * behaviour: the bind-back added by that task only REFUSES, it appends nothing, and the control
 * for that claim is drill D3 — deleting the bind-back leaves these four digests unchanged while
 * ARM G reds. An input value changed; the leg structure these arms guard did not.
 *
 * Pre-rotation values, kept so the rotation is auditable rather than silent:
 *   EXISTING_ROOT decision bf1ebb03…dc6f  effect d77b6d3e…4e13
 *   GENESIS       decision b5e34c59…2094  effect f6f1c0c7…035c
 */
const EXISTING_ROOT_DECISION_SHA256 = "e574e9f82bfac592fdd6ebcde0647d1e83017970ef62c930524e7e5c46465593";
const EXISTING_ROOT_EFFECT_SHA256 = "4c7ec474edc3acbe9340fe98a717ec34b1e9f8efb676a193e4d00f810979866a";
const GENESIS_DECISION_SHA256 = "128658aaad6fa3d54d9615f1b70aa21deca9222f321faace72bf21a1d406d446";
const GENESIS_EFFECT_SHA256 = "4216f79b4fb932670be5afb7f7d5eae93ed0e1461416678901ec06bd385cb0f7";

/** How many `GoalExecutionEnabled` events the goal aggregate carries. */
function goalActivationCount(store: SqliteEventStore): number {
  return store.readEvents(GOAL_ID).filter((row) => row.eventType === ACTIVATION_EVENT_TYPE).length;
}

describe("approval.decide policy-risk composition", () => {
  it("writes one exact policy-risk row on the qualifying GENESIS branch", () => {
    useRequireHumanPolicy();
    const store = approvableStore();
    seedActivationGraph(store);
    const subject = currentRiskSubject(store);
    const slot = observeActiveGraphSlot(store, PROJECT_ID);
    const slotEventsBefore = store.readEvents(slot.aggregateId).length;

    const result = registryApprovalDispatcher(store)(qualifyingPayload());

    expectRegistryDisposition(result, "DECIDED");
    expect(Object.keys(activationSection(store))).toEqual([
      "activeGraphRevisionRef",
      "graphApprovalRef",
      "truthClass",
      "authorityRef",
      "bodiesDigest",
      "budgetHash",
      "envelopeDigest",
      "runId",
    ]);
    expect(activationSection(store)).not.toHaveProperty("humanReview");
    expect(activationSection(store)).not.toHaveProperty("principalId");
    expectOnePolicyRiskRecord(store, subject);
    expect(observeActiveGraphSlot(store, PROJECT_ID).version).toBe(slot.version);
    expect(store.readEvents(slot.aggregateId)).toHaveLength(slotEventsBefore);
  });

  it("writes one policy-risk row on the qualifying later non-GENESIS branch", () => {
    useRequireHumanPolicy();
    const store = approvableStore();
    seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
    const subject = currentRiskSubject(store);
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(1);

    const result = registryApprovalDispatcher(store)(
      qualifyingPayload(),
      "cmd-policy-risk-later-approval",
    );

    expectRegistryDisposition(result, "DECIDED");
    expectOnePolicyRiskRecord(store, subject);
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(1);
  });

  it("replays identical registry bytes without another approval, activation, or risk row", () => {
    useRequireHumanPolicy();
    const store = approvableStore();
    seedActivationGraph(store);
    const subject = currentRiskSubject(store);
    const dispatch = registryApprovalDispatcher(store);
    const payload = qualifyingPayload();
    const first = dispatch(payload, "cmd-policy-risk-replay");
    expectRegistryDisposition(first, "DECIDED");
    const decisionsBefore = readDurableLedger(store, PROJECT_ID).decisionCount;
    const activationsBefore = goalActivationCount(store);
    const riskBefore = riskRows(store, subject).length;

    const replay = dispatch(payload, "cmd-policy-risk-replay");

    expectRegistryDisposition(replay, "REPLAYED");
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(decisionsBefore);
    expect(goalActivationCount(store)).toBe(activationsBefore);
    expect(riskRows(store, subject)).toHaveLength(riskBefore);
    expect(riskBefore).toBe(1);
  });

  it("refuses a stale accepted secondary risk leg atomically at the durable store", () => {
    useRequireHumanPolicy();
    const base = openEmptyFileStore();
    driveThrough(base, "approval.decide");
    seedActivationGraph(base);
    const subject = currentRiskSubject(base);
    const { a, b } = twoHandles(base);
    const goalVersionBefore = a.getAggregateVersion(GOAL_ID);
    let competitorCommitted = false;
    const facade = commitSeamFacade(a, () => {
      const competing = buildPolicyRiskLeg(b, policyRiskInput(
        qualifyingApproval(),
        OPERATOR_PRINCIPAL_ID,
        subject,
        "cmd-competing-policy-risk",
      ));
      if (!competing.ok) throw new Error(`${competing.code}@${competing.layer}`);
      b.commit({
        aggregateId: competing.leg.aggregateId,
        commandBytes: encoder.encode("competing-policy-risk"),
        commandId: "cmd-competing-policy-risk",
        committedAt: DECIDED_AT,
        events: competing.leg.events,
        expectedVersion: competing.leg.expectedVersion,
      });
      competitorCommitted = true;
    });

    const result = registryApprovalDispatcher(facade)(
      qualifyingPayload(),
      "cmd-stale-secondary-risk",
    );

    expect(competitorCommitted).toBe(true);
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome !== "REFUSED") throw new Error("stale risk leg unexpectedly committed");
    expect(result.refusal.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(result.refusal.layer).toBe("DURABLE_STORE");
    expect(a.getAggregateVersion(GOAL_ID)).toBe(goalVersionBefore);
    expect(goalActivationCount(a)).toBe(0);
    expect(a.readEvents(BUDGET_AGGREGATE)).toHaveLength(0);
    expect(riskRows(a, subject).map((row) => row.eventId)).toEqual([
      `cmd-competing-policy-risk-${POLICY_RISK_EVENT_TYPE}`,
    ]);
  });

  it("fences the risk subject against a concurrent active-graph slot advance", () => {
    useRequireHumanPolicy();
    const base = openEmptyFileStore();
    driveThrough(base, "approval.decide");
    seedActivationGraph(base);
    const subject = currentRiskSubject(base);
    const { a, b } = twoHandles(base);
    const goalVersionBefore = a.getAggregateVersion(GOAL_ID);
    const slot = observeActiveGraphSlot(a, PROJECT_ID);
    const facade = commitSeamFacade(a, () => advanceActiveGraphSlot(b));

    const result = registryApprovalDispatcher(facade)(
      qualifyingPayload(),
      "cmd-stale-active-graph-subject",
    );

    expect(result.outcome).toBe("REFUSED");
    if (result.outcome !== "REFUSED") throw new Error("stale graph subject unexpectedly committed");
    expect(result.refusal.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(result.refusal.layer).toBe("DURABLE_STORE");
    expect(a.getAggregateVersion(GOAL_ID)).toBe(goalVersionBefore);
    expect(goalActivationCount(a)).toBe(0);
    expect(riskRows(a, subject)).toHaveLength(0);
    expect(a.getCommandDecision({
      commandId: "cmd-stale-active-graph-subject",
      principalId: OPERATOR_PRINCIPAL_ID,
      projectId: PROJECT_ID,
    })).toMatchObject({
      expectedVersion: slot.version,
      observedVersion: slot.version + 1,
      targetAggregateId: slot.aggregateId,
    });
  });

  it("omits risk without a humanReview witness while SPEED still commits the approval", () => {
    useImmediateSpeedPolicy();
    const store = openEmptyFileStore();
    driveThrough(store, "approval.decide");
    seedActivationGraph(store);
    const subject = currentRiskSubject(store);
    const before = riskRows(store, subject).length;
    const { a, b } = twoHandles(store);
    const slot = observeActiveGraphSlot(a, PROJECT_ID);
    const facade = commitSeamFacade(a, () => advanceActiveGraphSlot(b));

    const result = send(facade, envelope("approval.decide", 0, qualifyingPayload()));

    expect(result.ok, result.ok ? "" : `${result.code}@${result.refusedBy}`).toBe(true);
    expect(observeActiveGraphSlot(a, PROJECT_ID).version).toBe(slot.version + 1);
    expect(goalActivationCount(a)).toBe(1);
    expect(riskRows(a, subject)).toHaveLength(before);
    expectPolicyRiskRefusal(
      a,
      qualifyingApproval(),
      null,
      subject,
      "POLICY_RISK_ACTOR_NOT_HUMAN",
    );
  });

  it("omits risk for a null policyDecisionRef while the witnessed approval commits", () => {
    useRequireHumanPolicy();
    const store = approvableStore();
    seedActivationGraph(store);
    const subject = currentRiskSubject(store);
    const before = riskRows(store, subject).length;

    const result = registryApprovalDispatcher(store)(qualifyingPayload({ policyDecisionRef: null }));

    expectRegistryDisposition(result, "DECIDED");
    expect(goalActivationCount(store)).toBe(1);
    expect(riskRows(store, subject)).toHaveLength(before);
    expectPolicyRiskRefusal(
      store,
      qualifyingApproval({ policyDecisionRef: null }),
      OPERATOR_PRINCIPAL_ID,
      subject,
      "POLICY_RISK_DECISION_REF_MISSING",
    );
  });

  it("omits risk for missing step-up at the typed activation seam", () => {
    const store = approvableStore();
    seedActivationGraph(store);
    const subject = currentRiskSubject(store);
    const approvalDecision = qualifyingApproval({ stepUpAuthRef: null });
    const before = riskRows(store, subject).length;

    const result = activateInitialGraph(
      contextFor(store, requestFor("cmd-risk-missing-step-up")),
      activationInputWithReview(store, approvalDecision),
    );

    expect(result.ok, result.ok ? "" : `${result.code}@${result.refusedBy}`).toBe(true);
    expect(goalActivationCount(store)).toBe(1);
    expect(riskRows(store, subject)).toHaveLength(before);
    expectPolicyRiskRefusal(
      store,
      approvalDecision,
      OPERATOR_PRINCIPAL_ID,
      subject,
      "POLICY_RISK_STEP_UP_MISSING",
    );
  });

  it("omits risk for a non-HUMAN actor at the typed activation seam", () => {
    const store = approvableStore();
    seedActivationGraph(store);
    const subject = currentRiskSubject(store);
    const approvalDecision = qualifyingApproval({ actorKind: "SYSTEM_POLICY" });
    const before = riskRows(store, subject).length;

    const result = activateInitialGraph(
      contextFor(store, requestFor("cmd-risk-non-human")),
      activationInputWithReview(store, approvalDecision),
    );

    expect(result.ok, result.ok ? "" : `${result.code}@${result.refusedBy}`).toBe(true);
    expect(goalActivationCount(store)).toBe(1);
    expect(riskRows(store, subject)).toHaveLength(before);
    expectPolicyRiskRefusal(
      store,
      approvalDecision,
      OPERATOR_PRINCIPAL_ID,
      subject,
      "POLICY_RISK_ACTOR_NOT_HUMAN",
    );
  });
});

describe("approve mints and binds the project's budget root (task-1de7b81a)", () => {
  it("records a budgetHash NO caller supplied, equal to the durable root's own digest", () => {
    const store = approvableStore();

    const outcome = send(store, approval());

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const root = durableRoot(store);
    // The witness value is the digest RECOMPUTED from the durable bytes, and the request that
    // produced it carried no budgetHash at all — so the field cannot have been passed through.
    expect(activationSection(store)["budgetHash"]).toBe(root.digest);
    expect(approvalPayload()["activation"]).not.toHaveProperty("budgetHash");
    expect(root.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("binds the genesis root to the approved revision at epoch 1, with a zero denominator", () => {
    const store = approvableStore();

    expect(send(store, approval()).ok).toBe(true);

    const { record } = durableRoot(store);
    expect(record.transition).toBe("ROOT_AUTHORIZED");
    expect(record.binding.graphEpoch).toBe(1);
    expect(record.binding.projectId).toBe(PROJECT_ID);
    expect(record.binding.goalRef).toBe(GOAL_ID);
    expect(record.authorization.amounts.length).toBeGreaterThan(0);
    expect(record.authorization.amounts.every((amount) => amount.amount === 0)).toBe(true);
  });

  it("refuses a caller budgetHash that disagrees with the server's, by exact code and layer", () => {
    const store = approvableStore();

    const outcome = send(store, approval({ budgetHash: "b0".padEnd(64, "0") }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.code).toBe("BOOTSTRAP_BUDGET_HASH_MISMATCH");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
  });

  // ARM A — ATOMICITY (ruling condition 4). Option B's entire safety claim: nothing about the
  // budget is durable before the decision, and a refusal leaves NO root behind. Option A could
  // not offer this, because its root was already committed by the time the approval was judged.
  it("ARM A: a REFUSED approval leaves no budget root at all, read through store events", () => {
    const store = approvableStore();
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(0);

    const refused = send(store, approval({ budgetHash: "b0".padEnd(64, "0") }));

    expect(refused.ok).toBe(false);
    // The leg was BUILT for this request — the writer ran, the reducer ran, the digest was
    // computed — and none of it reached the store, because a leg is bytes until a decision
    // commits it. A root here would be spend authority surviving a refused approval.
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(0);
    expect(store.getAggregateVersion(BUDGET_AGGREGATE)).toBe(0);
    expect(store.readEvents(GOAL_ID).filter((row) => row.eventType === ACTIVATION_EVENT_TYPE))
      .toHaveLength(0);
  });

  it("ARM A: a core-refused approval also leaves neither aggregate moved", () => {
    const store = approvableStore();
    const goalVersionBefore = store.getAggregateVersion(GOAL_ID);

    // The core judges `expectedGoalVersion`; 99 is nobody's version, so the reducer refuses
    // before any commit — a DIFFERENT refusal from the hash arm above, and the same invariant.
    const refused = send(store, approval({ expectedGoalVersion: 99 }));

    expect(refused.ok).toBe(false);
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(0);
    expect(store.getAggregateVersion(GOAL_ID)).toBe(goalVersionBefore);
  });

  // ARM B — READER VISIBILITY. A secondary leg commits durable events and advances its
  // aggregate's version, but `readDurableLedger` maps only `decision.targetAggregateId` — the
  // PRIMARY leg — so the ledger view never sees the budget aggregate at all. A verifier written
  // against the ledger would read version 0, conclude the root is absent, and refuse every
  // honest approval: a failure that looks exactly like a correct fail-closed refusal.
  it("ARM B: the committed root is visible to STORE EVENTS and invisible to the ledger view", () => {
    const store = approvableStore();

    expect(send(store, approval()).ok).toBe(true);

    // The reader production uses.
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(1);
    expect(store.getAggregateVersion(BUDGET_AGGREGATE)).toBe(1);
    // The reader that must NEVER be used for this, pinned so the distinction is deliberate
    // rather than incidental: same store, same moment, and it sees nothing.
    const ledger = readDurableLedger(store, PROJECT_ID);
    expect(ledger.aggregates.get(BUDGET_AGGREGATE)).toBeUndefined();
    expect(versionOf(ledger, BUDGET_AGGREGATE)).toBe(0);
    expect(stateOf(ledger, BUDGET_AGGREGATE)).toBeUndefined();
    // The PRIMARY leg is the goal, and it IS in the ledger — so the arm is measuring the
    // primary/secondary distinction and not a ledger that simply reads nothing.
    expect(versionOf(ledger, GOAL_ID)).toBeGreaterThan(0);
  });

  /**
   * THE FORK COLLAPSE'S ONLY SAFETY QUESTION (task-bdbe0519 step 6). `approval-activation.ts`
   * used to choose between `commitAccepted` and `commitAcceptedLegs` on whether a budget root
   * had to be minted. Both branches now go through `commitAcceptedLegs`, with `[]` in the extra
   * slot where the single-aggregate case used to take a different seam entirely.
   *
   * These two arms are the BYTE-COMPARE that keeps that a refactor. `decisionSha256` and
   * `effectSha256` are the store's own identity digests over the decision and its committed
   * effects, so a literal here pins the decision record a reader sees, not a restatement of the
   * code that built it. They were captured on the PRE-COLLAPSE tree and must not move.
   */
  it("COLLAPSE PIN: an approval onto an existing root commits ONE primary leg, unchanged", () => {
    const store = approvableStore();
    // A root already durable — the branch that used to call `commitAccepted` and now calls
    // `commitAcceptedLegs` with an empty extra slot. This is also the shape a SECOND approval in
    // a project takes: the genesis root is minted once and never again.
    seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");

    expect(send(store, approval()).ok).toBe(true);

    const decision = store.getCommandDecision(APPROVAL_DECISION_KEY);
    if (decision === null) throw new Error("the approval left no decision record");
    expect(decision.decisionSha256).toBe(EXISTING_ROOT_DECISION_SHA256);
    expect(decision.effectSha256).toBe(EXISTING_ROOT_EFFECT_SHA256);
    // ONE primary leg, and it is the goal — the single-aggregate case is still single.
    expect(decision.businessEventIds).toHaveLength(1);
    expect(goalActivationCount(store)).toBe(1);
  });

  it("COLLAPSE PIN: the GENESIS approval still rides two legs, decision unchanged", () => {
    const store = approvableStore();

    expect(send(store, approval()).ok).toBe(true);

    const decision = store.getCommandDecision(APPROVAL_DECISION_KEY);
    if (decision === null) throw new Error("the approval left no decision record");
    expect(decision.decisionSha256).toBe(GENESIS_DECISION_SHA256);
    expect(decision.effectSha256).toBe(GENESIS_EFFECT_SHA256);
    // LEGS[0] IS STILL THE GOAL. `businessEventIds` names the PRIMARY leg's events only, so it
    // reads 1 on both branches; the second leg is proven by the budget aggregate below, and the
    // effect digest is what distinguishes the two commits.
    expect(decision.businessEventIds).toHaveLength(1);
    expect(goalActivationCount(store)).toBe(1);
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(1);
  });

  it("COLLAPSE PIN: a replayed approval writes no second decision and no second activation", () => {
    const store = approvableStore();
    const first = send(store, approval());
    expect(first.ok).toBe(true);
    const decisionBefore = store.getCommandDecision(APPROVAL_DECISION_KEY);

    const replay = send(store, approval());

    expect(replay.ok).toBe(true);
    // Same decision record, not a second one written over the same key.
    expect(store.getCommandDecision(APPROVAL_DECISION_KEY)).toStrictEqual(decisionBefore);
    expect(goalActivationCount(store)).toBe(1);
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(1);
  });

  it("does not mint a SECOND root when the project already holds one", () => {
    const store = approvableStore();
    // The world's own FUNDED root, authorized before the approval — this repository's stand-in
    // for the grant it cannot yet express.
    seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
    const existing = durableRoot(store);

    expect(send(store, approval()).ok).toBe(true);

    // One root, still the world's, and the witness binds THAT one by its recomputed digest.
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(1);
    expect(activationSection(store)["budgetHash"]).toBe(existing.digest);
    expect(existing.record.authorization.amounts.some((amount) => amount.amount > 0)).toBe(true);
  });
});

/**
 * THE DECIDE-TIME BUDGET COMMITMENT'S BIND-BACK (task-61a2e8ad, ruling comment-87ad84c1
 * condition 3).
 *
 * `record.budgetRef` used to be a required 64-hex field that NOTHING on the server ever read: a
 * caller could put any well-formed digest there and the approval committed regardless. These
 * arms are what makes it mean something — activation recomputes the commitment from its OWN
 * durable reads and compares.
 *
 * WHY THIS IS NOT THE `budgetHash` FENCE WEARING A NEW NAME, which is the divergence question
 * epic rail 7(A) asks. The two guards refuse on DIFFERENT INPUTS and their fixtures cannot trip
 * each other:
 *   - the `budgetHash` fence reads `activation.budgetHash`, an OPTIONAL field, and compares it
 *     to the ROOT digest. ARM G's request carries no `budgetHash` at all, so that fence is
 *     inert — `claimed === undefined` short-circuits it — and cannot be what answers.
 *   - the bind-back reads `record.budgetRef`, a REQUIRED field, and compares it to the
 *     COMMITMENT. The existing `budgetHash` arm above supplies no `budgetRef` override, so
 *     under ITS mutation the bind-back sees a matching commitment and stays silent.
 * Loosening either one leaves the other's arm red, which is the property a shared fence would
 * not have.
 */
describe("activation binds back to the decide-time budget commitment", () => {
  /** The commitment activation WILL recompute, built through the production builder. */
  function trueCommitment(store: SqliteEventStore): string {
    const input = inputFor(store);
    const material = budgetCommitmentMaterial(store, {
      approvedRun: {
        runBinding: input.binding,
        verifiedGraphRevisionRef: input.graphRevisionRef,
      },
      goalRef: GOAL_ID,
      projectId: PROJECT_ID,
    });
    expect(material.ok, material.ok ? "" : `${material.code}@${material.layer}`).toBe(true);
    if (!material.ok) throw new Error(`${material.code}@${material.layer}`);
    return budgetCommitmentDigest(material.material);
  }

  /** The same digest with ONE hex character moved: well-formed, in-shape, and not the value. */
  function nearMiss(digest: string): string {
    const last = digest.slice(-1);
    return `${digest.slice(0, -1)}${last === "0" ? "1" : "0"}`;
  }

  const withBudgetRef = (budgetRef: string): Envelope =>
    envelope("approval.decide", 0, approvalPayload({
      record: { ...approvalRecord(SEALED_SUBMISSION_HASH), budgetRef },
    }));

  // ARM G — a well-formed budgetRef that is NOT this run's commitment refuses by exact code and
  // exact layer, BEFORE anything budget-shaped becomes durable.
  it("ARM G: refuses a budgetRef that is not this run's commitment, and mints no root", () => {
    const store = approvableStore();
    const wrong = nearMiss(trueCommitment(store));
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(0);

    const outcome = send(store, withBudgetRef(wrong));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.code).toBe("BOOTSTRAP_BUDGET_COMMITMENT_MISMATCH");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    // The mismatch fires BEFORE the root is minted, so a refused approval leaves no spend
    // authority and no activation behind.
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(0);
    expect(store.getAggregateVersion(BUDGET_AGGREGATE)).toBe(0);
    expect(goalActivationCount(store)).toBe(0);
  });

  // ARM G, DIVERGENCE HALF. The refusal above is the COMMITMENT's, not the root fence's: the
  // request states no `budgetHash`, so `BOOTSTRAP_BUDGET_HASH_MISMATCH` is unreachable for it.
  it("ARM G: the near-miss request states no budgetHash, so the root fence cannot be what refused",
    () => {
      const store = approvableStore();
      const payload = approvalPayload({
        record: { ...approvalRecord(SEALED_SUBMISSION_HASH), budgetRef: "b".repeat(64) },
      });
      expect(payload["activation"]).not.toHaveProperty("budgetHash");

      const outcome = send(store, envelope("approval.decide", 0, payload));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected a refusal");
      expect(outcome.code).not.toBe("BOOTSTRAP_BUDGET_HASH_MISMATCH");
      expect(outcome.code).toBe("BOOTSTRAP_BUDGET_COMMITMENT_MISMATCH");
    });

  // ARM H — the matching commitment proceeds exactly as before: the root is minted and the
  // witness carries the ROOT digest, which is a DIFFERENT value from the commitment.
  it("ARM H: the true commitment proceeds and mints the root exactly as today", () => {
    const store = approvableStore();
    const commitment = trueCommitment(store);

    const outcome = send(store, withBudgetRef(commitment));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const root = durableRoot(store);
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(1);
    expect(activationSection(store)["budgetHash"]).toBe(root.digest);
    expect(root.digest).toMatch(/^[0-9a-f]{64}$/u);
    // The two notions stay distinct: the record commits to decide-time material, the witness
    // binds the minted root. Aliasing them would make the bind-back vacuous.
    expect(commitment).not.toBe(root.digest);
  });

  // WHO OWNS THE MALFORMED CASE, measured rather than assumed. `budget-commitment.ts` carries a
  // `BUDGET_COMMITMENT_REF_MALFORMED` code, but it is UNREACHABLE through this seam: the core's
  // own `validHex64` on the approval record answers first, at a different layer. Pinning the
  // layer here is what keeps that ordering honest — if the core ever stopped validating the
  // field, this arm reds rather than silently promoting the daemon guard into its place.
  it("leaves a NON-HEX budgetRef to the CORE validator, at the core's layer, not the bind-back",
    () => {
      const store = approvableStore();

      const outcome = send(store, withBudgetRef("not-a-digest"));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected a refusal");
      expect(outcome.refusedBy).toBe("CORE_REDUCER");
      expect(outcome.code).not.toBe("BOOTSTRAP_BUDGET_COMMITMENT_MISMATCH");
      expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(0);
    });
});
