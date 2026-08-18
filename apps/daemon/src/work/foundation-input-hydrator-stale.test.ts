import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNodeGitObserver,
  createNodeScopePaths,
  hermeticGitEnvironment,
  type ScopePathObserver,
} from "@moe/runner";
import { expect, it } from "vitest";

import {
  hydrateFoundationInputManifest,
  type HydrateFoundationInputManifestInput,
} from "./foundation-input-hydrator.js";

const PATH = "scope/alpha.txt";

interface Fixture {
  readonly head: string;
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

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-foundation-stale-")));
  mkdirSync(join(root, "scope"));
  writeFileSync(join(root, PATH), Buffer.from("observed bytes\n", "utf8"));
  runGit(root, ["init", "--initial-branch=main", "--quiet"]);
  runGit(root, ["add", "--", PATH]);
  runGit(root, [
    "-c", "user.name=Moe Foundation", "-c", "user.email=foundation@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m", "stale observation fixture",
  ]);
  return { head: runGit(root, ["rev-parse", "HEAD"]), root };
}

function mutateAfterContainment(
  target: string,
  mutate: () => void,
): { readonly count: () => number; readonly observer: ScopePathObserver } {
  const paths = createNodeScopePaths();
  let count = 0;
  return {
    count: () => count,
    observer: {
      exists: (path) => paths.exists(path),
      realpath(path) {
        const resolved = paths.realpath(path);
        if (path === target && count === 0) {
          count += 1;
          mutate();
        }
        return resolved;
      },
    },
  };
}

function input(fixtureValue: Fixture, pathObserver: ScopePathObserver): HydrateFoundationInputManifestInput {
  return {
    baseIdentity: fixtureValue.head,
    declaredScopePaths: [PATH],
    gitObserver: createNodeGitObserver(
      fixtureValue.root,
      hermeticGitEnvironment(process.env),
    ),
    observedAt: "2026-08-18T00:00:00Z",
    observerVersion: "moe-daemon-foundation-input/1",
    pathObserver,
    proposedEntries: [],
    worktreeRoot: fixtureValue.root,
  };
}

function expectStale(result: ReturnType<typeof hydrateFoundationInputManifest>): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("FOUNDATION_INPUT_STALE_OBSERVATION");
  expect(result.refusedBy).toBe("DAEMON_FOUNDATION_INPUT");
  expect("manifest" in result).toBe(false);
}

it("refuses tracked bytes changed after containment observation as stale", () => {
  const repository = fixture();
  const target = join(repository.root, PATH);
  const replacement = Buffer.from("replacement bytes after observation\n", "utf8");
  const hook = mutateAfterContainment(target, () => writeFileSync(target, replacement));
  try {
    const result = hydrateFoundationInputManifest(input(repository, hook.observer));
    expect(hook.count()).toBe(1);
    expect(readFileSync(target)).toEqual(replacement);
    expectStale(result);
  } finally {
    rmSync(repository.root, { force: true, recursive: true });
  }
});

it("refuses an inode swap hidden inside an already-dirty observation", () => {
  const repository = fixture();
  const target = join(repository.root, PATH);
  const replacement = join(repository.root, "scope/replacement.txt");
  const exchange = join(repository.root, "scope/exchange.txt");
  writeFileSync(target, Buffer.from("dirty observed bytes\n", "utf8"));
  writeFileSync(replacement, Buffer.from("dirty replacement!\n", "utf8"));
  const hook = mutateAfterContainment(target, () => {
    renameSync(target, exchange);
    renameSync(replacement, target);
    renameSync(exchange, replacement);
  });
  try {
    const result = hydrateFoundationInputManifest(input(repository, hook.observer));
    expect(hook.count()).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("dirty replacement!\n");
    expectStale(result);
  } finally {
    rmSync(repository.root, { force: true, recursive: true });
  }
});

it("refuses a directory link swapped after containment observation as stale", () => {
  const repository = fixture();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "moe-foundation-swap-")));
  const target = join(repository.root, PATH);
  const scope = join(repository.root, "scope");
  const originalScope = join(repository.root, "scope-observed");
  writeFileSync(join(outside, "alpha.txt"), Buffer.from("outside bytes\n", "utf8"));
  const hook = mutateAfterContainment(target, () => {
    renameSync(scope, originalScope);
    symlinkSync(outside, scope, process.platform === "win32" ? "junction" : "dir");
  });
  try {
    const result = hydrateFoundationInputManifest(input(repository, hook.observer));
    expect(hook.count()).toBe(1);
    expect(realpathSync(scope)).toBe(outside);
    expectStale(result);
  } finally {
    rmSync(repository.root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});
