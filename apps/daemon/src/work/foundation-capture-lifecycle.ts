import { readFileSync, statSync } from "node:fs";

import {
  DEFAULT_FOUNDATION_CAPTURE_LIMITS, createNodeFoundationCaptureFs, createNodeGitObserver,
  createNodeScopePaths, createNodeWorktreeMaterializer, hermeticGitEnvironment,
  proveFoundationPrelaunchTree,
} from "@moe/runner";
import type {
  FoundationCaptureFsPort, FoundationPrelaunchProof, GitObserver, ScopeObservation,
  ScopePathObserver, WorkspaceInputManifest, WorktreeAssignment, WorktreeMaterializer,
  WorktreeReleaseRequest, WorktreeReleaseResult,
} from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import { DAEMON_FOUNDATION_CAPTURE } from "./foundation-capture-context-contract.js";
import type { FoundationCaptureContextRecord } from "./foundation-capture-context-contract.js";
import { deriveFoundationCaptureContextRecordDigest } from "./foundation-capture-context-contract.js";
import {
  commitFoundationCaptureContext, deriveFoundationCaptureRef, readFoundationCaptureContext,
} from "./foundation-capture-context-ledger.js";
import { hydrateFoundationInputManifest } from "./foundation-input-hydrator.js";
import {
  decodeFoundationRepositoryScopeCatalog, resolveFoundationRepositoryScope,
} from "./foundation-repository-scope-authority.js";
import type {
  FoundationRepositoryScopeAuthority, FoundationRepositoryScopeCatalogEntry,
} from "./foundation-repository-scope-contracts.js";

/**
 * The one place the five landed Foundation authorities are composed, at the one
 * safe point: after durable reservation/replay discrimination and BEFORE any
 * provider process exists.
 *
 * ORDER IS THE SECURITY PROPERTY, not an implementation detail. Resolve the
 * durable catalog authority, materialize the detached tree at the observed base,
 * hydrate the real bytes under the catalog's declared scopes, prove the caller's
 * proposals agree, prove the tree clean, and only then commit the durable
 * context. Nothing here launches; a caller that moved preparation after a launch
 * would be capturing bytes a provider had already touched.
 *
 * A CALLER PROPOSAL CAN REFUSE BUT CAN NEVER SELECT. `proposedCwd` and
 * `proposedEntries` are compared against authority that was derived without
 * them; a disagreement stops the attempt. Neither can choose a root, a scope or
 * a sealed input.
 *
 * THE LAYER STAMP IS IMPORTED, NOT REDECLARED. `DAEMON_FOUNDATION_CAPTURE`
 * already exists on the capture-context contract, deliberately unsuffixed so the
 * daemon security scanner does not read it as a public boundary owing a roster
 * row. A second literal with the same value would be a second thing that drifts.
 */

/** Closed, and this module's OWN: the context codec's nine codes are a landed
 *  vocabulary this task does not own and may not extend. */
export const FOUNDATION_CAPTURE_LIFECYCLE_CODES = Object.freeze([
  "FOUNDATION_CAPTURE_CATALOG_CONFIG_ABSENT",
  "FOUNDATION_CAPTURE_CATALOG_CONFIG_UNREADABLE",
  "FOUNDATION_CAPTURE_CATALOG_ENTRY_ABSENT",
  "FOUNDATION_CAPTURE_CATALOG_ENTRY_AMBIGUOUS",
  "FOUNDATION_CAPTURE_PREPARATION_DIVERGED",
  "FOUNDATION_CAPTURE_SLOT_MALFORMED",
  "FOUNDATION_CAPTURE_WORKSPACE_MISMATCH",
] as const);

export type FoundationCaptureLifecycleCode = (typeof FOUNDATION_CAPTURE_LIFECYCLE_CODES)[number];

/**
 * `code` and `layer` are plain strings because an UPSTREAM refusal crosses this
 * boundary verbatim: narrowing them to this module's own vocabulary would force
 * a restamp, and a restamped refusal hides which authority actually said no.
 */
export interface FoundationCaptureLifecycleRefusal {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
}

export interface PreparedCapture {
  readonly assignment: WorktreeAssignment;
  readonly captureRef: string;
  readonly disposition: "COMMITTED" | "REPLAYED";
  readonly inputManifest: WorkspaceInputManifest;
  readonly observation: ScopeObservation;
  readonly ok: true;
  /** Null on a REPLAYED answer: the proof is not a field of the durable record,
   *  and re-deriving one would mean re-scanning a tree already proven. */
  readonly proof: FoundationPrelaunchProof | null;
  readonly record: FoundationCaptureContextRecord;
}

export type PrepareCaptureResult = FoundationCaptureLifecycleRefusal | PreparedCapture;

export interface PrepareCaptureInput {
  readonly attemptAggregateId: string;
  readonly attemptId: string;
  readonly nodeKey: string;
  readonly projectId: string;
  /** A proposal, checked against the durable current observation. */
  readonly proposedBaseIdentity: string;
  /** A proposal, checked against the assigned root. Never a selector. */
  readonly proposedCwd: string | null;
  /** Proposals, checked against the hydrated bytes. Never a selector. */
  readonly proposedEntries: readonly unknown[];
  readonly requestDigest: string;
  readonly reservationDigest: string;
  readonly sessionId: string;
}

export interface FoundationCaptureLifecycle {
  prepareCapture(input: PrepareCaptureInput): Promise<PrepareCaptureResult>;
  releaseWorktree(request: WorktreeReleaseRequest): WorktreeReleaseResult;
}

export interface FoundationCaptureObservers {
  readonly gitObserver: GitObserver;
  readonly pathObserver: ScopePathObserver;
}

export interface FoundationCaptureLifecycleOptions {
  readonly captureFs?: FoundationCaptureFsPort;
  /** Read lazily, at prepare time: an absent catalog must never fail daemon boot. */
  readonly catalogSource: () => unknown;
  readonly clock?: () => string;
  readonly materializer?: WorktreeMaterializer;
  readonly observers?: (worktreeRoot: string) => FoundationCaptureObservers;
  readonly store: SqliteEventStore;
}

const OBSERVER_VERSION = "moe-daemon-foundation-input/1";

/** Published so the store provider names the same key this reader reads; two
 *  hand-written copies of an env key drift in exactly one direction. */
export const FOUNDATION_WORKSPACE_CATALOG_ENV_KEY = "MOE_FOUNDATION_WORKSPACE_CATALOG";
const MAX_CATALOG_BYTES = 1_048_576;
const HEX_64 = /^[0-9a-f]{64}$/u;

const refuse = (code: string, layer: string): FoundationCaptureLifecycleRefusal =>
  Object.freeze({ code, layer, ok: false as const });

const refuseLocal = (code: FoundationCaptureLifecycleCode): FoundationCaptureLifecycleRefusal =>
  refuse(code, DAEMON_FOUNDATION_CAPTURE);

/**
 * Bounded path admission, outside the request plane. Absent reads as absent
 * rather than as a fault; an unreadable or oversized file THROWS, and the
 * lifecycle turns that throw into its own exact code at prepare time.
 */
export function readFoundationCatalogConfig(
  env: Readonly<Record<string, string | undefined>>,
): () => unknown {
  const configured = env[FOUNDATION_WORKSPACE_CATALOG_ENV_KEY];
  if (configured === undefined || configured === "") return (): unknown => undefined;
  return (): unknown => {
    // SIZE IS CHECKED BEFORE THE READ, not after. Reading first and measuring
    // second would pull an operator-sized file into memory to decide it was too
    // large — the ceiling would exist and protect nothing.
    if (statSync(configured).size > MAX_CATALOG_BYTES) {
      throw new Error("catalog exceeds its byte ceiling");
    }
    return JSON.parse(readFileSync(configured, "utf8")) as unknown;
  };
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

function admitInput(input: PrepareCaptureInput): boolean {
  return text(input.attemptAggregateId) && text(input.attemptId) && text(input.nodeKey)
    && text(input.projectId) && text(input.sessionId) && text(input.proposedBaseIdentity)
    && HEX_64.test(input.requestDigest) && HEX_64.test(input.reservationDigest)
    && Array.isArray(input.proposedEntries)
    && (input.proposedCwd === null || text(input.proposedCwd));
}

/** Segment-aware, case-folded on win32 — the same rule the materializer applies
 *  to its own paths, so a proposal is compared the way the fence compares. */
function samePath(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    const slashed = value.replace(/\\/gu, "/").replace(/\/+$/u, "");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  return canonical(left) === canonical(right);
}

/**
 * Every proposed entry must BE one of the hydrated entries, field for field. An
 * entry naming a path that was not hydrated is a disagreement too: it proposes
 * content the sealed input does not contain.
 */
function entriesAgree(
  proposed: readonly unknown[], manifest: WorkspaceInputManifest,
): boolean {
  return proposed.every((candidate) => {
    if (candidate === null || typeof candidate !== "object") return false;
    const entry = candidate as Record<string, unknown>;
    const hydrated = manifest.entries.find((known) => known.path === entry["path"]);
    return hydrated !== undefined && hydrated.sha256 === entry["sha256"]
      && hydrated.byteLength === entry["byteLength"];
  });
}

function soleEntryFor(
  entries: readonly FoundationRepositoryScopeCatalogEntry[], projectId: string,
): FoundationRepositoryScopeCatalogEntry | FoundationCaptureLifecycleRefusal {
  const matches = entries.filter((entry) => entry.projectId === projectId);
  if (matches.length === 0) return refuseLocal("FOUNDATION_CAPTURE_CATALOG_ENTRY_ABSENT");
  const [first] = matches;
  if (matches.length > 1 || first === undefined) {
    return refuseLocal("FOUNDATION_CAPTURE_CATALOG_ENTRY_AMBIGUOUS");
  }
  return first;
}

function contextCandidate(
  input: PrepareCaptureInput, authority: FoundationRepositoryScopeAuthority,
  assignment: WorktreeAssignment, manifest: WorkspaceInputManifest,
  observation: ScopeObservation, observedAt: string,
): Record<string, unknown> {
  const body = {
    artifactDeclaration: "NONE", assignment: { ...assignment },
    attemptAggregateId: input.attemptAggregateId, attemptId: input.attemptId,
    baselineDigest: manifest.sha256, catalogAuthority: { ...authority },
    inputManifest: manifest, nodeKey: input.nodeKey, observation, observedAt,
    projectId: input.projectId, recordVersion: "moe-foundation-capture-context/1",
    requestDigest: input.requestDigest, reservationDigest: input.reservationDigest,
    sessionId: input.sessionId,
  };
  return { ...body, recordDigest: deriveFoundationCaptureContextRecordDigest(body) };
}

function defaultObservers(worktreeRoot: string): FoundationCaptureObservers {
  return {
    gitObserver: createNodeGitObserver(worktreeRoot, hermeticGitEnvironment(process.env)),
    pathObserver: createNodeScopePaths(),
  };
}

export function createFoundationCaptureLifecycle(
  options: FoundationCaptureLifecycleOptions,
): FoundationCaptureLifecycle {
  const { catalogSource, store } = options;
  const captureFs = options.captureFs ?? createNodeFoundationCaptureFs();
  const clock = options.clock ?? ((): string => new Date().toISOString());
  const materializer = options.materializer ?? createNodeWorktreeMaterializer(process.env);
  const observers = options.observers ?? defaultObservers;

  /** No unowned residue: a tree materialized for an attempt that then refused is
   *  released under the same identity fence a proven settlement uses. */
  function discard(assignment: WorktreeAssignment): void {
    materializer.release({ assignment, callerIntent: "ATTEMPT_TERMINAL" });
  }

  function catalogAuthorityFor(
    input: PrepareCaptureInput,
  ): FoundationCaptureLifecycleRefusal | FoundationRepositoryScopeAuthority {
    let configured: unknown;
    try {
      configured = catalogSource();
    } catch {
      return refuseLocal("FOUNDATION_CAPTURE_CATALOG_CONFIG_UNREADABLE");
    }
    if (configured === undefined) return refuseLocal("FOUNDATION_CAPTURE_CATALOG_CONFIG_ABSENT");
    const decoded = decodeFoundationRepositoryScopeCatalog(configured);
    if (!decoded.ok) return refuse(decoded.code, decoded.layer);
    const entry = soleEntryFor(decoded.catalog.entries, input.projectId);
    if ("ok" in entry) return entry;
    const resolved = resolveFoundationRepositoryScope(store, decoded.catalog, {
      baseRevisionHash: input.proposedBaseIdentity, projectId: input.projectId,
      repositoryRef: entry.repositoryRef, scopeRef: entry.scopeRef,
    });
    return resolved.ok ? resolved.authority : refuse(resolved.code, resolved.layer);
  }

  /** The durable answer for this slot, or null when nothing is committed yet. */
  function durableAnswer(
    input: PrepareCaptureInput, captureRef: string,
  ): PrepareCaptureResult | null {
    const read = readFoundationCaptureContext(store, captureRef);
    if (!read.ok) {
      return read.code === "FOUNDATION_CAPTURE_CONTEXT_READER_ABSENT"
        ? null : refuse(read.code, read.layer);
    }
    const { record } = read;
    if (record.requestDigest !== input.requestDigest
      || record.reservationDigest !== input.reservationDigest) {
      return refuseLocal("FOUNDATION_CAPTURE_PREPARATION_DIVERGED");
    }
    return Object.freeze({
      assignment: record.assignment as unknown as WorktreeAssignment, captureRef,
      disposition: "REPLAYED" as const, inputManifest: record.inputManifest,
      observation: record.observation, ok: true as const, proof: null, record,
    });
  }

  async function prepareCapture(input: PrepareCaptureInput): Promise<PrepareCaptureResult> {
    if (!admitInput(input)) return refuseLocal("FOUNDATION_CAPTURE_SLOT_MALFORMED");
    const captureRef = deriveFoundationCaptureRef(input);
    const durable = durableAnswer(input, captureRef);
    if (durable !== null) return durable;
    const authority = catalogAuthorityFor(input);
    if ("ok" in authority) return authority;

    const materialized = materializer.materialize({
      attemptId: input.attemptId, baseIdentity: authority.baseRevisionHash,
      projectId: input.projectId, sourceRepositoryRoot: authority.sourceRepositoryRoot,
      worktreeParent: authority.worktreeParent,
    });
    if (!materialized.ok) return refuse(materialized.code, materialized.layer);
    const { assignment } = materialized;

    const observedAt = clock();
    const { gitObserver, pathObserver } = observers(assignment.realWorktreePath);
    const hydrated = hydrateFoundationInputManifest({
      baseIdentity: authority.baseRevisionHash, declaredScopePaths: authority.declaredPaths,
      gitObserver, observedAt, observerVersion: OBSERVER_VERSION, pathObserver,
      proposedEntries: input.proposedEntries, worktreeRoot: assignment.realWorktreePath,
    });
    if (!hydrated.ok) {
      discard(assignment);
      return refuse(hydrated.code, hydrated.refusedBy);
    }

    // The proposals, compared against authority derived without them.
    if ((input.proposedCwd !== null && !samePath(input.proposedCwd, assignment.realWorktreePath))
      || !entriesAgree(input.proposedEntries, hydrated.manifest)) {
      discard(assignment);
      return refuseLocal("FOUNDATION_CAPTURE_WORKSPACE_MISMATCH");
    }

    const proven = proveFoundationPrelaunchTree({
      assignedRealRoot: assignment.realWorktreePath,
      declaredScopePaths: authority.declaredPaths, fs: captureFs,
      inputManifest: hydrated.manifest, limits: DEFAULT_FOUNDATION_CAPTURE_LIMITS,
      prelaunchObservation: hydrated.observation,
    });
    if (!proven.ok) {
      discard(assignment);
      return refuse(proven.code, proven.layer);
    }

    const sealed = commitFoundationCaptureContext(store, {
      candidate: contextCandidate(
        input, authority, assignment, hydrated.manifest, hydrated.observation, observedAt),
      decidedAt: observedAt,
    });
    if (!sealed.ok) {
      discard(assignment);
      return refuse(sealed.code, sealed.layer);
    }
    return Object.freeze({
      assignment, captureRef: sealed.captureRef, disposition: sealed.disposition,
      inputManifest: hydrated.manifest, observation: hydrated.observation, ok: true as const,
      proof: proven.proof, record: sealed.record,
    });
  }

  return Object.freeze({
    prepareCapture,
    releaseWorktree: (request: WorktreeReleaseRequest): WorktreeReleaseResult =>
      materializer.release(request),
  });
}
