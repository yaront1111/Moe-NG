import { deepFreeze } from "../canonical.js";
import type { ScopeObservation } from "../scope/scope-contract.js";
import {
  captureFailure,
  MAX_FOUNDATION_CAPTURE_BYTES,
  MAX_FOUNDATION_CAPTURE_ENTRIES,
  type FoundationCaptureCode,
  type FoundationCaptureFailure,
  type FoundationCaptureLimits,
} from "./foundation-workspace-capture-contract.js";
import { isContainedBy, type ResultTreeEntry, type WorkspaceInputEntry } from "./workspace-contract.js";

/**
 * The pure decision rules behind the Foundation capture scanner.
 *
 * Split out of the contract and the Node scanner because three concerns —
 * vocabulary, filesystem effects, and the rules that turn observations into a
 * delta — cannot share two files under the per-file line cap. Everything here
 * is total and side-effect free, so a case can drive it directly instead of
 * arranging a filesystem that produces the state under test.
 */

/** One regular file the scanner actually opened and hashed, byte for byte. */
export interface ScannedFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface DerivedCapture {
  readonly authoredPaths: readonly string[];
  readonly resultTreeEntries: readonly ResultTreeEntry[];
}

/** Every rule in this file decides under one layer; only the code varies. */
const refuse = (
  code: FoundationCaptureCode,
  message: string,
  path: string | null = null,
): FoundationCaptureFailure => captureFailure(code, "RUNNER_WORKSPACE_CAPTURE", message, path);

/**
 * Proves the scanned regular-file set EXACTLY equals the sealed input manifest.
 *
 * Deliberately not an intersection: an extra file, a missing file and changed
 * bytes are three different facts about who wrote the assigned tree, and a
 * prover that shrank to what both sides agreed on would report success for all
 * three. Nothing downstream can recover the difference afterwards.
 */
export function scannedTreeRejection(
  scanned: readonly ScannedFile[],
  entries: readonly WorkspaceInputEntry[],
): FoundationCaptureFailure | null {
  const sealed = new Map(entries.map((entry) => [entry.path, entry] as const));
  for (const file of scanned) {
    const entry = sealed.get(file.path);
    if (entry === undefined) {
      return refuse("RUNNER_FOUNDATION_CAPTURE_INPUT_ENTRY_EXTRA", `scanned path ${JSON.stringify(file.path)} is absent from the sealed input manifest`, file.path);
    }
    if (entry.sha256 !== file.sha256 || entry.byteLength !== file.byteLength) {
      return refuse("RUNNER_FOUNDATION_CAPTURE_INPUT_ENTRY_CHANGED", `scanned path ${JSON.stringify(file.path)} does not carry the bytes its input entry sealed`, file.path);
    }
  }
  const found = new Set(scanned.map((file) => file.path));
  for (const entry of entries) {
    if (!found.has(entry.path)) {
      return refuse("RUNNER_FOUNDATION_CAPTURE_INPUT_ENTRY_MISSING", `sealed input path ${JSON.stringify(entry.path)} was not found in the assigned tree`, entry.path);
    }
  }
  return null;
}

/**
 * A git-reported change cannot declare its own scope. Every changed path is
 * checked against the AUTHORITATIVE declaration; one that lies outside all of
 * them means the attempt wrote where it had no authority, and the whole
 * observation is unblessable rather than merely smaller.
 */
export function outOfScopeRejection(
  changedPaths: readonly string[],
  declaredScopePaths: readonly string[],
): FoundationCaptureFailure | null {
  for (const path of changedPaths) {
    if (!declaredScopePaths.some((scope) => isContainedBy(scope, path))) {
      return refuse("RUNNER_FOUNDATION_CAPTURE_OUT_OF_SCOPE_HOST_EFFECT_UNKNOWN", `changed path ${JSON.stringify(path)} lies outside every authoritative scope path`, path);
    }
  }
  return null;
}

/**
 * Refuses the postlaunch states that are not an authored working tree.
 *
 * The order is most-specific first, so a caller learns which fact fired: an
 * unmerged record means conflicting stages exist, a staged record means the
 * index holds a version the working tree does not, a contradictory record means
 * git reported a change whose own XY claims none, and an IGNORED scope means the
 * declaration crosses an ignore rule so nothing under it can be attributed. A
 * dirty or untracked in-scope path is NOT refused: that is precisely what an
 * attempt that did work looks like.
 *
 * The first three read the PATH buckets rather than the per-scope attribution
 * on purpose. `buildAttributionIndex` folds a declared directory to the
 * strongest class in its subtree, so one new file (UNTRACKED, rank 2) would
 * mask a staged sibling (rank 3) and a staged result would sail through. The
 * ignored check is the opposite case: it is a property of the DECLARATION, and
 * an untracked-ignored path never reaches the changed-path buckets at all.
 */
export function gitStateRejection(observation: ScopeObservation): FoundationCaptureFailure | null {
  const attribution = observation.gitAttribution;
  const first = (paths: readonly string[]): string | undefined => paths[0];
  const unmerged = first(attribution.unmergedPaths);
  if (unmerged !== undefined) {
    return refuse("RUNNER_FOUNDATION_CAPTURE_UNMERGED_STATE", `path ${JSON.stringify(unmerged)} holds unmerged index stages`, unmerged);
  }
  const staged = first(attribution.stagedPaths);
  if (staged !== undefined) {
    return refuse("RUNNER_FOUNDATION_CAPTURE_STAGED_STATE", `path ${JSON.stringify(staged)} is staged; an attempt may not stage its own result`, staged);
  }
  const accounted = new Set([
    ...attribution.dirtyPaths,
    ...attribution.stagedPaths,
    ...attribution.untrackedPaths,
    ...attribution.unmergedPaths,
  ]);
  const contradictory = attribution.changedPaths.find((path) => !accounted.has(path));
  if (contradictory !== undefined) {
    return refuse("RUNNER_FOUNDATION_CAPTURE_CONTRADICTORY_STATE", `path ${JSON.stringify(contradictory)} was reported changed but claims no change`, contradictory);
  }
  const ignored = observation.canonicalEntries.find((entry) => entry.attribution === "IGNORED");
  if (ignored !== undefined) {
    return refuse("RUNNER_FOUNDATION_CAPTURE_IGNORED_STATE", `declared scope ${JSON.stringify(ignored.path)} is ignored: ${ignored.attributionReason}`, ignored.path);
  }
  return null;
}

/**
 * Derives the delta from BYTES, never from git's opinion.
 *
 * A path whose bytes still equal the sealed input entry is INHERITED even if
 * git called it changed — a rewrite to identical content authored nothing. A
 * sealed path that is gone is an authored DELETION: it earns an authored path
 * with no result entry, which is how the sealer learns the byte range was
 * removed rather than merely omitted. That is a different fact from an
 * out-of-scope deletion, which never reaches here at all.
 */
export function deriveCapture(
  entries: readonly WorkspaceInputEntry[],
  scanned: readonly ScannedFile[],
): DerivedCapture {
  const sealed = new Map(entries.map((entry) => [entry.path, entry] as const));
  const authoredPaths = new Set<string>();
  const resultTreeEntries: ResultTreeEntry[] = [];
  for (const file of scanned) {
    const entry = sealed.get(file.path);
    const inherited =
      entry !== undefined && entry.sha256 === file.sha256 && entry.byteLength === file.byteLength;
    if (!inherited) {
      authoredPaths.add(file.path);
    }
    resultTreeEntries.push({
      path: file.path,
      sha256: file.sha256,
      byteLength: file.byteLength,
      origin: inherited ? "INHERITED" : "AUTHORED",
      kind: "REGULAR",
    });
  }
  const present = new Set(scanned.map((file) => file.path));
  for (const entry of entries) {
    if (!present.has(entry.path)) {
      authoredPaths.add(entry.path);
    }
  }
  return deepFreeze({
    authoredPaths: [...authoredPaths].sort(),
    resultTreeEntries: resultTreeEntries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  });
}

/** Budgets are the caller's to narrow, never to widen past the module ceilings. */
export function limitsRejection(limits: FoundationCaptureLimits): FoundationCaptureFailure | null {
  const bounded = (value: unknown, ceiling: number): boolean =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= ceiling;
  const ok =
    limits !== null &&
    typeof limits === "object" &&
    bounded(limits.maxEntries, MAX_FOUNDATION_CAPTURE_ENTRIES) &&
    bounded(limits.maxAggregateBytes, MAX_FOUNDATION_CAPTURE_BYTES);
  return ok
    ? null
    : refuse(
        "RUNNER_FOUNDATION_CAPTURE_INPUT_INVALID",
        "scanner limits must be positive safe integers within the module ceilings",
      );
}

/**
 * The declaration is authoritative, so it must be EXACTLY the set the trusted
 * observation canonicalized — a scanner told about paths the observer never
 * classified would bless bytes nothing ever attributed. Every one of those
 * entries must additionally read CLEAN or ABSENT: "trusted clean prelaunch" is
 * a property that has to be checked, not a name given to an argument.
 */
export function declarationRejection(
  declaredScopePaths: readonly string[],
  observation: ScopeObservation,
): FoundationCaptureFailure | null {
  const observed = new Set(observation.canonicalEntries.map((entry) => entry.path));
  const declared = new Set(declaredScopePaths);
  if (declared.size === 0 || declared.size !== observed.size) {
    return refuse("RUNNER_FOUNDATION_CAPTURE_SCOPE_UNDECLARED", `${declared.size} declared scope paths are not the ${observed.size} the observation canonicalized`);
  }
  for (const path of declared) {
    if (!observed.has(path)) {
      return refuse("RUNNER_FOUNDATION_CAPTURE_SCOPE_UNDECLARED", `declared path ${JSON.stringify(path)} was never observed`, path);
    }
  }
  for (const entry of observation.canonicalEntries) {
    if (entry.attribution !== "CLEAN" && entry.attribution !== "ABSENT") {
      return refuse("RUNNER_FOUNDATION_CAPTURE_PRELAUNCH_NOT_CLEAN", `declared scope ${JSON.stringify(entry.path)} is ${entry.attribution} before launch: ${entry.attributionReason}`, entry.path);
    }
  }
  return null;
}
