import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { posix } from "node:path";

import { describe, expect, it } from "vitest";

const BIN_TARGET_LAYER = "PORTABILITY_BIN_TARGET" as const;
const BIN_TARGET_CODES = Object.freeze({
  blobUnreadable: "BIN_TARGET_HEAD_BLOB_UNREADABLE",
  crByte: "BIN_TARGET_HEAD_CR_BYTE",
  headMoved: "BIN_TARGET_HEAD_MOVED",
  indexMissing: "BIN_TARGET_INDEX_ENTRY_MISSING",
  indexUnmerged: "BIN_TARGET_INDEX_UNMERGED",
  manifestInvalid: "BIN_TARGET_MANIFEST_INVALID",
  modeMismatch: "BIN_TARGET_INDEX_MODE_MISMATCH",
  pathInvalid: "BIN_TARGET_PATH_INVALID",
  rosterUndersized: "BIN_TARGET_ROSTER_UNDERSIZED",
  shebangMissing: "BIN_TARGET_HEAD_SHEBANG_MISSING",
} as const);
const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const MODE_TARGET = "apps/daemon/src/mcp-main.ts";
const SHEBANG_TARGET = "apps/daemon/src/orchestrator/moe-up-main.ts";

interface BinTargetFinding {
  readonly code: string;
  readonly command?: string;
  readonly layer: typeof BIN_TARGET_LAYER;
  readonly manifestPath?: string;
  readonly observedMode?: string;
  readonly targetPath?: string;
}

interface BinTargetRecord {
  readonly command: string;
  readonly headHasCr: boolean;
  readonly headHasShebang: boolean;
  readonly manifestPath: string;
  readonly mode: string;
  readonly targetPath: string;
}

interface BinTargetObservation {
  readonly findings: readonly BinTargetFinding[];
  readonly head: string | undefined;
  readonly manifests: readonly string[];
  readonly targets: readonly BinTargetRecord[];
}

function freezeObservation(
  head: string | undefined, manifests: readonly string[], targets: readonly BinTargetRecord[],
  findings: readonly BinTargetFinding[],
): BinTargetObservation {
  return Object.freeze({
    findings: Object.freeze(findings.map((entry) => Object.freeze(entry))), head,
    manifests: Object.freeze([...manifests]),
    targets: Object.freeze(targets.map((entry) => Object.freeze(entry))),
  });
}

function finding(code: string, details: Omit<BinTargetFinding, "code" | "layer"> = {}): BinTargetFinding {
  return { code, layer: BIN_TARGET_LAYER, ...details };
}

function tryGit(repository: string, args: readonly string[]): Buffer | undefined {
  try { return runGit(repository, args); } catch { return undefined; }
}

function oneLine(output: Buffer | undefined): string | undefined {
  if (output === undefined || output.includes(0)) return undefined;
  const value = output.toString("utf8").replace(/\n$/u, "");
  return /^[0-9a-f]{40,64}$/u.test(value) ? value : undefined;
}

function workspaceGlobs(bytes: Buffer | undefined): readonly string[] | undefined {
  if (bytes === undefined || bytes.includes(0) || bytes.includes(13)) return undefined;
  const lines = bytes.toString("utf8").split("\n"), start = lines.indexOf("packages:");
  if (start < 0) return undefined;
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "" || /^\s*#/u.test(line)) continue;
    const item = /^\s+-\s+([^\s#]+)\s*$/u.exec(line)?.[1];
    if (item !== undefined) {
      if (!/^[A-Za-z0-9._*?/-]+$/u.test(item) || item.includes("..")
        || item.startsWith("/") || item.includes("\\")) return undefined;
      globs.push(item);
      continue;
    }
    if (!/^\s/u.test(line)) break;
    return undefined;
  }
  return globs.length > 0 ? globs : undefined;
}

function nulPaths(output: Buffer | undefined): readonly string[] | undefined {
  if (output === undefined || output.length === 0 || output.at(-1) !== 0) return undefined;
  const decoded = output.subarray(0, -1).toString("utf8");
  if (decoded.includes("�")) return undefined;
  const paths = decoded.split("\0");
  return paths.every((path) => path !== "" && !path.includes("\\")) ? paths : undefined;
}

function binEntries(manifestPath: string, bytes: Buffer | undefined): readonly [string, string][] | undefined {
  if (bytes === undefined || bytes.includes(0)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return undefined; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>, bin = record.bin;
  if (bin === undefined) return [];
  if (typeof bin === "string") {
    const name = record.name;
    if (typeof name !== "string" || name === "" || bin === "") return undefined;
    return [[name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name, bin]];
  }
  if (bin === null || typeof bin !== "object" || Array.isArray(bin)) return undefined;
  const entries = Object.entries(bin);
  return entries.every(([command, target]) => command !== "" && typeof target === "string" && target !== "")
    ? entries as readonly [string, string][] : undefined;
}

function targetPath(manifestPath: string, rawTarget: string): string | undefined {
  if (rawTarget.includes("\0") || rawTarget.includes("\\") || posix.isAbsolute(rawTarget)) return undefined;
  const resolved = posix.normalize(posix.join(posix.dirname(manifestPath), rawTarget));
  return resolved !== ".." && !resolved.startsWith("../") && resolved !== "." ? resolved : undefined;
}

function indexMode(repository: string, target: string): string | "MISSING" | "UNMERGED" {
  const output = tryGit(repository, ["ls-files", "-s", "-z", "--", `:(top,literal)${target}`]);
  if (output === undefined || output.length === 0) return "MISSING";
  if (output.at(-1) !== 0) return "UNMERGED";
  const entries = output.subarray(0, -1).toString("utf8").split("\0");
  if (entries.length !== 1) return "UNMERGED";
  const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t(.+)$/u.exec(entries[0] ?? "");
  return match?.[3] === "0" && match[4] === target ? match[1] ?? "UNMERGED" : "UNMERGED";
}

function inspectTarget(
  repository: string, head: string, manifestPath: string, command: string, target: string,
  findings: BinTargetFinding[],
): BinTargetRecord {
  const mode = indexMode(repository, target);
  if (mode === "MISSING") findings.push(finding(BIN_TARGET_CODES.indexMissing,
    { command, manifestPath, targetPath: target }));
  else if (mode === "UNMERGED") findings.push(finding(BIN_TARGET_CODES.indexUnmerged,
    { command, manifestPath, targetPath: target }));
  else if (mode !== "100755") findings.push(finding(BIN_TARGET_CODES.modeMismatch,
    { command, manifestPath, observedMode: mode, targetPath: target }));
  const blob = tryGit(repository, ["cat-file", "-p", `${head}:${target}`]);
  if (blob === undefined) findings.push(finding(BIN_TARGET_CODES.blobUnreadable,
    { command, manifestPath, targetPath: target }));
  const headHasShebang = blob?.[0] === 35 && blob[1] === 33, headHasCr = blob?.includes(13) ?? false;
  if (blob !== undefined && !headHasShebang) findings.push(finding(BIN_TARGET_CODES.shebangMissing,
    { command, manifestPath, targetPath: target }));
  if (blob !== undefined && headHasCr) findings.push(finding(BIN_TARGET_CODES.crByte,
    { command, manifestPath, targetPath: target }));
  return { command, headHasCr, headHasShebang, manifestPath, mode, targetPath: target };
}

function observeRepositoryBinTargets(root: string): BinTargetObservation {
  const findings: BinTargetFinding[] = [], targets: BinTargetRecord[] = [];
  const head = oneLine(tryGit(root, ["rev-parse", "--verify", "HEAD"]));
  if (head === undefined) return freezeObservation(undefined, [], [], [finding(BIN_TARGET_CODES.headMoved)]);
  const globs = workspaceGlobs(tryGit(root, ["cat-file", "-p", `${head}:pnpm-workspace.yaml`]));
  if (globs === undefined) return freezeObservation(head, [], [], [finding(
    BIN_TARGET_CODES.manifestInvalid, { manifestPath: "pnpm-workspace.yaml" },
  )]);
  const pathspecs = [":(top,literal)package.json",
    ...globs.map((glob) => `:(top,glob)${glob}/package.json`)];
  const manifests = nulPaths(tryGit(root, ["ls-files", "-z", "--", ...pathspecs]));
  if (manifests === undefined) return freezeObservation(head, [], [], [finding(
    BIN_TARGET_CODES.manifestInvalid, { manifestPath: "<workspace-roster>" },
  )]);
  for (const manifestPath of manifests) {
    const entries = binEntries(manifestPath, tryGit(root, ["cat-file", "-p", `${head}:${manifestPath}`]));
    if (entries === undefined) {
      findings.push(finding(BIN_TARGET_CODES.manifestInvalid, { manifestPath }));
      continue;
    }
    for (const [command, rawTarget] of entries) {
      const target = targetPath(manifestPath, rawTarget);
      if (target === undefined) findings.push(finding(BIN_TARGET_CODES.pathInvalid,
        { command, manifestPath, targetPath: rawTarget }));
      else targets.push(inspectTarget(root, head, manifestPath, command, target, findings));
    }
  }
  targets.sort((left, right) => left.targetPath.localeCompare(right.targetPath)
    || left.command.localeCompare(right.command));
  if (targets.length < 6) findings.push(finding(BIN_TARGET_CODES.rosterUndersized));
  const after = oneLine(tryGit(root, ["rev-parse", "--verify", "HEAD"]));
  if (after !== head) findings.push(finding(BIN_TARGET_CODES.headMoved));
  return freezeObservation(head, manifests, targets, findings);
}

function isolatedGitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  Object.assign(environment, {
    GIT_ATTR_NOSYSTEM: "1", GIT_AUTHOR_EMAIL: "portability@example.invalid",
    GIT_AUTHOR_NAME: "Portability Fixture", GIT_COMMITTER_EMAIL: "portability@example.invalid",
    GIT_COMMITTER_NAME: "Portability Fixture",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0", LC_ALL: "C",
  });
  return environment;
}

function gitExecutable(): string {
  return process.env.MOE_PORTABILITY_GIT_EXECUTABLE ?? "git";
}

function runGit(repository: string, args: readonly string[], input?: Uint8Array): Buffer {
  const result = spawnSync(gitExecutable(), [
    "--no-replace-objects", "-c", `safe.directory=${repository}`,
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
    "-C", repository, ...args,
  ], {
    encoding: null, env: isolatedGitEnvironment(process.env), input,
    maxBuffer: 4 * 1024 * 1024, shell: false, stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000, windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(`git ${args[0] ?? "command"} failed`);
  }
  return result.stdout;
}

function cloneWithoutCheckout(parent: string, repository: string): void {
  const result = spawnSync(gitExecutable(), [
    "--no-replace-objects", "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "clone", "--no-hardlinks", "--no-checkout", "--quiet", REPOSITORY_ROOT, repository,
  ], {
    cwd: parent, encoding: "utf8", env: isolatedGitEnvironment(process.env),
    maxBuffer: 4 * 1024 * 1024, shell: false, stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000, windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) throw new Error("fixture clone failed");
  runGit(repository, ["read-tree", "HEAD"]);
}

function text(output: Buffer): string {
  return output.toString("utf8").replace(/\r?\n$/u, "");
}

function writeBlob(repository: string, bytes: Uint8Array): string {
  return text(runGit(repository, ["hash-object", "-w", "--stdin"], bytes));
}

function stageBlob(repository: string, mode: string, objectId: string, path: string): void {
  runGit(repository, ["update-index", "--add", "--cacheinfo", `${mode},${objectId},${path}`]);
}

function commitIndex(repository: string, label: string): void {
  const tree = text(runGit(repository, ["write-tree"]));
  const parent = text(runGit(repository, ["rev-parse", "--verify", "HEAD"]));
  const commit = text(runGit(repository, ["commit-tree", tree, "-p", parent, "-m", label]));
  runGit(repository, ["update-ref", "HEAD", commit, parent]);
}

function withFixture(
  label: string, mutate: (repository: string) => void,
  assertObservation: (observation: BinTargetObservation) => void,
): void {
  const parent = mkdtempSync(join(tmpdir(), `moe bin targets worker-4d8ff141 ${label} `));
  const repository = join(parent, "repository clone");
  try {
    cloneWithoutCheckout(parent, repository);
    mutate(repository);
    commitIndex(repository, label);
    assertObservation(observeRepositoryBinTargets(repository));
  } finally {
    rmSync(parent, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
  }
}

function expectOnlyFinding(
  observation: BinTargetObservation, expected: BinTargetFinding,
): void {
  expect(observation.findings).toEqual([expected]);
}

const CURRENT = observeRepositoryBinTargets(REPOSITORY_ROOT);
const PLACEHOLDER: BinTargetRecord = Object.freeze({
  command: "<unimplemented>", headHasCr: false, headHasShebang: false,
  manifestPath: "<unimplemented>", mode: "<unimplemented>", targetPath: "<unimplemented>",
});
const GENERATED_TARGET_CASES = CURRENT.targets.length === 0 ? [PLACEHOLDER] : [...CURRENT.targets];

describe("workspace package bin targets", { timeout: 30_000 }, () => {
  it("discovers a nonzero manifest-derived target census without findings", () => {
    expect(CURRENT.findings).toEqual([]);
    expect(CURRENT.manifests.length).toBeGreaterThan(0);
    expect(CURRENT.targets.length).toBeGreaterThanOrEqual(6);
  });

  it("generates one nonzero case for every discovered production target", () => {
    expect(CURRENT.targets.length).toBeGreaterThan(0);
    expect(GENERATED_TARGET_CASES).toEqual(CURRENT.targets);
  });

  it.each(GENERATED_TARGET_CASES)("accepts tracked executable $targetPath", (target) => {
    expect(CURRENT.findings).toEqual([]);
    expect(target.mode).toBe("100755");
    expect(target.headHasShebang).toBe(true);
    expect(target.headHasCr).toBe(false);
  });

  it("reports only the exact index-mode finding for valid bytes tracked 100644", () => {
    withFixture("mode mismatch", (repository) => {
      const objectId = text(runGit(repository, ["rev-parse", `HEAD:${MODE_TARGET}`]));
      stageBlob(repository, "100644", objectId, MODE_TARGET);
    }, (observation) => expectOnlyFinding(observation, {
      code: BIN_TARGET_CODES.modeMismatch, command: "moe-mcp-stdio", layer: BIN_TARGET_LAYER,
      manifestPath: "apps/daemon/package.json", observedMode: "100644", targetPath: MODE_TARGET,
    }));
  });

  it("reports only the exact missing-shebang finding for an executable LF blob", () => {
    withFixture("missing shebang", (repository) => {
      const bytes = runGit(repository, ["cat-file", "-p", `HEAD:${SHEBANG_TARGET}`]);
      const newline = bytes.indexOf(10);
      stageBlob(repository, "100755", writeBlob(repository, bytes.subarray(newline + 1)), SHEBANG_TARGET);
    }, (observation) => expectOnlyFinding(observation, {
      code: BIN_TARGET_CODES.shebangMissing, command: "moe-up", layer: BIN_TARGET_LAYER,
      manifestPath: "apps/daemon/package.json", targetPath: SHEBANG_TARGET,
    }));
  });

  it("reports only the exact CR-byte finding when mode and shebang remain valid", () => {
    withFixture("cr byte", (repository) => {
      const bytes = runGit(repository, ["cat-file", "-p", `HEAD:${MODE_TARGET}`]);
      const changed = Buffer.concat([bytes.subarray(0, 3), Buffer.from("\r"), bytes.subarray(3)]);
      stageBlob(repository, "100755", writeBlob(repository, changed), MODE_TARGET);
    }, (observation) => expectOnlyFinding(observation, {
      code: BIN_TARGET_CODES.crByte, command: "moe-mcp-stdio", layer: BIN_TARGET_LAYER,
      manifestPath: "apps/daemon/package.json", targetPath: MODE_TARGET,
    }));
  });

  it("discovers a seventh manifest target and reports its exact non-executable mode", () => {
    withFixture("dynamic seventh target", (repository) => {
      const manifestPath = "packages/contracts/package.json";
      const manifest = JSON.parse(text(runGit(repository, ["cat-file", "-p", `HEAD:${manifestPath}`]))) as Record<string, unknown>;
      manifest.bin = { "moe-seventh": "./src/bin-target-seven.ts" };
      const manifestBlob = writeBlob(repository, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
      stageBlob(repository, "100644", manifestBlob, manifestPath);
      const target = "packages/contracts/src/bin-target-seven.ts";
      stageBlob(repository, "100644", writeBlob(repository, Buffer.from("#!/usr/bin/env node\n")), target);
    }, (observation) => {
      expect(observation.targets.length).toBeGreaterThanOrEqual(7);
      expectOnlyFinding(observation, {
        code: BIN_TARGET_CODES.modeMismatch, command: "moe-seventh", layer: BIN_TARGET_LAYER,
        manifestPath: "packages/contracts/package.json", observedMode: "100644",
        targetPath: "packages/contracts/src/bin-target-seven.ts",
      });
    });
  });
});
