import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { createCompilerLanePort } from "../http/affordance-compiler-lane.js";
import type { CompilerGateRef } from "../http/affordance-compiler-lane.js";
import { readProductContractRevision } from "./product-contract-revision-reader.js";

/**
 * The planning seat's read of a goal's APPROVED Product Contract: the Gate 1
 * triple plus the revision's requirements and criteria with their ids — the
 * facts a decomposition is built from. Served over MCP as
 * `product_contract.read`, beside the PRD read.
 *
 * Measured 2026-09-03 on UnAI with a real `claude -p` planning seat: the seat
 * refused to plan because the only product authority it could reach was the
 * ~121 KB PRD text, which no seat could page, and nothing answered "which
 * criteria did the human approve?". The seat was right to stop; this is the
 * answer. It decides nothing: the gate is resolved from durable state the same
 * way the affordance surface and the compile dispatcher resolve it.
 */

const PRODUCT_CONTRACT_READ_LAYER = "PRODUCT_CONTRACT_READ" as const;

export interface ProductContractReadRequirement {
  readonly requirementId: string;
  readonly statement: string;
}

export interface ProductContractReadCriterion {
  readonly criterionId: string;
  readonly requirementId: string;
  readonly statement: string;
}

export interface ProductContractRead {
  readonly gateRef: CompilerGateRef;
  readonly ok: true;
  readonly revision: {
    readonly contractId: string;
    readonly criteria: readonly ProductContractReadCriterion[];
    readonly requirements: readonly ProductContractReadRequirement[];
    readonly revisionDigest: string;
    readonly revisionId: string;
  };
}

export interface ProductContractReadRefused {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
}

export type ProductContractReadResult = ProductContractRead | ProductContractReadRefused;

export interface ProductContractReadPort {
  read(goalRef: unknown): ProductContractReadResult;
}

function refused(code: string, layer: string = PRODUCT_CONTRACT_READ_LAYER): ProductContractReadRefused {
  return Object.freeze({ code, layer, ok: false });
}

export function createProductContractReadPort(options: {
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): ProductContractReadPort {
  const read = (goalRef: unknown): ProductContractReadResult => {
    if (typeof goalRef !== "string" || goalRef.length === 0 || goalRef.length > 512) {
      return refused("PRODUCT_CONTRACT_READ_MALFORMED");
    }
    const lane = createCompilerLanePort({
      ledger: readDurableLedger(options.store, options.projectId),
      projectId: options.projectId,
      store: options.store,
    });
    const facts = lane.factsFor(goalRef);
    if (facts.lane !== "COMPILER") return refused("PRODUCT_CONTRACT_GOAL_NOT_SOURCE_BOUND");
    if (facts.approvedGateRef === null) return refused("PRODUCT_CONTRACT_NOT_APPROVED");
    const gateRef = facts.approvedGateRef;
    const revision = readProductContractRevision(options.store, {
      projectId: options.projectId, ref: gateRef,
    });
    if (!revision.ok) return refused(String(revision.code), String(revision.layer));
    return Object.freeze({
      gateRef: Object.freeze({ ...gateRef }),
      ok: true as const,
      revision: Object.freeze({
        contractId: revision.revision.contractId,
        criteria: Object.freeze(revision.revision.criteria.map((criterion) => Object.freeze({
          criterionId: criterion.criterionId,
          requirementId: criterion.requirementId,
          statement: criterion.statement,
        }))),
        requirements: Object.freeze(revision.revision.requirements.map((requirement) => Object.freeze({
          requirementId: requirement.requirementId,
          statement: requirement.statement,
        }))),
        revisionDigest: revision.revision.revisionDigest,
        revisionId: revision.revision.revisionId,
      }),
    });
  };
  return Object.freeze({ read });
}
