import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";

import { decodeBinding, encodeBinding } from "./recovery-incarnation-binding-codec.js";
import type {
  GenesisIncarnationBinding,
  RecoveryIncarnationBinding,
  RestoreIncarnationBinding,
} from "./recovery-incarnation-contract.js";
import type { RecoveryIncarnationOrigin } from "./recovery-incarnation-context.js";
import {
  RECOVERY_INCARNATION_ANCHOR_COMMAND_KIND,
  incarnationAggregateId,
} from "./recovery-succession-contract.js";
import type { RecoveryDurableWriteRequest } from "./recovery-succession-contract.js";

/**
 * The durable half of recovery incarnation identity.
 *
 * Minting produces a binding that is fully serializable and proves itself, but
 * nothing about being serializable makes it a FACT: until a row exists, "I held
 * incarnation X" is only a caller's assertion, and a caller can mint a throwaway
 * incarnation whose binding passes every self-check. Anchoring is what makes the
 * predecessor of a succession something the daemon observed rather than
 * something it was told.
 *
 * The private key is not anchored and cannot be: it dies with its process by
 * design. Only public bytes are written here.
 */
const PAGE_SIZE = 100;
const encoder = new TextEncoder();

/**
 * The exact store capabilities each half needs, so a caller holding a narrower
 * handle than the whole event store can still anchor and read anchors.
 */
export type AnchorDecisionReader = Pick<SqliteEventStore, "readCommandDecisionsAfter">;
export type AnchorDecisionWriter = AnchorDecisionReader &
  Pick<SqliteEventStore, "commitExpectedVersionDecision">;

function isAnchorRow(decision: CommandDecisionRecord, projectId: string): boolean {
  return (
    decision.key.projectId === projectId &&
    decision.commandKind === RECOVERY_INCARNATION_ANCHOR_COMMAND_KIND &&
    decision.effectDisposition === "EFFECTS_COMMITTED"
  );
}

/**
 * Whether ANY incarnation was ever anchored for this project. An anchor with no
 * installed binding is a restore waiting to quiesce, so the genesis installer
 * asks this before treating an empty ACTIVE slot as a store with no recovery
 * history at all.
 */
export function hasAnchoredIncarnation(
  store: Pick<SqliteEventStore, "readCommandDecisionsAfter">,
  projectId: string,
): boolean {
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, PAGE_SIZE);
    if (page.items.some((decision) => isAnchorRow(decision, projectId))) return true;
    if (!page.hasMore || page.nextCursor === null) return false;
    cursor = page.nextCursor;
  }
}

/**
 * The one anchor scan, parameterized by the origin the CALLER asked about.
 *
 * The origin is a filter rather than a field read off the answer, so a reader
 * asking about a restore lineage can never be handed a genesis row to re-refuse
 * — and vice versa. The aggregate id is recomputed from the DECODED content, so
 * a row filed under one incarnation while carrying another's binding is dropped
 * rather than answered with.
 */
function readAnchoredBindingOfOrigin(
  store: AnchorDecisionReader,
  projectId: string,
  incarnationRef: string,
  origin: RecoveryIncarnationOrigin,
): RecoveryIncarnationBinding | null {
  const wanted = incarnationAggregateId(incarnationRef);
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, PAGE_SIZE);
    for (const decision of page.items) {
      if (!isAnchorRow(decision, projectId) || decision.targetAggregateId !== wanted) continue;
      const binding = decodeBinding(decision.resultBytes);
      if (binding === null || binding.origin !== origin) continue;
      if (incarnationAggregateId(binding.incarnationRef) !== wanted) continue;
      return binding;
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return null;
}

/**
 * Returns the anchored RESTORE binding for one incarnation, or null when
 * nothing anchored it.
 *
 * Every caller of this reader — the restore controller, the succession chain,
 * the inventory ledger — asks about a restore lineage and reads restore facts
 * off the answer. A GENESIS row therefore reads as ABSENT here rather than
 * being handed back for each of them to re-refuse: one place fails closed, and
 * the return type says so. Genesis has its own reader below.
 */
export function readAnchoredIncarnation(
  store: AnchorDecisionReader,
  projectId: string,
  incarnationRef: string,
): RestoreIncarnationBinding | null {
  const binding = readAnchoredBindingOfOrigin(store, projectId, incarnationRef, "RESTORE");
  return binding !== null && binding.origin === "RESTORE" ? binding : null;
}

/**
 * The genesis half, deliberately a SEPARATE export rather than a widened return
 * type on the restore reader: a restore caller that started receiving genesis
 * rows would read `restoreCommandId` off a store that never restored.
 *
 * A genesis fence is anchored the same way a restore incarnation is, so the
 * classifier can compare the ACTIVE row's bytes against something the daemon
 * durably observed rather than against the row's own claim about itself.
 */
export function readAnchoredGenesisIncarnation(
  store: AnchorDecisionReader,
  projectId: string,
  incarnationRef: string,
): GenesisIncarnationBinding | null {
  const binding = readAnchoredBindingOfOrigin(store, projectId, incarnationRef, "GENESIS");
  return binding !== null && binding.origin === "GENESIS" ? binding : null;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Anchors one incarnation, single-shot. `expectedVersion: 0` against an
 * aggregate keyed on the incarnation itself means the STORE refuses the second
 * anchor; nothing here reads-then-writes and hopes.
 *
 * Returns false only for that version conflict, which the store RETURNS as a
 * NO_BUSINESS_EFFECT decision. There is deliberately no try/catch: a genuine
 * store fault throws and must keep throwing, because a catch-all here would
 * report a real database failure as a benign duplicate.
 *
 * Re-anchoring the identical binding is idempotent, which is what makes a crash
 * between anchoring and recording the succession recoverable by simply retrying.
 */
export function anchorIncarnation(
  store: AnchorDecisionWriter,
  request: RecoveryDurableWriteRequest,
  binding: RecoveryIncarnationBinding,
): boolean {
  const bytes = encodeBinding(binding);
  const aggregateId = incarnationAggregateId(binding.incarnationRef);
  // Looked up under the binding's OWN origin. Asking the restore reader about a
  // genesis binding would always answer null, so every re-anchor would fall
  // through to a second write and be refused as a version conflict — an
  // idempotent retry reported as a failure.
  const existing = readAnchoredBindingOfOrigin(
    store,
    request.projectId,
    binding.incarnationRef,
    binding.origin,
  );
  if (existing !== null) return sameBytes(encodeBinding(existing), bytes);

  const commandId = `recovery-incarnate:${binding.incarnationRef}`;
  const response = store.commitExpectedVersionDecision({
    commandKind: RECOVERY_INCARNATION_ANCHOR_COMMAND_KIND,
    committedResultBytes: bytes,
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [
      {
        eventId: `${commandId}:anchored`,
        eventType: "RecoveryIncarnationAnchored",
        payload: bytes,
      },
    ],
    expectedVersion: 0,
    key: { commandId, principalId: request.principalId, projectId: request.projectId },
    requestBytes: encoder.encode(
      JSON.stringify({ incarnationRef: binding.incarnationRef, intent: "ANCHOR" }),
    ),
    targetAggregateId: aggregateId,
  });
  return response.decision.effectDisposition === "EFFECTS_COMMITTED";
}
