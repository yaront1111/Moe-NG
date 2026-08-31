import { createHash } from "node:crypto";
import { RUNTIME_COMMAND_ENVELOPE_VERSION, decodeBoundedJsonBytes, type NextAllowedCommand }
  from "@moe/contracts";
import { productContractGate1Authority, type ProductContractRevisionV2 } from "@moe/core";
import { DurableStoreError, type SqliteEventStore } from "@moe/store";
import { admitV2ActiveInstallation } from "../cutover/cutover-v2-authority.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createGoalSourceReadPort } from "../documents/document-source-full-read.js";
import { exactDataRecord } from "../documents/document-work-safe-value.js";
import { PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  deriveProductContractGate1AggregateId, productContractGate1SubjectDigest }
  from "../product-contract/product-contract-gate-1-contract.js";
import { readProductContractGate1Approval } from "../product-contract/product-contract-gate-1-reader.js";
import { validateRevisionProvenance } from "../product-contract/product-contract-provenance.js";
import { PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION, productContractClarificationV2AggregateId }
  from "../product-contract/product-contract-v2-clarification-contract.js";
import { resolveProductContractClarificationV2Authority } from "../product-contract/product-contract-v2-clarification-authority.js";
import { readProductContractClarificationsV2ForContract } from "../product-contract/product-contract-v2-clarification-reader.js";
import { readProductContractV2GoalBinding }
  from "../product-contract/product-contract-v2-goal-binding-reader.js";
import { readCurrentProductContractRevisionV2 }
  from "../product-contract/product-contract-v2-reader.js";
import { readProductContractV2WorkflowHead }
  from "../product-contract/product-contract-v2-workflow-reader.js";
import { sameProductContractV2WorkflowRef }
  from "../product-contract/product-contract-v2-workflow-contract.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";
import { captureProductContractV2PendingConfig, type ProductContractV2PendingConfig } from "./product-contract-v2-pending-config.js";
export const PRODUCT_CONTRACT_V2_PENDING_READ_PATH = "/v2/product-contract/pending/read" as const;
const LAYER = "PRODUCT_CONTRACT_V2_PENDING_READ" as const;
const REQUEST_KEYS = Object.freeze(["goalRef"] as const);
export const PRODUCT_CONTRACT_V2_PENDING_READ_CODES = Object.freeze([
  "PRODUCT_CONTRACT_V2_PENDING_READ_CAPABILITY_DENIED", "PRODUCT_CONTRACT_V2_PENDING_READ_PROJECT_MISMATCH",
  "PRODUCT_CONTRACT_V2_PENDING_READ_CLARIFICATION_CHANGED", "PRODUCT_CONTRACT_V2_PENDING_READ_MINT_INVALID",
  "PRODUCT_CONTRACT_V2_PENDING_READ_CONFIG_INVALID",
] as const);
export interface ProductContractV2PendingSubmission {
  readonly affordance: NextAllowedCommand; readonly commandId: string; readonly correlationId: string;
  readonly payload: Readonly<Record<string, string>>; readonly requestDigest: string;
}
export interface ProductContractV2PendingView {
  readonly approval: ProductContractV2PendingSubmission | null; readonly outcome: "PENDING";
  readonly clarifications: readonly Readonly<{
    clarificationId: string; question: string;
    options: readonly Readonly<{ answer: ProductContractV2PendingSubmission; label: string;
      optionId: string; projectionDigest: string; revisionDigest: string }>[];
  }>[];
  readonly ref: Readonly<{ contractId: string; revisionDigest: string; revisionId: string }>;
  readonly revision: ProductContractRevisionV2;
}
export type ProductContractV2PendingReadResult = ProductContractV2PendingView
  | Readonly<{ outcome: "NONE" }>
  | Readonly<{ code: string; layer: string; outcome: "REFUSED" }>;
export interface ProductContractV2PendingReadPort {
  readonly boundProjectId: string; readPending(goalRef: string): ProductContractV2PendingReadResult;
}
export interface ProductContractV2PendingMintInput {
  readonly commandKind: string; readonly targetAggregateId: string; }
const none = Object.freeze({ outcome: "NONE" as const });
function refused(code: string, layer: string = LAYER): ProductContractV2PendingReadResult {
  return Object.freeze({ code, layer, outcome: "REFUSED" as const });
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && Buffer.byteLength(value, "utf8") <= 512 && value.trim() === value && !value.includes("\0")
    && value.isWellFormed() && value.normalize("NFC") === value;
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function storeFailure(error: unknown): ProductContractV2PendingReadResult {
  return refused(error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
    error instanceof DurableStoreError ? "DURABLE_STORE" : LAYER);
}
type Current = Readonly<{ revision: ProductContractRevisionV2; slot: Exclude<ReturnType<typeof readCurrentProductContractRevisionV2>, { ok: false }>["slot"] }>;
function currentForGoal(
  store: SqliteEventStore, projectId: string, goalRef: string,
): Current | ProductContractV2PendingReadResult {
  try {
    const binding = readProductContractV2GoalBinding(store, { goalRef, projectId });
    if (!binding.ok) return binding.code === "PRODUCT_CONTRACT_V2_GOAL_BINDING_ABSENT"
      ? none : refused(binding.code, binding.layer);
    const current = readCurrentProductContractRevisionV2(store, {
      contractId: binding.binding.contractId, projectId,
    });
    if (!current.ok) return refused(current.code, current.layer);
    const provenance = validateRevisionProvenance(
      store, projectId, goalRef, current.revision.sourceDocumentDigests,
    );
    if (!provenance.ok) return refused(provenance.code, provenance.layer);
    return Object.freeze({ revision: current.revision, slot: current.slot });
  } catch (error) { return storeFailure(error); }
}
function submission(config: {
  mintCommandId(input: ProductContractV2PendingMintInput): string;
  mintCorrelationId(input: ProductContractV2PendingMintInput & { commandId: string }): string;
}, commandKind: string, inputSchemaVersion: string, expectedVersion: number,
targetAggregateId: string, payload: Readonly<Record<string, string>>,
used: Set<string>, requestDigest?: string | ((commandId: string) => string)): ProductContractV2PendingSubmission | null {
  try {
    const basis = Object.freeze({ commandKind, targetAggregateId });
    const commandId = config.mintCommandId(basis);
    const correlationId = config.mintCorrelationId({ ...basis, commandId });
    if (!validId(commandId) || !validId(correlationId) || commandId === correlationId
      || used.has(commandId) || used.has(correlationId)) return null;
    used.add(commandId); used.add(correlationId);
    return Object.freeze({
      affordance: Object.freeze({ commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
        commandId, commandKind, expectedVersion, inputSchemaVersion,
        targetAggregateId } as NextAllowedCommand),
      commandId, correlationId, payload, requestDigest: typeof requestDigest === "function"
        ? requestDigest(commandId) : requestDigest ?? digest(payload),
    });
  } catch { return null; }
}
export function createProductContractV2PendingReadPort(value: ProductContractV2PendingConfig): ProductContractV2PendingReadPort {
  const config = captureProductContractV2PendingConfig(value);
  if (config === undefined) return Object.freeze({ boundProjectId: "", readPending: () => refused("PRODUCT_CONTRACT_V2_PENDING_READ_CONFIG_INVALID") });
  return Object.freeze({ boundProjectId: config.projectId, readPending(goalRef: string) {
    const active = admitV2ActiveInstallation(config.store, { projectId: config.projectId });
    if (!active.ok) return refused(active.code, active.layer);
    let source; try {
      source = createGoalSourceReadPort({ projectId: config.projectId, store: config.store })
        .read(goalRef);
    } catch (error) { return storeFailure(error); }
    if (!source.ok) return source.code === "GOAL_SOURCE_UNBOUND" ? none
      : refused(source.code, source.layer);
    const current = currentForGoal(config.store, config.projectId, goalRef);
    if (!("slot" in current)) return current;
    const ref = Object.freeze({ contractId: current.revision.contractId,
      revisionDigest: current.revision.revisionDigest, revisionId: current.revision.revisionId });
    const workflow = readProductContractV2WorkflowHead(config.store, {
      contractId: ref.contractId, projectId: config.projectId,
    });
    if (!workflow.ok) return refused(workflow.code, workflow.layer);
    if (workflow.head.goalRef !== goalRef
      || !sameProductContractV2WorkflowRef(workflow.head.currentRevision,
        current.slot.currentRevision)) {
      return refused("PRODUCT_CONTRACT_V2_WORKFLOW_CURRENT_MISMATCH",
        "PRODUCT_CONTRACT_V2_WORKFLOW");
    }
    const scan = readProductContractClarificationsV2ForContract(
      config.store, config.projectId, ref.contractId,
    );
    if (scan.kind !== "PRESENT") return refused(scan.code, scan.layer);
    const authority = resolveProductContractClarificationV2Authority(config.store, {
      committedRefs: Object.freeze([...current.slot.revisionHistory,
        current.slot.currentRevision]), contractId: ref.contractId, goalRef,
      projectId: config.projectId,
    });
    if (authority.status === "INVALID" || authority.status === "UNREADABLE") {
      return refused(authority.code, authority.layer);
    }
    const open = scan.rows.filter((row) => row.answerDecision === null);
    if (authority.status === "OPEN" && (open.length !== authority.clarificationIds.length
      || open.some((row) => !authority.clarificationIds.includes(row.clarificationId)))) {
      return refused("PRODUCT_CONTRACT_V2_PENDING_READ_CLARIFICATION_CHANGED");
    }
    if (authority.status !== "OPEN" && open.length > 0) {
      return refused("PRODUCT_CONTRACT_V2_PENDING_READ_CLARIFICATION_CHANGED");
    }
    if (authority.status !== workflow.head.clarificationStatus
      || (authority.status === "OPEN" && (workflow.head.clarificationIds.length
        !== authority.clarificationIds.length || workflow.head.clarificationIds.some(
        (id) => !authority.clarificationIds.includes(id),
      )))) return refused("PRODUCT_CONTRACT_V2_PENDING_READ_CLARIFICATION_CHANGED");
    const clarifications = []; const used = new Set<string>();
    for (const row of open) {
      const target = productContractClarificationV2AggregateId(
        config.projectId, row.contractId, row.clarificationId,
      );
      const options = [];
      for (const option of row.optionDigests) {
        const payload = Object.freeze({ answerOptionId: option.optionId,
          clarificationId: row.clarificationId, contractId: row.contractId });
        const answer = submission(config,
          PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
          PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION, 1, target, payload, used);
        if (answer === null) return refused("PRODUCT_CONTRACT_V2_PENDING_READ_MINT_INVALID");
        options.push(Object.freeze({ answer, label: option.label, optionId: option.optionId,
          projectionDigest: option.projectionDigest, revisionDigest: option.revisionDigest }));
      }
      clarifications.push(Object.freeze({ clarificationId: row.clarificationId,
        options: Object.freeze(options), question: row.question }));
    }
    let approval: ProductContractV2PendingSubmission | null = null;
    if (authority.status === "SATISFIED") {
      const approved = readProductContractGate1Approval(
        config.store, { projectId: config.projectId, ref },
      );
      if (workflow.head.effectiveGateRef !== null) {
        if (!approved.ok) return refused(approved.code, approved.layer);
        if (!sameProductContractV2WorkflowRef(workflow.head.effectiveGateRef,
          current.slot.currentRevision)) {
          return refused("PRODUCT_CONTRACT_V2_WORKFLOW_CURRENT_MISMATCH",
            "PRODUCT_CONTRACT_V2_WORKFLOW");
        }
        return none;
      }
      if (approved.ok || approved.code !== "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT") {
        return approved.ok
          ? refused("PRODUCT_CONTRACT_V2_WORKFLOW_INVALID", "PRODUCT_CONTRACT_V2_WORKFLOW")
          : refused(approved.code, approved.layer);
      }
      const workRef = productContractGate1Authority(ref).workRef;
      const target = deriveProductContractGate1AggregateId(workRef);
      const payload = Object.freeze({ ...ref });
      approval = submission(config,
        PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION, 0,
        target, payload, used, (commandId) => productContractGate1SubjectDigest({ commandId,
          projectId: config.projectId, workRef }));
      if (approval === null) return refused("PRODUCT_CONTRACT_V2_PENDING_READ_MINT_INVALID");
    }
    return Object.freeze({ approval, clarifications: Object.freeze(clarifications),
      outcome: "PENDING" as const, ref, revision: current.revision });
  } });
}
type ListenerCode = "LISTENER_PRODUCT_CONTRACT_V2_PENDING_REQUEST_INVALID" | "LISTENER_PRODUCT_CONTRACT_V2_PENDING_UNAVAILABLE";
export type ProductContractV2PendingReadDispatch = Readonly<{
  body: HttpPortRefused | HttpRefused | ProductContractV2PendingReadResult; httpStatus: number; kind: "REPLY";
}> | Readonly<{ code: ListenerCode; kind: "LISTENER_REFUSAL" }>;
function requestedGoalRef(body: unknown): string | null {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const record = exactDataRecord(decoded.value, REQUEST_KEYS);
  return validId(record?.["goalRef"]) ? record["goalRef"] : null;
}
export function handleProductContractV2PendingReadRequest(dependencies: {
  readonly authenticator: Authenticator; readonly productContractV2Pending?: ProductContractV2PendingReadPort;
}, request: { readonly body: unknown; readonly credential: string | null;
  readonly protocolVersion: unknown }): ProductContractV2PendingReadDispatch {
  const access = authenticateHttpRequest(dependencies.authenticator, request.credential, request.protocolVersion);
  if (!access.ok) return Object.freeze({ body: access, httpStatus: access.httpStatus,
    kind: "REPLY" as const });
  if (!access.principal.capabilities.includes(CAPABILITIES.PLANNING)) {
    return Object.freeze({ body: refused("PRODUCT_CONTRACT_V2_PENDING_READ_CAPABILITY_DENIED"),
      httpStatus: 200, kind: "REPLY" as const });
  }
  const port = dependencies.productContractV2Pending;
  if (port === undefined) return Object.freeze({ code: "LISTENER_PRODUCT_CONTRACT_V2_PENDING_UNAVAILABLE",
    kind: "LISTENER_REFUSAL" as const });
  if (access.principal.projectId !== port.boundProjectId) return Object.freeze({
    body: refused("PRODUCT_CONTRACT_V2_PENDING_READ_PROJECT_MISMATCH"), httpStatus: 200,
    kind: "REPLY" as const });
  const goalRef = requestedGoalRef(request.body);
  if (goalRef === null) return Object.freeze({ code: "LISTENER_PRODUCT_CONTRACT_V2_PENDING_REQUEST_INVALID",
    kind: "LISTENER_REFUSAL" as const });
  return Object.freeze({ body: port.readPending(goalRef), httpStatus: 200, kind: "REPLY" as const });
}
