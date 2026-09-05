import { createHash } from "node:crypto";
import type { ProductContractRevisionRef } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";
import { readProductContractRevision } from "../product-contract/product-contract-revision-reader.js";
import { planningAuthorityAggregateId } from "./planning-authority-persistence.js";

export const COMPILED_CONTRACT_BINDING_VERSION = "moe-compiled-contract/1" as const;
export interface CompiledContractBinding {
  readonly version: typeof COMPILED_CONTRACT_BINDING_VERSION;
  readonly projectId: string;
  readonly goalRef: string;
  readonly planningRunRef: string;
  readonly contractRef: ProductContractRevisionRef;
  readonly graphContentHash: string;
  readonly submissionHash: string;
}
export const compiledContractAggregateId = (projectId: string, runId: string): string =>
  `compiled-contract/${createHash("sha256").update(JSON.stringify([
    COMPILED_CONTRACT_BINDING_VERSION, projectId, runId,
  ])).digest("hex")}`;
export const compiledContractBytes = (binding: CompiledContractBinding): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(binding));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const hex = (value: unknown): value is string => text(value) && /^[0-9a-f]{64}$/u.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function decodeCompiledContractBinding(bytes: Uint8Array): CompiledContractBinding | null {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; }
  if (!object(value) || Object.keys(value).sort().join() !== ["version", "projectId", "goalRef",
    "planningRunRef", "contractRef", "graphContentHash", "submissionHash"].sort().join()
    || value["version"] !== COMPILED_CONTRACT_BINDING_VERSION || !text(value["projectId"])
    || !text(value["goalRef"]) || !text(value["planningRunRef"]) || !hex(value["graphContentHash"])
    || !hex(value["submissionHash"])) return null;
  const ref = value["contractRef"];
  if (!object(ref) || Object.keys(ref).sort().join() !== "contractId,revisionDigest,revisionId"
    || !text(ref["contractId"]) || !text(ref["revisionId"]) || !hex(ref["revisionDigest"])) return null;
  return Object.freeze({ version: COMPILED_CONTRACT_BINDING_VERSION, projectId: value["projectId"],
    goalRef: value["goalRef"], planningRunRef: value["planningRunRef"],
    graphContentHash: value["graphContentHash"], submissionHash: value["submissionHash"],
    contractRef: Object.freeze({ contractId: ref["contractId"], revisionId: ref["revisionId"], revisionDigest: ref["revisionDigest"] }) });
}
export type CompiledContractBindingRead = Readonly<{ ok: true; binding: CompiledContractBinding }>
  | Readonly<{ ok: false; code: "COMPILED_CONTRACT_BINDING_ABSENT" | "COMPILED_CONTRACT_BINDING_INVALID" }>;

/** The binding is a secondary leg of PlanProposed, never a retrospective text match. */
export function readCompiledContractBinding(
  store: SqliteEventStore, projectId: string, planningRunRef: string,
): CompiledContractBindingRead {
  const invalid = { ok: false, code: "COMPILED_CONTRACT_BINDING_INVALID" } as const;
  try {
    const aggregateId = compiledContractAggregateId(projectId, planningRunRef);
    const page = store.readAggregateEvents(aggregateId, 0, 2);
    if (!page.hasMore && page.items.length === 0) return { ok: false, code: "COMPILED_CONTRACT_BINDING_ABSENT" };
    if (page.hasMore || page.items.length !== 1) return invalid;
    const event = page.items[0]!;
    const binding = decodeCompiledContractBinding(event.payload);
    const trace = event.decisionTrace;
    if (binding === null || binding.projectId !== projectId || binding.planningRunRef !== planningRunRef
      || event.aggregateId !== aggregateId || event.aggregateSequence !== 1 || event.eventType !== "CompiledContractBound"
      || trace === undefined || trace.commandKind !== "plan.propose" || trace.projectId !== projectId) return invalid;
    const decision = store.getCommandDecision({ commandId: trace.commandId, principalId: trace.principalId, projectId });
    if (decision === null || decision.effectDisposition !== "EFFECTS_COMMITTED" || decision.commandKind !== "plan.propose"
      || decision.targetAggregateId !== planningRunRef || decision.requestSha256 !== trace.requestSha256) return invalid;
    const bodies = store.readAggregateEvents(planningAuthorityAggregateId(planningRunRef), 0, 10).items
      .filter((item) => item.eventType === "PlanningAuthorityBodiesSealed");
    if (bodies.length !== 1) return invalid;
    const bodyEvent = bodies[0]!;
    if (JSON.stringify(bodyEvent.decisionTrace) !== JSON.stringify(trace)) return invalid;
    const body: unknown = JSON.parse(Buffer.from(bodyEvent.payload).toString("utf8"));
    if (!object(body) || body["projectId"] !== projectId || body["goalRef"] !== binding.goalRef
      || body["runId"] !== planningRunRef || body["graphContentHash"] !== binding.graphContentHash
      || body["submissionHash"] !== binding.submissionHash) return invalid;
    const revision = readProductContractRevision(store, { projectId, ref: binding.contractRef });
    return revision.ok ? { ok: true, binding } : invalid;
  } catch { return invalid; }
}
