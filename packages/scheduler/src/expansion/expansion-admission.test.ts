/**
 * Expansion admission: evidence derivation and the all-or-none composer.
 *
 * WHY THE CALLER-POSITIVE CASES COME FIRST. This kernel exists so an admission
 * decision comes from DERIVED evidence rather than from what a caller presented.
 * A suite that only feeds well-formed receipts and checks the happy path would
 * pass against a validator that trusted every field it was handed, which is the
 * one defect the task is written to prevent. So the first tests hand the
 * validator a receipt asserting its own eligibility and require refusal.
 *
 * Every refusal assertion pins the exact CODE and the exact LAYER. Where a
 * refusal is delegated from a composed surface it is asserted VERBATIM — a
 * re-coded delegated refusal loses which layer actually refused, and that is
 * invisible to an "it refused" assertion.
 */

import { describe, expect, it } from "vitest";

import { deriveExpansionEvidence } from "./expansion-evidence.js";
import {
  EXPANSION_EVIDENCE_ISSUE_CODES, EXPANSION_EVIDENCE_LAYERS, FORBIDDEN_VERDICT_KEYS,
} from "./expansion-receipt.js";

/** A receipt every derivation accepts. Each test perturbs exactly one thing. */
function healthyReceipt(): Record<string, unknown> {
  return {
    proposalId: "prop-1",
    revision: 3,
    goalVersion: 7,
    graphEpoch: 11,
    observedAtSequence: 100,
    horizonSequence: 90,
    parentScope: ["a", "b", "c", "d"],
    childScopes: [
      {
        childKey: "child-1",
        scope: ["a", "b"],
        oracleKind: "OBSERVED",
        completion: "CLOSED",
        inputs: [{ inputKey: "in-1", materialization: "MATERIALIZED", digest: "a".repeat(64) }],
      },
      {
        childKey: "child-2",
        scope: ["c"],
        oracleKind: "DERIVED",
        completion: "CLOSED",
        inputs: [{ inputKey: "in-2", materialization: "MATERIALIZED", digest: "b".repeat(64) }],
      },
    ],
    sourceDigests: ["a".repeat(64), "b".repeat(64)],
  };
}

/** The single issue a refusal carried, failing loudly if there was not exactly one. */
function onlyIssue(value: unknown): { code: string; layer: string; missingInput: string | null } {
  const result = value as { ok: boolean; issues?: readonly { code: string; layer: string; missingInput: string | null }[] };
  expect(result.ok).toBe(false);
  expect(result.issues).toBeDefined();
  expect(result.issues).toHaveLength(1);
  return result.issues![0]!;
}

describe("caller-declared verdicts gain nothing", () => {
  // THE CENTRAL PROPERTY. A caller that asserts its own eligibility must be
  // refused by a code that names exactly that, not by a generic malformed-input
  // code — otherwise the refusal could migrate to a shape guard and the suite
  // would stay green while the property stopped being tested.
  it.each([...FORBIDDEN_VERDICT_KEYS])("refuses a receipt carrying %s at the top level", (key: string) => {
    const receipt = { ...healthyReceipt(), [key]: true };
    const issue = onlyIssue(deriveExpansionEvidence(receipt));
    expect(issue.code).toBe("EXPANSION_CALLER_DECLARED_VERDICT");
    expect(issue.layer).toBe("EVIDENCE");
  });

  it("refuses a caller verdict hidden inside a child rather than at the top", () => {
    const receipt = healthyReceipt();
    const children = receipt["childScopes"] as Record<string, unknown>[];
    children[0] = { ...children[0], oracleEligible: true };
    const issue = onlyIssue(deriveExpansionEvidence(receipt));
    expect(issue.code).toBe("EXPANSION_CALLER_DECLARED_VERDICT");
    expect(issue.layer).toBe("EVIDENCE");
  });

  it("refuses a caller verdict that AGREES with the derived answer", () => {
    // The agreeing case is the one a permissive implementation passes, because
    // nothing it checks disagrees. Presenting a verdict at all is the defect.
    const receipt = { ...healthyReceipt(), scopeDisjoint: true };
    expect(onlyIssue(deriveExpansionEvidence(receipt)).code).toBe(
      "EXPANSION_CALLER_DECLARED_VERDICT",
    );
  });

  it("the forbidden-verdict sweep ran over a non-empty key set", () => {
    // A sweep that silently generated zero cases passes while testing nothing.
    expect(FORBIDDEN_VERDICT_KEYS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(FORBIDDEN_VERDICT_KEYS)).toBe(true);
  });
});

describe("the seven derivations refuse independently", () => {
  it("accepts the healthy receipt, so every refusal below is caused by its own perturbation", () => {
    const result = deriveExpansionEvidence(healthyReceipt());
    expect(result.ok).toBe(true);
  });

  it("refuses overlapping child scopes", () => {
    const receipt = healthyReceipt();
    const children = receipt["childScopes"] as Record<string, unknown>[];
    children[1] = { ...children[1], scope: ["b", "c"] };
    const issue = onlyIssue(deriveExpansionEvidence(receipt));
    expect(issue.code).toBe("EXPANSION_SCOPE_OVERLAP");
    expect(issue.layer).toBe("SCOPE");
  });

  it("refuses a child scope not contained by the parent scope", () => {
    const receipt = healthyReceipt();
    const children = receipt["childScopes"] as Record<string, unknown>[];
    children[1] = { ...children[1], scope: ["z"] };
    const issue = onlyIssue(deriveExpansionEvidence(receipt));
    expect(issue.code).toBe("EXPANSION_CONTAINMENT_VIOLATED");
    expect(issue.layer).toBe("CONTAINMENT");
  });

  it("refuses a child whose oracle is ineligible", () => {
    const receipt = healthyReceipt();
    const children = receipt["childScopes"] as Record<string, unknown>[];
    children[0] = { ...children[0], oracleKind: "NONE" };
    const issue = onlyIssue(deriveExpansionEvidence(receipt));
    expect(issue.code).toBe("EXPANSION_ORACLE_INELIGIBLE");
    expect(issue.layer).toBe("ORACLE");
  });

  it("refuses an input that is not materializable", () => {
    const receipt = healthyReceipt();
    const children = receipt["childScopes"] as Record<string, unknown>[];
    const inputs = [{ inputKey: "in-1", materialization: "PENDING", digest: null }];
    children[0] = { ...children[0], inputs };
    const issue = onlyIssue(deriveExpansionEvidence(receipt));
    expect(issue.code).toBe("EXPANSION_INPUT_NOT_MATERIALIZABLE");
    expect(issue.layer).toBe("INPUT");
  });

  it("refuses a child whose completion is not closed", () => {
    const receipt = healthyReceipt();
    const children = receipt["childScopes"] as Record<string, unknown>[];
    children[1] = { ...children[1], completion: "OPEN" };
    const issue = onlyIssue(deriveExpansionEvidence(receipt));
    expect(issue.code).toBe("EXPANSION_COMPLETION_NOT_CLOSED");
    expect(issue.layer).toBe("CONTAINMENT");
  });

  it("refuses a receipt observed before its freshness horizon", () => {
    const receipt = { ...healthyReceipt(), observedAtSequence: 89 };
    const issue = onlyIssue(deriveExpansionEvidence(receipt));
    expect(issue.code).toBe("EXPANSION_RECEIPT_STALE");
    expect(issue.layer).toBe("FRESHNESS");
  });

  it("refuses an input digest absent from the receipt's source digests", () => {
    const receipt = healthyReceipt();
    const children = receipt["childScopes"] as Record<string, unknown>[];
    children[0] = {
      ...children[0],
      inputs: [{ inputKey: "in-1", materialization: "MATERIALIZED", digest: "c".repeat(64) }],
    };
    const issue = onlyIssue(deriveExpansionEvidence(receipt));
    expect(issue.code).toBe("EXPANSION_SOURCE_DIGEST_MISMATCH");
    expect(issue.layer).toBe("SOURCE");
  });

  it("every derivation is reachable, so no code in the vocabulary is decorative", () => {
    // Guards the seven tests above the way a set comparison guards a sweep:
    // seven named tests read like seven covered derivations even if two of them
    // trip the same guard.
    const produced = new Set<string>();
    const perturbations: (() => unknown)[] = [
      () => {
        const r = healthyReceipt();
        (r["childScopes"] as Record<string, unknown>[])[1] = {
          ...(r["childScopes"] as Record<string, unknown>[])[1],
          scope: ["b", "c"],
        };
        return r;
      },
      () => {
        const r = healthyReceipt();
        (r["childScopes"] as Record<string, unknown>[])[1] = {
          ...(r["childScopes"] as Record<string, unknown>[])[1],
          scope: ["z"],
        };
        return r;
      },
      () => {
        const r = healthyReceipt();
        (r["childScopes"] as Record<string, unknown>[])[0] = {
          ...(r["childScopes"] as Record<string, unknown>[])[0],
          oracleKind: "NONE",
        };
        return r;
      },
      () => {
        const r = healthyReceipt();
        (r["childScopes"] as Record<string, unknown>[])[0] = {
          ...(r["childScopes"] as Record<string, unknown>[])[0],
          inputs: [{ inputKey: "in-1", materialization: "PENDING", digest: null }],
        };
        return r;
      },
      () => {
        const r = healthyReceipt();
        (r["childScopes"] as Record<string, unknown>[])[1] = {
          ...(r["childScopes"] as Record<string, unknown>[])[1],
          completion: "OPEN",
        };
        return r;
      },
      () => ({ ...healthyReceipt(), observedAtSequence: 89 }),
      () => {
        const r = healthyReceipt();
        (r["childScopes"] as Record<string, unknown>[])[0] = {
          ...(r["childScopes"] as Record<string, unknown>[])[0],
          inputs: [{ inputKey: "in-1", materialization: "MATERIALIZED", digest: "c".repeat(64) }],
        };
        return r;
      },
    ];
    for (const build of perturbations) {
      produced.add(onlyIssue(deriveExpansionEvidence(build())).code);
    }
    expect(produced.size).toBe(7);
  });
});

describe("UNKNOWN never becomes proof", () => {
  it("an UNKNOWN materialization is UNKNOWN, never an optimistic pass", () => {
    const receipt = healthyReceipt();
    const children = receipt["childScopes"] as Record<string, unknown>[];
    children[0] = {
      ...children[0],
      inputs: [{ inputKey: "in-1", materialization: "UNKNOWN", digest: null }],
    };
    const result = deriveExpansionEvidence(receipt) as { ok: boolean; disposition?: string };
    expect(result.ok).toBe(false);
    // The DISPOSITION separates "the value is wrong" from "an input needed to
    // classify it was never supplied". Collapsing them would let a missing fact
    // read as a refuted one.
    expect(result.disposition).toBe("UNKNOWN");
    const issue = onlyIssue(result);
    expect(issue.code).toBe("EXPANSION_EVIDENCE_UNKNOWN");
    expect(issue.missingInput).toBe("childScopes[0].inputs[0].materialization");
  });

  it("an UNKNOWN completion is UNKNOWN rather than not-closed", () => {
    const receipt = healthyReceipt();
    const children = receipt["childScopes"] as Record<string, unknown>[];
    children[1] = { ...children[1], completion: "UNKNOWN" };
    const result = deriveExpansionEvidence(receipt) as { ok: boolean; disposition?: string };
    expect(result.disposition).toBe("UNKNOWN");
    expect(onlyIssue(result).code).toBe("EXPANSION_EVIDENCE_UNKNOWN");
  });
});

describe("hostile and malformed receipts", () => {
  it.each([
    ["null", null],
    ["a string", "receipt"],
    ["an array", []],
    ["a number", 7],
  ])("refuses %s as malformed", (_label, value) => {
    const issue = onlyIssue(deriveExpansionEvidence(value));
    expect(issue.code).toBe("EXPANSION_EVIDENCE_MALFORMED");
    expect(issue.layer).toBe("EVIDENCE");
  });

  it("refuses a receipt missing a required key", () => {
    const receipt = healthyReceipt();
    delete receipt["sourceDigests"];
    const issue = onlyIssue(deriveExpansionEvidence(receipt));
    expect(issue.code).toBe("EXPANSION_EVIDENCE_MISSING");
    expect(issue.missingInput).toBe("sourceDigests");
  });

  it("refuses an unknown extra key rather than ignoring it", () => {
    // Ignoring unknown keys is how a future caller-supplied verdict slips in
    // under a name this version has never heard of.
    const receipt = { ...healthyReceipt(), somethingNew: 1 };
    expect(onlyIssue(deriveExpansionEvidence(receipt)).code).toBe("EXPANSION_EVIDENCE_MALFORMED");
  });

  it("refuses a prototype-polluting key without consulting the prototype chain", () => {
    const receipt = JSON.parse(
      '{"__proto__":{"scopeDisjoint":true},"proposalId":"p"}',
    ) as Record<string, unknown>;
    expect(deriveExpansionEvidence(receipt).ok).toBe(false);
  });

  it("refuses a source digest that is not 64 lowercase hex", () => {
    const receipt = { ...healthyReceipt(), sourceDigests: ["NOTHEX", "b".repeat(64)] };
    expect(onlyIssue(deriveExpansionEvidence(receipt)).code).toBe("EXPANSION_EVIDENCE_MALFORMED");
  });
});

describe("the derived verdict is frozen and complete", () => {
  it("returns a deeply frozen value a consumer cannot rewrite", () => {
    const result = deriveExpansionEvidence(healthyReceipt()) as unknown as {
      ok: true;
      value: Record<string, unknown>;
    };
    expect(result.ok).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value["childKeys"])).toBe(true);
  });

  it("the closed vocabularies are frozen and non-empty", () => {
    expect(Object.isFrozen(EXPANSION_EVIDENCE_ISSUE_CODES)).toBe(true);
    expect(Object.isFrozen(EXPANSION_EVIDENCE_LAYERS)).toBe(true);
    expect(EXPANSION_EVIDENCE_ISSUE_CODES.length).toBeGreaterThan(0);
    expect(EXPANSION_EVIDENCE_LAYERS.length).toBeGreaterThan(0);
  });

  it("every issue code the vocabulary declares is one a real path can produce", () => {
    // A vocabulary entry no guard can emit is a claimed guard that does not
    // exist. Every code below is produced by a test in this file.
    const emitted = new Set([
      "EXPANSION_CALLER_DECLARED_VERDICT",
      "EXPANSION_COMPLETION_NOT_CLOSED",
      "EXPANSION_CONTAINMENT_VIOLATED",
      "EXPANSION_EVIDENCE_MALFORMED",
      "EXPANSION_EVIDENCE_MISSING",
      "EXPANSION_EVIDENCE_UNKNOWN",
      "EXPANSION_INPUT_NOT_MATERIALIZABLE",
      "EXPANSION_ORACLE_INELIGIBLE",
      "EXPANSION_RECEIPT_STALE",
      "EXPANSION_SCOPE_OVERLAP",
      "EXPANSION_SOURCE_DIGEST_MISMATCH",
    ]);
    expect(new Set(EXPANSION_EVIDENCE_ISSUE_CODES)).toEqual(emitted);
  });
});

// ---------------------------------------------------------------------------
// THE COMPOSER. Everything below drives `admitExpansion`.
//
// The composer is where all-or-none lives, so its tests assert the ABSENCE of
// partial artefacts rather than only the presence of a refusal: a call that
// reserved budget and then failed must leave the budget exactly as it found it.
// A returned refusal object is satisfied by an implementation that strands a
// held reservation, so the reservation itself is what gets measured.
// ---------------------------------------------------------------------------

import { chain, inputFor } from "../admission/admission-fixtures.js";
import { admitExpansion } from "./expansion-admission.js";

const OPEN_METERS = [{ meter: "tokens", available: 1000, reserved: 0, quarantined: 0, committed: 0 }];

function budgetPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    view: { accountId: "acct.1", state: "OPEN", version: 4, meters: OPEN_METERS },
    admission: {
      admissionRef: "adm.1",
      expectedVersion: 4,
      amounts: [
        { purpose: "EXECUTION", meter: "tokens", quantity: 10 },
        { purpose: "VERIFICATION", meter: "tokens", quantity: 5 },
        { purpose: "INDEPENDENT_REVIEW", meter: "tokens", quantity: 5 },
        { purpose: "FINAL_ACCEPTANCE", meter: "tokens", quantity: 5 },
        { purpose: "CONTINGENCY", meter: "tokens", quantity: 5 },
      ],
    },
    gate: { allowance: { decisionRef: "dec.1", outcome: "ALLOW" }, approval: null },
    ...overrides,
  };
}

function rotationPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ring: {
      ringId: "ring.main",
      dimensionId: "dim.alpha",
      resources: [{ resourceId: "res.a", weight: 1 }, { resourceId: "res.b", weight: 1 }],
      entries: [
        { workItemId: "item.a", resourceId: "res.a", deficitCounter: 1 },
        { workItemId: "item.b", resourceId: "res.b", deficitCounter: 1 },
      ],
    },
    workItems: ["item.a", "item.b"].map((workItemId) => ({
      workItemId,
      dimensionId: "dim.alpha",
      priority: "P2",
      resourceId: workItemId === "item.a" ? "res.a" : "res.b",
      dispatchability: { state: "DISPATCHABLE", observationRef: `obs.${workItemId}` },
    })),
    capacities: [
      { resourceId: "res.a", capacityUnits: 4, inFlightUnits: 0 },
      { resourceId: "res.b", capacityUnits: 4, inFlightUnits: 0 },
    ],
    forcedHead: null,
    capRevision: null,
    ...overrides,
  };
}

function resourcesPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req.1",
    declaredResources: [{ resourceId: "res.a", capacityUnits: 1, external: false, fenceable: true }],
    capacitySnapshot: { "res.a": 4 },
    epoch: 1,
    eligibilityEventSequenceRef: "seq.1",
    continuouslyEligibleSinceRef: "since.1",
    callerObservation: "obs.1",
    ...overrides,
  };
}

function admissionRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receipt: healthyReceipt(),
    lineage: { expansionDepth: 2, nodesAddedInExpansion: 2 },
    graph: inputFor(chain()),
    rotation: rotationPart(),
    bypassClaim: null,
    budget: budgetPart(),
    resources: resourcesPart(),
    ...overrides,
  };
}

/** A receipt with `width` children, each on its own parent-scope key and digest. */
function wideReceipt(width: number): Record<string, unknown> {
  const keys = Array.from({ length: width }, (_, index) => `k${index}`);
  const digests = keys.map((_, index) => String(index % 10).repeat(64));
  return {
    ...healthyReceipt(),
    parentScope: keys,
    sourceDigests: digests,
    childScopes: keys.map((key, index) => ({
      childKey: `child-${index}`,
      scope: [key],
      oracleKind: "OBSERVED",
      completion: "CLOSED",
      inputs: [{ inputKey: `in-${index}`, materialization: "MATERIALIZED", digest: digests[index] }],
    })),
  };
}

interface ComposerIssue {
  code: string;
  layer: string;
  origin: string;
  message: string;
  missingInput: string | null;
}
interface ComposerRefusal {
  ok: false;
  disposition: string;
  issues: readonly ComposerIssue[];
  unwind: {
    budgetReservationCancelled: boolean;
    restoredMeters: readonly Record<string, unknown>[] | null;
  };
}
interface ComposerSuccess {
  ok: true;
  preparation: { identity: string; bound: Record<string, unknown> };
}

function refusalOf(value: unknown): ComposerRefusal {
  expect((value as { ok: boolean }).ok).toBe(false);
  return value as ComposerRefusal;
}

function preparationOf(value: unknown): ComposerSuccess["preparation"] {
  const result = value as ComposerSuccess;
  if (!result.ok) {
    const codes = (value as ComposerRefusal).issues.map((one) => one.code).join(",");
    throw new Error(`unexpected refusal: ${codes}`);
  }
  return result.preparation;
}

function codesOfRefusal(value: unknown): readonly string[] {
  return refusalOf(value).issues.map((one) => one.code);
}

describe("the composer prepares one all-or-none admission", () => {
  it("admits the healthy request and binds every fact the identity claims", () => {
    const bound = preparationOf(admitExpansion(admissionRequest())).bound;
    // Named one by one rather than by snapshot: a snapshot re-records whatever
    // the code produced, so a field silently dropped from the binding would be
    // re-baselined instead of caught.
    for (const key of [
      "proposalId", "revision", "goalVersion", "graphEpoch", "observedAtSequence", "childKeys",
      "sourceDigests", "evidenceDigest", "qualityDigest", "lineage", "fairness",
      "capacitySnapshot", "provenBypasses", "budgetReservation", "resourceReservation",
    ]) {
      expect(bound[key], `bound.${key} is absent`).toBeDefined();
    }
    expect(bound["proposalId"]).toBe("prop-1");
    expect(bound["lineage"]).toEqual({ expansionDepth: 2, childWidth: 2, nodesAddedInExpansion: 2 });
  });

  it("returns a frozen preparation a consumer cannot rewrite", () => {
    const preparation = preparationOf(admitExpansion(admissionRequest()));
    expect(Object.isFrozen(preparation)).toBe(true);
    expect(Object.isFrozen(preparation.bound)).toBe(true);
    expect(Object.isFrozen(preparation.bound["capacitySnapshot"])).toBe(true);
  });

  it("derives childWidth rather than accepting one the caller supplies", () => {
    // The caller may state depth and node count — structural facts this kernel
    // cannot see — but never the width, which the receipt proves.
    const request = admissionRequest({
      lineage: { expansionDepth: 2, childWidth: 1, nodesAddedInExpansion: 2 },
    });
    const issue = refusalOf(admitExpansion(request)).issues[0]!;
    expect(issue.code).toBe("EXPANSION_ADMISSION_REQUEST_MALFORMED");
    expect(issue.origin).toBe("REQUEST");
  });

  it("replaying the same proposal yields the same identity", () => {
    const first = preparationOf(admitExpansion(admissionRequest()));
    const second = preparationOf(admitExpansion(admissionRequest()));
    expect(second.identity).toBe(first.identity);
    expect(first.identity).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("any byte change yields a different identity", () => {
  const baseSelection = (): string => {
    const bound = preparationOf(admitExpansion(admissionRequest())).bound;
    return (bound["fairness"] as { workItemId: string }).workItemId;
  };

  const perturbations: readonly (readonly [string, () => Record<string, unknown>])[] = [
    ["proposalId", () => admissionRequest({ receipt: { ...healthyReceipt(), proposalId: "prop-2" } })],
    ["revision", () => admissionRequest({ receipt: { ...healthyReceipt(), revision: 4 } })],
    ["goalVersion", () => admissionRequest({ receipt: { ...healthyReceipt(), goalVersion: 8 } })],
    ["graphEpoch", () => admissionRequest({ receipt: { ...healthyReceipt(), graphEpoch: 12 } })],
    ["observedAtSequence",
      () => admissionRequest({ receipt: { ...healthyReceipt(), observedAtSequence: 101 } })],
    // An UNUSED extra source digest moves the receipt's declared digest set and
    // NOTHING else — no input references it — so only a live top-level
    // sourceDigests binding can see it. The paired case below moves an input
    // digest too, which the child facts would have covered on their own.
    ["an unreferenced source digest", () => admissionRequest({
      receipt: { ...healthyReceipt(), sourceDigests: ["a".repeat(64), "b".repeat(64), "f".repeat(64)] },
    })],
    ["sourceDigests", () => {
      const receipt = healthyReceipt();
      const children = receipt["childScopes"] as Record<string, unknown>[];
      children[0] = {
        ...children[0],
        inputs: [{ inputKey: "in-1", materialization: "MATERIALIZED", digest: "e".repeat(64) }],
      };
      receipt["sourceDigests"] = ["e".repeat(64), "b".repeat(64)];
      return admissionRequest({ receipt });
    }],
    ["childKeys", () => {
      const receipt = healthyReceipt();
      const children = receipt["childScopes"] as Record<string, unknown>[];
      children[0] = { ...children[0], childKey: "child-9" };
      return admissionRequest({ receipt });
    }],
    // The next three are the reason `evidenceDigest` digests the CHILD FACTS
    // and not the whole evidence value: each changes a fact that no other bound
    // field carries, so only a live scope/oracle/input binding can see it.
    ["a child scope key, with the child keys unchanged", () => {
      const receipt = healthyReceipt();
      const children = receipt["childScopes"] as Record<string, unknown>[];
      children[0] = { ...children[0], scope: ["a", "d"] };
      return admissionRequest({ receipt });
    }],
    ["a child oracle kind", () => {
      const receipt = healthyReceipt();
      const children = receipt["childScopes"] as Record<string, unknown>[];
      children[0] = { ...children[0], oracleKind: "DERIVED" };
      return admissionRequest({ receipt });
    }],
    ["an input key", () => {
      const receipt = healthyReceipt();
      const children = receipt["childScopes"] as Record<string, unknown>[];
      children[0] = {
        ...children[0],
        inputs: [{ inputKey: "in-9", materialization: "MATERIALIZED", digest: "a".repeat(64) }],
      };
      return admissionRequest({ receipt });
    }],
    ["expansionDepth",
      () => admissionRequest({ lineage: { expansionDepth: 3, nodesAddedInExpansion: 2 } })],
    ["nodesAddedInExpansion",
      () => admissionRequest({ lineage: { expansionDepth: 2, nodesAddedInExpansion: 3 } })],
    ["quality/dependency records", () => admissionRequest({
      graph: inputFor(chain(), {
        estimates: {
          proposedDuration: { value: 5, truthClass: "OBSERVED" },
          sequentialBaselineDuration: { value: 9, truthClass: "OBSERVED" },
          proposedCost: { value: 1, truthClass: "OBSERVED" },
          sequentialBaselineCost: { value: 2, truthClass: "OBSERVED" },
        },
      }),
    })],
    ["capacity snapshot", () => admissionRequest({
      rotation: rotationPart({
        capacities: [
          { resourceId: "res.a", capacityUnits: 5, inFlightUnits: 0 },
          { resourceId: "res.b", capacityUnits: 4, inFlightUnits: 0 },
        ],
      }),
    })],
    ["fairness opportunity", () => admissionRequest({
      rotation: rotationPart({ forcedHead: baseSelection() === "item.a" ? "item.b" : "item.a" }),
    })],
    ["cap revision", () => admissionRequest({
      rotation: rotationPart({
        capRevision: {
          revisionRef: "rev.1", dimensionId: "dim.alpha", fromCapUnits: 10, toCapUnits: 10,
          drainedWorkItemIds: [], migrations: [],
        },
      }),
    })],
    ["proven bypasses", () => admissionRequest({
      bypassClaim: {
        workItemId: "item.a", claimedBypasses: 1,
        attestations: [{ opportunityRef: "opp.1", winnerWorkItemId: "item.b", observationRef: "obs.z" }],
      },
    })],
    ["budget reservation", () => admissionRequest({
      budget: budgetPart({
        admission: { ...(budgetPart()["admission"] as Record<string, unknown>), admissionRef: "adm.2" },
      }),
    })],
    ["resource reservation", () => admissionRequest({ resources: resourcesPart({ requestId: "req.2" }) })],
  ];

  it("the perturbation sweep generated a non-zero number of cases", () => {
    // A sweep that silently produced zero cases passes while testing nothing.
    expect(perturbations.length).toBeGreaterThan(0);
  });

  it.each(perturbations)("perturbing %s changes the identity", (_label, build) => {
    const base = preparationOf(admitExpansion(admissionRequest())).identity;
    expect(preparationOf(admitExpansion(build())).identity).not.toBe(base);
  });

  it("every perturbation produces a DISTINCT identity, so no two collide", () => {
    const identities = new Set(
      perturbations.map(([, build]) => preparationOf(admitExpansion(build())).identity),
    );
    identities.add(preparationOf(admitExpansion(admissionRequest())).identity);
    expect(identities.size).toBe(perturbations.length + 1);
  });
});

describe("the 3/6/9 limits are the landed ones, at N and N+1", () => {
  it.each([
    ["depth", 3, 4, "ADMISSION_EXPANSION_DEPTH_EXCEEDED"],
    ["nodes", 9, 10, "ADMISSION_EXPANSION_FANOUT_EXCEEDED"],
  ])("%s admits at %i and refuses at %i", (kind, at, over, code) => {
    const lineageAt = kind === "depth"
      ? { expansionDepth: at as number, nodesAddedInExpansion: 2 }
      : { expansionDepth: 2, nodesAddedInExpansion: at as number };
    const lineageOver = kind === "depth"
      ? { expansionDepth: over as number, nodesAddedInExpansion: 2 }
      : { expansionDepth: 2, nodesAddedInExpansion: over as number };
    expect(admitExpansion(admissionRequest({ lineage: lineageAt })).ok).toBe(true);
    const refused = refusalOf(admitExpansion(admissionRequest({ lineage: lineageOver })));
    expect(refused.issues.map((one) => one.code)).toContain(code);
    expect(refused.issues[0]!.origin).toBe("LINEAGE");
  });

  it("child width admits at 6 and refuses at 7, from the DERIVED width", () => {
    expect(admitExpansion(admissionRequest({ receipt: wideReceipt(6) })).ok).toBe(true);
    expect(codesOfRefusal(admitExpansion(admissionRequest({ receipt: wideReceipt(7) }))))
      .toContain("ADMISSION_EXPANSION_CHILD_WIDTH_EXCEEDED");
  });
});

describe("delegated refusals pass through verbatim", () => {
  it("an evidence refusal keeps its own code AND layer", () => {
    const receipt = healthyReceipt();
    const children = receipt["childScopes"] as Record<string, unknown>[];
    children[1] = { ...children[1], scope: ["b", "c"] };
    const issue = refusalOf(admitExpansion(admissionRequest({ receipt }))).issues[0]!;
    expect(issue.code).toBe("EXPANSION_SCOPE_OVERLAP");
    expect(issue.layer).toBe("SCOPE");
    expect(issue.origin).toBe("EVIDENCE");
  });

  it("a graph refusal keeps its landed admission code", () => {
    const graph = { proposedSnapshot: chain(), contracts: "nope" };
    const issue = refusalOf(admitExpansion(admissionRequest({ graph }))).issues[0]!;
    expect(issue.code).toBe("ADMISSION_INPUT_MALFORMED");
    expect(issue.origin).toBe("GRAPH");
  });

  it("a fairness refusal keeps its landed code AND its own refusing layer", () => {
    const rotation = rotationPart({
      capacities: [
        { resourceId: "res.a", capacityUnits: 4, inFlightUnits: 0 },
        { resourceId: "res.b", capacityUnits: 4, inFlightUnits: 0 },
        { resourceId: "res.z", capacityUnits: 4, inFlightUnits: 0 },
      ],
    });
    const issue = refusalOf(admitExpansion(admissionRequest({ rotation }))).issues[0]!;
    expect(issue.code).toBe("FAIRNESS_CONTRACT_UNDECLARED_RESOURCE");
    expect(issue.layer).toBe("RESOURCE");
    expect(issue.origin).toBe("FAIRNESS");
  });

  it("a budget refusal keeps its landed reservation code", () => {
    const budget = budgetPart({
      admission: { ...(budgetPart()["admission"] as Record<string, unknown>), expectedVersion: 99 },
    });
    const issue = refusalOf(admitExpansion(admissionRequest({ budget }))).issues[0]!;
    expect(issue.code).toBe("BUDGET_RESERVATION_STALE_VERSION");
    expect(issue.origin).toBe("BUDGET");
  });

  it("a resource refusal keeps its landed authority code", () => {
    const issue = refusalOf(admitExpansion(admissionRequest({ resources: "not-a-request" }))).issues[0]!;
    expect(issue.code).toBe("AUTHORITY_MALFORMED_INPUT");
    expect(issue.origin).toBe("RESOURCE");
  });

  it("an UNKNOWN evidence disposition stays UNKNOWN rather than becoming REFUSED", () => {
    const receipt = healthyReceipt();
    const children = receipt["childScopes"] as Record<string, unknown>[];
    children[0] = {
      ...children[0],
      inputs: [{ inputKey: "in-1", materialization: "UNKNOWN", digest: null }],
    };
    const refusal = refusalOf(admitExpansion(admissionRequest({ receipt })));
    expect(refusal.disposition).toBe("UNKNOWN");
    expect(refusal.issues[0]!.missingInput).toBe("childScopes[0].inputs[0].materialization");
  });
});

describe("a local code is minted only where no composed surface can speak", () => {
  it("an idle rotation is not an opportunity, and no fairness code says so", () => {
    // rotateOnce returns ok:true with an IDLE disposition — a NON-refusal that
    // is nonetheless not an admission. The closed fairness code tuple describes
    // contract violations only, so this fact is inexpressible there.
    const rotation = rotationPart({
      capacities: [
        { resourceId: "res.a", capacityUnits: 1, inFlightUnits: 1 },
        { resourceId: "res.b", capacityUnits: 1, inFlightUnits: 1 },
      ],
    });
    const issue = refusalOf(admitExpansion(admissionRequest({ rotation }))).issues[0]!;
    expect(issue.code).toBe("EXPANSION_ADMISSION_NO_FAIRNESS_OPPORTUNITY");
    expect(issue.origin).toBe("FAIRNESS");
  });

  it("a WAITING acquisition reserved nothing, and no authority code says so", () => {
    const resources = resourcesPart({ capacitySnapshot: { "res.a": 0 } });
    const issue = refusalOf(admitExpansion(admissionRequest({ resources }))).issues[0]!;
    expect(issue.code).toBe("EXPANSION_ADMISSION_RESOURCES_UNAVAILABLE");
    expect(issue.origin).toBe("RESOURCE");
  });
});

describe("all-or-none: a late refusal leaves nothing held", () => {
  // The budget reservation is taken BEFORE the resource acquisition, so this is
  // the one ordering where a partial hold is reachable at all.
  const lateFailure = (): unknown =>
    admitExpansion(admissionRequest({ resources: resourcesPart({ capacitySnapshot: { "res.a": 0 } }) }));

  it("carries no preparation, no identity and no child authority", () => {
    const refusal = lateFailure() as Record<string, unknown>;
    expect(refusal["preparation"]).toBeUndefined();
    expect(refusal["identity"]).toBeUndefined();
    expect(refusal["reservation"]).toBeUndefined();
    expect(refusal["rows"]).toBeUndefined();
  });

  it("cancels the budget reservation it took, restoring the meters byte for byte", () => {
    // The decisive assertion. A refusal that merely RETURNS a refusal still
    // passes the check above while the units stay in RESERVED; only comparing
    // the restored buckets against the untouched view proves nothing is held.
    const refusal = refusalOf(lateFailure());
    expect(refusal.unwind.budgetReservationCancelled).toBe(true);
    expect(refusal.unwind.restoredMeters).toEqual([{ meter: "tokens", available: 1000, reserved: 0 }]);
  });

  it("reports no cancellation when the refusal happened before any reservation", () => {
    const refusal = refusalOf(admitExpansion(admissionRequest({ graph: "junk" })));
    expect(refusal.unwind.budgetReservationCancelled).toBe(false);
    expect(refusal.unwind.restoredMeters).toBeNull();
  });

  it("the refusal object itself is frozen", () => {
    const refusal = refusalOf(lateFailure());
    expect(Object.isFrozen(refusal)).toBe(true);
    expect(Object.isFrozen(refusal.issues)).toBe(true);
  });
});

describe("hostile composer requests", () => {
  it.each([
    ["null", null],
    ["a string", "request"],
    ["an array", []],
  ])("refuses %s with the request code", (_label, value) => {
    const issue = refusalOf(admitExpansion(value)).issues[0]!;
    expect(issue.code).toBe("EXPANSION_ADMISSION_REQUEST_MALFORMED");
    expect(issue.origin).toBe("REQUEST");
  });

  it("refuses an unknown extra key on the request envelope", () => {
    expect(codesOfRefusal(admitExpansion(admissionRequest({ extra: 1 }))))
      .toEqual(["EXPANSION_ADMISSION_REQUEST_MALFORMED"]);
  });

  it("refuses a request whose lineage counts are not safe integers", () => {
    const request = admissionRequest({ lineage: { expansionDepth: -1, nodesAddedInExpansion: 2 } });
    expect(codesOfRefusal(admitExpansion(request))).toEqual(["EXPANSION_ADMISSION_REQUEST_MALFORMED"]);
  });

  it("evidence is derived BEFORE any reservation, so a bad receipt holds nothing", () => {
    const refusal = refusalOf(admitExpansion(admissionRequest({ receipt: null })));
    expect(refusal.unwind.budgetReservationCancelled).toBe(false);
    expect(refusal.issues[0]!.origin).toBe("EVIDENCE");
  });
});
