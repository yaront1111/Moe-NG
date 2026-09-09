/**
 * The MIDDLE, drilled end to end over ONE durable world: PRD bound by the
 * production `goal.create_with_source`, revision committed by the production
 * writer, Gate 1 approved by a REAL paired bearer session through the production
 * gate command, then `runSubmitDecomposition` compiles the APPROVED revision and
 * drives create→ready→claim→propose→finalize through the production planning
 * handlers. The run ends REVIEWABLE — exactly where the browser's ApprovePlan
 * gate picks it up. Refusal arms: no Gate 1 approval; digest retarget;
 * crash-restart resume (second dispatch REPLAYS, no duplicate records).
 */
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import type { ProductContractRevisionRef } from "@moe/core";

import { GOAL_ID, PROJECT_ID, RUN_ID, closeStores } from "../bootstrap/bootstrap-test-fixtures.js";
import { runSubmitDecomposition } from "./compile-dispatcher.js";
// THE WORLD BUILDERS LIVE IN ONE MODULE, not two. They were authored here (this file's :43-233
// before task-138fab30) and moved to `plan-reject-test-fixtures.ts` when the REJECT journey's
// suites needed the SAME world: the successor run id is derived from the run id and the compile
// ids from the revision digest, so two hand-copied builders that drifted by a literal would
// produce two different worlds that both still looked plausible, and an arm written against one
// would assert nothing about the other. Every literal is unchanged, which is why every INITIAL
// arm below is byte-identical to the one that passed before the move.
import {
  approveGate1, boundWorld, committedRevision, nodeOf, structureOf, submit,
} from "./plan-reject-test-fixtures.js";

afterEach(closeStores);

/** c -> b -> a: a REAL hard chain, each criterion bound by exactly one node. Nothing depends
 *  on node-c, so it is the completion node (a dependency ON the completion node is refused). */
const CHAIN_NODES: readonly Record<string, unknown>[] = Object.freeze([
  nodeOf("node-a", ["crit-api"]),
  nodeOf("node-b", ["crit-ui"], ["node-a"]),
  nodeOf("node-c", ["crit-worker"], ["node-b"]),
]);

function chainStructure(
  nodes: readonly Record<string, unknown>[] = CHAIN_NODES,
): Record<string, unknown> {
  return structureOf(nodes, "node-c");
}

/** The layer the DAG-coherence refusals carry. The dispatcher forwards the producer's own code
 *  AND layer (`refused(compiled.code, compiled.layer)`), so the arms below pin BOTH: more than
 *  one layer can refuse a malformed structure, and a bare "it refused" assertion would stay
 *  green if the wrong one answered first — which is exactly what the node-count fence did. */
const PRODUCER = "COMPILED_PLAN_PRODUCER";

function refusalOf(
  store: SqliteEventStore, ref: ProductContractRevisionRef, structure: Record<string, unknown>,
): string {
  const result = submit(store, ref, { structure });
  return result.ok ? "ACCEPTED" : `${result.code} @ ${result.layer}`;
}

describe("runSubmitDecomposition", () => {
  it("SEALS a three-node INITIAL graph with a hard c->b->a chain: node count is not a fence", () => {
    const store = boundWorld();
    const ref = committedRevision(store, true);
    approveGate1(store, ref);

    const sealed = submit(store, ref, { structure: chainStructure() });
    if (!sealed.ok) throw new Error(`three-node dispatch refused: ${sealed.code} @ ${sealed.layer}`);
    // NOT merely "it did not refuse": a refusal arm that stopped returning a code would pass
    // that. The graph is only sealed if BOTH hashes came back and the run actually decided.
    expect(sealed.disposition).toBe("DECIDED");
    expect(typeof sealed.graphContentHash).toBe("string");
    expect(sealed.graphContentHash.length).toBeGreaterThan(0);
    expect(typeof sealed.submissionHash).toBe("string");
    expect(sealed.submissionHash.length).toBeGreaterThan(0);
    expect(sealed.runId).toBe(RUN_ID);
    // Proposed (one fold decision) + finalized (a second): sealed exactly like a single slice.
    expect(store.getAggregateVersion(RUN_ID)).toBe(2);
  });

  it("still seals N=1: lifting the count fence did not trade one node limit for another", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);

    const sealed = submit(store, ref);
    if (!sealed.ok) throw new Error(`single-node dispatch refused: ${sealed.code}`);
    expect(sealed.disposition).toBe("DECIDED");
    expect(sealed.graphContentHash.length).toBeGreaterThan(0);
    expect(sealed.submissionHash.length).toBeGreaterThan(0);
  });

  it("refuses an incoherent DAG at the compiled-plan producer, with the count fence irrelevant", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);
    const bothCriteria = ["crit-api", "crit-ui"];
    // SINGLE-node forms, so no node-count arm can answer instead: these prove the coherence
    // fence stands on its own. It is what REPLACES the retired count fence.
    expect(refusalOf(store, ref, structureOf([
      nodeOf("node-slice", bothCriteria, ["node-ghost"]),
    ]))).toBe(`COMPILED_PLAN_MALFORMED @ ${PRODUCER}`);
    expect(refusalOf(store, ref, structureOf([
      nodeOf("node-slice", bothCriteria, ["node-slice"]),
    ]))).toBe(`COMPILED_PLAN_MALFORMED @ ${PRODUCER}`);
    expect(refusalOf(store, ref, structureOf([
      nodeOf("node-slice", ["crit-api"]),
    ]))).toBe(`COMPILED_PLAN_CRITERION_UNBOUND @ ${PRODUCER}`);
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });

  it("keeps refusing an incoherent DAG once N>1 is admitted: the coherence fence is the fence", () => {
    const store = boundWorld();
    const ref = committedRevision(store, true);
    approveGate1(store, ref);
    const [nodeA, nodeB, nodeC] = CHAIN_NODES as readonly Record<string, unknown>[];
    const malformed = `COMPILED_PLAN_MALFORMED @ ${PRODUCER}`;
    // An unknown dependsOn target anywhere in the chain.
    expect(refusalOf(store, ref, chainStructure([
      nodeA!, nodeB!, { ...nodeC!, dependsOn: ["node-ghost"] },
    ]))).toBe(malformed);
    // A self-edge in the middle of the chain.
    expect(refusalOf(store, ref, chainStructure([
      nodeA!, { ...nodeB!, dependsOn: ["node-b"] }, nodeC!,
    ]))).toBe(malformed);
    // A dependency ON the completion node — the chain read backwards, which cannot execute.
    expect(refusalOf(store, ref, chainStructure([
      { ...nodeA!, dependsOn: ["node-c"] }, nodeB!, nodeC!,
    ]))).toBe(malformed);
    // A criterion bound by no node: the coverage duty is per GRAPH, not per node.
    expect(refusalOf(store, ref, chainStructure([
      nodeA!, nodeB!, { ...nodeC!, criterionIds: [] },
    ]))).toBe(`COMPILED_PLAN_CRITERION_UNBOUND @ ${PRODUCER}`);
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });

  it("refuses a dependsOn CYCLE, which only a multi-node graph can express", () => {
    const store = boundWorld();
    const ref = committedRevision(store, true);
    approveGate1(store, ref);
    // a <-> b: every target is a known node, no self-edge, nothing depends on the completion
    // node, every criterion bound once — so it clears every arm in `shapeRefusal` and is caught
    // deeper, by the graph codec's own admission. Pinned because a cycle that SEALED would
    // deadlock the dependency gate rather than refuse at the surface: no node is ever READY.
    expect(refusalOf(store, ref, chainStructure([
      nodeOf("node-a", ["crit-api"], ["node-b"]),
      nodeOf("node-b", ["crit-ui"], ["node-a"]),
      nodeOf("node-c", ["crit-worker"], ["node-b"]),
    ]))).toBe(`COMPILED_PLAN_ADMISSION_REFUSED @ ${PRODUCER}`);
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });

  it("drives the approved contract to a REVIEWABLE single-slice plan, and resumes idempotently", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);

    const first = submit(store, ref);
    if (!first.ok) throw new Error(`dispatch refused: ${first.code}`);
    expect(first.disposition).toBe("DECIDED");
    expect(first.runId).toBe(RUN_ID);
    // Proposed (one fold decision) + finalized (a second): the ApprovePlan shape.
    expect(store.getAggregateVersion(RUN_ID)).toBe(2);

    const again = submit(store, ref);
    if (!again.ok) throw new Error(`re-dispatch refused: ${again.code}`);
    expect(again.disposition).toBe("REPLAYED");
    expect(store.getAggregateVersion(RUN_ID)).toBe(2);
    expect(again.submissionHash).toBe(first.submissionHash);
  });

  it("canonicalizes the agent's criterion set: listing order and repeats are not plan facts", () => {
    const canonicalStore = boundWorld();
    const canonicalRef = committedRevision(canonicalStore);
    approveGate1(canonicalStore, canonicalRef);
    const canonical = submit(canonicalStore, canonicalRef);
    if (!canonical.ok) throw new Error(`canonical refused: ${canonical.code}`);

    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);
    const structure = structureOf();
    const node = (structure["nodes"] as Record<string, unknown>[])[0]!;
    const shuffled = submit(store, ref, {
      structure: {
        ...structure,
        nodes: [{ ...node, criterionIds: ["crit-ui", "crit-api", "crit-ui"] }],
      },
    });
    if (!shuffled.ok) throw new Error(`shuffled refused: ${shuffled.code}`);
    expect(shuffled.disposition).toBe("DECIDED");
    expect(shuffled.submissionHash).toBe(canonical.submissionHash);
    expect(shuffled.graphContentHash).toBe(canonical.graphContentHash);
  });

  it("seals the roster in the AGENT'S listing order: completion node last is the natural shape", () => {
    const [nodeA, nodeB, nodeC] = CHAIN_NODES as readonly Record<string, unknown>[];
    const sealedHash = (nodes: readonly Record<string, unknown>[]): string => {
      const store = boundWorld();
      const ref = committedRevision(store, true);
      approveGate1(store, ref);
      const sealed = submit(store, ref, { structure: chainStructure(nodes) });
      if (!sealed.ok) throw new Error(`sealed refused: ${sealed.code} ${sealed.detail ?? ""}`);
      return sealed.graphContentHash;
    };
    // c, b, a is how a planner writes a chain — and what refused GRAPH_CONTENT_FIELD_INVALID
    // for every real seat on 2026-09-05, because the graph codec wants the roster ascending.
    expect(sealedHash([nodeC!, nodeB!, nodeA!])).toBe(sealedHash([nodeA!, nodeB!, nodeC!]));
    // A producer named twice is one edge, not a duplicate-edge refusal one layer down.
    expect(sealedHash([nodeA!, { ...nodeB!, dependsOn: ["node-a", "node-a"] }, nodeC!]))
      .toBe(sealedHash([nodeA!, nodeB!, nodeC!]));
  });

  it("answers a criterion-free join node with the producer's words, never a bare 500", () => {
    const store = boundWorld();
    const ref = committedRevision(store, true);
    approveGate1(store, ref);
    const [nodeA, nodeB, nodeC] = CHAIN_NODES as readonly Record<string, unknown>[];
    // Coverage holds — node-a takes crit-worker — so the join node's emptiness is the refusal.
    expect(submit(store, ref, { structure: chainStructure([
      { ...nodeA!, criterionIds: ["crit-api", "crit-worker"] }, nodeB!,
      { ...nodeC!, criterionIds: [] },
    ]) })).toMatchObject({
      code: "COMPILED_PLAN_MALFORMED", detail: "node node-c binds no criterion",
      layer: PRODUCER, ok: false,
    });
    // Every refusal the dispatcher forwards keeps the refusing authority's detail.
    expect(submit(store, ref, { structure: chainStructure([
      nodeA!, nodeB!, { ...nodeC!, dependsOn: ["node-ghost"] },
    ]) })).toMatchObject({ detail: "dependsOn node-ghost of node-c", ok: false });
    expect(runSubmitDecomposition(store, {
      correlationId: "c", decidedAt: "2026-08-30T12:01:00.000Z", payload: {},
      principalId: "principal-1", projectId: PROJECT_ID,
    })).toMatchObject({
      code: "SUBMIT_DECOMPOSITION_MALFORMED",
      detail: "payload must be exactly {gateRef, goalRef, structure}", ok: false,
    });
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });

  it("refuses node text the plan codec cannot admit as a SHAPE refusal, never a producer throw", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);
    const structure = structureOf();
    const node = (structure["nodes"] as Record<string, unknown>[])[0]!;
    const refusalOf = (overrides: Record<string, unknown>): string => {
      const result = submit(store, ref, { structure: { ...structure, nodes: [{ ...node, ...overrides }] } });
      return result.ok ? "ACCEPTED" : result.code;
    };
    expect(refusalOf({ objective: "\0bad" })).toBe("SUBMIT_DECOMPOSITION_MALFORMED");
    expect(refusalOf({ objective: "é" })).toBe("SUBMIT_DECOMPOSITION_MALFORMED");
    expect(refusalOf({ criterionIds: ["crit-api", 7] })).toBe("SUBMIT_DECOMPOSITION_MALFORMED");
    expect(refusalOf({ dependsOn: [null] })).toBe("SUBMIT_DECOMPOSITION_MALFORMED");
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });

  it("refuses when no Gate 1 approval exists — the human gate is not optional", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    const outcome = submit(store, ref);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toContain("GATE_1");
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });

  it("refuses a gateRef retargeted at a digest the approval never named", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);
    const outcome = submit(store, ref, {
      gateRef: {
        contractId: ref.contractId, revisionDigest: "ab".repeat(32),
        revisionId: ref.revisionId,
      },
    });
    expect(outcome.ok).toBe(false);
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });

  it("refuses malformed payloads by shape, touching nothing durable", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);
    for (const payload of [null, {}, { gateRef: {}, goalRef: GOAL_ID, structure: {} }]) {
      const outcome = runSubmitDecomposition(store, {
        correlationId: "c", decidedAt: "2026-08-30T12:01:00.000Z", payload,
        principalId: "principal-1", projectId: PROJECT_ID,
      });
      expect(outcome).toMatchObject({ code: "SUBMIT_DECOMPOSITION_MALFORMED", ok: false });
    }
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });
});
