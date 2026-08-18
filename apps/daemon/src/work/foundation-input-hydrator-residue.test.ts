import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import {
  createNodeGitObserver,
  createNodeScopePaths,
  hermeticGitEnvironment,
  type GitObserver,
} from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  FOUNDATION_INPUT_HYDRATOR_LAYER,
  hydrateFoundationInputManifest,
  MAX_FOUNDATION_INPUT_FILE_BYTES,
  RUNNER_SCOPE_LAYER,
} from "./foundation-input-hydrator.js";

const OBSERVED_AT = "2026-08-18T00:00:00Z";
const OBSERVER_VERSION = "moe-daemon-foundation-input/1";
const PROJECT_ID = "foundation-input-residue";

interface Fixture {
  readonly head: string;
  readonly paths: readonly string[];
  readonly root: string;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root, encoding: "utf8", env: hermeticGitEnvironment(process.env),
    shell: false, windowsHide: true,
  }).trim();
}

function fixture(bytes = Buffer.from("alpha\n", "utf8")): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-foundation-residue-")));
  const paths = ["scope/b.txt", "scope/a.txt"] as const;
  git(root, ["init", "--initial-branch=main", "--quiet"]);
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  git(root, ["add", "--", ...paths]);
  git(root, [
    "-c", "user.name=Moe Residue", "-c", "user.email=residue@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m", "residue input",
  ]);
  return { head: git(root, ["rev-parse", "HEAD"]), paths, root };
}

function countedObserver(root: string, calls: string[]): GitObserver {
  const node = createNodeGitObserver(root, hermeticGitEnvironment(process.env));
  const call = <T>(name: string, run: () => T): T => { calls.push(name); return run(); };
  return Object.freeze({
    headCommit: () => call("head", () => node.headCommit()),
    lsFilesIgnored: () => call("ignored", () => node.lsFilesIgnored()),
    lsFilesTracked: () => call("tracked", () => node.lsFilesTracked()),
    statusPorcelainV2: () => call("status", () => node.statusPorcelainV2()),
    submodulePaths: () => call("submodules", () => node.submodulePaths()),
  });
}

function input(repository: Fixture, paths: readonly string[], observer: GitObserver, base = repository.head) {
  return {
    baseIdentity: base,
    declaredScopePaths: paths,
    gitObserver: observer,
    observedAt: OBSERVED_AT,
    observerVersion: OBSERVER_VERSION,
    pathObserver: createNodeScopePaths(),
    proposedEntries: [],
    worktreeRoot: repository.root,
  };
}

interface InventoryEntry {
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly path: string;
  readonly sha256: string;
}

function inventory(root: string): readonly InventoryEntry[] {
  const found: InventoryEntry[] = [];
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && item.name === ".git") continue;
      const absolute = join(directory, item.name);
      if (item.isDirectory()) { visit(absolute); continue; }
      const bytes = readFileSync(absolute);
      const stat = statSync(absolute);
      found.push({
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        path: relative(root, absolute).replaceAll("\\", "/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  visit(root);
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

function storeCounts(store: SqliteEventStore) {
  return {
    decisions: store.readCommandDecisionsAfter(0n, 1_000).items.length,
    events: store.readEventsAfter(0n, 1_000).items.length,
  };
}

describe("foundation input byte stability and zero residue", { timeout: 30_000 }, () => {
  it("derives one byte-stable manifest regardless of declared path order", () => {
    const repository = fixture();
    const calls: string[] = [];
    try {
      const first = hydrateFoundationInputManifest(input(repository, repository.paths, countedObserver(repository.root, calls)));
      const reversed = hydrateFoundationInputManifest(input(
        repository, [...repository.paths].reverse(), countedObserver(repository.root, calls),
      ));
      expect(first.ok).toBe(true);
      expect(reversed.ok).toBe(true);
      if (!first.ok || !reversed.ok) return;
      expect(JSON.stringify(first.manifest)).toBe(JSON.stringify(reversed.manifest));
      expect(first.manifest.entries.map((entry) => entry.path)).toEqual([...repository.paths].sort());
      expect(calls).toEqual([
        "head", "submodules", "status", "tracked", "ignored",
        "head", "submodules", "status", "tracked", "ignored",
      ]);
    } finally {
      rmSync(repository.root, { force: true, recursive: true });
    }
  });

  it("refuses conflicts before any durable write and leaves every worktree byte untouched", () => {
    const repository = fixture();
    const storeRoot = mkdtempSync(join(tmpdir(), "moe-foundation-residue-store-"));
    const store = SqliteEventStore.openForProject(join(storeRoot, "store.db"), PROJECT_ID);
    const calls: string[] = [];
    try {
      const beforeFiles = inventory(repository.root);
      const beforeStore = storeCounts(store);
      const mismatch = hydrateFoundationInputManifest(input(
        repository, repository.paths, countedObserver(repository.root, calls), "f".repeat(40),
      ));
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) {
        expect(mismatch.code).toBe("RUNNER_SCOPE_HEAD_MISMATCH");
        expect(mismatch.refusedBy).toBe(RUNNER_SCOPE_LAYER);
      }
      const nul = hydrateFoundationInputManifest(input(
        repository, ["scope/nul\0path"], countedObserver(repository.root, calls),
      ));
      expect(nul.ok).toBe(false);
      if (!nul.ok) {
        expect(nul.code).toBe("FOUNDATION_INPUT_ENTRY_UNREADABLE");
        expect(nul.refusedBy).toBe(FOUNDATION_INPUT_HYDRATOR_LAYER);
      }
      expect("manifest" in mismatch).toBe(false);
      expect("manifest" in nul).toBe(false);
      expect(storeCounts(store)).toEqual(beforeStore);
      expect(inventory(repository.root)).toEqual(beforeFiles);
      expect(calls).toEqual([
        "head", "head", "submodules", "status", "tracked", "ignored",
      ]);
    } finally {
      store.close();
      rmSync(repository.root, { force: true, recursive: true });
      rmSync(storeRoot, { force: true, recursive: true });
    }
  });

  it("refuses an oversized file without a lock, partial manifest, or mtime change", () => {
    const repository = fixture(Buffer.alloc(MAX_FOUNDATION_INPUT_FILE_BYTES + 1));
    try {
      const before = inventory(repository.root);
      const result = hydrateFoundationInputManifest(input(
        repository, repository.paths, createNodeGitObserver(repository.root, hermeticGitEnvironment(process.env)),
      ));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("FOUNDATION_INPUT_ENTRY_TOO_LARGE");
        expect(result.refusedBy).toBe(FOUNDATION_INPUT_HYDRATOR_LAYER);
      }
      expect("manifest" in result).toBe(false);
      expect(inventory(repository.root)).toEqual(before);
    } finally {
      rmSync(repository.root, { force: true, recursive: true });
    }
  });
});
