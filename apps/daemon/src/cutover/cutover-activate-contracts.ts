/**
 * The `cutover.activate` handler's own vocabulary: its refusal roster, its result union, the
 * store surface it needs, and the pure comparisons the handler decides on. Split out of
 * cutover-activate-service.ts to keep each production file under the epic's line cap; the
 * handler itself owns the order those comparisons run in.
 *
 * THE ROSTER IS THIS MODULE'S OWN REFUSALS ONLY. The admission's codes, core's gate codes, the
 * attempt fold's codes, the reducer's `RuntimeError`s and the generation snapshot's codes are
 * FORWARDED by the handler with their own layers - restamping them here would erase which
 * layer actually answered, which is the one thing a refusal has to say.
 */
import { createHash } from "node:crypto";

import { ACTIVATION_GENERATION_KEYS } from "@moe/benchmark";
import type { ActivationBinding, ActivationBindingAdmission } from "@moe/benchmark";
import type { CutoverAttemptState, CutoverRejectedResult } from "@moe/core";
import { DurableStoreError } from "@moe/store";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CommandDecisionResponse,
  CommitExpectedVersionDecisionLegsInput,
  DurableStoreErrorCode,
  StoredEvent,
} from "@moe/store";

import type {
  CutoverActivationMarker,
  CutoverActivationMarkerRefused,
} from "./cutover-activation-marker.js";
import type { CutoverAttemptReadRefusal } from "./cutover-attempt-commit.js";
import type { CutoverAttemptAdmittedRecord } from "./cutover-attempt-contracts.js";
import type { CutoverAttemptPresent, CutoverAttemptReadResult } from "./cutover-attempt-reader.js";
import type { CutoverGenerationFact, CutoverGenerationRefused } from "./cutover-generation-snapshot.js";

export const CUTOVER_ACTIVATE_LAYER = "DAEMON_CUTOVER_ACTIVATE" as const;
export const CUTOVER_ACTIVATE_COMMAND_KIND = "cutover.activate" as const;

/** This module's OWN refusals. Everything else it can answer with is forwarded, not minted. */
export const CUTOVER_ACTIVATE_CODES = Object.freeze([
  "CUTOVER_ACTIVATE_BINDING_DRIFT",
  "CUTOVER_ACTIVATE_GENERATION_DRIFT",
  "CUTOVER_ACTIVATE_VERSION_DESYNC",
  "CUTOVER_ACTIVATE_REPLAY_DIVERGED",
  "CUTOVER_ACTIVATE_EXPECTED_VERSION_CONFLICT",
  "CUTOVER_ACTIVATE_STORE_UNAVAILABLE",
  "CUTOVER_ACTIVATE_FIELD_INVALID",
] as const);

export type CutoverActivateCode = (typeof CUTOVER_ACTIVATE_CODES)[number];

export interface CutoverActivateRefusal {
  readonly code: CutoverActivateCode;
  /** WHICH generation drifted, so an operator is not sent to the wrong evidence. */
  readonly fact: CutoverGenerationFact | null;
  readonly layer: typeof CUTOVER_ACTIVATE_LAYER;
  readonly ok: false;
  readonly storeCode: DurableStoreErrorCode | null;
}

export interface CutoverActivateStore {
  commitExpectedVersionDecisionLegs(
    input: CommitExpectedVersionDecisionLegsInput,
  ): CommandDecisionResponse;
  getCommandDecision(key: CommandDecisionKey): CommandDecisionRecord | null;
  readEvents(aggregateId: string): readonly StoredEvent[];
}

export interface ActivateCutoverInput {
  readonly activatedAtEpochMs: number;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly projectId: string;
  /** The GO_ACTIVATE binding, opaque until the admission has admitted it. */
  readonly record: unknown;
}

export interface CutoverActivateAccepted {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly disposition: "COMMITTED" | "REPLAYED";
  readonly marker: CutoverActivationMarker;
  readonly ok: true;
  readonly state: CutoverAttemptState;
}

export type CutoverActivateResult =
  | CutoverActivateAccepted
  | CutoverActivateRefusal
  | CutoverAttemptReadRefusal
  | CutoverGenerationRefused
  | CutoverActivationMarkerRefused
  | CutoverRejectedResult
  | Exclude<ActivationBindingAdmission, { readonly ok: true }>;

export function refuse(
  code: CutoverActivateCode,
  fact: CutoverGenerationFact | null = null,
  storeCode: DurableStoreErrorCode | null = null,
): CutoverActivateRefusal {
  return Object.freeze({ code, fact, layer: CUTOVER_ACTIVATE_LAYER, ok: false as const, storeCode });
}

/** Forwards the fold's verdict with ITS code and layer; this module adds only the `ok` tag. */
export function forwarded(
  result: Exclude<CutoverAttemptReadResult, CutoverAttemptPresent>,
): CutoverAttemptReadRefusal {
  return Object.freeze({
    code: result.code,
    layer: result.layer,
    ok: false as const,
    storeCode: result.status === "ABSENT" ? null : result.storeCode,
  });
}

export function storeRefusal(error: unknown): CutoverActivateRefusal {
  if (!(error instanceof DurableStoreError)) return refuse("CUTOVER_ACTIVATE_STORE_UNAVAILABLE");
  if (error.code === "EXPECTED_VERSION_CONFLICT") {
    return refuse("CUTOVER_ACTIVATE_EXPECTED_VERSION_CONFLICT", null, error.code);
  }
  if (error.code === "STORE_INPUT_INVALID" || error.code === "STORE_LIMIT_EXCEEDED") {
    return refuse("CUTOVER_ACTIVATE_FIELD_INVALID", null, error.code);
  }
  return refuse("CUTOVER_ACTIVATE_STORE_UNAVAILABLE", null, error.code);
}

/**
 * A DISTINCT command id from the approval's. The decision key is (commandId, principalId,
 * projectId) and does NOT carry the kind, so reusing the approval's id would let the approval's
 * decision be returned as an accepted replay of an activation that was never decided.
 */
export function deriveCutoverActivateCommandId(decisionId: string): string {
  return createHash("sha256").update(`cutover-activate.v1|${decisionId}`, "utf8").digest("hex");
}

/** The presented binding must be the one the attempt durably admitted, fact by fact. */
export function bindingMatches(
  durable: CutoverAttemptAdmittedRecord | null,
  binding: ActivationBinding,
): boolean {
  const grant = binding.authority.grant;
  return durable !== null && grant !== null
    && durable.grantedAtEpochMs === grant.grantedAtEpochMs
    && durable.principalId === grant.principalId
    && durable.sourceCommit === binding.sourceCommit
    && ACTIVATION_GENERATION_KEYS.every((key) => durable.generations[key] === binding.generations[key]);
}

export function driftedFact(
  binding: ActivationBinding,
  live: Readonly<Record<CutoverGenerationFact, string>>,
): CutoverGenerationFact | null {
  for (const key of ACTIVATION_GENERATION_KEYS) {
    if (binding.generations[key] !== live[key]) return key;
  }
  return null;
}

export function replayMatches(
  decision: CommandDecisionRecord | null,
  key: CommandDecisionKey,
  aggregateId: string,
): boolean {
  return decision !== null && decision.effectDisposition === "EFFECTS_COMMITTED"
    && decision.commandKind === CUTOVER_ACTIVATE_COMMAND_KIND
    && decision.targetAggregateId === aggregateId
    && decision.key.commandId === key.commandId
    && decision.key.principalId === key.principalId
    && decision.key.projectId === key.projectId;
}
