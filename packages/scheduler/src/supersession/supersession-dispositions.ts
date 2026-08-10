/**
 * The scheduler's supersession disposition SET: complete over the declared kind
 * vocabulary, canonically ordered, hash bound through one digest, and the
 * landed consumer edge for the wait/blocker carry.
 *
 * COMPLETENESS IS STRUCTURAL. `SUPERSESSION_DISPOSITION_KINDS` is imported from
 * `@moe/core` and every member must be disposed by every family. A kind with no
 * facts is a REFUSAL, never a shorter set, so a partial result can never be
 * mistaken for a complete one.
 *
 * NODES ARE SORTED BEFORE PRODUCTION, not only after. Production stops at the
 * first refusal, so an unsorted pass would let input arrival order decide WHICH
 * refusal a caller sees when two facts are bad at once.
 *
 * CONSUMER EDGE (design 235 / admission-wait.ts): `carryWaitProjection` binds a
 * wait projection to this set through admission-wait's own
 * `validateIntentionalWait`. It stays representation and validation only — it
 * enqueues nothing, transitions nothing and reads no clock.
 */
import { SUPERSESSION_DISPOSITION_KINDS } from "@moe/core";

import { validateIntentionalWait } from "../admission/admission-wait.js";
import { compareStrings, exactRecord, isRef, readList } from "../authority/authority-kernel.js";
import {
  SUPERSESSION_DISPOSITION_FAMILIES,
  isSupersessionKind,
  refuseSupersession,
  sealDispositionSet,
  supersessionKindRank,
  type SupersessionDispositionResult,
  type SupersessionFamilyDisposition,
  type SupersessionNodeFacts,
} from "./supersession-disposition-contract.js";
import { FAMILY_PRODUCERS } from "./supersession-disposition-families.js";

export type {
  SupersessionBudgetFacts, SupersessionNodeFacts, SupersessionResourceFacts,
} from "./supersession-disposition-contract.js";

const SET_LAYER = "SCHEDULER_SUPERSESSION_SET" as const;
const NODE_KEYS = [
  "attemptLifecycle", "budget", "effectsTerminal", "kind", "nodeKey", "resource",
] as const;
const MAX_SUPERSESSION_NODES = 128;

/**
 * Structural only: the kind vocabulary and the node key are checked here because
 * the SET cannot be assembled without them. Every other fact is left to its own
 * family, so a family's refusal reaches the caller from the layer that owns it
 * rather than being pre-empted by a generic set-level refusal.
 */
function parseNodes(value: unknown): readonly SupersessionNodeFacts[] | null {
  const entries = readList(value, MAX_SUPERSESSION_NODES);
  if (entries === null || entries.length === 0) return null;
  const nodes: SupersessionNodeFacts[] = [];
  for (const entry of entries) {
    const parsed = exactRecord(entry, NODE_KEYS);
    if (parsed === null || !isSupersessionKind(parsed["kind"]) || !isRef(parsed["nodeKey"])) {
      return null;
    }
    nodes.push(parsed as unknown as SupersessionNodeFacts);
  }
  const kinds = nodes.map((node) => node.kind);
  const keys = nodes.map((node) => node.nodeKey);
  if (new Set(kinds).size !== kinds.length || new Set(keys).size !== keys.length) return null;
  return nodes;
}

function compareNodes(left: SupersessionNodeFacts, right: SupersessionNodeFacts): number {
  const kind = supersessionKindRank(left.kind) - supersessionKindRank(right.kind);
  return kind !== 0 ? kind : compareStrings(left.nodeKey, right.nodeKey);
}

export function buildSupersessionDispositions(value: unknown): SupersessionDispositionResult {
  const nodes = parseNodes(value);
  if (nodes === null) return refuseSupersession("INPUT_INVALID", SET_LAYER);
  const present = new Set<string>(nodes.map((node) => node.kind));
  if (SUPERSESSION_DISPOSITION_KINDS.some((kind) => !present.has(kind))) {
    return refuseSupersession("PLANNING_DISPOSITION_UNKNOWN", SET_LAYER);
  }
  const ordered = [...nodes].sort(compareNodes);
  const dispositions: SupersessionFamilyDisposition[] = [];
  for (const family of SUPERSESSION_DISPOSITION_FAMILIES) {
    for (const node of ordered) {
      const produced = FAMILY_PRODUCERS[family](node);
      if ("ok" in produced) return produced;
      dispositions.push(produced);
    }
  }
  return sealDispositionSet(dispositions);
}

/**
 * Wire the design-235 wait projection to the supersession set. The wait is
 * validated by admission-wait's OWN validator — its horizon and shape rules are
 * not restated here — and a wait whose owner node has no disposition refuses
 * rather than carrying an unbacked projection into the successor revision.
 */
export function carryWaitProjection(wait: unknown, nodes: unknown): SupersessionDispositionResult {
  const validated = validateIntentionalWait(wait);
  if (!validated.ok) return refuseSupersession("INPUT_INVALID", SET_LAYER);
  const built = buildSupersessionDispositions(nodes);
  if (!built.ok) return built;
  const owner = validated.wait.ownerNodeKey;
  return built.dispositions.some((entry) => entry.nodeKey === owner)
    ? built
    : refuseSupersession("PLANNING_DISPOSITION_UNKNOWN", SET_LAYER);
}
