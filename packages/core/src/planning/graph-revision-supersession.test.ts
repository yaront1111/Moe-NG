/**
 * The `graph.supersede` transition: the only authority-moving command out of `ACTIVE`. These tests
 * compose the production supersession kernel and the production reducer — no epoch, carry, or
 * disposition policy is reimplemented here. Every positive expectation is derived from
 * `decideSupersession` itself, and every refusal pins the exact stable code plus the refusing
 * layer, which the reducer re-shapes from `SUPERSESSION_KERNEL` to `GRAPH_REVISION`.
 */
import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { decideSupersession } from "../supersession/supersession-engine.js";
import type { SupersessionDisposition, SupersessionInput } from
  "../supersession/supersession-engine.js";
import type { GraphRevisionReducerResult, GraphRevisionState } from
  "./graph-revision-contract.js";
import { reduceGraphRevision } from "./graph-revision-reducer.js";
import {
  BINDING_HASH,
  CARRY,
  CARRY_HASH,
  GRAPH_HASH,
  STALE_HASH,
  SUCCESSOR_HASH,
  accepted,
  carryFact,
  changedCarryInput,
  expectError,
  expectIllegal,
  predecessorOf,
  staleEpochInput,
  state,
  supersedeCommand,
  supersessionInput,
} from "./graph-revision-test-fixtures.js";

/** Drives one refusal case and proves the refused command left the state byte-identical. */
function refuses(
  current: GraphRevisionState,
  supersession: SupersessionInput,
  code: string,
): GraphRevisionReducerResult {
  const before = JSON.stringify(current);
  const result = reduceGraphRevision(current, supersedeCommand(current, supersession));
  expectError(result, code);
  expect(JSON.stringify(current)).toBe(before);
  return result;
}

/** Drives one refusal case built as a single deliberate drift from the well-formed input. */
function refusesDrift(
  current: GraphRevisionState,
  overrides: Partial<SupersessionInput>,
  code: string,
): GraphRevisionReducerResult {
  return refuses(current, supersessionInput(current, overrides), code);
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
    const result = reduceGraphRevision(source, supersedeCommand(source, input));
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
    ];
    expect(drifted).toHaveLength(2);
    for (const overrides of drifted) refusesDrift(source, overrides, "REVISION_REBOUND");
    refuses(source, staleEpochInput(source), "REVISION_REBOUND");
  });

  /**
   * Every other drift case is also refusable by the successor binding, so only a SELF-CONSISTENT
   * foreign predecessor proves the reducer hands the kernel the LIVE state rather than echoing
   * the command's own claim back at it.
   */
  it("refuses a self-consistent supersession naming a predecessor that is not this one", () => {
    const source = state("ACTIVE");
    const foreign: readonly Partial<SupersessionInput>[] = [
      { expectedPredecessor: { ...predecessorOf(source), revisionId: "graph-revision-9" },
        successor: { graphContentHash: SUCCESSOR_HASH, graphEpoch: source.graphEpoch + 1,
          predecessorGraphContentHash: source.graphContentHash,
          predecessorRevisionId: "graph-revision-9", revisionId: "graph-revision-2" } },
      { expectedPredecessor: { ...predecessorOf(source), graphContentHash: STALE_HASH },
        successor: { graphContentHash: SUCCESSOR_HASH, graphEpoch: source.graphEpoch + 1,
          predecessorGraphContentHash: STALE_HASH,
          predecessorRevisionId: source.revisionId, revisionId: "graph-revision-2" } },
      { expectedPredecessor: { ...predecessorOf(source), graphEpoch: source.graphEpoch + 4 },
        successor: { graphContentHash: SUCCESSOR_HASH, graphEpoch: source.graphEpoch + 5,
          predecessorGraphContentHash: source.graphContentHash,
          predecessorRevisionId: source.revisionId, revisionId: "graph-revision-2" } },
    ];
    expect(foreign).toHaveLength(3);
    for (const overrides of foreign) refusesDrift(source, overrides, "REVISION_REBOUND");
  });

  it("refuses a successor epoch that is not exactly predecessor epoch plus one", () => {
    const source = state("ACTIVE");
    const successor = supersessionInput(source).successor;
    let cases = 0;
    for (const delta of [0, 2, -1] as const) {
      refusesDrift(source, { successor: { ...successor, graphEpoch: source.graphEpoch + delta } },
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
    for (const overrides of unbound) refusesDrift(source, overrides, "REVISION_REBOUND");
  });

  it("refuses changed or unknown carry evidence with the consequence code", () => {
    const source = state("ACTIVE");
    refuses(source, changedCarryInput(source), "SUPERSESSION_CONSEQUENCE_CHANGED");
    const unknown: SupersessionDisposition = { ...CARRY, safeCarry: {
      authority: { ...carryFact(CARRY_HASH), canonicalizerVersion: "canon-unknown" },
      inputBinding: carryFact(BINDING_HASH) } };
    refusesDrift(source, { dispositions: [unknown] }, "SUPERSESSION_CONSEQUENCE_CHANGED");
  });

  it("re-shapes the kernel layer so the refusing layer is observable on the result", () => {
    const source = state("ACTIVE");
    const overrides = {
      expectedPredecessor: { ...predecessorOf(source), graphEpoch: source.graphEpoch + 5 },
    };
    const kernel = decideSupersession(predecessorOf(source),
      supersessionInput(source, overrides));
    expect(kernel).toEqual({ code: "REVISION_REBOUND", layer: "SUPERSESSION_KERNEL", ok: false });
    const result = refusesDrift(source, overrides, "REVISION_REBOUND");
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
      const result = reduceGraphRevision(source, supersedeCommand(source));
      if (lifecycle === "SUPERSEDED") expectError(result, "SUPERSEDED_AUTHORITY");
      else expectIllegal(result, "graph.supersede", lifecycle);
      expect(JSON.stringify(source)).toBe(before);
      seen.add(lifecycle);
    }
    expect(seen.size).toBe(RUNTIME_LIFECYCLES.GRAPH_REVISION.length - 1);
  });
});
