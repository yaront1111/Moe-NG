import { describe, expect, it } from "vitest";

import {
  createPlannerAdmissionProfileRevision,
  decodePlannerAdmissionProfileRevisionBytes,
  encodePlannerAdmissionProfileRevision,
} from "./planner-admission-profile-codec.js";
import {
  PLANNER_ADMISSION_PROFILE_CODES,
  PLANNER_ADMISSION_PROFILE_DIGEST_DOMAIN,
  PLANNER_ADMISSION_PROFILE_LIMITS,
  PLANNER_ADMISSION_PROFILE_VERSION,
} from "./planner-admission-profile-contract.js";
import { mapPlannerAdmissionProfileRevision } from "./planner-admission-profile-mapping.js";

const PURPOSES = Object.freeze([
  "CONTINGENCY", "EXECUTION", "FINAL_ACCEPTANCE", "INDEPENDENT_REVIEW", "VERIFICATION",
] as const);
type Purpose = (typeof PURPOSES)[number];
type BudgetKind = "COMPUTE" | "MONEY" | "TIME" | "TOKEN";
type AuthorityKind = "BUILDER" | "VERIFIER";

interface BudgetFixture {
  budgetId: string;
  kind: BudgetKind;
  limit: number;
  unit: string;
}

interface ConversionFixture {
  authorityRef: string;
  denominator: number;
  numerator: number;
  targetMeter: string;
}

interface AllocationFixture {
  conversion: ConversionFixture;
  purposeQuantities: { purpose: Purpose; quantity: number }[];
  sourceBudget: BudgetFixture;
}

interface DraftFixture {
  admissionGatePolicy: string;
  allocationDecisionRef: string;
  allocationSemantics: string;
  authorRef: string;
  authorityKind: AuthorityKind;
  budgetAllocations: AllocationFixture[];
  budgetBindingDigest: string;
  contractBinding: { contractId: string; revisionDigest: string; revisionId: string };
  graphId: string;
  graphSnapshotIdentity: string;
  nodeIntentDigest: string;
  nodeKey: string;
  policyRevision: string;
  profileId: string;
  revisionId: string;
}

interface MappingExpectationFixture {
  authorityKind: AuthorityKind;
  budgetBindingDigest: string;
  budgetBindings: BudgetFixture[];
  contractBinding: DraftFixture["contractBinding"];
  graphId: string;
  graphSnapshotIdentity: string;
  nodeIntentDigest: string;
  nodeKey: string;
  policyRevision: string;
}

const hex = (digit: string): string => digit.repeat(64);
const budgetBindingDigest = (digit: string): string =>
  `moe.v2.budget-bindings.sha256:${hex(digit)}`;
const refusal = (code: string, layer: string) => ({ code, layer, ok: false as const });

function purposeQuantities(quantity = 3_000): AllocationFixture["purposeQuantities"] {
  return PURPOSES.map((purpose) => ({ purpose, quantity }));
}

function allocation(patch: {
  conversion?: Partial<ConversionFixture>;
  purposeQuantities?: AllocationFixture["purposeQuantities"];
  sourceBudget?: Partial<BudgetFixture>;
} = {}): AllocationFixture {
  return {
    conversion: {
      authorityRef: "policy:time-seconds-to-runner-ms-r1",
      denominator: 1,
      numerator: 1_000,
      targetMeter: "runner.authorized_ms",
      ...patch.conversion,
    },
    purposeQuantities: patch.purposeQuantities?.map((item) => ({ ...item }))
      ?? purposeQuantities(),
    sourceBudget: {
      budgetId: "budget-time-a", kind: "TIME", limit: 15, unit: "seconds",
      ...patch.sourceBudget,
    },
  };
}

function draft(patch: Partial<DraftFixture> = {}): DraftFixture {
  return {
    admissionGatePolicy: "POLICY_ALLOWANCE",
    allocationDecisionRef: "approval:planner-admission-profile-build-r1",
    allocationSemantics: "SINGLE_ADMISSION_FULL_ENVELOPE",
    authorRef: "principal:planner-admission-authority",
    authorityKind: "BUILDER",
    budgetAllocations: [allocation()],
    budgetBindingDigest: budgetBindingDigest("b"),
    contractBinding: {
      contractId: "contract-v2", revisionDigest: hex("a"), revisionId: "contract-v2-r1",
    },
    graphId: "graph-v2-r1",
    graphSnapshotIdentity: hex("c"),
    nodeIntentDigest: hex("d"),
    nodeKey: "node-build",
    policyRevision: hex("e"),
    profileId: "planner-admission-profile-build",
    revisionId: "planner-admission-profile-build-r1",
    ...patch,
  };
}

function created(value: unknown = draft()) {
  const result = createPlannerAdmissionProfileRevision(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

function encodedBytes(revision = created()): Uint8Array {
  const result = encodePlannerAdmissionProfileRevision(revision);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.bytes;
}

function expectation(
  revision: ReturnType<typeof created>,
  patch: Partial<MappingExpectationFixture> = {},
): MappingExpectationFixture {
  return {
    authorityKind: revision.authorityKind,
    budgetBindingDigest: revision.budgetBindingDigest,
    budgetBindings: revision.budgetAllocations.map((item) => ({ ...item.sourceBudget })),
    contractBinding: { ...revision.contractBinding },
    graphId: revision.graphId,
    graphSnapshotIdentity: revision.graphSnapshotIdentity,
    nodeIntentDigest: revision.nodeIntentDigest,
    nodeKey: revision.nodeKey,
    policyRevision: revision.policyRevision,
    ...patch,
  };
}

describe("PlannerAdmissionProfileRevision contract and codec", () => {
  it("publishes the versioned domain, exact refusal vocabulary, and Product-aligned bound", () => {
    expect(PLANNER_ADMISSION_PROFILE_VERSION)
      .toBe("moe-planner-admission-profile-revision/1");
    expect(PLANNER_ADMISSION_PROFILE_DIGEST_DOMAIN)
      .toBe("moe-planner-admission-profile-revision-digest/1");
    expect(PLANNER_ADMISSION_PROFILE_CODES).toEqual([
      "PLANNER_ADMISSION_PROFILE_MALFORMED",
      "PLANNER_ADMISSION_PROFILE_VERSION_UNSUPPORTED",
      "PLANNER_ADMISSION_PROFILE_LIMIT_EXCEEDED",
      "PLANNER_ADMISSION_PROFILE_BYTES_INVALID",
      "PLANNER_ADMISSION_PROFILE_DUPLICATE_KEY",
      "PLANNER_ADMISSION_PROFILE_NONCANONICAL",
      "PLANNER_ADMISSION_PROFILE_DIGEST_MISMATCH",
      "PLANNER_ADMISSION_PROFILE_BINDING_MISMATCH",
      "PLANNER_ADMISSION_PROFILE_BUDGET_KIND_UNSUPPORTED",
      "PLANNER_ADMISSION_PROFILE_PROVIDER_METER_FORBIDDEN",
      "PLANNER_ADMISSION_PROFILE_MAPPING_ABSENT",
      "PLANNER_ADMISSION_PROFILE_MAPPING_AMBIGUOUS",
      "PLANNER_ADMISSION_PROFILE_MAPPING_NONINTEGRAL",
      "PLANNER_ADMISSION_PROFILE_MAPPING_OVERFLOW",
      "PLANNER_ADMISSION_PROFILE_ALLOCATION_INCOMPLETE",
      "PLANNER_ADMISSION_PROFILE_ALLOCATION_TOTAL_MISMATCH",
      "PLANNER_ADMISSION_PROFILE_GATE_POLICY_INVALID",
    ]);
    expect(PLANNER_ADMISSION_PROFILE_LIMITS.maxAllocations).toBe(64);
  });

  it("round-trips canonical bytes as a deeply immutable revision", () => {
    const revision = created();
    const bytes = encodedBytes(revision);
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(revision));
    expect(decodePlannerAdmissionProfileRevisionBytes(bytes)).toEqual({ ok: true, revision });
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision.budgetAllocations[0]?.conversion)).toBe(true);
  });

  it("copies Buffer bytes and refuses shared storage or accessor-backed drafts", () => {
    const revision = created();
    expect(decodePlannerAdmissionProfileRevisionBytes(Buffer.from(encodedBytes(revision))))
      .toEqual({ ok: true, revision });
    expect(decodePlannerAdmissionProfileRevisionBytes(
      new Uint8Array(new SharedArrayBuffer(16)),
    )).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_BYTES_INVALID", "PLANNER_ADMISSION_PROFILE_CODEC",
    ));
    let reads = 0;
    const hostile = { ...draft() };
    Object.defineProperty(hostile, "authorRef", { enumerable: true, get: () => {
      reads += 1; return "principal:hostile";
    } });
    expect(createPlannerAdmissionProfileRevision(hostile)).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_MALFORMED", "PLANNER_ADMISSION_PROFILE_ADMISSION",
    ));
    expect(reads).toBe(0);
  });

  it("digest-binds compiler provenance, authors, units, conversion authority, and allocation", () => {
    const baseline = created();
    const redistributed = purposeQuantities();
    redistributed[0] = { ...redistributed[0]!, quantity: 2_999 };
    redistributed[1] = { ...redistributed[1]!, quantity: 3_001 };
    const mutations = [
      draft({ allocationDecisionRef: "approval:planner-admission-profile-build-r2" }),
      draft({ authorRef: "principal:changed" }),
      draft({ budgetBindingDigest: budgetBindingDigest("1") }),
      draft({ graphSnapshotIdentity: hex("2") }),
      draft({ nodeIntentDigest: hex("3") }),
      draft({ policyRevision: hex("4") }),
      draft({ budgetAllocations: [allocation({ sourceBudget: { unit: "s" } })] }),
      draft({ budgetAllocations: [allocation({
        conversion: { authorityRef: "policy:time-seconds-to-runner-ms-r2" },
      })] }),
      draft({ budgetAllocations: [allocation({ purposeQuantities: redistributed })] }),
    ];
    const changed = mutations.map((value) => created(value).revisionDigest);
    expect(changed.every((digest) => digest !== baseline.revisionDigest)).toBe(true);
    expect(new Set(changed).size).toBe(changed.length);
  });

  it("refuses unsupported versions, duplicate keys, noncanonical bytes, and digest mutation", () => {
    const revision = created();
    expect(encodePlannerAdmissionProfileRevision({
      ...revision, version: "moe-planner-admission-profile-revision/2",
    })).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_VERSION_UNSUPPORTED", "PLANNER_ADMISSION_PROFILE_VERSION",
    ));
    expect(decodePlannerAdmissionProfileRevisionBytes(new TextEncoder().encode(
      '{"profileId":"a","profileId":"b"}',
    ))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_DUPLICATE_KEY", "PLANNER_ADMISSION_PROFILE_CODEC",
    ));
    const text = new TextDecoder().decode(encodedBytes(revision));
    expect(decodePlannerAdmissionProfileRevisionBytes(new TextEncoder().encode(` ${text}`)))
      .toEqual(refusal(
        "PLANNER_ADMISSION_PROFILE_NONCANONICAL",
        "PLANNER_ADMISSION_PROFILE_CANONICALIZATION",
      ));
    expect(decodePlannerAdmissionProfileRevisionBytes(new TextEncoder().encode(
      text.replace(revision.revisionDigest, hex("f")),
    ))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_DIGEST_MISMATCH", "PLANNER_ADMISSION_PROFILE_DIGEST",
    ));
    expect(decodePlannerAdmissionProfileRevisionBytes(Uint8Array.of(0xff))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_BYTES_INVALID", "PLANNER_ADMISSION_PROFILE_CODEC",
    ));
  });

  it("enforces the profile byte cap before parsing valid or malformed JSON", () => {
    const overbound = [
      new TextEncoder().encode(" ".repeat(PLANNER_ADMISSION_PROFILE_LIMITS.maxBytes + 1)),
      new TextEncoder().encode(JSON.stringify(
        "x".repeat(PLANNER_ADMISSION_PROFILE_LIMITS.maxBytes),
      )),
    ];
    for (const bytes of overbound) expect(
      decodePlannerAdmissionProfileRevisionBytes(bytes),
    ).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_LIMIT_EXCEEDED", "PLANNER_ADMISSION_PROFILE_LIMITS",
    ));
  });

  it("refuses a structural allocation roster beyond Product Contract's 64-budget bound", () => {
    const budgetAllocations = Array.from(
      { length: PLANNER_ADMISSION_PROFILE_LIMITS.maxAllocations + 1 },
      (_, index) => allocation({
        conversion: { numerator: 1 },
        purposeQuantities: purposeQuantities(1),
        sourceBudget: { budgetId: `budget-time-${String(index).padStart(2, "0")}`, limit: 5 },
      }),
    );
    expect(createPlannerAdmissionProfileRevision(draft({ budgetAllocations }))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_LIMIT_EXCEEDED", "PLANNER_ADMISSION_PROFILE_LIMITS",
    ));
  });

  it("normalizes equivalent allocation order and reduced rational spelling", () => {
    const first = allocation({ conversion: { denominator: 2, numerator: 2_000 } });
    const second = allocation({
      purposeQuantities: purposeQuantities(1_000),
      sourceBudget: { budgetId: "budget-time-b", limit: 5 },
    });
    const left = created(draft({ budgetAllocations: [second, first] }));
    const right = created(draft({ budgetAllocations: [
      { ...first, conversion: { ...first.conversion, denominator: 1, numerator: 1_000 } },
      second,
    ] }));
    expect(left).toEqual(right);
    expect(left.budgetAllocations[0]?.conversion).toMatchObject({
      denominator: 1, numerator: 1_000,
    });
    expect(encodedBytes(left)).toEqual(encodedBytes(right));
  });

  it("admits all 64 Product budgets and still emits five aggregated pairs", () => {
    const budgetAllocations = Array.from({ length: 64 }, (_, index) => allocation({
      conversion: { numerator: 1 },
      purposeQuantities: purposeQuantities(1),
      sourceBudget: { budgetId: `budget-time-${String(index).padStart(2, "0")}`, limit: 5 },
    }));
    const revision = created(draft({ budgetAllocations }));
    const mapped = mapPlannerAdmissionProfileRevision(revision, expectation(revision));
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.authority.admissionAmounts).toEqual(PURPOSES.map((purpose) => ({
      meter: "runner.authorized_ms", purpose, quantity: 64,
    })));
  });
});

describe("PlannerAdmissionProfileRevision intrinsic allocation policy", () => {
  it.each(["MONEY", "TOKEN"] as const)("refuses unsupported %s source budgets", (kind) => {
    expect(createPlannerAdmissionProfileRevision(draft({
      budgetAllocations: [allocation({ sourceBudget: { kind } })],
    }))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_BUDGET_KIND_UNSUPPORTED",
      "PLANNER_ADMISSION_PROFILE_MAPPING",
    ));
  });

  it.each([
    "provider.cache_creation_input_tokens",
    "provider.cache_read_input_tokens",
    "provider.input_tokens",
    "provider.output_tokens",
  ])("forbids provider-owned meter %s", (targetMeter) => {
    expect(createPlannerAdmissionProfileRevision(draft({
      budgetAllocations: [allocation({ conversion: { targetMeter } })],
    }))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_PROVIDER_METER_FORBIDDEN",
      "PLANNER_ADMISSION_PROFILE_MAPPING",
    ));
  });

  it.each([
    ["wrong authority", draft({ authorityKind: "VERIFIER" })],
    ["wrong meter", draft({ budgetAllocations: [allocation({
      conversion: { targetMeter: "attempt.count" },
    })] })],
  ])("refuses an otherwise valid TIME mapping with %s", (_name, value) => {
    expect(createPlannerAdmissionProfileRevision(value)).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_MAPPING_ABSENT", "PLANNER_ADMISSION_PROFILE_MAPPING",
    ));
  });

  it("refuses duplicate source-budget identity as ambiguous", () => {
    expect(createPlannerAdmissionProfileRevision(draft({
      budgetAllocations: [allocation(), allocation()],
    }))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_MAPPING_AMBIGUOUS", "PLANNER_ADMISSION_PROFILE_MAPPING",
    ));
  });

  it("requires positive integral conversion structure and explicit authority provenance", () => {
    const invalid = [
      draft({ authorRef: "" }),
      draft({ allocationDecisionRef: "" }),
      draft({ budgetBindingDigest: "budget-bindings:unsealed" }),
      draft({ budgetAllocations: [allocation({ conversion: { authorityRef: "" } })] }),
      draft({ budgetAllocations: [allocation({ conversion: { numerator: 0 } })] }),
      draft({ budgetAllocations: [allocation({ conversion: { denominator: 0 } })] }),
      draft({ budgetAllocations: [allocation({ conversion: { numerator: 1.5 } })] }),
    ];
    for (const value of invalid) {
      expect(createPlannerAdmissionProfileRevision(value)).toEqual(refusal(
        "PLANNER_ADMISSION_PROFILE_MALFORMED", "PLANNER_ADMISSION_PROFILE_ADMISSION",
      ));
    }
  });

  it("gives structural limits precedence over malformed rows independent of allocation order", () => {
    const overlimit = allocation({ purposeQuantities: [
      ...purposeQuantities(), { purpose: "EXECUTION", quantity: 1 },
    ], sourceBudget: { budgetId: "budget-overlimit" } });
    const malformed = allocation({ conversion: { numerator: 0 },
      sourceBudget: { budgetId: "budget-malformed" } });
    for (const budgetAllocations of [[overlimit, malformed], [malformed, overlimit]]) {
      expect(createPlannerAdmissionProfileRevision(draft({ budgetAllocations }))).toEqual(refusal(
        "PLANNER_ADMISSION_PROFILE_LIMIT_EXCEEDED", "PLANNER_ADMISSION_PROFILE_LIMITS",
      ));
    }
  });

  it("distinguishes nonintegral conversion from per-allocation overflow", () => {
    expect(createPlannerAdmissionProfileRevision(draft({ budgetAllocations: [allocation({
      conversion: { denominator: 2, numerator: 1 },
      purposeQuantities: purposeQuantities(1),
      sourceBudget: { limit: 5 },
    })] }))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_MAPPING_NONINTEGRAL", "PLANNER_ADMISSION_PROFILE_MAPPING",
    ));
    expect(createPlannerAdmissionProfileRevision(draft({ budgetAllocations: [allocation({
      conversion: { numerator: 2 },
      purposeQuantities: purposeQuantities(1),
      sourceBudget: { limit: Number.MAX_SAFE_INTEGER },
    })] }))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_MAPPING_OVERFLOW", "PLANNER_ADMISSION_PROFILE_MAPPING",
    ));
  });

  it("gives nonintegral conversion precedence over overflow independent of budget identity", () => {
    for (const reverseFaultIds of [false, true]) {
      const nonintegral = allocation({ conversion: { denominator: 2, numerator: 1 },
        purposeQuantities: purposeQuantities(1), sourceBudget: {
          budgetId: reverseFaultIds ? "budget-z" : "budget-a", limit: 5,
        } });
      const overflow = allocation({ conversion: { numerator: 2 },
        purposeQuantities: purposeQuantities(1), sourceBudget: {
          budgetId: reverseFaultIds ? "budget-a" : "budget-z", limit: Number.MAX_SAFE_INTEGER,
        } });
      expect(createPlannerAdmissionProfileRevision(draft({
        budgetAllocations: [overflow, nonintegral],
      }))).toEqual(refusal(
        "PLANNER_ADMISSION_PROFILE_MAPPING_NONINTEGRAL",
        "PLANNER_ADMISSION_PROFILE_MAPPING",
      ));
    }
  });

  it("detects overflow while aggregating distinct budgets onto one purpose/meter line", () => {
    const almostMax = purposeQuantities(1);
    almostMax[0] = { ...almostMax[0]!, quantity: Number.MAX_SAFE_INTEGER - 4 };
    const plusTen = purposeQuantities(1);
    plusTen[0] = { ...plusTen[0]!, quantity: 6 };
    expect(createPlannerAdmissionProfileRevision(draft({ budgetAllocations: [
      allocation({ conversion: { numerator: 1 }, purposeQuantities: almostMax,
        sourceBudget: { budgetId: "budget-time-max", limit: Number.MAX_SAFE_INTEGER } }),
      allocation({ conversion: { numerator: 1 }, purposeQuantities: plusTen,
        sourceBudget: { budgetId: "budget-time-ten", limit: 10 } }),
    ] }))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_MAPPING_OVERFLOW", "PLANNER_ADMISSION_PROFILE_MAPPING",
    ));
  });

  it("requires each of the five scheduler purposes exactly once with positive quantity", () => {
    const complete = purposeQuantities();
    const invalid = [
      complete.slice(0, -1),
      [...complete.slice(0, -1), { ...complete[0]! }],
      complete.map((item, index) => index === 0 ? { ...item, quantity: 0 } : item),
    ];
    for (const purposeQuantities of invalid) {
      expect(createPlannerAdmissionProfileRevision(draft({
        budgetAllocations: [allocation({ purposeQuantities })],
      }))).toEqual(refusal(
        "PLANNER_ADMISSION_PROFILE_ALLOCATION_INCOMPLETE",
        "PLANNER_ADMISSION_PROFILE_ALLOCATION",
      ));
    }
  });

  it("requires purpose quantities to total the converted source limit", () => {
    const quantities = purposeQuantities();
    quantities[0] = { ...quantities[0]!, quantity: quantities[0]!.quantity + 1 };
    expect(createPlannerAdmissionProfileRevision(draft({
      budgetAllocations: [allocation({ purposeQuantities: quantities })],
    }))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_ALLOCATION_TOTAL_MISMATCH",
      "PLANNER_ADMISSION_PROFILE_ALLOCATION",
    ));
  });

  it("refuses gate policy outside the Scheduler's closed vocabulary", () => {
    expect(createPlannerAdmissionProfileRevision(draft({
      admissionGatePolicy: "EMBEDDED_APPROVAL",
    }))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_GATE_POLICY_INVALID",
      "PLANNER_ADMISSION_PROFILE_ADMISSION",
    ));
  });

  it("pins the conservative full-envelope single-admission semantics", () => {
    expect(createPlannerAdmissionProfileRevision(draft({
      allocationSemantics: "PER_ATTEMPT_INCREMENTAL",
    }))).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_MALFORMED", "PLANNER_ADMISSION_PROFILE_ADMISSION",
    ));
  });
});

describe("PlannerAdmissionProfileRevision mapping", () => {
  it.each([
    ["BUILDER", "TIME", "runner.authorized_ms"],
    ["VERIFIER", "TIME", "verification.authorized_ms"],
    ["BUILDER", "COMPUTE", "attempt.count"],
    ["VERIFIER", "COMPUTE", "attempt.count"],
  ] as const)("maps %s %s only onto %s", (authorityKind, kind, targetMeter) => {
    const value = draft({ authorityKind, budgetAllocations: [allocation({
      conversion: { numerator: 1, targetMeter }, purposeQuantities: purposeQuantities(1),
      sourceBudget: { kind, limit: 5 },
    })] });
    const revision = created(value);
    const mapped = mapPlannerAdmissionProfileRevision(revision, expectation(revision));
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.authority.admissionAmounts).toEqual(PURPOSES.map((purpose) => ({
      meter: targetMeter, purpose, quantity: 1,
    })));
  });

  it("sorts mixed TIME and COMPUTE aggregates by the Scheduler pair key", () => {
    const revision = created(draft({ budgetAllocations: [
      allocation({ conversion: { numerator: 1 }, purposeQuantities: purposeQuantities(1),
        sourceBudget: { limit: 5 } }),
      allocation({ conversion: { numerator: 1, targetMeter: "attempt.count" },
        purposeQuantities: purposeQuantities(1), sourceBudget: {
          budgetId: "budget-compute", kind: "COMPUTE", limit: 5, unit: "attempts",
        } }),
    ] }));
    const mapped = mapPlannerAdmissionProfileRevision(revision, expectation(revision));
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.authority.admissionAmounts).toEqual(PURPOSES.flatMap((purpose) => [
      { meter: "attempt.count", purpose, quantity: 1 },
      { meter: "runner.authorized_ms", purpose, quantity: 1 },
    ]));
  });

  it("accepts an exact MAX_SAFE aggregate without converting early to Number", () => {
    const quantities = purposeQuantities(1);
    quantities[0] = { ...quantities[0]!, quantity: Number.MAX_SAFE_INTEGER - 4 };
    const revision = created(draft({ budgetAllocations: [allocation({
      conversion: { numerator: 1 }, purposeQuantities: quantities,
      sourceBudget: { limit: Number.MAX_SAFE_INTEGER },
    })] }));
    const mapped = mapPlannerAdmissionProfileRevision(revision, expectation(revision));
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.authority.admissionAmounts[0]?.quantity).toBe(Number.MAX_SAFE_INTEGER - 4);
  });

  it("aggregates distinct budgets into exact sorted five-line Scheduler authority", () => {
    const revision = created(draft({ budgetAllocations: [
      allocation(),
      allocation({
        purposeQuantities: purposeQuantities(1_000),
        sourceBudget: { budgetId: "budget-time-b", limit: 5 },
      }),
    ] }));
    expect(mapPlannerAdmissionProfileRevision(revision, expectation(revision))).toEqual({
      authority: {
        admissionAmounts: PURPOSES.map((purpose) => ({
          meter: "runner.authorized_ms", purpose, quantity: 4_000,
        })),
        admissionGatePolicy: "POLICY_ALLOWANCE",
      },
      ok: true,
      profileBinding: {
        nodeKey: revision.nodeKey,
        profileId: revision.profileId,
        revisionDigest: revision.revisionDigest,
        revisionId: revision.revisionId,
        version: PLANNER_ADMISSION_PROFILE_VERSION,
      },
    });
  });

  it("refuses every changed external immutable or compiler provenance binding", () => {
    const revision = created();
    const base = expectation(revision);
    const mismatches: MappingExpectationFixture[] = [
      { ...base, contractBinding: { ...base.contractBinding, contractId: "contract-other" } },
      { ...base, contractBinding: { ...base.contractBinding, revisionDigest: hex("1") } },
      { ...base, contractBinding: { ...base.contractBinding, revisionId: "contract-v2-r2" } },
      { ...base, graphId: "graph-v2-r2" },
      { ...base, nodeKey: "node-verify" },
      { ...base, authorityKind: "VERIFIER" },
      { ...base, policyRevision: hex("2") },
      { ...base, budgetBindingDigest: budgetBindingDigest("3") },
      { ...base, graphSnapshotIdentity: hex("4") },
      { ...base, nodeIntentDigest: hex("5") },
      { ...base, budgetBindings: [{ ...base.budgetBindings[0]!, limit: 16 }] },
      { ...base, budgetBindings: [{ ...base.budgetBindings[0]!, kind: "COMPUTE" }] },
      { ...base, budgetBindings: [{ ...base.budgetBindings[0]!, unit: "milliseconds" }] },
    ];
    for (const candidate of mismatches) {
      expect(mapPlannerAdmissionProfileRevision(revision, candidate)).toEqual(refusal(
        "PLANNER_ADMISSION_PROFILE_BINDING_MISMATCH",
        "PLANNER_ADMISSION_PROFILE_BINDING",
      ));
    }
  });

  it("refuses a bound source budget with no profile allocation", () => {
    const revision = created();
    const base = expectation(revision);
    expect(mapPlannerAdmissionProfileRevision(revision, {
      ...base,
      budgetBindings: [...base.budgetBindings, {
        budgetId: "budget-time-unallocated", kind: "TIME", limit: 5, unit: "seconds",
      }],
    })).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_MAPPING_ABSENT", "PLANNER_ADMISSION_PROFILE_MAPPING",
    ));
  });

  it("refuses an external budget roster above the profile allocation bound", () => {
    const revision = created();
    const base = expectation(revision);
    let reads = 0;
    const budgetBindings = Array.from(
      { length: PLANNER_ADMISSION_PROFILE_LIMITS.maxAllocations + 1 },
      (_, index) => ({
        ...base.budgetBindings[0]!,
        budgetId: `budget-time-${String(index).padStart(2, "0")}`,
      }),
    );
    Object.defineProperty(budgetBindings[0], "unit", { enumerable: true, get: () => {
      reads += 1; return "seconds";
    } });
    expect(mapPlannerAdmissionProfileRevision(revision, {
      ...base,
      budgetBindings,
    })).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_LIMIT_EXCEEDED", "PLANNER_ADMISSION_PROFILE_LIMITS",
    ));
    expect(reads).toBe(0);
  });

  it("requires bounded NFC external binding text before comparison", () => {
    const revision = created();
    const base = expectation(revision);
    const hostile: MappingExpectationFixture[] = [
      { ...base, graphId: "x".repeat(PLANNER_ADMISSION_PROFILE_LIMITS.maxIdBytes + 1) },
      { ...base, contractBinding: { ...base.contractBinding, contractId: "e\u0301" } },
      { ...base, budgetBindings: [{ ...base.budgetBindings[0]!, unit: "e\u0301" }] },
    ];
    for (const candidate of hostile) {
      expect(mapPlannerAdmissionProfileRevision(revision, candidate)).toEqual(refusal(
        "PLANNER_ADMISSION_PROFILE_BINDING_MISMATCH",
        "PLANNER_ADMISSION_PROFILE_BINDING",
      ));
    }
  });

  it("does not invoke accessor-backed external binding authority", () => {
    const revision = created(); let reads = 0;
    const hostile = { ...expectation(revision) };
    Object.defineProperty(hostile, "graphId", { enumerable: true, get: () => {
      reads += 1; return revision.graphId;
    } });
    expect(mapPlannerAdmissionProfileRevision(revision, hostile)).toEqual(refusal(
      "PLANNER_ADMISSION_PROFILE_BINDING_MISMATCH", "PLANNER_ADMISSION_PROFILE_BINDING",
    ));
    expect(reads).toBe(0);
  });
});
