import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitLandingPort } from "../repository/git-landing-port.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { landedWithNoEffect, landingReceiptId } from "../repository/landing-receipt-contracts.js";
import { readRepositoryLandingEvidence } from "../repository/repository-landing-intent.js";
import { recoveryEvidenceFixture } from "../repository/repository-recovery-test-fixtures.js";
import type { VerifiedWorkspaceBinding } from "../repository/verified-workspace-contracts.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import { closeStores, hex64 } from "../review/review-test-fixtures.js";
import type { IntegrationGit } from "./node-integration.js";
import { adoptedSeatCommit } from "./node-lander-adopt.js";
import { createNodeLander } from "./node-lander.js";

/**
 * A SEAT-AUTHORED COMMIT ON A NODE BRANCH IS A LANDING (UnAI 2026-09-19). Every lander arm runs
 * against a real scratch repository with a real linked worktree, the real landing port and the
 * real verified-workspace port: the defect was a clean tree read as "owed no bytes", and only Git
 * can say whether a clean tree's HEAD is work the project's branch still lacks.
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
  const lander = (overrides: { readonly receiptId?: string } = {}) => createNodeLander({
    store: f.store, projectId: f.handle.owner.projectId, reservationHandle: f.handle, projectRoot,
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
  return { binding: captured.binding, effects, f, lander, nodeRef, receipt };
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
    const reviews = readReviewLedgers(w.f.store, w.f.handle.owner.projectId, new Set([w.nodeRef]));
    expect(landedWithNoEffect(w.receipt(), reviews.landingIntents)).toBe(true);
  }, 120_000);

  it("(3) adopts nothing on a branch that is not moe/, and nothing without a project checkout", async () => {
    const other = scratch("feature/x");
    seatCommits(other.tree);
    const onOtherBranch = await accepted(other.tree, other.root);
    expect(onOtherBranch.binding.branchRef).toBe("refs/heads/feature/x");
    expect(await onOtherBranch.lander().landOnce()).toMatchObject([{ outcome: "REFUSED", detail: expect.stringContaining("NOTHING_TO_COMMIT") }]);
    expect(onOtherBranch.receipt().commit).toBeNull();

    const node = scratch();
    seatCommits(node.tree);
    const noProject = await accepted(node.tree, null);
    expect(noProject.binding.branchRef).toBe("refs/heads/moe/x");
    expect(await noProject.lander().landOnce()).toMatchObject([{ outcome: "REFUSED", detail: expect.stringContaining("NOTHING_TO_COMMIT") }]);
    expect(noProject.receipt().commit).toBeNull();
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

  it("(5) falls back to NOTHING_TO_COMMIT when Git cannot say whether the commit is merged (a real exit 128)", async () => {
    const { tree } = scratch();
    seatCommits(tree);
    // A checkout that has never seen the seat's commit: `merge-base --is-ancestor` exits 128, not 1.
    const stranger = scratch();
    const w = await accepted(tree, stranger.root);

    expect(await w.lander().landOnce()).toMatchObject([{ outcome: "REFUSED", detail: expect.stringContaining("NOTHING_TO_COMMIT") }]);
    expect(w.receipt().commit).toBeNull();
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
});

describe("adoptedSeatCommit", () => {
  const SHA = "a".repeat(40);
  const PARENT = "b".repeat(40);
  const binding: VerifiedWorkspaceBinding = { branchRef: "refs/heads/moe/x", dirtySha256: "d".repeat(64), headSha: SHA,
    root: "D:/ws/project/.moe-next/trees/x", treeSha: "2".repeat(40), version: "moe-verified-workspace/1" };
  /** Git answering `merge-base` with `ancestry`, the diff with `names`, and `rev-parse` with the parent. */
  const answering = (ancestry: number, names: string, calls: string[][] = []): IntegrationGit => (cwd, args) => {
    calls.push([cwd, ...args]);
    if (args[0] === "merge-base") return { code: ancestry, stdout: "" };
    if (args[0] === "diff") return { code: 0, stdout: names };
    return { code: 0, stdout: `${PARENT}\n` };
  };

  it("adopts only on exit 1 exactly: 0 is merged, and any other code proves nothing", () => {
    const calls: string[][] = [];
    expect(adoptedSeatCommit(answering(1, "a.ts\0dir/b c.ts\0", calls), "D:/ws/project", binding, "message\n"))
      .toEqual({ branch: "moe/x", files: ["a.ts", "dir/b c.ts"], message: "message\n", parentSha: PARENT, sha: SHA });
    // Asked in the PROJECT's checkout, against its HEAD, with the three-dot diff.
    expect(calls).toEqual([
      ["D:/ws/project", "merge-base", "--is-ancestor", SHA, "HEAD"],
      ["D:/ws/project", "diff", "--name-only", "-z", "--no-renames", `HEAD...${SHA}`],
      ["D:/ws/project", "rev-parse", "--verify", "--quiet", `${SHA}^`],
    ]);
    for (const code of [0, 2, 128, 129]) {
      expect(adoptedSeatCommit(answering(code, "a.ts\0"), "D:/ws/project", binding, "message\n")).toBeNull();
    }
  });

  it("adopts nothing for an empty diff, a failed diff, an unborn HEAD, a foreign branch or no project", () => {
    const ok = answering(1, "a.ts\0");
    expect(adoptedSeatCommit(answering(1, ""), "D:/ws/project", binding, "m")).toBeNull();
    expect(adoptedSeatCommit((_cwd, args) => ({ code: args[0] === "diff" ? 128 : 1, stdout: "a.ts\0" }), "D:/ws/project", binding, "m")).toBeNull();
    expect(adoptedSeatCommit(ok, "D:/ws/project", { ...binding, headSha: null }, "m")).toBeNull();
    expect(adoptedSeatCommit(ok, "D:/ws/project", { ...binding, branchRef: "refs/heads/main" }, "m")).toBeNull();
    expect(adoptedSeatCommit(ok, "D:/ws/project", { ...binding, branchRef: "refs/heads/not-moe/x" }, "m")).toBeNull();
    expect(adoptedSeatCommit(ok, null, binding, "m")).toBeNull();
  });

  it("records a root commit with no parent, and caps the names it records at 2000", () => {
    const rootless: IntegrationGit = (_cwd, args) => args[0] === "rev-parse" ? { code: 1, stdout: "" }
      : { code: args[0] === "merge-base" ? 1 : 0, stdout: Array.from({ length: 2001 }, (_unused, index) => `f${String(index)}.ts`).join("\0") };
    const adopted = adoptedSeatCommit(rootless, "D:/ws/project", binding, "m");
    expect(adopted?.parentSha).toBeNull();
    expect(adopted?.files).toHaveLength(2000);
  });
});
