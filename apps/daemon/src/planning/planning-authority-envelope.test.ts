/**
 * The daemon-owned planning-authority envelope: the versioned payload that carries the CANONICAL
 * plan-revision and acceptance-contract BODIES together with the run's sealed planning
 * evidence, so a later approval reads content instead of the hash/ref-only `PlanProposed` body
 * (`planning-services.ts:117-127`).
 *
 * Two refusal vocabularies can answer here and every arm asserts WHICH one did. The core
 * codecs own body admission, canonicalization and digest (`PLAN_REVISION_*`,
 * `ACCEPTANCE_CONTRACT_*`); this module owns only the envelope shell and the cross-bindings
 * between the two bodies and the reducer's sealed submission. A restamped core refusal is a
 * defect, not a convenience — `planning-run-submission.ts` codes/layers pass through verbatim.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAcceptanceContract,
  createPlanRevision,
  deriveAcceptanceContractDigest,
  derivePlanRevisionDigest,
  reducePlanningRun,
} from "@moe/core";
import type {
  AcceptanceContract,
  PlanRevision,
  PlanningRunCommand,
  PlanningRunState,
} from "@moe/core";
import { describe, expect, it } from "vitest";

import {
  admitPlanningAuthorityEnvelope,
  decodePlanningAuthorityEnvelopeBytes,
  encodePlanningAuthorityEnvelope,
  PLANNING_AUTHORITY_ENVELOPE_CODES,
  PLANNING_AUTHORITY_ENVELOPE_LIMITS,
  PLANNING_AUTHORITY_ENVELOPE_VERSION,
} from "./planning-authority-envelope.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** BOTH production halves, or the structural forbidden-source proof only covers one of them. */
const MODULE_SOURCE = ["planning-authority-envelope.ts", "planning-authority-envelope-contract.ts"]
  .map((name) => readFileSync(join(MODULE_DIR, name), "utf8")).join("\n");
const ENVELOPE_LAYER = "PLANNING_AUTHORITY_ENVELOPE";
const TRUTH = "DAEMON_VERIFIED" as const;
const PROJECT_ID = "proj-authority-envelope";
const GOAL_REF = "goal-authority-envelope";
const RUN_ID = "run-authority-envelope";
const GRAPH_REVISION_REF = "graph-revision-authority-envelope";

const hex = (seed: string): string => createHash("sha256").update(seed, "utf8").digest("hex");

/** Distinct from every other digest in the fixture, and never a real body digest. */
const FOREIGN_HEX = hex("foreign-digest");

interface Fixture {
  readonly contract: AcceptanceContract;
  readonly revision: PlanRevision;
  readonly state: PlanningRunState;
}

function reduceOrThrow(state: PlanningRunState | undefined, command: unknown): PlanningRunState {
  const result = reducePlanningRun(state, command as PlanningRunCommand);
  if (!result.ok) {
    throw new Error(`planning reducer refused the fixture chain: ${JSON.stringify(result)}`);
  }
  return result.state;
}

function buildContract(criterionIds: readonly string[], statement?: string): AcceptanceContract {
  const result = createAcceptanceContract({
    applicability: {
      graphContentHash: hex("graph-content"), graphRevisionRef: GRAPH_REVISION_REF,
      nodeIds: ["node-a"], nodeKind: "LEAF",
    },
    authorRef: "architect-authority-envelope",
    contractId: "contract-authority-envelope",
    obligations: criterionIds.map((criterionId) => ({
      criterionId,
      evidenceRequirements: [
        { evidenceRef: `evidence-${criterionId}`, kind: "VERIFICATION_RECEIPT",
          requirementId: `requirement-${criterionId}` },
      ],
      statement: statement ?? `the run satisfies ${criterionId}`,
      verificationRecipeRefs: [`recipe-${criterionId}`],
    })),
  });
  if (!result.ok) throw new Error(`acceptance contract fixture refused: ${result.code}`);
  return result.contract;
}

function buildRevision(
  criterionIds: readonly string[], description?: string, stepCount = 1,
): PlanRevision {
  const result = createPlanRevision({
    affectedCriterionIds: [...criterionIds].sort(),
    affectedNodeIds: ["node-a"],
    approvalState: "PENDING_APPROVAL",
    authorRef: "architect-authority-envelope",
    graphBinding: { graphContentHash: hex("graph-content"), graphRevisionRef: GRAPH_REVISION_REF },
    parentRevisionId: null,
    rejectionRef: null,
    revisionId: "revision-authority-envelope",
    steps: Array.from({ length: stepCount }, (_unused, index) => ({
      description: description ?? "seal the planning authority",
      kind: "ANALYSIS", stepId: `step-${String(index).padStart(5, "0")}`,
    })),
    verificationRecipeRefs: ["recipe-gate"],
  });
  if (!result.ok) throw new Error(`plan revision fixture refused: ${result.code}`);
  return result.revision;
}

/**
 * The sealed run is produced by the CORE reducer's own transitions
 * (create_draft -> ready -> claim -> propose -> finalize), never hand-shaped: the envelope's
 * submission record has to bind to what `finalize` actually wrote, or the binding proves nothing.
 */
function buildFixture(
  criterionIds: readonly string[] = ["criterion-a", "criterion-b"], bulk?: string,
): Fixture {
  const contract = buildContract(criterionIds, bulk);
  const revision = buildRevision(criterionIds, bulk, bulk === undefined ? 1 : 512);
  const draft = reduceOrThrow(undefined, {
    commandId: "cmd-create", expectedVersion: 0, goalRef: GOAL_REF,
    kind: "planning.create_draft", runId: RUN_ID, runKind: "INITIAL",
  });
  const ready = reduceOrThrow(draft, {
    commandId: "cmd-ready", expectedVersion: 1, kind: "planning.ready",
    witness: { acceptanceCriteriaRef: "criteria-ref", intentBaseRef: "intent-ref",
      planningBudgetRef: "budget-ref", truthClass: TRUTH },
  });
  const claimed = reduceOrThrow(ready, {
    commandId: "cmd-claim", expectedVersion: 2, kind: "planning.claim",
    witness: { attemptRef: "attempt-ref", contextRef: "context-ref", leaseRef: "lease-ref",
      providerSlotRef: "slot-ref", truthClass: TRUTH },
  });
  const proposed = reduceOrThrow(claimed, {
    commandId: "cmd-propose",
    effectTerminalProof: { effectTerminalRef: "effect-terminal", resourcesTerminalRef:
      "resources-terminal", truthClass: TRUTH },
    expectedVersion: 3, kind: "plan.propose", proposalKind: "INITIAL",
    submissionHash: hex("submission"),
    witness: { attemptRef: "attempt-ref", submissionRef: "submission-ref", truthClass: TRUTH },
  });
  const state = reduceOrThrow(proposed, {
    commandId: "cmd-finalize", expectedVersion: 4, kind: "planning.finalize_submission",
    revision: { dependencyHash: hex("dependency"),
      graphContentHash: revision.graphBinding.graphContentHash,
      graphRevisionRef: GRAPH_REVISION_REF, planHash: revision.planHash,
      qualityHash: hex("quality") },
    witness: { attemptTerminalRef: "attempt-terminal", effectTerminalRef: "effect-terminal",
      nodeSummaries: [{ executionBearing: true, nodeKey: "node-a" }],
      providerSlotTerminalRef: "slot-terminal", resourcesTerminalRef: "resources-terminal",
      truthClass: TRUTH },
  });
  return { contract, revision, state };
}

type Envelope = Record<string, unknown>;

/** The sealed slice the reducer actually wrote; a null here means the fixture chain regressed. */
function sealedOf(state: PlanningRunState): {
  graphRevisionRef: string; sealedHashes: Record<string, string>; submissionHash: string;
} {
  const { graphRevisionRef, sealedHashes, submissionHash } = state;
  if (graphRevisionRef === null || sealedHashes === null || submissionHash === null) {
    throw new Error("the planning fixture did not reach a sealed PLAN_REVIEW state");
  }
  return { graphRevisionRef, sealedHashes: { ...sealedHashes }, submissionHash };
}

function envelopeOf(fixture: Fixture): Envelope {
  const { contract, revision, state } = fixture;
  const sealed = sealedOf(state);
  return {
    acceptanceContract: structuredClone(contract) as unknown,
    bindings: { goalRef: state.goalRef, projectId: PROJECT_ID, revisionId: revision.revisionId,
      runId: state.runId },
    planRevision: structuredClone(revision) as unknown,
    submission: {
      criteriaDigest: contract.criteriaDigest, goalRef: state.goalRef,
      graphRevisionRef: sealed.graphRevisionRef, lifecycle: state.lifecycle,
      projectId: PROJECT_ID, runId: state.runId,
      sealedHashes: sealed.sealedHashes, submissionHash: sealed.submissionHash,
    },
    version: PLANNING_AUTHORITY_ENVELOPE_VERSION,
  };
}

const BASE = buildFixture();

function refusalOf(value: unknown): { code: string; layer: string } {
  const result = admitPlanningAuthorityEnvelope(value);
  if (result.ok) throw new Error("expected the envelope admission to refuse");
  return { code: result.code, layer: result.layer };
}

describe("planning authority envelope — accepted control", () => {
  it("seals both canonical bodies with the reducer's sealed submission and the exact bindings", () => {
    const result = admitPlanningAuthorityEnvelope(envelopeOf(BASE));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { envelope } = result;
    expect(envelope.version).toBe(PLANNING_AUTHORITY_ENVELOPE_VERSION);
    expect(envelope.planRevision.steps).toHaveLength(1);
    expect(envelope.acceptanceContract.obligations).toHaveLength(2);
    expect(envelope.bindings).toStrictEqual({
      goalRef: GOAL_REF, projectId: PROJECT_ID, revisionId: BASE.revision.revisionId,
      runId: RUN_ID,
    });
    expect(envelope.submission.lifecycle).toBe("PLAN_REVIEW");
    expect(envelope.submission.sealedHashes).toStrictEqual({ ...BASE.state.sealedHashes });
    expect(envelope.submission.submissionHash).toBe(BASE.state.submissionHash);
  });

  it("recomputes both body digests through the core derivations rather than trusting the carriers", () => {
    const planDigest = derivePlanRevisionDigest(BASE.revision);
    const criteriaDigest = deriveAcceptanceContractDigest(BASE.contract);
    expect(planDigest.ok && criteriaDigest.ok).toBe(true);
    if (!planDigest.ok || !criteriaDigest.ok) return;
    const result = admitPlanningAuthorityEnvelope(envelopeOf(BASE));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.planRevision.planHash).toBe(planDigest.planHash);
    expect(result.envelope.submission.sealedHashes.planHash).toBe(planDigest.planHash);
    expect(result.envelope.acceptanceContract.criteriaDigest).toBe(criteriaDigest.criteriaDigest);
    expect(result.envelope.submission.criteriaDigest).toBe(criteriaDigest.criteriaDigest);
  });

  it("returns a deeply frozen, detached envelope", () => {
    const input = envelopeOf(BASE);
    const result = admitPlanningAuthorityEnvelope(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { envelope } = result;
    for (const frozen of [envelope, envelope.bindings, envelope.submission,
      envelope.submission.sealedHashes, envelope.planRevision, envelope.planRevision.steps,
      envelope.planRevision.steps[0], envelope.planRevision.graphBinding,
      envelope.acceptanceContract, envelope.acceptanceContract.applicability,
      envelope.acceptanceContract.obligations, envelope.acceptanceContract.obligations[0]]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    (input["bindings"] as Record<string, unknown>)["projectId"] = "mutated-after-admission";
    expect(envelope.bindings.projectId).toBe(PROJECT_ID);
  });
});

interface BindingArm {
  readonly code: string;
  readonly mutate: (envelope: Envelope) => void;
  readonly name: string;
}

function nested(envelope: Envelope, key: string): Record<string, unknown> {
  return envelope[key] as Record<string, unknown>;
}

/**
 * One arm per severed cross-binding, each mutating exactly ONE production-built input so a
 * single live check cannot cover for a bypassed sibling. Order matches the production table.
 */
const BINDING_ARMS: readonly BindingArm[] = [
  { code: "PLANNING_AUTHORITY_PROJECT_MISMATCH", name: "project identity",
    mutate: (envelope) => { nested(envelope, "bindings")["projectId"] = "proj-other"; } },
  { code: "PLANNING_AUTHORITY_GOAL_MISMATCH", name: "goal identity",
    mutate: (envelope) => { nested(envelope, "bindings")["goalRef"] = "goal-other"; } },
  { code: "PLANNING_AUTHORITY_RUN_MISMATCH", name: "run identity",
    mutate: (envelope) => { nested(envelope, "bindings")["runId"] = "run-other"; } },
  { code: "PLANNING_AUTHORITY_REVISION_MISMATCH", name: "revision identity",
    mutate: (envelope) => { nested(envelope, "bindings")["revisionId"] = "revision-other"; } },
  { code: "PLANNING_AUTHORITY_GRAPH_REVISION_MISMATCH", name: "graph revision",
    mutate: (envelope) => { nested(envelope, "submission")["graphRevisionRef"] = "graph-other"; } },
  { code: "PLANNING_AUTHORITY_APPLICABILITY_MISMATCH", name: "contract applicability revision",
    mutate: (envelope) => {
      const contract = buildContract(["criterion-a", "criterion-b"]);
      const applicability = { ...contract.applicability, graphRevisionRef: "graph-other" };
      const rebuilt = createAcceptanceContract({ applicability, authorRef: contract.authorRef,
        contractId: contract.contractId, obligations: contract.obligations });
      if (!rebuilt.ok) throw new Error("applicability fixture refused");
      envelope["acceptanceContract"] = structuredClone(rebuilt.contract) as unknown;
      nested(envelope, "submission")["criteriaDigest"] = rebuilt.contract.criteriaDigest;
    } },
  { code: "PLANNING_AUTHORITY_GRAPH_CONTENT_MISMATCH", name: "graph content hash",
    mutate: (envelope) => {
      const sealed = nested(nested(envelope, "submission"), "sealedHashes");
      sealed["graphContentHash"] = FOREIGN_HEX;
    } },
  { code: "PLANNING_AUTHORITY_SUBMISSION_HASH_MISMATCH", name: "sealed plan digest",
    mutate: (envelope) => {
      const sealed = nested(nested(envelope, "submission"), "sealedHashes");
      sealed["planHash"] = FOREIGN_HEX;
    } },
  { code: "PLANNING_AUTHORITY_CRITERIA_DIGEST_MISMATCH", name: "sealed criteria digest",
    mutate: (envelope) => { nested(envelope, "submission")["criteriaDigest"] = FOREIGN_HEX; } },
  { code: "PLANNING_AUTHORITY_CRITERIA_BINDING_MISMATCH", name: "criterion roster",
    mutate: (envelope) => {
      const revision = buildRevision(["criterion-a", "criterion-c"]);
      envelope["planRevision"] = structuredClone(revision) as unknown;
      nested(envelope, "bindings")["revisionId"] = revision.revisionId;
      nested(nested(envelope, "submission"), "sealedHashes")["planHash"] = revision.planHash;
    } },
];

describe("planning authority envelope — cross-binding refusals", () => {
  it("generates the full cross-binding matrix", () => {
    expect(BINDING_ARMS.length).toBe(10);
    expect(new Set(BINDING_ARMS.map((arm) => arm.code)).size).toBe(BINDING_ARMS.length);
    for (const arm of BINDING_ARMS) {
      expect(PLANNING_AUTHORITY_ENVELOPE_CODES).toContain(arm.code);
    }
  });

  for (const arm of BINDING_ARMS) {
    it(`refuses a severed ${arm.name} binding with ${arm.code}`, () => {
      const envelope = envelopeOf(BASE);
      expect(admitPlanningAuthorityEnvelope(envelope).ok).toBe(true);
      arm.mutate(envelope);
      expect(refusalOf(envelope)).toStrictEqual({ code: arm.code, layer: ENVELOPE_LAYER });
    });
  }
});

describe("planning authority envelope — no caller digest authority", () => {
  it("refuses a lying plan digest with the CORE code and layer, not a restamped local one", () => {
    const envelope = envelopeOf(BASE);
    nested(envelope, "planRevision")["planHash"] = FOREIGN_HEX;
    nested(nested(envelope, "submission"), "sealedHashes")["planHash"] = FOREIGN_HEX;
    expect(refusalOf(envelope)).toStrictEqual({
      code: "PLAN_REVISION_DIGEST_MISMATCH", layer: "PLAN_REVISION_DIGEST",
    });
  });

  it("refuses a lying criteria digest with the CORE code and layer", () => {
    const envelope = envelopeOf(BASE);
    nested(envelope, "acceptanceContract")["criteriaDigest"] = FOREIGN_HEX;
    nested(envelope, "submission")["criteriaDigest"] = FOREIGN_HEX;
    expect(refusalOf(envelope)).toStrictEqual({
      code: "ACCEPTANCE_CONTRACT_DIGEST_MISMATCH", layer: "ACCEPTANCE_CONTRACT_DIGEST",
    });
  });

  it("refuses an accessor field at admission rather than invoking it", () => {
    const envelope = envelopeOf(BASE);
    let reads = 0;
    Object.defineProperty(envelope, "version", {
      configurable: true, enumerable: true,
      get: () => { reads += 1; return PLANNING_AUTHORITY_ENVELOPE_VERSION; },
    });
    expect(refusalOf(envelope)).toStrictEqual({
      code: "PLANNING_AUTHORITY_ENVELOPE_MALFORMED", layer: ENVELOPE_LAYER,
    });
    expect(reads).toBe(0);
  });

  it("refuses a hostile prototype at admission", () => {
    const envelope = envelopeOf(BASE);
    Object.setPrototypeOf(envelope, { stolen: true });
    expect(refusalOf(envelope)).toStrictEqual({
      code: "PLANNING_AUTHORITY_ENVELOPE_MALFORMED", layer: ENVELOPE_LAYER,
    });
  });

  it("refuses an unsatisfied planning gate rather than sealing an unsealed run", () => {
    const envelope = envelopeOf(BASE);
    nested(envelope, "submission")["lifecycle"] = "PLANNING";
    expect(refusalOf(envelope)).toStrictEqual({
      code: "PLANNING_AUTHORITY_ENVELOPE_GATE_UNSATISFIED", layer: ENVELOPE_LAYER,
    });
  });
});


const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesOf(fixture: Fixture = BASE): Uint8Array {
  const result = encodePlanningAuthorityEnvelope(envelopeOf(fixture));
  if (!result.ok) throw new Error(`encode refused the accepted control: ${result.code}`);
  return result.bytes;
}

function decodeRefusalOf(bytes: unknown): { code: string; layer: string } {
  const result = decodePlanningAuthorityEnvelopeBytes(bytes);
  if (result.ok) throw new Error("expected the envelope decode to refuse");
  return { code: result.code, layer: result.layer };
}

describe("planning authority envelope — canonical bytes", () => {
  it("round-trips the accepted control through encode and decode", () => {
    const decoded = decodePlanningAuthorityEnvelopeBytes(bytesOf());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.envelope.bindings.revisionId).toBe(BASE.revision.revisionId);
    expect(decoded.envelope.acceptanceContract.criteriaDigest).toBe(BASE.contract.criteriaDigest);
  });

  it("encodes byte-identically twice from the same admitted inputs", () => {
    expect(decoder.decode(bytesOf())).toBe(decoder.decode(bytesOf()));
  });

  it("refuses bytes that are not a canonical re-encoding of their own content", () => {
    const decoded = decodePlanningAuthorityEnvelopeBytes(bytesOf());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const reordered = JSON.stringify({
      version: decoded.envelope.version, submission: decoded.envelope.submission,
      planRevision: decoded.envelope.planRevision, bindings: decoded.envelope.bindings,
      acceptanceContract: decoded.envelope.acceptanceContract,
    });
    expect(decodeRefusalOf(encoder.encode(reordered))).toStrictEqual({
      code: "PLANNING_AUTHORITY_ENVELOPE_NONCANONICAL", layer: ENVELOPE_LAYER,
    });
  });

  it("refuses malformed and non-byte input with the codec code", () => {
    for (const invalid of [encoder.encode("{"), encoder.encode("[]"), "not-bytes",
      Uint8Array.of(0xff, 0xfe, 0xfd)]) {
      expect(decodeRefusalOf(invalid)).toStrictEqual({
        code: "PLANNING_AUTHORITY_ENVELOPE_BYTES_INVALID", layer: ENVELOPE_LAYER,
      });
    }
  });

  it("refuses duplicate JSON keys with their own code rather than keeping the last", () => {
    const canonical = decoder.decode(bytesOf());
    const duplicated = `{"version":"shadow",${canonical.slice(1)}`;
    expect(decodeRefusalOf(encoder.encode(duplicated))).toStrictEqual({
      code: "PLANNING_AUTHORITY_ENVELOPE_DUPLICATE_KEY", layer: ENVELOPE_LAYER,
    });
  });
});

describe("planning authority envelope — closed shape", () => {
  it("refuses an unsupported version", () => {
    const envelope = envelopeOf(BASE);
    envelope["version"] = "moe-planning-authority-envelope/2";
    expect(refusalOf(envelope)).toStrictEqual({
      code: "PLANNING_AUTHORITY_ENVELOPE_VERSION_UNSUPPORTED", layer: ENVELOPE_LAYER,
    });
  });

  const UNKNOWN_KEYS: readonly { name: string; plant: (envelope: Envelope) => void }[] = [
    { name: "envelope", plant: (e) => { e["specFileRef"] = "docs/plans/spec.md"; } },
    { name: "bindings", plant: (e) => { nested(e, "bindings")["nodeMission"] = "x"; } },
    { name: "submission", plant: (e) => { nested(e, "submission")["reviewRow"] = "x"; } },
  ];

  it("generates the forbidden-source key probes", () => {
    expect(UNKNOWN_KEYS.length).toBe(3);
  });

  for (const { name, plant } of UNKNOWN_KEYS) {
    it(`refuses an unknown ${name} key — the admission record is exact, not partial`, () => {
      const envelope = envelopeOf(BASE);
      plant(envelope);
      expect(refusalOf(envelope)).toStrictEqual({
        code: "PLANNING_AUTHORITY_ENVELOPE_MALFORMED", layer: ENVELOPE_LAYER,
      });
    });
  }

  it.each(["acceptanceContract", "bindings", "planRevision", "submission", "version"])(
    "refuses a missing %s member", (key) => {
      const envelope = envelopeOf(BASE);
      delete envelope[key];
      expect(refusalOf(envelope)).toStrictEqual({
        code: "PLANNING_AUTHORITY_ENVELOPE_MALFORMED", layer: ENVELOPE_LAYER,
      });
    });

  it("never reads spec files, NodeMission, review rows or the filesystem", () => {
    expect(MODULE_SOURCE).not.toMatch(/node:fs|readFile|NodeMission|nodeMission/u);
    expect(MODULE_SOURCE).not.toMatch(/reviewRow|specFile|node:child_process/u);
    expect(MODULE_SOURCE).toMatch(/from "@moe\/core"/u);
  });
});

const ID_LIMIT = PLANNING_AUTHORITY_ENVELOPE_LIMITS.maxIdBytes;
const ROSTER_LIMIT = PLANNING_AUTHORITY_ENVELOPE_LIMITS.maxCriterionIds;
const rosterIds = (count: number): readonly string[] =>
  Array.from({ length: count }, (_unused, index) => `criterion-${String(index).padStart(5, "0")}`);

describe("planning authority envelope — finite bounds", () => {
  it("accepts a criterion roster exactly at the item bound", () => {
    expect(ROSTER_LIMIT).toBeGreaterThan(0);
    const atLimit = buildFixture(rosterIds(ROSTER_LIMIT));
    const result = admitPlanningAuthorityEnvelope(envelopeOf(atLimit));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.planRevision.affectedCriterionIds).toHaveLength(ROSTER_LIMIT);
  });

  it("refuses a criterion roster one entry over the item bound", () => {
    const envelope = envelopeOf(BASE);
    const oversized = buildRevision(rosterIds(ROSTER_LIMIT + 1));
    envelope["planRevision"] = structuredClone(oversized) as unknown;
    nested(envelope, "bindings")["revisionId"] = oversized.revisionId;
    nested(nested(envelope, "submission"), "sealedHashes")["planHash"] = oversized.planHash;
    expect(refusalOf(envelope)).toStrictEqual({
      code: "PLANNING_AUTHORITY_ENVELOPE_LIMIT_EXCEEDED", layer: ENVELOPE_LAYER,
    });
  });

  it("accepts a binding id exactly at the byte bound and refuses one byte over", () => {
    const atLimit = "p".repeat(ID_LIMIT);
    const accepted = envelopeOf(BASE);
    nested(accepted, "bindings")["projectId"] = atLimit;
    nested(accepted, "submission")["projectId"] = atLimit;
    expect(admitPlanningAuthorityEnvelope(accepted).ok).toBe(true);
    const overLimit = "p".repeat(ID_LIMIT + 1);
    const refused = envelopeOf(BASE);
    nested(refused, "bindings")["projectId"] = overLimit;
    nested(refused, "submission")["projectId"] = overLimit;
    expect(refusalOf(refused)).toStrictEqual({
      code: "PLANNING_AUTHORITY_ENVELOPE_LIMIT_EXCEEDED", layer: ENVELOPE_LAYER,
    });
  });

  it("refuses an envelope whose canonical bytes exceed the byte bound", () => {
    const bulky = buildFixture(rosterIds(ROSTER_LIMIT), "b".repeat(1_024));
    const result = encodePlanningAuthorityEnvelope(envelopeOf(bulky));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect({ code: result.code, layer: result.layer }).toStrictEqual({
      code: "PLANNING_AUTHORITY_ENVELOPE_LIMIT_EXCEEDED", layer: ENVELOPE_LAYER,
    });
  });
});

interface FieldFamily {
  readonly name: string;
  readonly vary: (envelope: Envelope) => void;
}

/** Every INCLUDED family must move the bytes, or the envelope seals less than it claims. */
const FIELD_FAMILIES: readonly FieldFamily[] = [
  { name: "bindings.projectId", vary: (envelope) => {
    nested(envelope, "bindings")["projectId"] = "proj-varied";
    nested(envelope, "submission")["projectId"] = "proj-varied";
  } },
  { name: "bindings.goalRef", vary: (envelope) => {
    nested(envelope, "bindings")["goalRef"] = "goal-varied";
    nested(envelope, "submission")["goalRef"] = "goal-varied";
  } },
  { name: "bindings.runId", vary: (envelope) => {
    nested(envelope, "bindings")["runId"] = "run-varied";
    nested(envelope, "submission")["runId"] = "run-varied";
  } },
  { name: "submission.submissionHash", vary: (envelope) => {
    nested(envelope, "submission")["submissionHash"] = hex("submission-varied");
  } },
  { name: "planRevision", vary: (envelope) => {
    const varied = buildRevision(["criterion-a", "criterion-b"], "a varied analysis step");
    envelope["planRevision"] = structuredClone(varied) as unknown;
    nested(envelope, "bindings")["revisionId"] = varied.revisionId;
    nested(nested(envelope, "submission"), "sealedHashes")["planHash"] = varied.planHash;
  } },
  { name: "acceptanceContract", vary: (envelope) => {
    const varied = buildContract(["criterion-a", "criterion-b"], "a varied obligation");
    envelope["acceptanceContract"] = structuredClone(varied) as unknown;
    nested(envelope, "submission")["criteriaDigest"] = varied.criteriaDigest;
  } },
];

describe("planning authority envelope — byte stability", () => {
  it("generates one probe per included field family", () => {
    expect(FIELD_FAMILIES.length).toBe(6);
    expect(new Set(FIELD_FAMILIES.map((family) => family.name)).size).toBe(FIELD_FAMILIES.length);
  });

  it("moves the canonical bytes for every included field family", () => {
    const baseline = decoder.decode(bytesOf());
    const seen = new Set<string>([baseline]);
    for (const family of FIELD_FAMILIES) {
      const envelope = envelopeOf(BASE);
      family.vary(envelope);
      const encoded = encodePlanningAuthorityEnvelope(envelope);
      expect(encoded.ok, `${family.name} must stay admissible`).toBe(true);
      if (!encoded.ok) continue;
      const text = decoder.decode(encoded.bytes);
      expect(text, `${family.name} must move the bytes`).not.toBe(baseline);
      seen.add(text);
    }
    expect(seen.size).toBe(FIELD_FAMILIES.length + 1);
  });

  it("detaches the decoded records so a caller cannot edit the sealed content", () => {
    const bytes = bytesOf();
    const decoded = decodePlanningAuthorityEnvelopeBytes(bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(() => {
      (decoded.envelope.bindings as { projectId: string }).projectId = "hijacked";
    }).toThrow(TypeError);
    const again = decodePlanningAuthorityEnvelopeBytes(bytes);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.envelope.bindings.projectId).toBe(PROJECT_ID);
  });
});

/**
 * Arms added by the pre-completion adversarial pass, each pinning a defect that was present in
 * the first green implementation and is invisible to every arm above.
 */
describe("planning authority envelope — hostile carriers", () => {
  it("refuses a proxied envelope instead of reading it through the traps", () => {
    let descriptorReads = 0;
    const target = envelopeOf(BASE);
    const hostile = new Proxy(target, {
      getOwnPropertyDescriptor: (object, key) => {
        descriptorReads += 1;
        return Object.getOwnPropertyDescriptor(object, key);
      },
    });
    expect(refusalOf(hostile)).toStrictEqual({
      code: "PLANNING_AUTHORITY_ENVELOPE_MALFORMED", layer: ENVELOPE_LAYER,
    });
    expect(descriptorReads).toBe(0);
  });

  it("refuses a proxied bindings member whose second read differs from the checked one", () => {
    const envelope = envelopeOf(BASE);
    let reads = 0;
    envelope["bindings"] = new Proxy(nested(envelope, "bindings"), {
      get: (object, key) => {
        reads += 1;
        return key === "projectId" && reads > 4 ? "proj-swapped" : Reflect.get(object, key);
      },
    });
    expect(refusalOf(envelope)).toStrictEqual({
      code: "PLANNING_AUTHORITY_ENVELOPE_MALFORMED", layer: ENVELOPE_LAYER,
    });
  });

  it("refuses a criterion roster that only matches once a separator is collapsed", () => {
    const envelope = envelopeOf(BASE);
    const collapsed = buildContract(["criterion-a criterion-b"]);
    envelope["acceptanceContract"] = structuredClone(collapsed) as unknown;
    nested(envelope, "submission")["criteriaDigest"] = collapsed.criteriaDigest;
    expect(refusalOf(envelope)).toStrictEqual({
      code: "PLANNING_AUTHORITY_CRITERIA_BINDING_MISMATCH", layer: ENVELOPE_LAYER,
    });
  });
});
