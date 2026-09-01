import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { RUNNER_WORKSPACE_ERROR_CODES } from "./workspace-contract.js";
import {
  RUNNER_WORKTREE_LAYERS,
  WORKTREE_ASSIGNMENT_VERSION,
  WORKTREE_RELEASE_DISPOSITIONS,
  WORKTREE_RELEASE_INTENTS,
  deriveWorktreeLeaf,
  deriveWorktreeTarget,
  isContainedByPath,
  isWorktreeFailure,
  worktreeStateRejection,
  type WorktreeAssignment,
  type WorktreeInspection,
  type WorktreeMaterializationRequest,
  type WorktreeReleaseRequest,
  type WorktreeTarget,
} from "./worktree-materializer-contract.js";
import {
  MAX_WORKTREE_COMMAND_BYTES,
  WORKTREE_GIT_TIMEOUT_MS,
  createNodeWorktreeMaterializer,
} from "./worktree-materializer-node.js";

/**
 * The derivation and the state fence are PURE, so they are driven directly —
 * that is the production surface a consumer reaches, not a reimplementation.
 * Everything physical (argv, `worktree add --detach`, realpath containment,
 * porcelain cleanliness, adoption, release) runs against a REAL temporary git
 * repository, because a fake would only prove the fake agrees with itself.
 *
 * Every refusal arm asserts the exact code AND which of the two layers refused.
 */

const scratch: string[] = [];

afterAll(() => {
  for (const path of scratch) rmSync(path, { force: true, recursive: true });
});

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { shell: false, stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function temporaryDirectory(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(root);
  return root;
}

/** A real repository with two commits, so a wrong-base arm has a second base to use. */
function temporaryRepository(objectFormat: "sha1" | "sha256" = "sha1"): {
  readonly root: string;
  readonly commits: readonly string[];
} {
  const root = temporaryDirectory("moe-worktree-src-");
  const git = (...args: readonly string[]): string =>
    execFileSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: "@0 +0000", GIT_COMMITTER_DATE: "@0 +0000" },
      shell: false,
      windowsHide: true,
    });
  git("init", `--object-format=${objectFormat}`, "--initial-branch=main", "--quiet");
  git("config", "user.email", "worktree@example.invalid");
  git("config", "user.name", "Worktree Test");
  // LOCAL config, so BOTH a hermetic reader and an ordinary one agree. On a host
  // with global core.autocrlf=true, a tree checked out by ordinary git holds CRLF
  // while the allocator's hermetic environment (GIT_CONFIG_GLOBAL=NUL) neutralises
  // only the GLOBAL setting and then reads that CRLF as a modification — every
  // adopted tree would look DIRTY for a reason that has nothing to do with the code.
  git("config", "core.autocrlf", "false");
  const commits: string[] = [];
  for (const index of [1, 2]) {
    writeFileSync(join(root, "seed.txt"), `seed ${scratch.length} ${index}\n`);
    git("add", "seed.txt");
    git("commit", "--quiet", "--no-gpg-sign", "-m", `seed ${index}`);
    commits.push(git("rev-parse", "HEAD").trim());
  }
  return { root, commits };
}

function caseDistinctClonePair(sourceRoot: string):
  | { readonly supported: false }
  | { readonly supported: true; readonly lower: string; readonly upper: string } {
  const parent = temporaryDirectory("moe-worktree-owner-case-");
  const lower = join(parent, "repository-owner");
  const upper = join(parent, "REPOSITORY-OWNER");
  git(sourceRoot, "clone", "--no-local", "--quiet", sourceRoot, lower);
  try {
    mkdirSync(upper);
  } catch {
    return { supported: false };
  }
  if (realpathSync(lower) === realpathSync(upper)) return { supported: false };
  git(sourceRoot, "clone", "--no-local", "--quiet", sourceRoot, upper);
  for (const repository of [lower, upper]) {
    git(repository, "config", "core.autocrlf", "false");
  }
  return { supported: true, lower, upper };
}

/** Spaces in the parent are the Windows reality this allocator has to survive. */
function temporaryParent(): string {
  const root = temporaryDirectory("moe-worktree-dst-");
  const parent = join(root, "attempt worktrees");
  mkdirSync(parent, { recursive: true });
  return parent;
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

function worktreeCount(sourceRoot: string): number {
  return git(sourceRoot, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
}

/**
 * Moves the real tree outside the parent and leaves a junction (a symlink on
 * POSIX) behind, so git still reports the registered path while the path's
 * REALPATH now resolves outside worktreeParent. That is the escape a
 * `startsWith` containment check cannot see.
 */
function redirectOutsideParent(assignment: WorktreeAssignment): void {
  const outside = join(temporaryDirectory("moe-worktree-escape-"), assignment.leaf);
  renameSync(assignment.realWorktreePath, outside);
  symlinkSync(outside, assignment.realWorktreePath, "junction");
}

const materializer = createNodeWorktreeMaterializer(process.env);

const PROJECT = "proj-dd087108";
const ATTEMPT = "attempt:7";

function request(
  overrides: Partial<WorktreeMaterializationRequest> = {},
): WorktreeMaterializationRequest {
  return {
    sourceRepositoryRoot: "/srv/source",
    worktreeParent: "/srv/parent",
    projectId: PROJECT,
    attemptId: ATTEMPT,
    baseIdentity: "0".repeat(40),
    ...overrides,
  };
}

function targetOf(input: WorktreeMaterializationRequest): WorktreeTarget {
  const derived = deriveWorktreeTarget(input);
  if (!derived.ok) throw new Error(`expected a derived target, got ${derived.code}`);
  return derived.target;
}

function refusalOf(input: WorktreeMaterializationRequest): {
  readonly code: string;
  readonly layer: string;
} {
  const derived = deriveWorktreeTarget(input);
  if (derived.ok) throw new Error("expected a refusal, got a derived target");
  return { code: derived.code, layer: derived.layer };
}

describe("deriveWorktreeTarget", () => {
  it("derives a byte-identical path from identical inputs", () => {
    expect(targetOf(request()).worktreePath).toBe(targetOf(request()).worktreePath);
    expect(deriveWorktreeLeaf(PROJECT, ATTEMPT)).toBe(deriveWorktreeLeaf(PROJECT, ATTEMPT));
  });

  it("derives a different path for a different attempt identity", () => {
    const first = targetOf(request());
    const second = targetOf(request({ attemptId: "attempt:8" }));
    expect(first.worktreePath).not.toBe(second.worktreePath);
    // And for a different project under the same attempt, so neither identity
    // is a passenger in the digest.
    expect(targetOf(request({ projectId: "proj-other" })).leaf).not.toBe(first.leaf);
  });

  it("embeds both identities in the leaf so a collision needs an identity collision", () => {
    const target = targetOf(request());
    expect(target.leaf).toContain("proj-dd087108");
    expect(target.leaf).toContain("attempt_7");
    expect(target.leaf).toMatch(/-[0-9a-f]{16}$/u);
    expect(target.worktreePath.endsWith(target.leaf)).toBe(true);
    expect(target.worktreePath.startsWith("/srv/parent")).toBe(true);
  });

  it("keeps two identities that slug identically on distinct paths", () => {
    // "attempt:7" and "attempt/7" both slug to "attempt_7": the readable half
    // collides on purpose, and only the digest keeps the two targets apart.
    expect(deriveWorktreeLeaf(PROJECT, "attempt:7").split("-").slice(0, -1)).toEqual(
      deriveWorktreeLeaf(PROJECT, "attempt+7").split("-").slice(0, -1),
    );
    expect(deriveWorktreeLeaf(PROJECT, "attempt:7")).not.toBe(
      deriveWorktreeLeaf(PROJECT, "attempt+7"),
    );
  });

  /**
   * The authority boundary. A caller may hand this seam anything it likes; none
   * of it may reach the derivation. Removing the boundary (threading a caller
   * `targetPath` into the derived location) reddens exactly this case.
   */
  it("ignores every caller-supplied path, ref, branch, flag and environment", () => {
    const hostile = {
      ...request(),
      targetPath: "/tmp/attacker",
      worktreePath: "/tmp/attacker",
      branch: "attacker",
      ref: "refs/heads/attacker",
      checkout: true,
      detach: false,
      command: "git worktree add /tmp/attacker",
      shell: "/bin/sh",
      env: { GIT_DIR: "/tmp/attacker/.git" },
      cleanupPath: "/",
      cwd: "/tmp/attacker",
    } as unknown as WorktreeMaterializationRequest;
    expect(targetOf(hostile).worktreePath).toBe(targetOf(request()).worktreePath);
    expect(JSON.stringify(targetOf(hostile))).not.toContain("attacker");
  });

  it("accepts a 40-hex and a 64-hex base and refuses everything else at the contract", () => {
    expect(targetOf(request({ baseIdentity: "a".repeat(40) })).baseIdentity).toBe("a".repeat(40));
    expect(targetOf(request({ baseIdentity: "b".repeat(64) })).baseIdentity).toBe("b".repeat(64));
    for (const base of ["A".repeat(40), "0".repeat(39), "0".repeat(41), "refs/heads/main", "HEAD"]) {
      expect(refusalOf(request({ baseIdentity: base }))).toEqual({
        code: "RUNNER_WORKSPACE_BASE_IDENTITY_INVALID",
        layer: "WORKTREE_CONTRACT",
      });
    }
  });

  it("refuses a hostile roster of identities and roots with their exact codes", () => {
    const roster: readonly (readonly [Partial<WorktreeMaterializationRequest>, string])[] = [
      [{ sourceRepositoryRoot: "relative/source" }, "RUNNER_WORKSPACE_WORKTREE_SOURCE_INVALID"],
      [{ sourceRepositoryRoot: "" }, "RUNNER_WORKSPACE_WORKTREE_SOURCE_INVALID"],
      [{ sourceRepositoryRoot: "/srv/\0source" }, "RUNNER_WORKSPACE_WORKTREE_SOURCE_INVALID"],
      [{ worktreeParent: "parent" }, "RUNNER_WORKSPACE_WORKTREE_PARENT_INVALID"],
      [{ worktreeParent: "/srv/\0parent" }, "RUNNER_WORKSPACE_WORKTREE_PARENT_INVALID"],
      [{ projectId: "" }, "RUNNER_WORKSPACE_WORKTREE_IDENTITY_INVALID"],
      [{ projectId: "../escape" }, "RUNNER_WORKSPACE_WORKTREE_IDENTITY_INVALID"],
      [{ projectId: "-leading" }, "RUNNER_WORKSPACE_WORKTREE_IDENTITY_INVALID"],
      [{ attemptId: "attempt 7" }, "RUNNER_WORKSPACE_WORKTREE_IDENTITY_INVALID"],
      [{ attemptId: "attempt\n7" }, "RUNNER_WORKSPACE_WORKTREE_IDENTITY_INVALID"],
      [{ attemptId: "a".repeat(129) }, "RUNNER_WORKSPACE_WORKTREE_IDENTITY_INVALID"],
      [{ attemptId: "attémpt" }, "RUNNER_WORKSPACE_WORKTREE_IDENTITY_INVALID"],
    ];
    // Non-vacuity: a roster that silently generated nothing would pass every
    // assertion below.
    expect(roster.length).toBe(12);
    for (const [override, code] of roster) {
      expect([override, refusalOf(request(override))]).toEqual([
        override,
        { code, layer: "WORKTREE_CONTRACT" },
      ]);
    }
  });

  it("refuses a non-object request rather than throwing", () => {
    const derived = deriveWorktreeTarget(null as unknown as WorktreeMaterializationRequest);
    expect(derived.ok).toBe(false);
    if (derived.ok) throw new Error("unreachable");
    expect([derived.code, derived.layer]).toEqual([
      "RUNNER_WORKSPACE_WORKTREE_IDENTITY_INVALID",
      "WORKTREE_CONTRACT",
    ]);
  });
});

describe("isContainedByPath", () => {
  it("holds on both separators and rejects a sibling-prefix escape", () => {
    for (const separator of ["/", "\\"]) {
      const parent = ["", "srv", "parent"].join(separator);
      expect(isContainedByPath(parent, parent, separator)).toBe(true);
      expect(isContainedByPath(parent, `${parent}${separator}leaf`, separator)).toBe(true);
      expect(isContainedByPath(parent, `${parent}-evil${separator}leaf`, separator)).toBe(false);
      expect(isContainedByPath(parent, ["", "srv", "other"].join(separator), separator)).toBe(false);
      expect(isContainedByPath(`${parent}${separator}`, `${parent}${separator}leaf`, separator)).toBe(
        true,
      );
    }
    expect(isContainedByPath("", "/anything", "/")).toBe(false);
  });
});

describe("worktreeStateRejection", () => {
  const target = targetOf(request());
  const clean: WorktreeInspection = {
    exists: true,
    hasGitMetadata: true,
    realWorktreePath: `/srv/parent/${target.leaf}`,
    realWorktreeParent: "/srv/parent",
    realSourceRepositoryRoot: "/srv/source",
    headCommit: target.baseIdentity,
    detached: true,
    clean: true,
  };

  it("admits a fully verified tree", () => {
    expect(worktreeStateRejection(target, clean, "/srv/source", "/")).toBeNull();
  });

  it("refuses each single deviation with its own code at the node layer", () => {
    const roster: readonly (readonly [Partial<WorktreeInspection>, string])[] = [
      [{ hasGitMetadata: false }, "RUNNER_WORKSPACE_WORKTREE_PARTIAL"],
      [{ realWorktreePath: null }, "RUNNER_WORKSPACE_WORKTREE_PARTIAL"],
      [{ realWorktreePath: "/srv/parent-evil/leaf" }, "RUNNER_WORKSPACE_WORKTREE_ESCAPED"],
      [{ realWorktreePath: "/elsewhere/leaf" }, "RUNNER_WORKSPACE_WORKTREE_ESCAPED"],
      [{ realSourceRepositoryRoot: null }, "RUNNER_WORKSPACE_WORKTREE_OWNERSHIP_AMBIGUOUS"],
      [
        { realSourceRepositoryRoot: "/srv/foreign" },
        "RUNNER_WORKSPACE_WORKTREE_OWNERSHIP_MISMATCH",
      ],
      [
        { realSourceRepositoryRoot: "/srv/SOURCE" },
        "RUNNER_WORKSPACE_WORKTREE_OWNERSHIP_MISMATCH",
      ],
      [{ detached: false }, "RUNNER_WORKSPACE_WORKTREE_NOT_DETACHED"],
      [{ headCommit: "9".repeat(40) }, "RUNNER_WORKSPACE_WORKTREE_HEAD_MISMATCH"],
      [{ headCommit: null }, "RUNNER_WORKSPACE_WORKTREE_HEAD_MISMATCH"],
      [{ clean: false }, "RUNNER_WORKSPACE_WORKTREE_DIRTY"],
    ];
    expect(roster.length).toBe(11);
    for (const [override, code] of roster) {
      // Exactly one field varies per arm: co-varying two would let a single
      // guard answer for both and hide the other.
      const failure = worktreeStateRejection(
        target,
        { ...clean, ...override },
        "/srv/source",
        "/",
      );
      expect([override, failure?.code, failure?.layer]).toEqual([override, code, "WORKTREE_NODE"]);
      expect(failure !== null && isWorktreeFailure(failure)).toBe(true);
    }
  });
});

describe("the worktree vocabulary", () => {
  it("publishes every new refusal code on the closed workspace roster", () => {
    const added = [
      "RUNNER_WORKSPACE_WORKTREE_IDENTITY_INVALID",
      "RUNNER_WORKSPACE_WORKTREE_PARENT_INVALID",
      "RUNNER_WORKSPACE_WORKTREE_SOURCE_INVALID",
      "RUNNER_WORKSPACE_WORKTREE_COLLISION",
      "RUNNER_WORKSPACE_WORKTREE_PARTIAL",
      "RUNNER_WORKSPACE_WORKTREE_HEAD_MISMATCH",
      "RUNNER_WORKSPACE_WORKTREE_NOT_DETACHED",
      "RUNNER_WORKSPACE_WORKTREE_DIRTY",
      "RUNNER_WORKSPACE_WORKTREE_ESCAPED",
      "RUNNER_WORKSPACE_WORKTREE_OWNERSHIP_AMBIGUOUS",
      "RUNNER_WORKSPACE_WORKTREE_OWNERSHIP_MISMATCH",
      "RUNNER_WORKSPACE_WORKTREE_COMMAND_FAILED",
      "RUNNER_WORKSPACE_WORKTREE_OUTPUT_OVERFLOW",
      "RUNNER_WORKSPACE_WORKTREE_RELEASE_NOT_TERMINAL",
      "RUNNER_WORKSPACE_WORKTREE_RELEASE_FENCE_MISMATCH",
      "RUNNER_WORKSPACE_WORKTREE_RELEASE_UNCERTAIN",
    ];
    expect(added.length).toBe(16);
    expect(added.filter((code) => !RUNNER_WORKSPACE_ERROR_CODES.includes(code as never))).toEqual([]);
    expect(Object.isFrozen(RUNNER_WORKSPACE_ERROR_CODES)).toBe(true);
  });

  it("publishes frozen layer, intent and disposition vocabularies", () => {
    expect([...RUNNER_WORKTREE_LAYERS]).toEqual(["WORKTREE_CONTRACT", "WORKTREE_NODE"]);
    expect([...WORKTREE_RELEASE_INTENTS]).toEqual(["ATTEMPT_TERMINAL", "ATTEMPT_ACTIVE"]);
    expect([...WORKTREE_RELEASE_DISPOSITIONS]).toEqual(["RELEASED", "QUARANTINED"]);
    for (const table of [
      RUNNER_WORKTREE_LAYERS,
      WORKTREE_RELEASE_INTENTS,
      WORKTREE_RELEASE_DISPOSITIONS,
    ]) {
      expect(Object.isFrozen(table)).toBe(true);
    }
    expect(WORKTREE_ASSIGNMENT_VERSION).toBe("moe-worktree-assignment/1");
  });

  it("pins its own command budgets rather than inheriting the observer's", () => {
    // A large detached checkout routinely outruns the 30s observation budget,
    // so the allocator owns its timeout and its output ceiling explicitly.
    expect(WORKTREE_GIT_TIMEOUT_MS).toBe(120_000);
    expect(MAX_WORKTREE_COMMAND_BYTES).toBe(4 * 1024 * 1024);
  });
});

// 60s: every case here spawns real git subprocesses, and the 5s default times
// out under full-fleet parallelism — the same repair 9f52c54 pinned elsewhere.
// The two roster cases build one whole repository PER ARM, so they carry their
// own budget below; MEASURED at 39s for the five-arm roster on a loaded host.
describe.skipIf(!gitAvailable())(
  "createNodeWorktreeMaterializer over a real repository",
  { timeout: 60_000 },
  () => {
    function scenario(overrides: Partial<WorktreeMaterializationRequest> = {}): {
      readonly input: WorktreeMaterializationRequest;
      readonly commits: readonly string[];
    } {
      const source = temporaryRepository();
      return {
        input: {
          sourceRepositoryRoot: source.root,
          worktreeParent: temporaryParent(),
          projectId: PROJECT,
          attemptId: ATTEMPT,
          baseIdentity: source.commits[1] as string,
          ...overrides,
        },
        commits: source.commits,
      };
    }

    function materialize(input: WorktreeMaterializationRequest): WorktreeAssignment {
      const result = materializer.materialize(input);
      if (!result.ok) throw new Error(`expected an assignment, got ${result.code}`);
      return result.assignment;
    }

    function head(path: string): string {
      return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      }).trim();
    }

    it("creates a detached worktree at the exact admitted base under a parent with spaces", () => {
      const { input, commits } = scenario();
      const assignment = materialize(input);
      expect(assignment.assignmentVersion).toBe(WORKTREE_ASSIGNMENT_VERSION);
      expect(assignment.adopted).toBe(false);
      expect(assignment.baseIdentity).toBe(commits[1]);
      expect(assignment.realWorktreeParent).toContain("attempt worktrees");
      expect(assignment.realWorktreePath.endsWith(`${sep}${assignment.leaf}`)).toBe(true);
      expect(isContainedByPath(assignment.realWorktreeParent, assignment.realWorktreePath, sep)).toBe(
        true,
      );
      expect(Object.isFrozen(assignment)).toBe(true);
      // Measured on disk, not inferred from a zero exit code.
      expect(head(assignment.realWorktreePath)).toBe(commits[1]);
      // `symbolic-ref --quiet HEAD` exits non-zero exactly when HEAD is
      // detached, so a THROW here is the detached state and a return is a branch.
      expect(() =>
        execFileSync("git", ["-C", assignment.realWorktreePath, "symbolic-ref", "--quiet", "HEAD"], {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        }),
      ).toThrow();
    });

    it("accepts equivalent source representations and records the inspected owner", () => {
      const source = temporaryRepository();
      const aliasRoot = temporaryDirectory("moe-worktree-alias-");
      const alias = join(aliasRoot, "source repository alias");
      symlinkSync(source.root, alias, "junction");
      const canonicalSource = realpathSync(source.root);
      const linkedSource = join(temporaryDirectory("moe-worktree-linked-source-"), "linked source");
      git(source.root, "worktree", "add", "--detach", "--quiet", linkedSource,
        source.commits[1] as string);
      const representations: Array<readonly [string, string]> = [
        ["junction or symlink alias", alias],
        ["trailing separator", `${source.root}${sep}`],
        ["linked-worktree source", linkedSource],
      ];
      const addIfEquivalent = (label: string, candidate: string): void => {
        try {
          if (realpathSync(candidate) === canonicalSource) representations.push([label, candidate]);
        } catch {
          // This host does not report that spelling as equivalent.
        }
      };
      if (process.platform === "win32") {
        addIfEquivalent("separator spelling", source.root.replaceAll("\\", "/"));
      }
      const swappedCase = source.root.replace(/[A-Za-z]/gu, (letter) =>
        letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
      addIfEquivalent("case spelling", swappedCase);
      expect(representations.length).toBeGreaterThanOrEqual(3);
      if (process.platform === "win32") {
        expect(representations.some(([label]) => label === "separator spelling")).toBe(true);
      }

      for (const [index, [label, sourceRepositoryRoot]] of representations.entries()) {
        const assignment = materialize({
          sourceRepositoryRoot,
          worktreeParent: temporaryParent(),
          projectId: PROJECT,
          attemptId: `attempt:equivalent-${index}`,
          baseIdentity: source.commits[1] as string,
        });
        const commonDir = realpathSync(git(
          assignment.realWorktreePath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ).trim());
        expect([label, assignment.realSourceRepositoryRoot, commonDir]).toEqual([
          label,
          canonicalSource,
          realpathSync(join(canonicalSource, ".git")),
        ]);
      }
    });

    it("refuses a base absent from the repository as a bounded command failure", () => {
      const { input } = scenario({ baseIdentity: "9".repeat(40) });
      const result = materializer.materialize(input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect([result.code, result.layer]).toEqual([
        "RUNNER_WORKSPACE_WORKTREE_COMMAND_FAILED",
        "WORKTREE_NODE",
      ]);
    });

    it("adopts its own tree on an exact replay instead of creating a second one", () => {
      const { input } = scenario();
      const first = materialize(input);
      const second = materialize(input);
      expect([first.adopted, second.adopted]).toEqual([false, true]);
      expect(second.realWorktreePath).toBe(first.realWorktreePath);
      expect(second.leaf).toBe(first.leaf);
      // On-disk count, not a return value: a double-create would show two trees.
      expect(readdirSync(first.realWorktreeParent)).toEqual([first.leaf]);
      expect(worktreeCount(input.sourceRepositoryRoot)).toBe(2);
    });

    it("refuses a same-commit worktree owned by another repository", () => {
      const { input } = scenario();
      const original = materialize(input);
      const expectedPath = original.realWorktreePath;
      const parked = join(temporaryDirectory("moe-worktree-parked-"), original.leaf);
      renameSync(expectedPath, parked);

      const foreign = temporaryDirectory("moe-worktree-foreign-");
      git(input.sourceRepositoryRoot, "clone", "--no-local", "--quiet",
        input.sourceRepositoryRoot, foreign);
      git(foreign, "config", "core.autocrlf", "false");
      git(foreign, "worktree", "add", "--detach", "--quiet", expectedPath, input.baseIdentity);

      expect(worktreeCount(input.sourceRepositoryRoot)).toBe(2);
      expect(worktreeCount(foreign)).toBe(2);
      expect(head(expectedPath)).toBe(input.baseIdentity);
      expect(() => git(expectedPath, "symbolic-ref", "--quiet", "HEAD")).toThrow();
      expect(git(expectedPath, "status", "--porcelain=v1").trim()).toBe("");
      expect(realpathSync(git(expectedPath, "rev-parse", "--path-format=absolute",
        "--git-common-dir").trim())).toBe(realpathSync(join(foreign, ".git")));
      expect(realpathSync(foreign)).not.toBe(realpathSync(input.sourceRepositoryRoot));

      const result = materializer.materialize(input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("a foreign owner became an assignment");
      expect([result.code, result.layer]).toEqual([
        "RUNNER_WORKSPACE_WORKTREE_OWNERSHIP_MISMATCH",
        "WORKTREE_NODE",
      ]);
      expect("assignment" in result).toBe(false);
      expect(existsSync(expectedPath)).toBe(true);
      expect(git(expectedPath, "status", "--porcelain=v1").trim()).toBe("");
    });

    it("refuses case-distinct owners when the host preserves both identities", () => {
      const source = temporaryRepository();
      const pair = caseDistinctClonePair(source.root);
      if (!pair.supported) {
        expect(pair).toEqual({ supported: false });
        return;
      }
      const input = {
        sourceRepositoryRoot: pair.lower,
        worktreeParent: temporaryParent(),
        projectId: PROJECT,
        attemptId: "attempt:case-distinct-owner",
        baseIdentity: source.commits[1] as string,
      };
      const original = materialize(input);
      const parked = join(temporaryDirectory("moe-worktree-case-parked-"), original.leaf);
      renameSync(original.realWorktreePath, parked);
      git(pair.upper, "worktree", "add", "--detach", "--quiet",
        original.realWorktreePath, input.baseIdentity);

      const result = materializer.materialize(input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("case-distinct owner became an assignment");
      expect([result.code, result.layer, "assignment" in result]).toEqual([
        "RUNNER_WORKSPACE_WORKTREE_OWNERSHIP_MISMATCH", "WORKTREE_NODE", false,
      ]);
      expect(materializer.release({
        assignment: original, callerIntent: "ATTEMPT_TERMINAL",
      })).toEqual({ ok: true, disposition: "QUARANTINED" });
      expect(existsSync(original.realWorktreePath)).toBe(true);
    });

    it("refuses each single adoption deviation with its own code and layer", { timeout: 180_000 }, () => {
      // Exactly one fact is disturbed per arm; co-varying two would let one
      // guard answer for both and hide the other entirely.
      const roster: readonly (readonly [string, (a: WorktreeAssignment) => void, string])[] = [
        [
          "wrong HEAD",
          (a) => git(a.realWorktreePath, "checkout", "--detach", "--quiet", "HEAD~1"),
          "RUNNER_WORKSPACE_WORKTREE_HEAD_MISMATCH",
        ],
        [
          "branch checked out",
          (a) => git(a.realWorktreePath, "checkout", "--quiet", "-b", "adopted"),
          "RUNNER_WORKSPACE_WORKTREE_NOT_DETACHED",
        ],
        [
          "dirty tree",
          (a) => writeFileSync(join(a.realWorktreePath, "seed.txt"), "edited by an attempt\n"),
          "RUNNER_WORKSPACE_WORKTREE_DIRTY",
        ],
        [
          "gutted git metadata",
          (a) => rmSync(join(a.realWorktreePath, ".git"), { force: true, recursive: true }),
          "RUNNER_WORKSPACE_WORKTREE_PARTIAL",
        ],
        [
          "tree redirected outside its parent",
          (a) => redirectOutsideParent(a),
          "RUNNER_WORKSPACE_WORKTREE_ESCAPED",
        ],
      ];
      expect(roster.length).toBe(5);
      for (const [label, disturb, code] of roster) {
        const { input } = scenario();
        disturb(materialize(input));
        const result = materializer.materialize(input);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect([label, result.code, result.layer]).toEqual([label, code, "WORKTREE_NODE"]);
      }
    });

    /**
     * The API is SYNCHRONOUS, so two calls cannot interleave inside one process;
     * the race that matters is cross-process, and this stages its losing side —
     * another process already created the tree at the derived path. The second
     * caller must ADOPT it, never create a second tree for the same attempt.
     */
    it("adopts a tree another process already created at the derived path", () => {
      const { input, commits } = scenario();
      const target = targetOf(input);
      const staged = join(realpathSync(input.worktreeParent), target.leaf);
      git(input.sourceRepositoryRoot, "worktree", "add", "--detach", staged, commits[1] as string);
      const assignment = materialize(input);
      expect(assignment.adopted).toBe(true);
      expect(worktreeCount(input.sourceRepositoryRoot)).toBe(2);
      expect(readdirSync(realpathSync(input.worktreeParent))).toEqual([target.leaf]);
    });

    it("refuses a release whose assignment carries non-string identities", () => {
      const { input } = scenario();
      const assignment = materialize(input);
      // A crash is not a refusal: deriveWorktreeLeaf would throw on these, and
      // the caller would get a stack trace where a stable code belongs.
      for (const forged of [{ projectId: 7 }, { attemptId: null }, { leaf: 12 }]) {
        const result = materializer.release({
          assignment: { ...assignment, ...forged } as unknown as WorktreeAssignment,
          callerIntent: "ATTEMPT_TERMINAL",
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect([forged, result.code, result.layer]).toEqual([
          forged,
          "RUNNER_WORKSPACE_WORKTREE_RELEASE_FENCE_MISMATCH",
          "WORKTREE_NODE",
        ]);
      }
      expect(existsSync(assignment.realWorktreePath)).toBe(true);
    });

    it("refuses a derived path occupied by a tree this repository does not own", () => {
      const { input } = scenario();
      const target = targetOf(input);
      const occupied = join(realpathSync(input.worktreeParent), target.leaf);
      mkdirSync(occupied, { recursive: true });
      writeFileSync(join(occupied, "foreign.txt"), "another agent's bytes\n");
      const result = materializer.materialize(input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect([result.code, result.layer]).toEqual([
        "RUNNER_WORKSPACE_WORKTREE_COLLISION",
        "WORKTREE_NODE",
      ]);
      // Refusing must not have touched the foreign bytes.
      expect(readdirSync(occupied)).toEqual(["foreign.txt"]);
    });

    it("releases only its own proven tree, and leaves the source checkout alone", () => {
      const { input } = scenario();
      const assignment = materialize(input);
      const sourceHead = git(input.sourceRepositoryRoot, "rev-parse", "HEAD").trim();
      const result = materializer.release({ assignment, callerIntent: "ATTEMPT_TERMINAL" });
      expect(result).toEqual({ ok: true, disposition: "RELEASED" });
      expect(existsSync(assignment.realWorktreePath)).toBe(false);
      expect(worktreeCount(input.sourceRepositoryRoot)).toBe(1);
      // Nothing staged, committed or checked out in the development checkout.
      expect(git(input.sourceRepositoryRoot, "rev-parse", "HEAD").trim()).toBe(sourceHead);
      expect(git(input.sourceRepositoryRoot, "status", "--porcelain=v1").trim()).toBe("");
      // Idempotent: a second terminal release of an already-gone tree is clean.
      expect(materializer.release({ assignment, callerIntent: "ATTEMPT_TERMINAL" })).toEqual({
        ok: true,
        disposition: "RELEASED",
      });
    });

    it.runIf(process.platform === "win32")(
      "releases through an equivalent canonical owner spelling",
      { timeout: 180_000 },
      () => {
        const { input } = scenario();
        const assignment = materialize(input);
        const forgedOwner = assignment.realSourceRepositoryRoot.replace(
          /[A-Za-z]/u,
          (letter) => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
        );
        expect(forgedOwner).not.toBe(assignment.realSourceRepositoryRoot);
        expect(realpathSync(forgedOwner).toLowerCase())
          .toBe(assignment.realSourceRepositoryRoot.toLowerCase());
        expect(materializer.release({
          assignment: { ...assignment, realSourceRepositoryRoot: forgedOwner },
          callerIntent: "ATTEMPT_TERMINAL",
        })).toEqual({ ok: true, disposition: "RELEASED" });
        expect(existsSync(assignment.realWorktreePath)).toBe(false);
      },
    );

    it("retains the bytes on every release the identity fence cannot prove", { timeout: 180_000 }, () => {
      const roster: readonly (readonly [
        string,
        (a: WorktreeAssignment) => WorktreeReleaseRequest,
        string,
      ])[] = [
        [
          "non-terminal caller intent",
          (a) => ({ assignment: a, callerIntent: "ATTEMPT_ACTIVE" }),
          "RUNNER_WORKSPACE_WORKTREE_RELEASE_NOT_TERMINAL",
        ],
        [
          "identity that does not derive the named leaf",
          (a) => ({
            assignment: { ...a, attemptId: "attempt:8" },
            callerIntent: "ATTEMPT_TERMINAL",
          }),
          "RUNNER_WORKSPACE_WORKTREE_RELEASE_FENCE_MISMATCH",
        ],
        [
          "assignment naming a path outside its own parent",
          (a) => ({
            assignment: { ...a, realWorktreePath: a.realWorktreeParent },
            callerIntent: "ATTEMPT_TERMINAL",
          }),
          "RUNNER_WORKSPACE_WORKTREE_RELEASE_FENCE_MISMATCH",
        ],
      ];
      expect(roster.length).toBe(3);
      for (const [label, build, code] of roster) {
        const { input } = scenario();
        const assignment = materialize(input);
        const result = materializer.release(build(assignment));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect([label, result.code, result.layer]).toEqual([label, code, "WORKTREE_NODE"]);
        // The refusal retained every byte and left the registration intact.
        expect([label, existsSync(assignment.realWorktreePath)]).toEqual([label, true]);
        expect(worktreeCount(input.sourceRepositoryRoot)).toBe(2);
      }
    });

    it("quarantines a tree whose measured state no longer matches its assignment", () => {
      const { input, commits } = scenario();
      const assignment = materialize(input);
      // The path and the owning repository still match; the HEAD does not, so
      // the fence cannot prove these bytes are the ones it allocated.
      git(assignment.realWorktreePath, "checkout", "--detach", "--quiet", commits[0] as string);
      expect(materializer.release({ assignment, callerIntent: "ATTEMPT_TERMINAL" })).toEqual({
        ok: true,
        disposition: "QUARANTINED",
      });
      expect(existsSync(assignment.realWorktreePath)).toBe(true);
      expect(worktreeCount(input.sourceRepositoryRoot)).toBe(2);
    });

    it("refuses an uncertain removal rather than forcing it", () => {
      const { input } = scenario();
      const assignment = materialize(input);
      writeFileSync(join(assignment.realWorktreePath, "seed.txt"), "unsaved attempt output\n");
      const result = materializer.release({ assignment, callerIntent: "ATTEMPT_TERMINAL" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      // No `--force` anywhere: git's refusal on a dirty tree becomes our
      // uncertainty, and the unsaved bytes survive it.
      expect([result.code, result.layer]).toEqual([
        "RUNNER_WORKSPACE_WORKTREE_RELEASE_UNCERTAIN",
        "WORKTREE_NODE",
      ]);
      expect(existsSync(join(assignment.realWorktreePath, "seed.txt"))).toBe(true);
    });

    it("materializes at a 64-hex base from a sha256 repository", () => {
      const source = temporaryRepository("sha256");
      const base = source.commits[1] as string;
      // Non-vacuity: an arm that quietly fell back to a sha1 repository would
      // assert 40 here and prove nothing about the 64-hex path.
      expect(base).toMatch(/^[0-9a-f]{64}$/u);
      const assignment = materialize({
        sourceRepositoryRoot: source.root,
        worktreeParent: temporaryParent(),
        projectId: PROJECT,
        attemptId: ATTEMPT,
        baseIdentity: base,
      });
      expect(assignment.baseIdentity).toBe(base);
      expect(head(assignment.realWorktreePath)).toBe(base);
    });

    it("materializes under a derived path longer than 200 characters", () => {
      const source = temporaryRepository();
      /**
       * MEASURED on git 2.54.0.windows.1: `worktree add --detach` succeeds at a
       * 212-character target and refuses a 222-character one with
       * `fatal: '$GIT_DIR' too big`, well below the 260-character MAX_PATH that
       * core.longpaths (unset on this host) governs. So the padding is computed
       * to land the derived path just past 200 rather than hard-coded off one
       * machine's temp directory length, and over the ceiling git's own failure
       * arrives as the bounded COMMAND_FAILED refusal asserted above.
       */
      const base = temporaryParent();
      const leaf = deriveWorktreeLeaf(PROJECT, ATTEMPT);
      const padding = 205 - (base.length + leaf.length + 2);
      // Non-vacuity: a host whose temp directory is already long enough would
      // otherwise silently test nothing about padding at all.
      expect(padding).toBeGreaterThan(0);
      const parent = join(base, "p".repeat(padding));
      mkdirSync(parent, { recursive: true });
      const assignment = materialize({
        sourceRepositoryRoot: source.root,
        worktreeParent: parent,
        projectId: PROJECT,
        attemptId: ATTEMPT,
        baseIdentity: source.commits[1] as string,
      });
      expect(assignment.realWorktreePath.length).toBeGreaterThan(200);
      expect(head(assignment.realWorktreePath)).toBe(source.commits[1]);
      expect(materializer.release({ assignment, callerIntent: "ATTEMPT_TERMINAL" })).toEqual({
        ok: true,
        disposition: "RELEASED",
      });
    });

    it("refuses an unresolvable source repository and parent at the node layer", () => {
      const { input } = scenario();
      const missing = join(input.worktreeParent, "no-such-directory");
      for (const [override, code] of [
        [{ sourceRepositoryRoot: missing }, "RUNNER_WORKSPACE_WORKTREE_SOURCE_INVALID"],
        [{ worktreeParent: missing }, "RUNNER_WORKSPACE_WORKTREE_PARENT_INVALID"],
      ] as const) {
        const result = materializer.materialize({ ...input, ...override });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect([code, result.code, result.layer]).toEqual([code, code, "WORKTREE_NODE"]);
      }
    });
  },
);
