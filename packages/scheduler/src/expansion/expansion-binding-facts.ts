/**
 * The bound-facts reader, the one canonical projection, and the trusted-side comparison.
 *
 * SPLIT FROM `expansion-binding.ts` BY THE PER-FILE CAP, along the seam that was already there:
 * that file owns the ORDER the gates run in and the words a refusal is spoken in; this one owns
 * the exact bytes a fact set is read from and compared by. Nothing here mints a code.
 *
 * # VALIDATION PRECEDES HASHING, NOT THE OTHER WAY ROUND
 *
 * `digestOf` is `JSON.stringify`, and `JSON.stringify` is not total: it THROWS on a BigInt and
 * on a cycle, and it silently DROPS a symbol, a function and an `undefined`. Reading a leaf as
 * `unknown` and handing it straight to the hash therefore has two failure modes, and both defeat
 * the identity check the hash exists for — the throw escapes the bridge as a raw `TypeError`
 * carrying no code and no layer, and the drop removes the leaf from the very bytes the identity
 * is supposed to cover. So every one of the twenty-six leaves is proven to be a string, a safe
 * count or an explicit null BEFORE anything is hashed, and an unprovable leaf is a REQUEST
 * refusal rather than an identity verdict: a value that cannot be canonicalised was never
 * comparable to begin with.
 *
 * The rebuild is also what makes the identity recomputation meaningful. The facts are rebuilt
 * from own data properties in the admission's own key order — `digestOf` is order-sensitive —
 * so a getter, a proxy, an array hole or an extra key never reaches the hash; it refuses first.
 */
import type { ExpansionAdmittedFacts } from "@moe/core";

import {
  MAX_AUTHORITY_ITEMS, exactRecord, isCount, isDigest, isRef, readList, stringList,
} from "../authority/authority-kernel.js";
import {
  hasOnlyOwnStringKeys, isPlainArray, isPlainRecord, readOwnArrayElement, readOwnDataProperty,
  readPlainArrayLength,
} from "../runtime-shape.js";
import { digestOf } from "./expansion-preparation.js";
import type {
  ExpansionBoundFacts, ExpansionBudgetFacts, ExpansionCapacityFact, ExpansionFairnessFacts,
  ExpansionLineageFacts, ExpansionResourceFacts,
} from "./expansion-preparation.js";

/** Key order is the ADMISSION's own literal order, because `digestOf` is order-sensitive. */
const BOUND_KEYS = Object.freeze([
  "proposalId", "revision", "goalVersion", "graphEpoch", "observedAtSequence", "childKeys",
  "sourceDigests", "evidenceDigest", "qualityDigest", "lineage", "fairness", "capacitySnapshot",
  "provenBypasses", "budgetReservation", "resourceReservation"] as const);
const LINEAGE_KEYS =
  Object.freeze(["expansionDepth", "childWidth", "nodesAddedInExpansion"] as const);
const FAIRNESS_KEYS = Object.freeze([
  "disposition", "workItemId", "resourceId", "roundsAdvanced", "capRevisionRef"] as const);
const CAPACITY_KEYS = Object.freeze(["resourceId", "capacityUnits", "inFlightUnits"] as const);
const BUDGET_KEYS = Object.freeze(["reservationId", "accountId", "admissionRef", "lines"] as const);
const LINE_KEYS = Object.freeze(["purpose", "meter", "quantity"] as const);
const RESOURCE_KEYS = Object.freeze(["resourceIds", "epoch", "effectIntentRefs"] as const);

type BudgetLine = ExpansionBudgetFacts["lines"][number];

function lineageOf(value: unknown): ExpansionLineageFacts | null {
  const raw = exactRecord(value, LINEAGE_KEYS);
  if (raw === null) return null;
  const expansionDepth = raw["expansionDepth"];
  const childWidth = raw["childWidth"];
  const nodesAddedInExpansion = raw["nodesAddedInExpansion"];
  if (!isCount(expansionDepth) || !isCount(childWidth) || !isCount(nodesAddedInExpansion)) {
    return null;
  }
  return { expansionDepth, childWidth, nodesAddedInExpansion };
}

function fairnessOf(value: unknown): ExpansionFairnessFacts | null {
  const raw = exactRecord(value, FAIRNESS_KEYS);
  if (raw === null) return null;
  const disposition = raw["disposition"]; const workItemId = raw["workItemId"];
  const resourceId = raw["resourceId"]; const roundsAdvanced = raw["roundsAdvanced"];
  const capRevisionRef = raw["capRevisionRef"];
  if (!isRef(disposition) || !isRef(workItemId) || !isRef(resourceId) || !isCount(roundsAdvanced)
    || !(capRevisionRef === null || isRef(capRevisionRef))) return null;
  return { disposition, workItemId, resourceId, roundsAdvanced, capRevisionRef };
}

function capacityOf(value: unknown): readonly ExpansionCapacityFact[] | null {
  const items = readList(value, MAX_AUTHORITY_ITEMS);
  if (items === null) return null;
  const rows: ExpansionCapacityFact[] = [];
  for (const item of items) {
    const raw = exactRecord(item, CAPACITY_KEYS);
    if (raw === null) return null;
    const resourceId = raw["resourceId"]; const capacityUnits = raw["capacityUnits"];
    const inFlightUnits = raw["inFlightUnits"];
    if (!isRef(resourceId) || !isCount(capacityUnits) || !isCount(inFlightUnits)) return null;
    rows.push({ resourceId, capacityUnits, inFlightUnits });
  }
  return rows;
}

function linesOf(value: unknown): readonly BudgetLine[] | null {
  const items = readList(value, MAX_AUTHORITY_ITEMS);
  if (items === null) return null;
  const lines: BudgetLine[] = [];
  for (const item of items) {
    const raw = exactRecord(item, LINE_KEYS);
    if (raw === null) return null;
    const purpose = raw["purpose"]; const meter = raw["meter"]; const quantity = raw["quantity"];
    if (!isRef(purpose) || !isRef(meter) || !isCount(quantity)) return null;
    lines.push({ purpose, meter, quantity });
  }
  return lines;
}

function budgetOf(value: unknown): ExpansionBudgetFacts | null {
  const raw = exactRecord(value, BUDGET_KEYS);
  if (raw === null) return null;
  const lines = linesOf(raw["lines"]);
  const reservationId = raw["reservationId"]; const accountId = raw["accountId"];
  const admissionRef = raw["admissionRef"];
  if (lines === null || !isRef(reservationId) || !isRef(accountId) || !isRef(admissionRef)) {
    return null;
  }
  return { reservationId, accountId, admissionRef, lines };
}

function resourceOf(value: unknown): ExpansionResourceFacts | null {
  const raw = exactRecord(value, RESOURCE_KEYS);
  if (raw === null) return null;
  const resourceIds = stringList(raw["resourceIds"], MAX_AUTHORITY_ITEMS);
  const effectIntentRefs = stringList(raw["effectIntentRefs"], MAX_AUTHORITY_ITEMS);
  const epoch = raw["epoch"];
  if (resourceIds === null || effectIntentRefs === null || !isCount(epoch)) return null;
  return { resourceIds: [...resourceIds], epoch, effectIntentRefs: [...effectIntentRefs] };
}

/**
 * The admitted facts, rebuilt leaf by proven leaf in the admission's own key order. Total: every
 * unprovable input is `null` here rather than an exception somewhere downstream.
 */
export function boundSnapshot(value: unknown): ExpansionBoundFacts | null {
  const raw = exactRecord(value, BOUND_KEYS);
  if (raw === null) return null;
  const lineage = lineageOf(raw["lineage"]); const fairness = fairnessOf(raw["fairness"]);
  const capacitySnapshot = capacityOf(raw["capacitySnapshot"]);
  const budgetReservation = budgetOf(raw["budgetReservation"]);
  const resourceReservation = resourceOf(raw["resourceReservation"]);
  const childKeys = stringList(raw["childKeys"], MAX_AUTHORITY_ITEMS);
  const sourceDigests = stringList(raw["sourceDigests"], MAX_AUTHORITY_ITEMS);
  const proposalId = raw["proposalId"]; const revision = raw["revision"];
  const goalVersion = raw["goalVersion"]; const graphEpoch = raw["graphEpoch"];
  const observedAtSequence = raw["observedAtSequence"];
  const evidenceDigest = raw["evidenceDigest"]; const qualityDigest = raw["qualityDigest"];
  const provenBypasses = raw["provenBypasses"];
  if (lineage === null || fairness === null || capacitySnapshot === null
    || budgetReservation === null || resourceReservation === null || childKeys === null
    || sourceDigests === null || !isRef(proposalId) || !isCount(revision) || !isCount(goalVersion)
    || !isCount(graphEpoch) || !isCount(observedAtSequence) || !isDigest(evidenceDigest)
    || !isDigest(qualityDigest) || !isCount(provenBypasses)) return null;
  return {
    proposalId, revision, goalVersion, graphEpoch, observedAtSequence,
    childKeys: [...childKeys], sourceDigests: [...sourceDigests], evidenceDigest, qualityDigest,
    lineage, fairness, capacitySnapshot, provenBypasses, budgetReservation, resourceReservation,
  };
}

/**
 * THE ONE CANONICAL PROJECTION: exactly the nine scheduler-only leaves core has no field for.
 * Every leaf core carries explicitly is absent here by construction, so each admitted byte is
 * falsifiable in exactly one place. Adding a carried field here would let a DROPPED mapping hide
 * behind the aggregate, because perturbing it would still move the digest.
 */
export function projectionOf(bound: ExpansionBoundFacts): unknown {
  return {
    budgetLines: bound.budgetReservation.lines, capacitySnapshot: bound.capacitySnapshot,
    effectIntentRefs: bound.resourceReservation.effectIntentRefs,
    fairnessDisposition: bound.fairness.disposition, graphEpoch: bound.graphEpoch,
    lineage: bound.lineage, provenBypasses: bound.provenBypasses,
    roundsAdvanced: bound.fairness.roundsAdvanced, schedulerEvidenceDigest: bound.evidenceDigest,
  };
}

/** The explicitly carried leaves, typed at the boundary rather than cast through it. */
export function admittedOf(
  bound: ExpansionBoundFacts, opportunityRef: string,
): ExpansionAdmittedFacts {
  const budget = bound.budgetReservation; const fairness = bound.fairness;
  const resource = bound.resourceReservation;
  return {
    budgetReservation: {
      accountId: budget.accountId, admissionRef: budget.admissionRef,
      reservationId: budget.reservationId, state: "RESERVED",
    },
    childKeys: bound.childKeys, evidenceDigest: digestOf(projectionOf(bound)),
    fairness: {
      capRevisionRef: fairness.capRevisionRef, opportunityRef, resourceId: fairness.resourceId,
      workItemId: fairness.workItemId,
    },
    goalVersion: bound.goalVersion, observedAtSequence: bound.observedAtSequence,
    proposalId: bound.proposalId, qualityDigest: bound.qualityDigest,
    resourceReservation: {
      epoch: resource.epoch, resourceIds: resource.resourceIds, state: "HELD",
    },
    revision: bound.revision, sourceDigests: bound.sourceDigests, truthClass: "DAEMON_VERIFIED",
  };
}

/**
 * Structural equality DRIVEN BY THE TRUSTED SIDE.
 *
 * The walk's depth and breadth come from the value a reducer produced, so a hostile presented
 * value cannot make it recurse forever and cannot widen it; and every read of the presented side
 * goes through the own-data readers, so an accessor, a proxy trap, an array hole or an extra key
 * is a MISMATCH rather than a value. Nothing is stringified, so no leaf can throw here either.
 */
export function matchesTrusted(presented: unknown, trusted: unknown): boolean {
  if (Array.isArray(trusted)) {
    if (!isPlainArray(presented) || readPlainArrayLength(presented) !== trusted.length) {
      return false;
    }
    return trusted.every((item, index) => {
      const read = readOwnArrayElement(presented, index);
      return read.ok && read.present && matchesTrusted(read.value, item);
    });
  }
  if (trusted !== null && typeof trusted === "object") {
    const source = trusted as Record<string, unknown>;
    const keys = Object.keys(source);
    if (!isPlainRecord(presented) || !hasOnlyOwnStringKeys(presented, keys)) return false;
    return keys.every((key) => {
      const read = readOwnDataProperty(presented, key);
      return read.ok && read.present && matchesTrusted(read.value, source[key]);
    });
  }
  return Object.is(presented, trusted);
}
