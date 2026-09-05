import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitCommitReceipt } from "./git-landing-port.js";
import type { VerifiedWorkspaceBinding } from "./verified-workspace-contracts.js";
import { sameVerifiedWorkspace } from "./verified-workspace-contracts.js";
import { captureVerifiedWorkspace, parseVerifiedTree } from "./git-verified-workspace-capture.js";
import { attemptVerifiedGit, failVerifiedGit, gitHead, literalPaths, objectId, verifiedGit } from "./git-verified-workspace-runtime.js";
import type { VerifiedGitContext } from "./git-verified-workspace-runtime.js";

function validPaths(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.length <= 20_000 && new Set(paths).size === paths.length && paths.every((path) =>
    path.length > 0 && !/[\u0000\\]/u.test(path) && !path.startsWith("/") && !/^[a-z]:/iu.test(path)
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git"));
}

async function prepareDeliveredTree(context: VerifiedGitContext, paths: readonly string[], binding: VerifiedWorkspaceBinding): Promise<string> {
  await verifiedGit(context, binding.headSha === null ? ["read-tree", "--empty"] : ["read-tree", binding.headSha], context.index);
  const baseTree = (await verifiedGit(context, ["write-tree"], context.index)).trim();
  const changed = (await verifiedGit(context, ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", baseTree, binding.treeSha]))
    .split("\0").filter(Boolean);
  const exact = new Set(changed);
  if (exact.size !== paths.length || !paths.every((path) => exact.has(path))) failVerifiedGit("VERIFIED_WORKSPACE_PATHS_MISMATCH");
  await verifiedGit(context, ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], context.index, `${literalPaths(paths).join("\0")}\0`);
  if ((await verifiedGit(context, ["write-tree"], context.index)).trim() !== binding.treeSha) failVerifiedGit("VERIFIED_WORKSPACE_PATHS_MISMATCH");
  return baseTree;
}

/** The standard Git index.lock excludes concurrent Git index writers without touching their staged entries. */
async function prepareIndex(context: VerifiedGitContext, lock: string, paths: readonly string[], binding: VerifiedWorkspaceBinding, baseTree: string): Promise<void> {
  const realIndex = join(context.gitDirectory, "index");
  if (existsSync(realIndex)) writeFileSync(lock, readFileSync(realIndex));
  else {
    const emptyIndex = join(context.scratch, "empty-index");
    await verifiedGit(context, ["read-tree", "--empty"], emptyIndex);
    writeFileSync(lock, readFileSync(emptyIndex));
  }
  const staged = await attemptVerifiedGit(context, ["diff-index", "--cached", "--quiet", baseTree, "--", ...literalPaths(paths)], lock);
  if (staged.code === 1) failVerifiedGit("VERIFIED_WORKSPACE_INDEX_CONFLICT");
  if (staged.code !== 0) failVerifiedGit("VERIFIED_WORKSPACE_GIT_FAILED");
  const entries = parseVerifiedTree(await verifiedGit(context, ["ls-tree", "-r", "-z", "--full-tree", binding.treeSha, "--", ...literalPaths(paths)]));
  const zeros = "0".repeat(binding.treeSha.length);
  const removed = paths.map((path) => `0 ${zeros}\t${path}\0`).join("");
  const present = entries.map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join("");
  await verifiedGit(context, ["update-index", "-z", "--index-info"], lock, removed + present);
}

export async function commitVerifiedWorkspace(context: VerifiedGitContext, paths: readonly string[], message: string, binding: VerifiedWorkspaceBinding): Promise<GitCommitReceipt> {
  if (!validPaths(paths)) failVerifiedGit("VERIFIED_WORKSPACE_PATH_INVALID");
  const current = await captureVerifiedWorkspace(context);
  if (!sameVerifiedWorkspace(current, binding)) failVerifiedGit("VERIFIED_WORKSPACE_DRIFT");
  const baseTree = await prepareDeliveredTree(context, paths, binding);
  const lock = join(context.gitDirectory, "index.lock");
  try { closeSync(openSync(lock, "wx", 0o600)); }
  catch { return failVerifiedGit("VERIFIED_WORKSPACE_INDEX_LOCKED"); }
  let refUpdated = false;
  let headGuard = false;
  let completed = false;
  const headLock = join(context.gitDirectory, "HEAD.lock");
  try {
    await prepareIndex(context, lock, paths, binding, baseTree);
    const args = ["-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false", "commit-tree", binding.treeSha,
      ...(binding.headSha === null ? [] : ["-p", binding.headSha])];
    const sha = (await verifiedGit(context, args, undefined, message)).trim();
    if (!objectId(sha)) failVerifiedGit("VERIFIED_WORKSPACE_GIT_FAILED");
    // CAS the explicit bound branch, never an implicitly dereferenced HEAD. The index
    // lock excludes ordinary checkout; an independent HEAD change is detected below.
    const commands = `start\nupdate ${binding.branchRef} ${sha} ${binding.headSha ?? "0".repeat(sha.length)}\nprepare\ncommit\n`;
    refUpdated = true;
    const moved = await attemptVerifiedGit(context, ["update-ref", "--no-deref", "--stdin"], undefined, commands);
    if (moved.code !== 0) {
      // A timeout/error can arrive after the ref actually moved. Only a known refusal and
      // unchanged original HEAD permit retry; a missing child result always retains the lock.
      try {
        const observed = await gitHead(context);
        refUpdated = moved.code === null || observed.headSha !== binding.headSha || observed.branchRef !== binding.branchRef;
      } catch { /* The update outcome stays unknown. */ }
      failVerifiedGit(refUpdated ? "VERIFIED_WORKSPACE_REF_UPDATE_UNKNOWN" : "VERIFIED_WORKSPACE_REF_CONFLICT");
    }
    // Git's CAS needs its own HEAD.lock, so acquire ours only after that command exits.
    // The fresh observation below detects a pointer change during the lock handoff;
    // this guard then excludes symbolic-ref writers through index reconciliation.
    try { closeSync(openSync(headLock, "wx", 0o600)); headGuard = true; }
    catch { failVerifiedGit("VERIFIED_WORKSPACE_REF_UPDATE_UNKNOWN"); }
    const landedHead = await gitHead(context);
    if (landedHead.branchRef !== binding.branchRef || landedHead.headSha !== sha) failVerifiedGit("VERIFIED_WORKSPACE_REF_UPDATE_UNKNOWN");
    try { renameSync(lock, join(context.gitDirectory, "index")); }
    catch { failVerifiedGit("VERIFIED_WORKSPACE_INDEX_RECONCILIATION_FAILED"); }
    completed = true;
    return Object.freeze({ branch: binding.branchRef.slice("refs/heads/".length), parentSha: binding.headSha, sha });
  } finally {
    // After a ref update, an unreconciled index lock is retained as a fail-closed recovery boundary.
    if (!refUpdated && existsSync(lock)) unlinkSync(lock);
    if (headGuard && completed) unlinkSync(headLock);
  }
}
