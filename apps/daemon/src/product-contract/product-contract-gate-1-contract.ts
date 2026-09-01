import { createHash } from "node:crypto";

import type { CommandDecisionRecord } from "@moe/store";

import { sessionAuthorityRequestDigest } from "../identity/session-authority-protocol.js";

/**
 * `product_contract.approve_gate_1` — the vocabulary of the daemon-owned writer
 * that records ONE authenticated human grant over ONE product-contract revision.
 *
 * NOTHING HERE IS A CALLER ASSERTION. The gate and the work reference come from
 * `@moe/core` (`productContractGate1Authority`, fed the ref admitted by
 * `admitProductContractRevisionRef`, landed by task-ce8398e72a744a0d8a17051372f0eddf);
 * the principal and its KIND come from the session authority's facts; the moment
 * comes from the `decidedAt` the registry stamps. A caller naming a principal, a
 * grant, a gate, a work reference or a moment is refused STRUCTURALLY at
 * PAYLOAD_SHAPE by the allow-list below, before this command's handler runs.
 *
 * The reader that re-proves the record — task-db1a8566958f416b92105cc2c7e51591 —
 * consumes `PRODUCT_CONTRACT_GATE_1_EVENT_TYPE` and
 * `deriveProductContractGate1AggregateId`, so both live here, not in the command.
 */

export const PRODUCT_CONTRACT_GATE_1_COMMAND_KIND = "product_contract.approve_gate_1" as const;
export const PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION = "moe-product-contract-gate-1/1" as const;
export const PRODUCT_CONTRACT_GATE_1_EVENT_TYPE = "ProductContractGate1Approved" as const;

/** TWO domains. A signed subject may never be presentable where an aggregate id is
 *  demanded, nor the reverse, so neither derivation shares the other's tag. */
export const PRODUCT_CONTRACT_GATE_1_APPROVAL_DOMAIN =
  "moe-product-contract-gate-1-approval/1" as const;
export const PRODUCT_CONTRACT_GATE_1_AGGREGATE_DOMAIN = "moe-product-contract-gate-1/1:" as const;

/**
 * SORTED: the HTTP seam compares its payload allow-list ORDERED. `authentication`
 * is a signed, single-use session presentation — the ONLY way a daemon command
 * learns that a HUMAN acted, because the registry's `AuthenticatedPrincipal`
 * carries capabilities and an id but no principal KIND.
 */
export const PRODUCT_CONTRACT_GATE_1_PAYLOAD_KEYS = Object.freeze([
  "authentication", "contractId", "revisionDigest", "revisionId",
] as const);

/** The exact envelope `daemon-command-registry.ts` assembles for this kind. */
export const PRODUCT_CONTRACT_GATE_1_REQUEST_KEYS = Object.freeze([
  "commandId", "correlationId", "decidedAt", "expectedVersion", "kind", "payload",
  "principalId", "projectId", "schemaVersion",
] as const);

/**
 * CLOSED, and exactly the codes THIS module emits. Core's admission refuses a
 * malformed triple and the session authority refuses a bad presentation; both
 * verdicts travel out under their OWN code and layer, so restating either here
 * would give one refusal two spellings and hide which authority answered.
 */
export const PRODUCT_CONTRACT_GATE_1_CODES = Object.freeze([
  "PRODUCT_CONTRACT_GATE_1_REQUEST_MALFORMED",
  "PRODUCT_CONTRACT_GATE_1_AUTHENTICATION_INVALID",
  "PRODUCT_CONTRACT_GATE_1_TRANSPORT_ORIGIN_INVALID",
] as const);
export type ProductContractGate1Code = (typeof PRODUCT_CONTRACT_GATE_1_CODES)[number];

/**
 * MODULE-PRIVATE. A column-zero `export const *_LAYER` declares a production
 * boundary `tests/security/boundary-roster.security.ts` then owes hostile arms
 * for. Only the closed TYPE escapes, as `../work/release-handoff-binding.ts` does.
 */
const LAYER = "DAEMON_PRODUCT_CONTRACT_GATE_1";
export type ProductContractGate1Layer = typeof LAYER;

export interface ProductContractGate1Request {
  readonly authentication: unknown;
  /** The canonical replay preimage: kind and payload only, never the stamped moment. */
  readonly bytes: Uint8Array;
  readonly commandId: string;
  readonly contractId: unknown;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly decidedAtEpochMs: number;
  readonly principalId: string;
  readonly projectId: string;
  readonly revisionDigest: unknown;
  readonly revisionId: unknown;
}

export interface ProductContractGate1Refused {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly code: string;
  readonly error: null;
  readonly kind: typeof PRODUCT_CONTRACT_GATE_1_COMMAND_KIND | null;
  readonly ok: false;
  readonly reason: string;
  /** The layer that ANSWERED — this module's, or a foreign producer's verbatim. */
  readonly refusedBy: string;
}

export interface ProductContractGate1Accepted {
  readonly advisoryOnly: false;
  readonly authority: "DURABLE_DECISION";
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly kind: typeof PRODUCT_CONTRACT_GATE_1_COMMAND_KIND;
  readonly ok: true;
}

export type ProductContractGate1Outcome =
  | ProductContractGate1Accepted
  | ProductContractGate1Refused;

export function productContractGate1Refusal(parts: {
  readonly code: ProductContractGate1Code | string;
  readonly reason: string;
  readonly refusedBy?: ProductContractGate1Layer | string;
}): ProductContractGate1Refused {
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const, code: parts.code, error: null,
    kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, ok: false as const, reason: parts.reason,
    refusedBy: parts.refusedBy ?? LAYER,
  });
}

export function acceptedProductContractGate1(
  decision: CommandDecisionRecord, disposition: "DECIDED" | "REPLAYED",
): ProductContractGate1Accepted {
  return Object.freeze({
    advisoryOnly: false as const, authority: "DURABLE_DECISION" as const, decision, disposition,
    kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, ok: true as const,
  });
}

/**
 * DOMAIN-SEPARATED. The work reference is a readable string core owns, so hashing
 * it under this command's own namespace is what stops a Gate 1 approval from
 * addressing another family's aggregate, or the reverse.
 */
export function deriveProductContractGate1AggregateId(workRef: string): string {
  return `product-contract-gate-1-${createHash("sha256")
    .update(PRODUCT_CONTRACT_GATE_1_AGGREGATE_DOMAIN, "utf8")
    .update(workRef, "utf8").digest("hex")}`;
}

/**
 * The subject one presentation is signed over. It names the WORK REFERENCE core
 * derived, so a human's signature cannot be lifted onto another revision, and the
 * COMMAND ID, so it cannot be lifted onto another command. Both are server facts.
 * The gate id is deliberately absent: `@moe/core` does not publish
 * `PRODUCT_CONTRACT_GATE_1_ID`, and the approval DOMAIN tag above already keeps
 * this subject out of every other digest's preimage.
 */
export function productContractGate1SubjectDigest(subject: {
  readonly commandId: string;
  readonly projectId: string;
  readonly workRef: string;
}): string {
  return sessionAuthorityRequestDigest({
    commandId: subject.commandId, decision: "APPROVE",
    domain: PRODUCT_CONTRACT_GATE_1_APPROVAL_DOMAIN, projectId: subject.projectId,
    schemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION, workRef: subject.workRef,
  });
}
