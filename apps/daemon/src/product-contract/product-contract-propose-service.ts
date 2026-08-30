/**
 * The WRITER the Product Contract family shipped without: an agent-authored
 * revision draft, admitted end to end and committed durably.
 *
 * Order is the authority story: exact payload shape → the provenance join
 * (the draft must name the goal's own PRD sha, and every cited digest must
 * resolve to stored integrity-proven text) → the clarification-consumption
 * fence (an open MATERIAL clarification refuses submission — "never quietly
 * invent a product decision" as a refusal code; the injected reader defaults
 * CLOSED-EMPTY until the clarification lifecycle row lands) → core admission +
 * digest derivation inside `commitProductContractRevision` (content-addressed
 * commandId, so replays dedupe). Lineage is v0-refused: re-revision arrives
 * with the clarification row, and admitting a parent chain before any reader
 * enforces parent-is-current would be quiet supersession.
 *
 * Every upstream refusal travels back UNRESTAMPED; this module's own codes name
 * only its ingress shape and its two fences.
 */
import type { SqliteEventStore } from "@moe/store";

import { commitProductContractRevision } from "./product-contract-revision-store.js";
import type { ProductContractRevisionCommitResult } from "./product-contract-revision-store.js";
import { validateRevisionProvenance } from "./product-contract-provenance.js";

const LAYER = "PRODUCT_CONTRACT_PROPOSE";

export const PRODUCT_CONTRACT_PROPOSE_PAYLOAD_KEYS = Object.freeze([
  "draft", "goalRef",
] as const);

export const PRODUCT_CONTRACT_PROPOSE_CODES = Object.freeze([
  "PRODUCT_CONTRACT_PROPOSE_MALFORMED",
  "PRODUCT_CONTRACT_PROPOSE_LINEAGE_UNSUPPORTED",
  "PRODUCT_CONTRACT_PROPOSE_CLARIFICATION_OPEN",
] as const);
export type ProductContractProposeCode = (typeof PRODUCT_CONTRACT_PROPOSE_CODES)[number];

/**
 * The clarification-consumption fence's read side. CLOSED-EMPTY by default: a
 * composition without the lifecycle answers "no open material clarifications",
 * and the row that lands the lifecycle swaps the real reader in — the fence's
 * call site is already load-bearing either way.
 */
export interface OpenClarificationReader {
  openMaterialClarificationIds(contractId: string): readonly string[];
}
export const CLOSED_EMPTY_CLARIFICATIONS: OpenClarificationReader = Object.freeze({
  openMaterialClarificationIds: () => Object.freeze([]),
});

export interface ProposeRevisionInput {
  readonly clarifications?: OpenClarificationReader;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly payload: unknown;
  readonly principalId: string;
  readonly projectId: string;
}

export interface ProposeRevisionRefused {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
}
export type ProposeRevisionResult =
  | Extract<ProductContractRevisionCommitResult, { readonly ok: true }>
  | ProposeRevisionRefused;

function refused(code: ProductContractProposeCode): ProposeRevisionRefused {
  return Object.freeze({ code, layer: LAYER, ok: false });
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function runProductContractProposeRevision(
  store: SqliteEventStore,
  input: ProposeRevisionInput,
): ProposeRevisionResult {
  const payload = record(input.payload);
  if (payload === null
    || Object.keys(payload).length !== PRODUCT_CONTRACT_PROPOSE_PAYLOAD_KEYS.length
    || typeof payload["goalRef"] !== "string") {
    return refused("PRODUCT_CONTRACT_PROPOSE_MALFORMED");
  }
  const draft = record(payload["draft"]);
  if (draft === null) return refused("PRODUCT_CONTRACT_PROPOSE_MALFORMED");

  // v0: first-admitted-wins, no parent chains — see module doc.
  if (draft["lineage"] !== null) {
    return refused("PRODUCT_CONTRACT_PROPOSE_LINEAGE_UNSUPPORTED");
  }

  const provenance = validateRevisionProvenance(
    store, input.projectId, payload["goalRef"], draft["sourceDocumentDigests"],
  );
  if (!provenance.ok) return provenance;

  const contractId = draft["contractId"];
  if (typeof contractId !== "string" || contractId.length === 0) {
    return refused("PRODUCT_CONTRACT_PROPOSE_MALFORMED");
  }
  const clarifications = input.clarifications ?? CLOSED_EMPTY_CLARIFICATIONS;
  if (clarifications.openMaterialClarificationIds(contractId).length > 0) {
    return refused("PRODUCT_CONTRACT_PROPOSE_CLARIFICATION_OPEN");
  }

  const committed = commitProductContractRevision(store, {
    correlationId: input.correlationId,
    decidedAt: input.decidedAt,
    draft,
    principalId: input.principalId,
    projectId: input.projectId,
  });
  if (!committed.ok) return committed;
  return committed;
}
