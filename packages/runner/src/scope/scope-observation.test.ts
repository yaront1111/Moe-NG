import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_SCOPE_PATHS,
  ScopeObserverError,
  type GitObserver,
  type ObserveScopeInput,
  type ScopePathObserver,
} from "./scope-contract.js";
import {
  createNodeGitObserver,
  createNodeScopePaths,
  hermeticGitEnvironment,
} from "./scope-git.js";
import { observeScope } from "./scope-observation.js";

const ROOT = join("fixture-root", "worktree");
const HEAD = "0".repeat(40);
const OBSERVED_AT = "2026-08-07T12:00:00Z";
const OBSERVER_VERSION = "moe-runner-scope-observer/1";
const BLOB = "1".repeat(40);

function porcelain(records: readonly string[]): Uint8Array {
  return new TextEncoder().encode(records.map((record) => `${record}\0`).join(""));
}

function changed(xy: string, path: string): string {
  return `1 ${xy} N... 100644 100644 100644 ${BLOB} ${BLOB} ${path}`;
}

function unmerged(path: string): string {
  return `u UU N... 100644 100644 100644 100644 ${BLOB} ${BLOB} ${BLOB} ${path}`;
}

function fakeGit(overrides: Partial<GitObserver> = {}): GitObserver {
  return {
    headCommit: () => HEAD,
    statusPorcelainV2: () => porcelain(["# branch.oid " + HEAD]),
    lsFilesTracked: () => [],
    lsFilesIgnored: () => [],
    submodulePaths: () => [],
    ...overrides,
  };
}

function fakePaths(links: Readonly<Record<string, string>> = {}, absent: readonly string[] = []) {
  const observer: ScopePathObserver = {
    realpath: (path) => links[path] ?? path,
    exists: (path) => !absent.includes(path),
  };
  return observer;
}

function input(overrides: Partial<ObserveScopeInput> = {}): ObserveScopeInput {
  return {
    worktreeRoot: ROOT,
    baseIdentity: HEAD,
    declaredScopePaths: ["src/a.ts"],
    gitObserver: fakeGit(),
    pathObserver: fakePaths(),
    observedAt: OBSERVED_AT,
    observerVersion: OBSERVER_VERSION,
    ...overrides,
  };
}

function expectCode(result: ReturnType<typeof observeScope>, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
}

describe("observeScope canonical path rules", () => {
  const rejections: ReadonlyArray<readonly [string, string, string]> = [
    ["leading slash", "/src/a.ts", "RUNNER_SCOPE_PATH_ABSOLUTE"],
    ["UNC prefix", "//server/share/a.ts", "RUNNER_SCOPE_PATH_ABSOLUTE"],
    ["drive letter", "C:/src/a.ts", "RUNNER_SCOPE_PATH_DRIVE_QUALIFIED"],
    ["colon anywhere", "src/a.ts:stream", "RUNNER_SCOPE_PATH_DRIVE_QUALIFIED"],
    ["backslash", "src\\a.ts", "RUNNER_SCOPE_PATH_BACKSLASH"],
    ["parent segment", "src/../a.ts", "RUNNER_SCOPE_PATH_DOT_SEGMENT"],
    ["current segment", "./a.ts", "RUNNER_SCOPE_PATH_DOT_SEGMENT"],
    ["empty segment", "src//a.ts", "RUNNER_SCOPE_PATH_DOT_SEGMENT"],
    ["bare parent", "..", "RUNNER_SCOPE_PATH_DOT_SEGMENT"],
    ["device stem", "src/NUL.txt", "RUNNER_SCOPE_PATH_RESERVED_DEVICE"],
    ["device directory", "con/a.ts", "RUNNER_SCOPE_PATH_RESERVED_DEVICE"],
    ["trailing dot", "src/a.", "RUNNER_SCOPE_PATH_TRAILING_DOT_OR_SPACE"],
    ["trailing space", "src/a ", "RUNNER_SCOPE_PATH_TRAILING_DOT_OR_SPACE"],
    ["decomposed NFC", "src/cafe\u0301.ts", "RUNNER_SCOPE_PATH_NOT_NORMALIZED"],
    ["lone surrogate", "src/\ud800.ts", "RUNNER_SCOPE_PATH_NOT_NORMALIZED"],
    ["empty path", "", "RUNNER_SCOPE_PATH_LENGTH_INVALID"],
    ["over-long path", `src/${"a".repeat(400)}.ts`, "RUNNER_SCOPE_PATH_LENGTH_INVALID"],
  ];

  for (const [label, path, code] of rejections) {
    it(`rejects ${label} with ${code}`, () => {
      expectCode(observeScope(input({ declaredScopePaths: [path] })), code);
    });
  }

  it("reports the offending path on the failure", () => {
    const result = observeScope(input({ declaredScopePaths: ["src/a.ts", "src\\b.ts"] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.path).toBe("src\\b.ts");
  });

  it("rejects a case-fold collision distinctly from an exact duplicate", () => {
    expectCode(
      observeScope(input({ declaredScopePaths: ["src/a.ts", "src/A.ts"] })),
      "RUNNER_SCOPE_PATH_CASE_COLLISION",
    );
    expectCode(
      observeScope(input({ declaredScopePaths: ["src/a.ts", "src/a.ts"] })),
      "RUNNER_SCOPE_PATH_DUPLICATE",
    );
  });

  it("rejects an empty declaration", () => {
    expectCode(observeScope(input({ declaredScopePaths: [] })), "RUNNER_SCOPE_DECLARATION_EMPTY");
  });

  it("rejects an oversized declaration", () => {
    const declaredScopePaths = Array.from({ length: MAX_SCOPE_PATHS + 1 }, (_unused, index) => `pkg/f${index}.ts`);
    expectCode(observeScope(input({ declaredScopePaths })), "RUNNER_SCOPE_DECLARATION_LIMIT");
  });

  it("accepts a plain relative path", () => {
    const result = observeScope(input());
    expect(result.ok).toBe(true);
  });
});

describe("observeScope containment", () => {
  it("rejects an entry whose realpath leaves the worktree", () => {
    const escaped = join("elsewhere", "target.ts");
    const result = observeScope(
      input({
        declaredScopePaths: ["src/linked.ts"],
        pathObserver: fakePaths({ [join(ROOT, "src", "linked.ts")]: escaped }),
      }),
    );
    expectCode(result, "RUNNER_SCOPE_SYMLINK_ESCAPE");
  });

  it("rejects a junction that resolves to a sibling prefix of the root", () => {
    const sibling = `${ROOT}-other`;
    const result = observeScope(
      input({
        declaredScopePaths: ["src/junction.ts"],
        pathObserver: fakePaths({ [join(ROOT, "src", "junction.ts")]: join(sibling, "x.ts") }),
      }),
    );
    expectCode(result, "RUNNER_SCOPE_SYMLINK_ESCAPE");
  });

  it("rejects an unresolvable worktree root", () => {
    const pathObserver: ScopePathObserver = {
      realpath: () => {
        throw new Error("ENOENT");
      },
      exists: () => true,
    };
    expectCode(observeScope(input({ pathObserver })), "RUNNER_SCOPE_REPOSITORY_ESCAPE");
  });

  it("does not resolve a declared path that does not exist yet", () => {
    const result = observeScope(
      input({ pathObserver: fakePaths({}, [join(ROOT, "src", "a.ts")]) }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.canonicalEntries[0]?.attribution).toBe("ABSENT");
  });

  it("rejects a path inside a reported submodule and the submodule root itself", () => {
    const gitObserver = fakeGit({ submodulePaths: () => ["vendor/lib"] });
    expectCode(
      observeScope(input({ declaredScopePaths: ["vendor/lib/src/x.ts"], gitObserver })),
      "RUNNER_SCOPE_SUBMODULE_BOUNDARY",
    );
    expectCode(
      observeScope(input({ declaredScopePaths: ["vendor/lib"], gitObserver })),
      "RUNNER_SCOPE_SUBMODULE_BOUNDARY",
    );
  });
});

describe("observeScope identity binding", () => {
  it("rejects a base identity that is not a commit digest", () => {
    for (const baseIdentity of ["", "abc", "Z".repeat(40), "a".repeat(41)]) {
      expectCode(observeScope(input({ baseIdentity })), "RUNNER_SCOPE_BASE_IDENTITY_INVALID");
    }
  });

  it("accepts both sha1 and sha256 base identities", () => {
    const sha256 = "a".repeat(64);
    const result = observeScope(
      input({ baseIdentity: sha256, gitObserver: fakeGit({ headCommit: () => sha256 }) }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an observed HEAD that differs from the declared base", () => {
    expectCode(
      observeScope(input({ gitObserver: fakeGit({ headCommit: () => "9".repeat(40) }) })),
      "RUNNER_SCOPE_HEAD_MISMATCH",
    );
  });

  it("rejects a non-canonical observedAt so the digest cannot be destabilized", () => {
    for (const observedAt of [
      "",
      "2026-08-07",
      "2026-08-07T12:00:00+02:00",
      "2026-08-07 12:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-08-07T24:00:00Z",
      "2026-08-07T12:60:00Z",
      "2026-08-07T12:00:00.1Z",
    ]) {
      expectCode(observeScope(input({ observedAt })), "RUNNER_SCOPE_OBSERVED_AT_INVALID");
    }
  });

  it("accepts second and millisecond precision, including a leap day", () => {
    for (const observedAt of [
      "2026-08-07T12:00:00Z",
      "2026-08-07T12:00:00.123Z",
      "2024-02-29T00:00:00Z",
    ]) {
      expect(observeScope(input({ observedAt })).ok).toBe(true);
    }
    expectCode(
      observeScope(input({ observedAt: "2026-02-29T00:00:00Z" })),
      "RUNNER_SCOPE_OBSERVED_AT_INVALID",
    );
  });

  it("rejects a missing observer version", () => {
    expectCode(observeScope(input({ observerVersion: "" })), "RUNNER_SCOPE_OBSERVER_VERSION_INVALID");
  });
});

describe("observeScope git attribution", () => {
  const status = porcelain([
    `# branch.oid ${HEAD}`,
    changed(".M", "src/dirty.ts"),
    changed("M.", "src/staged.ts"),
    changed("MM", "src/both.ts"),
    unmerged("src/conflict.ts"),
    "? src/untracked.ts",
  ]);
  const gitObserver = fakeGit({
    statusPorcelainV2: () => status,
    lsFilesTracked: () => ["src/clean.ts", "src/dirty.ts", "src/staged.ts", "src/both.ts"],
    lsFilesIgnored: () => ["src/ignored.log", "build/"],
  });

  function classify(paths: readonly string[]): Record<string, string> {
    const result = observeScope(input({ declaredScopePaths: paths, gitObserver }));
    expect(result.ok).toBe(true);
    if (!result.ok) return {};
    return Object.fromEntries(
      result.observation.canonicalEntries.map((entry) => [entry.path, entry.attribution]),
    );
  }

  it("classifies every declared path into one closed class", () => {
    expect(
      classify([
        "src/clean.ts",
        "src/dirty.ts",
        "src/staged.ts",
        "src/both.ts",
        "src/conflict.ts",
        "src/untracked.ts",
        "src/ignored.log",
        "src/never-seen.ts",
      ]),
    ).toEqual({
      "src/clean.ts": "CLEAN",
      "src/dirty.ts": "DIRTY",
      "src/staged.ts": "STAGED",
      "src/both.ts": "STAGED",
      "src/conflict.ts": "UNMERGED",
      "src/untracked.ts": "UNTRACKED",
      "src/ignored.log": "IGNORED",
      "src/never-seen.ts": "ABSENT",
    });
  });

  it("treats a path under an ignored directory entry as ignored", () => {
    expect(classify(["build/out.js"])).toEqual({ "build/out.js": "IGNORED" });
  });

  it("gives a directory declaration the strongest class in its subtree", () => {
    expect(classify(["src"])).toEqual({ src: "UNMERGED" });
    const quiet = fakeGit({
      statusPorcelainV2: () => porcelain([`# branch.oid ${HEAD}`, changed(".M", "docs/a.md")]),
      lsFilesTracked: () => ["docs/a.md", "docs/b.md"],
    });
    const result = observeScope(input({ declaredScopePaths: ["docs"], gitObserver: quiet }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.canonicalEntries[0]?.attribution).toBe("DIRTY");
  });

  it("records a contradictory status record as UNKNOWN rather than clean", () => {
    const contradictory = fakeGit({
      statusPorcelainV2: () => porcelain([changed("..", "src/weird.ts")]),
      lsFilesTracked: () => ["src/weird.ts"],
    });
    const result = observeScope(
      input({ declaredScopePaths: ["src/weird.ts"], gitObserver: contradictory }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.canonicalEntries[0]?.attribution).toBe("UNKNOWN");
  });

  it("publishes explicit per-class manifests and changed paths", () => {
    const result = observeScope(input({ declaredScopePaths: ["src/clean.ts"], gitObserver }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attribution = result.observation.gitAttribution;
    expect(attribution.headCommit).toBe(HEAD);
    expect(attribution.dirtyPaths).toEqual(["src/both.ts", "src/dirty.ts"]);
    expect(attribution.stagedPaths).toEqual(["src/both.ts", "src/staged.ts"]);
    expect(attribution.untrackedPaths).toEqual(["src/untracked.ts"]);
    expect(attribution.unmergedPaths).toEqual(["src/conflict.ts"]);
    expect(attribution.ignoredPaths).toEqual(["build/", "src/ignored.log"]);
    expect(attribution.changedPaths).toEqual([
      "src/both.ts",
      "src/conflict.ts",
      "src/dirty.ts",
      "src/staged.ts",
      "src/untracked.ts",
    ]);
  });

  it("records both sides of a rename", () => {
    const renamed = fakeGit({
      statusPorcelainV2: () =>
        porcelain([
          `2 R. N... 100644 100644 100644 ${BLOB} ${BLOB} R100 src/new.ts\0src/old.ts`,
        ]),
    });
    const result = observeScope(input({ declaredScopePaths: ["src/new.ts"], gitObserver: renamed }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.gitAttribution.stagedPaths).toEqual(["src/new.ts", "src/old.ts"]);
  });
});

describe("observeScope observer failures", () => {
  it("maps a malformed porcelain stream to a stable code", () => {
    for (const bytes of [
      porcelain(["x unknown-record"]),
      porcelain([changed("M", "src/a.ts")]),
      new Uint8Array([0xff, 0xfe, 0x00]),
      new TextEncoder().encode("? src/a.ts"),
    ]) {
      expectCode(
        observeScope(input({ gitObserver: fakeGit({ statusPorcelainV2: () => bytes }) })),
        "RUNNER_SCOPE_STATUS_MALFORMED",
      );
    }
  });

  it("maps an untyped observer throw to RUNNER_SCOPE_OBSERVATION_FAILED", () => {
    const gitObserver = fakeGit({
      statusPorcelainV2: () => {
        throw new Error("git exploded");
      },
    });
    expectCode(observeScope(input({ gitObserver })), "RUNNER_SCOPE_OBSERVATION_FAILED");
  });

  it("preserves a typed observer code such as the maxBuffer overflow", () => {
    const gitObserver = fakeGit({
      statusPorcelainV2: () => {
        throw new ScopeObserverError("RUNNER_SCOPE_OBSERVATION_OVERFLOW", "status output too large");
      },
    });
    expectCode(observeScope(input({ gitObserver })), "RUNNER_SCOPE_OBSERVATION_OVERFLOW");
  });
});

describe("observeScope digest binding", () => {
  it("is deep-frozen, sorted, and reproducible across runs and key orders", () => {
    const first = observeScope(input({ declaredScopePaths: ["src/b.ts", "src/a.ts"] }));
    const reordered = observeScope({
      observerVersion: OBSERVER_VERSION,
      observedAt: OBSERVED_AT,
      pathObserver: fakePaths(),
      gitObserver: fakeGit(),
      declaredScopePaths: ["src/b.ts", "src/a.ts"],
      baseIdentity: HEAD,
      worktreeRoot: ROOT,
    });
    expect(first.ok && reordered.ok).toBe(true);
    if (!first.ok || !reordered.ok) return;
    expect(first.observation.canonicalEntries.map((entry) => entry.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(first.observation.sha256).toBe(reordered.observation.sha256);
    expect(first.observation).toEqual(reordered.observation);
    expect(Object.isFrozen(first.observation)).toBe(true);
    expect(Object.isFrozen(first.observation.canonicalEntries)).toBe(true);
    expect(Object.isFrozen(first.observation.canonicalEntries[0])).toBe(true);
    expect(Object.isFrozen(first.observation.gitAttribution)).toBe(true);
    expect(first.observation.worktreeIdentity).toBe(ROOT);
    expect(first.observation.observationVersion).toBe("moe-scope-observation/1");
  });

  it("changes when any bound field changes", () => {
    const base = observeScope(input());
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const variants = [
      input({ observedAt: "2026-08-07T12:00:01Z" }),
      input({ observerVersion: "moe-runner-scope-observer/2" }),
      input({ declaredScopePaths: ["src/a.ts", "src/c.ts"] }),
      input({
        gitObserver: fakeGit({
          statusPorcelainV2: () => porcelain([changed(".M", "src/a.ts")]),
        }),
      }),
    ];
    for (const variant of variants) {
      const result = observeScope(variant);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.observation.sha256).not.toBe(base.observation.sha256);
    }
  });
});

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// 30s: real git subprocess work; the 5s default times out under full-fleet
// parallelism. Same repair as daemon 03fd290.
describe.skipIf(!gitAvailable())("observeScope over a real repository", { timeout: 30_000 }, () => {
  it("observes a freshly built worktree with dirty, staged, and untracked paths", () => {
    const repo = mkdtempSync(join(tmpdir(), "moe-runner-scope-"));
    try {
      const run = (...args: string[]): void => {
        execFileSync("git", args, { cwd: repo, stdio: "ignore" });
      };
      run("init", "--initial-branch=main");
      run("config", "user.email", "runner@example.invalid");
      run("config", "user.name", "runner");
      writeFileSync(join(repo, "clean.txt"), "clean\n");
      writeFileSync(join(repo, "dirty.txt"), "one\n");
      writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
      run("add", "clean.txt", "dirty.txt", ".gitignore");
      run("commit", "-m", "base");
      writeFileSync(join(repo, "dirty.txt"), "two\n");
      writeFileSync(join(repo, "untracked.txt"), "new\n");
      writeFileSync(join(repo, "ignored.log"), "noise\n");

      const gitObserver = createNodeGitObserver(repo, hermeticGitEnvironment(process.env));
      const result = observeScope({
        worktreeRoot: repo,
        baseIdentity: gitObserver.headCommit(),
        declaredScopePaths: ["clean.txt", "dirty.txt", "untracked.txt", "ignored.log"],
        gitObserver,
        pathObserver: createNodeScopePaths(),
        observedAt: OBSERVED_AT,
        observerVersion: OBSERVER_VERSION,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const classes = Object.fromEntries(
        result.observation.canonicalEntries.map((entry) => [entry.path, entry.attribution]),
      );
      expect(classes).toEqual({
        "clean.txt": "CLEAN",
        "dirty.txt": "DIRTY",
        "untracked.txt": "UNTRACKED",
        "ignored.log": "IGNORED",
      });
      expect(result.observation.worktreeIdentity.endsWith(`${sep}${repo.split(sep).pop()!}`)).toBe(
        true,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
