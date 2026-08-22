import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, RuntimeCommandKind, RuntimeError } from "@moe/contracts";
import type { CommandDecisionRecord } from "@moe/store";

import type { ActivationEmbargoHeld } from "./activation-embargo.js";

/**
 * Byte ingress vocabulary for `effect.activate` — the daemon command that turns
 * a granted execution claim into durable execution authority.
 *
 * DELIBERATELY DISJOINT from `work-claim-contracts.ts`. That family fences BOARD
 * work items ("who is working on what"); this one composes the four-leg claim
 * kernel plus the supervisor activation. Sharing a code vocabulary would let a
 * board-ownership refusal be mistaken for an execution refusal.
 *
 * This module validates the ENVELOPE ONLY. Not one domain field of the payload
 * sections is inspected here: the ordering contract in `activation-ingress.ts`
 * requires every domain judgement to run strictly AFTER the recovery embargo, so
 * a decoder that peeked at the claim legs would answer a well-formed embargoed
 * request with a domain code and silently invert that order.
 */

export const EFFECT_ACTIVATE_COMMAND_KIND = "effect.activate" as const satisfies RuntimeCommandKind;

export const ACTIVATION_INGRESS_SCHEMA_VERSION = "moe-effect-activate/1" as const;

/**
 * Sorted: the HTTP seam compares its payload allow-list ORDERED, so an
 * out-of-order list refuses every request with a shape error that looks like a
 * caller fault.
 */
export const EFFECT_ACTIVATE_PAYLOAD_KEYS = Object.freeze([
  "activation",
  "budget",
  "effect",
  "lease",
  "liveClaims",
  "slot",
] as const);

/**
 * The activation-only half of the payload: exactly the `activateEffect` request
 * keys this daemon forwards. `intent` is ABSENT on purpose — the intent handed
 * to the supervisor is derived server-side from the claim, never taken from the
 * caller, and a key the section cannot carry is a key no call site can forward.
 */
export const ACTIVATION_SECTION_KEYS = Object.freeze([
  "attempt",
  "claim",
  "dependencyWitnesses",
  "desiredState",
  "leaseProof",
  "lockIdentity",
  "observedGraphEpoch",
  "observedRuntimeDigest",
  "tombstone",
  "wrapperIdentity",
] as const);

/** Closed. Refusals raised downstream keep their own producer's vocabulary. */
export const ACTIVATION_INGRESS_CODES = Object.freeze([
  "ACTIVATION_INGRESS_REQUEST_MALFORMED",
  "ACTIVATION_INGRESS_PAYLOAD_MALFORMED",
] as const);

export type ActivationIngressCode = (typeof ACTIVATION_INGRESS_CODES)[number];

/**
 * The boundaries that can answer an `effect.activate`. Every one of these is
 * carried into `refusedBy` VERBATIM, because more than one of them can refuse
 * the same request and a caller that cannot tell them apart cannot tell an
 * embargo from a malformed lease.
 */
export const ACTIVATION_INGRESS_LAYER = "DAEMON_INGRESS" as const;
export const ACTIVATION_SLOT_LAYER = "SCHEDULER_PROVIDER_SLOT" as const;
export const ACTIVATION_BUDGET_LAYER = "SCHEDULER_BUDGET" as const;

export interface ActivationIngressRequest {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly kind: typeof EFFECT_ACTIVATE_COMMAND_KIND;
  readonly payload: JsonObject;
  readonly principalId: string;
  readonly projectId: string;
  readonly schemaVersion: typeof ACTIVATION_INGRESS_SCHEMA_VERSION;
}

export type ActivationIngressDecodeResult =
  | { readonly code: ActivationIngressCode; readonly ok: false }
  | {
      /**
       * The caller's bytes, unchanged. The store's replay identity hashes these,
       * so re-encoding them here would make two byte-identical retries look like
       * two different commands.
       */
      readonly bytes: Uint8Array;
      readonly ok: true;
      readonly request: ActivationIngressRequest;
    };

/**
 * STRUCTURALLY IDENTICAL to `WorkClaimOutcome`, so `daemon-command-registry`'s
 * `decisionOf` accepts it with no widening of its own logic. A refusal names the
 * layer that answered in `refusedBy`, which is what the port surfaces as the
 * refusal layer — the one field a test can use to tell two boundaries apart.
 */
export interface ActivationIngressAccepted {
  readonly advisoryOnly: false;
  readonly authority: "DURABLE_DECISION";
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly kind: typeof EFFECT_ACTIVATE_COMMAND_KIND;
  readonly ok: true;
}

export interface ActivationIngressRefused {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly code: string;
  /**
   * The embargo record VERBATIM when the recovery fence is what refused, `null`
   * otherwise. Flattening it into `code` alone would destroy `cause` and the
   * restore controller's own upstream layer — the only evidence of WHY the
   * project is still fenced.
   */
  readonly embargo: ActivationEmbargoHeld | null;
  readonly error: RuntimeError | null;
  readonly kind: typeof EFFECT_ACTIVATE_COMMAND_KIND | null;
  readonly ok: false;
  readonly refusedBy: string;
}

export type ActivationIngressOutcome = ActivationIngressAccepted | ActivationIngressRefused;

export interface ActivationRefusalParts {
  readonly code: string;
  readonly embargo?: ActivationEmbargoHeld;
  readonly error?: RuntimeError | null;
  readonly kind?: typeof EFFECT_ACTIVATE_COMMAND_KIND | null;
  readonly refusedBy: string;
}

export function activationIngressRefusal(parts: ActivationRefusalParts): ActivationIngressRefused {
  return Object.freeze({
    advisoryOnly: true as const,
    authority: "NONE" as const,
    code: parts.code,
    embargo: parts.embargo ?? null,
    error: parts.error ?? null,
    kind: parts.kind === undefined ? EFFECT_ACTIVATE_COMMAND_KIND : parts.kind,
    ok: false as const,
    refusedBy: parts.refusedBy,
  });
}

const REQUEST_KEYS = Object.freeze([
  "commandId", "correlationId", "decidedAt", "expectedVersion", "kind",
  "payload", "principalId", "projectId", "schemaVersion",
] as const);

const REQUEST_KEY_SET: ReadonlySet<string> = new Set(REQUEST_KEYS);

/**
 * TEMPORARY TOLERANCE — task-8be27625, link 1 of 4. REMOVED BY task-b8b69e74.
 *
 * Exactly TWO shapes: the full advertised roster, and the same roster without
 * `budget`. That opens the migration window links 2 and 3 (task-671585ec,
 * task-553b2165) need — while the count was exact, a sender that stopped sending
 * the section failed AND dropping the key while senders still sent it failed, so
 * the fence and all 17 senders had to change in one commit. Once every sender has
 * moved, link 4 drops `budget` from the roster and this list collapses by itself.
 *
 * SORTED STRICT EQUALITY, NOT ARITHMETIC: a `length >= 5` or `5 || 6` test admits
 * a five-key payload missing a DIFFERENT section, and a six-key one with a section
 * swapped for a smuggled key. Both are representable; neither is tolerated. */
const TOLERATED_PAYLOAD_SHAPES: readonly (readonly string[])[] = Object.freeze([
  Object.freeze([...EFFECT_ACTIVATE_PAYLOAD_KEYS].sort()),
  Object.freeze([...EFFECT_ACTIVATE_PAYLOAD_KEYS].filter((key) => key !== "budget").sort()),
]);

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSectionRecord(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return TOLERATED_PAYLOAD_SHAPES.some((shape) =>
    shape.length === keys.length && shape.every((key, index) => key === keys[index]));
}

/**
 * Envelope-only decode. Every section's VALUE is passed through untouched; only
 * the payload's own key set is fenced, because a missing section is a shape
 * fault the domain stages could not name and an extra one is smuggled input.
 */
export function decodeActivationRequestBytes(input: unknown): ActivationIngressDecodeResult {
  if (!(input instanceof Uint8Array)) {
    return { code: "ACTIVATION_INGRESS_REQUEST_MALFORMED", ok: false };
  }
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) return { code: "ACTIVATION_INGRESS_REQUEST_MALFORMED", ok: false };
  const value = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { code: "ACTIVATION_INGRESS_REQUEST_MALFORMED", ok: false };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== REQUEST_KEYS.length || !keys.every((key) => REQUEST_KEY_SET.has(key))) {
    return { code: "ACTIVATION_INGRESS_REQUEST_MALFORMED", ok: false };
  }
  if (
    record["kind"] !== EFFECT_ACTIVATE_COMMAND_KIND
    || record["schemaVersion"] !== ACTIVATION_INGRESS_SCHEMA_VERSION
    || !nonEmpty(record["commandId"]) || !nonEmpty(record["correlationId"])
    || !nonEmpty(record["principalId"]) || !nonEmpty(record["projectId"])
    || !isIsoInstant(record["decidedAt"])
    || typeof record["expectedVersion"] !== "number"
    || !Number.isSafeInteger(record["expectedVersion"]) || record["expectedVersion"] < 0
  ) {
    return { code: "ACTIVATION_INGRESS_REQUEST_MALFORMED", ok: false };
  }
  const payload = record["payload"];
  if (!isSectionRecord(payload)) {
    return { code: "ACTIVATION_INGRESS_REQUEST_MALFORMED", ok: false };
  }
  return {
    bytes: input,
    ok: true,
    request: Object.freeze({
      commandId: record["commandId"],
      correlationId: record["correlationId"],
      decidedAt: record["decidedAt"],
      expectedVersion: record["expectedVersion"],
      kind: EFFECT_ACTIVATE_COMMAND_KIND,
      payload,
      principalId: record["principalId"],
      projectId: record["projectId"],
      schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
    }),
  };
}
