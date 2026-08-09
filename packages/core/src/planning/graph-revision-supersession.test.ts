/**
 * The `graph.supersede` transition: the only authority-moving command out of `ACTIVE`. These tests
 * compose the production supersession kernel and the production reducer — no epoch, carry, or
 * disposition policy is reimplemented here. Every positive expectation is derived from
 * `decideSupersession` itself, and every refusal pins the exact stable code plus the refusing
 * layer, which the reducer re-shapes from `SUPERSESSION_KERNEL` to `GRAPH_REVISION`.
 */
import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import type { CarryForwardInput } from "../policy/approval-contract.js";
import { decideSupersession } from "../supersession/supersession-engine.js";
import type {
  SupersessionDisposition,
  SupersessionInput,
  SupersessionPredecessorBinding,
} from "../supersession/supersession-engine.js";
import type {
  GraphRevisionCommand,
  GraphRevisionReducerResult,
  GraphRevisionState,
} from "./graph-revision-contract.js";
import { reduceGraphRevision } from "./graph-revision-reducer.js";
import {
  GRAPH_HASH,
  STALE_HASH,
  accepted,
  expectError,
  expectIllegal,
  hash,
  state,
} from "./graph-revision-test-fixtures.js";

const SUCCESSOR_HASH = hash("88");
const CARRY_HASH = hash("44");
const BINDING_HASH = hash("66");
const CANONICALIZER = "canon-v1";

function carryFact(digest: string): CarryForwardInput {
  return {
    canonicalizerVersion: CANONICALIZER, dependenciesPresent: true,
    environmentClosureUnchanged: true, policySliceUnchanged: true,
    predecessorResultUnchanged: true, sourceHash: digest, targetHash: digest,
  };
}

const CARRY: SupersessionDisposition = {
  kind: "CARRY", nodeKey: "node-carry", predecessorAuthorityHash: CARRY_HASH,
  safeCarry: { authority: carryFact(CARRY_HASH), inputBinding: carryFact(BINDING_HASH) },
  successorAuthorityHash: CARRY_HASH,
};

function predecessorOf(current: GraphRevisionState): SupersessionPredecessorBinding {
  return {
    graphContentHash: current.graphContentHash, graphEpoch: current.graphEpoch,
    revisionId: current.revisionId,
  };
}

function supersessionInput(
  current: GraphRevisionState,
  overrides: Partial<SupersessionInput> = {},
): SupersessionInput {
  const predecessor = predecessorOf(current);
  return {
    dispositions: [CARRY],
    expectedPredecessor: predecessor,
    successor: {
      graphContentHash: SUCCESSOR_HASH, graphEpoch: predecessor.graphEpoch + 1,
      predecessorGraphContentHash: predecessor.graphContentHash,
      predecessorRevisionId: predecessor.revisionId, revisionId: "graph-revision-2",
    },
    supportedCanonicalizerVersions: [CANONICALIZER],
    ...overrides,
  };
}

function supersedeWith(
  current: GraphRevisionState,
  supersession: SupersessionInput,
): GraphRevisionCommand {
  return {
    commandId: "cmd-supersede", expectedVersion: current.version,
    kind: "graph.supersede", supersession,
  };
}

/** Drives one refusal case and proves the refused command left the state byte-identical. */
function refuses(
  current: GraphRevisionState,
  overrides: Partial<SupersessionInput>,
  code: string,
): GraphRevisionReducerResult {
  const before = JSON.stringify(current);
  const result = reduceGraphRevision(current,
    supersedeWith(current, supersessionInput(current, overrides)));
  expectError(result, code);
  expect(JSON.stringify(current)).toBe(before);
  return result;
}

describe("graph revision supersession", () => {
  it("supersedes an active revision and binds the successor to the predecessor it replaced", () => {
    const source = state("ACTIVE");
    const before = JSON.stringify(source);
    const input = supersessionInput(source);
    const decided = decideSupersession(predecessorOf(source), input);
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw new Error("kernel refused a well-formed supersession");
    expect(decided.decision.successor.graphEpoch).toBe(source.graphEpoch + 1);
    const result = reduceGraphRevision(source, supersedeWith(source, input));
    expect(accepted(result)).toMatchObject({
      graphContentHash: GRAPH_HASH, graphEpoch: source.graphEpoch, lifecycle: "SUPERSEDED",
      version: source.version + 1,
    });
    expect(result.ok && result.events).toEqual([{
      authorityHash: decided.decision.authorityHash, commandId: "cmd-supersede",
      kind: "GraphRevisionSuperseded", successor: decided.decision.successor,
      version: source.version + 1,
    }]);
    expect(result.ok && Object.isFrozen(result.events[0])).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("refuses a supersede whose expected predecessor disagrees with the live revision", () => {
    const source = state("ACTIVE");
    const drifted: readonly Partial<SupersessionInput>[] = [
      { expectedPredecessor: { ...predecessorOf(source), revisionId: "graph-revision-9" } },
      { expectedPredecessor: { ...predecessorOf(source), graphContentHash: STALE_HASH } },
      { expectedPredecessor: { ...predecessorOf(source), graphEpoch: source.graphEpoch + 1 } },
    ];
    expect(drifted).toHaveLength(3);
    for (const overrides of drifted) refuses(source, overrides, "REVISION_REBOUND");
  });

  it("refuses a successor epoch that is not exactly predecessor epoch plus one", () => {
    const source = state("ACTIVE");
    const successor = supersessionInput(source).successor;
    let cases = 0;
    for (const delta of [0, 2, -1] as const) {
      refuses(source, { successor: { ...successor, graphEpoch: source.graphEpoch + delta } },
        "REVISION_REBOUND");
      cases += 1;
    }
    expect(cases).toBe(3);
  });

  it("refuses a successor that does not name the predecessor it replaces", () => {
    const source = state("ACTIVE");
    const successor = supersessionInput(source).successor;
    const unbound: readonly Partial<SupersessionInput>[] = [
      { successor: { ...successor, predecessorRevisionId: "graph-revision-9" } },
      { successor: { ...successor, predecessorGraphContentHash: STALE_HASH } },
      { successor: { ...successor, revisionId: source.revisionId } },
    ];
    expect(unbound).toHaveLength(3);
    for (const overrides of unbound) refuses(source, overrides, "REVISION_REBOUND");
  });

  it("refuses changed or unknown carry evidence with the consequence code", () => {
    const source = state("ACTIVE");
    const changed: SupersessionDisposition = { ...CARRY, safeCarry: {
      authority: carryFact(STALE_HASH), inputBinding: carryFact(BINDING_HASH) } };
    const unknown: SupersessionDisposition = { ...CARRY, safeCarry: {
      authority: { ...carryFact(CARRY_HASH), canonicalizerVersion: "canon-unknown" },
      inputBinding: carryFact(BINDING_HASH) } };
    refuses(source, { dispositions: [changed] }, "SUPERSESSION_CONSEQUENCE_CHANGED");
    refuses(source, { dispositions: [unknown] }, "SUPERSESSION_CONSEQUENCE_CHANGED");
  });

  it("re-shapes the kernel layer so the refusing layer is observable on the result", () => {
    const source = state("ACTIVE");
    const overrides = {
      expectedPredecessor: { ...predecessorOf(source), graphEpoch: source.graphEpoch + 5 },
    };
    const kernel = decideSupersession(predecessorOf(source),
      supersessionInput(source, overrides));
    expect(kernel).toEqual({ code: "REVISION_REBOUND", layer: "SUPERSESSION_KERNEL", ok: false });
    const result = refuses(source, overrides, "REVISION_REBOUND");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.layer).toBe("GRAPH_REVISION");
    expect(result.layer).not.toBe("SUPERSESSION_KERNEL");
  });

  it("refuses supersede from every lifecycle except active with that state's exact code", () => {
    const seen = new Set<string>();
    for (const lifecycle of RUNTIME_LIFECYCLES.GRAPH_REVISION) {
      if (lifecycle === "ACTIVE") continue;
      const source = state(lifecycle);
      const before = JSON.stringify(source);
      const result = reduceGraphRevision(source,
        supersedeWith(source, supersessionInput(source)));
      if (lifecycle === "SUPERSEDED") expectError(result, "SUPERSEDED_AUTHORITY");
      else expectIllegal(result, "graph.supersede", lifecycle);
      expect(JSON.stringify(source)).toBe(before);
      seen.add(lifecycle);
    }
    expect(seen.size).toBe(RUNTIME_LIFECYCLES.GRAPH_REVISION.length - 1);
  });
});
