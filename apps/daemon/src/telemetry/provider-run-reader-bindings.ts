/**
 * ONE candidate provider-run row, judged whole against the ledger that wrote it.
 *
 * Split out of `provider-run-reader.ts` because the two together overran the
 * 250-line target. The seam is a real one rather than a convenience: this module
 * decides whether a single row IS a committed provider run, and knows nothing
 * about horizons, pages, cursors, attempts or activations. The reader beside it
 * owns the walk and the join, and can reach a per-row conclusion only through
 * `verifyProviderRunCandidate`. The dependency runs one way — reader imports
 * bindings, never the reverse — so the refusal constructors both share live here
 * rather than in a cycle between them.
 *
 * IDENTITY IS RE-DERIVED FROM THE DECODED REF, never read back from the event's
 * own fields. `deriveProviderRunAggregateId` and `deriveProviderRunEventId` are
 * length-framed, domain-separated digests over the run identity, and the
 * contract that mints them warns that only the digest is stored, so "later
 * readers must compare it rather than treating hash uniqueness as authority".
 * Comparing `event.aggregateId` against itself would be a check that can never
 * fail; comparing it against the derivation over `record.providerRunRef` is a
 * check the mutation table can and does redden.
 *
 * THE DECISION UNION IS DISCRIMINATED BEFORE ITS VERSIONS ARE READ.
 * `NoBusinessEffectDecision` carries NULL versions, so a naive
 * `previousVersion === 0` on one is `null === 0` — false, quietly, rather than a
 * type error. `effectDisposition` is therefore settled first, and only then are
 * the 0 -> 1 versions compared.
 */

import { DurableStoreError } from "@moe/store";
import type {
  CommandDecisionKey, CommandDecisionRecord, CommandReceipt, DurableStoreErrorCode,
  EffectsCommittedDecision, StoredEvent,
} from "@moe/store";

import { decodeProviderRunRecord } from "./provider-run-codec.js";
import {
  PROVIDER_RUN_COMMAND_KIND, PROVIDER_RUN_RECORD_VERSION, deriveProviderRunAggregateId,
} from "./provider-run-contracts.js";
import type { ProviderRunRecord } from "./provider-run-contracts.js";
import { deriveProviderRunEventId } from "./provider-run-ledger.js";
import { providerRunUnknown } from "./provider-run-refusals.js";
import type {
  ProviderRunCode, ProviderRunLayer, ProviderRunRefusal,
} from "./provider-run-refusals.js";

/** TWO READERS, which is every store fact a single row's provenance needs. */
export interface ProviderRunEvidenceStore {
  getCommandDecision(key: CommandDecisionKey): CommandDecisionRecord | null;
  getCommandReceipt(commandId: string): CommandReceipt | null;
}

/** Every fact a verified row carries forward. The DECISION rides along because
 *  the activation join needs its principal, and re-reading it there would be a
 *  second answer that can disagree with this one. */
export interface ProviderRunCandidate {
  readonly decision: EffectsCommittedDecision;
  readonly digest: string;
  readonly event: StoredEvent;
  readonly record: ProviderRunRecord;
}

/** MODULE-PRIVATE, and typed rather than indexed. Exporting a second name for a
 *  layer the refusal vocabulary already owns would be duplicate authority, and an
 *  `export const *_LAYER` is also what the boundary roster scans for. Typing it as
 *  `ProviderRunLayer` is what an index into the frozen roster could not give: if
 *  the member is ever renamed or dropped, this stops compiling instead of
 *  silently re-pointing at whichever layer moved into that slot. */
const READ_LAYER: ProviderRunLayer = "PROVIDER_RUN_READER";
const MISMATCH = "PROVIDER_RUN_BINDING_MISMATCH";
const UNREADABLE = "PROVIDER_RUN_EVIDENCE_UNREADABLE";

/** Reader refusals are always UNKNOWN: unverifiable evidence confers nothing. */
export const refuseRead = (
  code: ProviderRunCode, storeCode: DurableStoreErrorCode | null = null,
): ProviderRunRefusal => providerRunUnknown(code, READ_LAYER, storeCode);

/** A store throw keeps its OWN code verbatim; a foreign throw invents none. */
export const refuseThrown = (error: unknown): ProviderRunRefusal =>
  refuseRead(UNREADABLE, error instanceof DurableStoreError ? error.code : null);

/** The `instanceof` pair is load-bearing: two non-binary payloads both report an
 *  `undefined` byteLength, so without it a contract-breaking store would reach
 *  `.every` and CRASH where this module has to refuse. */
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left instanceof Uint8Array && right instanceof Uint8Array &&
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

/** The DECISION half. Its `requestSha256` is the SCOPED-COMMAND digest and is
 *  compared to the TRACE's, never to the event's. */
function decisionAgrees(
  decision: CommandDecisionRecord, event: StoredEvent,
  trace: NonNullable<StoredEvent["decisionTrace"]>, aggregateId: string,
): decision is EffectsCommittedDecision {
  return decision.effectDisposition === "EFFECTS_COMMITTED" &&
    decision.commandKind === PROVIDER_RUN_COMMAND_KIND &&
    decision.expectedVersion === 0 && decision.observedVersion === 0 &&
    decision.previousVersion === 0 && decision.currentVersion === 1 &&
    decision.key.commandId === trace.commandId &&
    decision.key.principalId === trace.principalId &&
    decision.key.projectId === trace.projectId &&
    decision.targetAggregateId === aggregateId &&
    decision.businessEventIds.length === 1 && decision.businessEventIds[0] === event.eventId &&
    decision.outboxMessageIds.length === 0 &&
    decision.requestSha256 === trace.requestSha256 &&
    sameBytes(decision.resultBytes, event.payload);
}

/** The EFFECT half. Its `requestSha256` is the EFFECT digest, a DIFFERENT domain,
 *  compared to the event's and never to the trace's. Zero outbox is ASSERTED on
 *  both halves rather than assumed: this ledger publishes nothing. */
const receiptAgrees = (receipt: CommandReceipt, event: StoredEvent, effect: string): boolean =>
  receipt.commandId === event.commandId && receipt.aggregateId === event.aggregateId &&
  receipt.previousVersion === 0 && receipt.currentVersion === 1 &&
  receipt.eventIds.length === 1 && receipt.eventIds[0] === event.eventId &&
  receipt.outboxMessageIds.length === 0 && receipt.committedAt.length > 0 &&
  receipt.effectSha256 === effect && receipt.requestSha256 === event.requestSha256;

/**
 * One candidate, judged in provenance order: bytes, then identity, then the
 * decision, then the receipt. The DECISION is keyed by the trace's command id and
 * the RECEIPT by `event.commandId`; those are different ids and swapping them
 * reads null, which is why each is named at its own call.
 */
export function verifyProviderRunCandidate(
  store: ProviderRunEvidenceStore, event: StoredEvent, projectId: string,
): ProviderRunCandidate | ProviderRunRefusal {
  const decoded = decodeProviderRunRecord(event.payload);
  if (!decoded.ok) return refuseRead("PROVIDER_RUN_RECORD_UNREADABLE");
  const { record } = decoded;
  const aggregateId = deriveProviderRunAggregateId(record.providerRunRef);
  if (event.aggregateId !== aggregateId) return refuseRead(MISMATCH);
  if (event.eventId !== deriveProviderRunEventId(record.providerRunRef)) return refuseRead(MISMATCH);
  if (event.aggregateSequence !== 1) return refuseRead(MISMATCH);
  if (record.recordVersion !== PROVIDER_RUN_RECORD_VERSION) return refuseRead(MISMATCH);
  const trace = event.decisionTrace;
  // No trace is evidence that never arrived rather than evidence that disagrees.
  if (trace === undefined) return refuseRead("PROVIDER_RUN_EVIDENCE_MALFORMED");
  if (trace.projectId !== projectId) return refuseRead(MISMATCH);
  if (trace.commandKind !== PROVIDER_RUN_COMMAND_KIND) return refuseRead(MISMATCH);
  let decision: CommandDecisionRecord | null;
  const key = { commandId: trace.commandId, principalId: trace.principalId, projectId };
  try { decision = store.getCommandDecision(key); } catch (error) { return refuseThrown(error); }
  // Absent, not disagreeing: nothing threw, so there is no upstream code to carry
  // and inventing one would be a fabricated provenance.
  if (decision === null) return refuseRead(UNREADABLE);
  if (!decisionAgrees(decision, event, trace, aggregateId)) return refuseRead(MISMATCH);
  let receipt: CommandReceipt | null;
  try { receipt = store.getCommandReceipt(event.commandId); } catch (e) { return refuseThrown(e); }
  if (receipt === null) return refuseRead(UNREADABLE);
  if (!receiptAgrees(receipt, event, decision.effectSha256)) return refuseRead(MISMATCH);
  return { decision, digest: decoded.digest, event, record };
}
