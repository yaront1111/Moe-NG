/**
 * The kernel's supersession disposition set, DERIVED from two durable node-authority sections
 * (task-9e52f850).
 *
 * `decideSupersession` takes one entry per node key with the predecessor's and successor's node
 * authority hashes, and `validHashes` fixes the shape per kind: ADD is `null -> hash`, REMOVE is
 * `hash -> null`, CHANGE is two DIFFERENT hashes, and CARRY/REQUALIFY/REEXECUTE are the same hash
 * twice. Nothing here invents a hash: both sides come from `GraphRevisionContent.nodeAuthority`,
 * which `encodeGraphContent` DERIVES from the admitted node definitions and embeds inside the
 * content identity, so a disposition can only ever cite authority the content hash already covers.
 *
 * AN UNCHANGED NODE IS `REQUALIFY`, NEVER `CARRY`, AND THAT IS THE FAIL-CLOSED CHOICE. CARRY is the
 * one kind that GRANTS something: it carries the predecessor's proof forward, and the kernel will
 * only accept it with `safeCarry` evidence that `evaluateCarryForward` validates — seven facts
 * about canonicalizer version, dependency presence, environment closure, policy slice and
 * predecessor result. `carry-forward-evidence` assembles and refuses those facts without a caller
 * evidence channel. Four still have no durable source and each needs a writer row before CARRY can
 * be emitted. REQUALIFY has the identical hash shape and grants nothing: the successor must
 * re-qualify the node.
 *
 * THE PRODUCTION-EMITTABLE SET IS {ADD, REMOVE, REQUALIFY, CHANGE}. The raw derivation answers those
 * four relations only; unchanged hashes stay REQUALIFY and never gain CARRY or REEXECUTE authority.
 * The covered wrapper below additionally proves every lineage sealed by preparation appears once.
 */
import type { SupersessionDisposition } from "@moe/core";
import type { GraphRevisionContent } from "@moe/scheduler";

import { assembleCarryForwardEvidence } from "./carry-forward-evidence.js";
import type { CarryForwardEvidenceFact } from "./carry-forward-evidence.js";

type Authorities = GraphRevisionContent["nodeAuthority"]["authorities"];

/** The kernel's own ceiling (`structuralInput` rejects more than 128 entries). */
const MAX_DISPOSITIONS = 128;

export function hashesByNodeKey(authorities: Authorities): ReadonlyMap<string, string> {
  const byKey = new Map<string, string>();
  for (const entry of authorities) byKey.set(entry.nodeKey, entry.nodeAuthorityHash);
  return byKey;
}

function entryFor(
  nodeKey: string, before: string | undefined, after: string | undefined,
): SupersessionDisposition | null {
  if (before === undefined && after === undefined) return null;
  const base = { nodeKey, safeCarry: null } as const;
  if (before === undefined) {
    return { ...base, kind: "ADD", predecessorAuthorityHash: null,
      successorAuthorityHash: after as string };
  }
  if (after === undefined) {
    return { ...base, kind: "REMOVE", predecessorAuthorityHash: before,
      successorAuthorityHash: null };
  }
  return {
    ...base, kind: before === after ? "REQUALIFY" : "CHANGE",
    predecessorAuthorityHash: before, successorAuthorityHash: after,
  };
}

/**
 * One entry per node key in the union of the two revisions, sorted so the derivation is a pure
 * function of the two contents. `null` when the union is empty or larger than the kernel admits —
 * a set the kernel would reject is refused HERE rather than handed over to be rejected as
 * `INPUT_INVALID`, which would name the caller for a fact the caller never supplied.
 */
export function deriveSupersessionDispositions(
  predecessor: Authorities, successor: Authorities,
): readonly SupersessionDisposition[] | null {
  const before = hashesByNodeKey(predecessor);
  const after = hashesByNodeKey(successor);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  if (keys.length === 0 || keys.length > MAX_DISPOSITIONS) return null;
  const dispositions: SupersessionDisposition[] = [];
  for (const nodeKey of keys) {
    const entry = entryFor(nodeKey, before.get(nodeKey), after.get(nodeKey));
    if (entry === null) return null;
    dispositions.push(entry);
  }
  return Object.freeze(dispositions);
}

/**
 * Derive kinds once, then prove the preparation's durable lineage roster is fully represented.
 * Successor-only keys remain legal ADD entries: they did not exist when preparation was sealed.
 */
export function deriveCoveredSupersessionDispositions(
  fencedLineages: readonly string[], predecessor: Authorities, successor: Authorities,
): readonly SupersessionDisposition[] | null {
  if (fencedLineages.length === 0 || fencedLineages.length > MAX_DISPOSITIONS) return null;
  const fenced = new Set(fencedLineages);
  if (fenced.size !== fencedLineages.length || [...fenced].some((lineage) => lineage.length === 0)) {
    return null;
  }
  const dispositions = deriveSupersessionDispositions(predecessor, successor);
  if (dispositions === null || dispositions.length === 0) return null;
  const counts = new Map<string, number>();
  for (const disposition of dispositions) {
    counts.set(disposition.nodeKey, (counts.get(disposition.nodeKey) ?? 0) + 1);
  }
  if (counts.size !== dispositions.length) return null;
  for (const lineage of fenced) if (counts.get(lineage) !== 1) return null;
  return dispositions;
}

/** Diagnostic-only composition point; it does not participate in the supersession decision. */
export function diagnoseCarryUnavailability(
  predecessor: Authorities,
  successor: Authorities,
  nodeKey: string,
  supportedCanonicalizerVersions: readonly string[],
): readonly CarryForwardEvidenceFact[] {
  const outcome = assembleCarryForwardEvidence(
    predecessor, successor, nodeKey, supportedCanonicalizerVersions,
  );
  return outcome.ok ? Object.freeze([]) : outcome.missingFacts;
}
