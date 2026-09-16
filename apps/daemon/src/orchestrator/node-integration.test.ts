import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "@moe/store";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { ensureNodeTree, forgetNodeTrees } from "./node-worktrees.js";
import { createNodeIntegration } from "./node-integration.js";
import type { LandedBranch } from "./node-integration.js";

const roots: string[] = [];
const stores: SqliteEventStore[] = [];
afterEach(() => {
  forgetNodeTrees();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

function world() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "moe-integration-"))); roots.push(workspace);
  git(workspace, "init", "--quiet");
  git(workspace, "config", "user.email", "integration@example.test");
  git(workspace, "config", "user.name", "Integration Fixture");
  // Line endings are pinned so a checkout reads the same bytes on every host.
  git(workspace, "config", "core.autocrlf", "false");
  writeFileSync(join(workspace, "shared.txt"), "base\n", "utf8");
  git(workspace, "add", "shared.txt");
  git(workspace, "commit", "--quiet", "-m", "base");
  const store = SqliteEventStore.openForProject(join(realpathSync(mkdtempSync(join(tmpdir(), "moe-integration-store-"))), "store.sqlite"), "project-a");
  stores.push(store);
  const port = createRepositoryExecutionPort();
  const landed: LandedBranch[] = [];
  const integration = createNodeIntegration({
    candidates: () => landed, clock: () => "2026-09-16T10:00:00.000Z",
    controller: { controllerId: "controller-a", controllerPid: 101 },
    projectId: "project-a", repository: port, store, storeId: "store-a", workspace,
  });
  /** A node that coded in its own tree and landed one commit on its own branch. */
  const landedNode = (nodeRef: string, file: string, body: string): LandedBranch => {
    const tree = ensureNodeTree({ nodeRef, projectRoot: workspace });
    if (tree === null) throw new Error("expected a tree");
    writeFileSync(join(tree.path, file), body, "utf8");
    git(tree.path, "add", file);
    git(tree.path, "commit", "--quiet", "-m", `${nodeRef} work`);
    const entry = { branch: tree.branch, nodeRef, sha: git(tree.path, "rev-parse", "HEAD") };
    landed.push(entry);
    return entry;
  };
  const events = (): readonly { type: string; facts: Record<string, unknown> }[] => {
    const rows = store.readEvents(`repository-integration/${createHash("sha256").update("project-a", "utf8").digest("hex")}`);
    return rows.map((row) => ({ facts: JSON.parse(new TextDecoder().decode(row.payload)) as Record<string, unknown>, type: row.eventType }));
  };
  return { events, integration, landed, landedNode, port, store, workspace };
}

/** Where parallel nodes meet again (owner decision 2026-09-16). */
describe("integrating the nodes' branches", () => {
  it("merges every landed branch into the project's branch, once", async () => {
    const w = world();
    const first = w.landedNode("node:v1:alpha", "alpha.txt", "alpha\n");
    const second = w.landedNode("node:v1:beta", "beta.txt", "beta\n");

    const reports = await w.integration.integrateOnce();

    expect(reports.map((entry) => entry.outcome)).toEqual(["MERGED", "MERGED"]);
    expect(existsSync(join(w.workspace, "alpha.txt"))).toBe(true);
    expect(existsSync(join(w.workspace, "beta.txt"))).toBe(true);
    expect(git(w.workspace, "merge-base", "--is-ancestor", first.sha, "HEAD")).toBe("");
    expect(git(w.workspace, "merge-base", "--is-ancestor", second.sha, "HEAD")).toBe("");
    expect(w.events().map((entry) => entry.type)).toEqual(["NodeBranchMerged", "NodeBranchMerged"]);
    // The checkout is given back, so a seat or a publish can take it next.
    expect(w.port.inspect(w.workspace)).toEqual({ ok: true, reservation: null });

    expect(await w.integration.integrateOnce()).toEqual([]);
    expect(w.events()).toHaveLength(2);
  }, 120_000);

  it("aborts a conflicting merge whole, records it, and leaves the project branch untouched", async () => {
    const w = world();
    w.landedNode("node:v1:one", "shared.txt", "one edits the shared line\n");
    w.landedNode("node:v1:two", "shared.txt", "two edits the same line\n");
    const before = git(w.workspace, "rev-parse", "HEAD");

    const reports = await w.integration.integrateOnce();

    expect(reports.map((entry) => entry.outcome)).toEqual(["MERGED", "CONFLICT"]);
    expect(reports[1]?.detail).toContain("shared.txt");
    // Aborted whole: no merge state, and the branch still points at the first merge only.
    expect(existsSync(join(w.workspace, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(w.workspace, "rev-parse", "HEAD")).not.toBe(before);
    expect(readFileSync(join(w.workspace, "shared.txt"), "utf8")).toBe("one edits the shared line\n");
    expect(w.events().map((entry) => entry.type)).toEqual(["NodeBranchMerged", "NodeBranchConflicted"]);
    expect(w.events()[1]?.facts["paths"]).toEqual(["shared.txt"]);
    expect(w.port.inspect(w.workspace)).toEqual({ ok: true, reservation: null });
  }, 120_000);

  it("leaves a checkout that holds uncommitted work alone", async () => {
    const w = world();
    w.landedNode("node:v1:alpha", "alpha.txt", "alpha\n");
    writeFileSync(join(w.workspace, "shared.txt"), "the operator is editing this\n", "utf8");

    const reports = await w.integration.integrateOnce();

    expect(reports.map((entry) => entry.outcome)).toEqual(["SKIPPED"]);
    expect(existsSync(join(w.workspace, "alpha.txt"))).toBe(false);
    expect(w.events()).toEqual([]);
  }, 120_000);

  it("waits for a checkout another owner holds", async () => {
    const w = world();
    w.landedNode("node:v1:alpha", "alpha.txt", "alpha\n");
    const held = w.port.acquire(w.workspace, { projectId: "project-a", nodeRef: "node-holder",
      ownershipToken: "c".repeat(64), storeId: "store-a" }, { controllerId: "controller-b", controllerPid: 102 });
    expect(held.ok).toBe(true);

    expect(await w.integration.integrateOnce()).toEqual([]);

    expect(existsSync(join(w.workspace, "alpha.txt"))).toBe(false);
    expect(w.events()).toEqual([]);
  }, 120_000);

  it("has nothing to do without landed work", async () => {
    const w = world();
    expect(await w.integration.integrateOnce()).toEqual([]);
    expect(w.port.inspect(w.workspace)).toEqual({ ok: true, reservation: null });
  }, 120_000);
});
