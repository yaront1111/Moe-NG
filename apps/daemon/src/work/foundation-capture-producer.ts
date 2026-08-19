/**
 * The production `captureResult` producer: the one place a real launch result
 * becomes the daemon's `CAPTURE_KEYS` answer.
 *
 * THE RECORD IS THE AUTHORITY, THE CALL SITE ONLY IDENTIFIES. Every physical
 * fact — the assigned root, the sealed input manifest, the declared scope, the
 * trusted prelaunch observation — is read from the durable capture context that
 * `prepareCapture` committed BEFORE any provider existed. The call site
 * contributes identifiers and this dispatch's own prelaunch proof, and nothing
 * else: there is no field here through which a caller could hand this module a
 * root, a path set or an authored list, so a smuggled result fact is not
 * refused, it is unrepresentable.
 *
 * WHY THE PROOF ARRIVES INSTEAD OF BEING DERIVED. Measured at 1d1a59e: the
 * proof is not a field of the durable record, re-proving the tree after a
 * launch refuses (the tree no longer equals its sealed input — that is what an
 * attempt DOING work looks like), and `sealPrelaunchProof` is withheld from
 * `@moe/runner` precisely so no consumer can mint "the tree was proven". So the
 * proof travels lexically from this dispatch's own preparation, exactly as
 * `captureRef` does. The PROOF FENCE below is what keeps that honest: a proof
 * must agree with the record `captureRef` names, so another attempt's genuine
 * proof — seal intact — still cannot be used here.
 *
 * REFUSALS ARE RETURNED, NEVER THROWN. The port's caller wraps this in
 * `contained()`, which turns a throw into `null` and then into a bare
 * `FOUNDATION_ATTEMPT_CAPTURE_UNKNOWN`. Returning the upstream code and layer
 * verbatim is what lets a reader learn WHICH authority refused.
 */

import {
  DEFAULT_FOUNDATION_CAPTURE_LIMITS, captureFoundationWorkspaceDelta,
  createNodeFoundationCaptureFs, createNodeGitObserver, createNodeScopePaths,
  hermeticGitEnvironment, prelaunchProofSealMatches,
} from "@moe/runner";
import type {
  FoundationCaptureFsPort, FoundationPrelaunchProof, GitObserver, ScopePathObserver,
} from "@moe/runner";

import { exactKeys, isRecord } from "./foundation-attempt-codec.js";
import { DAEMON_FOUNDATION_CAPTURE } from "./foundation-capture-context-contract.js";
import type { FoundationCaptureContextRecord } from "./foundation-capture-context-contract.js";
import { readFoundationCaptureContext } from "./foundation-capture-context-ledger.js";
import type { FoundationCaptureContextStore } from "./foundation-capture-context-ledger.js";

/** Closed, and this module's OWN. The ledger's and the runner's vocabularies
 *  are landed and cross this boundary verbatim; restating a member of either
 *  here would make one condition answerable under two codes. */
export const FOUNDATION_CAPTURE_PRODUCER_CODES = Object.freeze([
  "FOUNDATION_CAPTURE_PRODUCER_INPUT_INVALID",
  "FOUNDATION_CAPTURE_PRODUCER_IDENTITY_MISMATCH",
  "FOUNDATION_CAPTURE_PRODUCER_PROOF_UNBOUND",
] as const);

export type FoundationCaptureProducerCode = (typeof FOUNDATION_CAPTURE_PRODUCER_CODES)[number];

/**
 * Exactly what `foundation-attempt-service.ts` hands the port. Published so a
 * test bounds itself by THIS list rather than a copy, and so the absence of a
 * physical-fact key is a checkable property rather than a claim in a comment.
 */
export const FOUNDATION_CAPTURE_PRODUCER_INPUT_KEYS = Object.freeze([
  "attemptId", "baseIdentity", "captureRef", "nodeKey", "observation", "proof", "sessionId",
] as const);

/** `code` and `layer` are plain strings because an UPSTREAM refusal crosses
 *  this boundary verbatim; narrowing them would force a restamp, and a
 *  restamped refusal hides which authority actually said no. */
export interface FoundationCaptureProducerRefusal {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
}

export interface FoundationCaptureProducerObservers {
  readonly gitObserver: GitObserver;
  readonly pathObserver: ScopePathObserver;
}

export interface FoundationCaptureProducerOptions {
  readonly store: FoundationCaptureContextStore;
  readonly captureFs?: FoundationCaptureFsPort;
  readonly clock?: () => string;
  readonly observers?: (worktreeRoot: string) => FoundationCaptureProducerObservers;
}

/** The advisory core carries more than the daemon's answer; the store's
 *  `exactKeys` gate drops any superset to UNKNOWN, so the projection is exact. */
export type FoundationCaptureProducerAnswer = Readonly<Record<string, unknown>>;

const OBSERVER_VERSION = "moe-daemon-foundation-capture/1";

const refuse = (code: string, layer: string): FoundationCaptureProducerRefusal =>
  Object.freeze({ code, layer, ok: false as const });

const refuseLocal = (code: FoundationCaptureProducerCode): FoundationCaptureProducerRefusal =>
  refuse(code, DAEMON_FOUNDATION_CAPTURE);

function defaultObservers(worktreeRoot: string): FoundationCaptureProducerObservers {
  return {
    gitObserver: createNodeGitObserver(worktreeRoot, hermeticGitEnvironment(process.env)),
    pathObserver: createNodeScopePaths(),
  };
}

/**
 * Identity, not shape. The record was sealed by this daemon and is already
 * validated; what is unknown is whether the dispatch now asking is the one it
 * was sealed for. `baseIdentity` is included because the service reads it from
 * the request: a replayed base that no longer matches the sealed input would
 * otherwise capture one tree's bytes under another tree's identity.
 */
function identityFenced(
  record: FoundationCaptureContextRecord, input: Record<string, unknown>,
): boolean {
  return record.attemptId === input["attemptId"]
    && record.nodeKey === input["nodeKey"]
    && record.sessionId === input["sessionId"]
    && record.inputManifest.baseIdentity === input["baseIdentity"];
}

/**
 * The proof cannot be minted and cannot be re-derived, so it is checked instead:
 * its own seal must recompute, and every field that ties it to a workspace must
 * equal the durable record's. A proof from another attempt survives the first
 * check and fails the second, which is the case that matters.
 */
function proofBound(
  proof: FoundationPrelaunchProof, record: FoundationCaptureContextRecord,
): boolean {
  return prelaunchProofSealMatches(proof)
    && proof.baseIdentity === record.inputManifest.baseIdentity
    && proof.inputManifest.sha256 === record.inputManifest.sha256
    && proof.prelaunchObservation.sha256 === record.observation.sha256
    && proof.realRoot === record.assignment.realWorktreePath
    && sameStrings(proof.declaredScopePaths, record.catalogAuthority.declaredPaths);
}

function sameStrings(left: readonly unknown[], right: readonly unknown[]): boolean {
  const sortedLeft = [...left].map(String).sort();
  const sortedRight = [...right].map(String).sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

/**
 * A prelaunch proof is a frozen record whose seal recomputes. Checking the
 * shape before the seal keeps a hostile value from reaching `canonicalDigest`
 * as anything other than data.
 */
function provenProof(value: unknown): FoundationPrelaunchProof | null {
  if (!isRecord(value)) return null;
  const candidate = value as unknown as FoundationPrelaunchProof;
  return isRecord(candidate.inputManifest) && isRecord(candidate.prelaunchObservation)
    && typeof candidate.realRoot === "string" && typeof candidate.baseIdentity === "string"
    && Array.isArray(candidate.declaredScopePaths)
    ? candidate
    : null;
}

/**
 * Builds the port implementation `FoundationAttemptDeps.captureResult` demands.
 * Synchronous: every authority it composes is synchronous, and the service
 * awaits the answer either way.
 */
export function createFoundationCaptureProducer(
  options: FoundationCaptureProducerOptions,
): (input: Record<string, unknown>) => FoundationCaptureProducerAnswer
  | FoundationCaptureProducerRefusal {
  const { store } = options;
  const captureFs = options.captureFs ?? createNodeFoundationCaptureFs();
  const observers = options.observers ?? defaultObservers;
  const clock = options.clock ?? ((): string => new Date().toISOString());

  return function captureResult(
    rawInput: Record<string, unknown>,
  ): FoundationCaptureProducerAnswer | FoundationCaptureProducerRefusal {
    const input = exactKeys(rawInput, [...FOUNDATION_CAPTURE_PRODUCER_INPUT_KEYS]);
    if (input === null) return refuseLocal("FOUNDATION_CAPTURE_PRODUCER_INPUT_INVALID");
    const captureRef = input["captureRef"];
    if (typeof captureRef !== "string") {
      return refuseLocal("FOUNDATION_CAPTURE_PRODUCER_INPUT_INVALID");
    }

    // The durable context, read by the ref this dispatch's own preparation
    // derived. Its refusal is the READER's and crosses unrestamped.
    const read = readFoundationCaptureContext(store, captureRef);
    if (!read.ok) return refuse(read.code, read.layer);
    const { record } = read;

    if (!identityFenced(record, input)) {
      return refuseLocal("FOUNDATION_CAPTURE_PRODUCER_IDENTITY_MISMATCH");
    }
    const proof = provenProof(input["proof"]);
    if (proof === null || !proofBound(proof, record)) {
      return refuseLocal("FOUNDATION_CAPTURE_PRODUCER_PROOF_UNBOUND");
    }

    const { gitObserver, pathObserver } = observers(record.assignment.realWorktreePath);
    const captured = captureFoundationWorkspaceDelta({
      fs: captureFs, gitObserver, limits: DEFAULT_FOUNDATION_CAPTURE_LIMITS,
      observedAt: clock(), observerVersion: OBSERVER_VERSION, pathObserver, proof,
    });
    // The runner decided; this module carries its code and its layer verbatim.
    if (!captured.ok) return refuse(captured.code, captured.layer);

    // EXACTLY the daemon's CAPTURE_KEYS. `declaredArtifactRefs` is the runner's
    // own closed M1 pin, forwarded rather than re-pinned here: a second literal
    // would be a second thing to drift.
    const { core } = captured;
    return Object.freeze({
      authoredPaths: core.authoredPaths,
      declaredArtifactRefs: core.declaredArtifactRefs,
      resultTreeEntries: core.resultTreeEntries,
      scopeObservation: core.scopeObservation,
    });
  };
}
