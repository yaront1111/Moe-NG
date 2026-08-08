import {
  COORDINATION_ENDPOINT_VERSION, COORDINATION_LIMITS, COORDINATION_SCOPE,
} from "./coordination-contracts.js";
import type { CoordinationAddress, CoordinationEndpoint } from "./coordination-contracts.js";
import type { DurableMailbox } from "./coordination-mailbox.js";
import {
  hasExactOwnKeys, isIdentifier, isPlainRecord, readList, readOwnDataProperty,
} from "./coordination-shape.js";

/** What the service asks an authenticator to attest. The digest covers the exact endpoint
 *  request bytes, so a positive answer cannot be replayed onto a different request. */
export interface CoordinationAuthRequest {
  readonly endpoint: CoordinationEndpoint;
  readonly endpointVersion: typeof COORDINATION_ENDPOINT_VERSION;
  readonly now: number;
  readonly presentation: unknown;
  readonly requestDigest: string;
  readonly scope: typeof COORDINATION_SCOPE;
  readonly transportId: string;
}

/** The only answer shape that authorizes anything. It must be frozen and exact. */
export interface CoordinationBinding {
  readonly capabilities: readonly string[];
  readonly ok: true;
  readonly principalId: string;
  readonly sessionId: string;
}

export interface CoordinationEffectQuery {
  readonly effectId: string; readonly now: number; readonly sessionId: string;
}

export type CoordinationAuthenticator = (request: CoordinationAuthRequest) => unknown;
export type CoordinationRecipientRegistry = (address: CoordinationAddress) => unknown;
export type CoordinationEffectBindingPort = (query: CoordinationEffectQuery) => unknown;

export interface CoordinationDependencies {
  readonly authenticate: CoordinationAuthenticator;
  readonly mailbox: DurableMailbox;
  readonly now: () => number;
  readonly resolveEffectBinding: CoordinationEffectBindingPort;
  readonly resolveRecipient: CoordinationRecipientRegistry;
}

const BINDING_KEYS = ["capabilities", "ok", "principalId", "sessionId"] as const;
const RECIPIENT_KEYS = ["known", "role"] as const;
const EFFECT_KEYS = ["bound", "effectId", "sessionId"] as const;
const MAX_CAPABILITIES = 256;

function own(value: object, key: string): unknown {
  const read = readOwnDataProperty(value, key);
  return read.ok && read.present ? read.value : undefined;
}

/** Only a frozen, exact, positive answer becomes a binding. A thrown, unknown, partial, or
 *  mutable answer is indistinguishable from no answer at all. */
export function readBinding(answer: unknown): CoordinationBinding | null {
  if (!isPlainRecord(answer) || !Object.isFrozen(answer)) return null;
  if (!hasExactOwnKeys(answer, BINDING_KEYS) || own(answer, "ok") !== true) return null;
  const principalId = own(answer, "principalId");
  const sessionId = own(answer, "sessionId");
  const limit = COORDINATION_LIMITS.maxIdentifierUtf8Bytes;
  if (!isIdentifier(principalId, limit) || !isIdentifier(sessionId, limit)) return null;
  const entries = readList(own(answer, "capabilities"), MAX_CAPABILITIES);
  if (entries === null) return null;
  const capabilities: string[] = [];
  for (const entry of entries) {
    if (!isIdentifier(entry, COORDINATION_LIMITS.maxTextUtf8Bytes)) return null;
    capabilities.push(entry);
  }
  return Object.freeze({
    capabilities: Object.freeze(capabilities), ok: true as const, principalId, sessionId,
  });
}

/** True only when the registry positively knows this exact address, including its role. */
export function isKnownRecipient(answer: unknown, address: CoordinationAddress): boolean {
  if (!isPlainRecord(answer) || !Object.isFrozen(answer)) return false;
  if (!hasExactOwnKeys(answer, RECIPIENT_KEYS)) return false;
  return own(answer, "known") === true && own(answer, "role") === address.role;
}

/** True only for a current positive binding of this exact effect to this exact session. */
export function isBoundEffect(answer: unknown, query: CoordinationEffectQuery): boolean {
  if (!isPlainRecord(answer) || !Object.isFrozen(answer)) return false;
  if (!hasExactOwnKeys(answer, EFFECT_KEYS)) return false;
  return own(answer, "bound") === true
    && own(answer, "effectId") === query.effectId
    && own(answer, "sessionId") === query.sessionId;
}
