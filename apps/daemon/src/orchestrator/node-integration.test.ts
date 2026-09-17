import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "@moe/store";
import type { RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { readRepositoryIntegration } from "../repository/repository-integration-read.js";
import { ensureNodeTree, forgetNodeTrees } from "./node-worktrees.js";
import { createNodeIntegration } from "./node-integration.js";
import type { IntegrationGit, LandedBranch } from "./node-integration.js";

const roots: string[] = [];
const stores: SqliteEventStore[] = [];
afterEach(() => {
  forgetNodeTrees();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
/** The real Git, in the integrator's own shape, for a test that fails one call of it. */
const realGit: IntegrationGit = (cwd, args) => {
  try {
    return { code: 0, stdout: execFileSync("git", [...args], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error: unknown) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stderr: failure.stderr ?? "", stdout: failure.stdout ?? "" };
  }
};

function world(runner?: IntegrationGit) {
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
  let acquisitions = 0;
  const repository: RepositoryExecutionPort = { ...port, acquire: (...args) => { acquisitions += 1; return port.acquire(...args); } };
  const landed: LandedBranch[] = [];
  const integration = createNodeIntegration({
    candidates: () => landed, clock: () => "2026-09-16T10:00:00.000Z",
    controller: { controllerId: "controller-a", controllerPid: 101 },
    ...(runner === undefined ? {} : { git: runner }),
    projectId: "project-a", repository, store, storeId: "store-a", workspace,
  });
  /** A node that coded in its own tree and landed one commit on its own branch (its latest landing counts). */
  const landedNode = (nodeRef: string, file: string, body: string): LandedBranch => {
    const tree = ensureNodeTree({ nodeRef, projectRoot: workspace });
    if (tree === null) throw new Error("expected a tree");
    writeFileSync(join(tree.path, file), body, "utf8");
    git(tree.path, "add", file);
    git(tree.path, "commit", "--quiet", "-m", `${nodeRef} work`);
    const entry = { branch: tree.branch, nodeRef, sha: git(tree.path, "rev-parse", "HEAD") };
    const known = landed.findIndex((candidate) => candidate.nodeRef === nodeRef);
    if (known === -1) landed.push(entry); else landed.splice(known, 1, entry);
    return entry;
  };
  const aggregateId = `repository-integration/${createHash("sha256").update("project-a", "utf8").digest("hex")}`;
  const events = (): readonly { type: string; facts: Record<string, unknown> }[] => {
    const rows = store.readEvents(aggregateId);
    return rows.map((row) => ({ facts: JSON.parse(new TextDecoder().decode(row.payload)) as Record<string, unknown>, type: row.eventType }));
  };
  /** A record in the integrator's own shape, as an earlier pass of this daemon or of one before it left it. */
  const recorded = (eventType: string, facts: Record<string, unknown>): void => {
    const version = store.getAggregateVersion(aggregateId);
    const commandId = `rin-fixture-${String(version)}`;
    store.commit({ aggregateId, commandBytes: new TextEncoder().encode(JSON.stringify({ eventType })), commandId,
      committedAt: "2026-09-16T09:00:00.000Z", expectedVersion: version,
      events: [{ eventId: `${commandId}-e1`, eventType, payload: new TextEncoder().encode(JSON.stringify({ ...facts, version: "moe-repository-integration/1" })) }] });
  };
  return { acquisitions: () => acquisitions, events, integration, landed, landedNode, port, recorded, store, workspace };
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

  it("reports a merge Git stopped for another reason as unavailable, never as a conflict", async () => {
    const w = world();
    w.landedNode("node:v1:alpha", "added.txt", "alpha adds this file\n");
    // The operator's own untracked copy is in the way: not uncommitted work, and not a content conflict.
    writeFileSync(join(w.workspace, "added.txt"), "the operator's own copy\n", "utf8");
    const before = git(w.workspace, "rev-parse", "HEAD");

    const reports = await w.integration.integrateOnce();

    expect(reports.map((entry) => entry.outcome)).toEqual(["UNAVAILABLE"]);
    expect(reports[0]?.detail).toContain("untracked working tree files");
    // Nothing durable says "conflict": there was none, and a node briefed with no paths could answer nothing.
    expect(w.events()).toEqual([]);
    expect(existsSync(join(w.workspace, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(w.workspace, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(w.workspace, "added.txt"), "utf8")).toBe("the operator's own copy\n");
    expect(w.port.inspect(w.workspace)).toEqual({ ok: true, reservation: null });
  }, 120_000);

  it("leaves a recorded conflict to the node's next landing instead of retrying it every pass", async () => {
    const w = world();
    w.landedNode("node:v1:one", "shared.txt", "one edits the shared line\n");
    w.landedNode("node:v1:two", "shared.txt", "two edits the same line\n");
    expect((await w.integration.integrateOnce()).map((entry) => entry.outcome)).toEqual(["MERGED", "CONFLICT"]);
    const head = git(w.workspace, "rev-parse", "HEAD");
    // A third node lands while the conflict is unanswered: it waits behind it.
    w.landedNode("node:v1:three", "three.txt", "three\n");

    expect(await w.integration.integrateOnce()).toEqual([]);
    expect(await w.integration.integrateOnce()).toEqual([]);

    expect(w.events().map((entry) => entry.type)).toEqual(["NodeBranchMerged", "NodeBranchConflicted"]);
    expect(w.acquisitions()).toBe(1);
    expect(git(w.workspace, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(w.workspace, "three.txt"))).toBe(false);

    // The node answers by landing again, on the project's line; only then is its branch tried once more.
    const answered = w.landedNode("node:v1:two", "shared.txt", "one edits the shared line\n");
    const reports = await w.integration.integrateOnce();
    expect(reports.map((entry) => [entry.nodeRef, entry.outcome])).toEqual([["node:v1:two", "MERGED"], ["node:v1:three", "MERGED"]]);
    expect(git(w.workspace, "merge-base", "--is-ancestor", answered.sha, "HEAD")).toBe("");
    expect(w.events().map((entry) => entry.type)).toEqual(["NodeBranchMerged", "NodeBranchConflicted", "NodeBranchMerged", "NodeBranchMerged"]);
  }, 120_000);

  it("records a merge whose commit it could not read as merged with no name, and serves no nameless merge", async () => {
    const w = world((cwd, args) => args[0] === "rev-parse" && args[1] === "HEAD" ? { code: 1, stdout: "" } : realGit(cwd, args));
    const entry = w.landedNode("node:v1:alpha", "alpha.txt", "alpha\n");

    const reports = await w.integration.integrateOnce();

    expect(reports.map((report) => [report.outcome, report.detail.endsWith("; the merge commit could not be read")])).toEqual([["MERGED", true]]);
    expect(git(w.workspace, "merge-base", "--is-ancestor", entry.sha, "HEAD")).toBe("");
    expect(w.events().map((event) => event.type)).toEqual(["NodeBranchMerged"]);
    expect(w.events()[0]?.facts["mergeSha"]).toBeNull();
    // The operator's surface holds that a merge names its merge, and one nameless row would cost it
    // the whole read: a merge this could not name is served as nothing, never as MERGED with no name.
    expect(readRepositoryIntegration(w.store, "project-a", w.landed).branches).toEqual([]);
    // Git holds the merge, so it is never taken a second time for the sake of a name.
    expect(await w.integration.integrateOnce()).toEqual([]);
    expect(w.events()).toHaveLength(1);
  }, 120_000);

  it("asks Git for the merge commit's name a second time before it gives the name up", async () => {
    let withheld = 0;
    const w = world((cwd, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD" && withheld === 0) { withheld += 1; return { code: 1, stdout: "" }; }
      return realGit(cwd, args);
    });
    w.landedNode("node:v1:alpha", "alpha.txt", "alpha\n");

    const reports = await w.integration.integrateOnce();

    const head = git(w.workspace, "rev-parse", "HEAD");
    expect(reports.map((report) => [report.outcome, report.detail.includes("could not be read")])).toEqual([["MERGED", false]]);
    expect(w.events()[0]?.facts["mergeSha"]).toBe(head);
    expect(readRepositoryIntegration(w.store, "project-a", w.landed).branches[0]).toMatchObject({ mergeSha: head, state: "MERGED" });
  }, 120_000);

  it("tries again a conflict an earlier pass recorded with no paths: it names nothing a node could answer", async () => {
    const w = world();
    const entry = w.landedNode("node:v1:alpha", "alpha.txt", "alpha\n");
    // What a pass before this fix wrote when Git stopped a merge for a reason of its own, since cleared.
    w.recorded("NodeBranchConflicted", { at: "2026-09-16T09:00:00.000Z", branch: entry.branch, nodeRef: entry.nodeRef, paths: [], projectId: "project-a", sha: entry.sha });
    expect(readRepositoryIntegration(w.store, "project-a", w.landed).branches[0]).toMatchObject({ conflictPaths: [], state: "CONFLICTED" });

    const reports = await w.integration.integrateOnce();

    expect(reports.map((report) => report.outcome)).toEqual(["MERGED"]);
    expect(existsSync(join(w.workspace, "alpha.txt"))).toBe(true);
    expect(w.events().map((event) => event.type)).toEqual(["NodeBranchConflicted", "NodeBranchMerged"]);
    // The merge at the same commit supersedes the record, so the surface reads what happened.
    expect(readRepositoryIntegration(w.store, "project-a", w.landed).branches[0])
      .toMatchObject({ conflictPaths: [], mergeSha: git(w.workspace, "rev-parse", "HEAD"), state: "MERGED" });
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
