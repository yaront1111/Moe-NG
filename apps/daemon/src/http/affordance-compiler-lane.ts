/**
 * Which planning lane a durable goal rides, resolved for the offer surface.
 *
 * THE LADDER THE OFFERS ENFORCE: a goal that BINDS a PRD source is compiled,
 * never hand-planned — pre-Gate-1 it offers `product_contract.propose_revision`
 * and WITHHOLDS `plan.propose` (staffing the demo payload against a real PRD is
 * the race the compiler retires); once a Gate 1 approval names a revision whose
 * provenance cites the goal's own source sha, it offers
 * `planning.submit_decomposition` instead. A goal without a binding keeps the
 * legacy `plan.propose` journey untouched, and a goal whose binding will not
 * re-prove offers NOTHING — handing a broken source goal the legacy lane would
 * quietly plan around the very document the goal was created to compile.
 *
 * DETECTION IS LEDGER + CATALOG, NOT TRUST: the source side re-proves through
 * `createGoalSourceReadPort` (decision-trace-bound decode, bytes re-hashed), and
 * the Gate 1 side reads only COMMITTED decisions — the approval record on its
 * own `product-contract-gate-1-` aggregate, joined to the committed revision at
 * the aggregate id derived from (projectId, contractId, revisionId). The join
 * is provenance: the revision's `sourceDocumentDigests` must name the goal's
 * sha. The dispatcher re-verifies everything at submit; this port only decides
 * what is OFFERED, so a forged ledger row buys an offer whose dispatch refuses.
 */
import type { SqliteEventStore } from "@moe/store";

import { stateOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { createGoalSourceReadPort } from "../documents/document-source-full-read.js";
import { deriveProductContractRevisionAggregateId }
  from "../product-contract/product-contract-revision-store.js";

const GATE_1_AGGREGATE_PREFIX = "product-contract-gate-1-";
const REVISION_AGGREGATE_PREFIX = "product-contract-revision:";

/** The Gate 1 approval's revision triple, exactly what `submit_decomposition`'s
 *  `gateRef` payload member carries. */
export interface CompilerGateRef {
  readonly contractId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
}

/** A revision that cites the goal's source and that no Gate 1 approval names yet. */
export interface PendingRevisionRef {
  readonly contractId: string;
  readonly revisionId: string;
}

export type CompilerLaneFacts =
  /** No source binding: the legacy plan.propose journey, untouched. */
  | { readonly lane: "LEGACY" }
  /** Source-bound: the compiler lane. `approvedGateRef` null = pre-Gate-1. */
  | {
    readonly approvedGateRef: CompilerGateRef | null;
    readonly lane: "COMPILER";
    /**
     * Pre-Gate-1 only: the revision the human is looking at. While it is set the goal is the
     * HUMAN's turn and the ladder offers nothing — offering the writer again staffed a fresh
     * seat every pass that re-proposed the same revision until the goal exhausted its
     * attempts (measured 2026-09-05). Absent (fixtures built before the field) reads as none.
     */
    readonly pendingRevision?: PendingRevisionRef | null;
  }
  /** A binding is present but will not re-prove: offer nothing, fail closed. */
  | { readonly lane: "WITHHELD" };

export interface CompilerLanePort {
  factsFor(goalId: string): CompilerLaneFacts;
}

function dataRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function gateRefOf(value: unknown): CompilerGateRef | null {
  const approval = dataRecord(value);
  const contractId = approval?.["contractId"];
  const revisionDigest = approval?.["revisionDigest"];
  const revisionId = approval?.["revisionId"];
  return typeof contractId === "string" && typeof revisionDigest === "string"
    && typeof revisionId === "string"
    ? Object.freeze({ contractId, revisionDigest, revisionId })
    : null;
}

export function createCompilerLanePort(options: {
  readonly ledger: DurableLedger;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): CompilerLanePort {
  const source = createGoalSourceReadPort({
    projectId: options.projectId, store: options.store,
  });
  const approvedGateRef = (contentSha256: string): CompilerGateRef | null => {
    for (const [aggregateId] of options.ledger.aggregates) {
      if (!aggregateId.startsWith(GATE_1_AGGREGATE_PREFIX)) continue;
      const ref = gateRefOf(stateOf(options.ledger, aggregateId));
      if (ref === null) continue;
      const revision = dataRecord(stateOf(options.ledger,
        deriveProductContractRevisionAggregateId(
          options.projectId, ref.contractId, ref.revisionId,
        )));
      const digests = revision?.["sourceDocumentDigests"];
      if (Array.isArray(digests) && digests.includes(contentSha256)) return ref;
    }
    return null;
  };
  const pendingRevision = (contentSha256: string): PendingRevisionRef | null => {
    for (const [aggregateId] of options.ledger.aggregates) {
      if (!aggregateId.startsWith(REVISION_AGGREGATE_PREFIX)) continue;
      const revision = dataRecord(stateOf(options.ledger, aggregateId));
      const digests = revision?.["sourceDocumentDigests"];
      const contractId = revision?.["contractId"];
      const revisionId = revision?.["revisionId"];
      if (Array.isArray(digests) && digests.includes(contentSha256)
        && typeof contractId === "string" && typeof revisionId === "string") {
        return Object.freeze({ contractId, revisionId });
      }
    }
    return null;
  };
  const factsFor = (goalId: string): CompilerLaneFacts => {
    const read = source.read(goalId);
    if (read.ok) {
      const approved = approvedGateRef(read.contentSha256);
      return Object.freeze({
        approvedGateRef: approved,
        lane: "COMPILER" as const,
        pendingRevision: approved === null ? pendingRevision(read.contentSha256) : null,
      });
    }
    // UNBOUND covers "no binding at all" (a plain goal.create goal, or a goal
    // this store does not hold) — the legacy journey. Every OTHER refusal means
    // a binding EXISTS and failed integrity: fail closed, offer nothing.
    return read.code === "GOAL_SOURCE_UNBOUND"
      ? Object.freeze({ lane: "LEGACY" as const })
      : Object.freeze({ lane: "WITHHELD" as const });
  };
  return Object.freeze({ factsFor });
}
