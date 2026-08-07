import type { ScopeAttributionClass, ScopeObservation } from "../scope/scope-contract.js";
import {
  bytesRejection,
  isContainedBy,
  workspaceFailure,
  workspacePathRejection,
  type ResultTreeEntry,
  type WorkspaceFailure,
  type WorkspaceInputEntry,
} from "./workspace-contract.js";

export interface ResultEntryContext {
  readonly scopeObservation: ScopeObservation;
  readonly authoredPaths: ReadonlySet<string>;
  readonly inputByPath: ReadonlyMap<string, WorkspaceInputEntry>;
}

/**
 * Only a path git tracked as clean, or never reported at all, may carry result
 * bytes. Everything else is a distinct rejection: the caller must be able to
 * tell "someone else edited this" from "git could not answer".
 */
const ATTRIBUTION_REJECTION: Readonly<
  Partial<Record<ScopeAttributionClass, WorkspaceFailure["code"]>>
> = Object.freeze({
  DIRTY: "RUNNER_WORKSPACE_PATH_DIRTY",
  STAGED: "RUNNER_WORKSPACE_PATH_STAGED",
  UNTRACKED: "RUNNER_WORKSPACE_PATH_UNTRACKED",
  UNKNOWN: "RUNNER_WORKSPACE_ATTRIBUTION_UNKNOWN",
  UNMERGED: "RUNNER_WORKSPACE_ATTRIBUTION_UNKNOWN",
  IGNORED: "RUNNER_WORKSPACE_ATTRIBUTION_UNKNOWN",
} as const);

/** The most specific declaration wins, so a nested declaration governs its own subtree. */
export function governingScopeEntry(
  observation: ScopeObservation,
  path: string,
): ScopeObservation["canonicalEntries"][number] | null {
  let governing: ScopeObservation["canonicalEntries"][number] | null = null;
  for (const entry of observation.canonicalEntries) {
    if (!isContainedBy(entry.path, path)) {
      continue;
    }
    if (governing === null || entry.path.length > governing.path.length) {
      governing = entry;
    }
  }
  return governing;
}

function scopeRejection(context: ResultEntryContext, path: string): WorkspaceFailure | null {
  const governing = governingScopeEntry(context.scopeObservation, path);
  if (governing === null) {
    return workspaceFailure(
      "RUNNER_WORKSPACE_PATH_ESCAPED",
      `result path ${JSON.stringify(path)} lies outside every declared scope path`,
      path,
    );
  }
  const code = ATTRIBUTION_REJECTION[governing.attribution];
  if (code !== undefined) {
    return workspaceFailure(
      code,
      `declared scope path ${JSON.stringify(governing.path)} is ${governing.attribution}: ${governing.attributionReason}`,
      path,
    );
  }
  return null;
}

/**
 * Attributes one result byte-range to a declared producer.
 *
 * The order is deliberate. Shape is checked before location, location before
 * git attribution, and only then ownership — so a caller learns the most
 * specific true reason rather than whichever rule happened to run first.
 */
export function resultEntryRejection(
  entry: ResultTreeEntry,
  context: ResultEntryContext,
): WorkspaceFailure | null {
  const pathFailure = workspacePathRejection(entry.path);
  if (pathFailure !== null) {
    return pathFailure;
  }
  const bytesFailure = bytesRejection(entry.sha256, entry.byteLength, entry.path);
  if (bytesFailure !== null) {
    return bytesFailure;
  }
  const kindFailure = kindRejection(entry);
  if (kindFailure !== null) {
    return kindFailure;
  }
  const scopeFailure = scopeRejection(context, entry.path);
  if (scopeFailure !== null) {
    return scopeFailure;
  }
  const inherited = context.inputByPath.get(entry.path);
  if (!context.authoredPaths.has(entry.path) && inherited === undefined) {
    return workspaceFailure(
      "RUNNER_WORKSPACE_PATH_UNDECLARED",
      `result path ${JSON.stringify(entry.path)} is neither authored nor inherited`,
      entry.path,
    );
  }
  return ownershipRejection(entry, context, inherited);
}

function kindRejection(entry: ResultTreeEntry): WorkspaceFailure | null {
  if (entry.kind === "SYMLINK") {
    return workspaceFailure(
      "RUNNER_WORKSPACE_PATH_SYMLINKED",
      `result path ${JSON.stringify(entry.path)} is a symlink or junction`,
      entry.path,
    );
  }
  if (entry.kind !== "REGULAR") {
    return workspaceFailure(
      "RUNNER_WORKSPACE_PATH_KIND_UNSUPPORTED",
      `result path ${JSON.stringify(entry.path)} is ${entry.kind}, not a regular file`,
      entry.path,
    );
  }
  return null;
}

/** Foreign means "no declared producer for these exact bytes", in either direction. */
function ownershipRejection(
  entry: ResultTreeEntry,
  context: ResultEntryContext,
  inherited: WorkspaceInputEntry | undefined,
): WorkspaceFailure | null {
  if (entry.origin === "AUTHORED") {
    return context.authoredPaths.has(entry.path)
      ? null
      : workspaceFailure(
          "RUNNER_WORKSPACE_PATH_FOREIGN",
          `result path ${JSON.stringify(entry.path)} claims authorship but was never declared authored`,
          entry.path,
        );
  }
  if (entry.origin !== "INHERITED") {
    return workspaceFailure(
      "RUNNER_WORKSPACE_PATH_FOREIGN",
      `result path ${JSON.stringify(entry.path)} declares no known origin`,
      entry.path,
    );
  }
  if (inherited === undefined) {
    return workspaceFailure(
      "RUNNER_WORKSPACE_PATH_FOREIGN",
      `result path ${JSON.stringify(entry.path)} claims inheritance but no input entry produced it`,
      entry.path,
    );
  }
  if (inherited.sha256 !== entry.sha256 || inherited.byteLength !== entry.byteLength) {
    return workspaceFailure(
      "RUNNER_WORKSPACE_INHERITED_PRODUCER_MISMATCH",
      `inherited path ${JSON.stringify(entry.path)} differs from the bytes its producer recorded`,
      entry.path,
    );
  }
  return null;
}
