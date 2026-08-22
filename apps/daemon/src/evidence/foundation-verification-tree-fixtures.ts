import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hermeticGitEnvironment } from "@moe/runner";

/**
 * A REAL candidate tree for verification suites: one repository holding exactly
 * the sealed input `pkg/src/base.ts`, committed, clean, at a HEAD the suite's
 * input manifest can name.
 *
 * The verification service binds a caller's candidate root to the durable input
 * manifest through git and a byte-for-byte walk before it activates anything,
 * so a fixture manifest over invented digests and an empty scratch directory can
 * no longer be verified at all. Every suite that mints a receipt through the
 * real service seeds its manifest from a tree made here.
 *
 * SHA-256 objects so the head is 64 hex, as the durable observation validator
 * demands elsewhere; author, committer and dates pinned so two trees of the same
 * bytes share one HEAD; the root realpath'd so an 8.3 TEMP alias never becomes
 * the identity the service compares.
 *
 * Test-tier scaffolding, reached only from `*.test.ts` and sibling fixtures, so
 * it deliberately has no `.js` bridge; `review-test-fixtures.ts` has none either.
 */

export const CANDIDATE_TREE_BASE_PATH = "pkg/src/base.ts";
export const CANDIDATE_TREE_BASE_BYTES = Buffer.from("base-bytes", "utf8");
const GIT_DATE = "2026-08-15T00:00:00Z";
const GIT_IDENTITY = Object.freeze([
  "-c", "user.name=Moe Foundation", "-c", "user.email=foundation@example.invalid",
] as const);

export interface CandidateTree {
  readonly byteLength: number;
  readonly head: string;
  readonly root: string;
  readonly sha256: string;
}

/** One git plumbing call under the runner's hermetic environment plus pinned dates. */
export function runCandidateGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root, encoding: "utf8",
    env: {
      ...hermeticGitEnvironment(process.env), GIT_AUTHOR_DATE: GIT_DATE, GIT_COMMITTER_DATE: GIT_DATE,
    },
    shell: false, windowsHide: true,
  }).trim();
}

/** An empty commit on top of the sealed tree: same bytes, different HEAD. */
export function moveCandidateHead(root: string): string {
  runCandidateGit(root, [
    ...GIT_IDENTITY, "commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", "moved",
  ]);
  return runCandidateGit(root, ["rev-parse", "HEAD"]);
}

/** The caller owns cleanup: the root is reported, never registered anywhere. */
export function materializeCandidateTree(label: string): CandidateTree {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `moe-candidate-${label}-`)));
  mkdirSync(join(root, "pkg", "src"), { recursive: true });
  writeFileSync(join(root, CANDIDATE_TREE_BASE_PATH), CANDIDATE_TREE_BASE_BYTES);
  runCandidateGit(root, ["init", "--object-format=sha256", "--initial-branch=main", "--quiet"]);
  runCandidateGit(root, ["config", "core.autocrlf", "false"]);
  runCandidateGit(root, ["add", "--", CANDIDATE_TREE_BASE_PATH]);
  runCandidateGit(root, [
    ...GIT_IDENTITY, "commit", "--quiet", "--no-gpg-sign", "-m", "sealed input",
  ]);
  return Object.freeze({
    byteLength: CANDIDATE_TREE_BASE_BYTES.byteLength,
    head: runCandidateGit(root, ["rev-parse", "HEAD"]), root,
    sha256: createHash("sha256").update(CANDIDATE_TREE_BASE_BYTES).digest("hex"),
  });
}

/** The input-manifest entry set the tree's bytes seal to. */
export function candidateTreeEntries(tree: CandidateTree): readonly Record<string, unknown>[] {
  return Object.freeze([
    {
      byteLength: tree.byteLength, path: CANDIDATE_TREE_BASE_PATH, producer: { kind: "BASE" },
      sha256: tree.sha256,
    },
  ]);
}
