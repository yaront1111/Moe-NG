import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PACK_SOURCE_ERROR_CODES,
  PACKAGING_SOURCE_LAYER,
  PackSourceError,
  type PackSourceCode,
  type PackSourceCommand,
  type PackSourceCommandResult,
  type PackSourceDependencies,
  withMaterializedPackSource,
} from "./pack-source.js";

const SECRET = "must-never-escape-pack-source";
const roots: string[] = [];

interface GitFixture {
  readonly blobSha: string;
  readonly headSha: string;
  readonly repositoryRoot: string;
  readonly selectedSha: string;
  readonly trackedPaths: readonly string[];
}

function run(command: string, args: readonly string[], cwd: string, input?: string): Buffer {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: null,
    input,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${String(result.stderr)}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

const systemCommand: PackSourceCommand = (command, args, cwd) => {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: null,
    shell: false,
    windowsHide: true,
  });
  const answer: PackSourceCommandResult = {
    status: result.status,
    stderr: result.stderr ?? Buffer.alloc(0),
    stdout: result.stdout ?? Buffer.alloc(0),
  };
  return result.error === undefined ? answer : { ...answer, error: result.error };
};

function write(root: string, path: string, contents: string): void {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function createGitFixture(objectFormat: "sha1" | "sha256" = "sha1"): GitFixture {
  const repositoryRoot = mkdtempSync(join(tmpdir(), `moe-pack-source-${objectFormat}-`));
  roots.push(repositoryRoot);
  run("git", ["init", "--quiet", `--object-format=${objectFormat}`], repositoryRoot);
  run("git", ["config", "user.email", "pack-source@example.invalid"], repositoryRoot);
  run("git", ["config", "user.name", "Pack Source Test"], repositoryRoot);
  run("git", ["config", "core.autocrlf", "false"], repositoryRoot);

  write(repositoryRoot, ".gitignore", "packages/contracts/.env\n");
  write(repositoryRoot, "packaging/manifest.json", "{\"version\":1}\n");
  write(repositoryRoot, "src/name with space-μ.txt", "unicode path\n");
  write(repositoryRoot, "src/version.txt", "version-one\n");
  run("git", ["add", "--", ".gitignore", "packaging/manifest.json", "src"], repositoryRoot);
  run("git", ["commit", "--quiet", "-m", "version one"], repositoryRoot);
  const selectedSha = run("git", ["rev-parse", "HEAD"], repositoryRoot).toString("utf8").trim();

  write(repositoryRoot, "src/version.txt", "version-two\n");
  run("git", ["add", "--", "src/version.txt"], repositoryRoot);
  run("git", ["commit", "--quiet", "-m", "version two"], repositoryRoot);
  const headSha = run("git", ["rev-parse", "HEAD"], repositoryRoot).toString("utf8").trim();
  const blobSha = run("git", ["hash-object", "-w", "--stdin"], repositoryRoot, "not a commit")
    .toString("utf8").trim();

  write(repositoryRoot, "packages/contracts/.env", SECRET);
  write(repositoryRoot, "untracked-sentinel.txt", SECRET);
  return {
    blobSha,
    headSha,
    repositoryRoot,
    selectedSha,
    trackedPaths: Object.freeze([
      ".gitignore",
      "packaging/manifest.json",
      "src/name with space-μ.txt",
      "src/version.txt",
    ]),
  };
}

function isGitCommand(args: readonly string[], command: string): boolean {
  return args[0] === command || args[1] === command;
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected PackSourceError, but the operation succeeded");
}

function expectPackSourceError(action: () => unknown, code: PackSourceCode): PackSourceError {
  const error = captureError(action);
  expect(error).toBeInstanceOf(PackSourceError);
  expect(error).toMatchObject({ code, layer: PACKAGING_SOURCE_LAYER });
  expect(Object.isFrozen(error)).toBe(true);
  expect(String(error)).not.toContain(SECRET);
  return error as PackSourceError;
}

function temporaryOwner(dependencies: Partial<PackSourceDependencies> = {}): {
  readonly dependencies: PackSourceDependencies;
  readonly owners: string[];
} {
  const owners: string[] = [];
  return {
    dependencies: {
      ...dependencies,
      makeTemporaryRoot: () => {
        const owner = mkdtempSync(join(tmpdir(), "moe-pack-source-owner-test-"));
        owners.push(owner);
        roots.push(owner);
        return owner;
      },
    },
    owners,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("exact-commit packaging source", () => {
  it("materializes only the selected commit's tracked bytes and cleans its callback-only root", () => {
    const fixture = createGitFixture();
    let sourceRoot = "";
    const answer = withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, (source) => {
      sourceRoot = source.sourceRoot;
      expect(Object.isFrozen(source)).toBe(true);
      expect(Object.isFrozen(source.trackedPaths)).toBe(true);
      expect(source.sourceSha).toBe(fixture.selectedSha);
      expect(source.trackedPaths).toEqual(fixture.trackedPaths);
      expect(readFileSync(join(source.sourceRoot, "src", "version.txt"), "utf8"))
        .toBe("version-one\n");
      expect(existsSync(join(source.sourceRoot, "packages", "contracts", ".env"))).toBe(false);
      expect(existsSync(join(source.sourceRoot, "untracked-sentinel.txt"))).toBe(false);
      return Object.freeze({ selected: source.sourceSha, tracked: source.trackedPaths.length });
    });

    expect(answer).toEqual({ selected: fixture.selectedSha, tracked: fixture.trackedPaths.length });
    expect(sourceRoot).not.toBe("");
    expect(existsSync(dirname(sourceRoot))).toBe(false);
    expect(fixture.headSha).not.toBe(fixture.selectedSha);
  });

  it("accepts an exact lowercase SHA-256 commit without weakening the SHA-1 path", () => {
    const fixture = createGitFixture("sha256");
    expect(fixture.selectedSha).toMatch(/^[0-9a-f]{64}$/u);
    const observed = withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, (source) => ({ sha: source.sourceSha, paths: source.trackedPaths }));
    expect(observed).toEqual({ sha: fixture.selectedSha, paths: fixture.trackedPaths });
  });

  it("ignores local Git replacement refs that try to restamp HEAD as the selected commit", () => {
    const fixture = createGitFixture();
    run("git", ["replace", fixture.selectedSha, fixture.headSha], fixture.repositoryRoot);
    const materialized = withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, (source) => readFileSync(join(source.sourceRoot, "src", "version.txt"), "utf8"));
    expect(materialized).toBe("version-one\n");
  });

  const invalidInputNames = Object.freeze(["symbolic", "mixed-case", "short"] as const);
  it("rejects symbolic, mixed-case, and short identities before spawning archive authority", () => {
    const fixture = createGitFixture();
    const cases = [
      { name: "symbolic", sourceSha: "HEAD" },
      { name: "mixed-case", sourceSha: "A".repeat(40) },
      { name: "short", sourceSha: fixture.selectedSha.slice(0, 12) },
    ] as const;
    expect(cases.map(({ name }) => name)).toEqual(invalidInputNames);
    expect(cases.length).toBeGreaterThan(0);
    for (const testCase of cases) {
      expectPackSourceError(() => withMaterializedPackSource({
        repositoryRoot: fixture.repositoryRoot,
        sourceSha: testCase.sourceSha,
      }, () => undefined), "PACK_SOURCE_INPUT_INVALID");
    }
  });

  it("rejects a full-length blob identity because it is not a commit", () => {
    const fixture = createGitFixture();
    expect(fixture.blobSha).toMatch(/^[0-9a-f]{40}$/u);
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.blobSha,
    }, () => undefined), "PACK_SOURCE_COMMIT_UNAVAILABLE");
  });

  it("rejects malformed request records at the same input boundary", () => {
    const fixture = createGitFixture();
    const cases: readonly unknown[] = Object.freeze([
      null,
      {},
      { repositoryRoot: "", sourceSha: fixture.selectedSha },
      { extra: true, repositoryRoot: fixture.repositoryRoot, sourceSha: fixture.selectedSha },
      { repositoryRoot: fixture.repositoryRoot, sourceSha: `${fixture.selectedSha}${SECRET}` },
    ]);
    expect(cases.length).toBeGreaterThan(0);
    for (const request of cases) {
      expectPackSourceError(() => withMaterializedPackSource(
        request as never,
        () => undefined,
      ), "PACK_SOURCE_INPUT_INVALID");
    }
  });

  it("publishes one frozen closed code roster at the packaging-source layer", () => {
    expect(Object.isFrozen(PACK_SOURCE_ERROR_CODES)).toBe(true);
    expect(PACK_SOURCE_ERROR_CODES).toEqual([
      "PACK_SOURCE_INPUT_INVALID",
      "PACK_SOURCE_COMMIT_UNAVAILABLE",
      "PACK_SOURCE_ROSTER_FAILED",
      "PACK_SOURCE_ARCHIVE_FAILED",
      "PACK_SOURCE_EXTRACT_FAILED",
      "PACK_SOURCE_ROSTER_MISMATCH",
      "PACK_SOURCE_CLEANUP_FAILED",
    ]);
    expect(PACK_SOURCE_ERROR_CODES.length).toBeGreaterThan(0);
  });
});

describe("packaging-source failures and cleanup", () => {
  const commandFailures = Object.freeze([
    {
      code: "PACK_SOURCE_ROSTER_FAILED",
      expectedOwners: 0,
      matches: (command: string, args: readonly string[]) => command === "git" && isGitCommand(args, "ls-tree"),
      name: "tracked roster",
    },
    {
      code: "PACK_SOURCE_ARCHIVE_FAILED",
      expectedOwners: 1,
      matches: (command: string, args: readonly string[]) => command === "git" && isGitCommand(args, "archive"),
      name: "archive",
    },
    {
      code: "PACK_SOURCE_EXTRACT_FAILED",
      expectedOwners: 1,
      matches: (command: string) => command === "tar",
      name: "extraction",
    },
  ] as const);

  it("maps command failures to exact non-secret codes and cleans every owner root", () => {
    expect(commandFailures.length).toBeGreaterThan(0);
    for (const testCase of commandFailures) {
      const fixture = createGitFixture();
      const command: PackSourceCommand = (executable, args, cwd) => testCase.matches(executable, args)
        ? { status: 1, stderr: Buffer.from(SECRET), stdout: Buffer.from(SECRET) }
        : systemCommand(executable, args, cwd);
      const injected = temporaryOwner({ command });
      expectPackSourceError(() => withMaterializedPackSource({
        repositoryRoot: fixture.repositoryRoot,
        sourceSha: fixture.selectedSha,
      }, () => undefined, injected.dependencies), testCase.code);
      expect(injected.owners.length).toBe(testCase.expectedOwners);
      expect(injected.owners.every((owner) => !existsSync(owner))).toBe(true);
    }
  });

  it("maps a synchronously throwing command port without leaking its cause", () => {
    const fixture = createGitFixture();
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, {
      command: () => { throw new Error(SECRET); },
    }), "PACK_SOURCE_COMMIT_UNAVAILABLE");
  });

  it("rejects decorated commit output instead of trimming it into authority", () => {
    const fixture = createGitFixture();
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, {
      command: () => ({
        status: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(` ${fixture.selectedSha}\n`),
      }),
    }), "PACK_SOURCE_COMMIT_UNAVAILABLE");
  });

  it("refuses an extracted tree whose paths do not exactly match the Git roster", () => {
    const fixture = createGitFixture();
    const command: PackSourceCommand = (executable, args, cwd) => {
      const result = systemCommand(executable, args, cwd);
      if (executable === "tar" && result.status === 0) {
        const destinationIndex = args.indexOf("-C");
        const destination = args[destinationIndex + 1];
        if (destination !== undefined) {
          rmSync(join(destination, "src", "version.txt"), { force: true });
          writeFileSync(repositoryPath(destination, "injected-untracked.txt"), SECRET, "utf8");
        }
      }
      return result;
    };
    const injected = temporaryOwner({ command });
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, injected.dependencies), "PACK_SOURCE_ROSTER_MISMATCH");
    expect(injected.owners.every((owner) => !existsSync(owner))).toBe(true);
  });

  it("preserves the consumer exception while reporting a subordinate cleanup code only", () => {
    const fixture = createGitFixture();
    const primary = new Error("consumer failure is primary");
    const reports: string[] = [];
    const injected = temporaryOwner({
      removeTemporaryRoot: () => { throw new Error(SECRET); },
      reportCleanupFailure: (code) => { reports.push(code); throw new Error(SECRET); },
    });
    const error = captureError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => { throw primary; }, injected.dependencies));
    expect(error).toBe(primary);
    expect(reports).toEqual(["PACK_SOURCE_CLEANUP_FAILED"]);
    expect(reports.join(" ")).not.toContain(SECRET);
    expect(injected.owners.some((owner) => existsSync(owner))).toBe(true);
  });

  it("throws the stable cleanup error when cleanup is the only failure", () => {
    const fixture = createGitFixture();
    const injected = temporaryOwner({
      removeTemporaryRoot: () => { throw new Error(SECRET); },
    });
    const error = expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => "materialized", injected.dependencies), "PACK_SOURCE_CLEANUP_FAILED");
    expect(error.message).toBe("PACK_SOURCE_CLEANUP_FAILED");
    expect(injected.owners.some((owner) => existsSync(owner))).toBe(true);
  });

  it("preserves a materialization error when cleanup also fails", () => {
    const fixture = createGitFixture();
    const reports: string[] = [];
    const injected = temporaryOwner({
      command: (executable, args, cwd) => executable === "git" && isGitCommand(args, "archive")
        ? { status: 1, stderr: Buffer.from(SECRET), stdout: Buffer.alloc(0) }
        : systemCommand(executable, args, cwd),
      removeTemporaryRoot: () => { throw new Error(SECRET); },
      reportCleanupFailure: (code) => reports.push(code),
    });
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, injected.dependencies), "PACK_SOURCE_ARCHIVE_FAILED");
    roots.push(...injected.owners);
    expect(reports).toEqual(["PACK_SOURCE_CLEANUP_FAILED"]);
  });
});

function repositoryPath(root: string, path: string): string {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  return target;
}
