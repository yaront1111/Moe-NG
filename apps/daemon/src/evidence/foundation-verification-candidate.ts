/**
 * Binds a caller-named candidate root to the attempt's DURABLE input tree before
 * anything is activated or launched.
 *
 * `candidateRoot` is the one request field that is not an identity: it is WHERE
 * the sealed recipe runs. Left unbound, it is also the one place a caller could
 * substitute for durable state without touching the store: a trivially green
 * tree would earn a PASSED receipt for an attempt whose real tree fails, and
 * closure trusts that verdict. So the root is proven to BE the input manifest,
 * byte for byte, by the runner's own prelaunch prover over the runner's own git
 * observer: HEAD is read from the tree (never copied from the manifest), every
 * sealed entry must be present with its sealed bytes, and any regular file the
 * manifest does not list refuses, since an extra `package.json` or `vitest.config`
 * is exactly how a verifier is steered. `.git` is the only entry not walked:
 * it is the repository metadata HEAD is read from, which git itself never
 * lists as part of a tree.
 *
 * ONE condition, ONE code. "This root is not the durable tree" is a single
 * question whether the answer came from git, from the walk or from a path the
 * filesystem refused, and a caller can act on none of the sub-reasons
 * differently: the repair is always to present the tree the manifest sealed.
 */

import { readdirSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  DEFAULT_FOUNDATION_CAPTURE_LIMITS, createNodeFoundationCaptureFs, createNodeGitObserver,
  createNodeScopePaths, hermeticGitEnvironment, observeScope, proveFoundationPrelaunchTree,
} from "@moe/runner";
import type { WorkspaceInputManifest } from "@moe/runner";

import { refuseVerification } from "./foundation-verification-contracts.js";
import type { FoundationVerificationRefused } from "./foundation-verification-contracts.js";

/** Stamped on the observation this binding takes; never persisted, never compared. */
const CANDIDATE_OBSERVER_VERSION = "moe-daemon-verification-candidate/1";
const REPOSITORY_METADATA = ".git";

export interface BindCandidateTreeInput {
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly candidateRoot: string;
  readonly inputManifest: WorkspaceInputManifest;
  /** Canonical UTC instant, supplied by the service clock like every other stamp. */
  readonly observedAt: string;
}

export interface CandidateTreeBinding {
  /** HEAD as git reported it FROM THE TREE; equal to the manifest's base by proof. */
  readonly baseIdentity: string;
  readonly realRoot: string;
}

export type BindCandidateTreeResult = CandidateTreeBinding | FoundationVerificationRefused;

const mismatch = (): FoundationVerificationRefused => refuseVerification(
  "FOUNDATION_VERIFICATION_CANDIDATE_TREE_MISMATCH", "DAEMON_VERIFICATION_IDENTITY");

/** Every top-level entry except the repository metadata, so the walk covers
 *  the WHOLE tree: a manifest built over a narrower scope cannot be satisfied
 *  by a root that also holds files the manifest never sealed. */
function topLevelScope(realRoot: string): readonly string[] | null {
  try {
    return readdirSync(realRoot)
      .filter((name) => name !== REPOSITORY_METADATA)
      .sort();
  } catch {
    return null;
  }
}

export function bindCandidateTree(input: BindCandidateTreeInput): BindCandidateTreeResult {
  const { candidateRoot, inputManifest } = input;
  // A relative root would resolve against this process's cwd, which is not a
  // location the caller named; nothing below may run before this is known.
  if (candidateRoot.length === 0 || !isAbsolute(candidateRoot)) return mismatch();
  let realRoot: string;
  try {
    realRoot = realpathSync(candidateRoot);
  } catch {
    return mismatch();
  }
  const declaredScopePaths = topLevelScope(realRoot);
  if (declaredScopePaths === null) return mismatch();
  const observed = observeScope({
    baseIdentity: inputManifest.baseIdentity, declaredScopePaths,
    gitObserver: createNodeGitObserver(realRoot, hermeticGitEnvironment(input.baseEnvironment)),
    observedAt: input.observedAt, observerVersion: CANDIDATE_OBSERVER_VERSION,
    pathObserver: createNodeScopePaths(), worktreeRoot: realRoot,
  });
  if (!observed.ok) return mismatch();
  const proven = proveFoundationPrelaunchTree({
    assignedRealRoot: realRoot, declaredScopePaths, fs: createNodeFoundationCaptureFs(),
    inputManifest, limits: DEFAULT_FOUNDATION_CAPTURE_LIMITS,
    prelaunchObservation: observed.observation,
  });
  if (!proven.ok) return mismatch();
  return Object.freeze({
    baseIdentity: observed.observation.gitAttribution.headCommit, realRoot,
  });
}
