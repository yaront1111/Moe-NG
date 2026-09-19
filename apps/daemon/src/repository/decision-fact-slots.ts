import { createHash } from "node:crypto";
import type {
  CommandDecisionKey, CommandDecisionRecord, CommandDecisionResponse, CommitExpectedVersionDecisionInput, SqliteEventStore,
} from "@moe/store";

/**
 * Facts written once under a DETERMINISTIC decision key, on an aggregate other writers share.
 * The store persists a lost version race as a NO_BUSINESS_EFFECT decision under the caller's key,
 * so such a fact used to be burned by one sub-millisecond race forever (task-978669b6).
 * Slot 0 is the canonical key, so every fact written before this module still reads; a burned
 * slot sends the write, and every read, to the next one.
 */

export const FACT_WRITE_ATTEMPTS = 3;
export const FACT_SLOT_LIMIT = 32;

export type FactDecisionKey = Omit<CommandDecisionKey, "commandId">;
export type FactDecisionDraft = (commandId: string) => Omit<CommitExpectedVersionDecisionInput, "expectedVersion" | "key">;
export interface FactSlot {
  readonly commandId: string;
  readonly record: CommandDecisionRecord | null;
}

export function factSlotCommandId(canonicalId: string, slot: number): string {
  return slot === 0 ? canonicalId : createHash("sha256").update(JSON.stringify(["fact-slot", canonicalId, slot])).digest("hex");
}

/** The first slot that is empty or not burned (this kind lost a race there); the last slot once the chain is exhausted. */
export function findFactDecision(
  store: SqliteEventStore, key: FactDecisionKey, canonicalId: string, commandKind: string,
): FactSlot {
  let found: FactSlot = { commandId: canonicalId, record: null };
  for (let slot = 0; slot < FACT_SLOT_LIMIT; slot += 1) {
    const commandId = factSlotCommandId(canonicalId, slot);
    found = { commandId, record: store.getCommandDecision({ ...key, commandId }) };
    if (found.record?.commandKind !== commandKind || found.record.effectDisposition !== "NO_BUSINESS_EFFECT") return found;
  }
  return found;
}

/**
 * Writes at the first unburned slot, moving on after each lost race. An occupied slot is re-sent at
 * ITS OWN fence, because the fence is part of the request identity: a true retry then replays, and
 * different bytes still throw IdempotencyConflictError. Answers the last response when every attempt lost.
 */
export function commitFactDecision(
  store: SqliteEventStore, key: FactDecisionKey, canonicalId: string, commandKind: string, draft: FactDecisionDraft,
): CommandDecisionResponse {
  for (let attempt = 1; ; attempt += 1) {
    const { commandId, record } = findFactDecision(store, key, canonicalId, commandKind);
    const input = draft(commandId);
    const response = store.commitExpectedVersionDecision({ ...input, key: { ...key, commandId },
      expectedVersion: record?.expectedVersion ?? store.getAggregateVersion(input.targetAggregateId) });
    if (response.decision.effectDisposition === "EFFECTS_COMMITTED" || attempt >= FACT_WRITE_ATTEMPTS) return response;
  }
}
