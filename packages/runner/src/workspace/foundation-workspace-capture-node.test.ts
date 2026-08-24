import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createNodeGitObserver, createNodeScopePaths, hermeticGitEnvironment } from "../scope/scope-git.js";
import { observeScope } from "../scope/scope-observation.js";
import type { GitObserver, ScopeObservation } from "../scope/scope-contract.js";
import {
  captureFailure,
  DEFAULT_FOUNDATION_CAPTURE_LIMITS,
  FOUNDATION_CAPTURE_CODES,
  FOUNDATION_CAPTURE_LAYER_NAMES,
  FOUNDATION_CAPTURE_VERSION,
  MAX_FOUNDATION_CAPTURE_BYTES,
  MAX_FOUNDATION_CAPTURE_ENTRIES,
  type FoundationCaptureFsPort,
  type FoundationCaptureLimits,
  type FoundationPrelaunchProof,
} from "./foundation-workspace-capture-contract.js";
import { createNodeFoundationCaptureFs } from "./foundation-workspace-capture-node.js";
import { captureFoundationWorkspaceDelta, proveFoundationPrelaunchTree } from "./foundation-workspace-capture.js";
import { buildInputManifest, buildResultManifest } from "./workspace-manifest.js";
import type { WorkspaceInputManifest } from "./workspace-contract.js";

/**
 * The Foundation capture scanner, driven against REAL temp git worktrees.
 *
 * A fake filesystem would prove only that the fake agrees with itself, and the
 * parts most likely to be wrong — junction handling, inode identity across a
 * mid-scan swap, what porcelain v2 actually reports for a staged file — are
 * exactly what a fake cannot check. Hostile arms that real git and a real
 * filesystem cannot be made to produce on demand (an unreadable open, a
 * non-regular kind, a realpath escape) inject a PORT under the production
 * scanner instead; the code under test is unchanged in every one of them.
 *
 * Every refusal arm asserts the exact reason code AND which of the three layers
 * decided it, because two of them — the scope observer and the result sealer —
 * can also refuse, and a test that only checked "not ok" would stay green the
 * day one of them started answering first.
 */

const CLOCK = "2026-08-19T00:00:00Z";
const OBSERVER = "moe-runner-capture-test/1";
const OUT_OF_SCOPE = "outside/host.txt";

const gitAvailable = ((): boolean => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", shell: false, windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const digest = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");

interface Fixture {
  readonly root: string;
  readonly base: string;
  readonly scopes: readonly string[];
  readonly contents: Readonly<Record<string, string>>;
  git(...args: readonly string[]): void;
}

/** Files are written from KNOWN content, so the manifest never comes from the scanner it tests. */
const SEED: Readonly<Record<string, string>> = Object.freeze({
  "work/alpha.txt": "alpha bytes\n",
  "work/nested/beta.txt": "beta bytes\n",
  [OUT_OF_SCOPE]: "host bytes\n",
});

function seedWorkspace(contents: Readonly<Record<string, string>> = SEED): Fixture {
  const root = mkdtempSync(join(tmpdir(), "moe-capture-"));
  roots.push(root);
  const git = (...args: readonly string[]): void => {
    execFileSync("git", [...args], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: "@0 +0000", GIT_COMMITTER_DATE: "@0 +0000" },
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
  };
  git("init", "--initial-branch=main", "--quiet");
  git("config", "user.email", "capture@example.invalid");
  git("config", "user.name", "Capture Test");
  git("config", "core.autocrlf", "false");
  for (const [path, content] of Object.entries(contents)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  git("add", "--all");
  git("commit", "--quiet", "--no-gpg-sign", "-m", `seed ${roots.length}`);
  const base = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    shell: false,
    windowsHide: true,
  })
    .toString("utf8")
    .trim();
  return { root, base, scopes: ["work"], contents, git };
}

/** The sealed input manifest, built from the bytes the fixture WROTE. */
function sealedInput(fixture: Fixture, baseIdentity: string = fixture.base): WorkspaceInputManifest {
  const entries = Object.entries(fixture.contents)
    .filter(([path]) => fixture.scopes.some((scope) => path === scope || path.startsWith(`${scope}/`)))
    .map(([path, content]) => ({
      path,
      sha256: digest(content),
      byteLength: Buffer.byteLength(content, "utf8"),
      producer: { kind: "BASE" as const },
    }));
  const built = buildInputManifest({ baseIdentity, entries });
  if (!built.ok) throw new Error(`fixture input manifest refused: ${built.code}`);
  return built.manifest;
}

function observe(fixture: Fixture, scopes: readonly string[] = fixture.scopes): ScopeObservation {
  const result = observeScope({
    worktreeRoot: fixture.root,
    baseIdentity: fixture.base,
    declaredScopePaths: scopes,
    gitObserver: createNodeGitObserver(fixture.root, hermeticGitEnvironment(process.env)),
    pathObserver: createNodeScopePaths(),
    observedAt: CLOCK,
    observerVersion: OBSERVER,
  });
  if (!result.ok) throw new Error(`fixture observation refused: ${result.code}`);
  return result.observation;
}

const port = (overrides: Partial<FoundationCaptureFsPort> = {}): FoundationCaptureFsPort => ({
  ...createNodeFoundationCaptureFs(),
  ...overrides,
});

function prove(
  fixture: Fixture,
  overrides: {
    fs?: FoundationCaptureFsPort;
    limits?: FoundationCaptureLimits;
    root?: string;
    scopes?: readonly string[];
    inputManifest?: WorkspaceInputManifest;
    observation?: ScopeObservation;
    extraKeys?: Readonly<Record<string, unknown>>;
  } = {},
): ReturnType<typeof proveFoundationPrelaunchTree> {
  return proveFoundationPrelaunchTree({
    ...(overrides.extraKeys ?? {}),
    assignedRealRoot: overrides.root ?? createNodeFoundationCaptureFs().realpath(fixture.root),
    inputManifest: overrides.inputManifest ?? sealedInput(fixture),
    declaredScopePaths: overrides.scopes ?? fixture.scopes,
    prelaunchObservation: overrides.observation ?? observe(fixture),
    fs: overrides.fs ?? createNodeFoundationCaptureFs(),
    limits: overrides.limits ?? DEFAULT_FOUNDATION_CAPTURE_LIMITS,
  });
}

function capture(
  fixture: Fixture,
  proof: FoundationPrelaunchProof,
  overrides: {
    fs?: FoundationCaptureFsPort;
    limits?: FoundationCaptureLimits;
    gitObserver?: GitObserver;
    extraKeys?: Readonly<Record<string, unknown>>;
  } = {},
): ReturnType<typeof captureFoundationWorkspaceDelta> {
  return captureFoundationWorkspaceDelta({
    ...(overrides.extraKeys ?? {}),
    proof,
    gitObserver: overrides.gitObserver ?? createNodeGitObserver(fixture.root, hermeticGitEnvironment(process.env)),
    pathObserver: createNodeScopePaths(),
    fs: overrides.fs ?? createNodeFoundationCaptureFs(),
    limits: overrides.limits ?? DEFAULT_FOUNDATION_CAPTURE_LIMITS,
    observedAt: CLOCK,
    observerVersion: OBSERVER,
  });
}

/** Narrows to the proof, failing with the refusal code rather than a null deref. */
function provenProof(fixture: Fixture): FoundationPrelaunchProof {
  const result = prove(fixture);
  if (!result.ok) throw new Error(`prelaunch proof refused: ${result.code} @ ${result.layer}`);
  return result.proof;
}

describe("the capture vocabulary", () => {
  it("publishes a frozen, unique, capture-prefixed code roster", () => {
    expect(Object.isFrozen(FOUNDATION_CAPTURE_CODES)).toBe(true);
    expect(new Set(FOUNDATION_CAPTURE_CODES).size).toBe(FOUNDATION_CAPTURE_CODES.length);
    expect(FOUNDATION_CAPTURE_CODES.length).toBeGreaterThan(0);
    for (const code of FOUNDATION_CAPTURE_CODES) {
      expect(code.startsWith("RUNNER_FOUNDATION_CAPTURE_")).toBe(true);
    }
  });

  it("names the three boundaries that can refuse a capture", () => {
    expect(Object.isFrozen(FOUNDATION_CAPTURE_LAYER_NAMES)).toBe(true);
    expect([...FOUNDATION_CAPTURE_LAYER_NAMES]).toEqual([
      "RUNNER_WORKSPACE_CAPTURE",
      "RUNNER_SCOPE_OBSERVATION",
      "RUNNER_WORKSPACE_MANIFEST",
    ]);
  });

  it("freezes a failure and carries its deciding layer", () => {
    const failure = captureFailure("RUNNER_FOUNDATION_CAPTURE_PATH_ESCAPED", "RUNNER_WORKSPACE_CAPTURE", "m", "p");
    expect(Object.isFrozen(failure)).toBe(true);
    expect(failure).toEqual({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_PATH_ESCAPED",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      message: "m",
      path: "p",
    });
  });

  it("bounds its own scan budget independently of the sealer's manifest cap", () => {
    expect(DEFAULT_FOUNDATION_CAPTURE_LIMITS).toEqual({
      maxEntries: MAX_FOUNDATION_CAPTURE_ENTRIES,
      maxAggregateBytes: MAX_FOUNDATION_CAPTURE_BYTES,
    });
    expect(MAX_FOUNDATION_CAPTURE_ENTRIES).toBeGreaterThan(4096);
  });
});

describe.skipIf(!gitAvailable)("the prelaunch tree proof", { timeout: 30_000 }, () => {
  it("proves a clean assigned tree is exactly its sealed input", () => {
    const fixture = seedWorkspace();
    const result = prove(fixture);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.proof.proofVersion).toBe(FOUNDATION_CAPTURE_VERSION);
    expect(result.proof.scannedEntryCount).toBe(2);
    expect(result.proof.scannedByteTotal).toBe(
      Buffer.byteLength(SEED["work/alpha.txt"]!) + Buffer.byteLength(SEED["work/nested/beta.txt"]!),
    );
    // The out-of-scope host file exists but is not in the declared subtree, so
    // an enumeration that walked the whole root would have refused as EXTRA.
    expect(result.proof.declaredScopePaths).toEqual(["work"]);
  });

  it("refuses an extra file the sealed input never listed", () => {
    const fixture = seedWorkspace();
    // The clean observation is taken FIRST, exactly as the lifecycle takes it.
    // Tampering afterwards is the case the equality prover exists for; observing
    // after the tamper would let PRELAUNCH_NOT_CLEAN answer instead, and the
    // prover this arm names would never be reached at all.
    const clean = observe(fixture);
    writeFileSync(join(fixture.root, "work", "stray.txt"), "stray\n");
    expect(prove(fixture, { observation: clean })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_INPUT_ENTRY_EXTRA",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/stray.txt",
    });
  });

  it("refuses a sealed input path the assigned tree does not hold", () => {
    const fixture = seedWorkspace();
    const clean = observe(fixture);
    rmSync(join(fixture.root, "work", "nested", "beta.txt"));
    expect(prove(fixture, { observation: clean })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_INPUT_ENTRY_MISSING",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/nested/beta.txt",
    });
  });

  it("refuses bytes that differ from the ones the input entry sealed", () => {
    const fixture = seedWorkspace();
    const clean = observe(fixture);
    writeFileSync(join(fixture.root, "work", "alpha.txt"), "tampered\n");
    expect(prove(fixture, { observation: clean })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_INPUT_ENTRY_CHANGED",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/alpha.txt",
    });
  });

  it("refuses an input manifest whose digest does not recompute", () => {
    const fixture = seedWorkspace();
    const forged = { ...sealedInput(fixture), sha256: "0".repeat(64) };
    expect(prove(fixture, { inputManifest: forged })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_INPUT_MANIFEST_UNSEALED",
      layer: "RUNNER_WORKSPACE_CAPTURE",
    });
  });

  it("refuses an observation whose digest does not recompute", () => {
    const fixture = seedWorkspace();
    const forged = { ...observe(fixture), sha256: "0".repeat(64) };
    expect(prove(fixture, { observation: forged })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_OBSERVATION_UNSEALED",
      layer: "RUNNER_WORKSPACE_CAPTURE",
    });
  });

  it("refuses a manifest sealed against a different base than the observation", () => {
    const fixture = seedWorkspace();
    expect(prove(fixture, { inputManifest: sealedInput(fixture, "1".repeat(40)) })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_BASE_MISMATCH",
      layer: "RUNNER_WORKSPACE_CAPTURE",
    });
  });

  it("refuses a root that is not the worktree the observation resolved", () => {
    const fixture = seedWorkspace();
    const stranger = mkdtempSync(join(tmpdir(), "moe-capture-other-"));
    roots.push(stranger);
    expect(prove(fixture, { root: createNodeFoundationCaptureFs().realpath(stranger) })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_ROOT_MISMATCH",
      layer: "RUNNER_WORKSPACE_CAPTURE",
    });
  });

  it("refuses a declaration the observation never canonicalized", () => {
    const fixture = seedWorkspace();
    expect(prove(fixture, { scopes: ["work", "outside"] })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_SCOPE_UNDECLARED",
      layer: "RUNNER_WORKSPACE_CAPTURE",
    });
  });

  it("refuses a prelaunch observation that is not clean", () => {
    const fixture = seedWorkspace();
    writeFileSync(join(fixture.root, "work", "alpha.txt"), "dirtied before launch\n");
    const dirty = observe(fixture);
    expect(dirty.canonicalEntries[0]).toMatchObject({ path: "work", attribution: "DIRTY" });
    expect(prove(fixture, { observation: dirty })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_PRELAUNCH_NOT_CLEAN",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work",
    });
  });
});

describe.skipIf(!gitAvailable)("hostile trees the prelaunch scan must refuse", { timeout: 30_000 }, () => {
  it("refuses a junction or symlink inside a declared subtree without following it", () => {
    const fixture = seedWorkspace();
    const clean = observe(fixture);
    const target = mkdtempSync(join(tmpdir(), "moe-capture-link-target-"));
    roots.push(target);
    writeFileSync(join(target, "smuggled.txt"), "smuggled\n");
    try {
      symlinkSync(target, join(fixture.root, "work", "linked"), "junction");
    } catch {
      // A host that refuses even a junction cannot host this arm; the file
      // symlink arm below covers the same rule where it is creatable.
      return;
    }
    expect(prove(fixture, { observation: clean })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_PATH_SYMLINKED",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/linked",
    });
  });

  it("refuses a path whose kind is not a regular file", () => {
    const fixture = seedWorkspace();
    const clean = observe(fixture);
    const real = createNodeFoundationCaptureFs();
    const fs = port({
      lstatPath: (path) => {
        const stat = real.lstatPath(path);
        return path.endsWith("alpha.txt") ? { ...stat, kind: "OTHER" as const } : stat;
      },
    });
    expect(prove(fixture, { fs, observation: clean })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_PATH_KIND_UNSUPPORTED",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/alpha.txt",
    });
  });

  it("refuses a file whose real path resolves outside the assigned root", () => {
    const fixture = seedWorkspace();
    const clean = observe(fixture);
    const real = createNodeFoundationCaptureFs();
    const fs = port({
      realpath: (path) => (path.endsWith("alpha.txt") ? join(tmpdir(), "elsewhere", "alpha.txt") : real.realpath(path)),
    });
    expect(prove(fixture, { fs, observation: clean })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_PATH_ESCAPED",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/alpha.txt",
    });
  });

  it("refuses a file it cannot open rather than reporting a smaller tree", () => {
    const fixture = seedWorkspace();
    const clean = observe(fixture);
    const real = createNodeFoundationCaptureFs();
    let denials = 0;
    const fs = port({
      openRead: (path) => {
        if (path.endsWith("alpha.txt")) {
          denials += 1;
          throw new Error("EACCES");
        }
        return real.openRead(path);
      },
    });
    expect(prove(fixture, { fs, observation: clean })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_PATH_UNREADABLE",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/alpha.txt",
    });
    expect(denials).toBe(1);
  });

  it("refuses a file swapped between the stat and the open", () => {
    const fixture = seedWorkspace();
    const clean = observe(fixture);
    const real = createNodeFoundationCaptureFs();
    let swaps = 0;
    const fs = port({
      openRead: (path) => {
        // The swap happens AFTER lstat named the object and BEFORE the handle
        // exists, which is precisely the window a path-keyed read cannot see.
        if (path.endsWith("alpha.txt") && swaps === 0) {
          swaps += 1;
          rmSync(path);
          writeFileSync(path, SEED["work/alpha.txt"]!);
        }
        return real.openRead(path);
      },
    });
    const result = prove(fixture, { fs, observation: clean });
    expect(swaps).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_IDENTITY_SWAPPED",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/alpha.txt",
    });
  });

  it("refuses a tree that overflows the entry budget", () => {
    const fixture = seedWorkspace();
    expect(prove(fixture, { limits: { maxEntries: 1, maxAggregateBytes: MAX_FOUNDATION_CAPTURE_BYTES } })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_ENTRY_LIMIT",
      layer: "RUNNER_WORKSPACE_CAPTURE",
    });
  });

  it("refuses mid-scan when the aggregate byte budget overflows, with no partial answer", () => {
    const fixture = seedWorkspace();
    const result = prove(fixture, { limits: { maxEntries: 4096, maxAggregateBytes: 4 } });
    expect(result).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_BYTE_LIMIT",
      layer: "RUNNER_WORKSPACE_CAPTURE",
    });
    expect("proof" in result).toBe(false);
  });

  it("refuses limits a caller widened past the module ceilings", () => {
    const fixture = seedWorkspace();
    const cases: readonly FoundationCaptureLimits[] = [
      { maxEntries: MAX_FOUNDATION_CAPTURE_ENTRIES + 1, maxAggregateBytes: 1 },
      { maxEntries: 1, maxAggregateBytes: MAX_FOUNDATION_CAPTURE_BYTES + 1 },
      { maxEntries: 0, maxAggregateBytes: 1 },
      { maxEntries: 1.5, maxAggregateBytes: 1 },
    ];
    expect(cases.length).toBeGreaterThan(0);
    for (const limits of cases) {
      expect(prove(fixture, { limits })).toMatchObject({
        ok: false,
        code: "RUNNER_FOUNDATION_CAPTURE_INPUT_INVALID",
        layer: "RUNNER_WORKSPACE_CAPTURE",
      });
    }
  });
});

describe.skipIf(!gitAvailable)("the postlaunch delta capture", { timeout: 30_000 }, () => {
  it("maps a modified in-scope file to AUTHORED and leaves the rest INHERITED", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    writeFileSync(join(fixture.root, "work", "alpha.txt"), "authored bytes\n");
    const result = capture(fixture, proof);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.core.advisory).toBe(true);
    expect(result.core.authoredPaths).toEqual(["work/alpha.txt"]);
    expect(result.core.declaredArtifactRefs).toEqual([]);
    expect(result.core.resultTreeEntries).toEqual([
      {
        path: "work/alpha.txt",
        sha256: digest("authored bytes\n"),
        byteLength: Buffer.byteLength("authored bytes\n"),
        origin: "AUTHORED",
        kind: "REGULAR",
      },
      {
        path: "work/nested/beta.txt",
        sha256: digest(SEED["work/nested/beta.txt"]!),
        byteLength: Buffer.byteLength(SEED["work/nested/beta.txt"]!),
        origin: "INHERITED",
        kind: "REGULAR",
      },
    ]);
  });

  it("maps a new in-scope file to AUTHORED", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    writeFileSync(join(fixture.root, "work", "created.txt"), "created\n");
    const result = capture(fixture, proof);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.core.authoredPaths).toEqual(["work/created.txt"]);
    expect(result.core.resultTreeEntries.find((entry) => entry.path === "work/created.txt")).toMatchObject({
      origin: "AUTHORED",
      kind: "REGULAR",
    });
  });

  it("maps a deleted inherited path to an authored path with NO result entry", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    rmSync(join(fixture.root, "work", "alpha.txt"));
    const result = capture(fixture, proof);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // The authored DELETION and the out-of-scope deletion are different facts:
    // this one earns an authored path, the other one refuses the whole capture.
    expect(result.core.authoredPaths).toEqual(["work/alpha.txt"]);
    expect(result.core.resultTreeEntries.map((entry) => entry.path)).toEqual(["work/nested/beta.txt"]);
    expect(result.core.resultManifest.authoredEntries).toEqual([]);
  });

  it("accepts an attempt that authored nothing at all", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    const result = capture(fixture, proof);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.core.authoredPaths).toEqual([]);
    expect(result.core.resultTreeEntries.map((entry) => entry.origin)).toEqual(["INHERITED", "INHERITED"]);
  });

  it("treats a rewrite to identical bytes as INHERITED, not authored", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    // Git will report this path as changed on some hosts; authorship is decided
    // by BYTES, so an identical rewrite must author nothing.
    writeFileSync(join(fixture.root, "work", "alpha.txt"), SEED["work/alpha.txt"]!);
    const result = capture(fixture, proof);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.core.authoredPaths).toEqual([]);
  });

  it("refuses a change outside every authoritative scope as an unknown host effect", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    writeFileSync(join(fixture.root, OUT_OF_SCOPE), "host wrote here\n");
    expect(capture(fixture, proof)).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_OUT_OF_SCOPE_HOST_EFFECT_UNKNOWN",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: OUT_OF_SCOPE,
    });
  });

  it("refuses a staged result", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    writeFileSync(join(fixture.root, "work", "alpha.txt"), "staged bytes\n");
    fixture.git("add", "work/alpha.txt");
    expect(capture(fixture, proof)).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_STAGED_STATE",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/alpha.txt",
    });
  });

  it("refuses an ignored directory git reports under the declared scope", () => {
    const fixture = seedWorkspace({ ...SEED, ".gitignore": "work/logs/\n" });
    const proof = provenProof(fixture);
    mkdirSync(join(fixture.root, "work", "logs"), { recursive: true });
    writeFileSync(join(fixture.root, "work", "logs", "run.log"), "log\n");
    // The ignored listing collapses the fully ignored directory to `work/logs/`
    // (per-file enumeration would overflow the observation cap on a real
    // checkout), so the refusal names the collapsed directory, slash stripped.
    expect(capture(fixture, proof)).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_IGNORED_STATE",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/logs",
    });
  });

  // The attribution index folds a declared directory to the STRONGEST class in
  // its subtree, and DIRTY (rank 4) and UNTRACKED (rank 2) both outrank IGNORED
  // (rank 5). A sibling write therefore hides the ignored tree from the
  // canonical entry; the refusal has to come from the ignored-path bucket, or
  // ignore-ruled bytes seal as authored results whenever anything else changed.
  // The bucket carries the COLLAPSED `work/logs/` entry, so the refusal names
  // the directory (slash stripped) rather than a file inside it.
  it("refuses an ignored file under the scope even when a dirty sibling masks it in the fold", () => {
    const fixture = seedWorkspace({ ...SEED, ".gitignore": "work/logs/\n" });
    const proof = provenProof(fixture);
    mkdirSync(join(fixture.root, "work", "logs"), { recursive: true });
    writeFileSync(join(fixture.root, "work", "logs", "run.log"), "log\n");
    writeFileSync(join(fixture.root, "work", "alpha.txt"), "rewritten beside an ignored file\n");
    expect(capture(fixture, proof)).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_IGNORED_STATE",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/logs",
    });
  });

  it("refuses an ignored file under the scope even when an untracked sibling masks it in the fold", () => {
    const fixture = seedWorkspace({ ...SEED, ".gitignore": "work/logs/\n" });
    const proof = provenProof(fixture);
    mkdirSync(join(fixture.root, "work", "logs"), { recursive: true });
    writeFileSync(join(fixture.root, "work", "logs", "run.log"), "log\n");
    writeFileSync(join(fixture.root, "work", "created.txt"), "created beside an ignored file\n");
    expect(capture(fixture, proof)).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_IGNORED_STATE",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/logs",
    });
  });

  it("does not refuse an ignored file that lies outside every declared scope", () => {
    // The ignored bucket is repo-wide; only containment in a declaration makes
    // an ignored path the attempt's problem.
    const fixture = seedWorkspace({ ...SEED, ".gitignore": "outside/logs/\n" });
    const proof = provenProof(fixture);
    mkdirSync(join(fixture.root, "outside", "logs"), { recursive: true });
    writeFileSync(join(fixture.root, "outside", "logs", "host.log"), "log\n");
    writeFileSync(join(fixture.root, "work", "created.txt"), "created\n");
    const result = capture(fixture, proof);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.core.authoredPaths).toEqual(["work/created.txt"]);
  });

  it("forwards a scope-observer refusal under the observer's own layer and code", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    writeFileSync(join(fixture.root, "work", "alpha.txt"), "moved base\n");
    fixture.git("add", "--all");
    fixture.git("commit", "--quiet", "--no-gpg-sign", "-m", "the attempt moved HEAD");
    expect(capture(fixture, proof)).toMatchObject({
      ok: false,
      code: "RUNNER_SCOPE_HEAD_MISMATCH",
      layer: "RUNNER_SCOPE_OBSERVATION",
    });
  });

  it("forwards a sealer refusal under the sealer's own layer and code", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    // A case-only rename is a real attempt effect, and it is the one thing the
    // scanner can honestly produce that only the SEALER knows how to refuse.
    const real = createNodeFoundationCaptureFs();
    const fs = port({
      listDirectory: (path) =>
        real.listDirectory(path).map((entry) => (entry.name === "alpha.txt" ? { ...entry, name: "Alpha.txt" } : entry)),
      lstatPath: (path) => real.lstatPath(path.replace("Alpha.txt", "alpha.txt")),
      openRead: (path) => real.openRead(path.replace("Alpha.txt", "alpha.txt")),
      realpath: (path) => real.realpath(path.replace("Alpha.txt", "alpha.txt")),
      exists: (path) => real.exists(path.replace("Alpha.txt", "alpha.txt")),
    });
    expect(capture(fixture, proof, { fs })).toMatchObject({
      ok: false,
      code: "RUNNER_WORKSPACE_ENTRY_DUPLICATE",
      layer: "RUNNER_WORKSPACE_MANIFEST",
    });
  });

  it("refuses a prelaunch proof whose digest does not recompute", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    const forged = { ...proof, scannedEntryCount: proof.scannedEntryCount + 1 };
    expect(capture(fixture, forged)).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_PROOF_UNSEALED",
      layer: "RUNNER_WORKSPACE_CAPTURE",
    });
  });
});

/**
 * Two states real git will not produce on demand. The GIT OBSERVER is the
 * injection point, so `parsePorcelainV2`, `buildAttributionIndex`, `observeScope`
 * and `gitStateRejection` are all the production ones — only the bytes git would
 * have emitted are supplied. This is the same rationale scope-git.test.ts records
 * for its truncated-record arms.
 */
function observerEmitting(fixture: Fixture, porcelain: string): GitObserver {
  const real = createNodeGitObserver(fixture.root, hermeticGitEnvironment(process.env));
  return { ...real, statusPorcelainV2: () => new TextEncoder().encode(porcelain) };
}

describe.skipIf(!gitAvailable)("postlaunch index states that are not an authored tree", { timeout: 30_000 }, () => {
  it("refuses an unmerged index entry", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    const record = "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc work/alpha.txt\0";
    expect(capture(fixture, proof, { gitObserver: observerEmitting(fixture, record) })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_UNMERGED_STATE",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/alpha.txt",
    });
  });

  it("refuses a changed record whose own status claims no change", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    const record = "1 .. N... 100644 100644 100644 aaaa bbbb work/alpha.txt\0";
    expect(capture(fixture, proof, { gitObserver: observerEmitting(fixture, record) })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_CONTRADICTORY_STATE",
      layer: "RUNNER_WORKSPACE_CAPTURE",
      path: "work/alpha.txt",
    });
  });
});

describe.skipIf(!gitAvailable)("which observation may authorize result bytes", { timeout: 30_000 }, () => {
  it("seals against the PRELAUNCH observation and keeps the postlaunch one as evidence", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    writeFileSync(join(fixture.root, "work", "alpha.txt"), "authored bytes\n");
    const result = capture(fixture, proof);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.core.scopeObservation.sha256).toBe(proof.prelaunchObservation.sha256);
    expect(result.core.resultManifest.scopeObservationSha256).toBe(proof.prelaunchObservation.sha256);
    // The postlaunch observation is carried, and it is a DIFFERENT observation.
    // If these two digests were ever equal the pin below would be vacuous.
    expect(result.core.postlaunchObservation.sha256).not.toBe(proof.prelaunchObservation.sha256);
    expect(result.core.postlaunchObservation.canonicalEntries[0]).toMatchObject({
      path: "work",
      attribution: "DIRTY",
    });
  });

  it("pins WHY: handing the sealer the postlaunch observation makes it self-reject", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    writeFileSync(join(fixture.root, "work", "alpha.txt"), "authored bytes\n");
    const result = capture(fixture, proof);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // Same production sealer, same authored paths, same result bytes — the ONLY
    // difference is which observation is handed over. A postlaunch observation
    // sees the attempt's own writes as DIRTY, and the sealer admits result bytes
    // only under a CLEAN or ABSENT scope, so it refuses its own inputs.
    const resealed = buildResultManifest({
      inputManifest: proof.inputManifest,
      scopeObservation: result.core.postlaunchObservation,
      authoredPaths: result.core.authoredPaths,
      resultTreeEntries: result.core.resultTreeEntries,
      declaredArtifactRefs: [],
    });
    expect(resealed).toMatchObject({ ok: false, code: "RUNNER_WORKSPACE_PATH_DIRTY" });
  });
});

describe.skipIf(!gitAvailable)("caller-supplied conclusions the scanner must not read", { timeout: 30_000 }, () => {
  const SMUGGLED: Readonly<Record<string, unknown>> = Object.freeze({
    authoredPaths: ["work/never-authored.txt"],
    resultTreeEntries: [
      { path: "work/never-authored.txt", sha256: "0".repeat(64), byteLength: 1, origin: "AUTHORED", kind: "REGULAR" },
    ],
    declaredArtifactRefs: [{ sha256: "1".repeat(64), byteLength: 2 }],
    resultBytes: { "work/alpha.txt": "smuggled" },
    launchRequest: { argv: ["claude"] },
  });

  it("ignores every smuggled conclusion on both entry points", () => {
    const keys = Object.keys(SMUGGLED);
    expect(keys.length).toBeGreaterThan(0);
    const fixture = seedWorkspace();
    // One clean observation and one clean proof are the controls every smuggled
    // variant is compared against, so the comparison is over the SAME tree.
    const observation = observe(fixture);
    const clean = prove(fixture, { observation });
    expect(clean).toMatchObject({ ok: true });
    if (!clean.ok) return;
    let proved = 0;
    for (const key of keys) {
      const smuggled = prove(fixture, { observation, extraKeys: { [key]: SMUGGLED[key] } });
      expect(smuggled).toMatchObject({ ok: true });
      if (!smuggled.ok) continue;
      // Identical digest: the extra key changed nothing the scanner observed.
      expect(smuggled.proof.sha256).toBe(clean.proof.sha256);
      proved += 1;
    }
    expect(proved).toBe(keys.length);

    writeFileSync(join(fixture.root, "work", "alpha.txt"), "authored bytes\n");
    let captured = 0;
    for (const key of keys) {
      const result = capture(fixture, clean.proof, { extraKeys: { [key]: SMUGGLED[key] } });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(result.core.authoredPaths).toEqual(["work/alpha.txt"]);
      expect(result.core.declaredArtifactRefs).toEqual([]);
      expect(result.core.resultTreeEntries.map((entry) => entry.path)).toEqual([
        "work/alpha.txt",
        "work/nested/beta.txt",
      ]);
      captured += 1;
    }
    expect(captured).toBe(keys.length);
  });
});

describe.skipIf(!gitAvailable)("the advisory attempt core the daemon consumes", { timeout: 30_000 }, () => {
  /**
   * Transcribed from apps/daemon/src/work/foundation-attempt-contracts.ts
   * CAPTURE_KEYS. @moe/runner must not depend on the daemon, so the list is a
   * literal here; the point of the arm is that the runner core carries those
   * exact four names, so the downstream producer forwards without reshaping.
   */
  const CAPTURE_KEYS = ["authoredPaths", "declaredArtifactRefs", "resultTreeEntries", "scopeObservation"] as const;

  it("carries the four CAPTURE_KEYS verbatim, plus the advisory marker and its evidence", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    writeFileSync(join(fixture.root, "work", "created.txt"), "created\n");
    const result = capture(fixture, proof);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    for (const key of CAPTURE_KEYS) {
      expect(Object.hasOwn(result.core, key)).toBe(true);
    }
    expect(Object.keys(result.core).sort()).toEqual(
      [...CAPTURE_KEYS, "advisory", "captureVersion", "postlaunchObservation", "resultManifest"].sort(),
    );
    expect(result.core.captureVersion).toBe(FOUNDATION_CAPTURE_VERSION);
  });

  it("returns canonical, sorted, deeply frozen lists", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    writeFileSync(join(fixture.root, "work", "zulu.txt"), "zulu\n");
    writeFileSync(join(fixture.root, "work", "aaa.txt"), "aaa\n");
    rmSync(join(fixture.root, "work", "nested", "beta.txt"));
    const result = capture(fixture, proof);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const { core } = result;
    expect(core.authoredPaths).toEqual(["work/aaa.txt", "work/nested/beta.txt", "work/zulu.txt"]);
    expect(core.resultTreeEntries.map((entry) => entry.path)).toEqual([
      "work/aaa.txt",
      "work/alpha.txt",
      "work/zulu.txt",
    ]);
    expect(Object.isFrozen(core)).toBe(true);
    expect(Object.isFrozen(core.authoredPaths)).toBe(true);
    expect(Object.isFrozen(core.resultTreeEntries)).toBe(true);
    expect(Object.isFrozen(core.resultTreeEntries[0])).toBe(true);
    expect(Object.isFrozen(core.declaredArtifactRefs)).toBe(true);
    expect(Object.isFrozen(core.resultManifest)).toBe(true);
    // The sealer saw exactly what the core reports, so the digest binds them.
    expect(core.resultManifest.authoredPaths).toEqual(core.authoredPaths);
    expect(core.resultManifest.inputManifestSha256).toBe(proof.inputManifest.sha256);
  });
});

describe.skipIf(!gitAvailable)("inputs that must refuse rather than crash", { timeout: 30_000 }, () => {
  it("refuses malformed caller input on the prelaunch entry point", () => {
    const fixture = seedWorkspace();
    const observation = observe(fixture);
    const manifest = sealedInput(fixture);
    const root = createNodeFoundationCaptureFs().realpath(fixture.root);
    const base = {
      assignedRealRoot: root,
      inputManifest: manifest,
      declaredScopePaths: fixture.scopes,
      prelaunchObservation: observation,
      fs: createNodeFoundationCaptureFs(),
      limits: DEFAULT_FOUNDATION_CAPTURE_LIMITS,
    };
    // A crash carries no reason code, so every one of these has to REFUSE.
    const cases: readonly Record<string, unknown>[] = [
      { ...base, assignedRealRoot: "" },
      { ...base, fs: undefined },
      { ...base, inputManifest: "not-a-record" },
      { ...base, prelaunchObservation: undefined },
      { ...base, declaredScopePaths: "work" },
      { ...base, declaredScopePaths: [42] },
    ];
    expect(cases.length).toBeGreaterThan(0);
    let refused = 0;
    for (const malformed of cases) {
      const result = proveFoundationPrelaunchTree(malformed as unknown as Parameters<typeof proveFoundationPrelaunchTree>[0]);
      expect(result).toMatchObject({
        ok: false,
        code: "RUNNER_FOUNDATION_CAPTURE_INPUT_INVALID",
        layer: "RUNNER_WORKSPACE_CAPTURE",
      });
      refused += 1;
    }
    expect(refused).toBe(cases.length);
  });

  it("refuses a proof whose manifest body was swapped under an unchanged digest field", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    // The proof digest binds inputManifest.sha256, NOT the entries, so this
    // forgery leaves prelaunchProofSealMatches green. Only re-verifying the
    // manifest's own seal can see it.
    const forged = {
      ...proof,
      inputManifest: {
        ...proof.inputManifest,
        entries: [
          { path: "work/alpha.txt", sha256: "0".repeat(64), byteLength: 0, producer: { kind: "BASE" as const } },
        ],
      },
    };
    expect(capture(fixture, forged)).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_INPUT_MANIFEST_UNSEALED",
      layer: "RUNNER_WORKSPACE_CAPTURE",
    });
  });

  it("refuses a proof whose observation body was swapped under an unchanged digest field", () => {
    const fixture = seedWorkspace();
    const proof = provenProof(fixture);
    const forged = {
      ...proof,
      prelaunchObservation: { ...proof.prelaunchObservation, observerVersion: "forged/1" },
    };
    expect(capture(fixture, forged)).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_OBSERVATION_UNSEALED",
      layer: "RUNNER_WORKSPACE_CAPTURE",
    });
  });

  it("refuses a directory chain deeper than the scan bound instead of overflowing the stack", () => {
    const fixture = seedWorkspace();
    const clean = observe(fixture);
    const deep = join(fixture.root, "work", Array.from({ length: 70 }, (_unused, index) => `d${index}`).join("/"));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "buried.txt"), "buried\n");
    expect(prove(fixture, { observation: clean })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_DEPTH_LIMIT",
      layer: "RUNNER_WORKSPACE_CAPTURE",
    });
  });

  it("spends the byte budget from the stat, never by reading the file first", () => {
    const fixture = seedWorkspace();
    const real = createNodeFoundationCaptureFs();
    let reads = 0;
    const fs = port({
      readHandle: (handle) => {
        reads += 1;
        return real.readHandle(handle);
      },
    });
    expect(prove(fixture, { fs, limits: { maxEntries: 4096, maxAggregateBytes: 1 } })).toMatchObject({
      ok: false,
      code: "RUNNER_FOUNDATION_CAPTURE_BYTE_LIMIT",
      layer: "RUNNER_WORKSPACE_CAPTURE",
    });
    // A budget spent only after the read would have allocated the file first.
    expect(reads).toBe(0);
  });
});
