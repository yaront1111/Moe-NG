/**
 * One sealed expansion proposal, validated through the landed surfaces and
 * returned as ONE all-or-none prepared admission.
 *
 * # ORDER IS THE ALL-OR-NONE MECHANISM
 *
 * Every PURE check runs first — evidence, the landed lineage limits, the graph
 * admission pass, the real fairness opportunity, the proven-bypass count — and
 * only then is anything reserved. A refusal from any of them therefore cannot
 * strand a hold, because none exists yet.
 *
 * Budget is reserved before resources, so exactly one ordering can produce a
 * partial hold: a resource failure after a budget reservation. That path calls
 * `cancelReservation` and returns the restored buckets as evidence. A refusal
 * that merely RETURNS a refusal satisfies "no preparation" while the units stay
 * in RESERVED, which is why the unwind carries the meters and not just a flag.
 *
 * # THIS IS A PURE KERNEL
 *
 * No child run, lease, effect, provider slot, allocation activation or graph
 * mutation is created. Reservation is NOT activation: `activateReservation`
 * sits beside `reserveForAdmission` in the same module and is deliberately not
 * called. No policy is evaluated, no approval is decided, nothing is persisted.
 *
 * The 3/6/9 limits are NOT redeclared here. `checkExpansionLineage` already
 * owns them (admission-records.ts), so they are composed and their landed
 * ADMISSION_EXPANSION_* codes pass through; a second copy of the numbers would
 * fork the limit authority and diverge the first time one changed.
 */
import { admitGraph, checkExpansionLineage } from "../admission/admission-pass.js";
import type { AdmissionIssue } from "../admission/admission-model.js";
import { reserveAll } from "../authority/lease-resource.js";
import type { AuthorityIssue } from "../authority/authority-kernel.js";
import { deepFreeze } from "../authority/authority-kernel.js";
import { cancelReservation, reserveForAdmission } from "../budget/budget-reservation.js";
import type {
  AdmissionGate, AdmissionRequest, BudgetAvailableView, BudgetReservationIssue, ReservationRecord,
} from "../budget/budget-reservation.js";
import { validateCapRevision } from "../fairness/fairness-cap-revision.js";
import type { FairnessContractRefusal } from "../fairness/fairness-contract.js";
import { validateBypassClaim } from "../fairness/fairness-evidence.js";
import { rotateOnce } from "../fairness/fairness-rotation.js";
import { validateResourceCapacity } from "../fairness/fairness-rotation-input.js";
import { isPlainArray, isPlainRecord } from "../runtime-shape.js";
import { deriveExpansionEvidence } from "./expansion-evidence.js";
import { own } from "./expansion-receipt.js";
import type { ExpansionChildFacts, ExpansionEvidenceRefusal } from "./expansion-receipt.js";
import {
  NO_UNWIND, digestOf, parseExpansionRequest, prepare,
} from "./expansion-preparation.js";
import type {
  ExpansionAdmissionIssue, ExpansionAdmissionOrigin, ExpansionAdmissionRefusal,
  ExpansionAdmissionRequest, ExpansionAdmissionResult, ExpansionAdmissionUnwind,
  ExpansionCapacityFact, ExpansionFairnessFacts,
} from "./expansion-preparation.js";

export type {
  ExpansionAdmissionIssue, ExpansionAdmissionOrigin, ExpansionAdmissionRefusal,
  ExpansionAdmissionResult, ExpansionBoundFacts, ExpansionPreparation,
} from "./expansion-preparation.js";
export {
  EXPANSION_ADMISSION_ISSUE_CODES, EXPANSION_ADMISSION_ORIGINS,
} from "./expansion-preparation.js";

function refusal(
  issues: readonly ExpansionAdmissionIssue[],
  disposition: "REFUSED" | "UNKNOWN" = "REFUSED",
  unwind: ExpansionAdmissionUnwind = NO_UNWIND,
): ExpansionAdmissionRefusal {
  return deepFreeze({ ok: false as const, disposition, issues, unwind });
}

/** One of the three local codes. Used only where no composed surface can speak. */
function local(
  code: string, origin: ExpansionAdmissionOrigin, message: string,
): ExpansionAdmissionRefusal {
  return refusal([{ code, layer: origin, origin, message, missingInput: null }]);
}

/** Evidence and fairness both carry their own layer and disposition. Verbatim. */
function fromLayered(
  source: ExpansionEvidenceRefusal | FairnessContractRefusal, origin: ExpansionAdmissionOrigin,
): ExpansionAdmissionRefusal {
  const issues = source.issues.map((issue) => ({
    code: issue.code, layer: issue.layer, origin,
    message: issue.message, missingInput: issue.missingInput,
  }));
  return refusal(issues, source.disposition);
}

/**
 * The graph, budget and acquisition surfaces carry a code and a message but no
 * layer of their own, so the ORIGIN is the layer: it names the surface that
 * refused, which is exactly what a layer records. Nothing is re-coded.
 */
function fromFlat(
  issues: readonly (AdmissionIssue | BudgetReservationIssue | AuthorityIssue)[],
  origin: ExpansionAdmissionOrigin,
  unwind: ExpansionAdmissionUnwind = NO_UNWIND,
): ExpansionAdmissionRefusal {
  return refusal(issues.map((issue) => ({
    code: issue.code, layer: origin, origin, message: issue.message, missingInput: null,
  })), "REFUSED", unwind);
}

/**
 * Gives back everything this call took, then reports the refusal.
 *
 * The never-started proof is a FACT about this kernel rather than a claim about
 * the world: it creates no attempt, run, lease or effect, so nothing it reserved
 * can have started. A cancellation that nevertheless fails is disclosed as an
 * extra BUDGET issue instead of being reported as an unwind that happened.
 */
function unwound(
  cause: ExpansionAdmissionRefusal,
  reservedView: BudgetAvailableView,
  reservation: ReservationRecord,
  admissionRef: string,
): ExpansionAdmissionRefusal {
  const cancelled = cancelReservation(reservedView, reservation, {
    expectedVersion: reservation.version,
    neverStartedProofRef: `never-started:${admissionRef}`,
  });
  if (!cancelled.ok) {
    const disclosed = fromFlat(cancelled.issues, "BUDGET");
    return refusal([...cause.issues, ...disclosed.issues], cause.disposition, NO_UNWIND);
  }
  const restoredMeters = cancelled.view.meters.map((entry) => ({
    meter: entry.meter, available: entry.available, reserved: entry.reserved,
  }));
  return refusal(cause.issues, cause.disposition, { budgetReservationCancelled: true, restoredMeters });
}

/**
 * The capacity snapshot, re-derived through the landed validator.
 *
 * `rotateOnce` has already accepted these records, so every one validates again
 * here; running the production validator rather than reading the caller's
 * numbers is what keeps the snapshot derived instead of presented, and keeps
 * the failure closed if the two ever disagree.
 */
function capacitySnapshot(
  rotation: unknown,
): readonly ExpansionCapacityFact[] | ExpansionAdmissionRefusal {
  const source = isPlainRecord(rotation) ? own(rotation, "capacities") : undefined;
  if (!isPlainArray(source)) {
    return local("EXPANSION_ADMISSION_REQUEST_MALFORMED", "REQUEST", "capacities are unreadable");
  }
  const facts: ExpansionCapacityFact[] = [];
  for (const raw of source) {
    const capacity = validateResourceCapacity(raw);
    if (!capacity.ok) return fromLayered(capacity, "FAIRNESS");
    facts.push({
      resourceId: capacity.value.resourceId,
      capacityUnits: capacity.value.capacityUnits,
      inFlightUnits: capacity.value.inFlightUnits,
    });
  }
  return facts.sort((left, right) => (left.resourceId < right.resourceId ? -1 : 1));
}

function isRefusal(value: unknown): value is ExpansionAdmissionRefusal {
  return isPlainRecord(value) && value["ok"] === false;
}

/** The fairness opportunity and the revision it was taken under. */
function fairnessFacts(
  rotation: unknown, disposition: string, workItemId: string, resourceId: string,
  roundsAdvanced: number,
): ExpansionFairnessFacts | ExpansionAdmissionRefusal {
  const supplied = isPlainRecord(rotation) ? own(rotation, "capRevision") : null;
  if (supplied === null || supplied === undefined) {
    return { disposition, workItemId, resourceId, roundsAdvanced, capRevisionRef: null };
  }
  const revision = validateCapRevision(supplied);
  if (!revision.ok) return fromLayered(revision, "FAIRNESS");
  return {
    disposition, workItemId, resourceId, roundsAdvanced,
    capRevisionRef: revision.value.revisionRef,
  };
}

/** Zero unless a claim was supplied, and never more than the evidence proves. */
function provenBypasses(claim: unknown): number | ExpansionAdmissionRefusal {
  if (claim === null || claim === undefined) return 0;
  const proven = validateBypassClaim(claim);
  if (!proven.ok) return fromLayered(proven, "FAIRNESS");
  return proven.value.provenBypasses;
}

/** Everything that can refuse without holding anything. Runs before any reservation. */
function pureChecks(request: ExpansionAdmissionRequest): PureFacts | ExpansionAdmissionRefusal {
  const evidence = deriveExpansionEvidence(request.receipt);
  if (!evidence.ok) return fromLayered(evidence, "EVIDENCE");

  const lineage = {
    expansionDepth: request.lineage.expansionDepth,
    childWidth: evidence.value.childWidth,
    nodesAddedInExpansion: request.lineage.nodesAddedInExpansion,
  };
  const limitIssues = checkExpansionLineage(lineage);
  if (limitIssues.length > 0) return fromFlat(limitIssues, "LINEAGE");

  const graph = admitGraph(request.graph);
  if (!graph.ok) return fromFlat(graph.issues, "GRAPH");

  const rotated = rotateOnce(request.rotation);
  if (!rotated.ok) return fromLayered(rotated, "FAIRNESS");
  const selection = rotated.value.selection;
  if (rotated.value.disposition !== "SELECTED" || selection === null) {
    return local("EXPANSION_ADMISSION_NO_FAIRNESS_OPPORTUNITY", "FAIRNESS",
      `rotation yielded ${rotated.value.disposition} rather than an opportunity`);
  }
  const capacities = capacitySnapshot(request.rotation);
  if (isRefusal(capacities)) return capacities;
  const fairness = fairnessFacts(request.rotation, rotated.value.disposition,
    selection.workItemId, selection.resourceId, rotated.value.roundsAdvanced);
  if (isRefusal(fairness)) return fairness;
  const bypasses = provenBypasses(request.bypassClaim);
  if (isRefusal(bypasses)) return bypasses;

  return {
    evidence: evidence.value, lineage, capacities, fairness, bypasses,
    qualityDigest: digestOf(graph.records),
  };
}

interface PureFacts {
  readonly evidence: {
    readonly proposalId: string; readonly revision: number; readonly goalVersion: number;
    readonly graphEpoch: number; readonly observedAtSequence: number;
    readonly childKeys: readonly string[]; readonly childWidth: number;
    readonly sourceDigests: readonly string[];
    readonly childFacts: readonly ExpansionChildFacts[];
  };
  readonly lineage: { readonly expansionDepth: number; readonly childWidth: number; readonly nodesAddedInExpansion: number };
  readonly capacities: readonly ExpansionCapacityFact[];
  readonly fairness: ExpansionFairnessFacts;
  readonly bypasses: number;
  readonly qualityDigest: string;
}

/**
 * Validate one sealed expansion proposal and prepare — never grant — its
 * admission. Deterministic, side-effect-free, deeply frozen.
 */
export function admitExpansion(value: unknown): ExpansionAdmissionResult {
  const request = parseExpansionRequest(value);
  if (request === null) {
    return local("EXPANSION_ADMISSION_REQUEST_MALFORMED", "REQUEST",
      "the expansion admission request is malformed");
  }
  const pure = pureChecks(request);
  if (isRefusal(pure)) return pure;

  // NOTHING ABOVE HOLDS ANYTHING. The two reservations are last, in this order,
  // so at most one of them can ever need unwinding.
  // The three casts are a SIGNATURE accommodation, not an assumption: the
  // reservation kernel re-parses each argument through its own hostile-input
  // readers (`isView`, `readRecord`, `readGate`) and refuses with
  // BUDGET_RESERVATION_MALFORMED / _GATE_MALFORMED before touching a bucket.
  const reserved = reserveForAdmission(
    request.budget.view as BudgetAvailableView,
    request.budget.admission as AdmissionRequest,
    request.budget.gate as AdmissionGate,
  );
  if (!reserved.ok) return fromFlat(reserved.issues, "BUDGET");
  const reservation = reserved.reservation;

  const acquired = reserveAll(request.resources);
  if (!acquired.ok) {
    return unwound(fromFlat(acquired.issues, "RESOURCE"), reserved.view, reservation, reservation.admissionRef);
  }
  if (acquired.value.outcome !== "RESERVED") {
    return unwound(
      local("EXPANSION_ADMISSION_RESOURCES_UNAVAILABLE", "RESOURCE",
        "the acquisition is waiting on capacity and reserved nothing"),
      reserved.view, reservation, reservation.admissionRef);
  }
  const rows = acquired.value.rows;

  return prepare({
    proposalId: pure.evidence.proposalId,
    revision: pure.evidence.revision,
    goalVersion: pure.evidence.goalVersion,
    graphEpoch: pure.evidence.graphEpoch,
    observedAtSequence: pure.evidence.observedAtSequence,
    childKeys: pure.evidence.childKeys,
    sourceDigests: pure.evidence.sourceDigests,
    // The CHILD FACTS only, never the scalars beside them. Digesting the whole
    // evidence value would bind proposalId, revision, goalVersion, graphEpoch,
    // observedAtSequence, childKeys and sourceDigests a SECOND time, and a
    // second binding makes the first one unfalsifiable: dropping any of those
    // fields from the identity would leave every perturbation test green
    // because the digest still moved. Measured, not reasoned — the drill that
    // dropped goalVersion passed until this was split.
    evidenceDigest: digestOf(pure.evidence.childFacts),
    qualityDigest: pure.qualityDigest,
    lineage: pure.lineage,
    fairness: pure.fairness,
    capacitySnapshot: pure.capacities,
    provenBypasses: pure.bypasses,
    budgetReservation: {
      reservationId: reservation.reservationId,
      accountId: reservation.accountId,
      admissionRef: reservation.admissionRef,
      lines: reservation.lines.map((line) => ({
        purpose: line.purpose, meter: line.meter, quantity: line.quantity,
      })),
    },
    resourceReservation: {
      resourceIds: rows.map((row) => row.resourceId),
      epoch: rows[0]?.epoch ?? 0,
      effectIntentRefs: rows.map((row) => row.effectIntentRef),
    },
  });
}
