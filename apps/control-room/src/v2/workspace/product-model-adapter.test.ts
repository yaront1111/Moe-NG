import { describe, expect, it } from "vitest";
import { createProductWorkspaceModel } from "./product-model-adapter.js";
import type { ProductWorkspaceInput } from "./product-model-adapter.js";
import type { CriterionEvidenceView } from "../../live/live-criterion-evidence-contracts.js";
import type { CoverageContractView, DocumentCoverageOutcome } from "../../live/live-document-coverage.js";

const scope = { connectionId: "session", projectId: "project", goalId: "goal-a", plane: "V1" } as const;
const contractRef = { contractId: "contract-a", revisionId: "revision-a", revisionDigest: "digest-a" };
const contract: CoverageContractView = { ...contractRef, plane: "V1", gate1: "APPROVED", requirements: [
  { requirementId: "requirement-a", statement: "Book an appointment", criteria: [
    { criterionId: "criterion-a", statement: "Booking arrives", nodeKey: "node-a", nodeTestStatus: "NODE_TEST_PASSED", status: "VERIFIED" },
  ] },
] };
const coverage: DocumentCoverageOutcome = { status: "COVERAGE", contracts: [contract],
  document: { byteLength: 100, contentSha256: "source-sha", displayPath: "PRD.md" },
  goals: [{ goalId: "goal-a", planningRunRef: "run-a", title: "Appointments", lifecycle: "ACTIVE", lastActivityAt: null }],
  sections: null, totals: { contracts: 1, criteria: 1, goals: 1, planned: 1, requirements: 1, unattributable: 0, verified: 1 },
};
const criteriaView: CriterionEvidenceView = { outcome: "CRITERION_EVIDENCE", goalRef: "goal-a", planningRunRef: "run-a",
  contractRef, graphContentHash: "graph-a", integratedArtifact: { sha: "candidate-a", treeSha: "tree-a" },
  criteria: [{ criterionId: "criterion-a", statement: "Booking arrives", approval: {
    approvalId: "approval-a", executorDigest: "executor", checkId: "check", checkVersion: "1", program: "node", args: [], timeoutMs: 1000,
  }, approveOffer: null,
    evidence: { receiptId: "check-a", runRef: "check-run-a", sha: "candidate-a", treeSha: "tree-a", status: "PASSED",
      exitCode: 0, outputSha256: "output-sha", byteCount: 20, finishedAt: "2026-09-13T00:00:00Z" },
  }], run: { runRef: "check-run-a", status: "COMPLETED", integratedSha: "candidate-a" }, verifyOffer: null,
};
function input(patch: Partial<ProductWorkspaceInput> = {}): ProductWorkspaceInput {
  return { scope, goalRef: "goal-a", planningRunRef: "run-a", source: null, design: null, coverage,
    criteria: { status: "CRITERION_EVIDENCE", view: criteriaView }, preview: null, release: null, ...patch };
}

describe("product workspace read adapter", () => {
  it("joins requirements from the compiled contract and counts its candidate checks", () => {
    const result = createProductWorkspaceModel(input());
    expect(result.contractRef).toEqual({ ...contractRef, plane: "V1" });
    expect(result.requirements[0]?.requirementId).toBe("requirement-a");
    expect(result.readiness.passed).toBe(1);
    expect(result.currentWork?.sha).toBe("candidate-a");
    expect(result.delivered).toBeNull();
  });
  it("does not select another goal's contract from shared PRD coverage", () => {
    const result = createProductWorkspaceModel(input({ criteria: null, coverage: { ...coverage,
      contracts: [contract, { ...contract, contractId: "contract-b" }],
      goals: [...coverage.goals, { ...coverage.goals[0]!, goalId: "goal-b" }],
    } }));
    expect(result.requirements).toEqual([]);
    expect(result.contractRef).toBeNull();
    expect(result.scopeNote).toContain("definition binding");
  });
  it("does not call document-level VERIFIED rows candidate checks", () => {
    const result = createProductWorkspaceModel(input({ criteria: null, viewedContractRef: { ...contractRef, plane: "V1" } }));
    expect(result.requirements).toHaveLength(1);
    expect(result.readiness.passed).toBe(0);
    expect(result.requirements[0]?.criteria[0]?.implementationNodes).toEqual([]);
  });
  it.each([{ goalRef: "goal-b" }, { planningRunRef: "run-b" }])("does not borrow criterion view %j", (patch) => {
    const result = createProductWorkspaceModel(input({ criteria: { status: "CRITERION_EVIDENCE", view: { ...criteriaView, ...patch } } }));
    expect(result.contractRef).toBeNull();
    expect(result.readiness.passed).toBe(0);
  });
  it("keeps proposed definition separate from the running contract", () => {
    const proposed = { ...contract, revisionId: "revision-b", revisionDigest: "digest-b", gate1: "PENDING" as const };
    const result = createProductWorkspaceModel(input({ coverage: { ...coverage, contracts: [contract, proposed] },
      viewedContractRef: { plane: "V1", contractId: proposed.contractId, revisionId: proposed.revisionId, revisionDigest: proposed.revisionDigest },
    }));
    expect(result.contractRef?.revisionId).toBe("revision-b");
    expect(result.readiness.passed).toBe(0);
    expect(result.currentWork?.contractRef?.revisionId).toBe("revision-a");
  });
  it("keeps an exactly read pending definition selectable before coverage or compilation", () => {
    const ref = { ...contractRef, plane: "V1" as const };
    const result = createProductWorkspaceModel(input({ coverage: null, criteria: null,
      viewedContractRef: ref, availableDefinitionRef: ref }));
    expect(result.selection.status).toBe("SELECTED");
    expect(result.selection.artifact?.kind).toBe("DEFINITION");
    expect(result.requirements).toEqual([]);
    expect(result.readiness.passed).toBe(0);
  });
  it("keeps delivered receipt distinct when current work uses different bytes", () => {
    const result = createProductWorkspaceModel(input({ release: { status: "PRESENT", evidence: {
      ancestryMeasured: true, criteria: [], goalId: "goal-a", goalTitle: "Appointments", preview: null, reviewRounds: [], sha: "candidate-a",
      receipt: { dossierSha256: "dossier", outcome: "RELEASED", prUrl: "https://example.test/pr/1", receiptId: "release-old", refusalCode: null, sha: "candidate-old" },
    } } }));
    expect(result.currentWork?.sha).toBe("candidate-a");
    expect(result.delivered?.sha).toBe("candidate-old");
    expect(result.delivered?.contractRef).toBeNull();
  });
  it("does not import another goal's release", () => {
    const result = createProductWorkspaceModel(input({ release: { status: "PRESENT", evidence: {
      ancestryMeasured: true, criteria: [], goalId: "goal-b", goalTitle: "Other", preview: null, reviewRounds: [], sha: "candidate-a",
      receipt: { dossierSha256: "dossier", outcome: "RELEASED", prUrl: null, receiptId: "foreign", refusalCode: null, sha: "candidate-a" },
    } } }));
    expect(result.delivered).toBeNull();
    expect(result.artifacts.some((item) => item.id === "release:foreign")).toBe(false);
  });
  it("distinguishes release loading and failed reads from absence", () => {
    expect(createProductWorkspaceModel(input()).deliveryState).toBe("LOADING");
    const unreadable = createProductWorkspaceModel(input({ release: { status: "ERROR", code: "TRANSPORT_FAILED", layer: "HTTP" } }));
    expect(unreadable.deliveryState).toBe("UNREADABLE");
    expect(unreadable.deliveryNote).toBe("Release history cannot currently be read.");
    const absent = createProductWorkspaceModel(input({ release: { status: "ABSENT", goalId: "goal-a" } }));
    expect(absent.deliveryState).toBe("ABSENT");
    expect(absent.deliveryNote).toBe("No released version recorded.");
  });
  it("keeps failed preview identity without claiming current runtime availability", () => {
    const result = createProductWorkspaceModel(input({ selectedArtifactId: "preview:preview-a", preview: { status: "PREVIEW", preview: {
      goalId: "goal-a", receiptId: "preview-a", outcome: "REFUSED", code: "PREVIEW_START_FAILED", decidedAt: "2026-09-13T00:00:00Z",
      screenshots: [], sha: "candidate-a", url: null,
    } } }));
    expect(result.selection.selectedId).toBe("preview:preview-a");
    expect(result.selection.artifact?.availability).toBe("REFUSED");
    expect(result.selection.status).toBe("UNAVAILABLE");
  });
  it("preserves the viewed artifact id after a poll reports a different receipt", () => {
    const result = createProductWorkspaceModel(input({ selectedArtifactId: "preview:old" }));
    expect(result.selection.status).toBe("UNAVAILABLE");
    expect(result.selection.selectedId).toBe("preview:old");
    expect(result.readiness.passed).toBe(0);
  });
  it("does not reuse a build identity for another plan containing the same source SHA", () => {
    const first = createProductWorkspaceModel(input());
    const next = createProductWorkspaceModel(input({ planningRunRef: "run-b", criteria: {
      status: "CRITERION_EVIDENCE", view: { ...criteriaView, planningRunRef: "run-b", graphContentHash: "graph-b" },
    } }));
    expect(first.currentWork?.id).not.toBe(next.currentWork?.id);
  });
  it("does not reinterpret V1 criterion evidence as V2", () => {
    const result = createProductWorkspaceModel(input({ scope: { ...scope, plane: "V2" } }));
    expect(result.contractRef).toBeNull();
    expect(result.readiness.passed).toBe(0);
  });
  it.each([
    { run: null }, { run: { ...criteriaView.run!, status: "RUNNING" as const } },
    { run: { ...criteriaView.run!, runRef: "other-check-run" } },
    { integratedArtifact: { sha: "candidate-a", treeSha: "different-tree" } },
    { criteria: [{ ...criteriaView.criteria[0]!, approval: null }] },
  ])("never credits receipts without completed matching check provenance: %j", (patch) => {
    const result = createProductWorkspaceModel(input({ criteria: { status: "CRITERION_EVIDENCE", view: { ...criteriaView, ...patch } } }));
    expect(result.readiness.passed).toBe(0);
  });
  it("provides source and design as correctly identified concrete artifacts", () => {
    const result = createProductWorkspaceModel(input({ source: { status: "GOAL_SOURCE", text: "# Appointments", sourceRef: "source-a",
      contentSha256: "source-sha", displayPath: "PRD.md", byteLength: 14, mediaType: "text/markdown" },
      design: { status: "DESIGN", versions: [1], record: { contractRef, goalRef: "goal-a", projectId: "project", version: 1,
        profile: "web", schemaVersion: "design/1", submittedAt: "2026-09-13T00:00:00Z", revision: { skipped: true, reason: "API only" },
      } },
    }));
    expect(result.artifacts.find((item) => item.kind === "SOURCE")?.id).toBe("source:source-sha");
    expect(result.artifacts.find((item) => item.kind === "DESIGN")?.title).toBe("Design record");
  });
});
