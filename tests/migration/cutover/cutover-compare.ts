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

export type CutoverDifferenceKind = "ADDED" | "REMOVED" | "CONTENT_CHANGED" | "LENGTH_CHANGED";

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

/** Length is the more specific fact, so it wins over the hash difference it implies. */
const differenceFor = (
  before: CutoverManifestEntry,
  after: CutoverManifestEntry,
): CutoverDifferenceKind | undefined => {
  if (before.byteLength !== after.byteLength) {
    return "LENGTH_CHANGED";
  }
  return before.sha256 === after.sha256 ? undefined : "CONTENT_CHANGED";
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
