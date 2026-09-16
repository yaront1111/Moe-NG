import { describe, expect, it } from "vitest";
import { mapRepositoryIntegrationAnswer } from "./live-integration.js";

const branch = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  branch: "moe/node-alpha-1234abcd", conflictPaths: [], mergeSha: null,
  nodeRef: "node:v1:alpha", sha: "a".repeat(40), state: "WAITING", ...patch,
});
const view = (branches: readonly Record<string, unknown>[]): Record<string, unknown> =>
  ({ branches, projectId: "project-a", version: "moe-repository-integration-read/1" });

/** The section reads what the daemon recorded, or nothing (owner decision 2026-09-16). */
describe("reading what became of the nodes' branches", () => {
  it("reads a waiting, a merged and a conflicted branch", () => {
    const answer = mapRepositoryIntegrationAnswer(200, view([
      branch(),
      branch({ mergeSha: "b".repeat(40), nodeRef: "node:v1:beta", state: "MERGED" }),
      branch({ conflictPaths: ["src/shared.ts"], nodeRef: "node:v1:gamma", state: "CONFLICTED" }),
    ]));

    expect(answer.status).toBe("INTEGRATION");
    if (answer.status !== "INTEGRATION") throw new Error("expected a view");
    expect(answer.view.branches.map((entry) => entry.state)).toEqual(["WAITING", "MERGED", "CONFLICTED"]);
    expect(answer.view.branches[1]?.mergeSha).toBe("b".repeat(40));
    expect(answer.view.branches[2]?.conflictPaths).toEqual(["src/shared.ts"]);
  });

  it.each([
    ["an unknown version", 200, { ...view([]), version: "moe-repository-integration-read/2" }],
    ["a missing field", 200, { branches: [], projectId: "project-a" }],
    ["a state it does not know", 200, view([branch({ state: "MERGING" })])],
    ["a merge with no merge commit", 200, view([branch({ state: "MERGED" })])],
    ["a merge that also carries conflicts", 200, view([branch({ conflictPaths: ["a.ts"], mergeSha: "b".repeat(40), state: "MERGED" })])],
    ["a conflict that carries a merge commit", 200, view([branch({ conflictPaths: ["a.ts"], mergeSha: "b".repeat(40), state: "CONFLICTED" })])],
    ["a waiting branch carrying conflicts", 200, view([branch({ conflictPaths: ["a.ts"] })])],
    ["one node named twice", 200, view([branch(), branch()])],
    ["a status that is not 200", 500, view([])],
  ])("reads %s as invalid", (_label, status, body) => {
    expect(mapRepositoryIntegrationAnswer(status, body))
      .toMatchObject({ status: "ERROR", code: "REPOSITORY_INTEGRATION_RESPONSE_INVALID", layer: "CONTROL_ROOM_INTEGRATION" });
  });

  it("passes a daemon refusal through as it was stated", () => {
    expect(mapRepositoryIntegrationAnswer(200, {
      code: "REPOSITORY_INTEGRATION_READ_UNAVAILABLE", layer: "REPOSITORY_WORKFLOW_READ", outcome: "REFUSED",
    })).toMatchObject({ status: "REFUSED", code: "REPOSITORY_INTEGRATION_READ_UNAVAILABLE" });
  });
});
