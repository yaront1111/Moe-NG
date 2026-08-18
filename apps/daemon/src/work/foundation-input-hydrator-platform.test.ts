import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createNodeGitObserver,
  createNodeScopePaths,
  hermeticGitEnvironment,
} from "@moe/runner";
import { describe, expect, it } from "vitest";

import {
  hydrateFoundationInputManifest,
  RUNNER_SCOPE_LAYER,
} from "./foundation-input-hydrator.js";

const OBSERVED_AT = "2026-08-18T00:00:00Z";
const OBSERVER_VERSION = "moe-daemon-foundation-input/1";

interface Fixture {
  readonly head: string;
  readonly root: string;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: hermeticGitEnvironment(process.env),
    shell: false,
    windowsHide: true,
  }).trim();
}

function fixture(files: Readonly<Record<string, Uint8Array>>): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-foundation-platform-")));
  git(root, ["init", "--initial-branch=main", "--quiet"]);
  const paths = Object.keys(files);
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), files[path]!);
  }
  git(root, ["add", "--", ...paths]);
  git(root, [
    "-c", "user.name=Moe Platform", "-c", "user.email=platform@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m", "platform input",
  ]);
  return { head: git(root, ["rev-parse", "HEAD"]), root };
}

function hydrate(input: Fixture, paths: readonly string[]) {
  return hydrateFoundationInputManifest({
    baseIdentity: input.head,
    declaredScopePaths: paths,
    gitObserver: createNodeGitObserver(input.root, hermeticGitEnvironment(process.env)),
    observedAt: OBSERVED_AT,
    observerVersion: OBSERVER_VERSION,
    pathObserver: createNodeScopePaths(),
    proposedEntries: [],
    worktreeRoot: input.root,
  });
}

function refuse(result: ReturnType<typeof hydrate>, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  expect(result.refusedBy).toBe(RUNNER_SCOPE_LAYER);
}

describe("foundation input platform semantics", { timeout: 30_000 }, () => {
  it("preserves a canonical Windows-safe path containing a space", () => {
    const path = "scope/with space.txt";
    const repository = fixture({ [path]: Buffer.from("space\n", "utf8") });
    try {
      const result = hydrate(repository, [path]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.manifest.entries.map((entry) => entry.path)).toEqual([path]);
    } finally {
      rmSync(repository.root, { force: true, recursive: true });
    }
  });

  it("hashes CRLF over raw bytes without text-mode conversion", () => {
    const path = "scope/crlf.txt";
    const repository = fixture({ [path]: Buffer.from("first\r\nsecond\r\n", "utf8") });
    try {
      const result = hydrate(repository, [path]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const bytes = readFileSync(join(repository.root, path));
      expect(result.manifest.entries[0]?.byteLength).toBe(bytes.byteLength);
      expect(result.manifest.entries[0]?.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
    } finally {
      rmSync(repository.root, { force: true, recursive: true });
    }
  });

  it("lets the runner reject Windows and POSIX spellings without daemon rewriting", () => {
    const cases = [
      { code: "RUNNER_SCOPE_PATH_BACKSLASH", path: "scope\\file.txt" },
      { code: "RUNNER_SCOPE_PATH_DRIVE_QUALIFIED", path: "C:/scope/file.txt" },
      { code: "RUNNER_SCOPE_PATH_ABSOLUTE", path: "/opt/scope/file.txt" },
      { code: "RUNNER_SCOPE_PATH_DOT_SEGMENT", path: "scope/../file.txt" },
    ] as const;
    expect(cases.length).toBeGreaterThan(0);
    const repository = fixture({ "scope/file.txt": Buffer.from("content\n", "utf8") });
    try {
      for (const hostile of cases) refuse(hydrate(repository, [hostile.path]), hostile.code);
    } finally {
      rmSync(repository.root, { force: true, recursive: true });
    }
  });

  it("refuses case-colliding paths rather than silently dropping one", () => {
    const repository = fixture({ "scope/Case.txt": Buffer.from("case\n", "utf8") });
    try {
      const result = hydrate(repository, ["scope/Case.txt", "scope/case.txt"]);
      refuse(result, "RUNNER_SCOPE_PATH_CASE_COLLISION");
    } finally {
      rmSync(repository.root, { force: true, recursive: true });
    }
  });
});
