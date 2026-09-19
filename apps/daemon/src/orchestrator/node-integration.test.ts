import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "@moe/store";
import type { RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { nodeCommitMerged, readRepositoryIntegration } from "../repository/repository-integration-read.js";
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
  /** The integrator's store counts its calls and refuses `refusals[method]` more of them. The instance is sealed, so no spy lies on it. */
  const refusals: Record<string, number> = {};
  const calls: Record<string, number> = {};
  const refusing = new Proxy(store, { get(target, property): unknown {
    const held: unknown = Reflect.get(target, property, target);
    if (typeof held !== "function") return held;
    return (...args: unknown[]): unknown => {
      calls[String(property)] = (calls[String(property)] ?? 0) + 1;
      if ((refusals[String(property)] ?? 0) > 0) { refusals[String(property)]! -= 1; throw new Error("the store is busy"); }
      return (held as (...inner: unknown[]) => unknown).apply(target, args);
    };
  } });
  const integration = createNodeIntegration({
    candidates: () => landed, clock: () => "2026-09-16T10:00:00.000Z",
    controller: { controllerId: "controller-a", controllerPid: 101 },
    ...(runner === undefined ? {} : { git: runner }),
    projectId: "project-a", repository, store: refusing, storeId: "store-a", workspace,
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
  return { acquisitions: () => acquisitions, calls, events, integration, landed, landedNode, port, recorded, refusals, store, workspace };
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

  /** Moe's own tracked runtime file, committed and then edited by the operator (UnAI 2026-09-19). */
  const editedStartScript = (workspace: string): string => {
    const script = join(workspace, ".moe-next", "start.ps1");
    mkdirSync(join(workspace, ".moe-next"), { recursive: true });
    writeFileSync(script, "moe start\n", "utf8");
    git(workspace, "add", "-f", ".moe-next/start.ps1");
    git(workspace, "commit", "--quiet", "-m", "track the start script");
    writeFileSync(script, "moe start --the-operator-changed-this\n", "utf8");
    return script;
  };

  it("does not take an edit to Moe's own tracked runtime file for uncommitted work: the merge is taken", async () => {
    const w = world();
    const script = editedStartScript(w.workspace);
    const entry = w.landedNode("node:v1:alpha", "alpha.txt", "alpha\n");
    // Beside product dirt the checkout is still left alone: the runtime file excuses only itself.
    writeFileSync(join(w.workspace, "shared.txt"), "the operator is editing this\n", "utf8");
    expect((await w.integration.integrateOnce()).map((report) => report.outcome)).toEqual(["SKIPPED"]);
    git(w.workspace, "checkout", "--", "shared.txt");

    const reports = await w.integration.integrateOnce();

    expect(reports.map((report) => report.outcome)).toEqual(["MERGED"]);
    expect(git(w.workspace, "merge-base", "--is-ancestor", entry.sha, "HEAD")).toBe("");
    // The operator's edit is neither merged over nor committed: it is still theirs, still uncommitted.
    expect(readFileSync(script, "utf8")).toBe("moe start --the-operator-changed-this\n");
    expect(git(w.workspace, "status", "--porcelain", "--untracked-files=no").trim()).toBe("M .moe-next/start.ps1");
  }, 120_000);

  it("leaves a merge that would write over the edited runtime file to Git, which refuses it whole", async () => {
    const w = world();
    const script = editedStartScript(w.workspace);
    w.landedNode("node:v1:alpha", ".moe-next/start.ps1", "moe start --the-node-changed-this\n");
    const before = git(w.workspace, "rev-parse", "HEAD");

    const reports = await w.integration.integrateOnce();

    expect(reports.map((report) => report.outcome)).toEqual(["UNAVAILABLE"]);
    expect(reports[0]?.detail).toContain("would be overwritten by merge");
    expect(w.events()).toEqual([]);
    expect(git(w.workspace, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(script, "utf8")).toBe("moe start --the-operator-changed-this\n");
    expect(w.port.inspect(w.workspace)).toEqual({ ok: true, reservation: null });
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

/** A merge Git holds and no record names: never merged again, while the dependency gate and the publication credit wait on the record. */
describe("reconciling a merge that has no record", () => {
  const reconciledLine = (entry: LandedBranch) => ({ nodeRef: entry.nodeRef, outcome: "MERGED",
    detail: `${entry.branch} ${entry.sha.slice(0, 10)} was already on the project branch; its missing record was written` });
  const mergedByHand = (w: ReturnType<typeof world>, nodeRef: string): LandedBranch => {
    const entry = w.landedNode(nodeRef, `${nodeRef.slice(8)}.txt`, `${nodeRef}\n`);
    git(w.workspace, "merge", "--no-ff", "--no-edit", entry.sha);
    return entry;
  };
  const heldByAnother = (w: ReturnType<typeof world>): void => {
    expect(w.port.acquire(w.workspace, { projectId: "project-a", nodeRef: "node-holder", ownershipToken: "c".repeat(64),
      storeId: "store-a" }, { controllerId: "controller-b", controllerPid: 102 }).ok).toBe(true);
  };

  it("says a real merge lost its record, retries in silence while the store refuses, and writes it once", async () => {
    const w = world();
    const entry = w.landedNode("node:v1:alpha", "alpha.txt", "alpha\n");
    w.refusals["commit"] = 2;
    const first = await w.integration.integrateOnce();
    // Git took the merge and the store refused its record: the report says both.
    expect(git(w.workspace, "merge-base", "--is-ancestor", entry.sha, "HEAD")).toBe("");
    expect(first.map((report) => [report.outcome, report.detail])).toEqual([["MERGED",
      `${entry.branch} ${entry.sha.slice(0, 10)} merged; the record could not be written and is retried next pass`]]);
    // The store refuses again: nothing written, and nothing said every pass while it does.
    expect(await w.integration.integrateOnce()).toEqual([]);
    expect(w.events()).toEqual([]);
    expect(nodeCommitMerged(w.store, "project-a", entry.nodeRef, entry.sha)).toBe(false);
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(entry)]);
    // The merge commit is unknown by now, and never invented.
    expect(w.events().map((event) => [event.type, event.facts["sha"], event.facts["mergeSha"]])).toEqual([["NodeBranchMerged", entry.sha, null]]);
    expect(nodeCommitMerged(w.store, "project-a", entry.nodeRef, entry.sha)).toBe(true);
    // Written once: a later pass writes nothing and reports nothing.
    expect(await w.integration.integrateOnce()).toEqual([]);
    expect(w.events()).toHaveLength(1);
    expect(w.acquisitions()).toBe(1);
  }, 120_000);

  it("records a branch the owner merged by hand, behind every state that stops a merge", async () => {
    const w = world();
    // Nothing pending.
    const alpha = mergedByHand(w, "node:v1:alpha");
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(alpha)]);
    // A branch is pending and another owner holds the checkout.
    const beta = w.landedNode("node:v1:beta", "beta.txt", "beta\n");
    const gamma = mergedByHand(w, "node:v1:gamma");
    heldByAnother(w);
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(gamma)]);
    // The checkout holds uncommitted work.
    const delta = mergedByHand(w, "node:v1:delta");
    writeFileSync(join(w.workspace, "shared.txt"), "the operator is editing this\n", "utf8");
    expect((await w.integration.integrateOnce()).map((report) => report.outcome)).toEqual(["MERGED", "SKIPPED"]);
    // A conflict is parked. The record at the same commit as a conflict supersedes it: latest wins.
    const epsilon = mergedByHand(w, "node:v1:epsilon");
    w.recorded("NodeBranchConflicted", { at: "2026-09-16T09:00:00.000Z", branch: beta.branch, nodeRef: beta.nodeRef, paths: ["beta.txt"], projectId: "project-a", sha: beta.sha });
    w.recorded("NodeBranchConflicted", { at: "2026-09-16T09:00:00.000Z", branch: epsilon.branch, nodeRef: epsilon.nodeRef, paths: ["epsilon.txt"], projectId: "project-a", sha: epsilon.sha });
    const reads = w.calls["readEvents"] ?? 0;
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(epsilon)]);
    // Four contained branches and a pending one cost the pass ONE walk of the aggregate, not one each.
    expect((w.calls["readEvents"] ?? 0) - reads).toBe(1);
    expect(w.events().filter((event) => event.type === "NodeBranchMerged").map((event) => [event.facts["nodeRef"], event.facts["mergeSha"]]))
      .toEqual([alpha, gamma, delta, epsilon].map((entry) => [entry.nodeRef, null]));
    expect(nodeCommitMerged(w.store, "project-a", epsilon.nodeRef, epsilon.sha)).toBe(true);
    // One refused try at the held checkout in all of it, and the pending branch is still unmerged.
    expect(w.acquisitions()).toBe(1);
    expect(existsSync(join(w.workspace, "beta.txt"))).toBe(false);
  }, 120_000);

  it("takes only Git's exact yes for evidence: an is-ancestor that never answered records nothing", async () => {
    let answers = false;
    const w = world((cwd, args) => args[0] === "merge-base" && !answers ? { code: 128, stderr: "fatal: Git never answered", stdout: "" } : realGit(cwd, args));
    mergedByHand(w, "node:v1:alpha");
    // The pass ends at the hold, so no merge of its own is there to record.
    heldByAnother(w);
    expect(await w.integration.integrateOnce()).toEqual([]);
    expect(w.events()).toEqual([]);
    // THE CONTROL: the same world, once Git answers.
    answers = true;
    expect((await w.integration.integrateOnce()).map((report) => report.outcome)).toEqual(["MERGED"]);
    expect(w.events()).toHaveLength(1);
  }, 120_000);

  it("writes nothing over records it could not read: 'no record' is never inferred from 'unreadable'", async () => {
    const w = world();
    const entry = mergedByHand(w, "node:v1:alpha");
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(entry)]);
    // A read that fails hides the record just written; the write itself would still succeed, every pass.
    w.refusals["readEvents"] = 1;
    expect(await w.integration.integrateOnce()).toEqual([]);
    expect(w.refusals["readEvents"]).toBe(0);
    expect(w.events()).toHaveLength(1);
  }, 120_000);
});
