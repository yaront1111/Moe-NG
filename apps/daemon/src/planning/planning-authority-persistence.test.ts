/**
 * Durable persistence of the plan.propose authority BODIES.
 *
 * The core carrier (task-ff82bb75) admits a canonical PlanRevision and AcceptanceContract, cross-
 * checks them, seals a six-field IDENTITY into `PlanningSubmissionSealed` — and then drops the
 * bodies. This suite is about the bodies surviving: same decision, second leg, so plan and
 * criteria content cannot exist without `PlanProposed` nor `PlanProposed` without them.
 *
 * Everything runs through the REAL production edge: `runBootstrapCommand` over a real
 * `SqliteEventStore` with the real `plan.propose` handler. The bodies are minted by `@moe/core`'s
 * own `createPlanRevision` / `createAcceptanceContract`, and they are read back by `@moe/core`'s
 * own decoders — a fixture that hand-shaped either would be testing itself.
 *
 * RESCOPE: this row persists BODIES, not b42db644's envelope. That envelope's submission section
 * demands a PLAN_REVIEW lifecycle with sealed hashes, which no plan.propose chain can reach
 * (comment-4f54a956); composing it is task-bb923a7b's seam.
 */
import { createHash } from "node:crypto";

import {
  createAcceptanceContract,
  createPlanRevision,
  decodeAcceptanceContractBytes,
  decodePlanRevisionBytes,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID,
  PROJECT_ID,
  RUN_ID,
  closeStores,
  decisionCount,
  driveThrough,
  envelope,
  hex64,
  openStore,
  planningChain,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  buildPlanningAuthorityLeg,
  planningAuthorityAggregateId,
} from "./planning-authority-persistence.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const AUTHORITY_AGGREGATE = planningAuthorityAggregateId(RUN_ID);
const PERSISTENCE_LAYER = "PLANNING_AUTHORITY_PERSISTENCE";
const AUTHORITY_EVENT = "PlanningAuthorityBodiesSealed";
const GRAPH_REVISION_REF = "graph-revision-authority";
const CRITERION_IDS = Object.freeze(["criterion-a", "criterion-b"]);

afterEach(() => {
  closeStores();
});

type Json = Record<string, unknown>;

function planRevision(patch: Json = {}): Json {
  const built = createPlanRevision({
    affectedCriterionIds: [...CRITERION_IDS],
    affectedNodeIds: ["node-a"],
    approvalState: "PENDING_APPROVAL",
    authorRef: "architect-authority",
    graphBinding: { graphContentHash: hex64("c0ffee"), graphRevisionRef: GRAPH_REVISION_REF },
    parentRevisionId: null,
    rejectionRef: null,
    revisionId: "revision-authority",
    steps: [{ description: "Land the authority body.", kind: "ANALYSIS", stepId: "step-00001" }],
    verificationRecipeRefs: ["recipe-gate"],
    ...patch,
  });
  if (!built.ok) throw new Error(`plan fixture refused: ${built.code}@${built.layer}`);
  return built.revision as unknown as Json;
}

function acceptanceContract(patch: Json = {}): Json {
  const built = createAcceptanceContract({
    applicability: {
      graphContentHash: hex64("c0ffee"), graphRevisionRef: GRAPH_REVISION_REF,
      nodeIds: ["node-a"], nodeKind: "LEAF",
    },
    authorRef: "architect-authority",
    contractId: "contract-authority",
    obligations: CRITERION_IDS.map((criterionId) => ({
      criterionId,
      evidenceRequirements: [{
        evidenceRef: `evidence-${criterionId}`, kind: "VERIFICATION_RECEIPT",
        requirementId: `requirement-${criterionId}`,
      }],
      statement: `the run satisfies ${criterionId}`,
      verificationRecipeRefs: [`recipe-${criterionId}`],
    })),
    ...patch,
  });
  if (!built.ok) throw new Error(`acceptance fixture refused: ${built.code}@${built.layer}`);
  return built.contract as unknown as Json;
}

/** The chain the daemon folds, with the LAST propose carrying the authority bodies. */
function authorityChain(overrides: Json = {}): readonly Json[] {
  const chain = [...planningChain()] as Json[];
  const authority = { acceptanceContract: acceptanceContract(), planRevision: planRevision() };
  const last = chain[chain.length - 1] as Json;
  chain[chain.length - 1] = {
    ...last, authority,
    submissionHash: (authority.planRevision as Json)["planHash"], ...overrides,
  };
  return chain;
}

function propose(
  store: SqliteEventStore, chain: readonly Json[], commandId = "cmd-plan.propose",
) {
  return send(store, envelope("plan.propose", 0, { commands: chain, runId: RUN_ID }, commandId));
}

function readyStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "plan.propose");
  return store;
}

const eventsOf = (store: SqliteEventStore, aggregateId: string): readonly Json[] =>
  store.readEvents(aggregateId).map((event) => JSON.parse(decoder.decode(event.payload)) as Json);

function authorityPayload(store: SqliteEventStore): Json {
  const events = store.readEvents(AUTHORITY_AGGREGATE);
  expect(events.length).toBe(1);
  const first = events[0];
  if (first === undefined) throw new Error("the authority aggregate holds no event");
  expect(first.eventType).toBe(AUTHORITY_EVENT);
  return JSON.parse(decoder.decode(first.payload)) as Json;
}

/** The sealed event the CORE carrier wrote, which the durable bodies must agree with. */
function sealedIdentity(store: SqliteEventStore): Json {
  const sealed = eventsOf(store, RUN_ID)
    .flatMap((payload) => (Array.isArray(payload) ? payload : [payload]))
    .find((event) => (event as Json)["kind"] === "PlanningSubmissionSealed");
  if (sealed === undefined) throw new Error("no PlanningSubmissionSealed on the run aggregate");
  return (sealed as Json)["authority"] as Json;
}

const bytesFrom = (base64: unknown): Uint8Array =>
  Uint8Array.from(Buffer.from(String(base64), "base64"));

const framedDigest = (left: Uint8Array, right: Uint8Array): string => createHash("sha256")
  .update(`${left.length}:`, "utf8").update(left)
  .update(`${right.length}:`, "utf8").update(right).digest("hex");

describe("plan.propose authority persistence — the accepted control", () => {
  it("commits the bodies on a second leg of the SAME decision", () => {
    const store = readyStore();
    const before = decisionCount(store);
    const outcome = propose(store, authorityChain());
    expect(outcome.ok).toBe(true);
    expect(decisionCount(store)).toBe(before + 1);
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(1);
    expect(store.getAggregateVersion(RUN_ID)).toBeGreaterThan(0);
  });

  it("stores both bodies as bytes the CORE decoders read back, with nonempty content", () => {
    const store = readyStore();
    expect(propose(store, authorityChain()).ok).toBe(true);
    const payload = authorityPayload(store);
    const revision = decodePlanRevisionBytes(bytesFrom(payload["planRevisionBytesBase64"]));
    const contract = decodeAcceptanceContractBytes(
      bytesFrom(payload["acceptanceContractBytesBase64"]),
    );
    expect(revision.ok).toBe(true);
    expect(contract.ok).toBe(true);
    if (!revision.ok || !contract.ok) throw new Error("a persisted body did not decode");
    expect(revision.revision.steps.length).toBeGreaterThan(0);
    expect(contract.contract.obligations.length).toBeGreaterThan(0);
    expect(revision.revision.affectedCriterionIds).toEqual([...CRITERION_IDS]);
  });

  it("binds the durable payload to the identity the core carrier sealed", () => {
    const store = readyStore();
    expect(propose(store, authorityChain()).ok).toBe(true);
    const payload = authorityPayload(store);
    const identity = sealedIdentity(store);
    expect({
      criteriaDigest: payload["criteriaDigest"], criteriaRef: payload["criteriaRef"],
      graphContentHash: payload["graphContentHash"],
      graphRevisionRef: payload["graphRevisionRef"], planHash: payload["planHash"],
      revisionId: payload["revisionId"],
    }).toEqual(identity);
    expect(payload["projectId"]).toBe(PROJECT_ID);
    expect(payload["runId"]).toBe(RUN_ID);
    expect(payload["submissionHash"]).toBe(identity["planHash"]);
  });

  it("binds the bodies digest over BOTH bodies, length-framed", () => {
    const store = readyStore();
    expect(propose(store, authorityChain()).ok).toBe(true);
    const payload = authorityPayload(store);
    expect(payload["bodiesDigest"]).toBe(framedDigest(
      bytesFrom(payload["planRevisionBytesBase64"]),
      bytesFrom(payload["acceptanceContractBytesBase64"]),
    ));
  });

  it("returns the binding fields in the decision result bytes", () => {
    const store = readyStore();
    const outcome = propose(store, authorityChain());
    if (!outcome.ok) throw new Error("the accepted control was refused");
    const result = JSON.parse(decoder.decode(outcome.decision.resultBytes)) as Json;
    const payload = authorityPayload(store);
    expect({
      authorityRef: result["authorityRef"], bodiesDigest: result["bodiesDigest"],
      criteriaDigest: result["criteriaDigest"], planHash: result["planHash"],
    }).toEqual({
      authorityRef: AUTHORITY_AGGREGATE, bodiesDigest: payload["bodiesDigest"],
      criteriaDigest: payload["criteriaDigest"], planHash: payload["planHash"],
    });
    expect(outcome.decision.key).toMatchObject({
      principalId: "principal-1", projectId: PROJECT_ID,
    });
  });
});

describe("plan.propose authority persistence — replay and the ledger blind spot", () => {
  it("replays a byte-identical resubmit without writing anything new", () => {
    const store = readyStore();
    const first = propose(store, authorityChain());
    if (!first.ok) throw new Error("the first proposal was refused");
    const events = store.readEvents(AUTHORITY_AGGREGATE).length;
    const decisions = decisionCount(store);
    const second = propose(store, authorityChain());
    if (!second.ok) throw new Error("the replay was refused");
    expect(decoder.decode(second.decision.resultBytes))
      .toBe(decoder.decode(first.decision.resultBytes));
    expect(store.readEvents(AUTHORITY_AGGREGATE).length).toBe(events);
    expect(decisionCount(store)).toBe(decisions);
  });

  /**
   * `readDurableLedger` folds ONLY `decision.targetAggregateId`, so a SECONDARY leg's aggregate
   * never appears in the ledger at all. Pinned as a test because it is the trap for every future
   * reader AND for the fence: `versionOf(ledger, ...)` would return 0 forever here, so the
   * builder must fence with `store.getAggregateVersion`.
   */
  it("keeps the authority aggregate invisible to the ledger but readable from the store", () => {
    const store = readyStore();
    expect(propose(store, authorityChain()).ok).toBe(true);
    expect(readDurableLedger(store, PROJECT_ID).aggregates.get(AUTHORITY_AGGREGATE)).toBeUndefined();
    expect(readDurableLedger(store, PROJECT_ID).aggregates.get(RUN_ID)).toBeDefined();
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(1);
  });
});

describe("plan.propose authority persistence — the legacy arm stays byte-identical", () => {
  it("commits an authority-less proposal exactly as before, with no authority aggregate", () => {
    const store = readyStore();
    const outcome = propose(store, planningChain() as readonly Json[]);
    expect(outcome.ok).toBe(true);
    expect(store.readEvents(AUTHORITY_AGGREGATE)).toEqual([]);
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(0);
  });

  it("seals no authority member on the legacy run event", () => {
    const store = readyStore();
    expect(propose(store, planningChain() as readonly Json[]).ok).toBe(true);
    const sealed = eventsOf(store, RUN_ID)
      .flatMap((payload) => (Array.isArray(payload) ? payload : [payload]))
      .find((event) => (event as Json)["kind"] === "PlanningSubmissionSealed");
    expect(sealed).toBeDefined();
    expect(Object.keys(sealed as Json)).not.toContain("authority");
  });
});

describe("plan.propose authority persistence — the builder refuses before any write", () => {
  const legInput = (state: Json, authority: Json, store: SqliteEventStore) => ({
    lastCommand: { authority, kind: "plan.propose", submissionHash: state["submissionHash"] },
    request: { principalId: "principal-1", projectId: PROJECT_ID },
    runId: RUN_ID,
    state,
    store,
  });

  const sealedState = (): Json => ({
    goalRef: GOAL_ID, lifecycle: "SUBMISSION_DRAINING",
    submissionHash: (planRevision() as Json)["planHash"],
  });

  it("accepts the control at the builder surface", () => {
    const store = readyStore();
    const result = buildPlanningAuthorityLeg(legInput(
      sealedState(),
      { acceptanceContract: acceptanceContract(), planRevision: planRevision() },
      store,
    ));
    expect(result.kind).toBe("LEG");
  });

  it("refuses when the submission hash does not recompute from the body", () => {
    const store = readyStore();
    const before = store.readEvents(AUTHORITY_AGGREGATE).length;
    const result = buildPlanningAuthorityLeg(legInput(
      { ...sealedState(), submissionHash: hex64("badbad") },
      { acceptanceContract: acceptanceContract(), planRevision: planRevision() },
      store,
    ));
    expect(result).toEqual({
      code: "PLANNING_AUTHORITY_SUBMISSION_HASH_MISMATCH", kind: "REFUSED",
      layer: PERSISTENCE_LAYER,
    });
    expect(store.readEvents(AUTHORITY_AGGREGATE).length).toBe(before);
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(0);
  });

  it("passes a core body refusal through with the core's own code and layer", () => {
    const store = readyStore();
    const tampered = { ...planRevision(), planHash: hex64("badbad") };
    const result = buildPlanningAuthorityLeg(legInput(
      sealedState(),
      { acceptanceContract: acceptanceContract(), planRevision: tampered },
      store,
    ));
    expect(result).toEqual({
      code: "PLAN_REVISION_DIGEST_MISMATCH", kind: "REFUSED", layer: "PLAN_REVISION_DIGEST",
    });
  });

  it("reads an absent authority member as the legacy arm", () => {
    const store = readyStore();
    const result = buildPlanningAuthorityLeg({
      lastCommand: { kind: "plan.propose", submissionHash: hex64("dec0de") },
      request: { principalId: "principal-1", projectId: PROJECT_ID },
      runId: RUN_ID, state: sealedState(), store,
    });
    expect(result).toEqual({ kind: "ABSENT" });
  });

  it("shapes the leg as one authority event on the run's own aggregate", () => {
    const store = readyStore();
    const result = buildPlanningAuthorityLeg(legInput(
      sealedState(),
      { acceptanceContract: acceptanceContract(), planRevision: planRevision() },
      store,
    ));
    if (result.kind !== "LEG") throw new Error("the control was refused");
    expect(result.leg.aggregateId).toBe(AUTHORITY_AGGREGATE);
    expect(result.leg.events.length).toBe(1);
    expect(result.leg.events[0]?.eventType).toBe(AUTHORITY_EVENT);
    expect(encoder.encode("probe").length).toBeGreaterThan(0);
  });

  /**
   * The fence must be read from the STORE. `readDurableLedger` cannot see a secondary leg's
   * aggregate, so a ledger fence would read 0 forever and every write after the first would be a
   * stale-version conflict. On an EMPTY aggregate a constant 0 is indistinguishable from a real
   * read, so this arm advances the aggregate FIRST — without it the assertion is vacuous.
   */
  it("fences a NON-EMPTY authority aggregate at its current store version", () => {
    const store = readyStore();
    expect(propose(store, authorityChain()).ok).toBe(true);
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(1);
    const result = buildPlanningAuthorityLeg(legInput(
      sealedState(),
      { acceptanceContract: acceptanceContract(), planRevision: planRevision() },
      store,
    ));
    if (result.kind !== "LEG") throw new Error("the control was refused");
    expect(result.leg.expectedVersion).toBe(1);
  });
});
