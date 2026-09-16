import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryIntegrationOutcome } from "../../live/live-integration.js";
import { IntegrationCard } from "./integration-card.js";

afterEach(cleanup);
const branch = (patch: Partial<{ branch: string; conflictPaths: readonly string[]; mergeSha: string | null;
  nodeRef: string; sha: string; state: "MERGED" | "CONFLICTED" | "WAITING" }> = {}) => ({
  branch: "moe/node-alpha-1234abcd", conflictPaths: [] as readonly string[], mergeSha: null as string | null,
  nodeRef: "node:v1:alpha", sha: "a".repeat(40), state: "WAITING" as const, ...patch,
});
const view = (...branches: ReturnType<typeof branch>[]): RepositoryIntegrationOutcome => ({
  status: "INTEGRATION",
  view: { branches, projectId: "project-a", version: "moe-repository-integration-read/1" },
});

/** What the operator reads about the nodes' branches (owner decision 2026-09-16). */
describe("the integration card", () => {
  it("says what happened to each branch, and names a conflict's paths", () => {
    render(<IntegrationCard outcome={view(
      branch({ mergeSha: "b".repeat(40), nodeRef: "node:v1:merged", state: "MERGED" }),
      branch({ conflictPaths: ["src/shared.ts", "src/other.ts"], nodeRef: "node:v1:stuck", state: "CONFLICTED" }),
      branch({ nodeRef: "node:v1:waiting" }),
    )} />);

    expect(screen.getByTestId("cr.health.integration.node:v1:merged").textContent)
      .toContain("merged into this project's branch as bbbbbbbbbb");
    const stuck = screen.getByTestId("cr.health.integration.node:v1:stuck").textContent ?? "";
    expect(stuck).toContain("conflicts with this project's branch and waits for you");
    expect(stuck).toContain("src/shared.ts, src/other.ts");
    expect(screen.getByTestId("cr.health.integration.node:v1:waiting").textContent).toContain("is waiting to merge");
  });

  it("points at the Publish card rather than offering a push", () => {
    render(<IntegrationCard outcome={view(branch())} />);

    const card = screen.getByTestId("cr.health.integration");
    expect(card.textContent).toContain("Pushing is on the goal's Publish card");
    expect(card.querySelectorAll("button")).toHaveLength(0);
  });

  it("says so while reading, when nothing landed, and when the read refuses", () => {
    render(<IntegrationCard outcome={null} />);
    expect(screen.getByTestId("cr.health.integration").textContent).toContain("Reading node branches");
    cleanup();

    render(<IntegrationCard outcome={view()} />);
    expect(screen.getByTestId("cr.health.integration").textContent).toContain("No node has landed work on a branch of its own");
    cleanup();

    render(<IntegrationCard outcome={{ status: "ERROR", code: "REPOSITORY_INTEGRATION_READ_UNAVAILABLE", layer: "REPOSITORY_WORKFLOW_READ" }} />);
    expect(screen.getByTestId("cr.health.integration.read-refusal").textContent)
      .toContain("REPOSITORY_INTEGRATION_READ_UNAVAILABLE");
  });
});
