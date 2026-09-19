import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "@moe/store";
import { createNodeIntegration } from "../orchestrator/node-integration.js";
import type { LandedBranch } from "../orchestrator/node-integration.js";
import { ensureNodeTree, forgetNodeTrees } from "../orchestrator/node-worktrees.js";
import { createRepositoryExecutionPort } from "./repository-execution-port.js";
import { nodeCommitMerged, readIntegrationRecords, readRepositoryIntegration } from "./repository-integration-read.js";

const roots: string[] = [];
const stores: SqliteEventStore[] = [];
afterEach(() => {
  forgetNodeTrees();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

/** The real integrator writes the records this read folds; only a merge's name is ever hand-written, to pin how it is served. */
function world() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "moe-integration-read-"))); roots.push(workspace);
  git(workspace, "init", "--quiet");
  git(workspace, "config", "user.email", "read@example.test");
  git(workspace, "config", "user.name", "Read Fixture");
  git(workspace, "config", "core.autocrlf", "false");
  writeFileSync(join(workspace, "shared.txt"), "base\n", "utf8");
  git(workspace, "add", "shared.txt");
  git(workspace, "commit", "--quiet", "-m", "base");
  const store = SqliteEventStore.openForProject(
    join(realpathSync(mkdtempSync(join(tmpdir(), "moe-integration-read-store-"))), "store.sqlite"), "project-a");
  stores.push(store);
  const landed: LandedBranch[] = [];
  const integration = createNodeIntegration({
    candidates: () => landed, clock: () => "2026-09-16T10:00:00.000Z",
    controller: { controllerId: "controller-a", controllerPid: 101 },
    projectId: "project-a", repository: createRepositoryExecutionPort(), store, storeId: "store-a", workspace,
  });
  const landedNode = (nodeRef: string, file: string, body: string): LandedBranch => {
    const tree = ensureNodeTree({ nodeRef, projectRoot: workspace });
    if (tree === null) throw new Error("expected a tree");
    writeFileSync(join(tree.path, file), body, "utf8");
    git(tree.path, "add", file);
    git(tree.path, "commit", "--quiet", "-m", `${nodeRef} work`);
    const entry = { branch: tree.branch, fromTree: true, nodeRef, sha: git(tree.path, "rev-parse", "HEAD") };
    landed.push(entry);
    return entry;
  };
  /** A NodeBranchMerged record in the integrator's own shape, naming the merge as it is told to. */
  const recordedMerge = (entry: LandedBranch, mergeSha: string | null): void => {
    const aggregateId = `repository-integration/${createHash("sha256").update("project-a", "utf8").digest("hex")}`;
    const version = store.getAggregateVersion(aggregateId);
    const commandId = `rin-fixture-${String(version)}`;
    const facts = { at: "2026-09-16T10:00:00.000Z", branch: entry.branch, mergeSha, nodeRef: entry.nodeRef, projectId: "project-a", sha: entry.sha, version: "moe-repository-integration/1" };
    store.commit({ aggregateId, commandBytes: new TextEncoder().encode(JSON.stringify({ eventType: "NodeBranchMerged" })), commandId,
      committedAt: "2026-09-16T10:00:00.000Z", expectedVersion: version,
      events: [{ eventId: `${commandId}-e1`, eventType: "NodeBranchMerged", payload: new TextEncoder().encode(JSON.stringify(facts)) }] });
  };
  return { integration, landed, landedNode, recordedMerge, store, workspace };
}

/** What became of each node's branch (owner decision 2026-09-16). */
describe("reading the integration of the nodes' branches", () => {
  it("reads a branch nobody has merged yet as waiting", () => {
    const w = world();
    const entry = w.landedNode("node:v1:alpha", "alpha.txt", "alpha\n");

    expect(readRepositoryIntegration(w.store, "project-a", w.landed)).toEqual({
      branches: [{ branch: entry.branch, conflictPaths: [], mergeSha: null, nodeRef: entry.nodeRef, sha: entry.sha, state: "WAITING" }],
      projectId: "project-a", version: "moe-repository-integration-read/1",
    });
  }, 120_000);

  it("reads a merged branch with the merge it made, and a conflicted one with its paths", async () => {
    const w = world();
    const first = w.landedNode("node:v1:one", "shared.txt", "one edits the shared line\n");
    const second = w.landedNode("node:v1:two", "shared.txt", "two edits the same line\n");

    await w.integration.integrateOnce();

    const view = readRepositoryIntegration(w.store, "project-a", w.landed);
    expect(view.branches.map((branch) => branch.state)).toEqual(["MERGED", "CONFLICTED"]);
    expect(view.branches[0]).toMatchObject({ conflictPaths: [], nodeRef: first.nodeRef, sha: first.sha });
    expect(view.branches[0]?.mergeSha).toBe(git(w.workspace, "rev-parse", "HEAD"));
    expect(view.branches[1]).toMatchObject({ conflictPaths: ["shared.txt"], mergeSha: null, nodeRef: second.nodeRef, sha: second.sha });
  }, 120_000);

  it("serves no merged row without the name of its merge, which the surface holds every merge to", () => {
    const w = world();
    const named = w.landedNode("node:v1:alpha", "alpha.txt", "alpha\n");
    const unnamed = w.landedNode("node:v1:beta", "beta.txt", "beta\n");
    const blank = w.landedNode("node:v1:gamma", "gamma.txt", "gamma\n");
    const waiting = w.landedNode("node:v1:delta", "delta.txt", "delta\n");
    w.recordedMerge(named, "a".repeat(40));
    // A merge the integrator could not name, and one a daemon before this fix left with an empty name.
    w.recordedMerge(unnamed, null);
    w.recordedMerge(blank, "");

    // Served as MERGED with no name, one row would cost the operator's surface the whole read.
    expect(readRepositoryIntegration(w.store, "project-a", w.landed).branches).toEqual([
      { branch: named.branch, conflictPaths: [], mergeSha: "a".repeat(40), nodeRef: named.nodeRef, sha: named.sha, state: "MERGED" },
      { branch: waiting.branch, conflictPaths: [], mergeSha: null, nodeRef: waiting.nodeRef, sha: waiting.sha, state: "WAITING" },
    ]);
  }, 120_000);

  it("answers the merged question and the view from one walk, the latest record at a commit winning", async () => {
    const w = world();
    w.landedNode("node:v1:one", "shared.txt", "one edits the shared line\n");
    const second = w.landedNode("node:v1:two", "shared.txt", "two edits the same line\n");
    await w.integration.integrateOnce();
    expect(nodeCommitMerged(w.store, "project-a", second.nodeRef, second.sha)).toBe(false);
    // What the integrator's reconciliation writes once Git holds the commit: a merge with no name.
    w.recordedMerge(second, null);

    const records = readIntegrationRecords(w.store, "project-a");

    expect(records.whole).toBe(true);
    expect(records.merged(second.nodeRef, second.sha)).toBe(true);
    expect(records.merged(second.nodeRef, "0".repeat(40))).toBe(false);
    expect(nodeCommitMerged(w.store, "project-a", second.nodeRef, second.sha)).toBe(true);
    // The conflict is superseded, and a merge with no name is still served as nothing.
    expect(records.view(w.landed).branches.map((branch) => [branch.nodeRef, branch.state])).toEqual([["node:v1:one", "MERGED"]]);
    expect(records.view(w.landed)).toEqual(readRepositoryIntegration(w.store, "project-a", w.landed));
  }, 120_000);

  // The aggregate gains a record per merge, conflict and reconciliation and is never compacted. At the
  // 1001st the one-page read refused the whole walk: every merge read as unrecorded, for good, in silence.
  it("reads past the store's one-page ceiling: the 1001st record answers, and the walk is whole", () => {
    const w = world();
    const aggregateId = `repository-integration/${createHash("sha256").update("project-a", "utf8").digest("hex")}`;
    const encoder = new TextEncoder();
    const nodeOf = (index: number): string => `node:v1:n${String(index)}`;
    const shaOf = (index: number): string => String(index).padStart(40, "0");
    for (let from = 0; from < 1001; from += 250) {
      w.store.commit({ aggregateId, commandBytes: encoder.encode(JSON.stringify({ eventType: "NodeBranchMerged" })), commandId: `rin-bulk-${String(from)}`,
        committedAt: "2026-09-16T10:00:00.000Z", expectedVersion: w.store.getAggregateVersion(aggregateId),
        events: Array.from({ length: Math.min(250, 1001 - from) }, (_unused, offset) => ({ eventId: `rin-bulk-${String(from + offset)}-e1`, eventType: "NodeBranchMerged",
          payload: encoder.encode(JSON.stringify({ at: "2026-09-16T10:00:00.000Z", branch: `moe/n${String(from + offset)}`, mergeSha: null, nodeRef: nodeOf(from + offset),
            projectId: "project-a", sha: shaOf(from + offset), version: "moe-repository-integration/1" })) })) });
    }
    // THE MEASURED CEILING: the store refuses this aggregate as one page.
    expect(() => w.store.readEvents(aggregateId)).toThrow();

    const records = readIntegrationRecords(w.store, "project-a");

    expect(records.whole).toBe(true);
    expect([0, 999, 1000].map((index) => records.merged(nodeOf(index), shaOf(index)))).toEqual([true, true, true]);
    expect(records.merged(nodeOf(1001), shaOf(1001))).toBe(false);
    expect(nodeCommitMerged(w.store, "project-a", nodeOf(1000), shaOf(1000))).toBe(true);
    // A page that says "more" and does not move on is a read that failed, never the end of the records.
    const stuck = { readAggregateEvents: () => ({ hasMore: true, items: [], nextCursor: null }) } as unknown as SqliteEventStore;
    expect(readIntegrationRecords(stuck, "project-a").whole).toBe(false);
  }, 120_000);

  it("reads nothing for a project whose nodes landed nothing", () => {
    const w = world();
    expect(readRepositoryIntegration(w.store, "project-a", [])).toEqual({
      branches: [], projectId: "project-a", version: "moe-repository-integration-read/1",
    });
  }, 120_000);
});
