import { describe, expect, it } from "vitest";

import * as core from "../index.js";
import {
  SUPERSESSION_DISPOSITION_KINDS,
  SUPERSESSION_KERNEL_LAYER,
  decideSupersession,
} from "../index.js";
import type {
  CarryForwardInput,
  SupersessionDisposition,
  SupersessionDispositionKind,
  SupersessionInput,
  SupersessionPredecessorBinding,
  SupersessionResult,
  SupersessionSafeCarry,
} from "../index.js";

const hex = (character: string): string => character.repeat(64);
const PREDECESSOR = Object.freeze({
  graphContentHash: hex("a"), graphEpoch: 7, revisionId: "revision-1",
}) satisfies SupersessionPredecessorBinding;
const SUCCESSOR = Object.freeze({
  graphContentHash: hex("b"), graphEpoch: 8,
  predecessorGraphContentHash: PREDECESSOR.graphContentHash,
  predecessorRevisionId: PREDECESSOR.revisionId, revisionId: "revision-2",
});

const carryFact = (hash: string): CarryForwardInput => ({
  canonicalizerVersion: "canon-v1", dependenciesPresent: true,
  environmentClosureUnchanged: true, policySliceUnchanged: true,
  predecessorResultUnchanged: true, sourceHash: hash, targetHash: hash,
});

const disposition = (kind: SupersessionDispositionKind): SupersessionDisposition => {
  const byKind = {
    ADD: [null, hex("1")], CARRY: [hex("2"), hex("2")],
    CHANGE: [hex("5"), hex("6")], REEXECUTE: [hex("4"), hex("4")],
    REMOVE: [hex("7"), null], REQUALIFY: [hex("3"), hex("3")],
  } as const;
  const [predecessorAuthorityHash, successorAuthorityHash] = byKind[kind];
  return {
    kind, nodeKey: `node-${kind.toLowerCase()}`, predecessorAuthorityHash,
    safeCarry: kind === "CARRY" ? {
      authority: carryFact(hex("2")), inputBinding: carryFact(hex("8")),
    } : null,
    successorAuthorityHash,
  };
};

const allDispositions = (): SupersessionDisposition[] =>
  [...SUPERSESSION_DISPOSITION_KINDS].reverse().map(disposition);
const input = (dispositions = allDispositions()): SupersessionInput => ({
  dispositions, expectedPredecessor: PREDECESSOR, successor: SUCCESSOR,
  supportedCanonicalizerVersions: ["canon-v2", "canon-v1"],
});

function expectRefusal(
  result: SupersessionResult,
  code: "REVISION_REBOUND" | "SUPERSESSION_CONSEQUENCE_CHANGED",
): void {
  expect(result).toEqual({ code, layer: "SUPERSESSION_KERNEL", ok: false });
  expect(Object.isFrozen(result)).toBe(true);
  expect("decision" in result).toBe(false);
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value)
    && Reflect.ownKeys(value).every((key) => deeplyFrozen(
      (value as Readonly<Record<PropertyKey, unknown>>)[key], seen,
    ));
}

describe("supersession accepted decision", () => {
  it("exports the exact closed disposition vocabulary from the curated core root", () => {
    expect(SUPERSESSION_DISPOSITION_KINDS).toEqual([
      "ADD", "CARRY", "REQUALIFY", "REEXECUTE", "CHANGE", "REMOVE",
    ]);
    expect(Object.isFrozen(SUPERSESSION_DISPOSITION_KINDS)).toBe(true);
    expect(SUPERSESSION_KERNEL_LAYER).toBe("SUPERSESSION_KERNEL");
    // 61 + the 8 expansion preparation/approval values published by task-a1e7f75e
    // + the 6 project-configuration codec values published by task-bcea7056
    // + the 5 approval policy/human-authority values published by task-5d8f11c8
    // + snapshotProjectState, published by task-4af0e3dc so the daemon can
    // re-validate raw ledger bytes instead of casting them.
    // + the 20 planning-authority record values published by task-dc21cb4a: each
    // record's version and code/layer rosters, both encoders, both decoders, and
    // the four digest/content derivations with their four domain constants.
    // + productContractGate1Authority, published by task-af06b71f so a consumer
    // never hand-builds the work reference a Gate 1 human-authority grant binds
    // to; one type export (ProductContractGate1Approval) was removed with it,
    // which this runtime count cannot see.
    // + admitProductContractRevisionRef and PRODUCT_CONTRACT_REVISION_REF_KEYS,
    // published by task-ce8398e7 so a runtime writer holding only the identity
    // triple binds a grant to the work reference the full-revision validator
    // derives; the two type exports beside them are invisible to this count.
    // + CUTOVER_COMMAND_KINDS, CUTOVER_TRANSITIONS and reduceCutover, published by
    // task-b5315f42 so the daemon cutover handler can reach the CutoverAttempt reducer
    // through the bare specifier; its twenty type exports are invisible to this count.
    // The hand-transcribed NAME list that makes this count reviewable lives in
    // ../index-surface.test.ts; this stays a count so a rename cannot pass both.
    expect(Object.keys(core).filter((key) => key !== "default").length).toBe(132);
  });

  it("accepts all six kinds and binds a deterministic golden authority hash", () => {
    const result = decideSupersession(PREDECESSOR, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.authorityHash)
      .toBe("e34d09addeae4fe63c0b49efbf4268da0802b8fd45f843d3e6678a17caa2abdf");
    expect(Object.keys(result.decision).sort()).toEqual([
      "authorityHash", "dispositions", "predecessor", "successor", "supportedCanonicalizerVersions",
    ]);
    expect(result.decision.predecessor).toEqual({ ...PREDECESSOR, lifecycle: "SUPERSEDED" });
    expect(result.decision.successor).toEqual({ ...SUCCESSOR, lifecycle: "ACTIVE" });
    expect(result.decision.dispositions.map((entry) => entry.nodeKey)).toEqual([
      "node-add", "node-carry", "node-change", "node-reexecute", "node-remove",
      "node-requalify",
    ]);
    expect(result.decision.supportedCanonicalizerVersions).toEqual(["canon-v1", "canon-v2"]);
    expect(deeplyFrozen(result)).toBe(true);
  });

  it("is permutation invariant and retains no mutable caller aliases", () => {
    const first = input();
    const second = input([...first.dispositions].reverse());
    const left = decideSupersession(PREDECESSOR, first);
    const right = decideSupersession(PREDECESSOR, {
      ...second, supportedCanonicalizerVersions: ["canon-v1", "canon-v2"],
    });
    expect(left).toEqual(right);
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    const mutable = first as unknown as {
      dispositions: Array<{ nodeKey: string }>; supportedCanonicalizerVersions: string[];
    };
    mutable.dispositions[0]!.nodeKey = "mutated";
    mutable.supportedCanonicalizerVersions[0] = "mutated";
    expect(left.decision.dispositions.some((entry) => entry.nodeKey === "mutated")).toBe(false);
    expect(left.decision.supportedCanonicalizerVersions).toEqual(["canon-v1", "canon-v2"]);
  });

  it("accepts every disposition kind through the production surface non-vacuously", () => {
    const cases = SUPERSESSION_DISPOSITION_KINDS.map((kind) =>
      decideSupersession(PREDECESSOR, input([disposition(kind)])));
    expect(cases.length).toBe(6);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.map((result) => result.ok)).toEqual([true, true, true, true, true, true]);
  });
});

describe("supersession structural refusal", () => {
  it("pins current, predecessor, parent, successor and monotonic epoch bindings", () => {
    const cases: readonly [SupersessionPredecessorBinding, unknown][] = [
      [{ ...PREDECESSOR, revisionId: "stale" }, input()],
      [PREDECESSOR, { ...input(), expectedPredecessor: { ...PREDECESSOR, graphContentHash: hex("f") } }],
      [PREDECESSOR, { ...input(), successor: { ...SUCCESSOR, revisionId: PREDECESSOR.revisionId } }],
      [PREDECESSOR, { ...input(), successor: { ...SUCCESSOR, predecessorRevisionId: "stale" } }],
      [PREDECESSOR, { ...input(), successor: { ...SUCCESSOR, predecessorGraphContentHash: hex("f") } }],
      [PREDECESSOR, { ...input(), successor: { ...SUCCESSOR, graphEpoch: 9 } }],
      [{ ...PREDECESSOR, graphEpoch: Number.MAX_SAFE_INTEGER }, {
        ...input(), expectedPredecessor: { ...PREDECESSOR, graphEpoch: Number.MAX_SAFE_INTEGER },
        successor: { ...SUCCESSOR, graphEpoch: Number.MAX_SAFE_INTEGER },
      }],
    ];
    expect(cases.length).toBeGreaterThan(0);
    for (const [current, candidate] of cases) {
      expectRefusal(decideSupersession(current, candidate), "REVISION_REBOUND");
    }
  });

  it("refuses malformed, exotic, cyclic, sparse and extra-key data before carry", () => {
    const accessor = { ...input() } as Record<string, unknown>;
    Object.defineProperty(accessor, "successor", { enumerable: true, get: () => SUCCESSOR });
    const cyclic = { ...input() } as Record<string, unknown>; cyclic["cycle"] = cyclic;
    const sparse = Array<SupersessionDisposition>(2); sparse[0] = disposition("ADD");
    const hostile = [
      null, {}, { ...input(), extra: true },
      { ...input(), expectedPredecessor: { ...PREDECESSOR, extra: true } },
      { ...input(), successor: { ...SUCCESSOR, extra: true } },
      { ...input(), dispositions: [{ ...disposition("ADD"), extra: true }] },
      { ...input(), dispositions: sparse }, accessor, cyclic,
      new Proxy({}, { ownKeys: () => { throw new Error("hostile"); } }),
    ];
    expect(hostile.length).toBeGreaterThan(0);
    for (const candidate of hostile) {
      expectRefusal(decideSupersession(PREDECESSOR, candidate), "REVISION_REBOUND");
    }
  });

  it("enforces bounded dense dispositions, unique nodes and canonicalizer versions", () => {
    const additions = Array.from({ length: 128 }, (_, index) => ({
      ...disposition("ADD"), nodeKey: `node-${String(index).padStart(3, "0")}`,
      successorAuthorityHash: index.toString(16).padStart(64, "0"),
    }));
    expect(decideSupersession(PREDECESSOR, input(additions)).ok).toBe(true);
    const invalid = [
      input([]), input([...additions, { ...additions[0]!, nodeKey: "node-129" }]),
      input([{ ...disposition("ADD"), nodeKey: "duplicate" },
        { ...disposition("REMOVE"), nodeKey: "duplicate" }]),
      { ...input(), supportedCanonicalizerVersions: [] },
      { ...input(), supportedCanonicalizerVersions: ["canon-v1", "canon-v1"] },
      { ...input(), supportedCanonicalizerVersions: Array.from({ length: 33 },
        (_, index) => `canon-${index}`) },
    ];
    expect(invalid.length).toBeGreaterThan(0);
    for (const candidate of invalid) {
      expectRefusal(decideSupersession(PREDECESSOR, candidate), "REVISION_REBOUND");
    }
  });

  it("pins every disposition hash/presence rule and rejects carry smuggling", () => {
    const equal = hex("9");
    const invalid: SupersessionDisposition[] = [
      { ...disposition("ADD"), predecessorAuthorityHash: equal },
      { ...disposition("ADD"), successorAuthorityHash: null },
      { ...disposition("REMOVE"), predecessorAuthorityHash: null },
      { ...disposition("REMOVE"), successorAuthorityHash: equal },
      { ...disposition("CHANGE"), successorAuthorityHash: hex("5") },
      { ...disposition("CHANGE"), predecessorAuthorityHash: null },
      { ...disposition("REQUALIFY"), successorAuthorityHash: equal },
      { ...disposition("REEXECUTE"), successorAuthorityHash: equal },
      { ...disposition("CARRY"), successorAuthorityHash: equal },
      { ...disposition("ADD"), safeCarry: disposition("CARRY").safeCarry },
    ];
    expect(invalid.length).toBeGreaterThan(0);
    for (const entry of invalid) {
      expectRefusal(decideSupersession(PREDECESSOR, input([entry])), "REVISION_REBOUND");
    }
  });

  it("gives structural rebound precedence over missing carry evidence", () => {
    const carry = { ...disposition("CARRY"), safeCarry: null };
    const candidate = { ...input([carry]), successor: { ...SUCCESSOR, revisionId: "revision-1" } };
    expectRefusal(decideSupersession(PREDECESSOR, candidate), "REVISION_REBOUND");
  });
});

describe("supersession carry refusal", () => {
  const validCarry = disposition("CARRY").safeCarry as SupersessionSafeCarry;
  const withCarry = (safeCarry: unknown): unknown => ({
    ...input(), dispositions: [{ ...disposition("CARRY"), safeCarry }],
  });

  it("maps missing, malformed, UNKNOWN and unbound evidence to consequence changed", () => {
    const invalid = [
      null, {}, { authority: null, inputBinding: validCarry.inputBinding },
      { authority: { ...validCarry.authority, extra: true }, inputBinding: validCarry.inputBinding },
      { authority: { ...validCarry.authority, dependenciesPresent: "UNKNOWN" },
        inputBinding: validCarry.inputBinding },
      { authority: carryFact(hex("f")), inputBinding: validCarry.inputBinding },
    ];
    expect(invalid.length).toBeGreaterThan(0);
    for (const safeCarry of invalid) {
      expectRefusal(decideSupersession(PREDECESSOR, withCarry(safeCarry)),
        "SUPERSESSION_CONSEQUENCE_CHANGED");
    }
  });

  it("exercises every production carry predicate for authority and input binding", () => {
    const booleanKeys = [
      "dependenciesPresent", "environmentClosureUnchanged", "policySliceUnchanged",
      "predecessorResultUnchanged",
    ] as const;
    const cases: SupersessionSafeCarry[] = [];
    for (const group of ["authority", "inputBinding"] as const) {
      for (const key of booleanKeys) {
        cases.push({ ...validCarry, [group]: { ...validCarry[group], [key]: false } });
      }
      cases.push({ ...validCarry, [group]: { ...validCarry[group], targetHash: hex("f") } });
      cases.push({ ...validCarry, [group]: {
        ...validCarry[group], canonicalizerVersion: "canon-unknown",
      } });
    }
    expect(cases.length).toBe(12);
    expect(cases.length).toBeGreaterThan(0);
    for (const safeCarry of cases) {
      expectRefusal(decideSupersession(PREDECESSOR, withCarry(safeCarry)),
        "SUPERSESSION_CONSEQUENCE_CHANGED");
    }
  });
});
