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
 * predecessor result. This tree has no durable reader for any of them, and DoD 1 forbids the
 * request supplying carry authority, so emitting CARRY would mean inventing the evidence. REQUALIFY
 * has the identical hash shape and grants nothing: the successor must re-qualify the node.
 *
 * SET COMPLETENESS IS THE SCHEDULER'S QUESTION, NOT THIS ONE. `buildSupersessionDispositions`
 * demands one lineage per member of `SUPERSESSION_DISPOSITION_KINDS` and is unsatisfiable in this
 * tree (`journey-authority-bodies.ts:157-161` throws on a second node id); it is used by the
 * preparation for its coverage fact. The KERNEL asks only for a non-empty set of uniquely keyed,
 * well-shaped entries, which is what this module produces.
 */
import type { SupersessionDisposition } from "@moe/core";
import type { GraphRevisionContent } from "@moe/scheduler";

type Authorities = GraphRevisionContent["nodeAuthority"]["authorities"];

/** The kernel's own ceiling (`structuralInput` rejects more than 128 entries). */
const MAX_DISPOSITIONS = 128;

function hashesByNodeKey(authorities: Authorities): ReadonlyMap<string, string> {
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
