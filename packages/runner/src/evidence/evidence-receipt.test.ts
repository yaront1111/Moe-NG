import { describe, expect, it } from "vitest";

import type { ArtifactRef } from "../artifacts/artifact-contract.js";
import { canonicalDigest } from "../canonical.js";
import { buildProviderRuntimeObservation } from "../providers/claude/claude-observation.js";
import type { ProviderRuntimeObservation } from "../providers/claude/claude-observation.js";
import type { GitObserver, ScopeObservation } from "../scope/scope-contract.js";
import { observeScope } from "../scope/scope-observation.js";
import type {
  WorkspaceInputManifest,
  WorkspaceResultManifest,
} from "../workspace/workspace-contract.js";
import { buildInputManifest, buildResultManifest } from "../workspace/workspace-manifest.js";
import {
  EVIDENCE_RECEIPT_VERSION,
  MAX_EVIDENCE_OBLIGATIONS,
  type DischargedObligation,
  type VerificationRecipe,
} from "./evidence-contract.js";
import {
  buildEvidenceReceipt,
  receiptDigestInput,
  type BuildEvidenceReceiptInput,
  type EvidenceReceipt,
  type EvidenceReceiptBody,
} from "./evidence-receipt.js";
import { buildVerificationRecipe } from "./verification-recipe.js";
import type { ObservedVerifierExecution } from "./verifier-execution.js";

const HEAD = "0".repeat(40);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SCHEMA_DIGEST = "c".repeat(64);
const STARTED_AT = "2026-08-08T10:00:00Z";
const COMPLETED_AT = "2026-08-08T10:00:09Z";

const INPUT_PATH = "pkg/src/base.ts";
const AUTHORED_PATH = "pkg/src/authored.ts";
const OUTPUT_PATH = "out/report.json";
const OUTPUT_REF: ArtifactRef = { sha256: DIGEST_B, byteLength: 7 };

function fakeGit(): GitObserver {
  return {
    headCommit: () => HEAD,
    statusPorcelainV2: () => new TextEncoder().encode(`# branch.oid ${HEAD}\0`),
    lsFilesTracked: () => [],
    lsFilesIgnored: () => [],
    submodulePaths: () => [],
  };
}

function scopeFixture(): ScopeObservation {
  const result = observeScope({
    worktreeRoot: "fixture-root",
    baseIdentity: HEAD,
    declaredScopePaths: ["pkg/src"],
    gitObserver: fakeGit(),
    pathObserver: { realpath: (path) => path, exists: () => false },
    observedAt: STARTED_AT,
    observerVersion: "moe-runner-scope-observer/1",
  });
  if (!result.ok) {
    throw new Error(`scope fixture refused: ${result.code} ${result.message}`);
  }
  return result.observation;
}

function inputManifestFixture(): WorkspaceInputManifest {
  const result = buildInputManifest({
    baseIdentity: HEAD,
    entries: [
      { path: INPUT_PATH, sha256: DIGEST_A, byteLength: 10, producer: { kind: "BASE" } },
    ],
  });
  if (!result.ok) {
    throw new Error(`input manifest fixture refused: ${result.code} ${result.message}`);
  }
  return result.manifest;
}

function resultManifestFixture(inputManifest: WorkspaceInputManifest): WorkspaceResultManifest {
  const result = buildResultManifest({
    inputManifest,
    scopeObservation: scopeFixture(),
    authoredPaths: [AUTHORED_PATH],
    resultTreeEntries: [
      { path: INPUT_PATH, sha256: DIGEST_A, byteLength: 10, origin: "INHERITED", kind: "REGULAR" },
      { path: AUTHORED_PATH, sha256: DIGEST_B, byteLength: 4, origin: "AUTHORED", kind: "REGULAR" },
    ],
    declaredArtifactRefs: [OUTPUT_REF],
  });
  if (!result.ok) {
    throw new Error(`result manifest fixture refused: ${result.code} ${result.message}`);
  }
  return result.manifest;
}

function observationFixture(reportedVersion: string | null = "1.2.3"): ProviderRuntimeObservation {
  const result = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: "bin/node", sha256: DIGEST_A }],
    reportedVersion,
    adapterCapabilitySchemaDigest: SCHEMA_DIGEST,
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { os: "win32", arch: "x64", osVersion: "10.0.26200" },
    clock: { observedAt: () => STARTED_AT },
  });
  if (!result.ok) {
    throw new Error(`observation fixture refused: ${result.code} ${result.message}`);
  }
  return result.observation;
}

function recipeFixture(): VerificationRecipe {
  const result = buildVerificationRecipe({
    argv: ["node", "verify.mjs"],
    declaredInputs: [{ path: INPUT_PATH, ref: { sha256: DIGEST_A, byteLength: 10 } }],
    declaredOutputPaths: [OUTPUT_PATH],
    verifierIdentity: {
      verifierId: "moe-verifier",
      verifierVersion: "1.0.0",
      capabilitySchemaDigest: SCHEMA_DIGEST,
    },
  });
  if (!result.ok) {
    throw new Error(`recipe fixture refused: ${result.code} ${result.message}`);
  }
  return result.recipe;
}

const RECIPE = recipeFixture();
const INPUT_MANIFEST = inputManifestFixture();
const RESULT_MANIFEST = resultManifestFixture(INPUT_MANIFEST);
const OBSERVATION = observationFixture();

function executionFixture(
  overrides: Partial<ObservedVerifierExecution> = {},
): ObservedVerifierExecution {
  return {
    argv: [...RECIPE.argv],
    disposition: "COMPLETED",
    exitCode: 0,
    outputs: [{ path: OUTPUT_PATH, ref: OUTPUT_REF }],
    runtimeObservation: OBSERVATION,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    ...overrides,
  };
}

function receiptInput(
  overrides: Partial<BuildEvidenceReceiptInput> = {},
): BuildEvidenceReceiptInput {
  return {
    recipe: RECIPE,
    execution: executionFixture(),
    inputManifest: INPUT_MANIFEST,
    resultManifest: RESULT_MANIFEST,
    graphIdentity: "graph-node-17",
    leaseIdentity: "lease-42",
    effectIdentity: "effect-9",
    obligations: [
      { kind: "OUTPUT_PRESENT", support: { kind: "ARTIFACT", ref: OUTPUT_REF } },
      {
        kind: "RESULT_TREE_SEALED",
        support: { kind: "RESULT_TREE", manifestSha256: RESULT_MANIFEST.sha256 },
      },
    ],
    ...overrides,
  };
}

function receiptOrThrow(overrides: Partial<BuildEvidenceReceiptInput> = {}): EvidenceReceipt {
  const result = buildEvidenceReceipt(receiptInput(overrides));
  if (!result.ok) {
    throw new Error(`receipt fixture refused: ${result.code} ${result.message}`);
  }
  return result.receipt;
}

/**
 * Hand-written from DoD 2: "Receipts bind exact argv, input/result tree,
 * environment/runtime, output, timestamps, recipe, graph, lease, and effect
 * identities." Each entry pairs the DoD phrase with the field that carries it.
 */
const DOD_BOUND_FIELDS = Object.freeze([
  ["exact argv", "argv"],
  ["input tree", "inputTreeSha256"],
  ["result tree", "resultTreeSha256"],
  ["environment/runtime", "runtimeObservationSha256"],
  ["output", "outputs"],
  ["timestamps", "timestamps"],
  ["recipe", "recipeSha256"],
  ["graph identity", "graphIdentity"],
  ["lease identity", "leaseIdentity"],
  ["effect identity", "effectIdentity"],
] as const);

/** Not named by DoD 2, but bound: the version pin and what the receipt claims was proven. */
const STRUCTURAL_BOUND_FIELDS = Object.freeze(["receiptVersion", "obligations"] as const);

type BodyMutation = (body: EvidenceReceiptBody) => EvidenceReceiptBody;

const MUTATIONS: Readonly<Record<string, BodyMutation>> = Object.freeze({
  receiptVersion: (body) => ({
    ...body,
    receiptVersion: "moe-evidence-receipt/other" as unknown as typeof EVIDENCE_RECEIPT_VERSION,
  }),
  argv: (body) => ({ ...body, argv: ["node", "other.mjs"] }),
  inputTreeSha256: (body) => ({ ...body, inputTreeSha256: DIGEST_B }),
  resultTreeSha256: (body) => ({ ...body, resultTreeSha256: DIGEST_A }),
  runtimeObservationSha256: (body) => ({ ...body, runtimeObservationSha256: DIGEST_A }),
  outputs: (body) => ({
    ...body,
    outputs: [{ path: OUTPUT_PATH, ref: { sha256: DIGEST_A, byteLength: 7 } }],
  }),
  timestamps: (body) => ({
    ...body,
    timestamps: { startedAt: STARTED_AT, completedAt: "2026-08-08T10:00:10Z" },
  }),
  recipeSha256: (body) => ({ ...body, recipeSha256: DIGEST_A }),
  graphIdentity: (body) => ({ ...body, graphIdentity: "graph-node-18" }),
  leaseIdentity: (body) => ({ ...body, leaseIdentity: "lease-43" }),
  effectIdentity: (body) => ({ ...body, effectIdentity: "effect-10" }),
  obligations: (body) => ({
    ...body,
    obligations: [{ kind: "RUNTIME_PINNED", support: { kind: "RESULT_TREE", manifestSha256: DIGEST_A } }],
  }),
});

describe("buildEvidenceReceipt binding", () => {
  it("binds exactly the DoD field set and nothing has silently dropped out", () => {
    const receipt = receiptOrThrow();
    const bound = new Set(Object.keys(receiptDigestInput(receipt)));
    const expected = new Set<string>([
      ...DOD_BOUND_FIELDS.map(([, key]) => key),
      ...STRUCTURAL_BOUND_FIELDS,
    ]);

    expect(DOD_BOUND_FIELDS.length).toBe(10);
    expect(bound).toEqual(expected);
  });

  it("changes the receipt digest when any single bound field changes", () => {
    const receipt = receiptOrThrow();
    const body: EvidenceReceiptBody = receipt;
    const covered = Object.keys(MUTATIONS);

    // Driven from the bound field set itself, so a newly bound field with no
    // mutation case fails here instead of quietly going uncovered.
    expect(new Set(covered)).toEqual(new Set(Object.keys(receiptDigestInput(receipt))));
    expect(covered.length).toBe(DOD_BOUND_FIELDS.length + STRUCTURAL_BOUND_FIELDS.length);
    expect(covered.length).toBeGreaterThan(0);

    for (const key of covered) {
      const mutate = MUTATIONS[key];
      expect(mutate).toBeDefined();
      const mutated = canonicalDigest(receiptDigestInput(mutate!(body)));
      expect(`${key}:${mutated}`).not.toBe(`${key}:${receipt.sha256}`);
    }
  });

  it("digests identically when the same facts are supplied in a different key order", () => {
    const forward = receiptOrThrow();
    const shuffled = buildEvidenceReceipt({
      obligations: receiptInput().obligations,
      effectIdentity: "effect-9",
      leaseIdentity: "lease-42",
      graphIdentity: "graph-node-17",
      resultManifest: RESULT_MANIFEST,
      inputManifest: INPUT_MANIFEST,
      execution: executionFixture(),
      recipe: RECIPE,
    });

    expect(shuffled.ok && shuffled.receipt.sha256).toBe(forward.sha256);
  });

  it("returns a deep-frozen receipt under the pinned version", () => {
    const receipt = receiptOrThrow();

    expect(receipt.receiptVersion).toBe(EVIDENCE_RECEIPT_VERSION);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(() => {
      (receipt.argv as string[]).push("--extra");
    }).toThrow(TypeError);
  });
});

describe("buildEvidenceReceipt refuses agent-reported text", () => {
  // DoD 1. The receipt type has no free-text parameter at all; this is the
  // nearest LEGAL attempt — a fully well-formed support record whose only
  // backing is something an agent wrote.
  it("refuses an obligation supported only by an agent report, at the OBLIGATION layer", () => {
    const obligations: DischargedObligation[] = [
      {
        kind: "OUTPUT_PRESENT",
        support: { kind: "AGENT_REPORT", reportedBy: "agent-7", reportSha256: DIGEST_A },
      },
    ];

    const result = buildEvidenceReceipt(receiptInput({ obligations }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_AGENT_TEXT_UNSUPPORTED");
    // Which layer answered matters: a nearer shape gate refusing first would
    // leave this test green while it no longer tests the rule it was written for.
    expect(result.ok === false && result.layer).toBe("OBLIGATION");
  });

  it("still refuses an agent report when every other obligation is properly supported", () => {
    const obligations: DischargedObligation[] = [
      { kind: "OUTPUT_PRESENT", support: { kind: "ARTIFACT", ref: OUTPUT_REF } },
      {
        kind: "RUNTIME_PINNED",
        support: { kind: "AGENT_REPORT", reportedBy: "agent-7", reportSha256: DIGEST_B },
      },
    ];

    const result = buildEvidenceReceipt(receiptInput({ obligations }));

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_AGENT_TEXT_UNSUPPORTED");
    expect(result.ok === false && result.layer).toBe("OBLIGATION");
  });

  it("refuses a support digest that names nothing the receipt itself binds", () => {
    const obligations: DischargedObligation[] = [
      { kind: "RESULT_TREE_SEALED", support: { kind: "RESULT_TREE", manifestSha256: DIGEST_A } },
    ];

    const result = buildEvidenceReceipt(receiptInput({ obligations }));

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_OBLIGATION_SUPPORT_INVALID");
    expect(result.ok === false && result.layer).toBe("OBLIGATION");
  });

  it("refuses an unknown obligation kind", () => {
    const obligations = [
      { kind: "TRUST_ME", support: { kind: "ARTIFACT", ref: OUTPUT_REF } },
    ] as unknown as DischargedObligation[];

    const result = buildEvidenceReceipt(receiptInput({ obligations }));

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_OBLIGATION_KIND_INVALID");
  });

  it("refuses an over-limit obligation list", () => {
    const obligations: DischargedObligation[] = Array.from(
      { length: MAX_EVIDENCE_OBLIGATIONS + 1 },
      () => ({ kind: "OUTPUT_PRESENT" as const, support: { kind: "ARTIFACT" as const, ref: OUTPUT_REF } }),
    );
    expect(obligations.length).toBe(MAX_EVIDENCE_OBLIGATIONS + 1);

    const result = buildEvidenceReceipt(receiptInput({ obligations }));

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_OBLIGATION_LIMIT");
  });
});

describe("buildEvidenceReceipt shape gates", () => {
  it("refuses an empty graph identity", () => {
    const result = buildEvidenceReceipt(receiptInput({ graphIdentity: "" }));

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_IDENTITY_INVALID");
    expect(result.ok === false && result.layer).toBe("RECEIPT_SHAPE");
  });

  it("refuses a lease identity that is not a string", () => {
    const result = buildEvidenceReceipt(
      receiptInput({ leaseIdentity: 7 as unknown as string }),
    );

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_IDENTITY_INVALID");
  });

  it("refuses an effect identity that is not a string", () => {
    const result = buildEvidenceReceipt(
      receiptInput({ effectIdentity: null as unknown as string }),
    );

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_IDENTITY_INVALID");
  });

  it("refuses a timestamp that is not a canonical UTC instant", () => {
    const result = buildEvidenceReceipt(
      receiptInput({ execution: executionFixture({ completedAt: "8 Aug 2026, 10am" }) }),
    );

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_TIMESTAMP_INVALID");
  });

  it("refuses an input manifest whose recorded digest has been edited", () => {
    const tampered: WorkspaceInputManifest = { ...INPUT_MANIFEST, sha256: DIGEST_B };

    const result = buildEvidenceReceipt(receiptInput({ inputManifest: tampered }));

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_INPUT_MANIFEST_INVALID");
  });

  it("refuses a result manifest whose recorded digest has been edited", () => {
    const tampered: WorkspaceResultManifest = { ...RESULT_MANIFEST, sha256: DIGEST_A };

    const result = buildEvidenceReceipt(receiptInput({ resultManifest: tampered }));

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_RESULT_MANIFEST_INVALID");
  });

  it("refuses a result manifest that was sealed against a different input tree", () => {
    const otherInput = buildInputManifest({
      baseIdentity: HEAD,
      entries: [
        { path: INPUT_PATH, sha256: DIGEST_B, byteLength: 3, producer: { kind: "BASE" } },
      ],
    });
    expect(otherInput.ok).toBe(true);

    const result = buildEvidenceReceipt(
      receiptInput({ inputManifest: otherInput.ok ? otherInput.manifest : INPUT_MANIFEST }),
    );

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_MANIFEST_BINDING_MISMATCH");
  });

  it("refuses a runtime observation whose digest does not recompute", () => {
    const tampered: ProviderRuntimeObservation = {
      ...OBSERVATION,
      observationDigest: DIGEST_B,
    };

    const result = buildEvidenceReceipt(
      receiptInput({ execution: executionFixture({ runtimeObservation: tampered }) }),
    );

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_OBSERVATION_INVALID");
  });

  it("refuses an output produced at a path the recipe never declared", () => {
    const result = buildEvidenceReceipt(
      receiptInput({
        execution: executionFixture({ outputs: [{ path: "out/extra.json", ref: OUTPUT_REF }] }),
      }),
    );

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_OUTPUT_UNDECLARED");
  });

  it("refuses when a declared output is absent from the observed execution", () => {
    const result = buildEvidenceReceipt(
      receiptInput({ execution: executionFixture({ outputs: [] }) }),
    );

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_OUTPUT_MISSING");
  });

  it("exposes no receipt on the refusal arm", () => {
    const result = buildEvidenceReceipt(receiptInput({ graphIdentity: "" }));

    expect(result.ok).toBe(false);
    expect(Object.hasOwn(result, "receipt")).toBe(false);
  });
});
