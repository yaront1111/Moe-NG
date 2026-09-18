import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitLandingPort } from "../repository/git-landing-port.js";
import { prepareRuntimeMetadataExcludes } from "../repository/runtime-metadata-excludes.js";
import { checkpointRuntimeMetadata } from "./runtime-metadata-checkpoint.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * A real repository, because the whole defect lives in git's actual behaviour: the
 * operator's own identity, one product file and two tracked runtime metadata files.
 * It carries the exclusions every hosted project carries: `/.moe/` and `/.moe-next/`
 * in info/exclude, written by the production writer the host runs before each start.
 * Tracked files stay tracked under them, but `git add` of one exits 1 (measured
 * 2026-09-18), which is how the first cut of this module failed in every live project.
 */
async function scratchRepository(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "moe-metadata-checkpoint-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=trunk");
  git(root, "config", "user.email", "operator@example.test");
  git(root, "config", "user.name", "Operator");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".moe-next"));
  writeFileSync(join(root, "src", "product.ts"), "export const shipped = 1;\n", "utf8");
  writeFileSync(join(root, ".moe-next", "start.ps1"), "# start\n", "utf8");
  writeFileSync(join(root, ".moe-next", "seed.ps1"), "# seed\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "operator: initial");
  expect(await prepareRuntimeMetadataExcludes({ configPath: join(root, "moe.config.json"),
    projectRoot: root, storePath: join(root, "store.sqlite") })).toEqual({ ok: true });
  return root;
}

const checkpoint = (root: string, paths: readonly string[]): ReturnType<typeof checkpointRuntimeMetadata> =>
  checkpointRuntimeMetadata({ git: createGitLandingPort(), nodeRef: "node-alpha", paths, workspace: root });

/** Each path set must be refused before git sees it. Several were measured escaping the first fence. */
const FENCE_CASES = [
  ["a traversal that escapes the metadata directory", [".moe-next/start.ps1", ".moe-next/../src/product.ts"]],
  // Git for Windows reads `\` as a separator in a pathspec, so this one names src/product.ts.
  ["a backslash traversal", [".moe-next/..\\src\\product.ts"]],
  ["a dot-backslash traversal", [".moe-next/.\\..\\src\\product.ts"]],
  // Pathspec magic: an exclude-only pathspec means everything else, the whole tree.
  ["exclude magic, short form", [":!x/.moe-next/y"]],
  ["exclude magic, long form", [":(exclude)x/.moe-next/y"]],
  // The port NUL-delimits its pathspecs, so a NUL inside one path becomes a second pathspec.
  ["a NUL that splits one path into two pathspecs", [".moe-next/start.ps1\0src/product.ts"]],
  ["an absolute posix path", [".moe-next/start.ps1", "/etc/hosts"]],
  ["an absolute windows path", [".moe-next/start.ps1", "C:/Windows/system32/drivers/etc/hosts"]],
  ["a metadata path mixed in with a product path", [".moe-next/start.ps1", "src/product.ts"]],
  ["an empty set", []],
] as const satisfies readonly (readonly [string, readonly string[]])[];
const executedFenceCases = new Set<string>();

describe("checkpointRuntimeMetadata against a real repository", () => {
  it("checkpoints dirty tracked runtime metadata under Moe's identity so the node can be staffed", async () => {
    const root = await scratchRepository();
    writeFileSync(join(root, ".moe-next", "start.ps1"), "# start --operator-stdin\n", "utf8");
    const head = git(root, "rev-parse", "HEAD");

    const report = await checkpoint(root, [".moe-next/start.ps1"]);

    expect(report.outcome).toBe("RUNTIME_METADATA_CHECKPOINTED");
    expect(report.ok).toBe(true);
    expect(git(root, "rev-parse", "HEAD")).not.toBe(head);
    expect(report.detail).toContain(git(root, "rev-parse", "HEAD"));
    // Clean for that path, and the commit carried nothing else with it.
    expect(git(root, "status", "--porcelain", "--", ".moe-next/start.ps1")).toBe("");
    expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe(".moe-next/start.ps1");
    // Moe's identity, never the operator's, so history says plainly who wrote it.
    expect(git(root, "log", "-1", "--format=%an <%ae>")).toBe("Moe <moe@moe.local>");
    expect(git(root, "log", "-1", "--format=%s")).toBe("chore(moe): checkpoint runtime metadata before staffing node-alpha");
    expect(git(root, "log", "-1", "--format=%b")).toContain("node-alpha");
    // Revertable by the operator with one command, per the plan's rationale for the message.
    git(root, "-c", "user.name=Operator", "-c", "user.email=operator@example.test", "revert", "--no-edit", "HEAD");
    expect(git(root, "status", "--porcelain", "--", ".moe-next/start.ps1")).toBe("");
  });

  it("refuses a path outside the runtime metadata classification without touching the repository", async () => {
    const root = await scratchRepository();
    writeFileSync(join(root, "src", "product.ts"), "export const shipped = 2;\n", "utf8");
    const head = git(root, "rev-parse", "HEAD");
    const index = readFileSync(join(root, ".git", "index"));

    const report = await checkpoint(root, ["src/product.ts"]);

    expect(report.outcome).toBe("RUNTIME_METADATA_CHECKPOINT_UNKNOWN_PATHS");
    expect(report.ok).toBe(false);
    expect(report.detail).toContain("src/product.ts");
    // NO EFFECT, not merely a refusal: nothing committed, nothing even staged.
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
    // `git` trims, so the leading unstaged column is gone: "M <path>" is ` M <path>` trimmed.
    expect(git(root, "status", "--porcelain", "--", "src/product.ts")).toBe("M src/product.ts");
  });

  it.each(FENCE_CASES)("refuses %s without touching the repository", async (label, paths) => {
    executedFenceCases.add(label);
    const root = await scratchRepository();
    writeFileSync(join(root, ".moe-next", "start.ps1"), "# start --operator-stdin\n", "utf8");
    // Product dirt, tracked and untracked, that an escape would sweep into Moe's commit.
    writeFileSync(join(root, "src", "product.ts"), "export const shipped = 2;\n", "utf8");
    writeFileSync(join(root, "src", "untracked-wip.ts"), "export const wip = 1;\n", "utf8");
    const head = git(root, "rev-parse", "HEAD");
    const index = readFileSync(join(root, ".git", "index"));

    const report = await checkpoint(root, paths);

    expect(report.outcome).toBe("RUNTIME_METADATA_CHECKPOINT_UNKNOWN_PATHS");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
  });

  it("reports the checkpoint ineffective when metadata it was not given stays dirty", async () => {
    const root = await scratchRepository();
    writeFileSync(join(root, ".moe-next", "start.ps1"), "# start --operator-stdin\n", "utf8");
    writeFileSync(join(root, ".moe-next", "seed.ps1"), "# seed --operator-stdin\n", "utf8");

    const report = await checkpoint(root, [".moe-next/start.ps1"]);

    // The commit succeeded; the CLASS did not clear. Reporting success here would send the
    // caller straight back into the retry loop this module exists to end.
    expect(report.outcome).toBe("RUNTIME_METADATA_CHECKPOINT_INEFFECTIVE");
    expect(report.ok).toBe(false);
    expect(report.detail).toContain("still dirty");
    expect(report.detail).toContain(".moe-next/seed.ps1");
    expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe(".moe-next/start.ps1");
  });

  it("reports git's own words and leaves HEAD and the index alone when the commit cannot succeed", async () => {
    const root = await scratchRepository();
    const head = git(root, "rev-parse", "HEAD");
    const index = readFileSync(join(root, ".git", "index"));

    // Classified as metadata and confined, so it passes the fence, but no such file exists:
    // real git refuses the pathspec rather than this module predicting that it would.
    const report = await checkpoint(root, [".moe-next/never-existed.ps1"]);

    expect(report.outcome).toBe("RUNTIME_METADATA_CHECKPOINT_FAILED");
    expect(report.ok).toBe(false);
    expect(report.detail).toContain(".moe-next/never-existed.ps1");
    expect(report.detail).toContain("did not match any file(s) known to git");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
  });

  it("leaves the operator's index as it was when their own hook refuses the checkpoint", async () => {
    const root = await scratchRepository();
    const hooks = join(root, ".git", "moe-test-hooks"); mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho HOOK_REFUSED_TEST >&2\nexit 1\n", { mode: 0o755 });
    git(root, "config", "core.hooksPath", hooks);
    writeFileSync(join(root, ".moe-next", "start.ps1"), "# start --operator-stdin\n", "utf8");
    const head = git(root, "rev-parse", "HEAD");
    const index = readFileSync(join(root, ".git", "index"));

    const report = await checkpoint(root, [".moe-next/start.ps1"]);

    // The hook runs AFTER git staged the path into its temporary index; the real one is untouched.
    expect(report.outcome).toBe("RUNTIME_METADATA_CHECKPOINT_FAILED");
    expect(report.detail).toContain("HOOK_REFUSED_TEST");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
    expect(git(root, "status", "--porcelain", "--", ".moe-next/start.ps1")).toBe("M .moe-next/start.ps1");
  });

  // A sweep that silently yields no case passes. This names the cases that actually ran.
  it("runs every fence case", () => {
    expect([...executedFenceCases].toSorted()).toEqual(FENCE_CASES.map(([label]) => label).toSorted());
  });
});
