import { isHex64, isSafeByteCount } from "../canonical.js";
import { exactRecord, isCount, isRef, oneOf } from "../supervisor/effect-shape.js";
import { byWitnessText } from "./dependency-witness-mirror.js";
import {
  MAX_ARTIFACTS_PER_PREDECESSOR,
  MAX_PREDECESSOR_CANDIDATES,
  QUALIFYING_MILESTONES,
  isMirroredGraphKey,
  materializationFailure,
  readBoundedList,
  type MaterializationFailure,
  type QualifyingMilestone,
} from "./materialization-kernel.js";

/**
 * Hostile-input parsing for the predecessor closure.
 *
 * Split out of `predecessor-selection.ts` to keep each file inside the per-file
 * ceiling: this module answers "is this a well-formed candidate record", and
 * that one answers "which of them are selected, and in what order".
 *
 * Every parser here is total. It returns either a parsed record or exactly one
 * coded refusal; nothing throws past this boundary, and no caller ever reads a
 * field off an unvalidated object.
 */
export interface ParsedArtifact {
  readonly artifactIdentity: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ParsedCandidate {
  readonly nodeKey: string;
  readonly topologicalIndex: number;
  readonly resultRef: string;
  readonly attemptRef: string;
  readonly epoch: number;
  readonly adoptionRef: string;
  readonly milestone: QualifyingMilestone;
  readonly artifacts: readonly ParsedArtifact[];
}

const CANDIDATE_KEYS = [
  "nodeKey",
  "topologicalIndex",
  "resultRef",
  "attemptRef",
  "epoch",
  "adoptionRef",
  "milestone",
  "artifacts",
] as const;

const ARTIFACT_KEYS = ["artifactIdentity", "sha256", "byteLength"] as const;

function malformed(): MaterializationFailure {
  return materializationFailure(
    "RUNNER_MATERIALIZATION_CANDIDATE_MALFORMED",
    "SELECTION",
    "predecessor candidate is malformed or incomplete",
  );
}

function parseArtifacts(
  value: unknown,
  nodeKey: string,
): readonly ParsedArtifact[] | MaterializationFailure {
  const read = readBoundedList(value, MAX_ARTIFACTS_PER_PREDECESSOR);
  if (read.kind === "LIMIT") {
    return materializationFailure(
      "RUNNER_MATERIALIZATION_ARTIFACT_LIMIT",
      "SELECTION",
      "predecessor offers more artifacts than the ceiling allows",
      nodeKey,
    );
  }
  if (read.kind !== "OK" || read.items.length === 0) return malformed();
  const output: ParsedArtifact[] = [];
  const seen = new Set<string>();
  for (const entry of read.items) {
    const item = exactRecord(entry, ARTIFACT_KEYS);
    if (item === null || !isRef(item["artifactIdentity"])) return malformed();
    if (seen.has(item["artifactIdentity"])) return malformed();
    if (!isHex64(item["sha256"]) || !isSafeByteCount(item["byteLength"])) return malformed();
    seen.add(item["artifactIdentity"]);
    output.push(item as unknown as ParsedArtifact);
  }
  return output.sort((left, right) =>
    byWitnessText(left.artifactIdentity, right.artifactIdentity),
  );
}

function parseCandidate(value: unknown): ParsedCandidate | MaterializationFailure {
  const item = exactRecord(value, CANDIDATE_KEYS);
  if (item === null || !isMirroredGraphKey(item["nodeKey"])) return malformed();
  if (!isCount(item["topologicalIndex"]) || !isCount(item["epoch"])) return malformed();
  if (!isRef(item["resultRef"]) || !isRef(item["attemptRef"])) return malformed();
  if (!isRef(item["adoptionRef"]) || !oneOf(item["milestone"], QUALIFYING_MILESTONES)) {
    return malformed();
  }
  const artifacts = parseArtifacts(item["artifacts"], item["nodeKey"]);
  if ("ok" in artifacts) return artifacts;
  return {
    nodeKey: item["nodeKey"],
    topologicalIndex: item["topologicalIndex"],
    resultRef: item["resultRef"],
    attemptRef: item["attemptRef"],
    epoch: item["epoch"],
    adoptionRef: item["adoptionRef"],
    milestone: item["milestone"],
    artifacts,
  };
}

export function parseClosure(value: unknown): ParsedCandidate[] | MaterializationFailure {
  const read = readBoundedList(value, MAX_PREDECESSOR_CANDIDATES);
  if (read.kind === "LIMIT") {
    return materializationFailure(
      "RUNNER_MATERIALIZATION_CLOSURE_LIMIT",
      "SELECTION",
      "predecessor closure exceeds its ceiling",
    );
  }
  if (read.kind !== "OK") {
    return materializationFailure(
      "RUNNER_MATERIALIZATION_CLOSURE_MALFORMED",
      "SELECTION",
      "predecessor closure is malformed",
    );
  }
  const output: ParsedCandidate[] = [];
  for (const entry of read.items) {
    const candidate = parseCandidate(entry);
    if ("ok" in candidate) return candidate;
    output.push(candidate);
  }
  // Selection order, applied once, up front: every later refusal names an
  // element chosen by this order rather than by the order the caller built.
  return output.sort(
    (left, right) =>
      left.topologicalIndex - right.topologicalIndex ||
      byWitnessText(left.nodeKey, right.nodeKey),
  );
}
