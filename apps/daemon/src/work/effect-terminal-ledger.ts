/**
 * The only production writer of a terminal effect, and the only strict reader of one.
 *
 * TERMINALITY IS NOT DECIDED HERE. The daemon holds two durable facts — the activation's
 * `EffectIntent` and the committed provider run — and hands both to the runner's
 * `settleEffectFromProviderObservation`, whose output is persisted UNCHANGED. That mapper
 * exists because the reducer beneath it accepts a caller-chosen `target`, so the only way to
 * make the wrong terminal unreachable is to never let anything choose one. This module
 * therefore takes no terminal state, outcome class, result bytes or intent id from its caller:
 * they are not parameters, so there is no arm in which a caller value could win.
 *
 * `FoundationAttemptRecorded` is advisory and terminalises nothing; an attempt with no
 * committed provider run is EVIDENCE_ABSENT here, never a quiet success.
 */

import { PROVIDER_TELEMETRY_CONTRACT_VERSION, settleEffectFromProviderObservation } from "@moe/runner";
import type { CommandDecisionResponse, SqliteEventStore } from "@moe/store";

import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import { readActivationLedgerRecord } from "../activation/activation-ledger-reader.js";
import { readCurrentProviderRun } from "../telemetry/provider-run-reader.js";
import {
  EFFECT_TERMINAL_COMMAND_KIND,
  EFFECT_TERMINAL_EVENT_TYPE,
  EFFECT_TERMINAL_RECORD_VERSION,
  decodeTerminalEffectRecord,
  deriveTerminalEffectAggregateId,
  deriveTerminalEffectEventId,
  encodeTerminalEffectRecord,
  exactKeys,
  isText,
  refuseTerminal,
} from "./effect-terminal-contracts.js";
import type {
  EffectTerminalRecord,
  EffectTerminalRefusal,
  EffectTerminalSelector,
} from "./effect-terminal-contracts.js";

export {
  EFFECT_TERMINAL_CODES, EFFECT_TERMINAL_EVENT_TYPE, deriveTerminalEffectAggregateId,
  encodeTerminalEffectRecord,
} from "./effect-terminal-contracts.js";
export type {
  EffectTerminalCode, EffectTerminalLayer, EffectTerminalRecord, EffectTerminalRefusal,
  EffectTerminalSelector, EffectTerminalUpstream,
} from "./effect-terminal-contracts.js";

export interface EffectTerminalSuccess {
  readonly ok: true;
  readonly record: EffectTerminalRecord;
}

export type EffectTerminalResult = EffectTerminalSuccess | EffectTerminalRefusal;

const EXPECTED_VERSION = 0;
const TERMINAL_STATES: readonly string[] = Object.freeze(["SUCCEEDED", "FAILED", "CANCELLED"]);

/** Every terminal event on the identity's own aggregate, in commit order. */
function terminalEvents(store: SqliteEventStore, aggregateId: string): readonly Uint8Array[] {
  return store
    .readEvents(aggregateId)
    .filter((event) => event.eventType === EFFECT_TERMINAL_EVENT_TYPE)
    .map((event) => event.payload);
}

/**
 * The strict current reader. Arms are ordered so a corrupt record can never be masked by a
 * later one: an undecodable or non-canonical row refuses BEFORE any winner is chosen.
 */
export function readCurrentTerminalEffect(
  store: SqliteEventStore,
  selector: unknown,
): EffectTerminalResult {
  const request = exactKeys(selector, ["attemptRef", "intentId", "projectId"]);
  if (request === null || !isText(request.attemptRef) || !isText(request.intentId)
    || !isText(request.projectId)) {
    return refuseTerminal("EFFECT_TERMINAL_REQUEST_INVALID", "selector is not an exact record");
  }
  const bound = request as unknown as EffectTerminalSelector;
  let payloads: readonly Uint8Array[];
  try {
    payloads = terminalEvents(store, deriveTerminalEffectAggregateId(bound));
  } catch (error) {
    return refuseTerminal("EFFECT_TERMINAL_UNREADABLE",
      `durable read failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
  if (payloads.length === 0) {
    return refuseTerminal("EFFECT_TERMINAL_ABSENT", "no terminal record for this identity");
  }
  const decoded = payloads.map((payload) => decodeTerminalEffectRecord(payload));
  if (decoded.some((entry) => !entry.ok)) {
    // Undecodable JSON and a decoding-but-non-canonical record are DIFFERENT failures: the
    // first is unreadable evidence, the second is evidence this codec did not write.
    return decoded.some((entry) => !entry.ok && entry.reason === "UNREADABLE")
      ? refuseTerminal("EFFECT_TERMINAL_UNREADABLE", "a durable terminal payload does not decode")
      : refuseTerminal("EFFECT_TERMINAL_MALFORMED", "durable bytes are not this codec's output");
  }
  const records = decoded.map((entry) => (entry as { readonly record: EffectTerminalRecord }).record);
  const distinct = new Set(records.map((record) => encodeTerminalEffectRecord(record).toString()));
  if (distinct.size > 1) {
    return refuseTerminal("EFFECT_TERMINAL_AMBIGUOUS",
      `${String(distinct.size)} terminal records claim this identity`);
  }
  return Object.freeze({ ok: true as const, record: records[0]! });
}

interface Derived {
  readonly ok: true;
  readonly record: EffectTerminalRecord;
  readonly selector: EffectTerminalSelector;
}

/** Reads the two durable facts and lets the RUNNER decide; never decides itself. */
function deriveTerminal(
  store: SqliteEventStore,
  projectId: string,
  attemptRef: string,
): Derived | EffectTerminalRefusal {
  const binding = readFoundationActivationByAttempt(store, projectId, attemptRef);
  if (binding.status !== "BOUND") {
    const absent = binding as unknown as Record<string, unknown>;
    return refuseTerminal("EFFECT_TERMINAL_EVIDENCE_ABSENT", "no bound activation for this attempt",
      { code: String(absent.code ?? binding.status), layer: "FOUNDATION_ACTIVATION_BINDING" });
  }
  // The binding is primitives-only by design, so the durable INTENT is read from the activation
  // ledger record itself rather than reconstructed from the id the binding carries.
  const decoded = readActivationLedgerRecord(
    binding.activationAggregateId,
    store.readEvents(binding.activationAggregateId),
  );
  if (!decoded.ok) {
    const issue = decoded as unknown as Record<string, unknown>;
    return refuseTerminal("EFFECT_TERMINAL_EVIDENCE_ABSENT", "the activation record is not readable",
      { code: String(issue.code ?? "UNKNOWN"), layer: String(issue.layer ?? "ACTIVATION_LEDGER") });
  }
  const run = readCurrentProviderRun(store, { attemptRef, projectId });
  if (!("ok" in run) || run.ok !== true) {
    const upstream = run as unknown as Record<string, unknown>;
    return refuseTerminal("EFFECT_TERMINAL_EVIDENCE_ABSENT", "no durable provider run for this attempt",
      { code: String(upstream.code ?? upstream.status ?? "UNKNOWN"), layer: String(upstream.layer ?? "PROVIDER_RUN_READER") });
  }
  const { effectIntent } = decoded.record;
  // A PROJECTION of durable evidence, not a composition: every field is read, none invented.
  const settlement = settleEffectFromProviderObservation(effectIntent, {
    // The launch facts record a plain timestamp string; the settlement contract wants a
    // ProviderText. Bridging the two vocabularies is this module's job, and it is a WRAP, not a
    // reinterpretation: an unobserved completion stays null and refuses upstream.
    completedAt: run.record.launch.completedAt === null
      ? null
      : { known: true as const, value: run.record.launch.completedAt },
    infrastructure: run.record.infrastructure,
    runRef: run.record.providerRunRef,
    sourceDigest: run.recordDigest,
    sourceVersion: PROVIDER_TELEMETRY_CONTRACT_VERSION,
    terminal: run.record.terminal,
    upstreamRefusal: run.record.upstreamRefusal,
  });
  const outcome = settlement as unknown as Record<string, unknown>;
  if (outcome.kind === "PROVIDER_SETTLEMENT_REFUSED" || outcome.kind === "REFUSED") {
    const failure = (outcome.failure ?? {}) as Record<string, unknown>;
    return refuseTerminal("EFFECT_TERMINAL_SETTLEMENT_REFUSED", "the runner refused this evidence",
      { code: String(failure.code ?? "UNKNOWN"), layer: String(failure.layer ?? "PROVIDER_EFFECT_SETTLEMENT") });
  }
  const intent = (outcome.intent ?? null) as { readonly state?: unknown } | null;
  const state = intent === null ? null : intent.state;
  if (outcome.kind !== "TRANSITIONED" || !isText(state) || !TERMINAL_STATES.includes(state)) {
    // MUST_DRAIN lands here on purpose: a cancellation over ACTIVE is an instruction to drain
    // and reconcile, never a terminal anyone may adopt from a distance.
    return refuseTerminal("EFFECT_TERMINAL_NOT_PROVEN",
      `evidence proves no terminal arc (${String(outcome.kind)})`);
  }
  const selector: EffectTerminalSelector = {
    attemptRef, intentId: effectIntent.intentId, projectId,
  };
  return {
    ok: true,
    record: Object.freeze({
      attemptRef,
      intentId: effectIntent.intentId,
      projectId,
      recordVersion: EFFECT_TERMINAL_RECORD_VERSION,
      settlement,
      terminalState: state,
    }),
    selector,
  };
}

/**
 * Writes the terminal the runner derived, once. A second call carrying the SAME derivation
 * replays without appending; one carrying a different derivation refuses before mutating,
 * because a terminal that already has durable authority is not something later evidence may
 * silently overwrite.
 */
export function recordTerminalEffect(
  store: SqliteEventStore,
  input: unknown,
): EffectTerminalResult {
  const request = exactKeys(input, ["attemptRef", "projectId"]);
  if (request === null || !isText(request.attemptRef) || !isText(request.projectId)) {
    return refuseTerminal("EFFECT_TERMINAL_REQUEST_INVALID",
      "request is not an exact {projectId, attemptRef} record");
  }
  const derived = deriveTerminal(store, request.projectId, request.attemptRef);
  if (!derived.ok) return derived;
  const { record, selector } = derived;
  const bytes = encodeTerminalEffectRecord(record);
  const existing = readCurrentTerminalEffect(store, selector);
  if (existing.ok) {
    return encodeTerminalEffectRecord(existing.record).toString() === bytes.toString()
      ? existing
      : refuseTerminal("EFFECT_TERMINAL_CONFLICT",
        "a different terminal already has durable authority for this identity");
  }
  if (existing.code !== "EFFECT_TERMINAL_ABSENT") return existing;
  let response: CommandDecisionResponse;
  try {
    response = store.commitExpectedVersionDecision({
      commandKind: EFFECT_TERMINAL_COMMAND_KIND,
      committedResultBytes: bytes,
      correlationId: `effect-terminal-${selector.attemptRef}`,
      decidedAt: new Date(0).toISOString(),
      events: [{
        eventId: deriveTerminalEffectEventId(selector),
        eventType: EFFECT_TERMINAL_EVENT_TYPE,
        payload: bytes,
      }],
      expectedVersion: EXPECTED_VERSION,
      key: {
        commandId: deriveTerminalEffectEventId(selector),
        principalId: selector.intentId,
        projectId: selector.projectId,
      },
      requestBytes: bytes,
      targetAggregateId: deriveTerminalEffectAggregateId(selector),
    });
  } catch (error) {
    return refuseTerminal("EFFECT_TERMINAL_UNREADABLE",
      `durable commit failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
  if (response.disposition !== "DECIDED" && response.disposition !== "REPLAYED") {
    return refuseTerminal("EFFECT_TERMINAL_CONFLICT", "the store refused this terminal commit");
  }
  return Object.freeze({ ok: true as const, record });
}
