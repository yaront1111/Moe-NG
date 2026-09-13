import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProductArtifact as Artifact } from "@moe/control-room-model";
import { ProductArtifact } from "./product-artifact.js";
import { productArtifacts } from "./product-model-artifacts.js";
import type { ProductWorkspaceInput } from "./product-model-contracts.js";

afterEach(cleanup);
const scope = { connectionId: "session", projectId: "project", goalId: "goal", plane: "V1" } as const;
const contractRef = { contractId: "contract", revisionId: "revision", revisionDigest: "digest" };
const source = { status: "GOAL_SOURCE", sourceRef: "source", text: "The exact PRD", contentSha256: "source-digest",
  displayPath: "PRD.md", byteLength: 13, mediaType: "text/markdown" } as const;
const design = { status: "DESIGN", versions: [1], record: { contractRef, goalRef: "goal", projectId: "project", version: 1,
  profile: "web", schemaVersion: "design/1", submittedAt: "2026-09-13T00:00:00Z", revision: { skipped: true, reason: "API only" } } } as const;
const preview = { status: "PREVIEW", preview: { goalId: "goal", receiptId: "preview:opaque", outcome: "STARTED", code: null,
  decidedAt: "2026-09-13T00:00:00Z", screenshots: [], sha: "candidate", url: "https://preview.test/" } } as const;
const release = { status: "PRESENT", evidence: { goalId: "goal", goalTitle: "Product", ancestryMeasured: true, criteria: [],
  preview: null, reviewRounds: [], sha: "candidate", receipt: { dossierSha256: "dossier", outcome: "RELEASED",
    prUrl: "https://source.test/pr/1", receiptId: "release:opaque", refusalCode: null, sha: "candidate" } } } as const;
const input: ProductWorkspaceInput = { scope, goalRef: "goal", planningRunRef: "run", source, design, preview, release, coverage: null, criteria: null };
function artifact(kind: Artifact["kind"]): Artifact {
  const found = productArtifacts(input, null, null).find((item) => item.kind === kind);
  if (found === undefined) throw new Error(`Missing ${kind} artifact`);
  return found;
}
function show(kind: Artifact["kind"], patch: Partial<ProductWorkspaceInput> = {}, selected = artifact(kind)) {
  const reads = { ...input, ...patch };
  render(<ProductArtifact artifact={selected} source={reads.source} design={reads.design} preview={reads.preview}
    release={reads.release} definition={<p>Definition review</p>} />);
}
function unavailable() {
  expect(screen.getByRole("heading", { name: "This artifact cannot be read right now" })).toBeTruthy();
  expect(screen.queryByText("Implementation recorded")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
}

describe("exact product artifact canvas", () => {
  it.each(["SOURCE", "DESIGN", "PREVIEW", "RELEASE"] as const)("renders the exact %s payload", (kind) => {
    show(kind);
    expect(screen.queryByRole("heading", { name: "This artifact cannot be read right now" })).toBeNull();
    expect(screen.getByText({ SOURCE: "The exact PRD", DESIGN: "Authored design", PREVIEW: "Captured product preview", RELEASE: "Released source" }[kind])).toBeTruthy();
  });
  it("refuses replacement PRD bytes", () => {
    show("SOURCE", { source: { ...source, contentSha256: "replacement", text: "Wrong PRD" } });
    unavailable(); expect(screen.queryByText("Wrong PRD")).toBeNull();
  });
  it.each([
    { version: 2 }, { goalRef: "another-goal" }, { projectId: "another-project" },
    { contractRef: { ...contractRef, contractId: "other" } },
    { contractRef: { ...contractRef, revisionId: "other" } },
    { contractRef: { ...contractRef, revisionDigest: "other" } },
  ])("refuses design identity mismatch %j", (patch) => {
    show("DESIGN", { design: { ...design, record: { ...design.record, ...patch } } }); unavailable();
  });
  it.each([{ receiptId: "replacement" }, { sha: "replacement" }, { goalId: "other" }, { outcome: "REFUSED" as const }])(
    "refuses preview identity or availability mismatch %j", (patch) => {
      show("PREVIEW", { preview: { ...preview, preview: { ...preview.preview, ...patch } } }); unavailable();
    });
  it.each([{ receiptId: "replacement" }, { sha: "replacement" }, { outcome: "REFUSED" as const }])(
    "refuses release identity or availability mismatch %j", (patch) => {
      show("RELEASE", { release: { ...release, evidence: { ...release.evidence, receipt: { ...release.evidence.receipt, ...patch } } } }); unavailable();
    });
  it("refuses a release response for another goal", () => {
    show("RELEASE", { release: { ...release, evidence: { ...release.evidence, goalId: "other" } } }); unavailable();
  });
  it.each(["SOURCE", "DESIGN", "PREVIEW", "RELEASE"] as const)("describes unreadable %s honestly", (kind) => {
    show(kind, { source: null, design: null, preview: null, release: null }); unavailable();
  });
  it("preserves a readable saved release without claiming runtime availability", () => {
    show("RELEASE", {}, { ...artifact("RELEASE"), availability: "STALE" });
    expect(screen.getByText("Released source")).toBeTruthy();
  });
  it("only describes BUILD metadata as a recorded implementation", () => {
    show("SOURCE", {}, { ...artifact("SOURCE"), kind: "BUILD", sha: "candidate" });
    expect(screen.getByText("Implementation recorded")).toBeTruthy();
  });
});
