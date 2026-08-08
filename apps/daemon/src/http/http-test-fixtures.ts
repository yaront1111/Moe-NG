import { MAX_JSON_DEPTH, RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonValue, RuntimeCommandKind } from "@moe/contracts";

import { WIRE_PROTOCOL_VERSION, buildCommandRegistry } from "./http-contract.js";
import type {
  AuthenticationResult,
  Authenticator,
  CommandDecisionPort,
  CommandHandler,
  CommandRegistry,
  DecisionKey,
  DecisionPortResult,
  DurableDecision,
  HttpCommandRequest,
} from "./http-contract.js";

/**
 * Inputs only. Nothing here re-implements a boundary rule: every fixture builds a
 * request, a principal, or a port, and the assertions in the test files run against the
 * production functions.
 */

export const GOOD_CREDENTIAL = "sess-good";
export const UNKNOWN_CREDENTIAL = "sess-unknown";
export const DIGEST = "a".repeat(64);
export const OTHER_DIGEST = "b".repeat(64);
export const CAPABILITY = "goal.write";

const encoder = new TextEncoder();

export function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export interface EnvelopeOverrides {
  readonly commandId?: string;
  readonly commandKind?: string;
  readonly payload?: Readonly<Record<string, JsonValue>>;
  readonly requestDigest?: string;
  readonly targetAggregateId?: string;
}

export function envelopeObject(
  overrides: EnvelopeOverrides = {},
): Readonly<Record<string, JsonValue>> {
  return {
    commandId: overrides.commandId ?? "cmd-0001",
    commandKind: overrides.commandKind ?? "goal.create",
    correlationId: "corr-0001",
    expectedVersion: 7,
    payload: (overrides.payload ?? { title: "ship it" }) as JsonValue,
    requestDigest: overrides.requestDigest ?? DIGEST,
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: GOOD_CREDENTIAL,
    targetAggregateId: overrides.targetAggregateId ?? "goal-0001",
  };
}

export function request(overrides: {
  readonly body?: unknown;
  readonly credential?: string | null;
  readonly protocolVersion?: unknown;
} = {}): HttpCommandRequest {
  return {
    body: overrides.body ?? bytes(envelopeObject()),
    credential: overrides.credential === undefined ? GOOD_CREDENTIAL : overrides.credential,
    protocolVersion:
      overrides.protocolVersion === undefined ? WIRE_PROTOCOL_VERSION : overrides.protocolVersion,
  };
}

/** Bytes that no decoder can accept, used to prove an earlier stage answered first. */
export const UNDECODABLE_BODY = Uint8Array.from([0x7b, 0xff, 0xfe]);

/** A JSON envelope whose UTF-8 encoding is exactly `target` bytes. */
export function envelopeOfExactByteLength(target: number): Uint8Array {
  const padCount = 6;
  const payload: Record<string, JsonValue> = {};
  for (let index = 0; index < padCount; index += 1) payload[`p${index}`] = "";
  let remaining = target - bytes(envelopeObject({ payload })).length;
  if (remaining < 0) throw new Error("target smaller than the minimum envelope");
  for (let index = 0; index < padCount && remaining > 0; index += 1) {
    const take = Math.min(remaining, 200_000);
    payload[`p${index}`] = "a".repeat(take);
    remaining -= take;
  }
  if (remaining !== 0) throw new Error("padding could not reach the requested size");
  return bytes(envelopeObject({ payload }));
}

/** A payload nested in `containers` arrays, so total container depth is `containers + 2`. */
export function nestedPayload(containers: number): Readonly<Record<string, JsonValue>> {
  let nested: JsonValue = null;
  for (let index = 0; index < containers; index += 1) nested = [nested];
  return { deep: nested };
}

export const DEEPEST_ADMITTED_CONTAINERS = MAX_JSON_DEPTH - 2;

export function payloadWithFieldCount(count: number): Readonly<Record<string, JsonValue>> {
  const payload: Record<string, JsonValue> = {};
  for (let index = 0; index < count; index += 1) payload[`f${index}`] = index;
  return payload;
}

export function principal(capabilities: readonly string[]): AuthenticationResult {
  return {
    principal: { capabilities, principalId: "prin-0001", projectId: "proj-0001" },
    verdict: "AUTHENTICATED",
  };
}

/** Knows one credential per capability set; every other credential is unknown. */
export function authenticator(capabilities: readonly string[] = [CAPABILITY]): Authenticator {
  return {
    authenticate(credential: string | null): AuthenticationResult {
      if (credential !== GOOD_CREDENTIAL) return { verdict: "UNAUTHENTICATED" };
      return principal(capabilities);
    },
  };
}

export interface RecordingHandler {
  readonly calls: { count: number };
  readonly handler: CommandHandler;
}

export function recordingHandler(resultCode = "EFFECTS_COMMITTED"): RecordingHandler {
  const calls = { count: 0 };
  return {
    calls,
    handler: (input) => {
      calls.count += 1;
      return {
        commandId: input.envelope.commandId,
        disposition: "DECIDED",
        effectId: `effect-${String(calls.count)}`,
        resultCode,
      };
    },
  };
}

export function registryOf(
  kind: RuntimeCommandKind,
  handler: CommandHandler,
  payloadKeys: readonly string[],
): CommandRegistry {
  return buildCommandRegistry([
    { handler, kind, payloadKeys, requiredCapability: CAPABILITY },
  ]);
}

/**
 * A durable decision port that keeps every committed effect. Replay returns the stored
 * decision and never re-runs `commit`, so a double write is visible in `effects.length`.
 */
export interface RecordingDecisionPort extends CommandDecisionPort {
  readonly effects: DurableDecision[];
  readonly keys: DecisionKey[];
}

export function decisionPort(): RecordingDecisionPort {
  const stored = new Map<string, DurableDecision>();
  const effects: DurableDecision[] = [];
  const keys: DecisionKey[] = [];
  return {
    decide(key: DecisionKey, _requestDigest: string, commit: () => DurableDecision):
    DecisionPortResult {
      keys.push({
        commandId: key.commandId, principalId: key.principalId, projectId: key.projectId,
      });
      const id = `${key.projectId}/${key.principalId}/${key.commandId}`;
      const prior = stored.get(id);
      if (prior !== undefined) {
        return { decision: { ...prior, disposition: "REPLAYED" }, outcome: "DECIDED" };
      }
      const decision = commit();
      stored.set(id, decision);
      effects.push(decision);
      return { decision, outcome: "DECIDED" };
    },
    effects,
    keys,
  };
}

/** A port that always refuses, so the seam's verbatim pass-through can be observed. */
export function refusingDecisionPort(): CommandDecisionPort {
  return {
    decide(): DecisionPortResult {
      return {
        outcome: "REFUSED",
        refusal: {
          code: "IDEMPOTENCY_CONFLICT",
          detail: "cmd-0001 was already decided with a different request digest",
          httpStatus: 409,
          layer: "DURABLE_DECISION",
        },
      };
    },
  };
}
