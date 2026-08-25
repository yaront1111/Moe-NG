/**
 * Durable identities and exact codecs for the two aggregates one expansion request writes.
 *
 * NEITHER DECODER RESTATES A VALIDATION RULE. Both hand the decoded bytes back to the production
 * reducer that produced them and keep only what the reducer vouches for:
 *
 *   the hold  `reduceExpansionPlanningHold(candidate, null)` — a null command can never parse, so
 *             the reducer takes its INPUT_INVALID branch and returns `parseState(candidate)`:
 *             core's own state parser, applied to stored bytes, with the stored lifecycle and
 *             version PRESERVED. Replaying the creation command instead would have laundered a
 *             terminated hold back into an ACTIVE one, because the replay branch answers with the
 *             OPENING state. That is the difference between reading the ledger and rewriting it;
 *   the run   the stored creation COMMAND is re-reduced from `undefined` and the derived state is
 *             compared to the stored one. A run record whose state was edited after the fact no
 *             longer matches what its own command produces, so it decodes as nothing at all.
 *
 * WHY THE HOLD GETS ITS OWN AGGREGATE PREFIX. `expansion-hold:<projectId>:<holdId>` makes the
 * project a structural part of the key, so a cross-project read is not a comparison this code
 * could forget to make — `enumerateAggregateIdsByPrefix` simply cannot see another project's
 * holds. The PlanningRun keeps `runId` as its aggregate id, exactly as `planning-services.ts`
 * already writes it; inventing a second run identity here would fork the run's durable history.
 *
 * This module performs no I/O and mints no authority.
 */

import {
  reduceExpansionPlanningHold, reducePlanningRun, snapshotPlanningRunContractState,
} from "@moe/core";
import type {
  ExpansionPlanningHoldState,
  PlanningCreateDraftCommand,
  PlanningRunContractState,
} from "@moe/core";

import { deepFreezeExpansionValue } from "./expansion-request-contracts.js";

export const EXPANSION_HOLD_EVENT_TYPE = "ExpansionPlanningHoldCreated";
/**
 * Deliberately NOT "PlanningRunCreated". That name is core's domain-event kind and the natural
 * choice for a future INITIAL-run writer on the same aggregate family; a collision would make
 * this decoder answer MALFORMED for a perfectly healthy foreign record. Distinct name, no clash.
 */
export const EXPANSION_RUN_EVENT_TYPE = "ExpansionPlanningRunCreated";
export const EXPANSION_HOLD_AGGREGATE_NAMESPACE = "expansion-hold";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Every hold aggregate of one project shares this prefix, and no other project's does. */
export function expansionHoldAggregatePrefix(projectId: string): string {
  return `${EXPANSION_HOLD_AGGREGATE_NAMESPACE}:${projectId}:`;
}

export function expansionHoldAggregateId(projectId: string, holdId: string): string {
  return `${expansionHoldAggregatePrefix(projectId)}${holdId}`;
}

/** The hold-leg event payload: the complete reducer-produced state, and nothing else. */
export interface ExpansionHoldRecord {
  readonly state: ExpansionPlanningHoldState;
}

/** The run-leg event payload: the creation command AND the state it produced. */
export interface ExpansionRunRecord {
  readonly command: PlanningCreateDraftCommand;
  readonly state: PlanningRunContractState;
}

function bytesOf(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function jsonOf(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function exactly(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key))
    ? value as Record<string, unknown> : null;
}

export function encodeExpansionHoldRecord(state: ExpansionPlanningHoldState): Uint8Array {
  return bytesOf({ state } satisfies ExpansionHoldRecord);
}

/**
 * Returns the state CORE vouches for, with its stored lifecycle and version intact, or null when
 * core refuses the bytes. `verdict.ok` is unreachable by construction — a null command cannot
 * parse — but it is handled rather than asserted, because an unreachable throw in a durable
 * reader is a crash where a refusal belongs.
 */
export function decodeExpansionHoldRecord(
  bytes: Uint8Array,
): ExpansionPlanningHoldState | null {
  const record = exactly(jsonOf(bytes), ["state"]);
  if (record === null) return null;
  const verdict = reduceExpansionPlanningHold(
    record["state"] as ExpansionPlanningHoldState, null,
  );
  return verdict.ok ? null : verdict.state;
}

export function encodeExpansionRunRecord(record: ExpansionRunRecord): Uint8Array {
  return bytesOf({ command: record.command, state: record.state });
}

/**
 * Re-derives the run from its OWN stored command and returns the result only when the derivation
 * reproduces the stored state exactly. The comparison is over canonical JSON of both sides: the
 * reducer emits a deterministic key order, so one comparison covers every member and cannot
 * silently omit the one that was edited.
 */
export function decodeExpansionRunRecord(bytes: Uint8Array): ExpansionRunRecord | null {
  const record = exactly(jsonOf(bytes), ["command", "state"]);
  if (record === null) return null;
  const command = record["command"] as PlanningCreateDraftCommand;
  if (typeof command !== "object" || command === null) return null;
  const verdict = reducePlanningRun(undefined, command);
  if (!verdict.ok) return null;
  // The contract narrowing is core's own, not a local cast: an EXPANSION run without a binding
  // is not representable as a `PlanningRunContractState` and decodes as nothing.
  const state = snapshotPlanningRunContractState(verdict.state);
  if (state === undefined) return null;
  if (JSON.stringify(state) !== JSON.stringify(record["state"])) return null;
  // The reducer deep-freezes the state; the stored COMMAND is frozen here so no consumer
  // can edit a decoded record and hand it on as if the ledger had said it.
  return deepFreezeExpansionValue({ command, state });
}

/** The two event ids one request mints. Deterministic, so a replay cannot mint a third. */
export function expansionHoldEventId(commandId: string): string {
  return `${commandId}:expansion-hold`;
}

export function expansionRunEventId(commandId: string): string {
  return `${commandId}:expansion-run`;
}
