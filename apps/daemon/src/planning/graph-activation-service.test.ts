/**
 * The accepted control for the atomic active-graph transition (task-eacea969), plus the replay
 * and conflict semantics its DoD 3 names.
 *
 * WHY THE ACCEPTED CONTROL IS THE ARM MOST WORTH DISTRUSTING. It is trivial to make one green by
 * seeding a graph revision by hand and asserting it is there. Every fact this file reads back is
 * therefore produced by a PRODUCTION writer: the run and its sealed body by the shipped bootstrap
 * sequence, the revision by `reduceGraphRevision` inside the service, and the read by
 * `readCurrentActiveGraph` — the same projection any consumer will use. Nothing in the fixture
 * commits a graph-revision event.
 */
import { applyApprovalCommand } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";
import type { ApprovalDecisionRecord } from "@moe/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_ID,
  GRAPH_REVISION_REF,
  PROJECT_ID,
  SEALED_GRAPH_CONTENT_HASH,
  SEALED_SUBMISSION_HASH,
  approvalCommand,
  approvalRecord,
  decisionCount,
} from "../bootstrap/bootstrap-test-fixtures.js";
import type { BootstrapRequest } from "../bootstrap/bootstrap-contracts.js";
import { readPolicyRisk } from "../bootstrap/policy-risk-reader.js";
import {
  POLICY_RISK_EVENT_TYPE,
  decodePolicyRiskRecord,
  policyRiskAggregateIdFor,
  selectCurrentPolicyRiskRecord,
} from "../bootstrap/policy-risk-record.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import { activateApprovedGraph } from "./graph-activation-service.js";
import {
  activationWitness,
  approvableStore,
  closeStores,
  contextFor,
  inputFor,
  requestFor,
} from "./graph-activation-test-fixtures.js";
import { readGraphBody } from "./graph-body-record.js";

const decoder = new TextDecoder();

afterEach(() => {
  closeStores();
});

const REVISION_AGGREGATE = `graph-revision:${PROJECT_ID}:${GRAPH_REVISION_REF}`;
const POLICY_DECISION_REF = "9".repeat(64);
/**
 * The composition root's witness, which only an HTTP-origin operator dispatch can mint. It is
 * spelled out here rather than defaulted into `inputFor` so that every arm below states whether
 * this activation had one — the difference between the two is the writer's authentication fence.
 */
const OPERATOR_REVIEW = Object.freeze({ principalId: "principal-1" });

function graphRequest(commandId: string): BootstrapRequest {
  return { ...requestFor(commandId), kind: "graph.approve" } as unknown as BootstrapRequest;
}

function riskApproval(): ApprovalDecisionRecord {
  const verdict = applyApprovalCommand(
    { ...approvalRecord(SEALED_SUBMISSION_HASH), policyDecisionRef: POLICY_DECISION_REF },
    approvalCommand(),
  );
  if (!verdict.ok) throw new Error(`risk approval refused: ${verdict.error.code}`);
  return verdict.value;
}

function riskAggregateFor(subjectRef: string): string {
  return policyRiskAggregateIdFor({ actionKind: "plan.approve", projectId: PROJECT_ID, subjectRef });
}

function riskAggregate(): string {
  return riskAggregateFor(SEALED_GRAPH_CONTENT_HASH);
}

/** Only the risk events on the aggregate a given subject hashes to. */
function riskEventsOn(store: SqliteEventStore, subjectRef: string) {
  return store.readEvents(riskAggregateFor(subjectRef))
    .filter((event) => event.eventType === POLICY_RISK_EVENT_TYPE);
}

/** The four lifecycle events an initial activation writes, in the order the reducer emits them. */
const INITIAL_ACTIVATION_EVENT_TYPES = Object.freeze([
  "GraphRevisionCreated",
  "GraphRevisionSubmitted",
  "GraphRevisionApproved",
  "GraphRevisionActivated",
] as const);

describe("activateApprovedGraph commits one ACTIVE revision at epoch 1 (task-eacea969)", () => {
  it("writes a qualifying graph approval and resolves it through the production reader", () => {
    const store = approvableStore();
    const request = graphRequest("cmd-risk-graph-1");

    const outcome = activateApprovedGraph(
      contextFor(store, request),
      inputFor(store, { approval: riskApproval(), humanReview: OPERATOR_REVIEW }),
    );

    expect(outcome.ok).toBe(true);
    const events = store.readEvents(riskAggregate())
      .filter((event) => event.eventType === POLICY_RISK_EVENT_TYPE);
    expect(events).toHaveLength(1);
    const decoded = decodePolicyRiskRecord(events[0]?.payload ?? new Uint8Array());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(`${decoded.code}@${decoded.layer}`);
    expect(selectCurrentPolicyRiskRecord([decoded.record]))
      .toEqual({ ok: true, record: decoded.record });
    expect(readPolicyRisk(store, PROJECT_ID, "principal-1", "plan.approve")).toEqual({
      factId: POLICY_DECISION_REF,
      ok: true,
      tier: "R2",
      truthClass: "HUMAN_APPROVED",
    });
  });

  /**
   * THE WRITER'S AUTHENTICATION FENCE, and the only degree of freedom that moves between this arm
   * and the one above: the SAME qualifying approval, by the same actor, on the same store. If the
   * writer keyed `approvedBy` off `approval.actor` or `request.principalId` — both of which say
   * "principal-1" here — this arm would write a row and stay green while an MCP-dispatched
   * operator credential minted risk authority no human ever conferred.
   */
  it("REFUSES to attribute risk authority to a qualifying approval with no human witness", () => {
    const store = approvableStore();
    const request = graphRequest("cmd-risk-graph-unwitnessed");

    const outcome = activateApprovedGraph(
      contextFor(store, request), inputFor(store, { approval: riskApproval() }),
    );

    expect(outcome.ok).toBe(true);
    expect(store.readEvents(riskAggregate())).toHaveLength(0);
    // The approval is NOT blocked by the missing tier authority; the graph still activates.
    expect(readCurrentActiveGraph(store, PROJECT_ID).ok).toBe(true);
    // The consumer keeps answering fail-closed rather than seeing a fabricated tier.
    expect(readPolicyRisk(store, PROJECT_ID, "principal-1", "plan.approve")).toEqual({
      code: "POLICY_RISK_RECORD_MISSING", layer: "DAEMON_POLICY_RISK",
      ok: false, tier: null, truthClass: "UNKNOWN",
    });
  });

  /**
   * NO SUBSEQUENT-ACTIVATION ARM LIVES HERE, and the reason is a MEASURED limit of this world,
   * not an omission. `graph.approve` appends the risk leg to the RESULT of the GENESIS ternary,
   * so there is exactly ONE append site and a "genesis-only" risk leg is unrepresentable on this
   * path. Attempting the arm anyway: a second activation against `approvableStoreWithTwoGoals`'s
   * second goal refuses `BUDGET_PROJECTION_SCOPE_FOREIGN` BEFORE any leg is built, with no risk
   * code involved — measured with a plain `inputForSecondGoal(store)` carrying no risk overrides
   * at all, so the refusal is the budget projection's and predates this row (task-bdbe0519).
   */
  /**
   * ATOMICITY (DoD 3): a refused activation leaves NO risk row, and a replay writes none twice.
   *
   * HONEST SCOPE, because the arm's name would otherwise overclaim. Every refusal reachable from
   * a single process answers BEFORE `commitExpectedVersionDecisionLegs` — the drifted-bytes
   * conflict at `replayOf` (graph-activation-service.ts:162) and the read-side revision guard
   * both do. So what this arm proves is that a risk leg is BYTES until a decision commits it and
   * that no path writes it out of band; the in-commit expected-version race is NOT reachable
   * here, exactly as the CONCURRENT arm below already records for the approval itself. The leg
   * rides the same `commitAcceptedLegs` array as the approval (graph-activation-service.ts:241),
   * which is what makes the race case a property of the store rather than of this call site.
   */
  it("a refused activation leaves no risk row, and a replay writes none twice", () => {
    const store = approvableStore();
    // The first activation carries NO witness, so the aggregate starts genuinely empty of risk.
    const first = activateApprovedGraph(
      contextFor(store, graphRequest("cmd-risk-atomic")), inputFor(store),
    );
    expect(first.ok).toBe(true);
    expect(store.readEvents(riskAggregate())).toHaveLength(0);
    const horizon = store.readEventHorizon();

    // Same decision identity, different request bytes, and this time a fully qualifying
    // witnessed approval: the leg is built, the commit refuses, and neither lands.
    const drifted = activateApprovedGraph(
      contextFor(store, { ...graphRequest("cmd-risk-atomic"), payload: { drifted: true } }),
      { ...inputFor(store), approval: riskApproval(), humanReview: OPERATOR_REVIEW },
    );

    expect(drifted.ok).toBe(false);
    if (drifted.ok) throw new Error("expected a refusal");
    expect(drifted.code).toBe("BOOTSTRAP_COMMAND_BYTES_CONFLICT");
    expect(drifted.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(store.readEvents(riskAggregate())).toHaveLength(0);
    expect(store.readEventHorizon()).toBe(horizon);

    // REPLAY, on a store that now DOES write a row: the identical witnessed command twice.
    const replayStore = approvableStore();
    const witnessed = { ...inputFor(replayStore), approval: riskApproval(), humanReview: OPERATOR_REVIEW };
    const request = graphRequest("cmd-risk-replay");
    expect(activateApprovedGraph(contextFor(replayStore, request), witnessed).ok).toBe(true);
    expect(riskEventsOn(replayStore, SEALED_GRAPH_CONTENT_HASH)).toHaveLength(1);

    const replayed = activateApprovedGraph(contextFor(replayStore, request), witnessed);

    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error("expected a replay");
    expect(replayed.disposition).toBe("REPLAYED");
    expect(riskEventsOn(replayStore, SEALED_GRAPH_CONTENT_HASH)).toHaveLength(1);
  });

  it("still activates while omitting risk authority from a non-qualifying approval", () => {
    const store = approvableStore();
    const request = graphRequest("cmd-risk-graph-omitted");

    const outcome = activateApprovedGraph(
      contextFor(store, request), inputFor(store, { humanReview: OPERATOR_REVIEW }),
    );

    expect(outcome.ok).toBe(true);
    expect(store.readEvents(riskAggregate())).toHaveLength(0);
    expect(readCurrentActiveGraph(store, PROJECT_ID).ok).toBe(true);
  });

  it("ACCEPTED CONTROL: the projection answers with the run's own sealed content at epoch 1", () => {
    const store = approvableStore();
    // Nothing has ever written this aggregate: the service is about to be its whole history.
    expect(store.readEvents(REVISION_AGGREGATE)).toHaveLength(0);
    expect(readCurrentActiveGraph(store, PROJECT_ID).ok).toBe(false);

    const request = requestFor("cmd-activate-1");
    const outcome = activateApprovedGraph(contextFor(store, request), inputFor(store));

    expect(outcome.ok, outcome.ok ? "" : `${outcome.code}/${outcome.refusedBy}`).toBe(true);
    if (!outcome.ok) throw new Error("expected an accepted activation");
    expect(outcome.authority).toBe("DURABLE_DECISION");
    expect(outcome.disposition).toBe("DECIDED");

    // THE CONSUMER'S OWN READ, not a re-derivation. Until this row it could never answer for a
    // project whose graph was written by a command rather than by a fixture.
    const active = readCurrentActiveGraph(store, PROJECT_ID);
    expect(active.ok, active.ok ? "" : `${active.code}/${active.sourceCode ?? "-"}`).toBe(true);
    if (!active.ok) throw new Error("expected an active graph");
    expect(active.graphEpoch).toBe(1);
    expect(active.revisionId).toBe(GRAPH_REVISION_REF);
    expect(active.graphContentHash).toBe(SEALED_GRAPH_CONTENT_HASH);
    expect(active.provenance.goalRef).toBe(GOAL_ID);
  });

  it("writes exactly the four lifecycle events, on one aggregate, in reducer order", () => {
    const store = approvableStore();

    expect(activateApprovedGraph(contextFor(store, requestFor("cmd-activate-1")), inputFor(store))
      .ok).toBe(true);

    const events = store.readEvents(REVISION_AGGREGATE);
    expect(events.map((event) => event.eventType))
      .toStrictEqual([...INITIAL_ACTIVATION_EVENT_TYPES]);
    expect(store.getAggregateVersion(REVISION_AGGREGATE)).toBe(4);
    // The GOAL is the primary leg and its own activation event rides the same decision.
    expect(store.readEvents(GOAL_ID).filter((row) => row.eventType === "GoalExecutionEnabled"))
      .toHaveLength(1);
    expect(decisionCount(store)).toBeGreaterThan(0);
  });

  it("binds the RECOMPUTED content hash and never the structural snapshotIdentity", () => {
    const store = approvableStore();

    expect(activateApprovedGraph(contextFor(store, requestFor("cmd-activate-1")), inputFor(store))
      .ok).toBe(true);

    const body = readGraphBody(store, PROJECT_ID, SEALED_GRAPH_CONTENT_HASH);
    if (!body.ok) throw new Error(`fixture body unreadable: ${body.code}`);
    const activated = store.readEvents(REVISION_AGGREGATE)
      .find((event) => event.eventType === "GraphRevisionActivated");
    if (activated === undefined) throw new Error("no activation event");
    const witness = (JSON.parse(decoder.decode(activated.payload)) as {
      witness: Record<string, unknown>;
    }).witness;
    expect(witness["graphHash"]).toBe(SEALED_GRAPH_CONTENT_HASH);
    expect(witness["graphEpoch"]).toBe(1);
    // dec-64b2391c option A, asserted rather than argued: the two are both 64-hex on one object,
    // which is exactly why a name-grep cannot catch the substitution.
    expect(body.snapshotIdentity).not.toBe(SEALED_GRAPH_CONTENT_HASH);
    expect(witness["graphHash"]).not.toBe(body.snapshotIdentity);
  });

  it("records the whole server-composed binding on the goal's durable event", () => {
    const store = approvableStore();

    expect(activateApprovedGraph(contextFor(store, requestFor("cmd-activate-1")), inputFor(store))
      .ok).toBe(true);

    const [enabled] = store.readEvents(GOAL_ID)
      .filter((row) => row.eventType === "GoalExecutionEnabled");
    if (enabled === undefined) throw new Error("no goal activation event");
    const payload = JSON.parse(decoder.decode(enabled.payload)) as {
      activation: Record<string, unknown>;
    };
    const binding = payload.activation["graphActivationBinding"] as Record<string, unknown>;
    expect(Object.keys(binding).sort()).toStrictEqual([
      "budgetHash", "expectedGoalVersion", "graphHash", "policyHash", "qualityHash",
    ]);
    expect(binding["graphHash"]).toBe(SEALED_GRAPH_CONTENT_HASH);
    expect(binding["expectedGoalVersion"]).toBe(1);
    for (const key of ["budgetHash", "policyHash", "qualityHash"]) {
      expect(binding[key], key).toMatch(/^[0-9a-f]{64}$/u);
    }
    // The request stated none of them, so none of them can have been passed through.
    for (const key of Object.keys(binding)) {
      if (key !== "expectedGoalVersion") expect(activationWitness()).not.toHaveProperty(key);
    }
  });
});

describe("replay and conflict leave the durable record exactly where it was", () => {
  it("SAME BYTES replay: the original decision, and NO new event or decision row", () => {
    const store = approvableStore();
    const request = requestFor("cmd-activate-1");
    const first = activateApprovedGraph(contextFor(store, request), inputFor(store));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected an accepted activation");
    const horizonAfterFirst = store.readEventHorizon();
    const decisionsAfterFirst = decisionCount(store);

    const replayed = activateApprovedGraph(contextFor(store, request), inputFor(store));

    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error("expected a replayed activation");
    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.decision.decisionId).toBe(first.decision.decisionId);
    // COUNTS, not just the returned value: a second event is invisible to a return-value check.
    expect(store.readEventHorizon()).toBe(horizonAfterFirst);
    expect(decisionCount(store)).toBe(decisionsAfterFirst);
    expect(store.getAggregateVersion(REVISION_AGGREGATE)).toBe(4);
  });

  it("CHANGED BYTES under one decision identity refuse rather than echo the first decision", () => {
    const store = approvableStore();
    const request = requestFor("cmd-activate-1");
    expect(activateApprovedGraph(contextFor(store, request), inputFor(store)).ok).toBe(true);
    const horizon = store.readEventHorizon();

    const drifted = activateApprovedGraph(
      contextFor(store, requestFor("cmd-activate-1", { drifted: true })),
      inputFor(store),
    );

    expect(drifted.ok).toBe(false);
    if (drifted.ok) throw new Error("expected a refusal");
    expect(drifted.code).toBe("BOOTSTRAP_COMMAND_BYTES_CONFLICT");
    expect(drifted.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("CONCURRENT activation: the read-side existing-revision guard refuses the loser", () => {
    const store = approvableStore();
    // Both contexts are built BEFORE either commits, so both hold the same pre-activation fences.
    const first = contextFor(store, requestFor("cmd-activate-1"));
    const second = contextFor(store, requestFor("cmd-activate-2"));
    const firstInput = inputFor(store);
    const secondInput = inputFor(store);

    const winner = activateApprovedGraph(first, firstInput);
    const loser = activateApprovedGraph(second, secondInput);

    expect(winner.ok).toBe(true);
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("expected the second activation to lose");
    // The READ-SIDE existing-revision guard answers first: by the time the loser is decided, the
    // revision aggregate already carries the winner's events. The store's expected-version fence
    // remains the authority for a genuine cross-process race, but a single-process fixture cannot
    // reach it because this read answers earlier.
    expect(loser.code).toBe("GRAPH_REVISION_ALREADY_RECORDED");
    expect(loser.refusedBy).toBe("GRAPH_REVISION_ACTIVATION");
    expect(store.getAggregateVersion(REVISION_AGGREGATE)).toBe(4);
    expect(store.readEvents(GOAL_ID).filter((row) => row.eventType === "GoalExecutionEnabled"))
      .toHaveLength(1);
    expect(readCurrentActiveGraph(store, PROJECT_ID).ok).toBe(true);
  });
});
