/**
 * The plan.propose authority parser: admission of the ONE bounded field that carries a canonical
 * PlanRevision and AcceptanceContract together, and the cross-bindings between them and the
 * legacy `submissionHash`.
 *
 * THREE refusal vocabularies can answer and every arm pins WHICH one did. The core codecs own
 * body admission, canonicalization and digest (`PLAN_REVISION_*`, `ACCEPTANCE_CONTRACT_*`); this
 * module owns only the two-key shell, the forged-decision gate and the cross-bindings. A
 * restamped core refusal would hide which authority answered, so `layer` is asserted everywhere.
 *
 * Every arm is evaluated INSIDE its own `it`. Hoisting the sweep to module scope would turn any
 * regression into one anonymous suite-level failure instead of a named assertion going red.
 *
 * REACHABILITY DISCLOSURE: `PLAN_REVISION_NONCANONICAL` / `ACCEPTANCE_CONTRACT_NONCANONICAL` are
 * unreachable from a record-carrying field. The parser ENCODES before it decodes, so the bytes it
 * decodes are canonical by construction. The reachable canonicalization refusals are asserted
 * instead — non-NFC text — plus a positive control that hostile key ORDER still admits.
 */
import { describe, expect, it } from "vitest";

import { deriveAcceptanceContractDigest } from "./acceptance-contract-codec.js";
import { derivePlanRevisionDigest } from "./plan-revision-codec.js";
import {
  admitPlanAuthoritySubmission,
  PLAN_AUTHORITY_SUBMISSION_CODES,
} from "./planning-authority-submission.js";
import type { PlanAuthorityAdmitResult } from "./planning-authority-submission.js";
import {
  AUTHOR_REF, buildAuthority, CONTRACT_ID, contractDraft, CRITERION_IDS, FOREIGN_HEX,
  GRAPH_CONTENT_HASH, GRAPH_REVISION_REF, REVISION_ID,
} from "./planning-authority-test-fixtures.js";
import type { AuthorityFixture } from "./planning-authority-test-fixtures.js";

const LAYER = "PLAN_AUTHORITY_SUBMISSION";
const MALFORMED = { code: "PLAN_AUTHORITY_SUBMISSION_MALFORMED", layer: LAYER, ok: false };
/**
 * `e` + COMBINING ACUTE, written as an escape on purpose: NFC folds it to a single precomposed
 * codepoint, so the text is not in canonical form. A literal `é` in this source would be saved
 * precomposed by most editors, and the arm would silently degrade into a digest-mismatch test.
 */
const NON_NFC = `${AUTHOR_REF}-e\u0301`;

const base: AuthorityFixture = buildAuthority();
const BASE_HASH = base.planRevision.planHash;

interface Refusal { readonly code: string; readonly layer: string; readonly ok: false }

function refuseWith(value: unknown, submissionHash: string = BASE_HASH): Refusal {
  const result: PlanAuthorityAdmitResult = admitPlanAuthoritySubmission(value, submissionHash);
  if (result.ok) throw new Error(`expected a refusal, admitted ${JSON.stringify(result.identity)}`);
  return result;
}

function accessorShell(): Record<string, unknown> {
  const shell: Record<string, unknown> = { acceptanceContract: base.acceptanceContract };
  Object.defineProperty(shell, "planRevision", {
    configurable: true, enumerable: true, get: () => base.planRevision,
  });
  return shell;
}

/** Every one of these is a caller trying to hand the proposal a decision it never earned. */
const APPROVAL_SHAPED_KEYS = Object.freeze([
  "approval", "approvalDigest", "approvalRef", "approvalState", "approvedHashes",
  "humanApproval", "planApproval",
]);

const SHELL_ARMS: readonly (readonly [string, unknown])[] = Object.freeze([
  ["a non-object authority", "not-an-authority"],
  ["a null authority", null],
  ["a numeric authority", 7],
  ["an array authority", [base.planRevision, base.acceptanceContract]],
  ["a missing acceptance contract", { planRevision: base.planRevision }],
  ["a missing plan revision", { acceptanceContract: base.acceptanceContract }],
  ["an empty shell", {}],
  ["an extra shell key", { ...base, submissionHash: BASE_HASH }],
  ["an accessor shell member", accessorShell()],
  ["a proxied shell", new Proxy({ ...base }, {})],
  ["a hostile shell prototype", Object.assign(Object.create({ inherited: true }), { ...base })],
]);

const FIRST_OBLIGATION = base.acceptanceContract.obligations[0];

const CORE_ARMS: readonly (readonly [string, unknown, string, string])[] = Object.freeze([
  ["a tampered plan revision digest",
    { ...base, planRevision: { ...base.planRevision, planHash: FOREIGN_HEX } },
    "PLAN_REVISION_DIGEST_MISMATCH", "PLAN_REVISION_DIGEST"],
  ["a tampered criteria digest",
    { ...base, acceptanceContract: { ...base.acceptanceContract, criteriaDigest: FOREIGN_HEX } },
    "ACCEPTANCE_CONTRACT_DIGEST_MISMATCH", "ACCEPTANCE_CONTRACT_DIGEST"],
  ["an extra key inside the plan revision",
    { ...base, planRevision: { ...base.planRevision, approvalRef: "approval-ref" } },
    "PLAN_REVISION_MALFORMED", "PLAN_REVISION_ADMISSION"],
  ["a proxied plan revision",
    { ...base, planRevision: new Proxy({ ...base.planRevision }, {}) },
    "PLAN_REVISION_MALFORMED", "PLAN_REVISION_ADMISSION"],
  ["a duplicated affected criterion id",
    { ...base, planRevision: { ...base.planRevision, affectedCriterionIds: ["a", "a"] } },
    "PLAN_REVISION_DUPLICATE_ID", "PLAN_REVISION_LIMITS"],
  ["a noncanonical author on the plan revision",
    { ...base, planRevision: { ...base.planRevision, authorRef: NON_NFC } },
    "PLAN_REVISION_MALFORMED", "PLAN_REVISION_ADMISSION"],
  ["a duplicated obligation id",
    { ...base, acceptanceContract: { ...base.acceptanceContract,
      obligations: [FIRST_OBLIGATION, FIRST_OBLIGATION] } },
    "ACCEPTANCE_CONTRACT_DUPLICATE_ID", "ACCEPTANCE_CONTRACT_LIMITS"],
  ["a noncanonical author on the acceptance contract",
    { ...base, acceptanceContract: { ...base.acceptanceContract, authorRef: NON_NFC } },
    "ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_ADMISSION"],
]);

const applicability = contractDraft()["applicability"] as object;
const otherGraphRevision = buildAuthority({}, {
  applicability: { ...applicability, graphRevisionRef: "other-graph-revision" },
});
const otherGraphContent = buildAuthority({}, {
  applicability: { ...applicability, graphContentHash: FOREIGN_HEX },
});
const narrowedRoster = buildAuthority({ affectedCriterionIds: [CRITERION_IDS[0]] });
const preApproved = buildAuthority({ approvalState: "APPROVED" });
const preRejected = buildAuthority({ rejectionRef: "rejection-ref" });
/**
 * The separator collision: a criterion id may legally CONTAIN the separator, so `["a,b"]` and
 * `["a", "b"]` collapse to the same delimiter-joined string. Only an injective encoding refuses
 * this, which is why the roster is JSON rather than a join.
 */
const collidingRoster = buildAuthority(
  { affectedCriterionIds: ["a", "b"] }, { obligations: [{ ...FIRST_OBLIGATION, criterionId: "a,b" }] },
);

/** Each row deviates in EXACTLY one binding and is otherwise fully admissible. */
const BINDING_ARMS: readonly (readonly [string, AuthorityFixture, string, string])[] =
  Object.freeze([
    ["a legacy submission hash disagreeing with the recomputed plan digest", base, FOREIGN_HEX,
      "PLAN_AUTHORITY_SUBMISSION_HASH_MISMATCH"],
    ["a contract bound to another graph revision", otherGraphRevision,
      otherGraphRevision.planRevision.planHash, "PLAN_AUTHORITY_GRAPH_REVISION_MISMATCH"],
    ["a contract bound to another graph content hash", otherGraphContent,
      otherGraphContent.planRevision.planHash, "PLAN_AUTHORITY_GRAPH_CONTENT_MISMATCH"],
    ["a criterion roster the plan revision does not carry", narrowedRoster,
      narrowedRoster.planRevision.planHash, "PLAN_AUTHORITY_CRITERIA_BINDING_MISMATCH"],
    ["a criterion roster that only a delimiter join would accept", collidingRoster,
      collidingRoster.planRevision.planHash, "PLAN_AUTHORITY_CRITERIA_BINDING_MISMATCH"],
    ["a pre-approved plan revision", preApproved, preApproved.planRevision.planHash,
      "PLAN_AUTHORITY_APPROVAL_FORGED"],
    ["a plan revision carrying a rejection decision", preRejected,
      preRejected.planRevision.planHash, "PLAN_AUTHORITY_REJECTION_FORGED"],
  ]);

describe("plan authority submission — accepted control", () => {
  const admitted = (): Extract<PlanAuthorityAdmitResult, { ok: true }> => {
    const result = admitPlanAuthoritySubmission(base, BASE_HASH);
    if (!result.ok) throw new Error(`the accepted control was refused: ${JSON.stringify(result)}`);
    return result;
  };

  it("admits a nonempty proposal built through the production codecs", () => {
    expect(admitted().ok).toBe(true);
  });

  it("recomputes both digests through the published derivations", () => {
    const plan = derivePlanRevisionDigest(base.planRevision);
    const criteria = deriveAcceptanceContractDigest(base.acceptanceContract);
    if (!plan.ok || !criteria.ok) throw new Error("a production derivation refused the control");
    expect(admitted().identity.planHash).toBe(plan.planHash);
    expect(admitted().identity.criteriaDigest).toBe(criteria.criteriaDigest);
    expect(admitted().identity.planHash).toBe(BASE_HASH);
  });

  it("carries the identity the envelope consumer binds on, and nothing executable", () => {
    const { identity } = admitted();
    expect(Object.keys(identity).sort()).toStrictEqual([
      "criteriaDigest", "criteriaRef", "graphContentHash", "graphRevisionRef", "planHash",
      "revisionId",
    ]);
    expect(identity.revisionId).toBe(REVISION_ID);
    expect(identity.criteriaRef).toBe(CONTRACT_ID);
    expect(identity.graphRevisionRef).toBe(GRAPH_REVISION_REF);
    expect(identity.graphContentHash).toBe(GRAPH_CONTENT_HASH);
  });

  it("returns the codecs' own records rather than the caller's objects", () => {
    const { authority } = admitted();
    expect(authority.planRevision).not.toBe(base.planRevision);
    expect(authority.acceptanceContract).not.toBe(base.acceptanceContract);
    expect(authority.planRevision).toStrictEqual(base.planRevision);
    expect(Object.isFrozen(authority.planRevision)).toBe(true);
  });

  it("admits a hostile key order to the identical identity", () => {
    const reordered = {
      planRevision: { ...base.planRevision }, acceptanceContract: { ...base.acceptanceContract },
    };
    const shuffled = admitPlanAuthoritySubmission(reordered, BASE_HASH);
    if (!shuffled.ok) throw new Error("the key-order control was refused");
    expect(shuffled.identity).toStrictEqual(admitted().identity);
  });
});

describe("plan authority submission — shell refusals", () => {
  it("generates a nonempty hostile sweep", () => {
    expect(SHELL_ARMS.length).toBeGreaterThan(0);
    expect(APPROVAL_SHAPED_KEYS.length).toBeGreaterThan(0);
  });

  for (const [name, value] of SHELL_ARMS) {
    it(`refuses ${name} at its own layer`, () => {
      expect(refuseWith(value)).toStrictEqual(MALFORMED);
    });
  }

  for (const key of APPROVAL_SHAPED_KEYS) {
    it(`refuses a caller-supplied "${key}" member`, () => {
      expect(refuseWith({ ...base, [key]: "forged" })).toStrictEqual(MALFORMED);
    });
  }
});

describe("plan authority submission — upstream refusals pass through verbatim", () => {
  it("generates a nonempty upstream sweep", () => {
    expect(CORE_ARMS.length).toBeGreaterThan(0);
  });

  for (const [name, value, code, layer] of CORE_ARMS) {
    it(`answers ${name} with the upstream code and layer`, () => {
      expect(refuseWith(value)).toStrictEqual({ code, layer, ok: false });
    });
  }
});

describe("plan authority submission — cross-bindings", () => {
  it("generates a nonempty binding sweep", () => {
    expect(BINDING_ARMS.length).toBeGreaterThan(0);
  });

  for (const [name, fixture, hash, code] of BINDING_ARMS) {
    it(`refuses ${name}`, () => {
      expect(refuseWith(fixture, hash)).toStrictEqual({ code, layer: LAYER, ok: false });
    });
  }

  it("exercises every advertised code, and advertises every exercised code", () => {
    const codes = new Set<string>();
    for (const [, value] of SHELL_ARMS) codes.add(refuseWith(value).code);
    for (const [, fixture, hash] of BINDING_ARMS) codes.add(refuseWith(fixture, hash).code);
    expect([...codes].sort()).toStrictEqual([...PLAN_AUTHORITY_SUBMISSION_CODES].sort());
  });
});
