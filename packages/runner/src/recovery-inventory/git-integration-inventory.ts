import { canonicalDigest } from "../canonical.js";
import type { ObservationClock } from "../providers/claude/claude-observation.js";
import { isUnresolvedHeadFailure } from "../scope/scope-git-classify.js";
import {
  ScopeObserverError,
  type GitObserver,
  type GitRefListing,
  type GitRefObservation,
  type RunnerScopeErrorCode,
  type ScopeObserverLayer,
} from "../scope/scope-contract.js";
import type {
  RecoveryInventoryEnumerationContext,
  RecoveryInventoryItem,
  RecoveryInventoryPortReading,
  RecoveryInventoryRegistration,
} from "./recovery-inventory-contract.js";
import { compareCodePoints, identityKey } from "./recovery-inventory-shape.js";

/**
 * Recovery-window enumerator for the GIT_INTEGRATION_ON_DISK class.
 *
 * Composes the shipped hermetic observer and adds no git of its own: refs from
 * `listRefs()`, the integration targets represented on disk from `submodulePaths()`
 * (mode-160000 gitlinks), and `headCommit()` for which of them the worktree sits
 * on. It never spawns a process or re-derives the ref grammar — `parseRefListing`
 * is a helper FOR `listRefs`, so calling it would duplicate landed authority.
 *
 * THREE FACTS, THREE ANSWERS: an observed repository with nothing in it is
 * COMPLETE against a negative proof digest, a path that answers with a failure is
 * UNAVAILABLE, and a record that could not be read TRUNCATES. Collapsing any two
 * is how an inventory reports "nothing to recover" for a store it never opened.
 *
 * It mints no coverage code — `collectRecoveryInventory` turns a reading into a
 * proof — but the observer's own code and boundary ride along on `refusal` so a
 * caller can still tell WHICH layer refused underneath.
 */
export const GIT_INTEGRATION_INVENTORY_VERSION = "moe-git-integration-inventory/1" as const;

const CLASS = "GIT_INTEGRATION_ON_DISK" as const;
const UNAVAILABLE: RecoveryInventoryPortReading = Object.freeze({ status: "UNAVAILABLE" as const });

/** The scope boundary's verbatim answer; `layer` is null when it named none. */
export interface GitIntegrationRefusal {
  readonly code: RunnerScopeErrorCode;
  readonly layer: ScopeObserverLayer | null;
}

export interface GitIntegrationInventoryReading {
  readonly reading: RecoveryInventoryPortReading;
  readonly refusal: GitIntegrationRefusal | null;
}

export interface GitIntegrationInventoryInput {
  readonly observer: GitObserver;
  readonly clock: ObservationClock;
}

interface Observed {
  readonly kind: "OBSERVED";
  readonly listing: GitRefListing;
  readonly head: string | null;
  readonly submodules: readonly string[];
}

type Observation =
  | { readonly kind: "UNAVAILABLE"; readonly refusal: GitIntegrationRefusal | null }
  | { readonly kind: "TRUNCATED"; readonly refusal: GitIntegrationRefusal }
  | Observed;

function refusalOf(error: unknown): GitIntegrationRefusal {
  if (error instanceof ScopeObserverError) {
    return { code: error.code, layer: error.layer ?? null };
  }
  return { code: "RUNNER_SCOPE_OBSERVATION_FAILED", layer: null };
}

/** `a\b` and `a/b` name one target, so identity, order and digest must agree. */
function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/");
}

/** Both mean "I could not finish reading"; every other code means nothing answered. */
function truncates(refusal: GitIntegrationRefusal): boolean {
  const code = refusal.code;
  return code === "RUNNER_SCOPE_STATUS_MALFORMED" || code === "RUNNER_SCOPE_OBSERVATION_OVERFLOW";
}

/**
 * `listRefs` is optional on the port, so an observer without it is UNAVAILABLE with
 * no refusal at all: undefined treated as an empty listing would report "no refs"
 * for a question that was never asked.
 */
function observe(observer: GitObserver): Observation {
  const listRefs = observer.listRefs;
  if (listRefs === undefined) {
    return { kind: "UNAVAILABLE", refusal: null };
  }
  let listing: GitRefListing;
  try {
    listing = listRefs.call(observer);
  } catch (error) {
    const refusal = refusalOf(error);
    return truncates(refusal) ? { kind: "TRUNCATED", refusal } : { kind: "UNAVAILABLE", refusal };
  }
  const head = observeHead(observer);
  if (head !== null && typeof head !== "string") {
    return { kind: "TRUNCATED", refusal: head.refusal };
  }
  try {
    return { kind: "OBSERVED", listing, head, submodules: observer.submodulePaths() };
  } catch (error) {
    return { kind: "TRUNCATED", refusal: refusalOf(error) };
  }
}

/**
 * An UNBORN HEAD IS NOT AN UNREADABLE REPOSITORY: `listRefs` already succeeded, so
 * the repository was observable and a fresh one has no commit yet.
 *
 * That reading is earned by the observer's exit status and nothing else. A
 * malformed answer, an overflow, the 30s timeout kill and an EAGAIN/ENOMEM spawn
 * fault are all records that could not be read, so they truncate: recording a
 * transient fault as `head: null` would mint a negative proof asserting a durable
 * fact about the repository that was never observed.
 */
function observeHead(observer: GitObserver): string | null | { readonly refusal: GitIntegrationRefusal } {
  try {
    return observer.headCommit();
  } catch (error) {
    return isUnresolvedHeadFailure(error) ? null : { refusal: refusalOf(error) };
  }
}

function refItem(
  ref: GitRefObservation,
  observation: Observed,
  context: RecoveryInventoryEnumerationContext,
  observedAt: string,
): RecoveryInventoryItem {
  const refName = normalizePath(ref.refName);
  const head = observation.head;
  return {
    class: CLASS,
    projectTag: context.projectTag,
    identity: { kind: "PATH", path: refName },
    observedAt,
    facts: {
      target: "REF",
      refScope: refName.startsWith("refs/remotes/") ? "REMOTE" : "LOCAL",
      targetCommit: ref.targetCommit,
      // Two booleans on purpose: "HEAD is elsewhere" and "HEAD was never
      // observed" are different dispositions and one flag would merge them.
      headObserved: head !== null,
      atHead: head !== null && head === ref.targetCommit,
    },
    sourceProofDigest: canonicalDigest({
      version: GIT_INTEGRATION_INVENTORY_VERSION,
      target: "REF",
      refName,
      targetCommit: ref.targetCommit,
      observationDigest: observation.listing.observationDigest,
    }),
  };
}

function submoduleItem(
  path: string,
  listing: GitRefListing,
  context: RecoveryInventoryEnumerationContext,
  observedAt: string,
): RecoveryInventoryItem {
  const declaredPath = normalizePath(path);
  return {
    class: CLASS,
    projectTag: context.projectTag,
    identity: { kind: "PATH", path: declaredPath },
    observedAt,
    facts: { target: "SUBMODULE", declaredPath },
    sourceProofDigest: canonicalDigest({
      version: GIT_INTEGRATION_INVENTORY_VERSION,
      target: "SUBMODULE",
      declaredPath,
      observationDigest: listing.observationDigest,
    }),
  };
}

/**
 * What makes an empty answer verifiable: the listing's own observation digest is
 * present even at zero refs, so this says "these bytes were read and this is what
 * they held" rather than "trust me, nothing exists".
 */
function observationProof(
  listing: GitRefListing,
  head: string | null,
  submodules: readonly string[],
): string {
  return canonicalDigest({
    version: GIT_INTEGRATION_INVENTORY_VERSION,
    head,
    refCount: listing.refCount,
    refObservationDigest: listing.observationDigest,
    submodules: submodules.map(normalizePath).sort(compareCodePoints),
  });
}

export function enumerateGitIntegrationInventory(
  input: GitIntegrationInventoryInput,
  context: RecoveryInventoryEnumerationContext,
): GitIntegrationInventoryReading {
  const observation = observe(input.observer);
  if (observation.kind === "UNAVAILABLE") {
    return { reading: UNAVAILABLE, refusal: observation.refusal };
  }
  if (observation.kind === "TRUNCATED") {
    return {
      reading: { status: "ENUMERATED", items: [], complete: false, negativeProofDigest: null },
      refusal: observation.refusal,
    };
  }
  const observedAt = input.clock.observedAt();
  const items: RecoveryInventoryItem[] = observation.listing.refs.map((ref) =>
    refItem(ref, observation, context, observedAt),
  );
  for (const path of observation.submodules) {
    items.push(submoduleItem(path, observation.listing, context, observedAt));
  }
  // Code points, never localeCompare: an order that depends on the host's
  // collation makes the observation depend on the machine that produced it.
  items.sort((left, right) => compareCodePoints(identityKey(left.identity), identityKey(right.identity)));
  return {
    reading: {
      status: "ENUMERATED",
      items,
      complete: true,
      negativeProofDigest: observationProof(observation.listing, observation.head, observation.submodules),
    },
    refusal: null,
  };
}

/**
 * A factory for the same reason as the sibling slices: a module-global
 * registration is the order-dependent coupling the aggregate refused.
 */
export function gitIntegrationInventoryRegistration(
  input: GitIntegrationInventoryInput,
): RecoveryInventoryRegistration {
  return Object.freeze({
    class: CLASS,
    enumerate: (context: RecoveryInventoryEnumerationContext) =>
      enumerateGitIntegrationInventory(input, context).reading,
  });
}
