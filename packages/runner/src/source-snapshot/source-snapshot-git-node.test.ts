import { execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  MAX_SOURCE_SNAPSHOT_GIT_OUTPUT_BYTES,
  RUNNER_SOURCE_SNAPSHOT_GIT_CODES,
  RUNNER_SOURCE_SNAPSHOT_GIT_LAYER,
  SOURCE_SNAPSHOT_GIT_TIMEOUT_MS,
} from "./source-snapshot-git-contract.js";
import {
  createNodeSourceSnapshotGitObserver,
  observeSourceSnapshotGitWithPort,
  type SourceSnapshotGitCommandResult,
  type SourceSnapshotGitNodePort,
} from "./source-snapshot-git-node.js";

const encoder = new TextEncoder();
const roots: string[] = [];
const EXPECTED = "a".repeat(64);
const TREE = "b".repeat(40);
const CHANGED = "c".repeat(64);

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

const output = (text: string): SourceSnapshotGitCommandResult =>
  Object.freeze({ ok: true as const, stdout: encoder.encode(text) });
const failed = (): SourceSnapshotGitCommandResult =>
  Object.freeze({ failure: "FAILED" as const, ok: false as const });
const overflow = (): SourceSnapshotGitCommandResult =>
  Object.freeze({ failure: "OVERFLOW" as const, ok: false as const });

interface PortOptions {
  readonly headAnswers?: readonly Uint8Array[];
  readonly rootAnswer?: SourceSnapshotGitCommandResult;
  readonly treeAnswer?: SourceSnapshotGitCommandResult;
  readonly topLevel?: string;
}

function scriptedPort(options: PortOptions = {}): {
  readonly calls: readonly (readonly string[])[];
  readonly port: SourceSnapshotGitNodePort;
} {
  const calls: (readonly string[])[] = [];
  const heads = [...(options.headAnswers ?? [
    encoder.encode(`${EXPECTED}\n`), encoder.encode(`${EXPECTED}\n`),
  ])];
  const root = "/srv/repository";
  const topLevel = options.topLevel ?? root;
  const port: SourceSnapshotGitNodePort = Object.freeze({
    realpath(path: string): string {
      if (path === root || path === topLevel) return path;
      throw new Error(`unexpected realpath ${path}`);
    },
    run(_repositoryRoot: string, args: readonly string[]): SourceSnapshotGitCommandResult {
      calls.push([...args]);
      const key = JSON.stringify(args);
      if (key === JSON.stringify([
        "rev-parse", "--path-format=absolute", "--show-toplevel",
      ])) return options.rootAnswer ?? output(`${topLevel}\n`);
      if (key === JSON.stringify([
        "rev-parse", "--verify", "--quiet", "HEAD^{commit}",
      ])) {
        const answer = heads.shift();
        return answer === undefined ? failed() : Object.freeze({ ok: true, stdout: answer });
      }
      if (key === JSON.stringify([
        "rev-parse", "--verify", `${EXPECTED}^{tree}`,
      ])) return options.treeAnswer ?? output(`${TREE}\n`);
      return failed();
    },
  });
  return { calls, port };
}

describe("source-snapshot Git contract", () => {
  it("publishes one exact layer, closed codes, and bounded process limits", () => {
    expect(RUNNER_SOURCE_SNAPSHOT_GIT_LAYER).toBe("RUNNER_SOURCE_SNAPSHOT_GIT");
    expect(RUNNER_SOURCE_SNAPSHOT_GIT_CODES).toEqual([
      "RUNNER_SOURCE_SNAPSHOT_ROOT_UNRESOLVABLE",
      "RUNNER_SOURCE_SNAPSHOT_REPOSITORY_OWNERSHIP_MISMATCH",
      "RUNNER_SOURCE_SNAPSHOT_EXPECTED_REVISION_INVALID",
      "RUNNER_SOURCE_SNAPSHOT_HEAD_MISMATCH",
      "RUNNER_SOURCE_SNAPSHOT_TREE_UNREADABLE",
      "RUNNER_SOURCE_SNAPSHOT_OUTPUT_MALFORMED",
      "RUNNER_SOURCE_SNAPSHOT_OBSERVATION_FAILED",
      "RUNNER_SOURCE_SNAPSHOT_OBSERVATION_OVERFLOW",
    ]);
    expect(MAX_SOURCE_SNAPSHOT_GIT_OUTPUT_BYTES).toBe(4 * 1024);
    expect(SOURCE_SNAPSHOT_GIT_TIMEOUT_MS).toBe(30_000);
  });
});

describe("observeSourceSnapshotGitWithPort", () => {
  it("runs every Git query from the resolved real repository root", () => {
    const configured = "/srv/catalog-link";
    const real = "/srv/repository";
    const commandRoots: unknown[] = [];
    const scripted = scriptedPort();
    const port = {
      realpath(path: string): string {
        return path === configured ? real : scripted.port.realpath(path);
      },
      run(repositoryRoot: string, args: readonly string[]): SourceSnapshotGitCommandResult {
        commandRoots.push(repositoryRoot);
        return repositoryRoot === real ? scripted.port.run(repositoryRoot, args) : failed();
      },
    } satisfies SourceSnapshotGitNodePort;
    expect(observeSourceSnapshotGitWithPort(configured, EXPECTED, port))
      .toMatchObject({ ok: true });
    expect(commandRoots).toEqual([real, real, real, real]);
  });

  it("derives the tree from the expected immutable commit and returns a frozen observation", () => {
    const { calls, port } = scriptedPort();
    const result = observeSourceSnapshotGitWithPort("/srv/repository", EXPECTED, port);
    expect(result).toEqual({
      observation: {
        baseRevisionHash: EXPECTED,
        realRepositoryRoot: "/srv/repository",
        repositoryBaseTree: TREE,
      },
      ok: true,
    });
    expect(calls).toEqual([
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      ["rev-parse", "--verify", `${EXPECTED}^{tree}`],
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    if (!result.ok) throw new Error("fixture unexpectedly refused");
    expect(Object.isFrozen(result.observation)).toBe(true);
  });

  it("refuses a HEAD move after the tree read", () => {
    const { calls, port } = scriptedPort({
      headAnswers: [encoder.encode(`${EXPECTED}\n`), encoder.encode(`${CHANGED}\n`)],
    });
    expect(observeSourceSnapshotGitWithPort("/srv/repository", EXPECTED, port)).toEqual({
      code: "RUNNER_SOURCE_SNAPSHOT_HEAD_MISMATCH",
      layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
      ok: false,
    });
    expect(calls.filter((args) => args.includes("HEAD^{commit}"))).toHaveLength(2);
  });

  it("refuses an initial HEAD mismatch before asking for a tree", () => {
    const { calls, port } = scriptedPort({
      headAnswers: [encoder.encode(`${CHANGED}\n`)],
    });
    expect(observeSourceSnapshotGitWithPort("/srv/repository", EXPECTED, port)).toEqual({
      code: "RUNNER_SOURCE_SNAPSHOT_HEAD_MISMATCH",
      layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
      ok: false,
    });
    expect(calls.some((args) => args.includes(`${EXPECTED}^{tree}`))).toBe(false);
  });

  it("refuses a configured directory whose Git top-level is a different root", () => {
    const { port } = scriptedPort({ topLevel: "/srv/parent" });
    expect(observeSourceSnapshotGitWithPort("/srv/repository", EXPECTED, port)).toEqual({
      code: "RUNNER_SOURCE_SNAPSHOT_REPOSITORY_OWNERSHIP_MISMATCH",
      layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
      ok: false,
    });
  });

  it("refuses an unresolvable configured root without invoking Git", () => {
    let calls = 0;
    const port: SourceSnapshotGitNodePort = {
      realpath() { throw new Error("absent"); },
      run() { calls += 1; return failed(); },
    };
    expect(observeSourceSnapshotGitWithPort("/srv/absent", EXPECTED, port)).toEqual({
      code: "RUNNER_SOURCE_SNAPSHOT_ROOT_UNRESOLVABLE",
      layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
      ok: false,
    });
    expect(calls).toBe(0);
  });

  it.each([
    ["SHA-1", "a".repeat(40)],
    ["uppercase SHA-256", "A".repeat(64)],
    ["short SHA-256", "a".repeat(63)],
  ])("refuses an invalid %s expected revision before resolving a path or invoking Git", (
    _name, invalidExpected,
  ) => {
    let observations = 0;
    const port: SourceSnapshotGitNodePort = {
      realpath() { observations += 1; return "/srv/repository"; },
      run() { observations += 1; return failed(); },
    };
    expect(observeSourceSnapshotGitWithPort(
      "/srv/repository", invalidExpected, port,
    )).toEqual({
      code: "RUNNER_SOURCE_SNAPSHOT_EXPECTED_REVISION_INVALID",
      layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
      ok: false,
    });
    expect(observations).toBe(0);
  });

  it("distinguishes an unreadable expected tree from a generic observation failure", () => {
    const tree = scriptedPort({ treeAnswer: failed() });
    expect(observeSourceSnapshotGitWithPort(
      "/srv/repository", EXPECTED, tree.port,
    )).toEqual({
      code: "RUNNER_SOURCE_SNAPSHOT_TREE_UNREADABLE",
      layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
      ok: false,
    });
    const root = scriptedPort({ rootAnswer: failed() });
    expect(observeSourceSnapshotGitWithPort(
      "/srv/repository", EXPECTED, root.port,
    )).toEqual({
      code: "RUNNER_SOURCE_SNAPSHOT_OBSERVATION_FAILED",
      layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
      ok: false,
    });
  });

  it("keeps overflow distinct at every Git operation", () => {
    const root = scriptedPort({ rootAnswer: overflow() });
    expect(observeSourceSnapshotGitWithPort(
      "/srv/repository", EXPECTED, root.port,
    )).toMatchObject({ code: "RUNNER_SOURCE_SNAPSHOT_OBSERVATION_OVERFLOW", ok: false });
    const tree = scriptedPort({ treeAnswer: overflow() });
    expect(observeSourceSnapshotGitWithPort(
      "/srv/repository", EXPECTED, tree.port,
    )).toMatchObject({ code: "RUNNER_SOURCE_SNAPSHOT_OBSERVATION_OVERFLOW", ok: false });
  });

  it.each([
    ["uppercase", encoder.encode(`${"B".repeat(40)}\n`)],
    ["short", encoder.encode(`${"b".repeat(39)}\n`)],
    ["missing line terminator", encoder.encode(TREE)],
    ["multiple records", encoder.encode(`${TREE}\n${TREE}\n`)],
    ["invalid UTF-8", Uint8Array.of(0xff, 0x0a)],
  ] as const)("refuses malformed %s tree output", (_name, bytes) => {
    const { port } = scriptedPort({
      treeAnswer: Object.freeze({ ok: true as const, stdout: bytes }),
    });
    expect(observeSourceSnapshotGitWithPort("/srv/repository", EXPECTED, port)).toEqual({
      code: "RUNNER_SOURCE_SNAPSHOT_OUTPUT_MALFORMED",
      layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
      ok: false,
    });
  });
});

interface RepositoryFixture {
  readonly head: string;
  readonly root: string;
  readonly tree: string;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "@0 +0000",
      GIT_COMMITTER_DATE: "@0 +0000",
    },
    shell: false,
    windowsHide: true,
  }).trimEnd();
}

function repository(objectFormat: "sha1" | "sha256"): RepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), `moe-source-snapshot-${objectFormat}-`));
  roots.push(root);
  const format = objectFormat === "sha256" ? ["--object-format=sha256"] : [];
  git(root, ["init", ...format, "--initial-branch=main", "--quiet"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "user.email", "source-snapshot@example.invalid"]);
  git(root, ["config", "user.name", "Source Snapshot Test"]);
  writeFileSync(join(root, "seed.txt"), `${objectFormat} seed\n`, "utf8");
  git(root, ["add", "--", "seed.txt"]);
  git(root, ["commit", "--quiet", "--no-gpg-sign", "-m", "seed"]);
  return Object.freeze({
    head: git(root, ["rev-parse", "HEAD"]),
    root: realpathSync(root),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
  });
}

function supportsSha256(): boolean {
  const root = mkdtempSync(join(tmpdir(), "moe-source-snapshot-sha256-probe-"));
  try {
    execFileSync("git", ["init", "--object-format=sha256", "--quiet"], {
      cwd: root, shell: false, stdio: "ignore", windowsHide: true,
    });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("createNodeSourceSnapshotGitObserver — real Git", { timeout: 30_000 }, () => {
  it("refuses a real SHA-1 commit as an invalid SourceSnapshot expected revision", () => {
    const fixture = repository("sha1");
    const observer = createNodeSourceSnapshotGitObserver(fixture.root, {
      ...process.env,
      GIT_DIR: join(fixture.root, "hostile-git-dir"),
      GIT_WORK_TREE: join(fixture.root, "hostile-work-tree"),
    });
    expect(observer.observe(fixture.head)).toEqual({
      code: "RUNNER_SOURCE_SNAPSHOT_EXPECTED_REVISION_INVALID",
      layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
      ok: false,
    });
  });

  it("refuses a nested directory even though Git would discover its ancestor repository", () => {
    const fixture = repository("sha1");
    const nested = join(fixture.root, "nested");
    mkdirSync(nested);
    const observer = createNodeSourceSnapshotGitObserver(nested, process.env);
    expect(observer.observe("a".repeat(64))).toEqual({
      code: "RUNNER_SOURCE_SNAPSHOT_REPOSITORY_OWNERSHIP_MISMATCH",
      layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
      ok: false,
    });
  });

  it("refuses a real repository whose current HEAD differs from the expected commit", () => {
    const fixture = repository("sha1");
    writeFileSync(join(fixture.root, "second.txt"), "second\n", "utf8");
    git(fixture.root, ["add", "--", "second.txt"]);
    git(fixture.root, ["commit", "--quiet", "--no-gpg-sign", "-m", "second"]);
    const observer = createNodeSourceSnapshotGitObserver(fixture.root, process.env);
    expect(observer.observe("a".repeat(64))).toEqual({
      code: "RUNNER_SOURCE_SNAPSHOT_HEAD_MISMATCH",
      layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
      ok: false,
    });
  });

  it("refuses a missing configured root before spawning Git", () => {
    const missing = join(tmpdir(), `moe-source-snapshot-missing-${process.pid}`);
    const observer = createNodeSourceSnapshotGitObserver(missing, process.env);
    expect(observer.observe("a".repeat(64))).toEqual({
      code: "RUNNER_SOURCE_SNAPSHOT_ROOT_UNRESOLVABLE",
      layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
      ok: false,
    });
  });
});

const describeSha256 = supportsSha256() ? describe : describe.skip;
describeSha256("createNodeSourceSnapshotGitObserver — real SHA-256 Git", { timeout: 30_000 }, () => {
  it("observes the exact 64-hex commit and tree", () => {
    const fixture = repository("sha256");
    expect(fixture.head).toMatch(/^[0-9a-f]{64}$/u);
    expect(fixture.tree).toMatch(/^[0-9a-f]{64}$/u);
    const result = createNodeSourceSnapshotGitObserver(fixture.root, process.env)
      .observe(fixture.head);
    expect(result).toEqual({
      observation: {
        baseRevisionHash: fixture.head,
        realRepositoryRoot: fixture.root,
        repositoryBaseTree: fixture.tree,
      },
      ok: true,
    });
  });
});
