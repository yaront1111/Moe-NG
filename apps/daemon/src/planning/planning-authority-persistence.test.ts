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
import {
  GRAPH_CONTENT_ISSUE_CODES, GRAPH_CONTENT_LAYERS, encodeGraphContent,
} from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  driveTo, finalizeRequestIndex, legacyProposedStore,
} from "../bootstrap/bootstrap-journey-fixtures.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID,
  PROJECT_ID,
  RUN_ID,
  bootstrapSequence,
  closeStores,
  decisionCount,
  driveThrough,
  envelope,
  goalPayload,
  hex64,
  openStore,
  planningChain,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  PLANNING_AUTHORITY_PERSISTENCE_CODES,
  buildPlanningAuthorityLeg,
  planningAuthorityAggregateId,
} from "./planning-authority-persistence.js";
import { PLANNING_GRAPH_CONTENT_CODES } from "./planning-graph-content-ingress.js";
import { graphBodyAggregateId, readGraphBody } from "./graph-body-record.js";
import { PRIMARY, SECONDARY } from "./graph-query-test-fixtures.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const AUTHORITY_AGGREGATE = planningAuthorityAggregateId(RUN_ID);
const PERSISTENCE_LAYER = "PLANNING_AUTHORITY_PERSISTENCE";
const AUTHORITY_EVENT = "PlanningAuthorityBodiesSealed";
const GRAPH_REVISION_REF = "graph-revision-authority";
const CRITERION_IDS = Object.freeze(["criterion-a", "criterion-b"]);

/**
 * THE REAL GRAPH THIS SUITE'S BODIES BIND TO (task-c96ef2d1).
 *
 * Hoisted above the body builders because they now state `CONTENT_HASH` rather than
 * the retired placeholder: since the propose seam made `graphContentBytesBase64` MANDATORY, a body
 * stating a hash no bytes recompute to is refused `PLANNING_GRAPH_CONTENT_HASH_MISMATCH` before
 * any authority assertion is reached. The placeholder is retired here for the same reason it is
 * retired in the shipped journeys: nothing may state a graph hash it cannot produce the graph for.
 */
const CONTENT = PRIMARY;
const OTHER_CONTENT = SECONDARY;
const CONTENT_HASH = PRIMARY.graphContentHash;
const CONTENT_MEMBER = "graphContentBytesBase64";
const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

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
    graphBinding: { graphContentHash: CONTENT_HASH, graphRevisionRef: GRAPH_REVISION_REF },
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
      graphContentHash: CONTENT_HASH, graphRevisionRef: GRAPH_REVISION_REF,
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
    // The body its plan revision NAMES. Mandatory since task-c96ef2d1: a propose whose terminal
    // omits it is refused at the ingress, so every authority arm below would refuse for the
    // wrong reason without this. The WORLD gained a member; no arm's subject moved.
    [CONTENT_MEMBER]: base64Of(CONTENT.bytes),
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

/**
 * THE HOME ARM of task-16a6a2b1 (D1's mandatory-authority flip). Until this row the
 * propose seam answered an authority-less terminal with the ABSENT leg and committed
 * the run anyway — the "legacy arm" the describe below pinned byte-identical. D1 is
 * now closed at the edge: a `plan.propose` whose terminal carries no authority member
 * is REFUSED, and no legacy path remains for a caller to fall back onto.
 */
describe("plan.propose authority persistence — an authority-less proposal is refused", () => {
  it("refuses with PLANNING_AUTHORITY_REQUIRED at the persistence layer", () => {
    const store = readyStore();

    const outcome = propose(store, planningChain() as readonly Json[]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // BOTH, per the reason-code rail: more than one seam can refuse a propose, and an
    // arm pinning only "refused" would stay green if the core started answering first.
    expect(outcome.code).toBe("PLANNING_AUTHORITY_REQUIRED");
    expect(outcome.refusedBy).toBe(PERSISTENCE_LAYER);
  });

  it("leaves zero residue — no run event, no authority aggregate, no committed decision", () => {
    const store = readyStore();
    const runVersion = store.getAggregateVersion(RUN_ID);
    const decisions = decisionCount(store);

    expect(propose(store, planningChain() as readonly Json[]).ok).toBe(false);

    // Asserted against the STORE, never the handler's return value: a refusal that had
    // already written its first leg returns exactly the same shape as one that wrote
    // nothing, so only the store can tell the two apart.
    expect(store.getAggregateVersion(RUN_ID)).toBe(runVersion);
    expect(store.readEvents(AUTHORITY_AGGREGATE)).toEqual([]);
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(0);
    expect(decisionCount(store)).toBe(decisions);
  });

  it("still accepts the same seam when the terminal carries its authority", () => {
    // THE POSITIVE CONTROL, and it is what makes the refusal above mean something: the
    // seam, the chain and the store are identical, and only the authority member differs.
    // Without it, a propose broken for any other reason would satisfy the arms above.
    const store = readyStore();

    const outcome = propose(store, authorityChain());

    expect(outcome.ok).toBe(true);
    expect(store.readEvents(AUTHORITY_AGGREGATE)).toHaveLength(1);
  });

  it("carries the new code in the module's own refusal roster", () => {
    // Roster membership is DoD 1's second clause, and THIS ASSERTION IS THE ONLY THING
    // ENFORCING IT — measured, not assumed. The plan expected the compiler to catch a code
    // emitted outside the roster (SERVICE_REFUSED_BY is typed from it), so step 5's drill 2
    // dropped the member while the refusal kept emitting it: `pnpm --filter @moe/daemon
    // typecheck` stayed GREEN and only this arm reddened. `refused()` takes a bare `string`,
    // so nothing upstream of it is typed against the roster. Delete this arm and a refusal
    // code can leave the roster silently.
    expect(PLANNING_AUTHORITY_PERSISTENCE_CODES).toContain("PLANNING_AUTHORITY_REQUIRED");
  });
});

/**
 * WAS "the legacy arm stays byte-identical" (task-074e6d2e). RE-GRADED, NOT DELETED, by
 * task-16a6a2b1: 074e6d2e pinned that an authority-less proposal committed EXACTLY as it did
 * before authority bodies shipped, so the new member could not disturb the old path. **That
 * clause is DISCHARGED — the flip retires the old path rather than preserving it**, and the
 * same world is now this suite's evidence that it is gone. The world is untouched
 * (`planningChain()`, the shared authority-less builder); only the expected outcome moved.
 */
describe("plan.propose authority persistence — the retired legacy arm", () => {
  it("no longer commits an authority-less proposal, and creates no authority aggregate", () => {
    const store = readyStore();

    const outcome = propose(store, planningChain() as readonly Json[]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("PLANNING_AUTHORITY_REQUIRED");
    expect(store.readEvents(AUTHORITY_AGGREGATE)).toEqual([]);
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(0);
  });

  it("seals no run event at all, where it once sealed one without an authority member", () => {
    // 074e6d2e's original assertion was that the sealed submission carried NO `authority` key.
    // Asserting that again would be free: there is no sealed submission now. What survives is
    // the stronger property — the whole event is absent — read off the store rather than the
    // handler, so a refusal that had already written its leg would fail here.
    const store = readyStore();
    expect(propose(store, planningChain() as readonly Json[]).ok).toBe(false);
    const sealed = eventsOf(store, RUN_ID)
      .flatMap((payload) => (Array.isArray(payload) ? payload : [payload]))
      .find((event) => (event as Json)["kind"] === "PlanningSubmissionSealed");
    expect(sealed).toBeUndefined();
  });

  it("still describes a LEGACY durable run with no authority member — planted, not proposed", () => {
    // The world 074e6d2e pinned is real durable history and the guards that read it must keep
    // working, so it survives as a PLANTED store. Production cannot construct it since
    // task-16a6a2b1; per the task-93e8aab3 retirement ruling a guard production can no longer
    // trigger is fine to keep, and this arm says so rather than implying the propose path
    // still reaches it.
    const store = legacyProposedStore();
    const sealed = eventsOf(store, RUN_ID)
      .flatMap((payload) => (Array.isArray(payload) ? payload : [payload]))
      .find((event) => (event as Json)["kind"] === "PlanningSubmissionSealed");
    expect(sealed).toBeDefined();
    expect(Object.keys(sealed as Json)).not.toContain("authority");
    expect(store.readEvents(AUTHORITY_AGGREGATE)).toEqual([]);
  });
});

describe("plan.propose authority persistence — the builder refuses before any write", () => {
  const legInput = (state: Json, authority: Json, store: SqliteEventStore) => ({
    lastCommand: {
      authority, [CONTENT_MEMBER]: base64Of(CONTENT.bytes),
      kind: "plan.propose", submissionHash: state["submissionHash"],
    },
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

  it("refuses an absent authority member where it once read the legacy arm", () => {
    // RE-GRADED by task-16a6a2b1: this was `toEqual({ kind: "ABSENT" })`. That member is now
    // RETIRED from PlanningAuthorityLegResult — unreturnable, not merely unused — so the
    // builder's answer to a missing member is a refusal in its own vocabulary. Asserted at the
    // BUILDER surface, which is what makes this arm distinct from the service-level arms above:
    // it pins where the refusal is MINTED, not merely where it is carried.
    const store = readyStore();
    const result = buildPlanningAuthorityLeg({
      lastCommand: { kind: "plan.propose", submissionHash: hex64("dec0de") },
      request: { principalId: "principal-1", projectId: PROJECT_ID },
      runId: RUN_ID, state: sealedState(), store,
    });
    expect(result).toEqual({
      code: "PLANNING_AUTHORITY_REQUIRED", kind: "REFUSED", layer: PERSISTENCE_LAYER,
    });
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

// ---------------------------------------------------------------------------------------
// task-cd1784ce: the proposed graph body rides the propose decision.
//
// Every arm drives the PRODUCTION `plan.propose` handler through `send`; none calls the
// ingress directly, because DoD-3 forbids a fixture-only proof. The content is REAL codec
// output (`graph-query-test-fixtures`' PRIMARY/SECONDARY, built by `encodeGraphContent`),
// so the hash a body is stored under is one only the codec could have produced.
// ---------------------------------------------------------------------------------------

const BODY_AGGREGATE = graphBodyAggregateId(PROJECT_ID, CONTENT_HASH);
const INGRESS_LAYER = "PLANNING_GRAPH_CONTENT_INGRESS";
const SECOND_RUN_ID = "run-2";
/** Four bytes whose canonical base64 is "+//+AQ==" — it exercises BOTH non-standard alphabet
 *  characters and padding, neither of which the real body's encoding happens to contain. */
const ALPHABET_SAMPLE = Buffer.from(Uint8Array.from([251, 255, 254, 1])).toString("base64");

/** Both bodies must state the SAME graph hash: core refuses PLAN_AUTHORITY_GRAPH_CONTENT_MISMATCH. */
function boundChain(statedHash: string, overrides: Json = {}): readonly Json[] {
  const chain = [...planningChain()] as Json[];
  const revision = planRevision({
    graphBinding: { graphContentHash: statedHash, graphRevisionRef: GRAPH_REVISION_REF },
  });
  const contract = acceptanceContract({
    applicability: {
      graphContentHash: statedHash, graphRevisionRef: GRAPH_REVISION_REF,
      nodeIds: ["node-a"], nodeKind: "LEAF",
    },
  });
  const last = chain[chain.length - 1] as Json;
  chain[chain.length - 1] = {
    ...last,
    authority: { acceptanceContract: contract, planRevision: revision },
    submissionHash: (revision as Json)["planHash"],
    ...overrides,
  };
  return chain;
}

/** The accepted control: a body whose bytes recompute to the hash the plan revision states. */
const contentChain = (overrides: Json = {}): readonly Json[] =>
  boundChain(CONTENT_HASH, { [CONTENT_MEMBER]: base64Of(CONTENT.bytes), ...overrides });

interface Residue {
  readonly authorityEvents: number;
  readonly bodyEvents: number;
  readonly runEvents: number;
}

const residueOf = (store: SqliteEventStore): Residue => ({
  authorityEvents: store.readEvents(AUTHORITY_AGGREGATE).length,
  bodyEvents: store.readEvents(BODY_AGGREGATE).length,
  runEvents: store.readEvents(RUN_ID).length,
});

function refusalOf(outcome: ReturnType<typeof propose>): { code: string; refusedBy: string } {
  if (outcome.ok) throw new Error("expected a refusal, received an accepted decision");
  return { code: outcome.code, refusedBy: outcome.refusedBy };
}

/** Names the refusal in the failure message: "ok was false" does not say which layer spoke. */
function acceptedOf(outcome: ReturnType<typeof propose>): ReturnType<typeof propose> {
  if (!outcome.ok) throw new Error(`expected acceptance, got ${outcome.code}@${outcome.refusedBy}`);
  return outcome;
}

/** The four-hash seal the finalize terminal states; `graphContentHash` is what DoD-1 is about. */
function finalizeCommand(planHash: unknown, graphContentHash: string): Json {
  return {
    commandId: "chain-finalize",
    expectedVersion: 4,
    kind: "planning.finalize_submission",
    revision: {
      dependencyHash: hex64("d1"), graphContentHash,
      graphRevisionRef: GRAPH_REVISION_REF, planHash, qualityHash: hex64("dd"),
    },
    witness: {
      attemptTerminalRef: "attempt-terminal-1", effectTerminalRef: "effect-terminal-1",
      nodeSummaries: [{ executionBearing: true, nodeKey: "node-a" }],
      providerSlotTerminalRef: "slot-terminal-1", resourcesTerminalRef: "resources-terminal-1",
      truthClass: "DAEMON_VERIFIED",
    },
  };
}

describe("plan.propose graph content — the accepted control stores the body", () => {
  it("admits a propose carrying the body and stores it under the RECOMPUTED hash", () => {
    const store = readyStore();

    const outcome = acceptedOf(propose(store, contentChain()));

    expect(outcome.ok).toBe(true);
    const body = readGraphBody(store, PROJECT_ID, CONTENT_HASH);
    expect(body.ok).toBe(true);
    if (!body.ok) throw new Error(`body refused: ${body.code}`);
    // Asserted against the CODEC's own value, never a literal: the bytes on disk are the bytes
    // `encodeGraphContent` produced, which is the only thing that makes the hash meaningful.
    expect(Array.from(body.bytes)).toEqual(Array.from(CONTENT.bytes));
    expect(body.graphContentHash).toBe(CONTENT.graphContentHash);
  });

  it("keeps the run event and the authority event on the SAME accepted decision", () => {
    const store = readyStore();
    const before = decisionCount(store);

    acceptedOf(propose(store, contentChain()));

    expect(decisionCount(store)).toBe(before + 1);
    expect(residueOf(store)).toEqual({ authorityEvents: 1, bodyEvents: 1, runEvents: 1 });
  });

  it("stores the body under a key that is NOT the snapshot's structural identity", () => {
    const store = readyStore();

    acceptedOf(propose(store, contentChain()));

    const body = readGraphBody(store, PROJECT_ID, CONTENT_HASH);
    if (!body.ok) throw new Error(`body refused: ${body.code}`);
    // dec-64b2391c OPTION A: the structural identity and the content hash are different facts,
    // and this is the arm that survives a rename of either one.
    expect(body.snapshotIdentity).not.toBe(CONTENT_HASH);
    expect(store.readEvents(graphBodyAggregateId(PROJECT_ID, body.snapshotIdentity)).length).toBe(0);
  });
});

describe("plan.propose graph content — the sealed hash is reachable as a body", () => {
  it("seals the recomputed hash at finalize and serves that hash back from the store", () => {
    const store = readyStore();
    const chain = contentChain();
    acceptedOf(propose(store, chain));
    const planHash = ((chain[chain.length - 1] as Json)["authority"] as Json);
    const revision = (planHash as Json)["planRevision"] as Json;

    const finalized = propose(
      store, [finalizeCommand(revision["planHash"], CONTENT_HASH)], "cmd-finalize",
    );

    expect(finalized.ok).toBe(true);
    if (!finalized.ok) throw new Error(`finalize refused: ${finalized.code}`);
    const result = JSON.parse(decoder.decode(finalized.decision.resultBytes)) as Json;
    const sealed = (result["state"] as Json)["sealedHashes"] as Json;
    expect(sealed["graphContentHash"]).toBe(CONTENT_HASH);
    // The fact task-eacea969 needs: the SEALED value is reachable as a body, not just equal to one.
    const body = readGraphBody(store, PROJECT_ID, String(sealed["graphContentHash"]));
    expect(body.ok).toBe(true);
  });
});

describe("plan.propose graph content — a body that does not recompute is refused", () => {
  it("refuses PLANNING_GRAPH_CONTENT_HASH_MISMATCH when the bytes hash to another graph", () => {
    const store = readyStore();
    // Both bodies state OTHER_CONTENT's hash, so core's own cross-check is satisfied and the
    // only disagreement left is the one this row exists to catch.
    const chain = boundChain(OTHER_CONTENT.graphContentHash, {
      [CONTENT_MEMBER]: base64Of(CONTENT.bytes),
    });

    expect(refusalOf(propose(store, chain))).toEqual({
      code: "PLANNING_GRAPH_CONTENT_HASH_MISMATCH",
      refusedBy: INGRESS_LAYER,
    });
  });

  it("leaves ZERO residue on a mismatch — no run event, no authority event, no body row", () => {
    const store = readyStore();
    const chain = boundChain(OTHER_CONTENT.graphContentHash, {
      [CONTENT_MEMBER]: base64Of(CONTENT.bytes),
    });
    const before = decisionCount(store);

    expect(propose(store, chain).ok).toBe(false);

    expect(residueOf(store)).toEqual({ authorityEvents: 0, bodyEvents: 0, runEvents: 0 });
    expect(store.readEvents(graphBodyAggregateId(PROJECT_ID, OTHER_CONTENT.graphContentHash))
      .length).toBe(0);
    expect(decisionCount(store)).toBe(before);
  });
});

describe("plan.propose graph content — malformed members are refused by this seam", () => {
  it.each([
    ["a number", 7],
    ["an object", { bytes: "AAAA" }],
    ["an empty string", ""],
  ])("refuses %s as PLANNING_GRAPH_CONTENT_MALFORMED at the ingress layer", (_label, member) => {
    const store = readyStore();

    expect(refusalOf(propose(store, contentChain({ [CONTENT_MEMBER]: member })))).toEqual({
      code: "PLANNING_GRAPH_CONTENT_MALFORMED",
      refusedBy: INGRESS_LAYER,
    });
    expect(residueOf(store)).toEqual({ authorityEvents: 0, bodyEvents: 0, runEvents: 0 });
  });

  /**
   * `Buffer.from(s, "base64")` never throws: whitespace, the url-safe alphabet and missing
   * padding all decode best-effort. Each row asserts its spelling actually DIFFERS from the
   * canonical one and still decodes to the same bytes, so a transform that silently no-ops
   * cannot make the row assert nothing.
   *
   * The alphabet and padding rows use a four-byte sample rather than the real body because
   * PRIMARY's base64 happens to contain no `+`, no `/` and no `=` — measured, not assumed: the
   * first version of these rows was GREEN-on-the-control for exactly that reason. Sampling a
   * spelling the fixture cannot express is how a canonical-form arm goes vacuous.
   */
  it.each([
    ["leading and trailing whitespace", base64Of(CONTENT.bytes), (t: string): string => ` ${t} `],
    ["an embedded newline", base64Of(CONTENT.bytes),
      (t: string): string => `${t.slice(0, 8)}
${t.slice(8)}`],
    ["the url-safe alphabet", ALPHABET_SAMPLE,
      (t: string): string => t.replace(/\+/gu, "-").replace(/\//gu, "_")],
    ["no padding", ALPHABET_SAMPLE, (t: string): string => t.replace(/=+$/u, "")],
  ])("refuses %s as PLANNING_GRAPH_CONTENT_MALFORMED at the ingress layer",
    (_label, canonical, spell) => {
      const member = spell(canonical);
      expect(member).not.toBe(canonical);
      expect(Array.from(Uint8Array.from(Buffer.from(member, "base64"))))
        .toEqual(Array.from(Uint8Array.from(Buffer.from(canonical, "base64"))));
      const store = readyStore();

      expect(refusalOf(propose(store, contentChain({ [CONTENT_MEMBER]: member })))).toEqual({
        code: "PLANNING_GRAPH_CONTENT_MALFORMED",
        refusedBy: INGRESS_LAYER,
      });
      expect(residueOf(store)).toEqual({ authorityEvents: 0, bodyEvents: 0, runEvents: 0 });
    });
});

describe("plan.propose graph content — a codec refusal travels unrestamped", () => {
  it("hands back the CODEC's own code and layer for bytes that are not content", () => {
    const store = readyStore();
    const truncated = CONTENT.bytes.slice(0, Math.floor(CONTENT.bytes.length / 2));

    const refusal = refusalOf(
      propose(store, contentChain({ [CONTENT_MEMBER]: base64Of(truncated) })),
    );

    // The point of the arm is WHICH layer answered: a daemon restatement would still be a
    // refusal, and a test that only asserted "refused" could not tell the two apart.
    // Measured, then pinned: the exact pair, plus the roster membership that says WHY it is the
    // codec's to answer. A daemon restatement would still be a refusal, so "refused" alone
    // cannot tell the two apart — which layer spoke is the assertion.
    expect(refusal).toEqual({
      code: "GRAPH_CONTENT_UNREADABLE",
      refusedBy: "GRAPH_CONTENT_CODEC",
    });
    expect(refusal.refusedBy).not.toBe(INGRESS_LAYER);
    expect(GRAPH_CONTENT_LAYERS).toContain(refusal.refusedBy);
    expect(GRAPH_CONTENT_ISSUE_CODES).toContain(refusal.code);
    expect(residueOf(store)).toEqual({ authorityEvents: 0, bodyEvents: 0, runEvents: 0 });
  });
});

/**
 * RE-POINTED, NOT DELETED, by task-c96ef2d1. This was "the seam is TOLERANT until task-c96ef2d1":
 * a propose with no `graphContentBytesBase64` was ADMITTED and simply wrote no body row, and that
 * tolerance was the stated reason the shipped journeys could keep sealing hex64("c0ffee"). The
 * WORLD is unchanged — an otherwise complete propose with the member subtracted — and only
 * the expected outcome moved, because every shipped sender now carries the bytes.
 */
describe("plan.propose graph content — the member is MANDATORY (task-c96ef2d1)", () => {
  it("refuses PLANNING_GRAPH_CONTENT_REQUIRED at the ingress when the terminal omits it", () => {
    const store = readyStore();
    const chain = [...contentChain()] as Json[];
    const last = { ...(chain[chain.length - 1] as Json) };
    // Subtracted from the ACCEPTED world, and the subtraction is ASSERTED. Without this line a
    // rename of CONTENT_MEMBER would silently turn the arm into "a chain that never carried
    // bytes is refused", which is true of a chain this suite never builds.
    expect(typeof last[CONTENT_MEMBER]).toBe("string");
    delete last[CONTENT_MEMBER];
    chain[chain.length - 1] = last;
    const before = decisionCount(store);

    // BOTH halves, per the reason-code rail: more than one layer can refuse a propose, and an
    // arm pinning only "refused" stays green if the codec or the core starts answering first.
    expect(refusalOf(propose(store, chain))).toEqual({
      code: "PLANNING_GRAPH_CONTENT_REQUIRED",
      refusedBy: INGRESS_LAYER,
    });

    // Read the STORE, never the returned refusal: a seam that refused AFTER committing its first
    // leg hands back the same shape as one that wrote nothing. The second body aggregate is the
    // load-bearing half the tolerant arm already argued for — a seam that invented a row would
    // file it under the STATED hash, and a drill emitting an empty-bytes leg survives a check
    // that only looks at BODY_AGGREGATE. Measured then: it did.
    expect(residueOf(store)).toEqual({ authorityEvents: 0, bodyEvents: 0, runEvents: 0 });
    expect(store.readEvents(graphBodyAggregateId(PROJECT_ID, hex64("c0ffee"))).length).toBe(0);
    expect(decisionCount(store)).toBe(before);
  });

  it("admits the IDENTICAL chain WITH the member — the refusal is about ABSENCE", () => {
    // The positive control. Without it the arm above is equally satisfied by a seam that refuses
    // every propose, which is the opposite of what this row landed.
    const store = readyStore();

    acceptedOf(propose(store, contentChain()));

    expect(store.readEvents(BODY_AGGREGATE).length).toBe(1);
  });

  it("carries the new code in the ingress module's own refusal roster", () => {
    // The roster is what SERVICE_REFUSED_BY is typed from, but `refused()` takes a bare union
    // member, so a code emitted outside the roster left typecheck GREEN when task-16a6a2b1
    // measured the same shape one layer over. This assertion is the enforcement.
    expect(PLANNING_GRAPH_CONTENT_CODES).toContain("PLANNING_GRAPH_CONTENT_REQUIRED");
  });
});

/**
 * THE SHIPPED JOURNEY'S OWN BODY (task-c96ef2d1 DoD-3).
 *
 * Every arm above builds its own chain. This one drives the SEQUENCE THE PRODUCT SHIPS —
 * `bootstrapSequence()`, whose propose terminal is `sealedPlanningChain()` and whose finalize is
 * `finalizeChain()` — then asks the store for the body behind the hash that journey SEALED.
 * A hand-built control cannot answer that question: it proves the seam works, not that anything
 * production runs ever reaches it. That gap is exactly what left the accepted path producerless.
 */
describe("the SHIPPED journey seals a recomputed hash and stores its body", () => {
  /** Drives the shipped sequence through its finalize terminal and returns that outcome. */
  function shippedThroughFinalize(): {
    readonly finalized: ReturnType<typeof propose>;
    readonly store: SqliteEventStore;
  } {
    const store = openStore();
    const index = finalizeRequestIndex();
    driveTo(store, index);
    const request = bootstrapSequence()[index];
    if (request === undefined) throw new Error("the shipped sequence issues no finalize request");
    return { finalized: send(store, request), store };
  }

  function sealedGraphHash(finalized: ReturnType<typeof propose>): string {
    if (!finalized.ok) {
      throw new Error(`shipped finalize refused: ${finalized.code}@${finalized.refusedBy}`);
    }
    const result = JSON.parse(decoder.decode(finalized.decision.resultBytes)) as Json;
    const sealed = (result["state"] as Json)["sealedHashes"] as Json;
    return String(sealed["graphContentHash"]);
  }

  it("serves the SEALED hash back as a decoded body from the store", () => {
    const { finalized, store } = shippedThroughFinalize();

    const hash = sealedGraphHash(finalized);
    const body = readGraphBody(store, PROJECT_ID, hash);

    if (!body.ok) throw new Error(`shipped body refused: ${body.code}@${body.layer}`);
    // Nonempty is asserted separately from equality: a seam that stored zero bytes under a real
    // hash would satisfy a byte-comparison against another empty array.
    expect(body.bytes.length).toBeGreaterThan(0);
    expect(body.content.snapshot.nodes.length).toBeGreaterThan(0);
    expect(body.graphContentHash).toBe(hash);
  });

  it("seals the hash PUBLIC encodeGraphContent recomputes over that same content", () => {
    const { finalized, store } = shippedThroughFinalize();
    const hash = sealedGraphHash(finalized);
    const body = readGraphBody(store, PROJECT_ID, hash);
    if (!body.ok) throw new Error(`shipped body refused: ${body.code}`);

    // Re-run the PUBLIC codec over the decoded content. This is the assertion that reds if the
    // journey ever seals a hash it did not compute from the graph it stored.
    const reencoded = encodeGraphContent(body.content);

    if (!reencoded.ok) throw new Error(`re-encode refused: ${reencoded.issues[0]?.code ?? "?"}`);
    expect(reencoded.value.graphContentHash).toBe(hash);
    expect(Array.from(reencoded.value.bytes)).toEqual(Array.from(body.bytes));
    // dec-64b2391c OPTION A, at the SHIPPED seal rather than at a fixture: the structural
    // identity is a different fact, and binding it as content authority is the trap a
    // name-grep cannot see. This reds if a producer ever substitutes one for the other.
    expect(reencoded.value.snapshotIdentity).not.toBe(hash);
    expect(body.snapshotIdentity).not.toBe(hash);
  });

  it("no longer seals the retired c0ffee placeholder, and files no body under it", () => {
    const { finalized, store } = shippedThroughFinalize();

    const hash = sealedGraphHash(finalized);

    expect(hash).not.toBe(hex64("c0ffee"));
    // The placeholder names no body either, so a sender that half-retired it — real bytes,
    // stale stated hash — cannot pass by leaving a row under the old key.
    expect(store.readEvents(graphBodyAggregateId(PROJECT_ID, hex64("c0ffee"))).length).toBe(0);
  });
});

/** The same content under another goal/run: the body aggregate is keyed by CONTENT, not by run. */
function chainForRun(runId: string, goalId: string): readonly Json[] {
  return contentChain().map((entry) =>
    (entry as Json)["kind"] === "planning.create_draft"
      ? { ...(entry as Json), goalRef: goalId, runId }
      : entry);
}

describe("plan.propose graph content — one body row however many runs propose it", () => {
  it("admits a SECOND RUN proposing the same content and leaves exactly ONE body row", () => {
    const store = readyStore();
    acceptedOf(propose(store, contentChain()));

    const secondGoalId = "goal-2";
    acceptedOf(send(store, envelope("goal.create", 0, {
      ...goalPayload(),
      budgetAccountRef: "budget-account-2",
      goalId: secondGoalId,
      planningRunRef: SECOND_RUN_ID,
    }, "cmd-goal.create-run-2")));

    // The body aggregate is keyed by (project, contentHash) and event ids are GLOBALLY unique
    // here, so a second emission of `graph-body-<hash>` THROWS DurableIdConflictError rather
    // than refusing — the task-16a6a2b1 failure. Two goal-owned runs sharing one graph is the
    // reachable shape of that collision, and the pre-read guard is what makes this arm pass.
    const second = send(store, envelope(
      "plan.propose", 0, {
        commands: chainForRun(SECOND_RUN_ID, secondGoalId), runId: SECOND_RUN_ID,
      },
      "cmd-plan.propose-run-2",
    ));

    expect(acceptedOf(second).ok).toBe(true);
    expect(store.readEvents(BODY_AGGREGATE).length).toBe(1);
    expect(store.readEvents(SECOND_RUN_ID).length).toBe(1);
  });

  it("replays a byte-identical resubmit without a second body row", () => {
    const store = readyStore();
    acceptedOf(propose(store, contentChain()));

    acceptedOf(propose(store, contentChain()));

    expect(store.readEvents(BODY_AGGREGATE).length).toBe(1);
  });
});

describe("plan.propose graph content — the FINALIZE terminal refuses a body outright", () => {
  it("refuses PLANNING_FINALIZE_BODIES_SUPPLIED at DAEMON_INGRESS, before the fold", () => {
    const store = readyStore();
    const chain = contentChain();
    acceptedOf(propose(store, chain));
    const revision = ((chain[chain.length - 1] as Json)["authority"] as Json)["planRevision"];
    const before = residueOf(store);

    const refused = propose(store, [{
      ...finalizeCommand((revision as Json)["planHash"], CONTENT_HASH),
      [CONTENT_MEMBER]: base64Of(CONTENT.bytes),
    }], "cmd-finalize-smuggled");

    // TWO layers can now refuse content bytes, so the arm pins WHICH: the ingress fence answers
    // before the fold, not this row's own PLANNING_GRAPH_CONTENT_* codes.
    expect(refusalOf(refused)).toEqual({
      code: "PLANNING_FINALIZE_BODIES_SUPPLIED",
      refusedBy: "DAEMON_INGRESS",
    });
    expect(refusalOf(refused).code).not.toBe("PLANNING_GRAPH_CONTENT_MALFORMED");
    expect(residueOf(store)).toEqual(before);
  });

  it("admits the IDENTICAL body on a PROPOSE terminal — the fence is about the terminal", () => {
    const store = readyStore();

    // The positive control. Without it, the arm above is equally consistent with "this key is
    // never admissible anywhere", which is the opposite of what this row landed.
    acceptedOf(propose(store, contentChain()));

    expect(store.readEvents(BODY_AGGREGATE).length).toBe(1);
  });
});
