import { snapshotProjectState } from "@moe/core";
import { createNodeGitObserver, createNodeScopePaths, hermeticGitEnvironment } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { readCurrentActiveGraph } from "../planning/active-graph-projection.js";
import { foundationAttemptRefusal } from "./foundation-attempt-contracts.js";
import type { FoundationAttemptRefused } from "./foundation-attempt-contracts.js";
import type { FoundationCaptureObservers } from "./foundation-capture-lifecycle.js";
import { hydrateFoundationInputManifest } from "./foundation-input-hydrator.js";
import {
  decodeFoundationRepositoryScopeCatalog, resolveFoundationRepositoryScope,
} from "./foundation-repository-scope-authority.js";
import type { FoundationRepositoryScopeAuthority } from "./foundation-repository-scope-contracts.js";

/**
 * The two facts `foundation.dispatch` may not take from its caller.
 *
 * The command entry used to forward the caller's `graphSnapshot` and `inputManifest`
 * straight into the attempt service, which made the caller the authority on which graph
 * is current and what the workspace contained. Both are now READ from the server's own
 * durable world: the ACTIVE graph revision through the projection task-dd4ffa0c landed,
 * and the workspace manifest through the hydrator task-a3e8a02d landed, over the host
 * paths the daemon-startup repository scope catalog names.
 *
 * EVERY REFUSAL TRAVELS UNRESTAMPED. A projection or hydrator refusal keeps its own code
 * AND its own layer, because flattening them to one derivation code would erase which
 * authority actually refused — the exact defect epic rail 6 exists to catch. This module
 * stamps only the refusals it genuinely owns, and they are all configuration or durable
 * state facts no other layer can answer.
 *
 * `launchTemplate` is deliberately NOT derived here: it stays caller-proposed and codec-
 * bounded until task-9a1eb61d lands the server-side launch-template producer.
 */

/** This module's own refusals — configuration and durable-state facts it alone reads. */
export const FOUNDATION_DISPATCH_DERIVATION_CODES = Object.freeze([
  "FOUNDATION_DISPATCH_CATALOG_CONFIG_ABSENT",
  "FOUNDATION_DISPATCH_CATALOG_CONFIG_UNREADABLE",
  "FOUNDATION_DISPATCH_PROJECT_STATE_ABSENT",
  "FOUNDATION_DISPATCH_PROJECT_STATE_INVALID",
  "FOUNDATION_DISPATCH_REPOSITORY_OBSERVATION_ABSENT",
] as const);
export type FoundationDispatchDerivationCode =
  (typeof FOUNDATION_DISPATCH_DERIVATION_CODES)[number];

export const FOUNDATION_DISPATCH_DERIVATION_LAYER = "DAEMON_FOUNDATION_DISPATCH_DERIVATION";

/**
 * Named distinctly from the capture lifecycle's `moe-daemon-foundation-input/1`: this
 * observation is taken at DISPATCH time over the source repository, not at capture time
 * over a materialized worktree, and a manifest should say which observer sealed it. The
 * lifecycle's constant is module-private, so sharing a literal would only invite drift.
 */
export const FOUNDATION_DISPATCH_OBSERVER_VERSION = "moe-daemon-foundation-dispatch/1";

export interface FoundationDispatchDerivationDeps {
  /** Read lazily, exactly as the capture lifecycle reads it: an absent catalog must
   *  refuse this dispatch, never fail daemon boot. */
  readonly catalogSource: () => unknown;
  readonly clock?: () => string;
  readonly observers?: (worktreeRoot: string) => FoundationCaptureObservers;
  /** Server-derived, from the AUTHENTICATED principal — never from the payload. */
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

/** The codec's exact input-manifest shape: the sealed manifest carries `manifestVersion`
 *  and `sha256` as well, and `FOUNDATION_ATTEMPT_INPUT_KEYS` admits exactly these two. */
export interface DerivedInputManifest {
  readonly baseIdentity: string;
  readonly entries: readonly unknown[];
}

export interface FoundationDispatchProvenance {
  readonly graphContentHash: string;
  readonly graphEpoch: number;
  readonly revisionId: string;
}

export interface FoundationDispatchFacts {
  readonly graphSnapshot: unknown;
  readonly inputManifest: DerivedInputManifest;
  readonly ok: true;
  readonly provenance: FoundationDispatchProvenance;
}

export type FoundationDispatchDerivationResult = FoundationAttemptRefused | FoundationDispatchFacts;

const refuse = (code: FoundationDispatchDerivationCode): FoundationAttemptRefused =>
  foundationAttemptRefusal(code, FOUNDATION_DISPATCH_DERIVATION_LAYER);

function defaultObservers(worktreeRoot: string): FoundationCaptureObservers {
  return {
    gitObserver: createNodeGitObserver(worktreeRoot, hermeticGitEnvironment(process.env)),
    pathObserver: createNodeScopePaths(),
  };
}

/**
 * The scope request, built ENTIRELY from durable state. The authority re-validates every
 * field against the same durable observation it was read from and returns the durable
 * values, so a request assembled here can only ever agree with it or expose a genuine
 * inconsistency — there is no path by which a caller value reaches this request.
 */
function resolveScope(
  deps: FoundationDispatchDerivationDeps,
): FoundationAttemptRefused | FoundationRepositoryScopeAuthority {
  let raw: unknown;
  try {
    raw = stateOf(readDurableLedger(deps.store, deps.projectId), deps.projectId);
  } catch {
    return refuse("FOUNDATION_DISPATCH_PROJECT_STATE_INVALID");
  }
  if (raw === undefined || raw === null) return refuse("FOUNDATION_DISPATCH_PROJECT_STATE_ABSENT");
  const state = snapshotProjectState(raw);
  if (state === undefined) return refuse("FOUNDATION_DISPATCH_PROJECT_STATE_INVALID");
  const current = state.repositoryObservations[state.repositoryObservations.length - 1];
  if (current === undefined) {
    return refuse("FOUNDATION_DISPATCH_REPOSITORY_OBSERVATION_ABSENT");
  }

  let configured: unknown;
  try {
    configured = deps.catalogSource();
  } catch {
    return refuse("FOUNDATION_DISPATCH_CATALOG_CONFIG_UNREADABLE");
  }
  if (configured === undefined) return refuse("FOUNDATION_DISPATCH_CATALOG_CONFIG_ABSENT");
  const decoded = decodeFoundationRepositoryScopeCatalog(configured);
  if (!decoded.ok) return foundationAttemptRefusal(decoded.code, decoded.layer);

  const resolved = resolveFoundationRepositoryScope(deps.store, decoded.catalog, {
    baseRevisionHash: current.baseRevisionHash, projectId: deps.projectId,
    repositoryRef: current.repositoryRef, scopeRef: current.scopeRef,
  });
  return resolved.ok ? resolved.authority : foundationAttemptRefusal(resolved.code, resolved.layer);
}

export function deriveFoundationDispatchFacts(
  deps: FoundationDispatchDerivationDeps,
): FoundationDispatchDerivationResult {
  const graph = readCurrentActiveGraph(deps.store, deps.projectId);
  if (!graph.ok) return foundationAttemptRefusal(graph.code, graph.layer);

  const authority = resolveScope(deps);
  if ("ok" in authority && authority.ok === false) return authority;
  const scope = authority as FoundationRepositoryScopeAuthority;

  const { gitObserver, pathObserver } = (deps.observers ?? defaultObservers)(
    scope.sourceRepositoryRoot);
  const hydrated = hydrateFoundationInputManifest({
    baseIdentity: scope.baseRevisionHash,
    declaredScopePaths: scope.declaredPaths,
    gitObserver,
    observedAt: (deps.clock ?? ((): string => new Date().toISOString()))(),
    observerVersion: FOUNDATION_DISPATCH_OBSERVER_VERSION,
    pathObserver,
    proposedEntries: [],
    worktreeRoot: scope.sourceRepositoryRoot,
  });
  if (!hydrated.ok) return hydrated;

  return Object.freeze({
    graphSnapshot: graph.snapshot,
    // Projected, not forwarded: the sealed manifest carries four keys and the attempt
    // codec admits exactly two under `exactKeys`.
    inputManifest: Object.freeze({
      baseIdentity: hydrated.manifest.baseIdentity,
      entries: Object.freeze([...hydrated.manifest.entries]),
    }),
    ok: true as const,
    provenance: Object.freeze({
      graphContentHash: graph.graphContentHash, graphEpoch: graph.graphEpoch,
      revisionId: graph.revisionId,
    }),
  });
}
