import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dependencySatisfied } from "../http/dependency-integration.js";
import { createGitLandingPort } from "../repository/git-landing-port.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { landedWithNoEffect, landingReceiptId } from "../repository/landing-receipt-contracts.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { readRepositoryLandingEvidence } from "../repository/repository-landing-intent.js";
import { recoveryEvidenceFixture } from "../repository/repository-recovery-test-fixtures.js";
import type { VerifiedWorkspaceBinding } from "../repository/verified-workspace-contracts.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import { closeStores, hex64 } from "../review/review-test-fixtures.js";
import { createNodeIntegration, runGit } from "./node-integration.js";
import type { IntegrationGit } from "./node-integration.js";
import { landedNodeBranches } from "./node-landed-branches.js";
import { LANDING_ADOPTION_UNPROVEN, adoptedSeatCommit } from "./node-lander-adopt.js";
import { createNodeLander } from "./node-lander.js";

/**
 * A SEAT-AUTHORED COMMIT ON A NODE BRANCH IS A LANDING (UnAI 2026-09-19). Every lander arm runs
 * against a real scratch repository with a real linked worktree, the real landing port and the
 * real verified-workspace port: the defect was a clean tree read as "owed no bytes", and only Git
 * can say whether a clean tree's HEAD is work the project's branch still lacks. When Git does NOT
 * say, that is a third answer (UNPROVEN), never "owed no bytes": nothing is recorded or credited.
 */
const roots: string[] = [];
afterEach(() => {
  closeStores();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
}).trim();
const commit = (cwd: string, who: string, subject: string) =>
  git(cwd, "-c", `user.name=${who}`, "-c", `user.email=${who}@example.test`, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", subject);

/** A project on `trunk` with one commit, and the node's own linked worktree cut from it. */
function scratch(branch = "moe/x"): { readonly base: string; readonly root: string; readonly tree: string } {
  const root = mkdtempSync(join(tmpdir(), "moe-lander-adopt-")); roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=trunk");
  // The integrator's merge commit needs an author, and the project's own checkout must bind with a
  // tree inside it: every hosted project carries this exclusion (runtime-metadata-excludes.ts).
  for (const [key, value] of [["user.name", "Moe"], ["user.email", "moe@moe.local"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]] as const) git(root, "config", key, value);
  mkdirSync(join(root, ".git", "info"), { recursive: true });
  appendFileSync(join(root, ".git", "info", "exclude"), "/.moe-next/\n");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "--", "base.txt");
  commit(root, "Operator", "initial");
  const tree = join(root, ".moe-next", "trees", "x");
  mkdirSync(join(root, ".moe-next", "trees"), { recursive: true });
  git(root, "worktree", "add", "--quiet", "-b", branch, tree, "trunk");
  return { base: git(root, "rev-parse", "HEAD"), root, tree };
}

/** The seat commits its own work in its tree and leaves the tree clean. */
function seatCommits(tree: string, file = "feature.txt"): string {
  writeFileSync(join(tree, file), `${file} by the seat\n`);
  git(tree, "add", "--", file);
  commit(tree, "Seat", `seat: ${file}`);
  return git(tree, "rev-parse", "HEAD");
}

/** Capture the tree as the verifier would, accept it through the production ledgers, build the lander. */
async function accepted(tree: string, projectRoot: string | null) {
  const workspace = createVerifiedWorkspacePort();
  const captured = await workspace.capture(tree);
  if (!captured.ok) throw new Error(captured.code);
  const f = recoveryEvidenceFixture({ binding: captured.binding });
  const effects = { commits: 0 };
  const nodeRef = f.handle.owner.nodeRef;
  const lander = (overrides: { readonly projectRoot?: string; readonly receiptId?: string } = {}) => createNodeLander({
    store: f.store, projectId: f.handle.owner.projectId, reservationHandle: f.handle, projectRoot: overrides.projectRoot ?? projectRoot,
    baselineId: () => f.baseline.baselineId, git: createGitLandingPort(), nodes: () => [{ nodeRef }],
    nodeMission: () => ({ title: "Node", instructions: "build", test: "approved-check", workspace: captured.binding.root }),
    verifiedWorkspace: { capture: workspace.capture, commit: async (...args) => { effects.commits += 1; return workspace.commit(...args); } },
    ...(overrides.receiptId === undefined ? {} : {
      readAccepted: () => ({ verifierReceiptId: overrides.receiptId as string }), readVerifiedBinding: () => captured.binding,
    }),
  });
  const receipt = (receiptId = f.verified.receipt.receiptId) => {
    const read = readLandingReceipt(f.store, f.handle.owner.projectId, landingReceiptId(f.handle.owner.projectId, nodeRef, receiptId));
    if (!read.ok) throw new Error(read.code);
    return read.receipt;
  };
  /** Whether goal closure, the dependency gate and publication would count this node as having owed no bytes. */
  const credited = (): boolean => {
    const reviews = readReviewLedgers(f.store, f.handle.owner.projectId, new Set([nodeRef]));
    const landing = reviews.landings.get(nodeRef);
    return landing !== undefined && landedWithNoEffect(landing, reviews.landingIntents);
  };
  return { binding: captured.binding, credited, effects, f, lander, nodeRef, receipt };
}

describe("the lander adopts a seat-authored commit", () => {
  it("(1) records a seat commit on a clean node tree as COMMITTED at the tree's HEAD, with no Git effect and no landing intent", async () => {
    const { base, root, tree } = scratch();
    const seat = seatCommits(tree);
    const w = await accepted(tree, root);

    const reports = await w.lander().landOnce();

    expect(reports).toEqual([{ nodeRef: w.nodeRef, outcome: "COMMITTED",
      detail: `${seat.slice(0, 10)} on moe/x, 1 file(s), adopted from the seat's own commit` }]);
    expect(w.receipt()).toMatchObject({ outcome: "COMMITTED", refusal: null, workspace: w.binding.root,
      commit: { branch: "moe/x", files: ["feature.txt"], parentSha: base, sha: seat } });
    // NO Git effect: the port's commit was never asked, no intent was journaled, the tree did not move.
    expect(w.effects.commits).toBe(0);
    expect(readRepositoryLandingEvidence(w.f.store, w.f.handle)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_EVIDENCE_MISSING" });
    expect(git(tree, "rev-parse", "HEAD")).toBe(seat);
    expect(git(tree, "status", "--porcelain")).toBe("");
    // One landing per acceptance still holds.
    expect(await w.lander().landOnce()).toEqual([]);
  }, 120_000);

  it("(2) keeps NOTHING_TO_COMMIT, and its no-effect credit, for a tree HEAD the project's HEAD already contains", async () => {
    const { root, tree } = scratch();
    seatCommits(tree);
    git(root, "-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false", "merge", "--quiet", "--no-ff", "--no-edit", "moe/x");
    const w = await accepted(tree, root);

    expect(await w.lander().landOnce()).toMatchObject([{ outcome: "REFUSED", detail: expect.stringContaining("NOTHING_TO_COMMIT") }]);

    expect(w.receipt()).toMatchObject({ commit: null, refusal: { code: "NOTHING_TO_COMMIT" } });
    expect(w.credited()).toBe(true);
  }, 120_000);

  // Adoption is decided by WHERE the commit was made, as the dependency gate decides (http/
  // dependency-integration.ts), never by how the branch is spelled: this used to be NOTHING_TO_COMMIT,
  // credited, with the seat's commit on `wip` merged by nobody.
  it("(3) adopts a commit on a branch the seat renamed inside its tree, and the integrator merges it by sha", async () => {
    const { base, root, tree } = scratch();
    git(tree, "switch", "--quiet", "-c", "wip");
    const seat = seatCommits(tree);
    const w = await accepted(tree, root);
    expect(w.binding.branchRef).toBe("refs/heads/wip");

    expect(await w.lander().landOnce()).toEqual([{ nodeRef: w.nodeRef, outcome: "COMMITTED",
      detail: `${seat.slice(0, 10)} on wip, 1 file(s), adopted from the seat's own commit` }]);

    expect(w.receipt()).toMatchObject({ outcome: "COMMITTED", commit: { branch: "wip", files: ["feature.txt"], parentSha: base, sha: seat } });
    const projectId = w.f.handle.owner.projectId;
    // The PRODUCTION candidates: what the integrator is offered is what the dependency gate waits on.
    const candidates = () => landedNodeBranches(w.f.store, projectId, [{ nodeRef: w.nodeRef }]);
    expect(candidates()).toEqual([{ branch: "wip", fromTree: true, nodeRef: w.nodeRef, sha: seat }]);
    expect(dependencySatisfied(w.f.store, projectId, w.nodeRef)).toBe(false);
    const integration = createNodeIntegration({ candidates, clock: () => "2026-09-19T12:00:00.000Z",
      controller: { controllerId: "controller-adopt", controllerPid: process.pid }, projectId,
      repository: createRepositoryExecutionPort(), store: w.f.store, storeId: "store-adopt", workspace: root });
    expect(await integration.integrateOnce()).toMatchObject([{ nodeRef: w.nodeRef, outcome: "MERGED" }]);
    expect(readFileSync(join(root, "feature.txt"), "utf8")).toBe("feature.txt by the seat\n");
    expect(dependencySatisfied(w.f.store, projectId, w.nodeRef)).toBe(true);
  }, 120_000);

  // ON PURPOSE: a seat sent back over a conflict that resolves nothing is accepted at the SAME sha.
  // Crediting that NOTHING_TO_COMMIT would read as delivered while the branch is never merged.
  it("(4) adopts the previously landed sha again, under the new receipt id, while it is still unmerged", async () => {
    const { root, tree } = scratch();
    const seat = seatCommits(tree);
    const w = await accepted(tree, root);
    expect(await w.lander().landOnce()).toMatchObject([{ outcome: "COMMITTED" }]);
    const second = hex64("b2");
    expect(second).not.toBe(w.f.verified.receipt.receiptId);

    expect(await w.lander({ receiptId: second }).landOnce()).toMatchObject([{ outcome: "COMMITTED" }]);

    expect(w.receipt(second)).toMatchObject({ outcome: "COMMITTED", verifierReceiptId: second, commit: { branch: "moe/x", sha: seat } });
    expect(w.receipt().commit?.sha).toBe(seat);
    expect(w.effects.commits).toBe(0);
  }, 120_000);

  // "Could not establish whether work remains" was recorded NOTHING_TO_COMMIT, which goal closure,
  // the dependency gate and publication all credit, while the commit sat in the tree unmerged.
  it("(5) records NOTHING while Git cannot say whether the commit is merged (a real exit 128), credits nothing, and adopts once Git answers", async () => {
    const { root } = scratch();
    // A tree whose OWN project has never seen the seat's commit: a clone standing where a tree stands
    // keeps its own objects, so `merge-base --is-ancestor` in the project exits 128, not 1. (A checkout
    // that is not the tree's project is no longer asked at all: Git is asked where the tree belongs.)
    const tree = join(root, ".moe-next", "trees", "y");
    // Line endings are pinned AT the checkout: set afterwards, the host's own setting has already made base.txt dirt.
    git(root, "clone", "--quiet", "-c", "core.autocrlf=false", root, tree);
    git(tree, "switch", "--quiet", "-c", "moe/y");
    const seat = seatCommits(tree);
    const w = await accepted(tree, root);
    const projectId = w.f.handle.owner.projectId;

    for (const pass of [1, 2]) {
      expect(await w.lander().landOnce(), `pass ${String(pass)}`).toEqual([{ nodeRef: w.nodeRef, outcome: LANDING_ADOPTION_UNPROVEN,
        detail: `merge-base --is-ancestor ${seat} HEAD exited 128, which proves neither answer` }]);
    }

    expect(readLandingReceipt(w.f.store, projectId, landingReceiptId(projectId, w.nodeRef, w.f.verified.receipt.receiptId)))
      .toEqual({ code: "LANDING_RECEIPT_NOT_FOUND", ok: false });
    expect(w.credited()).toBe(false);
    expect(dependencySatisfied(w.f.store, projectId, w.nodeRef)).toBe(false);
    // The acceptance was not consumed, so the pass on which Git answers lands it: the project fetches the commit.
    git(root, "fetch", "--quiet", tree, "moe/y");
    expect(await w.lander().landOnce()).toMatchObject([{ outcome: "COMMITTED" }]);
    expect(w.receipt()).toMatchObject({ outcome: "COMMITTED", refusal: null, commit: { branch: "moe/y", sha: seat } });
    expect(w.effects.commits).toBe(0);
  }, 120_000);

  it("(6) lands a seat commit PLUS dirt the ordinary way: one plumbing commit whose parent is the seat's", async () => {
    const { root, tree } = scratch();
    const seat = seatCommits(tree);
    writeFileSync(join(tree, "dirt.txt"), "left uncommitted by the seat\n");
    const w = await accepted(tree, root);

    expect(await w.lander().landOnce()).toMatchObject([{ outcome: "COMMITTED", detail: expect.not.stringContaining("adopted") }]);

    const landed = git(tree, "rev-parse", "HEAD");
    expect(landed).not.toBe(seat);
    expect(git(tree, "rev-parse", "HEAD^")).toBe(seat);
    expect(w.receipt()).toMatchObject({ outcome: "COMMITTED", commit: { branch: "moe/x", files: ["dirt.txt"], parentSha: seat, sha: landed } });
    expect(w.effects.commits).toBe(1);
    expect(readRepositoryLandingEvidence(w.f.store, w.f.handle)).toMatchObject({ ok: true });
  }, 120_000);

  // The truth from before node trees: a commit made in a workspace that is no node's tree is already on
  // its own branch. A separate single-tree repository a spec names (`spec.workspace`) was asked about
  // in the configured project's checkout, which cannot reach its sha: 128 on every pass, no receipt,
  // the reservation AWAITING_LANDING for good, and every node briefed into that repository behind it.
  it("(7) keeps NOTHING_TO_COMMIT, and its credit, for a commit made where no node tree is: the project's OWN checkout, and a separate repository", async () => {
    const shared = scratch();
    seatCommits(shared.root);
    const inProject = await accepted(shared.root, shared.root);
    expect(await inProject.lander().landOnce()).toMatchObject([{ outcome: "REFUSED", detail: expect.stringContaining("NOTHING_TO_COMMIT") }]);
    expect(inProject.receipt()).toMatchObject({ commit: null, refusal: { code: "NOTHING_TO_COMMIT" } });
    expect(inProject.credited()).toBe(true);

    const separate = scratch();
    seatCommits(separate.root);
    const elsewhere = await accepted(separate.root, shared.root);
    expect(await elsewhere.lander().landOnce()).toMatchObject([{ outcome: "REFUSED", detail: expect.stringContaining("NOTHING_TO_COMMIT") }]);
    expect(elsewhere.receipt()).toMatchObject({ commit: null, refusal: { code: "NOTHING_TO_COMMIT" } });
    expect(elsewhere.credited()).toBe(true);
  }, 120_000);

  // Node trees do not depend on a configured project root (MOE_NODE_TREES cuts one under the mission's
  // own workspace). "No root, so no trees" was an inference, and this arm used to PIN its wrong credit.
  it("(8) adopts a seat commit in a real node tree with NO project root configured, asking Git in the project the tree belongs to", async () => {
    const { base, tree } = scratch();
    const seat = seatCommits(tree);
    const w = await accepted(tree, null);

    expect(await w.lander().landOnce()).toEqual([{ nodeRef: w.nodeRef, outcome: "COMMITTED",
      detail: `${seat.slice(0, 10)} on moe/x, 1 file(s), adopted from the seat's own commit` }]);
    expect(w.receipt()).toMatchObject({ outcome: "COMMITTED", refusal: null, commit: { branch: "moe/x", files: ["feature.txt"], parentSha: base, sha: seat } });
    expect(w.credited()).toBe(false);
    expect(w.effects.commits).toBe(0);
  }, 120_000);
});

describe("adoptedSeatCommit", () => {
  const SHA = "a".repeat(40);
  const PARENT = "b".repeat(40);
  const binding: VerifiedWorkspaceBinding = { branchRef: "refs/heads/moe/x", dirtySha256: "d".repeat(64), headSha: SHA,
    root: "D:/ws/project/.moe-next/trees/x", treeSha: "2".repeat(40), version: "moe-verified-workspace/1" };
  /** Git answering `merge-base` with `ancestry`, `diff --quiet` by whether `names` is empty, the name list with `names`, and `rev-parse` with the parent. */
  const answering = (ancestry: number, names: string, calls: string[][] = []): IntegrationGit => (cwd, args) => {
    calls.push([cwd, ...args]);
    if (args[0] === "merge-base") return { code: ancestry, stdout: "" };
    if (args[0] === "diff") return args[1] === "--quiet" ? { code: names === "" ? 0 : 1, stdout: "" } : { code: 0, stdout: names };
    return { code: 0, stdout: `${PARENT}\n` };
  };

  const noGit: IntegrationGit = () => { throw new Error("this answer asks Git nothing"); };
  const UNPROVEN_128 = { kind: "UNPROVEN", detail: `merge-base --is-ancestor ${SHA} HEAD exited 128, which proves neither answer` };

  it("adopts only on exit 1 exactly: 0 is PROVEN merged, and any other code is UNPROVEN, never no-effect", () => {
    const calls: string[][] = [];
    expect(adoptedSeatCommit(answering(1, "a.ts\0dir/b c.ts\0", calls), "D:/ws/project", binding, "message\n"))
      .toEqual({ kind: "ADOPT", commit: { branch: "moe/x", files: ["a.ts", "dir/b c.ts"], message: "message\n", parentSha: PARENT, sha: SHA } });
    // Asked in the PROJECT's checkout, as configured, against its HEAD: `--quiet` decides, then the three-dot names.
    expect(calls).toEqual([
      ["D:/ws/project", "merge-base", "--is-ancestor", SHA, "HEAD"],
      ["D:/ws/project", "diff", "--quiet", `HEAD...${SHA}`],
      ["D:/ws/project", "diff", "--name-only", "-z", "--no-renames", `HEAD...${SHA}`],
      ["D:/ws/project", "rev-parse", "--verify", "--quiet", `${SHA}^`],
    ]);
    expect(adoptedSeatCommit(answering(0, "a.ts\0"), "D:/ws/project", binding, "message\n"))
      .toEqual({ kind: "NO_EFFECT", detail: `the project's HEAD already contains ${SHA}` });
    for (const code of [2, 128, 129]) {
      expect(adoptedSeatCommit(answering(code, "a.ts\0"), "D:/ws/project", binding, "message\n"))
        .toEqual({ kind: "UNPROVEN", detail: `merge-base --is-ancestor ${SHA} HEAD exited ${String(code)}, which proves neither answer` });
    }
  });

  // A timeout or a spawn failure carries no exit status. runGit reported that as 1, which is
  // `merge-base --is-ancestor`'s own "no": a Git that never answered read as "not merged".
  it("reads a Git that never answered as 128, never as merge-base's own 1", () => {
    const missing = join(tmpdir(), "moe-adopt-no-such-directory");
    expect(runGit(missing, ["merge-base", "--is-ancestor", SHA, "HEAD"]).code).toBe(128);
    expect(adoptedSeatCommit(runGit, missing, { ...binding, root: join(missing, ".moe-next", "trees", "x") }, "m")).toEqual(UNPROVEN_128);
  });

  // Each of these answered null, and every null was recorded NOTHING_TO_COMMIT and credited.
  it("answers NO_EFFECT only on proof: a diff Git called identical, or a workspace that is no node's tree, which asks Git nothing", () => {
    expect(adoptedSeatCommit(answering(1, ""), "D:/ws/project", binding, "m"))
      .toEqual({ kind: "NO_EFFECT", detail: `${SHA} adds no path to the project's branch` });
    // ONE RULE: the project's own checkout, a separate single-tree repository, with a root configured
    // or none. A commit made there is already on its own branch, and a foreign checkout could only answer 128.
    for (const [projectRoot, root] of [["D:/ws/project", "D:/ws/./project"], ["D:/ws/project", "D:/ws/other"], [null, "D:/ws/other"]] as const) {
      expect(adoptedSeatCommit(noGit, projectRoot, { ...binding, root }, "m"))
        .toMatchObject({ kind: "NO_EFFECT", detail: expect.stringContaining("no node's own tree") });
    }
  });

  // "No root configured, so no trees" and "the configured root is this tree's project" were both
  // inferences: a tree says where it belongs by its own path, three levels up.
  it("asks Git in the project the tree belongs to when no root is configured, or the configured one is another project", () => {
    for (const projectRoot of [null, "D:/ws/another-project"]) {
      const calls: string[][] = [];
      expect(adoptedSeatCommit(answering(1, "a.ts\0", calls), projectRoot, binding, "m")).toMatchObject({ kind: "ADOPT", commit: { files: ["a.ts"], sha: SHA } });
      expect(calls.map(([cwd]) => cwd)).toEqual(Array.from({ length: 4 }, () => resolve("D:/ws/project")));
      expect(adoptedSeatCommit(answering(128, "a.ts\0"), projectRoot, binding, "m")).toEqual(UNPROVEN_128);
    }
  });

  it("answers UNPROVEN, naming what could not be established, for a failed diff, an unborn HEAD and unmerged work on no branch", () => {
    expect(adoptedSeatCommit((_cwd, args) => ({ code: args[0] === "diff" ? 128 : 1, stdout: "a.ts\0" }), "D:/ws/project", binding, "m"))
      .toEqual({ kind: "UNPROVEN", detail: `git diff HEAD...${SHA} exited 128, so what the commit adds is unknown` });
    expect(adoptedSeatCommit(noGit, "D:/ws/project", { ...binding, headSha: null }, "m"))
      .toEqual({ kind: "UNPROVEN", detail: "the node's tree has an unborn HEAD, so nothing says where its work is" });
    // A detached HEAD (the withdrawal scan reads one as ""): no receipt can carry it, and it is never no-effect.
    // Git DID prove the work, and says so: the withdrawal, which writes no receipt, reads `workProven` as found.
    const detached: string[][] = [];
    expect(adoptedSeatCommit(answering(1, "a.ts\0", detached), "D:/ws/project", { ...binding, branchRef: "" }, "m"))
      .toEqual({ kind: "UNPROVEN", workProven: true, detail: `${SHA} holds work the project lacks but HEAD names no branch, and a landing receipt must name one` });
    // Decided on `--quiet` alone: no name is read for an answer that names none.
    expect(detached.map(([, verb, flag]) => `${verb ?? ""} ${flag ?? ""}`)).toEqual(["merge-base --is-ancestor", "diff --quiet"]);
    // Exit 0 is proof whatever HEAD is called.
    expect(adoptedSeatCommit(answering(0, ""), "D:/ws/project", { ...binding, branchRef: "" }, "m")).toMatchObject({ kind: "NO_EFFECT" });
  });

  it("adopts by WHERE the commit was made: a tree's commit on a branch that is not moe/ is still the node's work", () => {
    for (const branch of ["main", "not-moe/x", "wip"]) {
      expect(adoptedSeatCommit(answering(1, "a.ts\0"), "D:/ws/project", { ...binding, branchRef: `refs/heads/${branch}` }, "m"))
        .toMatchObject({ kind: "ADOPT", commit: { branch, files: ["a.ts"], sha: SHA } });
    }
  });

  it("records a root commit with no parent, and caps the names it records at 2000", () => {
    const rootless: IntegrationGit = (_cwd, args) => args[0] === "rev-parse" ? { code: 1, stdout: "" }
      : { code: args[0] === "merge-base" || args[1] === "--quiet" ? 1 : 0, stdout: Array.from({ length: 2001 }, (_unused, index) => `f${String(index)}.ts`).join("\0") };
    const adopted = adoptedSeatCommit(rootless, "D:/ws/project", binding, "m");
    if (adopted.kind !== "ADOPT") throw new Error(adopted.detail);
    expect(adopted.commit.parentSha).toBeNull();
    expect(adopted.commit.files).toHaveLength(2000);
  });

  // A commit naming more than runGit's 4 MiB buffer (vendored code, build output) fails the name read
  // with no exit status, which reads as 128: that was UNPROVEN "git diff exited 128" on every pass, for
  // good. The DECISION is `--quiet`'s; the names are best-effort, and a name is never invented.
  it("adopts on Git's own 'differs' when the full name list cannot be read, naming the top-level paths instead", () => {
    const BASE = "c".repeat(40);
    const calls: string[][] = [];
    const overflowing = (topLevel: { readonly code: number; readonly stdout: string }): IntegrationGit => (_cwd, args) => {
      calls.push([...args]);
      if (args[0] === "merge-base") return args[1] === "--is-ancestor" ? { code: 1, stdout: "" } : { code: 0, stdout: `${BASE}\n` };
      // The buffer overflowed mid-name: what did arrive is never used.
      if (args[0] === "diff") return args[1] === "--quiet" ? { code: 1, stdout: "" } : { code: 128, stdout: "vendor/a.ts\0vendor/b" };
      return args[0] === "diff-tree" ? topLevel : { code: 0, stdout: `${PARENT}\n` };
    };
    expect(adoptedSeatCommit(overflowing({ code: 0, stdout: "README.md\0vendor\0" }), "D:/ws/project", binding, "m"))
      .toEqual({ kind: "ADOPT", commit: { branch: "moe/x", files: ["README.md", "vendor"], message: "m", parentSha: PARENT, sha: SHA } });
    // The fallback asks for the top level only: no `-r`, between the merge base and the seat's commit.
    expect(calls.slice(3, 5)).toEqual([["merge-base", "HEAD", SHA], ["diff-tree", "--name-only", "-z", BASE, SHA]]);
    // No list at all: work is proven, no receipt can be written, and the reason names the limit, not "exited 128".
    const answer = adoptedSeatCommit(overflowing({ code: 128, stdout: "" }), "D:/ws/project", binding, "m");
    expect(answer).toMatchObject({ kind: "UNPROVEN", workProven: true, detail: expect.stringContaining("4 MiB output limit") });
    expect(answer.kind === "UNPROVEN" && answer.detail).not.toContain("exited 128");
  });
});
