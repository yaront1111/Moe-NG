import { refRejection, type ArtifactRef } from "../artifacts/artifact-contract.js";
import { canonicalDigest, deepFreeze, isPlainRecord } from "../canonical.js";
import { scopeObservationDigestInput, type ScopeObservation } from "../scope/scope-contract.js";
import {
  baseIdentityRejection,
  inputManifestDigestInput,
  isContainedBy,
  isWorkspaceFailure,
  MAX_WORKSPACE_ENTRIES,
  normalizeProducer,
  resultManifestDigestInput,
  workspaceFailure,
  workspacePathRejection,
  WORKSPACE_INPUT_MANIFEST_VERSION,
  WORKSPACE_RESULT_MANIFEST_VERSION,
  bytesRejection,
  type BuildInputManifestInput,
  type BuildInputManifestResult,
  type BuildResultManifestInput,
  type BuildResultManifestResult,
  type WorkspaceFailure,
  type WorkspaceInputEntry,
  type WorkspaceInputManifest,
  type WorkspaceTreeEntry,
} from "./workspace-contract.js";
import { resultEntryRejection } from "./workspace-result-rules.js";

/** Case folding is checked too: two paths that a filesystem could merge are one path. */
class PathSet {
  private readonly exact = new Set<string>();
  private readonly folded = new Set<string>();

  add(path: string): WorkspaceFailure | null {
    const lowered = path.toLowerCase();
    if (this.exact.has(path) || this.folded.has(lowered)) {
      return workspaceFailure(
        "RUNNER_WORKSPACE_ENTRY_DUPLICATE",
        `path ${JSON.stringify(path)} is declared more than once`,
        path,
      );
    }
    this.exact.add(path);
    this.folded.add(lowered);
    return null;
  }

  get values(): ReadonlySet<string> {
    return this.exact;
  }
}

const byPath = (left: { path: string }, right: { path: string }): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/**
 * Builds the digest-bound input tree an attempt starts from.
 *
 * Every entry names the producer that authored its bytes, because a digest is
 * one-way: nothing downstream could ever recover which attempt, epoch, or
 * adoption an inherited path came from if this manifest did not carry it.
 */
export function buildInputManifest(input: BuildInputManifestInput): BuildInputManifestResult {
  const baseFailure = baseIdentityRejection(input.baseIdentity);
  if (baseFailure !== null) {
    return baseFailure;
  }
  if (input.entries.length > MAX_WORKSPACE_ENTRIES) {
    return workspaceFailure("RUNNER_WORKSPACE_ENTRY_LIMIT", `input tree exceeds ${MAX_WORKSPACE_ENTRIES} entries`);
  }
  const declared = new PathSet();
  const entries: WorkspaceInputEntry[] = [];
  for (const entry of input.entries) {
    if (!isPlainRecord(entry)) {
      return workspaceFailure("RUNNER_WORKSPACE_PATH_NOT_CANONICAL", "input entry must be a record");
    }
    const pathFailure = workspacePathRejection(entry.path);
    if (pathFailure !== null) {
      return pathFailure;
    }
    const bytesFailure = bytesRejection(entry.sha256, entry.byteLength, entry.path);
    if (bytesFailure !== null) {
      return bytesFailure;
    }
    const producer = normalizeProducer(entry.producer);
    if (producer === null) {
      return workspaceFailure(
        "RUNNER_WORKSPACE_PRODUCER_INVALID",
        `entry ${JSON.stringify(entry.path)} has no valid producer identity`,
        entry.path,
      );
    }
    const duplicate = declared.add(entry.path);
    if (duplicate !== null) {
      return duplicate;
    }
    entries.push({ path: entry.path, sha256: entry.sha256, byteLength: entry.byteLength, producer });
  }
  entries.sort(byPath);
  const body = {
    manifestVersion: WORKSPACE_INPUT_MANIFEST_VERSION,
    baseIdentity: input.baseIdentity,
    entries,
  };
  const manifest: WorkspaceInputManifest = deepFreeze({
    ...body,
    sha256: canonicalDigest(inputManifestDigestInput(body)),
  });
  return Object.freeze({ ok: true as const, manifest });
}

/** A record that cannot even be canonically serialized is unsealed, never trusted. */
function sealMatches(body: Record<string, unknown>, sha256: string): boolean {
  try {
    return canonicalDigest(body) === sha256;
  } catch {
    return false;
  }
}

function isSealedInput(manifest: WorkspaceInputManifest): boolean {
  return sealMatches(inputManifestDigestInput(manifest), manifest.sha256);
}

function isSealedObservation(observation: ScopeObservation): boolean {
  return sealMatches(scopeObservationDigestInput(observation), observation.sha256);
}

function canonicalAuthoredPaths(
  authoredPaths: readonly string[],
  observation: ScopeObservation,
  inheritedPaths: readonly string[],
): PathSet | WorkspaceFailure {
  const declared = new PathSet();
  for (const path of authoredPaths) {
    const pathFailure = workspacePathRejection(path);
    if (pathFailure !== null) {
      return pathFailure;
    }
    const duplicate = declared.add(path);
    if (duplicate !== null) {
      return duplicate;
    }
    // Two declarations one filesystem could merge are one path, so an authored
    // path that folds onto a different inherited path is refused outright.
    const collision = inheritedPaths.find(
      (inherited) => inherited !== path && inherited.toLowerCase() === path.toLowerCase(),
    );
    if (collision !== undefined) {
      return workspaceFailure(
        "RUNNER_WORKSPACE_ENTRY_DUPLICATE",
        `authored path ${JSON.stringify(path)} collides case-insensitively with inherited ${JSON.stringify(collision)}`,
        path,
      );
    }
    if (!observation.canonicalEntries.some((entry) => isContainedBy(entry.path, path))) {
      return workspaceFailure(
        "RUNNER_WORKSPACE_AUTHORED_PATH_OUT_OF_SCOPE",
        `authored path ${JSON.stringify(path)} lies outside every declared scope path`,
        path,
      );
    }
  }
  return declared;
}

function canonicalArtifactRefs(refs: readonly ArtifactRef[]): readonly ArtifactRef[] | WorkspaceFailure {
  const canonical: ArtifactRef[] = [];
  for (const ref of refs) {
    if (!isPlainRecord(ref)) {
      return workspaceFailure("RUNNER_WORKSPACE_ARTIFACT_REF_INVALID", "artifact reference must be a record");
    }
    const rejection = refRejection(ref);
    if (rejection !== null) {
      return workspaceFailure("RUNNER_WORKSPACE_ARTIFACT_REF_INVALID", rejection);
    }
    canonical.push({ sha256: ref.sha256, byteLength: ref.byteLength });
  }
  return canonical.sort((left, right) =>
    left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : left.byteLength - right.byteLength,
  );
}

/**
 * Builds the digest-bound result tree, splitting inherited bytes from authored
 * ones and refusing anything with no declared producer. The serialized bytes
 * embed both upstream digests, so the base, the scope observation, and the whole
 * input tree are transitively bound into this manifest's digest.
 */
export function buildResultManifest(input: BuildResultManifestInput): BuildResultManifestResult {
  const { inputManifest, scopeObservation } = input;
  if (!isSealedInput(inputManifest)) {
    return workspaceFailure("RUNNER_WORKSPACE_INPUT_MANIFEST_INVALID", "input manifest digest does not recompute");
  }
  if (!isSealedObservation(scopeObservation)) {
    return workspaceFailure(
      "RUNNER_WORKSPACE_SCOPE_OBSERVATION_INVALID",
      "scope observation digest does not recompute",
    );
  }
  if (inputManifest.baseIdentity !== scopeObservation.baseIdentity) {
    return workspaceFailure(
      "RUNNER_WORKSPACE_BASE_MISMATCH",
      `input manifest base ${inputManifest.baseIdentity} does not match observed base ${scopeObservation.baseIdentity}`,
    );
  }
  const authored = canonicalAuthoredPaths(
    input.authoredPaths,
    scopeObservation,
    inputManifest.entries.map((entry) => entry.path),
  );
  if (isWorkspaceFailure(authored)) {
    return authored;
  }
  const declaredArtifactRefs = canonicalArtifactRefs(input.declaredArtifactRefs);
  if (isWorkspaceFailure(declaredArtifactRefs)) {
    return declaredArtifactRefs;
  }
  const split = splitResultEntries(input, authored.values);
  if (isWorkspaceFailure(split)) {
    return split;
  }
  const body = {
    manifestVersion: WORKSPACE_RESULT_MANIFEST_VERSION,
    baseIdentity: inputManifest.baseIdentity,
    inputManifestSha256: inputManifest.sha256,
    scopeObservationSha256: scopeObservation.sha256,
    authoredPaths: [...authored.values].sort(),
    inheritedEntries: split.inherited,
    authoredEntries: split.authored,
    declaredArtifactRefs,
  };
  return Object.freeze({
    ok: true as const,
    manifest: deepFreeze({ ...body, sha256: canonicalDigest(resultManifestDigestInput(body)) }),
  });
}

interface ResultSplit {
  readonly inherited: readonly WorkspaceTreeEntry[];
  readonly authored: readonly WorkspaceTreeEntry[];
}

function splitResultEntries(
  input: BuildResultManifestInput,
  authoredPaths: ReadonlySet<string>,
): ResultSplit | WorkspaceFailure {
  if (input.resultTreeEntries.length > MAX_WORKSPACE_ENTRIES) {
    return workspaceFailure("RUNNER_WORKSPACE_ENTRY_LIMIT", `result tree exceeds ${MAX_WORKSPACE_ENTRIES} entries`);
  }
  // Shapes are checked before the sort, because the comparator reads `path`.
  if (input.resultTreeEntries.some((entry) => !isPlainRecord(entry))) {
    return workspaceFailure("RUNNER_WORKSPACE_PATH_NOT_CANONICAL", "result entry must be a record");
  }
  const inputByPath = new Map(input.inputManifest.entries.map((entry) => [entry.path, entry] as const));
  const context = { scopeObservation: input.scopeObservation, authoredPaths, inputByPath };
  const seen = new PathSet();
  const inherited: WorkspaceTreeEntry[] = [];
  const authoredEntries: WorkspaceTreeEntry[] = [];
  for (const entry of [...input.resultTreeEntries].sort(byPath)) {
    const rejection = resultEntryRejection(entry, context);
    if (rejection !== null) {
      return rejection;
    }
    const duplicate = seen.add(entry.path);
    if (duplicate !== null) {
      return duplicate;
    }
    const tree = entry.origin === "AUTHORED" ? authoredEntries : inherited;
    tree.push({ path: entry.path, sha256: entry.sha256, byteLength: entry.byteLength });
  }
  return { inherited, authored: authoredEntries };
}
