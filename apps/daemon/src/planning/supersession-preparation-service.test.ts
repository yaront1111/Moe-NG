/**
 * Contract + service arms for the durable supersession preparation (task-32c1ba45).
 *
 * The contract arms live here rather than in their own file so the task stays inside its five
 * declared paths. They police the vocabulary the ledger and the service both spend: closed code
 * rosters with EXACT pinned denominators, an exact-key request that cannot smuggle a current
 * authority fact, and one binding that both paired members are projected from.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import type { HandlerContext } from "../bootstrap/bootstrap-ledger.js";

import { proposedNotFinalizedStore } from "../bootstrap/bootstrap-journey-fixtures.js";
import {
  GOAL_ID, GRAPH_REVISION_REF, PROJECT_ID, RUN_ID,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import { activateApprovedGraph } from "./graph-activation-service.js";
import {
  approvableStore, closeStores, contextFor, inputFor, requestFor,
} from "./graph-activation-test-fixtures.js";
import { horizonDigestOf } from "./supersession-preparation-history.js";
import type { HorizonFacts } from "./supersession-preparation-history.js";
import {
  proposeSupersessionPreparation, submissionFinalized,
} from "./supersession-preparation-service.js";
import {
  PREPARATION_WINDOW_MS,
  PREPARATION_BINDING_FIELDS,
  SUPERSESSION_PREPARATION_CODES,
  SUPERSESSION_PREPARATION_REQUEST_KEYS,
  SUPERSESSION_PREPARATION_SERVICES,
  SUPERSESSION_RELEASE_CODES,
  SUPERSESSION_RELEASE_REQUEST_KEYS,
  bindPreparationGeneration,
  decodePreparationRequest,
  decodeReleaseRequest,
  fundingAggregateId,
  planningFenceAggregateId,
  preparationAggregateId,
  refusePreparation,
  refuseRelease,
  releaseGeneration,
} from "./supersession-preparation-contracts.js";
import type { PreparationGenerationBinding } from "./supersession-preparation-contracts.js";

const BINDING: PreparationGenerationBinding = Object.freeze({
  deadlineEpochMs: 1_760_000_600_000,
  factHorizonDigest: "f".repeat(64),
  generation: 3,
  goalRef: "goal-1",
  targetRevisionRef: "rev-2",
});

const REQUEST = Object.freeze({
  approvedTargetRevisionRef: "rev-2",
  commandId: "cmd-prepare-1",
  correlationId: "corr-1",
  decidedAt: "2026-08-26T00:00:00.000Z",
  goalRef: "goal-1",
  principalId: "principal-1",
  projectId: "project-1",
});

const RELEASE_REQUEST = Object.freeze({
  commandId: "cmd-release-1",
  correlationId: "corr-2",
  decidedAt: "2026-08-26T00:01:00.000Z",
  expectedPreparationVersion: 4,
  generation: 3,
  goalRef: "goal-1",
  principalId: "principal-1",
  projectId: "project-1",
});

export const PREPARE_DECIDED_AT = "2026-08-26T00:00:00.000Z";

afterEach(() => {
  closeStores();
});

/** A world whose ACTIVE graph was written by the production activation service, not by hand. */
export function activatedStore(): SqliteEventStore {
  const store = approvableStore();
  const outcome = activateApprovedGraph(
    contextFor(store, requestFor("cmd-activate-1")), inputFor(store),
  );
  if (!outcome.ok) throw new Error(`fixture activation refused: ${outcome.code}`);
  return store;
}

export const PROJECT_ID_FOR_PREPARATION = PROJECT_ID;
export const GOAL_ID_FOR_PREPARATION = GOAL_ID;

export function prepareRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approvedTargetRevisionRef: GRAPH_REVISION_REF,
    commandId: "cmd-prepare-1",
    correlationId: "corr-prepare",
    decidedAt: PREPARE_DECIDED_AT,
    goalRef: GOAL_ID,
    principalId: "principal-1",
    projectId: PROJECT_ID,
    ...overrides,
  };
}

/** The transport's own envelope. Its payload IS the preparation request, so replay is byte-exact. */
export function prepareContext(
  store: SqliteEventStore, commandId: string, payload = prepareRequest(),
): HandlerContext {
  return contextFor(store, requestFor(commandId, payload as JsonObject));
}

export function releaseContext(
  store: SqliteEventStore, commandId: string, generation: number, expectedPreparationVersion: number,
  overrides: Record<string, unknown> = {},
): HandlerContext {
  return contextFor(store, requestFor(commandId, {
    commandId, correlationId: "corr-release", decidedAt: "2026-08-26T00:05:00.000Z",
    expectedPreparationVersion, generation, goalRef: GOAL_ID, principalId: "principal-1",
    projectId: PROJECT_ID, ...overrides,
  } as JsonObject));
}

function generation(): ReturnType<typeof bindPreparationGeneration> {
  return bindPreparationGeneration({
    binding: BINDING,
    dispositionCoverage: "PARTIAL",
    dispositionDigest: "d".repeat(64),
    fencedLineages: ["node-b", "node-a"],
    meter: "PLANNING_TOKENS",
    quantity: 40,
  });
}

describe("supersession preparation vocabulary is closed and pinned (task-32c1ba45)", () => {
  it("pins the exact preparation, release and refusing-service denominators", () => {
    expect(SUPERSESSION_PREPARATION_CODES).toHaveLength(14);
    expect(SUPERSESSION_RELEASE_CODES).toHaveLength(7);
    expect(SUPERSESSION_PREPARATION_SERVICES).toHaveLength(2);
    expect(PREPARATION_BINDING_FIELDS).toHaveLength(5);
    expect(new Set(SUPERSESSION_PREPARATION_CODES).size)
      .toBe(SUPERSESSION_PREPARATION_CODES.length);
    expect(new Set(SUPERSESSION_RELEASE_CODES).size).toBe(SUPERSESSION_RELEASE_CODES.length);
  });

  it("stamps its own layer and the refusing service on a local refusal", () => {
    expect(refusePreparation("SUPERSESSION_PREPARATION_LINEAGE_EMPTY", "SUPERSESSION_PREPARATION_SERVICE"))
      .toEqual({
        code: "SUPERSESSION_PREPARATION_LINEAGE_EMPTY",
        layer: "SUPERSESSION_PREPARATION",
        ok: false,
        refusedBy: "SUPERSESSION_PREPARATION_SERVICE",
        sourceCode: null,
        sourceLayer: null,
      });
  });

  it("preserves an upstream code and layer instead of restamping them", () => {
    expect(refuseRelease(
      "SUPERSESSION_RELEASE_GENERATION_STALE",
      "SUPERSESSION_PREPARATION_LEDGER",
      { code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE" },
    )).toEqual({
      code: "SUPERSESSION_RELEASE_GENERATION_STALE",
      layer: "SUPERSESSION_PREPARATION",
      ok: false,
      refusedBy: "SUPERSESSION_PREPARATION_LEDGER",
      sourceCode: "EXPECTED_VERSION_CONFLICT",
      sourceLayer: "DURABLE_STORE",
    });
  });
});

describe("supersession preparation request carries identity and selectors only (task-32c1ba45)", () => {
  it("accepts exactly the seven identity/selector keys", () => {
    expect([...SUPERSESSION_PREPARATION_REQUEST_KEYS]).toEqual([
      "approvedTargetRevisionRef", "commandId", "correlationId", "decidedAt",
      "goalRef", "principalId", "projectId",
    ]);
    const decoded = decodePreparationRequest(REQUEST);
    expect(decoded.ok).toBe(true);
  });

  it.each([
    "content", "dispositions", "expectedVersion", "factHorizonDigest", "fencedLineages",
    "funding", "graphContentHash", "graphEpoch", "lifecycle", "snapshotIdentity",
  ])("refuses a request smuggling the current authority fact %s", (field) => {
    const refused = decodePreparationRequest({ ...REQUEST, [field]: "smuggled" });
    expect(refused).toEqual({
      code: "SUPERSESSION_PREPARATION_REQUEST_INVALID",
      layer: "SUPERSESSION_PREPARATION",
      ok: false,
      refusedBy: "SUPERSESSION_PREPARATION_SERVICE",
      sourceCode: null,
      sourceLayer: null,
    });
  });

  it("refuses a request missing a selector", () => {
    const { goalRef: _dropped, ...missing } = REQUEST;
    expect(decodePreparationRequest(missing)).toMatchObject({
      code: "SUPERSESSION_PREPARATION_REQUEST_INVALID",
      ok: false,
    });
  });

  it("accepts exactly the eight release keys and refuses an extra one", () => {
    expect([...SUPERSESSION_RELEASE_REQUEST_KEYS]).toEqual([
      "commandId", "correlationId", "decidedAt", "expectedPreparationVersion",
      "generation", "goalRef", "principalId", "projectId",
    ]);
    expect(decodeReleaseRequest(RELEASE_REQUEST).ok).toBe(true);
    expect(decodeReleaseRequest({ ...RELEASE_REQUEST, fenceLifecycle: "RELEASED" })).toMatchObject({
      code: "SUPERSESSION_RELEASE_REQUEST_INVALID",
      layer: "SUPERSESSION_PREPARATION",
      refusedBy: "SUPERSESSION_PREPARATION_LEDGER",
    });
  });

  it("refuses a non-integer generation or version fence", () => {
    expect(decodeReleaseRequest({ ...RELEASE_REQUEST, generation: 0 })).toMatchObject({
      code: "SUPERSESSION_RELEASE_REQUEST_INVALID",
    });
    expect(decodeReleaseRequest({ ...RELEASE_REQUEST, expectedPreparationVersion: -1 }))
      .toMatchObject({ code: "SUPERSESSION_RELEASE_REQUEST_INVALID" });
  });
});

describe("one binding projects both paired members (task-32c1ba45)", () => {
  it("gives the HELD reservation and the ACTIVE fence identical shared fields", () => {
    const prepared = generation();
    for (const field of PREPARATION_BINDING_FIELDS) {
      expect(prepared.funding[field]).toBe(prepared.binding[field]);
      expect(prepared.fence[field]).toBe(prepared.binding[field]);
    }
    expect(prepared.funding.lifecycle).toBe("HELD");
    expect(prepared.fence.lifecycle).toBe("ACTIVE");
    expect(prepared.funding.refunded).toBe(0);
    expect(prepared.fence.fencedLineages).toEqual(["node-a", "node-b"]);
  });

  it("derives one stored plan identity that both members cite", () => {
    const prepared = generation();
    expect(prepared.supersessionPlanId).toMatch(/^[0-9a-f]{64}$/u);
    expect(prepared.funding.reservationId).toBe(`${prepared.supersessionPlanId}#funding`);
    expect(prepared.fence.fenceRef).toBe(`${prepared.supersessionPlanId}#fence`);
  });

  it("moves the plan identity when any single shared field moves", () => {
    const base = generation().supersessionPlanId;
    for (const field of PREPARATION_BINDING_FIELDS) {
      const drifted = bindPreparationGeneration({
        binding: { ...BINDING, [field]: field === "generation" || field === "deadlineEpochMs"
          ? (BINDING[field] as number) + 1 : `${BINDING[field] as string}-x` },
        dispositionCoverage: "PARTIAL",
        dispositionDigest: "d".repeat(64),
        fencedLineages: ["node-b", "node-a"],
        meter: "PLANNING_TOKENS",
        quantity: 40,
      });
      expect(drifted.supersessionPlanId).not.toBe(base);
    }
  });

  it("releases both members together, refunding the held quantity", () => {
    const released = releaseGeneration(generation());
    expect(released.funding.lifecycle).toBe("RELEASED");
    expect(released.fence.lifecycle).toBe("RELEASED");
    expect(released.funding.refunded).toBe(40);
    expect(released.supersessionPlanId).toBe(generation().supersessionPlanId);
  });
});

describe("preparation aggregates are distinct and project/goal scoped (task-32c1ba45)", () => {
  it("keys the three aggregates apart under one project and goal", () => {
    const ids = [
      preparationAggregateId("project-1", "goal-1"),
      fundingAggregateId("project-1", "goal-1"),
      planningFenceAggregateId("project-1", "goal-1"),
    ];
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("supersession-preparation:project-1:goal-1");
    expect(ids[1]).toBe("supersession-funding:project-1:goal-1");
    expect(ids[2]).toBe("planning-fence:project-1:goal-1");
  });
});

describe("proposeSupersessionPreparation reads every current fact durably (task-32c1ba45)", () => {
  it("ACCEPTED CONTROL: proposes generation 1 over a nonzero enumerated lineage set", () => {
    const store = activatedStore();
    const proposal = proposeSupersessionPreparation(store, prepareRequest());
    expect(proposal.ok, proposal.ok ? "" : `${proposal.code}/${proposal.sourceCode ?? "-"}`)
      .toBe(true);
    if (!proposal.ok) throw new Error("expected a preparation proposal");
    expect(proposal.lineageCount).toBe(1);
    expect(proposal.generation.binding.generation).toBe(1);
    expect(proposal.generation.binding.targetRevisionRef).toBe(GRAPH_REVISION_REF);
    expect(proposal.generation.funding.lifecycle).toBe("HELD");
    expect(proposal.generation.fence.lifecycle).toBe("ACTIVE");
    expect(proposal.generation.fence.fencedLineages.length).toBe(proposal.lineageCount);
    expect(proposal.expectedPreparationVersion).toBe(0);
    // GENUINELY PARTIAL: preparation captures only the active predecessor lineage. The request has
    // no successor content/hash, so COMPLETE cannot be derived honestly until graph.supersede reads
    // both authenticated contents. This pin must not move when supersede-time coverage becomes live.
    expect(proposal.generation.fence.fencedLineages).toStrictEqual(["node-a"]);
    expect("successorGraphContentHash" in proposal.request).toBe(false);
    expect(proposal.dispositionCoverage).toBe("PARTIAL");
    expect(proposal.horizon.coverage).toBe("PARTIAL");
    // DURABLE, NOT JUST RETURNED (task-7eddd612): the same answer is now bound onto the generation
    // record itself, which is the only copy `graph.supersede` can ever read back.
    expect(proposal.generation.dispositionCoverage).toBe("PARTIAL");
    expect(proposal.meterQuantity).toBe(0);
  });

  it("binds the deadline to the command's own decidedAt and never to a clock", () => {
    const store = activatedStore();
    const proposal = proposeSupersessionPreparation(store, prepareRequest());
    if (!proposal.ok) throw new Error("expected a preparation proposal");
    expect(proposal.generation.binding.deadlineEpochMs)
      .toBe(Date.parse(PREPARE_DECIDED_AT) + PREPARATION_WINDOW_MS);
  });

  it("cites the codec's graphContentHash and never the structural snapshotIdentity", () => {
    const store = activatedStore();
    const active = readCurrentActiveGraph(store, PROJECT_ID);
    if (!active.ok) throw new Error("expected an active graph");
    const proposal = proposeSupersessionPreparation(store, prepareRequest());
    if (!proposal.ok) throw new Error("expected a preparation proposal");
    expect(active.snapshotIdentity).not.toBe(active.graphContentHash);
    expect(proposal.horizon.graphContentHash).toBe(active.graphContentHash);
    expect(proposal.horizon.graphContentHash).not.toBe(active.snapshotIdentity);
  });

  it("refuses with the projection's own code when no graph is active", () => {
    const store = approvableStore();
    expect(proposeSupersessionPreparation(store, prepareRequest())).toEqual({
      code: "SUPERSESSION_PREPARATION_GRAPH_UNAVAILABLE",
      layer: "SUPERSESSION_PREPARATION",
      ok: false,
      refusedBy: "SUPERSESSION_PREPARATION_SERVICE",
      sourceCode: "ACTIVE_GRAPH_ABSENT",
      sourceLayer: "ACTIVE_GRAPH_PROJECTION",
    });
  });

  it("refuses with the planning reader's own code for a foreign goal", () => {
    const store = activatedStore();
    const refused = proposeSupersessionPreparation(
      store, prepareRequest({ goalRef: "goal-does-not-exist" }),
    );
    expect(refused).toMatchObject({
      code: "SUPERSESSION_PREPARATION_PLAN_UNAVAILABLE",
      layer: "SUPERSESSION_PREPARATION",
      refusedBy: "SUPERSESSION_PREPARATION_SERVICE",
      sourceLayer: "PLANNING_AUTHORITY_READER",
    });
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.sourceCode).toMatch(/^PLANNING_AUTHORITY_READER_/u);
  });

  it("refuses a target the approved plan does not name", () => {
    const store = activatedStore();
    expect(proposeSupersessionPreparation(
      store, prepareRequest({ approvedTargetRevisionRef: "rev-foreign" }),
    )).toEqual({
      code: "SUPERSESSION_PREPARATION_TARGET_FOREIGN",
      layer: "SUPERSESSION_PREPARATION",
      ok: false,
      refusedBy: "SUPERSESSION_PREPARATION_SERVICE",
      sourceCode: null,
      sourceLayer: null,
    });
  });

  it("reads the finalization boundary off committed events, not off a request field", () => {
    expect(submissionFinalized(activatedStore(), RUN_ID)).toBe(true);
    expect(submissionFinalized(proposedNotFinalizedStore(), RUN_ID)).toBe(false);
  });
});

/**
 * The consequence-change comparison is only as good as the digest it compares.
 *
 * The two captures inside `proposeSupersessionPreparation` are synchronous, so no production path
 * can move a fact between them in-process; what CAN be proven is that the digest discriminates on
 * every fact it claims to cover. A field that stopped being framed would leave this matrix red.
 */
const HORIZON_FACTS: HorizonFacts = Object.freeze({
  budgetHeadVersion: 3,
  coverage: "PARTIAL",
  dispositionDigest: "a".repeat(64),
  finalized: true,
  graphContentHash: "b".repeat(64),
  graphEpoch: 1,
  lineages: ["node-a"],
  planHash: "c".repeat(64),
  preparationVersion: 0,
  revisionId: "rev-1",
  runId: "run-1",
});

const HORIZON_MUTATIONS = Object.freeze([
  { field: "budgetHeadVersion", value: 4 },
  { field: "coverage", value: "COMPLETE" },
  { field: "dispositionDigest", value: "d".repeat(64) },
  { field: "finalized", value: false },
  { field: "graphContentHash", value: "e".repeat(64) },
  { field: "graphEpoch", value: 2 },
  { field: "lineages", value: ["node-a", "node-b"] },
  { field: "planHash", value: "f".repeat(64) },
  { field: "preparationVersion", value: 1 },
  { field: "revisionId", value: "rev-2" },
  { field: "runId", value: "run-2" },
] as const);

describe("the captured fact horizon discriminates on every fact (task-32c1ba45)", () => {
  it("pins the mutation denominator against the fact roster it must cover", () => {
    expect(HORIZON_MUTATIONS).toHaveLength(11);
    expect(Object.keys(HORIZON_FACTS)).toHaveLength(11);
    expect(HORIZON_MUTATIONS.map((entry) => entry.field).slice().sort())
      .toEqual(Object.keys(HORIZON_FACTS).slice().sort());
  });

  it.each(HORIZON_MUTATIONS)("moves the digest when $field moves", (mutation) => {
    const base = horizonDigestOf(HORIZON_FACTS).digest;
    const moved = horizonDigestOf({ ...HORIZON_FACTS, [mutation.field]: mutation.value });
    expect(moved.digest).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("is stable for identical facts, so an honest replay never reads as a change", () => {
    expect(horizonDigestOf(HORIZON_FACTS).digest)
      .toBe(horizonDigestOf({ ...HORIZON_FACTS }).digest);
  });
});
