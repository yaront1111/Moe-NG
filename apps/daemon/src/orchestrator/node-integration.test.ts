import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeCommitMerged, readRepositoryIntegration } from "../repository/repository-integration-read.js";
import type { LandedBranch } from "./node-integration.js";
import { closeWorlds, git, realGit, world } from "./node-integration-test-fixtures.js";
import type { World } from "./node-integration-test-fixtures.js";

// The world itself (real checkout, real trees, real store, the production integrator) is in
// node-integration-test-fixtures.ts: this file had reached the size this repository splits at.
afterEach(closeWorlds);

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
    let reads = 0;
    const w = world((cwd, args) => {
      // The first read is the HEAD the merge starts from; the SECOND is the first ask for the merge's name.
      if (args[0] === "rev-parse" && args[1] === "HEAD" && (reads += 1) === 2) return { code: 1, stdout: "" };
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
  const mergedByHand = (w: World, nodeRef: string): LandedBranch => {
    const entry = w.landedNode(nodeRef, `${nodeRef.slice(8)}.txt`, `${nodeRef}\n`);
    git(w.workspace, "merge", "--no-ff", "--no-edit", entry.sha);
    return entry;
  };
  /** Another owner takes the checkout; the answer gives it back. */
  const heldByAnother = (w: World): (() => void) => {
    const owner = { projectId: "project-a", nodeRef: "node-holder", ownershipToken: "c".repeat(64), storeId: "store-a" };
    const held = w.port.acquire(w.workspace, owner, { controllerId: "controller-b", controllerPid: 102 });
    if (!held.ok) throw new Error(held.code);
    return () => { expect(w.port.release(w.workspace, owner, held.handle.reservation.revision, "YIELDED", "controller-b").ok).toBe(true); };
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
    const asked: string[] = [];
    let unreadable = false;
    const w = world((cwd, args) => {
      asked.push(args[0] ?? "");
      return unreadable && args[0] === "status" ? { code: 128, stderr: "fatal: the checkout could not be read", stdout: "" } : realGit(cwd, args);
    });
    // Nothing pending.
    const alpha = mergedByHand(w, "node:v1:alpha");
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(alpha)]);
    // A branch is pending and another owner holds the checkout.
    const beta = w.landedNode("node:v1:beta", "beta.txt", "beta\n");
    const gamma = mergedByHand(w, "node:v1:gamma");
    heldByAnother(w);
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(gamma)]);
    // The project checkout cannot be read: the line for the record just written is said once, here or never.
    const zeta = mergedByHand(w, "node:v1:zeta");
    unreadable = true;
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(zeta),
      { nodeRef: beta.nodeRef, outcome: "UNAVAILABLE", detail: "the project checkout could not be read" }]);
    unreadable = false;
    // The checkout holds uncommitted work.
    const delta = mergedByHand(w, "node:v1:delta");
    writeFileSync(join(w.workspace, "shared.txt"), "the operator is editing this\n", "utf8");
    expect((await w.integration.integrateOnce()).map((report) => report.outcome)).toEqual(["MERGED", "SKIPPED"]);
    // A conflict is parked. The record at the same commit as a conflict supersedes it: latest wins.
    const epsilon = mergedByHand(w, "node:v1:epsilon");
    w.recorded("NodeBranchConflicted", { at: "2026-09-16T09:00:00.000Z", branch: beta.branch, nodeRef: beta.nodeRef, paths: ["beta.txt"], projectId: "project-a", sha: beta.sha });
    w.recorded("NodeBranchConflicted", { at: "2026-09-16T09:00:00.000Z", branch: epsilon.branch, nodeRef: epsilon.nodeRef, paths: ["epsilon.txt"], projectId: "project-a", sha: epsilon.sha });
    const reads = w.calls["readAggregateEvents"] ?? 0;
    const probes = asked.filter((verb) => verb === "merge-base").length;
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(epsilon)]);
    // Five contained branches and a pending one cost the pass ONE walk of the aggregate (one page), not one each,
    expect((w.calls["readAggregateEvents"] ?? 0) - reads).toBe(1);
    // and ONE is-ancestor each: those spawns are what a pass costs, on every pass, for every landed node.
    expect(asked.filter((verb) => verb === "merge-base").length - probes).toBe(6);
    expect(w.events().filter((event) => event.type === "NodeBranchMerged").map((event) => [event.facts["nodeRef"], event.facts["mergeSha"]]))
      .toEqual([alpha, gamma, zeta, delta, epsilon].map((entry) => [entry.nodeRef, null]));
    expect(nodeCommitMerged(w.store, "project-a", epsilon.nodeRef, epsilon.sha)).toBe(true);
    // One refused try at the held checkout in all of it, and the pending branch is still unmerged.
    expect(w.acquisitions()).toBe(1);
    expect(existsSync(join(w.workspace, "beta.txt"))).toBe(false);
  }, 120_000);

  it("takes only Git's exact yes for evidence, and invents no merge for a sha the branch held all along", async () => {
    let answers = false;
    const w = world((cwd, args) => args[0] === "merge-base" && !answers ? { code: 128, stderr: "fatal: Git never answered", stdout: "" } : realGit(cwd, args));
    const alpha = mergedByHand(w, "node:v1:alpha");
    // The pass ends at the hold, so no merge of its own is there to record: an is-ancestor that never answered records nothing.
    const release = heldByAnother(w);
    expect(await w.integration.integrateOnce()).toEqual([]);
    expect(w.events()).toEqual([]);
    // THE CONTROL: the same world, once Git answers.
    answers = true;
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(alpha)]);
    // The checkout is free and is-ancestor is silent again, so the pass falls through to the merge. Git
    // says "Already up to date" (exit 0) and HEAD does not move: this used to be reported "merged" and
    // recorded with HEAD, an unrelated commit, as its merge commit, once more on every such pass.
    const beta = mergedByHand(w, "node:v1:beta");
    const head = git(w.workspace, "rev-parse", "HEAD");
    answers = false;
    release();
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(beta)]);
    expect(git(w.workspace, "rev-parse", "HEAD")).toBe(head);
    // alpha went the same way in that pass and already had its record: nothing is written twice.
    expect(w.events().map((event) => [event.facts["nodeRef"], event.facts["mergeSha"]])).toEqual([[alpha.nodeRef, null], [beta.nodeRef, null]]);
    expect(await w.integration.integrateOnce()).toEqual([]);
    expect(w.events()).toHaveLength(2);
  }, 120_000);

  // moe-next's own project branch is `moe/work-<date>`: every in-place landing there is a candidate by
  // its spelling and already contained. Both gates are satisfied where it landed, so nothing reads a record.
  it("leaves a landing made in the project's own checkout alone: no record, no line, no walk of the aggregate", async () => {
    const w = world();
    git(w.workspace, "switch", "--quiet", "-c", "moe/work-2026-09-18");
    writeFileSync(join(w.workspace, "in-place.txt"), "landed in place\n", "utf8");
    git(w.workspace, "add", "in-place.txt");
    git(w.workspace, "commit", "--quiet", "-m", "landed in place");
    const inPlace = { branch: "moe/work-2026-09-18", fromTree: false, nodeRef: "node:v1:in-place", sha: git(w.workspace, "rev-parse", "HEAD") };
    w.landed.push(inPlace);
    expect(await w.integration.integrateOnce()).toEqual([]);
    expect(w.events()).toEqual([]);
    expect(w.calls["readAggregateEvents"] ?? 0).toBe(0);
    // Beside a tree's branch the pass has a merge to take, and still writes nothing for the in-place landing.
    const alpha = w.landedNode("node:v1:alpha", "alpha.txt", "alpha\n");
    expect((await w.integration.integrateOnce()).map((report) => [report.nodeRef, report.outcome])).toEqual([[alpha.nodeRef, "MERGED"]]);
    expect(w.events().map((event) => event.facts["nodeRef"])).toEqual([alpha.nodeRef]);
    // THE CONTROL: the same commit, had it been landed from a node's tree, is a record a gate waits on.
    w.landed.splice(0, 1, { ...inPlace, fromTree: true });
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(inPlace)]);
  }, 120_000);

  it("writes nothing over records it could not read: 'no record' is never inferred from 'unreadable'", async () => {
    const w = world();
    const entry = mergedByHand(w, "node:v1:alpha");
    expect(await w.integration.integrateOnce()).toEqual([reconciledLine(entry)]);
    // A read that fails hides the record just written; the write itself would still succeed, every pass.
    w.refusals["readAggregateEvents"] = 1;
    expect(await w.integration.integrateOnce()).toEqual([]);
    expect(w.refusals["readAggregateEvents"]).toBe(0);
    expect(w.events()).toHaveLength(1);
  }, 120_000);
});
