import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildInputManifest,
  createNodeGitObserver,
  createNodeScopePaths,
  hermeticGitEnvironment,
  MAX_WORKSPACE_ENTRIES,
  type ScopePathObserver,
} from "@moe/runner";
import { describe, expect, it } from "vitest";

import {
  FOUNDATION_INPUT_HYDRATOR_LAYER,
  hydrateFoundationInputManifest,
  MAX_FOUNDATION_INPUT_FILE_BYTES,
  RUNNER_SCOPE_LAYER,
  type HydrateFoundationInputManifestInput,
} from "./foundation-input-hydrator.js";

const OBSERVED_AT = "2026-08-18T00:00:00Z";
const OBSERVER_VERSION = "moe-daemon-foundation-input/1";

interface RepositoryFixture {
  readonly head: string;
  readonly paths: readonly string[];
  readonly root: string;
}
function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: hermeticGitEnvironment(process.env),
    shell: false,
    windowsHide: true,
  }).trim();
}

function repositoryFixture(): RepositoryFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-foundation-input-")));
  const paths = ["scope/alpha.txt", "scope/beta.txt"] as const;
  mkdirSync(join(root, "scope"));
  writeFileSync(join(root, paths[0]), Buffer.from("alpha\n", "utf8"));
  writeFileSync(join(root, paths[1]), Buffer.from("beta\r\n", "utf8"));
  runGit(root, ["init", "--initial-branch=main", "--quiet"]);
  runGit(root, ["add", "--", ...paths]);
  runGit(root, [
    "-c", "user.name=Moe Foundation", "-c", "user.email=foundation@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m", "foundation input",
  ]);
  return { head: runGit(root, ["rev-parse", "HEAD"]), paths, root };
}

function expectedEntries(fixture: RepositoryFixture) {
  return fixture.paths.map((path) => {
    const bytes = readFileSync(join(fixture.root, path));
    return {
      byteLength: bytes.byteLength,
      path,
      producer: { kind: "BASE" as const },
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

function hydratorInput(
  fixture: RepositoryFixture,
  overrides: Partial<HydrateFoundationInputManifestInput> = {},
): HydrateFoundationInputManifestInput {
  return {
    baseIdentity: fixture.head,
    declaredScopePaths: fixture.paths,
    gitObserver: createNodeGitObserver(fixture.root, hermeticGitEnvironment(process.env)),
    observedAt: OBSERVED_AT,
    observerVersion: OBSERVER_VERSION,
    pathObserver: createNodeScopePaths(),
    proposedEntries: [],
    worktreeRoot: fixture.root,
    ...overrides,
  };
}

function hydrate(fixture: RepositoryFixture) {
  return hydrateFoundationInputManifest(hydratorInput(fixture));
}

function expectRefusal(result: ReturnType<typeof hydrateFoundationInputManifest>, code: string, layer: string) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  expect(result.refusedBy).toBe(layer);
}

describe("hydrateFoundationInputManifest accepted control", { timeout: 30_000 }, () => {
  it("observes raw workspace bytes and seals a stable deeply frozen input manifest", () => {
    const fixture = repositoryFixture();
    try {
      const first = hydrate(fixture);
      const second = hydrate(fixture);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      const entries = expectedEntries(fixture);
      const expected = buildInputManifest({ baseIdentity: fixture.head, entries });
      expect(expected.ok).toBe(true);
      if (!expected.ok) return;

      expect(first.manifest.baseIdentity).toBe(fixture.head);
      expect(first.manifest.entries).toEqual(entries);
      expect(first.manifest.sha256).toBe(expected.manifest.sha256);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.manifest)).toBe(true);
      expect(Object.isFrozen(first.manifest.entries)).toBe(true);
      expect(Object.isFrozen(first.manifest.entries[0])).toBe(true);
      expect(Object.isFrozen(first.observation)).toBe(true);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});

describe("hydrateFoundationInputManifest caller-cannot-win matrix", { timeout: 30_000 }, () => {
  it("refuses a proposed base that disagrees with observed HEAD at the runner scope layer", () => {
    const fixture = repositoryFixture();
    try {
      const result = hydrateFoundationInputManifest(hydratorInput(fixture, {
        baseIdentity: "f".repeat(40),
      }));
      expectRefusal(result, "RUNNER_SCOPE_HEAD_MISMATCH", RUNNER_SCOPE_LAYER);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("ignores bounded caller entries that contradict the observed files", () => {
    const fixture = repositoryFixture();
    try {
      const proposedEntries = [
        { byteLength: 999, path: fixture.paths[0], producer: { kind: "BASE" }, sha256: "f".repeat(64) },
        { byteLength: 1, path: "caller-only.txt", producer: { kind: "BASE" }, sha256: "0".repeat(64) },
      ];
      const result = hydrateFoundationInputManifest(hydratorInput(fixture, { proposedEntries }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.manifest.entries).toEqual(expectedEntries(fixture));
      expect(result.manifest.entries.some((entry) => entry.path === "caller-only.txt")).toBe(false);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses a file deleted between scope observation and raw-byte read", () => {
    const fixture = repositoryFixture();
    const target = join(fixture.root, fixture.paths[0]!);
    const nodePaths = createNodeScopePaths();
    const pathObserver: ScopePathObserver = {
      exists: (path) => nodePaths.exists(path),
      realpath(path) {
        const resolved = nodePaths.realpath(path);
        if (path === target) rmSync(path);
        return resolved;
      },
    };
    try {
      const result = hydrateFoundationInputManifest(hydratorInput(fixture, { pathObserver }));
      expectRefusal(result, "FOUNDATION_INPUT_STALE_OBSERVATION", FOUNDATION_INPUT_HYDRATOR_LAYER);
      expect("manifest" in result).toBe(false);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("distinguishes a missing worktree from a directory that is not a repository", () => {
    const fixture = repositoryFixture();
    const nonRepository = mkdtempSync(join(tmpdir(), "moe-foundation-no-git-"));
    const missing = join(tmpdir(), `moe-foundation-missing-${Date.now()}`);
    const environment = hermeticGitEnvironment(process.env);
    try {
      const absent = hydrateFoundationInputManifest(hydratorInput(fixture, {
        gitObserver: createNodeGitObserver(missing, environment), worktreeRoot: missing,
      }));
      expectRefusal(absent, "FOUNDATION_INPUT_WORKTREE_MISSING", FOUNDATION_INPUT_HYDRATOR_LAYER);
      const notGit = hydrateFoundationInputManifest(hydratorInput(fixture, {
        gitObserver: createNodeGitObserver(nonRepository, environment), worktreeRoot: nonRepository,
      }));
      expectRefusal(notGit, "RUNNER_SCOPE_OBSERVATION_FAILED", RUNNER_SCOPE_LAYER);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
      rmSync(nonRepository, { force: true, recursive: true });
    }
  });

  it("refuses unreadable and over-ceiling observed entries locally", () => {
    const fixture = repositoryFixture();
    try {
      const directory = hydrateFoundationInputManifest(hydratorInput(fixture, {
        declaredScopePaths: ["scope"],
      }));
      expectRefusal(directory, "FOUNDATION_INPUT_ENTRY_UNREADABLE", FOUNDATION_INPUT_HYDRATOR_LAYER);
      writeFileSync(join(fixture.root, fixture.paths[0]!), Buffer.alloc(MAX_FOUNDATION_INPUT_FILE_BYTES + 1));
      const oversized = hydrateFoundationInputManifest(hydratorInput(fixture));
      expectRefusal(oversized, "FOUNDATION_INPUT_ENTRY_TOO_LARGE", FOUNDATION_INPUT_HYDRATOR_LAYER);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});

describe("hydrateFoundationInputManifest hostile paths", { timeout: 30_000 }, () => {
  const pathCases = [
    { code: "RUNNER_SCOPE_PATH_ABSOLUTE", path: "/absolute" },
    { code: "RUNNER_SCOPE_PATH_DOT_SEGMENT", path: "../escape" },
    { code: "FOUNDATION_INPUT_ENTRY_UNREADABLE", path: "scope/nul\0path" },
    { code: "RUNNER_SCOPE_PATH_NOT_NORMALIZED", path: "scope/e\u0301.txt" },
    { code: "RUNNER_SCOPE_PATH_LENGTH_INVALID", path: "a".repeat(401) },
  ] as const;

  it("generates and refuses every hostile spelling at its exact layer", () => {
    expect(pathCases.length).toBeGreaterThan(0);
    const fixture = repositoryFixture();
    try {
      for (const hostile of pathCases) {
        const result = hydrateFoundationInputManifest(hydratorInput(fixture, {
          declaredScopePaths: [hostile.path],
        }));
        const layer = hostile.code.startsWith("RUNNER_") ? RUNNER_SCOPE_LAYER : FOUNDATION_INPUT_HYDRATOR_LAYER;
        expectRefusal(result, hostile.code, layer);
      }
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses a real symlink or junction that escapes the observed worktree", () => {
    const fixture = repositoryFixture();
    const outside = mkdtempSync(join(tmpdir(), "moe-foundation-outside-"));
    const link = join(fixture.root, "scope", "escape");
    try {
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      const result = hydrateFoundationInputManifest(hydratorInput(fixture, {
        declaredScopePaths: ["scope/escape"],
      }));
      expectRefusal(result, "RUNNER_SCOPE_SYMLINK_ESCAPE", RUNNER_SCOPE_LAYER);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  it("pins the reachable runner scope limit instead of fabricating an unreachable workspace refusal", () => {
    const fixture = repositoryFixture();
    try {
      const declaredScopePaths = Array.from(
        { length: MAX_WORKSPACE_ENTRIES + 1 }, (_, index) => `scope/${index}.txt`,
      );
      const result = hydrateFoundationInputManifest(hydratorInput(fixture, { declaredScopePaths }));
      expectRefusal(result, "RUNNER_SCOPE_DECLARATION_LIMIT", RUNNER_SCOPE_LAYER);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});

describe("hydrateFoundationInputManifest hostile input records", { timeout: 30_000 }, () => {
  it("generates a nonempty sweep and contains every case as one exact local refusal", () => {
    const fixture = repositoryFixture();
    const base = hydratorInput(fixture);
    const { proposedEntries: _omitted, ...missing } = base;
    const getter = { ...base } as Record<string, unknown>;
    Object.defineProperty(getter, "baseIdentity", { enumerable: true, get: () => fixture.head });
    const { proxy, revoke } = Proxy.revocable(base, {});
    revoke();
    const cases: readonly unknown[] = [
      null, [], missing, { ...base, grant: "caller-authority" }, getter, proxy,
    ];
    expect(cases.length).toBeGreaterThan(0);
    try {
      for (const hostile of cases) {
        const result = hydrateFoundationInputManifest(hostile as never);
        expectRefusal(result, "FOUNDATION_INPUT_REQUEST_MALFORMED", FOUNDATION_INPUT_HYDRATOR_LAYER);
      }
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
