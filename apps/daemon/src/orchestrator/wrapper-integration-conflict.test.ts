import { describe, expect, it } from "vitest";
import type { RepositoryIntegrationView } from "../repository/repository-integration-read.js";
import type { NodeMission } from "./agent-wrapper.js";
import type { WrapperReviewContext } from "./wrapper-review-missions.js";
import { withIntegrationConflict } from "./wrapper-integration-conflict.js";

const NODE = "node:v1:alpha";
const context: WrapperReviewContext = { operatorPrincipalId: "operator", projectId: "project-a", store: () => undefined };
const brief: NodeMission = { instructions: "build it", test: "pnpm test", title: "a node", workspace: "C:\\tree" };
const view = (patch: Record<string, unknown> = {}): RepositoryIntegrationView => ({
  branches: [{ branch: "moe/alpha-1234abcd", conflictPaths: [], mergeSha: null, nodeRef: NODE, sha: "a".repeat(40),
    state: "WAITING", ...patch }],
  projectId: "project-a", version: "moe-repository-integration-read/1",
} as RepositoryIntegrationView);

/** A conflict goes back to the node that owns the branch (owner decision 2026-09-16). */
describe("handing an unmergeable branch back to its node", () => {
  it("names the branch and every path that could not be joined", () => {
    const placed = withIntegrationConflict(context, NODE, brief,
      () => view({ conflictPaths: ["src/shared.ts", "docs/readme.md"], state: "CONFLICTED" }));

    const text = placed?.instructions ?? "";
    expect(text).toContain("build it");
    expect(text).toContain("moe/alpha-1234abcd could not be merged");
    expect(text).toContain("BEGIN INTEGRATION CONFLICT\nsrc/shared.ts\ndocs/readme.md\nEND INTEGRATION CONFLICT");
    expect(text).toContain("is not lost");
    // The seat resolves and lands again; the ordinary review judges it.
    expect(text).toContain("explain in your next review");
  });

  it("truncates a very large conflict rather than flooding the mission", () => {
    const paths = Array.from({ length: 60 }, (_, index) => `src/file-${String(index)}.ts`);
    const placed = withIntegrationConflict(context, NODE, brief, () => view({ conflictPaths: paths, state: "CONFLICTED" }));

    const text = placed?.instructions ?? "";
    expect(text).toContain("src/file-39.ts");
    expect(text).not.toContain("src/file-40.ts");
    expect(text).toContain("[conflicting paths truncated]");
  });

  it.each([
    ["a branch that merged", { mergeSha: "b".repeat(40), state: "MERGED" }],
    ["a branch still waiting", {}],
  ])("says nothing for %s", (_label, patch) => {
    expect(withIntegrationConflict(context, NODE, brief, () => view(patch))).toEqual(brief);
  });

  it("says nothing for another node's conflict", () => {
    expect(withIntegrationConflict(context, NODE, brief,
      () => view({ conflictPaths: ["src/shared.ts"], nodeRef: "node:v1:beta", state: "CONFLICTED" }))).toEqual(brief);
  });

  it("keeps the brief when there is nothing to read or the read fails, and has no brief to change", () => {
    expect(withIntegrationConflict(context, NODE, brief, () => null)).toEqual(brief);
    expect(withIntegrationConflict(context, NODE, brief, () => { throw new Error("unreadable"); })).toEqual(brief);
    expect(withIntegrationConflict(context, NODE, null, () => view())).toBeNull();
  });
});
