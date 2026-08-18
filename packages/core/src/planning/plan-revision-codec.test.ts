import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PLAN_REVISION_APPROVAL_STATES, PLAN_REVISION_CODES, PLAN_REVISION_LAYERS, PLAN_REVISION_LIMITS, PLAN_REVISION_STEP_KINDS, PLAN_REVISION_VERSION } from "./plan-revision-contract.js";
import { createPlanRevision, decodePlanRevisionBytes, derivePlanRevisionDigest, encodePlanRevision, PLAN_REVISION_DIGEST_DOMAIN } from "./plan-revision-codec.js";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hex = (digit: string): string => digit.repeat(64);
const baseDraft = () => ({
  affectedCriterionIds: ["criterion-a"],
  affectedNodeIds: ["node-a"],
  approvalState: "APPROVED",
  authorRef: "principal-a",
  graphBinding: { graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a" },
  parentRevisionId: null as string | null,
  rejectionRef: null as string | null,
  revisionId: "plan-revision-a",
  steps: [
    { description: "Analyse the graph.", kind: "ANALYSIS", stepId: "step-a" },
    { description: "Implement the change.", kind: "IMPLEMENTATION", stepId: "step-b" },
  ],
  verificationRecipeRefs: ["verify-a"],
});
type Draft = ReturnType<typeof baseDraft>;
function createdOrThrow(draft: unknown = baseDraft()) {
  const result = createPlanRevision(draft);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}
function encodedOrThrow(revision: unknown = createdOrThrow()): Uint8Array {
  const result = encodePlanRevision(revision);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.bytes;
}
function refusal(result: { readonly code?: string; readonly layer?: string; readonly ok: boolean }) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  return [result.code, result.layer];
}
function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Reflect.ownKeys(value).every(
    (key) => deeplyFrozen((value as Readonly<Record<PropertyKey, unknown>>)[key]),
  );
}
describe("plan revision contract vocabulary", () => {
  it("pins the closed version, vocabulary, codes and layers", () => {
    expect(PLAN_REVISION_VERSION).toBe("moe-plan-revision/1");
    expect(PLAN_REVISION_STEP_KINDS).toEqual([
      "ANALYSIS", "IMPLEMENTATION", "INTEGRATION", "VERIFICATION", "DOCUMENTATION", "REVIEW",
    ]);
    expect(PLAN_REVISION_APPROVAL_STATES).toEqual([
      "PENDING_APPROVAL", "APPROVED", "REJECTED",
    ]);
    expect(PLAN_REVISION_CODES).toEqual([
      "PLAN_REVISION_MALFORMED", "PLAN_REVISION_VERSION_UNSUPPORTED",
      "PLAN_REVISION_DUPLICATE_ID", "PLAN_REVISION_LIMIT_EXCEEDED",
      "PLAN_REVISION_BYTES_INVALID", "PLAN_REVISION_DUPLICATE_KEY",
      "PLAN_REVISION_NONCANONICAL", "PLAN_REVISION_DIGEST_MISMATCH",
    ]);
    expect(PLAN_REVISION_LAYERS).toEqual([
      "PLAN_REVISION_ADMISSION", "PLAN_REVISION_VERSION", "PLAN_REVISION_LIMITS",
      "PLAN_REVISION_CODEC", "PLAN_REVISION_CANONICALIZATION", "PLAN_REVISION_DIGEST",
    ]);
  });
});
describe("nonempty canonical plan control", () => {
  it("derives its hash, preserves order, detaches, freezes and round-trips", () => {
    const draft = baseDraft();
    const revision = createdOrThrow(draft);
    const derived = derivePlanRevisionDigest(revision);
    expect(derived).toEqual({ ok: true, planHash: revision.planHash });
    expect(revision.steps.map((step: { readonly stepId: string }) => step.stepId))
      .toEqual(["step-a", "step-b"]);
    const detached = structuredClone(revision);
    draft.steps[0]!.description = "caller mutation";
    draft.steps.reverse();
    draft.graphBinding.graphRevisionRef = "caller mutation";
    draft.affectedNodeIds.push("node-z");
    draft.affectedCriterionIds.push("criterion-z");
    draft.verificationRecipeRefs.push("verify-z");
    expect(revision).toEqual(detached);
    expect(deeplyFrozen(revision)).toBe(true);
    const bytes = encodedOrThrow(revision);
    const source = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    delete source["planHash"];
    const digestBytes = encoder.encode(JSON.stringify(source));
    expect(decoder.decode(digestBytes)).toContain(`"version":"${PLAN_REVISION_VERSION}"`);
    expect(revision.planHash).toBe(createHash("sha256")
      .update(PLAN_REVISION_DIGEST_DOMAIN, "utf8").update(Uint8Array.of(0))
      .update(digestBytes).digest("hex"));
    const decoded = decodePlanRevisionBytes(bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected decode");
    expect(decoded.revision).toEqual(revision);
    expect(Array.from(encodedOrThrow(decoded.revision))).toEqual(Array.from(bytes));
    expect(decoder.decode(bytes)).not.toMatch(/"(?:argv|command|effect|environment)"/u);
  });
  it("decodes Buffer and Uint8Array subclasses without consulting Symbol.species", () => {
    class SpeciesTrap extends Uint8Array {
      static get [Symbol.species](): Uint8ArrayConstructor { throw new Error("species read"); }
    }
    for (const bytes of [Buffer.from(encodedOrThrow()), new SpeciesTrap(encodedOrThrow())]) {
      expect(decodePlanRevisionBytes(bytes)).toEqual({ ok: true, revision: createdOrThrow() });
    }
  });
});
type Hostile = readonly [string, () => { readonly ok: boolean }, string, string];
const hostile = (name: string, run: Hostile[1], code: string, layer: string): Hostile =>
  [name, run, code, layer];
const malformed = (name: string, value: () => unknown): Hostile => hostile(
  name, () => createPlanRevision(value()), "PLAN_REVISION_MALFORMED", "PLAN_REVISION_ADMISSION",
);
const limitSteps = (): Draft => {
  const draft = baseDraft();
  draft.steps = Array.from({ length: PLAN_REVISION_LIMITS.maxSteps + 1 }, (_, index) => ({
    description: "bounded", kind: "ANALYSIS", stepId: `step-${String(index).padStart(4, "0")}`,
  }));
  return draft;
};
const overWireDraft = (): Draft => {
  const draft = baseDraft();
  const count = Math.ceil(PLAN_REVISION_LIMITS.maxBytes
    / PLAN_REVISION_LIMITS.maxDescriptionBytes) + 1;
  draft.steps = Array.from({ length: count }, (_, index) => ({
    description: "x".repeat(PLAN_REVISION_LIMITS.maxDescriptionBytes),
    kind: "ANALYSIS", stepId: `wire-${index}`,
  }));
  return draft;
};
const overWireRevision = () => ({
  ...overWireDraft(), planHash: hex("0"), version: PLAN_REVISION_VERSION,
});
const canonicalText = (): string => decoder.decode(encodedOrThrow());
const reorderedCanonicalText = (): string => {
  const parsed = JSON.parse(canonicalText()) as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()));
};
const HOSTILES: readonly Hostile[] = [
  malformed("null", () => null),
  malformed("empty-steps", () => ({ ...baseDraft(), steps: [] })),
  malformed("empty-set", () => ({ ...baseDraft(), affectedNodeIds: [] })),
  malformed("missing", () => { const { authorRef: _removed, ...rest } = baseDraft(); return rest; }),
  malformed("extra", () => ({ ...baseDraft(), command: "run" })),
  malformed("caller-planHash", () => ({ ...baseDraft(), planHash: hex("c") })),
  malformed("accessor", () => Object.defineProperty(baseDraft(), "authorRef", { enumerable: true, get: () => "x" })),
  malformed("symbol", () => Object.defineProperty(baseDraft(), Symbol("x"), { enumerable: true, value: "x" })),
  malformed("proxy", () => new Proxy(baseDraft(), {})),
  malformed("revoked-proxy", () => { const p = Proxy.revocable(baseDraft(), {}); p.revoke(); return p.proxy; }),
  malformed("cyclic", () => { const d = baseDraft(); (d.steps[0] as { description: unknown }).description = d; return d; }),
  malformed("array-exotic", () => { const d = baseDraft(); Object.setPrototypeOf(d.steps, Object.create(Array.prototype)); return d; }),
  malformed("sparse", () => { const d = baseDraft(); d.steps = Array<unknown>(1) as typeof d.steps; return d; }),
  hostile("version", () => encodePlanRevision({ ...createdOrThrow(), version: "moe-plan-revision/2" }), "PLAN_REVISION_VERSION_UNSUPPORTED", "PLAN_REVISION_VERSION"),
  malformed("vocabulary", () => { const d = baseDraft(); d.steps[0]!.kind = "EXECUTE"; return d; }),
  malformed("text", () => { const d = baseDraft(); d.steps[0]!.description = "bad\0text"; return d; }),
  malformed("text-non-nfc", () => { const d = baseDraft(); d.steps[0]!.description = "e\u0301"; return d; }),
  malformed("text-unpaired-surrogate", () => { const d = baseDraft(); d.steps[0]!.description = "\ud800"; return d; }),
  malformed("hash", () => { const d = baseDraft(); d.graphBinding.graphContentHash = "bad"; return d; }),
  malformed("ref", () => ({ ...baseDraft(), authorRef: "" })),
  hostile("duplicate-step", () => { const d = baseDraft(); d.steps[1]!.stepId = "step-a"; return createPlanRevision(d); }, "PLAN_REVISION_DUPLICATE_ID", "PLAN_REVISION_LIMITS"),
  hostile("duplicate-set", () => createPlanRevision({ ...baseDraft(), affectedNodeIds: ["node-a", "node-a"] }), "PLAN_REVISION_DUPLICATE_ID", "PLAN_REVISION_LIMITS"),
  malformed("unsorted-set", () => ({ ...baseDraft(), affectedNodeIds: ["node-b", "node-a"] })),
  hostile("step-limit", () => createPlanRevision(limitSteps()), "PLAN_REVISION_LIMIT_EXCEEDED", "PLAN_REVISION_LIMITS"),
  hostile("set-limit", () => createPlanRevision({ ...baseDraft(), affectedNodeIds: Array.from({ length: PLAN_REVISION_LIMITS.maxSetEntries + 1 }, (_, i) => `node-${String(i).padStart(5, "0")}`) }), "PLAN_REVISION_LIMIT_EXCEEDED", "PLAN_REVISION_LIMITS"),
  hostile("aggregate-limit", () => createPlanRevision({ ...baseDraft(), affectedNodeIds: Array.from({ length: 10_000 }, (_, i) => `n-${String(i).padStart(5, "0")}`), affectedCriterionIds: Array.from({ length: 10_000 }, (_, i) => `c-${String(i).padStart(5, "0")}`) }), "PLAN_REVISION_LIMIT_EXCEEDED", "PLAN_REVISION_LIMITS"),
  hostile("id-byte-limit", () => createPlanRevision({ ...baseDraft(), authorRef: "x".repeat(PLAN_REVISION_LIMITS.maxIdBytes + 1) }), "PLAN_REVISION_LIMIT_EXCEEDED", "PLAN_REVISION_LIMITS"),
  hostile("description-limit", () => { const d = baseDraft(); d.steps[0]!.description = "x".repeat(PLAN_REVISION_LIMITS.maxDescriptionBytes + 1); return createPlanRevision(d); }, "PLAN_REVISION_LIMIT_EXCEEDED", "PLAN_REVISION_LIMITS"),
  hostile("wire-limit-create", () => createPlanRevision(overWireDraft()), "PLAN_REVISION_LIMIT_EXCEEDED", "PLAN_REVISION_LIMITS"),
  hostile("wire-limit-digest", () => derivePlanRevisionDigest(overWireRevision()), "PLAN_REVISION_LIMIT_EXCEEDED", "PLAN_REVISION_LIMITS"),
  hostile("wire-limit-encode", () => encodePlanRevision(overWireRevision()), "PLAN_REVISION_LIMIT_EXCEEDED", "PLAN_REVISION_LIMITS"),
  hostile("bytes-limit", () => decodePlanRevisionBytes(new Uint8Array(PLAN_REVISION_LIMITS.maxBytes + 1)), "PLAN_REVISION_BYTES_INVALID", "PLAN_REVISION_CODEC"),
  hostile("bytes-not-typed", () => decodePlanRevisionBytes("{}"), "PLAN_REVISION_BYTES_INVALID", "PLAN_REVISION_CODEC"),
  hostile("bytes-proxy", () => decodePlanRevisionBytes(new Proxy(encodedOrThrow(), {})), "PLAN_REVISION_BYTES_INVALID", "PLAN_REVISION_CODEC"),
  hostile("bytes-shared", () => decodePlanRevisionBytes(new Uint8Array(new SharedArrayBuffer(8))), "PLAN_REVISION_BYTES_INVALID", "PLAN_REVISION_CODEC"),
  hostile("bytes-detached", () => { const b = encodedOrThrow(); structuredClone(b.buffer, { transfer: [b.buffer as ArrayBuffer] }); return decodePlanRevisionBytes(b); }, "PLAN_REVISION_BYTES_INVALID", "PLAN_REVISION_CODEC"),
  hostile("bad-utf8", () => decodePlanRevisionBytes(Uint8Array.of(0xc3, 0x28)), "PLAN_REVISION_BYTES_INVALID", "PLAN_REVISION_CODEC"),
  hostile("bad-json", () => decodePlanRevisionBytes(encoder.encode("{")), "PLAN_REVISION_BYTES_INVALID", "PLAN_REVISION_CODEC"),
  hostile("duplicate-key", () => decodePlanRevisionBytes(encoder.encode(canonicalText().replace('"revisionId":', '"revisionId":"shadow","revisionId":'))), "PLAN_REVISION_DUPLICATE_KEY", "PLAN_REVISION_CODEC"),
  hostile("noncanonical", () => decodePlanRevisionBytes(encoder.encode(canonicalText().replace("{", "{ "))), "PLAN_REVISION_NONCANONICAL", "PLAN_REVISION_CANONICALIZATION"),
  hostile("noncanonical-key-order", () => decodePlanRevisionBytes(encoder.encode(reorderedCanonicalText())), "PLAN_REVISION_NONCANONICAL", "PLAN_REVISION_CANONICALIZATION"),
  hostile("digest", () => encodePlanRevision({ ...createdOrThrow(), planHash: hex("f") }), "PLAN_REVISION_DIGEST_MISMATCH", "PLAN_REVISION_DIGEST"),
];
describe("hostile admission and codec refusals", () => {
  it("runs the pinned hostile roster", () => {
    expect(HOSTILES.length).toBe(42);
    expect(new Set(HOSTILES.map(([name]) => name)).size).toBe(42);
  });
  it.each(HOSTILES)("pins %s", (_name, run, code, layer) => {
    expect(refusal(run())).toEqual([code, layer]);
  });
  it("rejects an accessor without executing its getter", () => {
    let hits = 0;
    const input = Object.defineProperty(baseDraft(), "authorRef", {
      enumerable: true, get: () => { hits += 1; return "principal-forged"; },
    });
    expect(refusal(createPlanRevision(input))).toEqual([
      "PLAN_REVISION_MALFORMED", "PLAN_REVISION_ADMISSION",
    ]);
    expect(hits).toBe(0);
  });
});
const MUTATIONS: readonly (readonly [string, (draft: Draft) => void])[] = [
  ["revisionId", (d) => { d.revisionId = "plan-revision-b"; }],
  ["parentRevisionId", (d) => { d.parentRevisionId = "plan-revision-parent"; }],
  ["rejectionRef", (d) => { d.rejectionRef = "rejection-a"; }],
  ["authorRef", (d) => { d.authorRef = "principal-b"; }],
  ["graphBinding.graphRevisionRef", (d) => { d.graphBinding.graphRevisionRef = "graph-revision-b"; }],
  ["graphBinding.graphContentHash", (d) => { d.graphBinding.graphContentHash = hex("b"); }],
  ["approvalState", (d) => { d.approvalState = "REJECTED"; }],
  ["steps.order", (d) => { d.steps = [d.steps[1]!, d.steps[0]!]; }],
  ["steps.stepId", (d) => { d.steps[0]!.stepId = "step-z"; }],
  ["steps.kind", (d) => { d.steps[0]!.kind = "REVIEW"; }],
  ["steps.description", (d) => { d.steps[0]!.description = "Analyse twice."; }],
  ["affectedNodeIds", (d) => { d.affectedNodeIds = ["node-a", "node-b"]; }],
  ["affectedCriterionIds", (d) => { d.affectedCriterionIds = ["criterion-a", "criterion-b"]; }],
  ["verificationRecipeRefs", (d) => { d.verificationRecipeRefs = ["verify-a", "verify-b"]; }],
];
describe("authoritative-field digest sweep", () => {
  it("pins every mutable digest-source field by name", () => {
    expect(MUTATIONS.map(([name]) => name)).toEqual([
      "revisionId", "parentRevisionId", "rejectionRef", "authorRef",
      "graphBinding.graphRevisionRef", "graphBinding.graphContentHash", "approvalState",
      "steps.order", "steps.stepId", "steps.kind", "steps.description",
      "affectedNodeIds", "affectedCriterionIds", "verificationRecipeRefs",
    ]);
  });
  it.each(MUTATIONS)("binds %s", (_name, change) => {
    const baseline = createdOrThrow();
    const draft = baseDraft();
    change(draft);
    const mutated = createdOrThrow(draft);
    expect(mutated.planHash).not.toBe(baseline.planHash);
    expect(refusal(encodePlanRevision({ ...mutated, planHash: baseline.planHash }))).toEqual([
      "PLAN_REVISION_DIGEST_MISMATCH", "PLAN_REVISION_DIGEST",
    ]);
    const forged = decoder.decode(encodedOrThrow(mutated))
      .replace(mutated.planHash, baseline.planHash);
    expect(refusal(decodePlanRevisionBytes(encoder.encode(forged)))).toEqual([
      "PLAN_REVISION_DIGEST_MISMATCH", "PLAN_REVISION_DIGEST",
    ]);
  });
});
