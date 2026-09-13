import { describe, expect, it } from "vitest";
import { reconcileProductArtifactHistory, selectProductArtifactHistory } from "./product-artifact-history.js";
import type { ProductArtifactHistory } from "./product-artifact-history.js";
import type { ProductWorkspaceInput } from "./product-model-adapter.js";

const scope = { connectionId: "connection-a", projectId: "project-a", goalId: "goal-a", plane: "V1" } as const;
const observedAt = "2026-09-13T00:00:00Z";
function input(patch: Partial<ProductWorkspaceInput> = {}): ProductWorkspaceInput {
  return { scope, goalRef: "goal-a", planningRunRef: "run-a", source: { status: "GOAL_SOURCE", contentSha256: "source-a",
    sourceRef: "source-ref", text: "Original source", byteLength: 15, displayPath: "PRD.md", mediaType: "text/markdown" },
    design: null, preview: null, release: null, criteria: null, coverage: null, ...patch };
}
function preview(receiptId: string): ProductWorkspaceInput["preview"] {
  return { status: "PREVIEW", preview: { goalId: "goal-a", receiptId, sha: `sha-${receiptId}`, outcome: "STARTED",
    code: null, decidedAt: observedAt, url: `http://localhost:3000/${receiptId}`, screenshots: [] } };
}
function released(receiptId: string): ProductWorkspaceInput["release"] {
  return { status: "PRESENT", evidence: { ancestryMeasured: true, goalId: "goal-a", goalTitle: "Appointments", criteria: [],
    preview: null, reviewRounds: [], sha: `sha-${receiptId}`, receipt: { receiptId, outcome: "RELEASED", dossierSha256: "dossier",
      prUrl: "https://example.test/pr/1", refusalCode: null, sha: `sha-${receiptId}` } } };
}

describe("observed product artifact history", () => {
  it("retains the exact preview payload when a later observation selects another receipt", () => {
    const first = input({ preview: preview("old"), selectedArtifactId: "preview:old" });
    const oldHistory = reconcileProductArtifactHistory(null, first, observedAt);
    const current = input({ preview: preview("new"), selectedArtifactId: "preview:old" });
    const history = reconcileProductArtifactHistory(oldHistory, current, "2026-09-13T00:01:00Z");
    const view = selectProductArtifactHistory(history, current);
    expect(view.historical).toBe(true);
    expect(view.observedAt).toBe(observedAt);
    expect(view.reads.preview).toMatchObject({ status: "PREVIEW", preview: { receiptId: "old", sha: "sha-old" } });
    expect(view.model.selection).toMatchObject({ status: "SELECTED", selectedId: "preview:old" });
    expect(view.model.readiness.state).toBe("UNKNOWN");
    expect(view.model.readiness.passed).toBe(0);
    expect(view.model.currentWork?.id).toBe("preview:new");
  });
  it.each(["connectionId", "projectId", "goalId", "plane"] as const)("does not retain history across %s", (key) => {
    const history = reconcileProductArtifactHistory(null, input({ preview: preview("old") }), observedAt);
    const nextScope = { ...scope, [key]: key === "plane" ? "V2" : "other" } as ProductWorkspaceInput["scope"];
    const next = input({ scope: nextScope, goalRef: nextScope.goalId, selectedArtifactId: "preview:old" });
    const view = selectProductArtifactHistory(history, next);
    expect(view.historical).toBe(false);
    expect(view.model.selection.status).toBe("UNAVAILABLE");
    const replaced = reconcileProductArtifactHistory(history, next, observedAt);
    expect(replaced.snapshots.some((item) => item.artifact.id === "preview:old")).toBe(false);
  });
  it("preserves a positively observed release when a later read fails", () => {
    const history = reconcileProductArtifactHistory(null, input({ release: released("old") }), observedAt);
    const current = input({ release: { status: "ERROR", code: "READ_FAILED", layer: "HTTP" } });
    const view = selectProductArtifactHistory(reconcileProductArtifactHistory(history, current, observedAt), current);
    expect(view.model.delivered?.id).toBe("release:old");
    expect(view.model.deliveryState).toBe("STALE");
    expect(view.model.deliveryNote).toContain("Previously observed");
  });
  it("does not treat a refused release attempt as deletion of the observed released version", () => {
    const history = reconcileProductArtifactHistory(null, input({ release: released("old") }), observedAt);
    const release = released("failed");
    if (release?.status !== "PRESENT" || release.evidence.receipt === null) throw new Error("fixture invalid");
    const current = input({ release: { ...release, evidence: { ...release.evidence,
      receipt: { ...release.evidence.receipt, outcome: "REFUSED", prUrl: null, refusalCode: "RELEASE_REFUSED" },
    } } });
    const view = selectProductArtifactHistory(reconcileProductArtifactHistory(history, current, observedAt), current);
    expect(view.model.delivered?.id).toBe("release:old");
    expect(view.model.deliveryNote).toContain("refused");
  });
  it("returns current matching payloads without historical promotion", () => {
    const current = input({ preview: preview("now"), selectedArtifactId: "preview:now" });
    const history = reconcileProductArtifactHistory(null, current, observedAt);
    const view = selectProductArtifactHistory(history, current);
    expect(view.historical).toBe(false);
    expect(view.reads.preview).toEqual(current.preview);
  });
  it("copies and freezes stored payloads without retaining authority-bearing reads", () => {
    const current = input({ preview: preview("old") });
    const history = reconcileProductArtifactHistory(null, current, observedAt);
    const entry = history.snapshots.find((item) => item.artifact.id === "source:source-a");
    expect(Object.isFrozen(entry?.reads.source)).toBe(true);
    expect(entry?.reads.source).not.toBe(current.source);
    expect(Object.keys(entry?.reads ?? {}).sort()).toEqual(["design", "preview", "release", "source"]);
    expect(entry?.reads.preview).toBeNull();
  });
  it("bounds observation history while preserving the viewed and released artifacts", () => {
    let history: ProductArtifactHistory | null = reconcileProductArtifactHistory(null, input({ preview: preview("old"), release: released("released") }), observedAt);
    for (let index = 0; index < 40; index += 1) {
      history = reconcileProductArtifactHistory(history, input({ preview: preview(String(index)), selectedArtifactId: "preview:old" }), observedAt);
    }
    expect(history.snapshots.length).toBeLessThanOrEqual(26);
    expect(history.snapshots.some((item) => item.artifact.id === "preview:old")).toBe(true);
    expect(history.snapshots.some((item) => item.artifact.id === "release:released")).toBe(true);
  });
});
