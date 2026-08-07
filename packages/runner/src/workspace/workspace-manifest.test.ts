import { describe, expect, it } from "vitest";

import { canonicalJson } from "../canonical.js";
import type { ArtifactRef } from "../artifacts/artifact-contract.js";
import type { GitObserver, ScopeObservation } from "../scope/scope-contract.js";
import { observeScope } from "../scope/scope-observation.js";
import {
  MAX_WORKSPACE_ENTRIES,
  type BuildResultManifestInput,
  type ResultTreeEntry,
  type WorkspaceInputEntry,
  type WorkspaceInputManifest,
} from "./workspace-contract.js";
import { buildInputManifest, buildResultManifest } from "./workspace-manifest.js";

const ROOT = "fixture-root";
const HEAD = "0".repeat(40);
const OTHER_HEAD = "1".repeat(40);
const BLOB = "2".repeat(40);
const OBSERVED_AT = "2026-08-07T12:00:00Z";
const OBSERVER_VERSION = "moe-runner-scope-observer/1";

const digestOf = (marker: string): string => marker.repeat(64).slice(0, 64);
const DIGEST_A = digestOf("a");
const DIGEST_B = digestOf("b");
const DIGEST_C = digestOf("c");

function porcelain(records: readonly string[]): Uint8Array {
  return new TextEncoder().encode(records.map((record) => `${record}\0`).join(""));
}

function changed(xy: string, path: string): string {
  return `1 ${xy} N... 100644 100644 100644 ${BLOB} ${BLOB} ${path}`;
}

function fakeGit(overrides: Partial<GitObserver> = {}): GitObserver {
  return {
    headCommit: () => HEAD,
    statusPorcelainV2: () => porcelain([`# branch.oid ${HEAD}`]),
    lsFilesTracked: () => [],
    lsFilesIgnored: () => [],
    submodulePaths: () => [],
    ...overrides,
  };
}

/** Builds a genuinely digest-bound observation so result binding is never faked. */
function scopeFor(paths: readonly string[], git: Partial<GitObserver> = {}, base = HEAD): ScopeObservation {
  const result = observeScope({
    worktreeRoot: ROOT,
    baseIdentity: base,
    declaredScopePaths: paths,
    gitObserver: fakeGit({ headCommit: () => base, ...git }),
    pathObserver: { realpath: (path) => path, exists: () => false },
    observedAt: OBSERVED_AT,
    observerVersion: OBSERVER_VERSION,
  });
  if (!result.ok) {
    throw new Error(`scope fixture failed: ${result.code} ${result.message}`);
  }
  return result.observation;
}

function inputEntry(overrides: Partial<WorkspaceInputEntry> = {}): WorkspaceInputEntry {
  return {
    path: "pkg/src/base.ts",
    sha256: DIGEST_A,
    byteLength: 10,
    producer: { kind: "BASE" },
    ...overrides,
  };
}

function inputManifestFixture(entries: readonly WorkspaceInputEntry[] = [inputEntry()]): WorkspaceInputManifest {
  const built = buildInputManifest({ baseIdentity: HEAD, entries });
  if (!built.ok) {
    throw new Error(`input manifest fixture failed: ${built.code} ${built.message}`);
  }
  return built.manifest;
}

function resultEntry(overrides: Partial<ResultTreeEntry> = {}): ResultTreeEntry {
  return {
    path: "pkg/src/base.ts",
    sha256: DIGEST_A,
    byteLength: 10,
    origin: "INHERITED",
    kind: "REGULAR",
    ...overrides,
  };
}

function resultInput(overrides: Partial<BuildResultManifestInput> = {}): BuildResultManifestInput {
  return {
    inputManifest: inputManifestFixture(),
    scopeObservation: scopeFor(["pkg/src"]),
    authoredPaths: ["pkg/src/authored.ts"],
    resultTreeEntries: [
      resultEntry(),
      resultEntry({ path: "pkg/src/authored.ts", sha256: DIGEST_B, byteLength: 4, origin: "AUTHORED" }),
    ],
    declaredArtifactRefs: [{ sha256: DIGEST_C, byteLength: 7 }],
    ...overrides,
  };
}

function expectInputFailure(
  input: Parameters<typeof buildInputManifest>[0],
  code: string,
): void {
  const result = buildInputManifest(input);
  expect(result.ok).toBe(false);
  expect(result.ok === false ? result.code : null).toBe(code);
}

function expectResultFailure(overrides: Partial<BuildResultManifestInput>, code: string): void {
  const result = buildResultManifest(resultInput(overrides));
  expect(result.ok).toBe(false);
  expect(result.ok === false ? result.code : null).toBe(code);
}

describe("buildInputManifest", () => {
  it("returns a frozen digest-bound manifest with sorted entries", () => {
    const built = buildInputManifest({
      baseIdentity: HEAD,
      entries: [
        inputEntry({ path: "pkg/src/z.ts", sha256: DIGEST_B }),
        inputEntry({ path: "pkg/src/a.ts" }),
      ],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.manifest.entries.map((entry) => entry.path)).toEqual(["pkg/src/a.ts", "pkg/src/z.ts"]);
    expect(built.manifest.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(built.manifest)).toBe(true);
    expect(Object.isFrozen(built.manifest.entries[0])).toBe(true);
    expect(() => {
      (built.manifest.entries as WorkspaceInputEntry[]).push(inputEntry());
    }).toThrow();
  });

  it("carries a predecessor producer identity that a digest could never recover", () => {
    const built = buildInputManifest({
      baseIdentity: HEAD,
      entries: [
        inputEntry({
          producer: { kind: "PREDECESSOR", attemptRef: "attempt-7", epoch: 3, adoptionRef: "adopt-2" },
        }),
      ],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.manifest.entries[0]?.producer).toEqual({
      kind: "PREDECESSOR",
      attemptRef: "attempt-7",
      epoch: 3,
      adoptionRef: "adopt-2",
    });
  });

  it("binds the producer into the digest", () => {
    const base = inputManifestFixture([inputEntry()]);
    const predecessor = inputManifestFixture([
      inputEntry({ producer: { kind: "PREDECESSOR", attemptRef: "attempt-1", epoch: 0 } }),
    ]);
    expect(predecessor.sha256).not.toBe(base.sha256);
  });

  it("is reproducible across declaration orders and repeated runs", () => {
    const forward = inputManifestFixture([
      inputEntry({ path: "pkg/src/a.ts" }),
      inputEntry({ path: "pkg/src/b.ts", sha256: DIGEST_B }),
    ]);
    const reverse = inputManifestFixture([
      inputEntry({ path: "pkg/src/b.ts", sha256: DIGEST_B }),
      inputEntry({ path: "pkg/src/a.ts" }),
    ]);
    expect(canonicalJson(forward)).toBe(canonicalJson(reverse));
    expect(forward.sha256).toBe(reverse.sha256);
  });

  it("rejects a non-commit base identity", () => {
    expectInputFailure({ baseIdentity: "HEAD", entries: [inputEntry()] }, "RUNNER_WORKSPACE_BASE_IDENTITY_INVALID");
  });

  it("rejects non-canonical entry paths", () => {
    expectInputFailure(
      { baseIdentity: HEAD, entries: [inputEntry({ path: "../escape.ts" })] },
      "RUNNER_WORKSPACE_PATH_NOT_CANONICAL",
    );
    expectInputFailure(
      { baseIdentity: HEAD, entries: [inputEntry({ path: "pkg\\src\\a.ts" })] },
      "RUNNER_WORKSPACE_PATH_NOT_CANONICAL",
    );
  });

  it("rejects malformed digests and byte lengths", () => {
    expectInputFailure(
      { baseIdentity: HEAD, entries: [inputEntry({ sha256: "not-a-digest" })] },
      "RUNNER_WORKSPACE_ENTRY_DIGEST_INVALID",
    );
    expectInputFailure(
      { baseIdentity: HEAD, entries: [inputEntry({ byteLength: -1 })] },
      "RUNNER_WORKSPACE_ENTRY_BYTE_LENGTH_INVALID",
    );
  });

  it("rejects duplicate and case-colliding entry paths", () => {
    expectInputFailure(
      { baseIdentity: HEAD, entries: [inputEntry(), inputEntry()] },
      "RUNNER_WORKSPACE_ENTRY_DUPLICATE",
    );
    expectInputFailure(
      { baseIdentity: HEAD, entries: [inputEntry(), inputEntry({ path: "pkg/src/BASE.ts" })] },
      "RUNNER_WORKSPACE_ENTRY_DUPLICATE",
    );
  });

  it("rejects malformed producers", () => {
    const cases: readonly WorkspaceInputEntry["producer"][] = [
      { kind: "MYSTERY" } as unknown as WorkspaceInputEntry["producer"],
      { kind: "PREDECESSOR", attemptRef: "", epoch: 0 },
      { kind: "PREDECESSOR", attemptRef: "attempt-1", epoch: -1 },
      { kind: "PREDECESSOR", attemptRef: "attempt-1", epoch: 1.5 },
      { kind: "PREDECESSOR", attemptRef: "attempt-1", epoch: 0, adoptionRef: "" },
    ];
    for (const producer of cases) {
      expectInputFailure(
        { baseIdentity: HEAD, entries: [inputEntry({ producer })] },
        "RUNNER_WORKSPACE_PRODUCER_INVALID",
      );
    }
  });

  it("rejects a malformed entry record instead of throwing", () => {
    const entries = [null] as unknown as readonly WorkspaceInputEntry[];
    expectInputFailure({ baseIdentity: HEAD, entries }, "RUNNER_WORKSPACE_PATH_NOT_CANONICAL");
  });

  it("rejects an oversized input tree", () => {
    const entries = Array.from({ length: MAX_WORKSPACE_ENTRIES + 1 }, (_unused, index) =>
      inputEntry({ path: `pkg/src/f${index}.ts` }),
    );
    expectInputFailure({ baseIdentity: HEAD, entries }, "RUNNER_WORKSPACE_ENTRY_LIMIT");
  });
});

describe("buildResultManifest", () => {
  it("splits inherited from authored and binds every upstream digest", () => {
    const input = resultInput();
    const built = buildResultManifest(input);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { manifest } = built;
    expect(manifest.inheritedEntries.map((entry) => entry.path)).toEqual(["pkg/src/base.ts"]);
    expect(manifest.authoredEntries.map((entry) => entry.path)).toEqual(["pkg/src/authored.ts"]);
    expect(manifest.inputManifestSha256).toBe(input.inputManifest.sha256);
    expect(manifest.scopeObservationSha256).toBe(input.scopeObservation.sha256);
    expect(manifest.baseIdentity).toBe(HEAD);
    expect(manifest.authoredPaths).toEqual(["pkg/src/authored.ts"]);
    expect(manifest.declaredArtifactRefs).toEqual([{ sha256: DIGEST_C, byteLength: 7 }]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.inheritedEntries[0])).toBe(true);
  });

  it("changes the digest when any bound fact changes", () => {
    const baseline = buildResultManifest(resultInput());
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const otherInput = buildResultManifest(
      resultInput({
        inputManifest: inputManifestFixture([inputEntry({ byteLength: 11 })]),
        resultTreeEntries: [
          resultEntry({ byteLength: 11 }),
          resultEntry({ path: "pkg/src/authored.ts", sha256: DIGEST_B, byteLength: 4, origin: "AUTHORED" }),
        ],
      }),
    );
    const otherScope = buildResultManifest(resultInput({ scopeObservation: scopeFor(["pkg/src", "pkg/docs"]) }));
    const otherArtifacts = buildResultManifest(resultInput({ declaredArtifactRefs: [] }));
    const digests = [baseline, otherInput, otherScope, otherArtifacts].map((result) =>
      result.ok ? result.manifest.sha256 : "failed",
    );
    expect(new Set(digests).size).toBe(4);
  });

  it("is reproducible across entry orders and repeated runs", () => {
    const forward = buildResultManifest(resultInput());
    const reverse = buildResultManifest(
      resultInput({
        resultTreeEntries: [
          resultEntry({ path: "pkg/src/authored.ts", sha256: DIGEST_B, byteLength: 4, origin: "AUTHORED" }),
          resultEntry(),
        ],
        declaredArtifactRefs: [{ sha256: DIGEST_C, byteLength: 7 }],
      }),
    );
    expect(forward.ok && reverse.ok).toBe(true);
    if (!forward.ok || !reverse.ok) return;
    expect(canonicalJson(forward.manifest)).toBe(canonicalJson(reverse.manifest));
    expect(forward.manifest.sha256).toBe(reverse.manifest.sha256);
  });

  it("rejects an input manifest whose digest does not recompute", () => {
    const tampered = { ...inputManifestFixture(), sha256: DIGEST_B } as WorkspaceInputManifest;
    expectResultFailure({ inputManifest: tampered }, "RUNNER_WORKSPACE_INPUT_MANIFEST_INVALID");
  });

  it("rejects a scope observation whose digest does not recompute", () => {
    const tampered = { ...scopeFor(["pkg/src"]), sha256: DIGEST_B } as ScopeObservation;
    expectResultFailure({ scopeObservation: tampered }, "RUNNER_WORKSPACE_SCOPE_OBSERVATION_INVALID");
  });

  it("rejects an input manifest and scope observation taken over different bases", () => {
    expectResultFailure({ scopeObservation: scopeFor(["pkg/src"], {}, OTHER_HEAD) }, "RUNNER_WORKSPACE_BASE_MISMATCH");
  });

  it("rejects a result entry outside the canonical scope", () => {
    expectResultFailure(
      { resultTreeEntries: [resultEntry({ path: "other/pkg/loot.ts", origin: "AUTHORED" })] },
      "RUNNER_WORKSPACE_PATH_ESCAPED",
    );
  });

  it("rejects a symlinked result entry", () => {
    expectResultFailure(
      { resultTreeEntries: [resultEntry({ kind: "SYMLINK" })] },
      "RUNNER_WORKSPACE_PATH_SYMLINKED",
    );
  });

  it("rejects a result entry that is not a regular file", () => {
    expectResultFailure(
      { resultTreeEntries: [resultEntry({ kind: "DIRECTORY" })] },
      "RUNNER_WORKSPACE_PATH_KIND_UNSUPPORTED",
    );
  });

  it("rejects dirty, staged, untracked, and unclassifiable scope attribution", () => {
    const cases: readonly (readonly [Partial<GitObserver>, string])[] = [
      [{ statusPorcelainV2: () => porcelain([changed(".M", "pkg/src/base.ts")]) }, "RUNNER_WORKSPACE_PATH_DIRTY"],
      [{ statusPorcelainV2: () => porcelain([changed("M.", "pkg/src/base.ts")]) }, "RUNNER_WORKSPACE_PATH_STAGED"],
      [{ statusPorcelainV2: () => porcelain(["? pkg/src/base.ts"]) }, "RUNNER_WORKSPACE_PATH_UNTRACKED"],
      [
        { statusPorcelainV2: () => porcelain([changed("..", "pkg/src/base.ts")]) },
        "RUNNER_WORKSPACE_ATTRIBUTION_UNKNOWN",
      ],
    ];
    for (const [git, code] of cases) {
      expectResultFailure({ scopeObservation: scopeFor(["pkg/src"], git) }, code);
    }
  });

  it("rejects a result entry nobody declared", () => {
    expectResultFailure(
      {
        resultTreeEntries: [resultEntry(), resultEntry({ path: "pkg/src/stowaway.ts", origin: "AUTHORED" })],
      },
      "RUNNER_WORKSPACE_PATH_UNDECLARED",
    );
  });

  it("rejects inherited bytes with no producer in the input closure", () => {
    expectResultFailure(
      {
        authoredPaths: ["pkg/src/authored.ts"],
        resultTreeEntries: [resultEntry(), resultEntry({ path: "pkg/src/authored.ts", sha256: DIGEST_B })],
      },
      "RUNNER_WORKSPACE_PATH_FOREIGN",
    );
  });

  it("rejects authored bytes with no declared author", () => {
    expectResultFailure(
      { resultTreeEntries: [resultEntry({ origin: "AUTHORED" })] },
      "RUNNER_WORKSPACE_PATH_FOREIGN",
    );
  });

  it("rejects an inherited entry whose bytes drifted from its producer", () => {
    expectResultFailure({ resultTreeEntries: [resultEntry({ sha256: DIGEST_B })] }, "RUNNER_WORKSPACE_INHERITED_PRODUCER_MISMATCH");
    expectResultFailure({ resultTreeEntries: [resultEntry({ byteLength: 11 })] }, "RUNNER_WORKSPACE_INHERITED_PRODUCER_MISMATCH");
  });

  it("rejects an authored path outside the declared scope", () => {
    expectResultFailure({ authoredPaths: ["other/pkg/a.ts"] }, "RUNNER_WORKSPACE_AUTHORED_PATH_OUT_OF_SCOPE");
  });

  it("rejects a non-canonical or duplicated authored path", () => {
    expectResultFailure({ authoredPaths: ["pkg/src/../a.ts"] }, "RUNNER_WORKSPACE_PATH_NOT_CANONICAL");
    expectResultFailure(
      { authoredPaths: ["pkg/src/authored.ts", "pkg/src/authored.ts"] },
      "RUNNER_WORKSPACE_ENTRY_DUPLICATE",
    );
  });

  it("rejects duplicate result entries", () => {
    expectResultFailure(
      { resultTreeEntries: [resultEntry(), resultEntry()] },
      "RUNNER_WORKSPACE_ENTRY_DUPLICATE",
    );
  });

  it("rejects a malformed declared artifact reference", () => {
    const refs = [{ sha256: "short", byteLength: 1 }] as readonly ArtifactRef[];
    expectResultFailure({ declaredArtifactRefs: refs }, "RUNNER_WORKSPACE_ARTIFACT_REF_INVALID");
  });

  it("rejects an input manifest that cannot be canonically serialized", () => {
    const sealed = inputManifestFixture();
    const unserializable = {
      ...sealed,
      entries: [
        {
          ...sealed.entries[0],
          producer: { kind: "PREDECESSOR", attemptRef: "attempt-1", epoch: 0, adoptionRef: undefined },
        },
      ],
    } as unknown as WorkspaceInputManifest;
    expectResultFailure({ inputManifest: unserializable }, "RUNNER_WORKSPACE_INPUT_MANIFEST_INVALID");
  });

  it("rejects an authored path that case-collides with an inherited path", () => {
    expectResultFailure({ authoredPaths: ["pkg/src/BASE.ts"] }, "RUNNER_WORKSPACE_ENTRY_DUPLICATE");
  });

  it("rejects malformed result entry and artifact records instead of throwing", () => {
    const entries = [null] as unknown as readonly ResultTreeEntry[];
    expectResultFailure({ resultTreeEntries: entries }, "RUNNER_WORKSPACE_PATH_NOT_CANONICAL");
    const refs = [null] as unknown as readonly ArtifactRef[];
    expectResultFailure({ declaredArtifactRefs: refs }, "RUNNER_WORKSPACE_ARTIFACT_REF_INVALID");
  });

  it("accepts an inherited entry whose declared scope path git tracks as clean", () => {
    const built = buildResultManifest(
      resultInput({ scopeObservation: scopeFor(["pkg/src"], { lsFilesTracked: () => ["pkg/src/base.ts"] }) }),
    );
    expect(built.ok).toBe(true);
  });
});
