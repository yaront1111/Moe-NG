/**
 * The Foundation Preview release manifest — DoD 1.
 *
 * One canary run produces one manifest binding: the exact commit SHA, the
 * frozen-lockfile install result, every gate that ran with its outcome, and the
 * digest of the evidence each journey produced.
 *
 * Two properties are what make it a release claim rather than a decoration, and
 * both are refusals rather than warnings:
 *
 * - the working tree was CLEAN when the run started, and
 * - every gate ran at the SAME commit.
 *
 * A canary assembled from a dirty tree, or whose gates were run at different
 * commits, proves nothing about a release. So the manifest cannot be built at
 * all in either case; it fails closed with a stable code and no partially
 * authoritative object escapes.
 *
 * Digesting reuses the production `canonicalDigest`/`isCommitIdentity` rather
 * than reimplementing them here — a hashing or validation helper rewritten in
 * test code is exactly the detached-assertion defect epic rail 6 names.
 */

import {
  canonicalDigest,
  isCommitIdentity,
  isHex64,
  deepFreeze,
} from "../../../packages/runner/src/canonical.js";

import { FOUNDATION_EXIT_SET, type FoundationExitItem } from "./journey-spec.js";

export const RELEASE_MANIFEST_VERSION = "moe-foundation-release-manifest/1" as const;

/**
 * The install command is part of the CLAIM, not a convenience: a manifest built
 * from any other install command is refused, so "we installed from the lockfile"
 * cannot be asserted by a run that did not.
 */
export const FROZEN_LOCKFILE_COMMAND = "pnpm install --frozen-lockfile" as const;

export const RELEASE_MANIFEST_ERROR_CODES = Object.freeze([
  "RELEASE_MANIFEST_COMMIT_INVALID",
  "RELEASE_MANIFEST_COMMIT_MISMATCH",
  "RELEASE_MANIFEST_DIRTY_TREE",
  "RELEASE_MANIFEST_EVIDENCE_INCOMPLETE",
  "RELEASE_MANIFEST_GATE_EMPTY",
  "RELEASE_MANIFEST_GATE_RED",
  "RELEASE_MANIFEST_INSTALL_FAILED",
  "RELEASE_MANIFEST_INSTALL_NOT_FROZEN",
] as const);
export type ReleaseManifestErrorCode = (typeof RELEASE_MANIFEST_ERROR_CODES)[number];

export interface InstallRun {
  readonly command: string;
  readonly exitCode: number;
}

export interface GateRun {
  readonly command: string;
  readonly exitCode: number;
  readonly commitSha: string;
}

export interface JourneyEvidence {
  readonly journey: FoundationExitItem;
  readonly evidenceDigest: string;
}

export interface ReleaseManifestInput {
  readonly commitSha: string;
  readonly treeCleanAtStart: boolean;
  readonly install: InstallRun;
  readonly gates: readonly GateRun[];
  readonly journeyEvidence: readonly JourneyEvidence[];
}

export interface ReleaseManifest extends ReleaseManifestInput {
  readonly manifestVersion: typeof RELEASE_MANIFEST_VERSION;
  readonly manifestDigest: string;
}

export type ReleaseManifestResult =
  | { readonly ok: true; readonly manifest: ReleaseManifest }
  | {
      readonly ok: false;
      readonly code: ReleaseManifestErrorCode;
      readonly message: string;
    };

function refuse(code: ReleaseManifestErrorCode, message: string): ReleaseManifestResult {
  return Object.freeze({ ok: false as const, code, message });
}

/**
 * The exact value hashed into `manifestDigest`.
 *
 * Exported so a stored manifest can be re-verified without reconstructing the
 * field list, and so the digest provably does not cover itself.
 */
export function releaseManifestDigestInput(
  manifest: Omit<ReleaseManifest, "manifestDigest">,
): Record<string, unknown> {
  return {
    manifestVersion: manifest.manifestVersion,
    commitSha: manifest.commitSha,
    treeCleanAtStart: manifest.treeCleanAtStart,
    install: { command: manifest.install.command, exitCode: manifest.install.exitCode },
    gates: manifest.gates.map((gate) => ({
      command: gate.command,
      exitCode: gate.exitCode,
      commitSha: gate.commitSha,
    })),
    journeyEvidence: manifest.journeyEvidence.map((entry) => ({
      journey: entry.journey,
      evidenceDigest: entry.evidenceDigest,
    })),
  };
}

/**
 * Every journey in the design's exit set must carry exactly ONE well-formed digest.
 *
 * Duplicates are refused before the missing check, and by the entries rather than by a
 * set of their journeys: a set collapses a second J1 row carrying a conflicting digest
 * into the first, so a manifest that named one journey twice would bind two digests to
 * one claim and still read as complete.
 */
function evidenceRefusal(
  evidence: readonly JourneyEvidence[],
): ReleaseManifestResult | null {
  const seen = new Set<FoundationExitItem>();
  for (const entry of evidence) {
    if (seen.has(entry.journey)) {
      return refuse(
        "RELEASE_MANIFEST_EVIDENCE_INCOMPLETE",
        `evidence names ${entry.journey} more than once`,
      );
    }
    seen.add(entry.journey);
  }
  const missing = FOUNDATION_EXIT_SET.filter((journey) => !seen.has(journey));
  if (missing.length > 0 || evidence.length !== FOUNDATION_EXIT_SET.length) {
    return refuse(
      "RELEASE_MANIFEST_EVIDENCE_INCOMPLETE",
      `evidence is missing for ${missing.join(", ") || "a journey outside the exit set"}`,
    );
  }
  const malformed = evidence.filter((entry) => !isHex64(entry.evidenceDigest));
  const first = malformed[0];
  return first === undefined
    ? null
    : refuse(
        "RELEASE_MANIFEST_EVIDENCE_INCOMPLETE",
        `evidence digest for ${first.journey} is not a sha256 digest`,
      );
}

function gateRefusal(
  gates: readonly GateRun[],
  commitSha: string,
): ReleaseManifestResult | null {
  if (gates.length === 0) {
    return refuse("RELEASE_MANIFEST_GATE_EMPTY", "a release claim needs at least one gate");
  }
  const elsewhere = gates.find((gate) => gate.commitSha !== commitSha);
  if (elsewhere !== undefined) {
    return refuse(
      "RELEASE_MANIFEST_COMMIT_MISMATCH",
      `${elsewhere.command} ran at ${elsewhere.commitSha}, not at ${commitSha}`,
    );
  }
  const red = gates.find((gate) => gate.exitCode !== 0);
  return red === undefined
    ? null
    : refuse("RELEASE_MANIFEST_GATE_RED", `${red.command} exited ${red.exitCode}`);
}

/**
 * Builds the manifest, or refuses with the single most specific reason.
 *
 * Order matters and is deliberate: identity, then tree cleanliness, then the
 * install, then the gates, then the evidence. Each check is reached only when
 * the ones before it hold, so a reported code names the first thing that is
 * actually wrong rather than whichever check happened to run first.
 */
export function buildReleaseManifest(input: ReleaseManifestInput): ReleaseManifestResult {
  if (!isCommitIdentity(input.commitSha)) {
    return refuse(
      "RELEASE_MANIFEST_COMMIT_INVALID",
      `${JSON.stringify(input.commitSha)} is not a commit identity`,
    );
  }
  if (input.treeCleanAtStart !== true) {
    return refuse(
      "RELEASE_MANIFEST_DIRTY_TREE",
      "the working tree was not clean when the canary run started",
    );
  }
  if (input.install.command !== FROZEN_LOCKFILE_COMMAND) {
    return refuse(
      "RELEASE_MANIFEST_INSTALL_NOT_FROZEN",
      `install was ${JSON.stringify(input.install.command)}, not ${FROZEN_LOCKFILE_COMMAND}`,
    );
  }
  if (input.install.exitCode !== 0) {
    return refuse(
      "RELEASE_MANIFEST_INSTALL_FAILED",
      `${FROZEN_LOCKFILE_COMMAND} exited ${input.install.exitCode}`,
    );
  }
  const gateProblem = gateRefusal(input.gates, input.commitSha);
  if (gateProblem !== null) {
    return gateProblem;
  }
  const evidenceProblem = evidenceRefusal(input.journeyEvidence);
  if (evidenceProblem !== null) {
    return evidenceProblem;
  }
  const body = {
    manifestVersion: RELEASE_MANIFEST_VERSION,
    commitSha: input.commitSha,
    treeCleanAtStart: input.treeCleanAtStart,
    install: input.install,
    gates: input.gates,
    journeyEvidence: input.journeyEvidence,
  } as const satisfies Omit<ReleaseManifest, "manifestDigest">;
  const manifest = deepFreeze({
    ...body,
    manifestDigest: canonicalDigest(releaseManifestDigestInput(body)),
  });
  return Object.freeze({ ok: true as const, manifest });
}
