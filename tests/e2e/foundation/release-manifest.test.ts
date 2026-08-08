/**
 * Tests for the release manifest — DoD 1.
 *
 * The manifest's whole job is to make a release claim falsifiable, so every
 * refusal below pins its exact stable code rather than merely asserting that the
 * build failed. Two properties carry the claim: the working tree was CLEAN when
 * the run started, and every gate ran at the SAME commit. A canary assembled
 * from a dirty tree, or whose gates were run at different commits, proves
 * nothing about a release.
 */

import { describe, expect, it } from "vitest";

import { FOUNDATION_EXIT_SET, HOSTILE_CLIENT_CASE_KINDS } from "./journey-spec.js";
import {
  FROZEN_LOCKFILE_COMMAND,
  RELEASE_MANIFEST_ERROR_CODES,
  RELEASE_MANIFEST_VERSION,
  buildReleaseManifest,
  releaseManifestDigestInput,
  type ReleaseManifestInput,
} from "./release-manifest.js";

const COMMIT = "34a3d11c0ffee0ba5eba11deadbeef0123456789";
const OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567";

/**
 * Hand-written, deliberately not imported from the module under test: a list
 * the module exports could not detect a field silently dropped from the digest.
 */
const EXPECTED_DIGEST_FIELDS = [
  "manifestVersion",
  "commitSha",
  "treeCleanAtStart",
  "install",
  "gates",
  "journeyEvidence",
] as const;

function evidenceForExitSet(): ReleaseManifestInput["journeyEvidence"] {
  return FOUNDATION_EXIT_SET.map((journey, index) => ({
    journey,
    evidenceDigest: String(index + 1).repeat(64).slice(0, 64),
  }));
}

function validInput(): ReleaseManifestInput {
  return {
    commitSha: COMMIT,
    treeCleanAtStart: true,
    install: { command: FROZEN_LOCKFILE_COMMAND, exitCode: 0 },
    gates: [
      { command: "pnpm typecheck", exitCode: 0, commitSha: COMMIT },
      { command: "pnpm test", exitCode: 0, commitSha: COMMIT },
      { command: "pnpm test:e2e", exitCode: 0, commitSha: COMMIT },
    ],
    journeyEvidence: evidenceForExitSet(),
  };
}

function built(input: ReleaseManifestInput) {
  const result = buildReleaseManifest(input);
  if (result.ok !== true) {
    throw new Error(`expected an accepted manifest, got ${result.code}`);
  }
  return result.manifest;
}

function refusalCode(input: ReleaseManifestInput): string {
  const result = buildReleaseManifest(input);
  return result.ok === true ? "ACCEPTED" : result.code;
}

describe("release manifest acceptance", () => {
  it("binds the commit, the frozen install, every gate, and the journey evidence", () => {
    const manifest = built(validInput());
    expect(manifest.manifestVersion).toBe(RELEASE_MANIFEST_VERSION);
    expect(manifest.commitSha).toBe(COMMIT);
    expect(manifest.treeCleanAtStart).toBe(true);
    expect(manifest.install).toEqual({ command: FROZEN_LOCKFILE_COMMAND, exitCode: 0 });
    expect(manifest.gates.map((gate) => gate.command)).toEqual([
      "pnpm typecheck",
      "pnpm test",
      "pnpm test:e2e",
    ]);
    expect(manifest.journeyEvidence.map((entry) => entry.journey)).toEqual([
      ...FOUNDATION_EXIT_SET,
    ]);
  });

  it("is immutable and content-addressed by a digest that excludes itself", () => {
    const manifest = built(validInput());
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(manifest.manifestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.keys(releaseManifestDigestInput(manifest))).not.toContain("manifestDigest");
    expect(built(validInput()).manifestDigest).toBe(manifest.manifestDigest);
  });
});

describe("release manifest digest coverage", () => {
  it("digests exactly the hand-written field list", () => {
    expect(Object.keys(releaseManifestDigestInput(built(validInput()))).sort()).toEqual(
      [...EXPECTED_DIGEST_FIELDS].sort(),
    );
  });

  /**
   * Only three covered fields can vary inside an ACCEPTED manifest:
   * `treeCleanAtStart` must be true and `install` must be the frozen command at
   * exit 0, or the build refuses. Those two are pinned by their refusal codes
   * below instead, which is a stronger guarantee than a digest change.
   */
  it("changes the digest when any field that can vary changes", () => {
    const baseline = built(validInput()).manifestDigest;
    const perturbations: readonly (readonly [string, ReleaseManifestInput])[] = [
      [
        // The gates move with it: a manifest whose gates ran elsewhere is
        // refused, so the commit cannot be perturbed on its own.
        "commitSha",
        {
          ...validInput(),
          commitSha: OTHER_COMMIT,
          gates: validInput().gates.map((gate) => ({ ...gate, commitSha: OTHER_COMMIT })),
        },
      ],
      [
        "gates",
        { ...validInput(), gates: [{ command: "pnpm test", exitCode: 0, commitSha: COMMIT }] },
      ],
      [
        "journeyEvidence",
        {
          ...validInput(),
          journeyEvidence: evidenceForExitSet().map((entry) => ({
            ...entry,
            evidenceDigest: "f".repeat(64),
          })),
        },
      ],
    ];
    expect(perturbations.length).toBe(3);
    expect(perturbations.map(([field, input]) => [field, built(input).manifestDigest !== baseline]))
      .toEqual([
        ["commitSha", true],
        ["gates", true],
        ["journeyEvidence", true],
      ]);
  });
});

describe("release manifest refusals", () => {
  it("refuses a dirty working tree with RELEASE_MANIFEST_DIRTY_TREE", () => {
    expect(refusalCode({ ...validInput(), treeCleanAtStart: false })).toBe(
      "RELEASE_MANIFEST_DIRTY_TREE",
    );
  });

  it("refuses gates run at different commits with RELEASE_MANIFEST_COMMIT_MISMATCH", () => {
    expect(
      refusalCode({
        ...validInput(),
        gates: [
          { command: "pnpm typecheck", exitCode: 0, commitSha: COMMIT },
          { command: "pnpm test", exitCode: 0, commitSha: OTHER_COMMIT },
        ],
      }),
    ).toBe("RELEASE_MANIFEST_COMMIT_MISMATCH");
  });

  it("refuses a non-frozen install with RELEASE_MANIFEST_INSTALL_NOT_FROZEN", () => {
    expect(
      refusalCode({ ...validInput(), install: { command: "pnpm install", exitCode: 0 } }),
    ).toBe("RELEASE_MANIFEST_INSTALL_NOT_FROZEN");
  });

  it("refuses a failed install with RELEASE_MANIFEST_INSTALL_FAILED", () => {
    expect(
      refusalCode({
        ...validInput(),
        install: { command: FROZEN_LOCKFILE_COMMAND, exitCode: 1 },
      }),
    ).toBe("RELEASE_MANIFEST_INSTALL_FAILED");
  });

  it("refuses a red gate with RELEASE_MANIFEST_GATE_RED", () => {
    expect(
      refusalCode({
        ...validInput(),
        gates: [{ command: "pnpm test", exitCode: 1, commitSha: COMMIT }],
      }),
    ).toBe("RELEASE_MANIFEST_GATE_RED");
  });

  it("refuses an empty gate list with RELEASE_MANIFEST_GATE_EMPTY", () => {
    expect(refusalCode({ ...validInput(), gates: [] })).toBe("RELEASE_MANIFEST_GATE_EMPTY");
  });

  it("refuses a malformed commit with RELEASE_MANIFEST_COMMIT_INVALID", () => {
    expect(refusalCode({ ...validInput(), commitSha: "not-a-commit" })).toBe(
      "RELEASE_MANIFEST_COMMIT_INVALID",
    );
  });

  it("refuses evidence that misses a journey with RELEASE_MANIFEST_EVIDENCE_INCOMPLETE", () => {
    expect(
      refusalCode({ ...validInput(), journeyEvidence: evidenceForExitSet().slice(1) }),
    ).toBe("RELEASE_MANIFEST_EVIDENCE_INCOMPLETE");
  });

  it("lists every refusal code it can return, frozen and without duplicates", () => {
    expect([...RELEASE_MANIFEST_ERROR_CODES].sort()).toEqual([
      "RELEASE_MANIFEST_COMMIT_INVALID",
      "RELEASE_MANIFEST_COMMIT_MISMATCH",
      "RELEASE_MANIFEST_DIRTY_TREE",
      "RELEASE_MANIFEST_EVIDENCE_INCOMPLETE",
      "RELEASE_MANIFEST_GATE_EMPTY",
      "RELEASE_MANIFEST_GATE_RED",
      "RELEASE_MANIFEST_INSTALL_FAILED",
      "RELEASE_MANIFEST_INSTALL_NOT_FROZEN",
    ]);
    expect(new Set(RELEASE_MANIFEST_ERROR_CODES).size).toBe(RELEASE_MANIFEST_ERROR_CODES.length);
  });
});

describe("journey specification anchors", () => {
  it("carries the design's exit set exactly, in the order the exit line names it", () => {
    expect([...FOUNDATION_EXIT_SET]).toEqual([
      "J1",
      "J3",
      "J4",
      "hostile-client",
      "release-handoff",
    ]);
  });

  it("enumerates a non-empty hostile-client case list so an empty sweep cannot pass", () => {
    expect(HOSTILE_CLIENT_CASE_KINDS.length).toBeGreaterThan(0);
    expect(new Set(HOSTILE_CLIENT_CASE_KINDS).size).toBe(HOSTILE_CLIENT_CASE_KINDS.length);
  });
});
