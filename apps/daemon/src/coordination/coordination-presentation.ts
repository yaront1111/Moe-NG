import { types } from "node:util";

import {
  COORDINATION_ENDPOINTS, COORDINATION_ENDPOINT_VERSION, COORDINATION_SCOPE,
} from "@moe/coordination";
import type { CoordinationEndpoint } from "@moe/coordination";

import {
  isBoundedId, isSessionDigest, sessionAuthorityRequestDigest,
} from "../identity/session-authority-protocol.js";

const MAX_TARGETS = 32;

/** Every authority-bearing value covered by a coordination presentation proof. */
export interface CoordinationPresentationFields {
  readonly endpoint: CoordinationEndpoint;
  readonly requestDigest: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly targets: readonly string[];
  readonly transportId: string;
}

/** Rejects malformed capability requests instead of silently signing a weaker projection. */
export function readCoordinationPresentationTargets(value: unknown): readonly string[] | null {
  try {
    if (!Array.isArray(value) || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TARGETS
      || Reflect.ownKeys(value).length !== length + 1) return null;
    const targets: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
        || !isBoundedId(descriptor.value) || seen.has(descriptor.value)) return null;
      seen.add(descriptor.value);
      targets.push(descriptor.value);
    }
    return Object.freeze(targets);
  } catch {
    return null;
  }
}

/**
 * Domain-separated from session lifecycle commands and bound to both the canonical
 * coordination request and the complete capability-target request.
 */
export function coordinationPresentationDigest(
  fields: CoordinationPresentationFields,
): string {
  if (!COORDINATION_ENDPOINTS.includes(fields.endpoint)
    || !isSessionDigest(fields.requestDigest) || !isBoundedId(fields.requestId)
    || !isBoundedId(fields.sessionId) || !isBoundedId(fields.transportId)) {
    throw new TypeError("invalid coordination presentation fields");
  }
  const targets = readCoordinationPresentationTargets(fields.targets);
  if (targets === null) throw new TypeError("invalid targets");
  return sessionAuthorityRequestDigest({
    endpoint: fields.endpoint,
    endpointVersion: COORDINATION_ENDPOINT_VERSION,
    kind: "COORDINATION_REQUEST",
    requestDigest: fields.requestDigest,
    requestId: fields.requestId,
    scope: COORDINATION_SCOPE,
    sessionId: fields.sessionId,
    targets,
    transportId: fields.transportId,
  });
}
