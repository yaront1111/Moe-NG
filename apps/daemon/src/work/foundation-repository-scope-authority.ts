import { isProxy } from "node:util/types";

import { snapshotProjectState } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import {
  CATALOG_KEYS, ENTRY_KEYS, FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
  FOUNDATION_REPOSITORY_SCOPE_LIMITS, REQUEST_KEYS, UNREADABLE, digestOf, entryKey,
  isDeclaredPath, isHostRoot, isRef, ownValues, refuseCatalog, refuseResolution,
} from "./foundation-repository-scope-contracts.js";
import type {
  FoundationRepositoryScopeCatalog, FoundationRepositoryScopeCatalogEntry,
  FoundationRepositoryScopeCatalogResult, FoundationRepositoryScopeRefused,
  FoundationRepositoryScopeRequest, FoundationRepositoryScopeResult,
} from "./foundation-repository-scope-contracts.js";

const ARRAY_LIMIT_EXCEEDED = Symbol("array-limit-exceeded");

/**
 * Snapshots an untrusted array without reading `length` or an indexed value
 * through ordinary property access. This keeps nested accessors and Proxy
 * `get` traps outside the authority boundary while bounding work before any
 * element descriptors are copied.
 */
function ownArrayValues(
  value: unknown,
  limit: number,
): readonly unknown[] | typeof ARRAY_LIMIT_EXCEEDED | typeof UNREADABLE | null {
  try {
    if (value === null || typeof value !== "object") return null;
    if (isProxy(value)) return UNREADABLE;
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) return UNREADABLE;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0) return null;
    if (length > limit) return ARRAY_LIMIT_EXCEEDED;

    const expectedKeys = new Set<string>(["length"]);
    for (let index = 0; index < length; index += 1) expectedKeys.add(String(index));
    const actualKeys = Reflect.ownKeys(value);
    if (actualKeys.length !== expectedKeys.size
      || actualKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
      return null;
    }

    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return UNREADABLE;
      if (descriptor.enumerable !== true) return null;
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    return UNREADABLE;
  }
}

/**
 * The server-owned resolver from a durable (projectId, repositoryRef, scopeRef)
 * identity to the host workspace configuration that identity names.
 *
 * THE DURABLE WORLD CARRIES NO HOST PATHS BY DESIGN: `RepositoryObservation`
 * stores opaque refs and project configuration is path-neutral. The mapping
 * therefore lives in daemon-STARTUP configuration — bounded, versioned and
 * digest-sealed — and this module is the only thing allowed to read it.
 */

function decodeEntry(
  value: unknown,
): FoundationRepositoryScopeCatalogEntry | FoundationRepositoryScopeRefused {
  const own = ownValues(value, ENTRY_KEYS);
  if (own === null) return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_ENTRY_MALFORMED");
  if (own === UNREADABLE) return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_CATALOG_ACCESSOR");
  const limits = FOUNDATION_REPOSITORY_SCOPE_LIMITS;
  const projectId = own["projectId"], repositoryRef = own["repositoryRef"];
  const scopeRef = own["scopeRef"], raw = own["declaredPaths"];
  const capturedPaths = ownArrayValues(raw, FOUNDATION_REPOSITORY_SCOPE_LIMITS.declaredPaths);
  if (!isRef(projectId, limits.refChars) || !isRef(repositoryRef, limits.refChars)
    || !isRef(scopeRef, limits.refChars) || capturedPaths === null
    || (Array.isArray(capturedPaths) && capturedPaths.length === 0)) {
    return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_ENTRY_MALFORMED");
  }
  if (capturedPaths === UNREADABLE) {
    return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_CATALOG_ACCESSOR");
  }
  if (capturedPaths === ARRAY_LIMIT_EXCEEDED) {
    return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_LIMIT_EXCEEDED");
  }
  const declaredPaths: string[] = [];
  for (const path of capturedPaths) {
    if (!isDeclaredPath(path)) {
      return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_PATH_NONCANONICAL");
    }
    declaredPaths.push(path);
  }
  declaredPaths.sort();
  // Case-folded, because this host's filesystem cannot tell the pair apart and
  // would hand two declarations the same bytes.
  if (new Set(declaredPaths.map((path) => path.toLowerCase())).size !== declaredPaths.length) {
    return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_PATH_CASE_COLLISION");
  }
  const sourceRepositoryRoot = own["sourceRepositoryRoot"], worktreeParent = own["worktreeParent"];
  if (!isHostRoot(sourceRepositoryRoot) || !isHostRoot(worktreeParent)) {
    return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_HOST_ROOT_INVALID");
  }
  return Object.freeze({
    declaredPaths: Object.freeze(declaredPaths), projectId, repositoryRef, scopeRef,
    sourceRepositoryRoot, worktreeParent,
  });
}

export function decodeFoundationRepositoryScopeCatalog(
  input: unknown,
): FoundationRepositoryScopeCatalogResult {
  const outer = ownValues(input, CATALOG_KEYS);
  if (outer === null) return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_CATALOG_MALFORMED");
  if (outer === UNREADABLE) return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_CATALOG_ACCESSOR");
  if (outer["catalogVersion"] !== FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION) {
    return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION_UNSUPPORTED");
  }
  const raw = outer["entries"];
  const capturedEntries = ownArrayValues(raw, FOUNDATION_REPOSITORY_SCOPE_LIMITS.entries);
  if (capturedEntries === null
    || (Array.isArray(capturedEntries) && capturedEntries.length === 0)) {
    return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_CATALOG_MALFORMED");
  }
  if (capturedEntries === UNREADABLE) {
    return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_CATALOG_ACCESSOR");
  }
  if (capturedEntries === ARRAY_LIMIT_EXCEEDED) {
    return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_LIMIT_EXCEEDED");
  }
  const entries: FoundationRepositoryScopeCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of capturedEntries) {
    const entry = decodeEntry(candidate);
    if ("ok" in entry) return entry;
    if (seen.has(entryKey(entry))) {
      return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_ENTRY_DUPLICATE");
    }
    seen.add(entryKey(entry));
    entries.push(entry);
  }
  // Sorted by the whole key so the digest is a function of the admitted SET, not
  // of the order an operator happened to write the file in.
  entries.sort((left, right) => entryKey(left) < entryKey(right) ? -1 : 1);
  const catalogVersion = FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION;
  return Object.freeze({
    catalog: Object.freeze({
      catalogVersion, digest: digestOf({ catalogVersion, entries }),
      entries: Object.freeze(entries),
    }),
    ok: true as const,
  });
}

/** A store that cannot be read is UNKNOWN here, never an absent project. */
function readProjectState(store: SqliteEventStore, projectId: string): unknown {
  try {
    return stateOf(readDurableLedger(store, projectId), projectId);
  } catch { return UNREADABLE; }
}

export type FoundationCurrentRepositoryScopeRequestResult =
  | Readonly<{ readonly ok: true; readonly request: FoundationRepositoryScopeRequest }>
  | FoundationRepositoryScopeRefused;

/**
 * Derives the repository identity the project is bound to NOW, without accepting
 * any repository, scope or revision proposal from a caller. Consumers still pass
 * the returned request through `resolveFoundationRepositoryScope`: that second
 * durable read is the optimistic currentness fence immediately before they use
 * the resolved host authority.
 */
export function readCurrentFoundationRepositoryScopeRequest(
  store: SqliteEventStore,
  projectId: string,
): FoundationCurrentRepositoryScopeRequestResult {
  if (!isRef(projectId, FOUNDATION_REPOSITORY_SCOPE_LIMITS.refChars)) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_REQUEST_MALFORMED");
  }
  const raw = readProjectState(store, projectId);
  if (raw === UNREADABLE) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_UNREADABLE");
  }
  if (raw === undefined || raw === null) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_ABSENT");
  }
  const state = snapshotProjectState(raw);
  if (state === undefined) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_INVALID");
  }
  if (state.projectId !== projectId) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_PROJECT_MISMATCH");
  }
  const current = state.repositoryObservations[state.repositoryObservations.length - 1];
  if (current === undefined) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_OBSERVATION_ABSENT");
  }
  return Object.freeze({
    ok: true as const,
    request: Object.freeze({
      baseRevisionHash: current.baseRevisionHash,
      projectId: state.projectId,
      repositoryRef: current.repositoryRef,
      scopeRef: current.scopeRef,
    }),
  });
}

/**
 * Resolves the bound project's CURRENT repository observation to host facts.
 *
 * The FINAL `repositoryObservations` entry is current by explicit product
 * decision for this append-only M1 state: the reducer appends, so the last entry
 * is the most recent bind. An older match is never selected and observations are
 * never merged — either the request names what the project is bound to now, or
 * it is refused.
 *
 * Durable bytes are RE-VALIDATED here. `stateOf` returns raw `JsonValue` and the
 * bind handler casts unchecked, so corrupt ledger bytes reach this point looking
 * like state; `snapshotProjectState` is the production validator that says
 * otherwise, and its refusal is a refusal rather than a fallback.
 */
export function resolveFoundationRepositoryScope(
  store: SqliteEventStore,
  catalog: FoundationRepositoryScopeCatalog,
  request: unknown,
): FoundationRepositoryScopeResult {
  const own = ownValues(request, REQUEST_KEYS);
  if (own === null || own === UNREADABLE) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_REQUEST_MALFORMED");
  }
  const limit = FOUNDATION_REPOSITORY_SCOPE_LIMITS.refChars;
  const projectId = own["projectId"], repositoryRef = own["repositoryRef"];
  const scopeRef = own["scopeRef"], baseRevisionHash = own["baseRevisionHash"];
  if (!isRef(projectId, limit) || !isRef(repositoryRef, limit) || !isRef(scopeRef, limit)
    || !isRef(baseRevisionHash, limit)) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_REQUEST_MALFORMED");
  }
  if (digestOf(catalog) !== catalog.digest) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_CATALOG_DIGEST_MISMATCH");
  }
  const raw = readProjectState(store, projectId);
  if (raw === UNREADABLE) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_UNREADABLE");
  }
  if (raw === undefined || raw === null) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_ABSENT");
  }
  const state = snapshotProjectState(raw);
  if (state === undefined) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_INVALID");
  }
  if (state.projectId !== projectId) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_PROJECT_MISMATCH");
  }
  const current = state.repositoryObservations[state.repositoryObservations.length - 1];
  if (current === undefined) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_OBSERVATION_ABSENT");
  }
  if (current.repositoryRef !== repositoryRef) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_REPOSITORY_MISMATCH");
  }
  if (current.scopeRef !== scopeRef) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_SCOPE_MISMATCH");
  }
  if (current.baseRevisionHash !== baseRevisionHash) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_BASE_REVISION_MISMATCH");
  }
  const matches = catalog.entries.filter((candidate) => candidate.projectId === projectId
    && candidate.repositoryRef === repositoryRef && candidate.scopeRef === scopeRef);
  const entry = matches[0];
  if (entry === undefined) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_ENTRY_ABSENT");
  }
  // A catalog assembled without the codec can still carry a duplicate triple.
  // Taking the first match would let the later entry lose in silence, which is
  // the ambiguity this authority exists to refuse rather than to break.
  if (matches.length > 1) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_ENTRY_DUPLICATE");
  }
  // Re-fenced at the point of RETURN. `digestOf` is published, so a caller that
  // hand-assembled a catalog can seal it; the seal proves internal consistency,
  // never canonicality. This is what makes the returned paths canonical BY
  // CONSTRUCTION instead of by trusting that the codec was the one who built it.
  if (!isHostRoot(entry.sourceRepositoryRoot) || !isHostRoot(entry.worktreeParent)) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_HOST_ROOT_INVALID");
  }
  if (!entry.declaredPaths.every(isDeclaredPath)) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_PATH_NONCANONICAL");
  }
  return Object.freeze({
    authority: Object.freeze({
      baseRevisionHash: current.baseRevisionHash, catalogDigest: catalog.digest,
      declaredPaths: entry.declaredPaths, projectId: state.projectId,
      repositoryRef: current.repositoryRef, scopeRef: current.scopeRef,
      sourceRepositoryRoot: entry.sourceRepositoryRoot, worktreeParent: entry.worktreeParent,
    }),
    ok: true as const,
  });
}
