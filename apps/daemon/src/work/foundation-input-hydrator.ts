import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

import {
  buildInputManifest,
  MAX_SCOPE_PATHS,
  MAX_WORKSPACE_ENTRIES,
  observeScope,
  type GitObserver,
  type ScopeObservation,
  type ScopePathObserver,
  type WorkspaceInputEntry,
  type WorkspaceInputManifest,
} from "@moe/runner";

import {
  foundationAttemptRefusal,
  RUNNER_WORKSPACE_LAYER,
  type FoundationAttemptRefused,
} from "./foundation-attempt-contracts.js";
import { snapshotFoundationInputPaths } from "./foundation-input-file-snapshot.js";
import { readBoundedFoundationInputFile } from "./foundation-input-bounded-read.js";

/**
 * Foundation input authority matrix (Graph Beta, input-manifest half):
 *
 * - baseIdentity is SERVER-OBSERVED git HEAD. The caller value is only a
 *   proposal checked by observeScope; it never becomes the sealed fact.
 * - entries are SERVER-OBSERVED paths and raw filesystem bytes. proposedEntries
 *   are structurally bounded only; their element values are never inspected or
 *   sealed.
 * - producer is BASE-only in this slice. No durable per-entry PREDECESSOR source
 *   exists, so predecessor attribution must block at a future composing seam
 *   rather than being guessed here.
 *
 * Reading and hashing bytes is observation, not a second manifest authority.
 * buildInputManifest remains the only sealer. This seam accepts no grant,
 * runtime closure, slot, budget, lease, attempt, effect, or registration.
 */

const FOUNDATION_INPUT_HYDRATOR_LAYER = "DAEMON_FOUNDATION_INPUT" as const;
const RUNNER_SCOPE_LAYER = "RUNNER_SCOPE" as const;
export const MAX_FOUNDATION_INPUT_FILE_BYTES = 1_048_576;

export const FOUNDATION_INPUT_HYDRATOR_CODES = Object.freeze([
  "FOUNDATION_INPUT_ENTRY_UNREADABLE",
  "FOUNDATION_INPUT_ENTRY_TOO_LARGE",
  "FOUNDATION_INPUT_REQUEST_MALFORMED",
  "FOUNDATION_INPUT_STALE_OBSERVATION",
  "FOUNDATION_INPUT_WORKTREE_MISSING",
] as const);

export type FoundationInputHydratorCode =
  (typeof FOUNDATION_INPUT_HYDRATOR_CODES)[number];

export interface HydrateFoundationInputManifestInput {
  readonly baseIdentity: string;
  readonly declaredScopePaths: readonly string[];
  readonly gitObserver: GitObserver;
  readonly observedAt: string;
  readonly observerVersion: string;
  readonly pathObserver: ScopePathObserver;
  /** Untrusted proposal; only array shape/count are admitted, never its values. */
  readonly proposedEntries: readonly unknown[];
  readonly worktreeRoot: string;
}

export interface HydratedFoundationInputManifest {
  readonly manifest: WorkspaceInputManifest;
  readonly observation: ScopeObservation;
  readonly ok: true;
}

export type HydrateFoundationInputManifestResult =
  | FoundationAttemptRefused
  | HydratedFoundationInputManifest;

type ReadEntryResult =
  | FoundationAttemptRefused
  | { readonly entry: WorkspaceInputEntry; readonly ok: true };

const HYDRATOR_INPUT_KEYS = Object.freeze([
  "baseIdentity", "declaredScopePaths", "gitObserver", "observedAt",
  "observerVersion", "pathObserver", "proposedEntries", "worktreeRoot",
] as const);
const HYDRATOR_INPUT_KEY_SET = new Set<string>(HYDRATOR_INPUT_KEYS);

function localRefusal(code: FoundationInputHydratorCode): FoundationAttemptRefused {
  return foundationAttemptRefusal(code, FOUNDATION_INPUT_HYDRATOR_LAYER);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function snapshotArray(
  value: unknown,
  maximum: number,
  preserveOverflow: boolean,
): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) return null;
  if (length > maximum) {
    return preserveOverflow ? Object.freeze(new Array<unknown>(maximum + 1)) : null;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) return null;
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function admitInput(value: unknown): HydrateFoundationInputManifestInput | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== HYDRATOR_INPUT_KEYS.length || keys.some(
      (key) => typeof key !== "string" || !HYDRATOR_INPUT_KEY_SET.has(key),
    )) return null;
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of HYDRATOR_INPUT_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
      fields[key] = descriptor.value;
    }
    const declared = snapshotArray(fields["declaredScopePaths"], MAX_SCOPE_PATHS, true);
    const proposed = snapshotArray(fields["proposedEntries"], MAX_WORKSPACE_ENTRIES, false);
    if (declared === null || proposed === null) return null;
    if (["baseIdentity", "observedAt", "observerVersion", "worktreeRoot"].some(
      (key) => typeof fields[key] !== "string",
    )) return null;
    if (typeof fields["gitObserver"] !== "object" || fields["gitObserver"] === null
      || typeof fields["pathObserver"] !== "object" || fields["pathObserver"] === null) return null;
    return Object.freeze({
      baseIdentity: fields["baseIdentity"] as string,
      declaredScopePaths: declared as readonly string[],
      gitObserver: fields["gitObserver"] as GitObserver,
      observedAt: fields["observedAt"] as string,
      observerVersion: fields["observerVersion"] as string,
      pathObserver: fields["pathObserver"] as ScopePathObserver,
      proposedEntries: proposed,
      worktreeRoot: fields["worktreeRoot"] as string,
    });
  } catch {
    return null;
  }
}

function worktreeMissing(root: string): boolean {
  try {
    return !statSync(root).isDirectory();
  } catch (error) {
    return isMissing(error);
  }
}

function readObservedEntry(worktreeRoot: string, path: string): ReadEntryResult {
  const absolutePath = join(worktreeRoot, path);
  try {
    const read = readBoundedFoundationInputFile(
      absolutePath,
      MAX_FOUNDATION_INPUT_FILE_BYTES,
    );
    if (read.kind === "NOT_FILE") {
      return localRefusal("FOUNDATION_INPUT_ENTRY_UNREADABLE");
    }
    if (read.kind === "TOO_LARGE") {
      return localRefusal("FOUNDATION_INPUT_ENTRY_TOO_LARGE");
    }
    return Object.freeze({
      entry: Object.freeze({
        byteLength: read.bytes.byteLength,
        path,
        producer: Object.freeze({ kind: "BASE" as const }),
        sha256: createHash("sha256").update(read.bytes).digest("hex"),
      }),
      ok: true as const,
    });
  } catch (error) {
    return localRefusal(isMissing(error)
      ? "FOUNDATION_INPUT_STALE_OBSERVATION"
      : "FOUNDATION_INPUT_ENTRY_UNREADABLE");
  }
}

/** Observes workspace paths and bytes, then asks the runner to seal them. */
export function hydrateFoundationInputManifest(
  value: unknown,
): HydrateFoundationInputManifestResult {
  const input = admitInput(value);
  if (input === null) return localRefusal("FOUNDATION_INPUT_REQUEST_MALFORMED");
  if (worktreeMissing(input.worktreeRoot)) {
    return localRefusal("FOUNDATION_INPUT_WORKTREE_MISSING");
  }
  const paths = snapshotFoundationInputPaths(input.pathObserver);
  const scopeInput = {
    baseIdentity: input.baseIdentity,
    declaredScopePaths: input.declaredScopePaths,
    gitObserver: input.gitObserver,
    observedAt: input.observedAt,
    observerVersion: input.observerVersion,
    pathObserver: paths.observer,
    worktreeRoot: input.worktreeRoot,
  } as const;
  const observed = observeScope(scopeInput);
  if (!observed.ok) return foundationAttemptRefusal(observed.code, RUNNER_SCOPE_LAYER);

  const entries: WorkspaceInputEntry[] = [];
  for (const observedEntry of observed.observation.canonicalEntries) {
    const read = readObservedEntry(input.worktreeRoot, observedEntry.path);
    if (!read.ok) return read;
    if (!paths.unchanged(join(input.worktreeRoot, observedEntry.path))) {
      return localRefusal("FOUNDATION_INPUT_STALE_OBSERVATION");
    }
    entries.push(read.entry);
  }
  // Optimistic snapshot verification: the scope authority must still describe
  // the same workspace after every byte read. A changed file or swapped link
  // either changes the observation digest or makes re-observation refuse.
  const verified = observeScope(scopeInput);
  if (!verified.ok || verified.observation.sha256 !== observed.observation.sha256) {
    return localRefusal("FOUNDATION_INPUT_STALE_OBSERVATION");
  }
  const sealed = buildInputManifest({
    baseIdentity: observed.observation.baseIdentity,
    entries,
  });
  if (!sealed.ok) return foundationAttemptRefusal(sealed.code, RUNNER_WORKSPACE_LAYER);
  return Object.freeze({
    manifest: sealed.manifest,
    observation: observed.observation,
    ok: true as const,
  });
}
