/**
 * The judging half of the cutover manifest: given two captures, say exactly what
 * moved. Split from `cutover-manifest.ts` so neither source outgrows the
 * per-file line target — producing evidence and judging it are separable jobs —
 * but both refuse under the SAME layer and the SAME code set, imported rather
 * than restated, so a drill can assert one vocabulary.
 *
 * The comparison never answers with a bare boolean, and it never answers
 * "matched" over nothing: an empty or self-inconsistent manifest REFUSES. That
 * is deliberate. "Nothing equals nothing" is the precise vacuity a quiesce drill
 * exists to rule out, and it must not be reachable through the happy path.
 */

import { refuseManifest } from "./cutover-manifest.js";
import type { CutoverManifest, CutoverManifestEntry, CutoverRefusal } from "./cutover-manifest.js";

export type CutoverDifferenceKind =
  | "ADDED"
  | "REMOVED"
  | "CONTENT_CHANGED"
  | "LENGTH_CHANGED"
  /** A symlink still at the same path, now pointing somewhere else. */
  | "LINK_TARGET_CHANGED"
  /** A file became a link, or a link became a file. Never collapsed into a content difference. */
  | "KIND_CHANGED";

export interface CutoverDifference {
  readonly path: string;
  readonly kind: CutoverDifferenceKind;
}

export interface CutoverComparison {
  readonly ok: true;
  readonly matched: boolean;
  /** Named differences, never a bare boolean: an operator needs to know what moved. */
  readonly differences: readonly CutoverDifference[];
  readonly comparedEntryCount: number;
}

export type CutoverComparisonResult = CutoverComparison | CutoverRefusal;

const byPathBytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const selfInconsistent = (manifest: CutoverManifest, side: string): CutoverRefusal | undefined => {
  const { entryCount, entries, root } = manifest;
  if (entryCount !== entries.length) {
    const detail = `${side} declares ${entryCount} entries but carries ${entries.length}`;
    return refuseManifest("CUTOVER_MANIFEST_COUNT_INCONSISTENT", root, detail);
  }
  if (entryCount === 0) {
    return refuseManifest("CUTOVER_MANIFEST_EMPTY", root, `${side} manifest is empty`);
  }
  return undefined;
};

/**
 * Sits with the `selfInconsistent` guards for the same reason they exist. A
 * capture that excluded MORE than its counterpart compares a smaller population,
 * so a widened exclusion between the two captures could report a clean match
 * over exactly the files that moved. That has to fail closed rather than answer.
 */
const exclusionsDisagree = (
  before: CutoverManifest,
  after: CutoverManifest,
): CutoverRefusal | undefined => {
  const beforeKeys = [...before.excludedDirectories].sort();
  const afterKeys = [...after.excludedDirectories].sort();
  if (beforeKeys.length === afterKeys.length && beforeKeys.every((key, at) => key === afterKeys[at])) {
    return undefined;
  }
  const detail = `before excluded [${beforeKeys.join(", ")}] but after excluded [${afterKeys.join(", ")}]`;
  return refuseManifest("CUTOVER_MANIFEST_EXCLUSION_MISMATCH", before.root, detail);
};

/**
 * Length is the more specific fact, so it wins over the hash difference it
 * implies. A kind change is more specific still: something REPLACED a file with
 * a link (or the reverse), and calling that a content difference would describe
 * a smaller event than the one that happened.
 */
const differenceFor = (
  before: CutoverManifestEntry,
  after: CutoverManifestEntry,
): CutoverDifferenceKind | undefined => {
  if (before.kind === "FILE" && after.kind === "FILE") {
    if (before.byteLength !== after.byteLength) {
      return "LENGTH_CHANGED";
    }
    return before.sha256 === after.sha256 ? undefined : "CONTENT_CHANGED";
  }
  if (before.kind === "LINK" && after.kind === "LINK") {
    return before.target === after.target ? undefined : "LINK_TARGET_CHANGED";
  }
  return "KIND_CHANGED";
};

export const compareCutoverManifests = (
  before: CutoverManifest,
  after: CutoverManifest,
): CutoverComparisonResult => {
  const beforeBad = selfInconsistent(before, "before");
  if (beforeBad !== undefined) {
    return beforeBad;
  }
  const afterBad = selfInconsistent(after, "after");
  if (afterBad !== undefined) {
    return afterBad;
  }
  const widened = exclusionsDisagree(before, after);
  if (widened !== undefined) {
    return widened;
  }

  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const differences: CutoverDifference[] = [];

  for (const entry of before.entries) {
    const counterpart = afterByPath.get(entry.path);
    if (counterpart === undefined) {
      differences.push({ path: entry.path, kind: "REMOVED" });
      continue;
    }
    const kind = differenceFor(entry, counterpart);
    if (kind !== undefined) {
      differences.push({ path: entry.path, kind });
    }
  }

  const beforePaths = new Set(before.entries.map((entry) => entry.path));
  for (const entry of after.entries) {
    if (!beforePaths.has(entry.path)) {
      differences.push({ path: entry.path, kind: "ADDED" });
    }
  }

  differences.sort((left, right) => byPathBytes(left.path, right.path));
  return {
    ok: true,
    matched: differences.length === 0,
    differences,
    comparedEntryCount: before.entryCount,
  };
};
