/**
 * Contract tests for the five production fairness contract families.
 *
 * Covers all three modules. These contracts DESCRIBE and VALIDATE; the rotation
 * algorithm, deficit accounting and aging decisions belong to the consumer,
 * task-10cab3e5 (Fair scheduler production). The last describe block asserts that
 * boundary as a real property over the modules' runtime exports.
 */
import { describe, expect, it } from "vitest";

import { MAX_AUTHORITY_ITEMS } from "../authority/authority-kernel.js";
import * as contractModule from "./fairness-contract.js";
import * as evidenceModule from "./fairness-evidence.js";
import * as ringModule from "./fairness-ring.js";
import {
  FAIRNESS_CONTRACT_ISSUE_CODES,
  FAIRNESS_CONTRACT_LAYERS,
  FAIRNESS_DISPATCHABILITY_STATES,
  FAIRNESS_PRIORITY_CLASSES,
} from "./fairness-contract.js";
import type {
  FairnessContractIssueCode,
  FairnessContractLayer,
  FairnessContractResult,
} from "./fairness-contract.js";
import * as capRevisionModule from "./fairness-cap-revision.js";
import { validateCapRevision } from "./fairness-cap-revision.js";
import type { FairnessCapRevision } from "./fairness-cap-revision.js";
import { validateBypassClaim } from "./fairness-evidence.js";
import type { FairnessProvenBypasses } from "./fairness-evidence.js";
import { validateRing, validateRingResource } from "./fairness-ring.js";
import type { FairnessRing } from "./fairness-ring.js";
import * as workItemModule from "./fairness-work-item.js";
import { validateWorkItem, validateWorkItemSet } from "./fairness-work-item.js";
import type { FairnessWorkItem } from "./fairness-work-item.js";

interface CodeAndLayer {
  readonly code: FairnessContractIssueCode;
  readonly layer: FairnessContractLayer;
}

/** Whole-object issue projection: a swapped, extra or missing issue fails. */
function issuesOf(result: FairnessContractResult<unknown>): readonly CodeAndLayer[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal, got an accepted value");
  return result.issues.map((issue) => ({ code: issue.code, layer: issue.layer }));
}

function dispositionOf(result: FairnessContractResult<unknown>): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal, got an accepted value");
  return result.disposition;
}

function missingInputsOf(result: FairnessContractResult<unknown>): readonly (string | null)[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal, got an accepted value");
  return result.issues.map((issue) => issue.missingInput);
}

/** A total validator ANSWERS: it never throws, so a throw fails the case here. */
function answer(run: () => FairnessContractResult<unknown>): FairnessContractResult<unknown> {
  let thrown: unknown = null;
  let result: FairnessContractResult<unknown> | null = null;
  try {
    result = run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeNull();
  if (result === null) throw new Error("validator returned no result");
  return result;
}

function acceptedValue<T>(result: FairnessContractResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected acceptance, refused with ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

// --- Fixtures: each hostile case below is ONE mutation off a valid base, so the
// guard under test is the guard that answers rather than an earlier layer. ---

const OBSERVED_DISPATCHABILITY = { state: "DISPATCHABLE", observationRef: "obs:wi-a" };
const WORK_ITEM: Readonly<Record<string, unknown>> = {
  workItemId: "wi-a",
  dimensionId: "dim-1",
  priority: "P1",
  resourceId: "res-a",
  dispatchability: OBSERVED_DISPATCHABILITY,
};
function workItem(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...WORK_ITEM, ...overrides };
}

const RING: Readonly<Record<string, unknown>> = {
  ringId: "ring-1",
  dimensionId: "dim-1",
  resources: [{ resourceId: "res-b", weight: 3 }, { resourceId: "res-a", weight: 1 }],
  entries: [
    { workItemId: "wi-b", resourceId: "res-b", deficitCounter: 5 },
    { workItemId: "wi-a", resourceId: "res-a", deficitCounter: 0 },
  ],
};
function ring(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...RING, ...overrides };
}

const ATTESTATIONS: readonly Readonly<Record<string, unknown>>[] = [
  { opportunityRef: "opp-1", winnerWorkItemId: "wi-b", observationRef: "obs-1" },
  { opportunityRef: "opp-2", winnerWorkItemId: "wi-c", observationRef: "obs-2" },
];
const CLAIM: Readonly<Record<string, unknown>> = {
  workItemId: "wi-a",
  claimedBypasses: 2,
  attestations: ATTESTATIONS,
};
function claim(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...CLAIM, ...overrides };
}

const REVISION: Readonly<Record<string, unknown>> = {
  revisionRef: "rev-1",
  dimensionId: "dim-1",
  fromCapUnits: 4,
  toCapUnits: 8,
  drainedWorkItemIds: ["wi-z"],
  migrations: [{ workItemId: "wi-a", boundAtMost: 3, currentBoundAtMost: 5 }],
};
function revision(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...REVISION, ...overrides };
}

const OVER_CAP = MAX_AUTHORITY_ITEMS + 1;

describe("fairness contract — vocabularies are frozen and closed", () => {
  it("pins the cardinality bound the contracts reuse", () => {
    // Hardcoded so a change to the reused package bound reddens here loudly
    // instead of silently resizing every cardinality fixture below.
    expect(MAX_AUTHORITY_ITEMS).toBe(128);
    expect(OVER_CAP).toBe(129);
  });

  it("freezes every exported vocabulary", () => {
    for (const vocabulary of [
      FAIRNESS_CONTRACT_ISSUE_CODES,
      FAIRNESS_CONTRACT_LAYERS,
      FAIRNESS_DISPATCHABILITY_STATES,
      FAIRNESS_PRIORITY_CLASSES,
    ]) {
      expect(Object.isFrozen(vocabulary)).toBe(true);
    }
  });

  it("names the five refusing layers and no others", () => {
    expect([...FAIRNESS_CONTRACT_LAYERS]).toEqual([
      "CAP_REVISION", "OPPORTUNITY_EVIDENCE", "RESOURCE", "RING", "WORK_ITEM",
    ]);
  });
});

describe("fairness contract — defect (a): a bypass claim must carry its proof", () => {
  it("REFUSES a bypass claim with no evidence at all", () => {
    const result = validateBypassClaim(claim({ attestations: [] }));
    expect(dispositionOf(result)).toBe("REFUSED");
    expect(issuesOf(result)).toEqual([
      { code: "FAIRNESS_CONTRACT_BYPASS_EVIDENCE_MISSING", layer: "OPPORTUNITY_EVIDENCE" },
    ]);
  });

  it("REFUSES a claimed count the attestations do not prove", () => {
    expect(issuesOf(validateBypassClaim(claim({ claimedBypasses: 3 })))).toEqual([
      { code: "FAIRNESS_CONTRACT_BYPASS_COUNT_UNPROVEN", layer: "OPPORTUNITY_EVIDENCE" },
    ]);
  });

  it("REFUSES a claim attested by the claimant itself", () => {
    const selfAttested = [{ ...ATTESTATIONS[0], winnerWorkItemId: "wi-a" }, ATTESTATIONS[1]];
    expect(issuesOf(validateBypassClaim(claim({ attestations: selfAttested })))).toEqual([
      { code: "FAIRNESS_CONTRACT_BYPASS_SELF_ATTESTED", layer: "OPPORTUNITY_EVIDENCE" },
    ]);
  });

  it("ACCEPTS a proven claim and counts the bypasses from the evidence, not the claim", () => {
    const proven: FairnessProvenBypasses = acceptedValue(validateBypassClaim(CLAIM));
    expect(proven).toEqual({
      workItemId: "wi-a",
      provenBypasses: 2,
      opportunityRefs: ["opp-1", "opp-2"],
    });
    expect(Object.isFrozen(proven.opportunityRefs)).toBe(true);
  });
});

describe("fairness contract — defect (b): rings and resource queues are representable", () => {
  it("ACCEPTS a valid multi-resource ring the reference could not express", () => {
    const validated: FairnessRing = acceptedValue(validateRing(RING));
    expect(validated.resources.map((resource) => resource.resourceId)).toEqual(["res-b", "res-a"]);
    expect(validated.entries.map((entry) => entry.workItemId)).toEqual(["wi-b", "wi-a"]);
    expect(validated.entries.map((entry) => entry.deficitCounter)).toEqual([5, 0]);
  });

  it("ACCEPTS a standalone resource declaration", () => {
    expect(acceptedValue(validateRingResource({ resourceId: "res-a", weight: 7 })))
      .toEqual({ resourceId: "res-a", weight: 7 });
  });

  it("REFUSES a queued item naming a resource the ring never declared", () => {
    const entries = [{ workItemId: "wi-c", resourceId: "res-zz", deficitCounter: 0 }];
    expect(issuesOf(validateRing(ring({ entries })))).toEqual([
      { code: "FAIRNESS_CONTRACT_UNDECLARED_RESOURCE", layer: "RING" },
    ]);
  });

  it("REFUSES one work item queued on two resources", () => {
    const entries = [
      { workItemId: "wi-a", resourceId: "res-a", deficitCounter: 0 },
      { workItemId: "wi-a", resourceId: "res-b", deficitCounter: 0 },
    ];
    expect(issuesOf(validateRing(ring({ entries })))).toEqual([
      { code: "FAIRNESS_CONTRACT_ITEM_IN_MULTIPLE_QUEUES", layer: "RING" },
    ]);
  });

  it("REFUSES an empty resource set while a queue still holds an item", () => {
    expect(issuesOf(validateRing(ring({ resources: [] })))).toEqual([
      { code: "FAIRNESS_CONTRACT_EMPTY_RESOURCE_SET", layer: "RING" },
    ]);
  });

  it("ACCEPTS an empty ring: no resources and no queued items", () => {
    const empty: FairnessRing = acceptedValue(validateRing(ring({ resources: [], entries: [] })));
    expect([empty.resources.length, empty.entries.length]).toEqual([0, 0]);
  });

  it("names the RESOURCE layer, not RING, for a malformed declared resource", () => {
    const resources = [{ resourceId: "res-a", weight: -1 }];
    expect(issuesOf(validateRing(ring({ resources, entries: [] })))).toEqual([
      { code: "FAIRNESS_CONTRACT_INVALID_COUNTER", layer: "RESOURCE" },
    ]);
  });
});

describe("fairness contract — defect (c): unclassifiable input is UNKNOWN, never admitted", () => {
  it("types an unobserved dispatchability claim UNKNOWN and names the missing input", () => {
    const unobserved = workItem({
      dispatchability: { state: "DISPATCHABLE", observationRef: null },
    });
    const result = validateWorkItem(unobserved);
    expect(dispositionOf(result)).toBe("UNKNOWN");
    expect(issuesOf(result)).toEqual([
      { code: "FAIRNESS_CONTRACT_DISPATCHABILITY_UNOBSERVED", layer: "WORK_ITEM" },
    ]);
    expect(missingInputsOf(result)).toEqual(["dispatchability.observationRef"]);
  });

  it("types an unobserved bypass opportunity UNKNOWN and names the missing input", () => {
    const attestations = [{ ...ATTESTATIONS[0], observationRef: null }, ATTESTATIONS[1]];
    const result = validateBypassClaim(claim({ attestations }));
    expect(dispositionOf(result)).toBe("UNKNOWN");
    expect(issuesOf(result)).toEqual([
      { code: "FAIRNESS_CONTRACT_OPPORTUNITY_UNOBSERVED", layer: "OPPORTUNITY_EVIDENCE" },
    ]);
    expect(missingInputsOf(result)).toEqual(["attestations[0].observationRef"]);
  });

  it("types an unobserved prior cap bound UNKNOWN and names the missing input", () => {
    const migrations = [{ workItemId: "wi-a", boundAtMost: 3, currentBoundAtMost: null }];
    const result = validateCapRevision(revision({ migrations }));
    expect(dispositionOf(result)).toBe("UNKNOWN");
    expect(issuesOf(result)).toEqual([
      { code: "FAIRNESS_CONTRACT_PRIOR_BOUND_UNOBSERVED", layer: "CAP_REVISION" },
    ]);
    expect(missingInputsOf(result)).toEqual(["migrations[0].currentBoundAtMost"]);
  });

  it("closes the reference's Unicode identity gap: an invisible-character id is REFUSED", () => {
    // The reference accepts any well-formed Unicode identity up to 256 UTF-8
    // bytes, so a zero-width joiner passes there. Production reuses this
    // package's ASCII-only identity rule, so it cannot be represented. The
    // joiner is written as an escape so it stays visible to a reviewer.
    const zeroWidthJoinerId = `wi${String.fromCharCode(0x200d)}-a`;
    const result = validateWorkItem(workItem({ workItemId: zeroWidthJoinerId }));
    expect(dispositionOf(result)).toBe("REFUSED");
    expect(issuesOf(result)).toEqual([
      { code: "FAIRNESS_CONTRACT_INVALID_IDENTITY", layer: "WORK_ITEM" },
    ]);
  });

  it("ACCEPTS a fully observed work item", () => {
    const item: FairnessWorkItem = acceptedValue(validateWorkItem(WORK_ITEM));
    expect(item).toEqual({
      workItemId: "wi-a",
      dimensionId: "dim-1",
      priority: "P1",
      resourceId: "res-a",
      dispatchability: { state: "DISPATCHABLE", observationRef: "obs:wi-a" },
    });
  });

  it("ACCEPTS an observed NOT_DISPATCHABLE work item — absence of readiness is not absence of evidence", () => {
    const item = acceptedValue(validateWorkItem(workItem({
      dispatchability: { state: "NOT_DISPATCHABLE", observationRef: "obs:wi-a" },
    })));
    expect(item.dispatchability.state).toBe("NOT_DISPATCHABLE");
  });
});

describe("fairness contract — cap revision is data plus a total validator, never a decision", () => {
  it("ACCEPTS a revision whose migration bound is equal or tighter", () => {
    const accepted: FairnessCapRevision = acceptedValue(validateCapRevision(REVISION));
    expect(accepted.migrations.map((migration) => migration.boundAtMost)).toEqual([3]);
    expect([accepted.fromCapUnits, accepted.toCapUnits]).toEqual([4, 8]);
  });

  it("ACCEPTS a lowered cap: the contract does not judge the direction of a revision", () => {
    const lowered = acceptedValue(validateCapRevision(revision({ fromCapUnits: 8, toCapUnits: 4 })));
    expect([lowered.fromCapUnits, lowered.toCapUnits]).toEqual([8, 4]);
  });

  it("REFUSES a loosened migration bound", () => {
    const migrations = [{ workItemId: "wi-a", boundAtMost: 9, currentBoundAtMost: 5 }];
    expect(issuesOf(validateCapRevision(revision({ migrations })))).toEqual([
      { code: "FAIRNESS_CONTRACT_BOUND_LOOSENED", layer: "CAP_REVISION" },
    ]);
  });

  it("REFUSES a work item that is both drained and migrated", () => {
    expect(issuesOf(validateCapRevision(revision({ drainedWorkItemIds: ["wi-a"] })))).toEqual([
      { code: "FAIRNESS_CONTRACT_MIGRATION_TARGET_DRAINED", layer: "CAP_REVISION" },
    ]);
  });
});

// --- DoD 2/DoD 3: every declared reason code is reachable from a real refusal
// path, asserted by a HAND-WRITTEN table rather than derived from the vocabulary
// under test. The final assertion pins the table's code set to the frozen
// vocabulary, so an unreachable code and an undeclared code both go red. ---

interface ReachabilityCase {
  readonly label: string;
  readonly run: () => FairnessContractResult<unknown>;
  readonly disposition: "REFUSED" | "UNKNOWN";
  readonly code: FairnessContractIssueCode;
  readonly layer: FairnessContractLayer;
  readonly missingInput: string | null;
}

function reachability(
  label: string,
  run: () => FairnessContractResult<unknown>,
  disposition: "REFUSED" | "UNKNOWN",
  code: FairnessContractIssueCode,
  layer: FairnessContractLayer,
  missingInput: string | null = null,
): ReachabilityCase {
  return { label, run, disposition, code, layer, missingInput };
}

function repeat<T>(count: number, make: (index: number) => T): T[] {
  const items: T[] = [];
  for (let index = 0; index < count; index += 1) items.push(make(index));
  return items;
}

const REACHABILITY_CASES: readonly ReachabilityCase[] = [
  reachability("work item: hostile input", () => validateWorkItem(null),
    "REFUSED", "FAIRNESS_CONTRACT_MALFORMED_INPUT", "WORK_ITEM"),
  reachability("work item: unsafe identity", () => validateWorkItem(workItem({ workItemId: "wi a" })),
    "REFUSED", "FAIRNESS_CONTRACT_INVALID_IDENTITY", "WORK_ITEM"),
  reachability("work item: priority outside the closed class set",
    () => validateWorkItem(workItem({ priority: "P9" })),
    "REFUSED", "FAIRNESS_CONTRACT_INVALID_PRIORITY", "WORK_ITEM"),
  reachability("work item: dispatchability with no observation",
    () => validateWorkItem(workItem({ dispatchability: { state: "DISPATCHABLE", observationRef: null } })),
    "UNKNOWN", "FAIRNESS_CONTRACT_DISPATCHABILITY_UNOBSERVED", "WORK_ITEM",
    "dispatchability.observationRef"),
  reachability("work item set: foreign dimension",
    () => validateWorkItemSet([WORK_ITEM], "dim-2"),
    "REFUSED", "FAIRNESS_CONTRACT_DIMENSION_MISMATCH", "WORK_ITEM"),
  reachability("work item set: duplicate identity",
    () => validateWorkItemSet([WORK_ITEM, WORK_ITEM], "dim-1"),
    "REFUSED", "FAIRNESS_CONTRACT_DUPLICATE_IDENTITY", "WORK_ITEM"),
  reachability("work item set: above the cardinality bound",
    () => validateWorkItemSet(repeat(OVER_CAP, (index) => workItem({ workItemId: `wi-${index}` })), "dim-1"),
    "REFUSED", "FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED", "WORK_ITEM"),
  reachability("ring: hostile input", () => validateRing(null),
    "REFUSED", "FAIRNESS_CONTRACT_MALFORMED_INPUT", "RING"),
  reachability("ring: unsafe identity", () => validateRing(ring({ ringId: "ring 1" })),
    "REFUSED", "FAIRNESS_CONTRACT_INVALID_IDENTITY", "RING"),
  reachability("ring: negative deficit counter",
    () => validateRing(ring({ entries: [{ workItemId: "wi-a", resourceId: "res-a", deficitCounter: -1 }] })),
    "REFUSED", "FAIRNESS_CONTRACT_INVALID_COUNTER", "RING"),
  reachability("ring: above the cardinality bound",
    () => validateRing(ring({
      resources: repeat(OVER_CAP, (index) => ({ resourceId: `res-${index}`, weight: 1 })),
      entries: [],
    })),
    "REFUSED", "FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED", "RING"),
  reachability("ring: duplicate resource declaration",
    () => validateRing(ring({
      resources: [{ resourceId: "res-a", weight: 1 }, { resourceId: "res-a", weight: 2 }],
      entries: [],
    })),
    "REFUSED", "FAIRNESS_CONTRACT_DUPLICATE_IDENTITY", "RING"),
  reachability("ring: undeclared resource",
    () => validateRing(ring({ entries: [{ workItemId: "wi-c", resourceId: "res-zz", deficitCounter: 0 }] })),
    "REFUSED", "FAIRNESS_CONTRACT_UNDECLARED_RESOURCE", "RING"),
  reachability("ring: one item in two queues",
    () => validateRing(ring({
      entries: [
        { workItemId: "wi-a", resourceId: "res-a", deficitCounter: 0 },
        { workItemId: "wi-a", resourceId: "res-b", deficitCounter: 0 },
      ],
    })),
    "REFUSED", "FAIRNESS_CONTRACT_ITEM_IN_MULTIPLE_QUEUES", "RING"),
  reachability("ring: queued item with no declared resources",
    () => validateRing(ring({ resources: [] })),
    "REFUSED", "FAIRNESS_CONTRACT_EMPTY_RESOURCE_SET", "RING"),
  reachability("resource: hostile input", () => validateRingResource(null),
    "REFUSED", "FAIRNESS_CONTRACT_MALFORMED_INPUT", "RESOURCE"),
  reachability("resource: unsafe identity", () => validateRingResource({ resourceId: "", weight: 1 }),
    "REFUSED", "FAIRNESS_CONTRACT_INVALID_IDENTITY", "RESOURCE"),
  reachability("resource: negative weight", () => validateRingResource({ resourceId: "res-a", weight: -1 }),
    "REFUSED", "FAIRNESS_CONTRACT_INVALID_COUNTER", "RESOURCE"),
  reachability("evidence: hostile input", () => validateBypassClaim(null),
    "REFUSED", "FAIRNESS_CONTRACT_MALFORMED_INPUT", "OPPORTUNITY_EVIDENCE"),
  reachability("evidence: unsafe opportunity identity",
    () => validateBypassClaim(claim({
      attestations: [{ ...ATTESTATIONS[0], opportunityRef: "opp 1" }, ATTESTATIONS[1]],
    })),
    "REFUSED", "FAIRNESS_CONTRACT_INVALID_IDENTITY", "OPPORTUNITY_EVIDENCE"),
  reachability("evidence: claim with no attestations",
    () => validateBypassClaim(claim({ attestations: [] })),
    "REFUSED", "FAIRNESS_CONTRACT_BYPASS_EVIDENCE_MISSING", "OPPORTUNITY_EVIDENCE"),
  reachability("evidence: claimed count exceeds the proof",
    () => validateBypassClaim(claim({ claimedBypasses: 3 })),
    "REFUSED", "FAIRNESS_CONTRACT_BYPASS_COUNT_UNPROVEN", "OPPORTUNITY_EVIDENCE"),
  reachability("evidence: self-attested bypass",
    () => validateBypassClaim(claim({
      attestations: [{ ...ATTESTATIONS[0], winnerWorkItemId: "wi-a" }, ATTESTATIONS[1]],
    })),
    "REFUSED", "FAIRNESS_CONTRACT_BYPASS_SELF_ATTESTED", "OPPORTUNITY_EVIDENCE"),
  reachability("evidence: duplicate opportunity",
    () => validateBypassClaim(claim({ attestations: [ATTESTATIONS[0], ATTESTATIONS[0]] })),
    "REFUSED", "FAIRNESS_CONTRACT_DUPLICATE_IDENTITY", "OPPORTUNITY_EVIDENCE"),
  reachability("evidence: above the cardinality bound",
    () => validateBypassClaim(claim({
      claimedBypasses: OVER_CAP,
      attestations: repeat(OVER_CAP, (index) => ({
        opportunityRef: `opp-${index}`, winnerWorkItemId: "wi-b", observationRef: `obs-${index}`,
      })),
    })),
    "REFUSED", "FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED", "OPPORTUNITY_EVIDENCE"),
  reachability("evidence: attestation with no observation",
    () => validateBypassClaim(claim({
      attestations: [{ ...ATTESTATIONS[0], observationRef: null }, ATTESTATIONS[1]],
    })),
    "UNKNOWN", "FAIRNESS_CONTRACT_OPPORTUNITY_UNOBSERVED", "OPPORTUNITY_EVIDENCE",
    "attestations[0].observationRef"),
  reachability("cap revision: hostile input", () => validateCapRevision(null),
    "REFUSED", "FAIRNESS_CONTRACT_MALFORMED_INPUT", "CAP_REVISION"),
  reachability("cap revision: unsafe identity", () => validateCapRevision(revision({ revisionRef: "rev 1" })),
    "REFUSED", "FAIRNESS_CONTRACT_INVALID_IDENTITY", "CAP_REVISION"),
  reachability("cap revision: negative cap units",
    () => validateCapRevision(revision({ toCapUnits: -1 })),
    "REFUSED", "FAIRNESS_CONTRACT_INVALID_COUNTER", "CAP_REVISION"),
  reachability("cap revision: duplicate migration target",
    () => validateCapRevision(revision({
      migrations: [
        { workItemId: "wi-a", boundAtMost: 3, currentBoundAtMost: 5 },
        { workItemId: "wi-a", boundAtMost: 2, currentBoundAtMost: 5 },
      ],
    })),
    "REFUSED", "FAIRNESS_CONTRACT_DUPLICATE_IDENTITY", "CAP_REVISION"),
  reachability("cap revision: above the cardinality bound",
    () => validateCapRevision(revision({
      migrations: repeat(OVER_CAP, (index) => ({
        workItemId: `wi-${index}`, boundAtMost: 1, currentBoundAtMost: 5,
      })),
    })),
    "REFUSED", "FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED", "CAP_REVISION"),
  reachability("cap revision: loosened bound",
    () => validateCapRevision(revision({
      migrations: [{ workItemId: "wi-a", boundAtMost: 9, currentBoundAtMost: 5 }],
    })),
    "REFUSED", "FAIRNESS_CONTRACT_BOUND_LOOSENED", "CAP_REVISION"),
  reachability("cap revision: migrated item is also drained",
    () => validateCapRevision(revision({ drainedWorkItemIds: ["wi-a"] })),
    "REFUSED", "FAIRNESS_CONTRACT_MIGRATION_TARGET_DRAINED", "CAP_REVISION"),
  reachability("cap revision: migration with no prior bound",
    () => validateCapRevision(revision({
      migrations: [{ workItemId: "wi-a", boundAtMost: 3, currentBoundAtMost: null }],
    })),
    "UNKNOWN", "FAIRNESS_CONTRACT_PRIOR_BOUND_UNOBSERVED", "CAP_REVISION",
    "migrations[0].currentBoundAtMost"),
];

describe("fairness contract — every declared reason code is reachable", () => {
  it("generated a non-zero, hand-counted number of reachability cases", () => {
    expect(REACHABILITY_CASES.length).toBeGreaterThan(0);
    expect(REACHABILITY_CASES.length).toBe(34);
  });

  it.each(REACHABILITY_CASES.map((testCase) => [testCase.label, testCase] as const))(
    "refuses %s with its own code and layer",
    (_label, testCase) => {
      const result = testCase.run();
      expect(dispositionOf(result)).toBe(testCase.disposition);
      expect(issuesOf(result)).toEqual([{ code: testCase.code, layer: testCase.layer }]);
      expect(missingInputsOf(result)).toEqual([testCase.missingInput]);
    },
  );

  it("covers exactly the frozen reason-code vocabulary — no unreachable code", () => {
    const covered = [...new Set(REACHABILITY_CASES.map((testCase) => testCase.code))].sort();
    expect(covered).toEqual([...FAIRNESS_CONTRACT_ISSUE_CODES].sort());
  });

  it("covers every refusing layer", () => {
    const covered = [...new Set(REACHABILITY_CASES.map((testCase) => testCase.layer))].sort();
    expect(covered).toEqual([...FAIRNESS_CONTRACT_LAYERS].sort());
  });

  it("names a missing input on every UNKNOWN and on no REFUSED", () => {
    for (const testCase of REACHABILITY_CASES) {
      const named = testCase.missingInput !== null;
      expect(named).toBe(testCase.disposition === "UNKNOWN");
    }
  });
});

// --- DoD 3: totality. Every validator answers every hostile shape with a typed
// refusal instead of a throw, and the sweep asserts it actually generated cases. ---

const HOSTILE_RECORDS: readonly (readonly [string, unknown])[] = [
  ["null", null],
  ["undefined", undefined],
  ["string", "res-a"],
  ["number", 7],
  ["boolean", true],
  ["symbol", Symbol("hostile")],
  ["array", []],
  ["proxy", new Proxy({}, { get: () => { throw new Error("trap"); } })],
  ["throwing accessor", Object.defineProperty({}, "trap", {
    enumerable: true, get: () => { throw new Error("getter"); },
  })],
  ["symbol-keyed record", Object.defineProperty({}, Symbol("key"), {
    enumerable: true, value: 1,
  })],
  ["class instance", new (class Hostile { public readonly resourceId = "res-a"; })()],
  ["null-prototype record", Object.create(null)],
];

interface SweptValidator {
  readonly name: string;
  readonly layer: FairnessContractLayer;
  readonly run: (value: unknown) => FairnessContractResult<unknown>;
}

const RECORD_VALIDATORS: readonly SweptValidator[] = [
  { name: "validateWorkItem", layer: "WORK_ITEM", run: validateWorkItem },
  { name: "validateRing", layer: "RING", run: validateRing },
  { name: "validateRingResource", layer: "RESOURCE", run: validateRingResource },
  { name: "validateBypassClaim", layer: "OPPORTUNITY_EVIDENCE", run: validateBypassClaim },
  { name: "validateCapRevision", layer: "CAP_REVISION", run: validateCapRevision },
];

const TOTALITY_CASES: readonly (readonly [string, SweptValidator, unknown])[] =
  RECORD_VALIDATORS.flatMap((validator) =>
    HOSTILE_RECORDS.map(
      (entry): readonly [string, SweptValidator, unknown] =>
        [`${validator.name} <- ${entry[0]}`, validator, entry[1]],
    ),
  );

/** An array IS the accepted shape for the set validator, so it gets its own corpus. */
const LIST_TOTALITY_CASES: readonly (readonly [string, unknown])[] =
  HOSTILE_RECORDS.filter((entry) => entry[0] !== "array")
    .map((entry): readonly [string, unknown] => [`validateWorkItemSet <- ${entry[0]}`, entry[1]]);

describe("fairness contract — refusal paths are total", () => {
  it("generated a non-zero, hand-counted number of totality cases", () => {
    expect(HOSTILE_RECORDS.length).toBe(12);
    expect(TOTALITY_CASES.length).toBeGreaterThan(0);
    expect(TOTALITY_CASES.length).toBe(60);
    expect(LIST_TOTALITY_CASES.length).toBeGreaterThan(0);
    expect(LIST_TOTALITY_CASES.length).toBe(11);
  });

  it.each(TOTALITY_CASES)("returns a typed refusal for %s", (_label, validator, value) => {
    const answered = answer(() => validator.run(value));
    expect(issuesOf(answered)).toEqual([
      { code: "FAIRNESS_CONTRACT_MALFORMED_INPUT", layer: validator.layer },
    ]);
    expect(dispositionOf(answered)).toBe("REFUSED");
  });

  it.each(LIST_TOTALITY_CASES)("returns a typed refusal for %s", (_label, value) => {
    const answered = answer(() => validateWorkItemSet(value, "dim-1"));
    expect(issuesOf(answered)).toEqual([
      { code: "FAIRNESS_CONTRACT_MALFORMED_INPUT", layer: "WORK_ITEM" },
    ]);
    expect(dispositionOf(answered)).toBe("REFUSED");
  });

  it("refuses a hostile expected dimension without consulting the items", () => {
    expect(issuesOf(validateWorkItemSet([WORK_ITEM], null))).toEqual([
      { code: "FAIRNESS_CONTRACT_INVALID_IDENTITY", layer: "WORK_ITEM" },
    ]);
  });

  it("ACCEPTS an empty work-item set for a well-formed dimension", () => {
    expect(acceptedValue(validateWorkItemSet([], "dim-1"))).toEqual([]);
  });
});

// --- DoD 4: the contracts carry no authority. Asserted as a real property over
// the modules' RUNTIME exports, not as a comment. ---

const RUNTIME_MODULES: readonly (readonly [string, Readonly<Record<string, unknown>>, number])[] = [
  ["fairness-contract", contractModule, 11],
  ["fairness-work-item", workItemModule, 2],
  ["fairness-ring", ringModule, 2],
  // Two: validateBypassClaim, plus validateOpportunityAttestation for the
  // admission-to-preparation bridge. Both are `validate*`, so the name rules
  // below still apply unchanged.
  ["fairness-evidence", evidenceModule, 2],
  ["fairness-cap-revision", capRevisionModule, 1],
];

/**
 * Hand-written closed allowlist: the only non-validator, non-guard exports.
 * Adding a name here is a reviewable act, which is the point — a new export
 * either reads as a validator/guard or forces this list to change.
 */
const RESULT_CONSTRUCTORS: ReadonlySet<string> = new Set([
  "acceptFairness", "makeFairnessIssue", "readFairnessItems", "refuseFairness", "unknownFairness",
]);
const VALIDATOR_NAME = /^validate[A-Z]/u;
const GUARD_NAME = /^is[A-Z]/u;
/** Any export whose NAME claims a scheduling decision — task-10cab3e5's scope. */
const AUTHORITY_NAME = /next|order|sort|rotat|select|charge|promot|rank|decid|pick|schedul/iu;

describe("fairness contract — no authority and no policy", () => {
  it.each(RUNTIME_MODULES)("enumerates a non-zero export count for %s", (_name, module, count) => {
    const names = Object.keys(module);
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBe(count);
  });

  it.each(RUNTIME_MODULES)("publishes only validators, guards, constructors and frozen constants from %s",
    (_name, module) => {
      for (const [name, value] of Object.entries(module)) {
        if (typeof value === "function") {
          const classified = VALIDATOR_NAME.test(name) || GUARD_NAME.test(name)
            || RESULT_CONSTRUCTORS.has(name);
          expect({ name, classified }).toEqual({ name, classified: true });
          continue;
        }
        expect({ name, frozen: Object.isFrozen(value) }).toEqual({ name, frozen: true });
      }
    });

  it.each(RUNTIME_MODULES)("exports no name claiming a scheduling decision from %s", (_name, module) => {
    for (const name of Object.keys(module)) {
      expect({ name, claimsAuthority: AUTHORITY_NAME.test(name) })
        .toEqual({ name, claimsAuthority: false });
    }
  });

  it("preserves caller order and counters verbatim — it never rotates or charges", () => {
    const validated = acceptedValue(validateRing(RING));
    expect(validated.resources.map((resource) => [resource.resourceId, resource.weight]))
      .toEqual([["res-b", 3], ["res-a", 1]]);
    expect(validated.entries.map((entry) => [entry.workItemId, entry.deficitCounter]))
      .toEqual([["wi-b", 5], ["wi-a", 0]]);
  });

  it("freezes accepted values so a consumer cannot mutate the contract's answer", () => {
    const validated = acceptedValue(validateRing(RING));
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.entries)).toBe(true);
    expect(Object.isFrozen(validated.entries[0])).toBe(true);
  });

  it("copies the caller's input so later caller mutation cannot change an accepted value", () => {
    const mutable = {
      ringId: "ring-1",
      dimensionId: "dim-1",
      resources: [{ resourceId: "res-a", weight: 1 }],
      entries: [{ workItemId: "wi-a", resourceId: "res-a", deficitCounter: 4 }],
    };
    const validated = acceptedValue(validateRing(mutable));
    const firstEntry = mutable.entries[0];
    if (firstEntry === undefined) throw new Error("fixture lost its entry");
    firstEntry.deficitCounter = 99;
    mutable.resources.push({ resourceId: "res-b", weight: 2 });
    expect(validated.entries.map((entry) => entry.deficitCounter)).toEqual([4]);
    expect(validated.resources.length).toBe(1);
  });
});
