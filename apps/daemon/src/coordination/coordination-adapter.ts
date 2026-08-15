/**
 * The daemon's coordination authority adapter.
 *
 * It is the production consumer of `@moe/coordination`: it constructs the durable mailbox and
 * the coordination service over the real event store and answers all five of the service's
 * ports from committed daemon records. A caller may present PROOF and name candidate targets;
 * it may never present an answer. Every positive fact here is read back from the durable
 * session authority or the committed recipient ledger.
 *
 * It carries no command, lifecycle, MCP-framing, chat, or terminal-effect authority: nothing
 * here opens, closes, renews, rotates, starts, stops, or dispatches anything. Advisory text
 * and CONTROL/HANDOFF envelopes are data that reaches a mailbox and stops there.
 */

import {
  COORDINATION_ENDPOINT_VERSION, COORDINATION_ENVELOPE_KINDS, COORDINATION_SCOPE,
  coordinationCapability, createCoordinationService, createDurableMailbox,
} from "@moe/coordination";
import type {
  CoordinationAckResult, CoordinationAcknowledgeRequest, CoordinationAuthRequest,
  CoordinationEffectBindingPort, CoordinationEndpoint, CoordinationMailboxRequest,
  CoordinationReadResult, CoordinationRecipientRegistry, CoordinationReplayRequest,
  CoordinationSendRequest, CoordinationSendResult,
} from "@moe/coordination";
import type { SqliteEventStore } from "@moe/store";

import { readCurrentEffectSessionBinding } from "../activation/activation-ledger-reader.js";
import type {
  SessionAuthorityCode, SessionAuthorityLayer, SessionAuthorityService,
} from "../identity/session-authority-contracts.js";
import {
  isBoundedId, readExactRecord, sessionAuthorityRequestDigest,
} from "../identity/session-authority-protocol.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { readRecipientFold } from "./recipient-registry-records.js";
import { createRecipientRegistry } from "./recipient-registry.js";
import type { RecipientRegistryService } from "./recipient-registry.js";

/** Exactly what a caller may present. `projectId`, `transportId`, and `requestDigest` are
 *  deliberately absent: the adapter forces those from its own configuration and from the live
 *  coordination request, so a presentation cannot claim the scope it is used in. */
const PRESENTATION_KEYS = [
  "clientKeyId", "credentialId", "generation", "principalId", "proof", "requestId",
  "sessionId", "targets",
] as const;

const MAILBOX_ENDPOINTS = ["ACKNOWLEDGE", "READ", "REPLAY"] as const;
const MAX_TARGETS = 32;

/** The one non-positive effect answer. Every ABSENT, UNKNOWN and thrown outcome collapses to
 *  exactly this record — no code, no layer, no aggregate id — so a refusal cannot become a
 *  probe: a caller learns it holds no binding, never why, and nothing about anyone else's
 *  effect. `isBoundEffect` refuses it, so the service answers TERMINAL_BINDING_INVALID. */
const NO_EFFECT_BINDING = Object.freeze({ bound: false as const, effectId: null, sessionId: null });

export interface CoordinationAdapterOptions {
  readonly clock: () => number;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

/** The tuple a coordination presentation is signed over. Both sides derive it from values
 *  they already hold, so a presentation signed for one endpoint, transport, or session is
 *  worthless on another. */
export interface CoordinationPresentationFields {
  readonly endpoint: CoordinationEndpoint;
  readonly requestId: string;
  readonly sessionId: string;
  readonly transportId: string;
}

/** A refusal carries the DAEMON's own code and layer. It is not a binding — the coordination
 *  service accepts only a frozen record whose keys are exactly the binding keys — so this can
 *  report which layer refused without ever authorizing anything. */
export interface CoordinationAuthRefused {
  readonly code: SessionAuthorityCode;
  readonly layer: SessionAuthorityLayer;
  readonly ok: false;
}

export interface CoordinationAdapter {
  readonly acknowledge: (request: CoordinationAcknowledgeRequest) => CoordinationAckResult;
  readonly authenticate: (request: CoordinationAuthRequest) => unknown;
  readonly read: (request: CoordinationMailboxRequest) => CoordinationReadResult;
  readonly recipients: RecipientRegistryService;
  readonly replay: (request: CoordinationReplayRequest) => CoordinationReadResult;
  readonly resolveEffectBinding: CoordinationEffectBindingPort;
  readonly resolveRecipient: CoordinationRecipientRegistry;
  readonly send: (request: CoordinationSendRequest) => CoordinationSendResult;
  readonly sessions: SessionAuthorityService;
}

/**
 * Domain-separated from every session-authority command digest by its `kind`, so a
 * presentation minted for coordination traffic can never authorize a lifecycle mutation.
 */
export function coordinationPresentationDigest(
  fields: CoordinationPresentationFields,
): string {
  return sessionAuthorityRequestDigest({
    endpoint: fields.endpoint,
    endpointVersion: COORDINATION_ENDPOINT_VERSION,
    kind: "COORDINATION_REQUEST",
    requestId: fields.requestId,
    scope: COORDINATION_SCOPE,
    sessionId: fields.sessionId,
    transportId: fields.transportId,
  });
}

export function createCoordinationAdapter(
  options: CoordinationAdapterOptions,
): CoordinationAdapter {
  const { clock, projectId, store } = options;
  const sessions = createSessionAuthority(store, { clock, projectId });
  const recipients = createRecipientRegistry({ clock, projectId, sessions, store });

  function refused(
    code: SessionAuthorityCode, layer: SessionAuthorityLayer,
  ): CoordinationAuthRefused {
    return Object.freeze({ code, layer, ok: false as const });
  }

  /** A live committed recipient record of THIS project. Unreadable evidence is not live. */
  function liveRecipient(sessionId: string): boolean {
    try {
      const read = readRecipientFold(store, sessionId);
      if (read.status !== "FOUND") return false;
      return !read.record.revoked && read.record.projectId === projectId;
    } catch {
      return false;
    }
  }

  /**
   * Mailbox capabilities are always the authenticated session's OWN — the service separately
   * requires the binding to own the addressed mailbox. Send capabilities are minted only for
   * candidate targets that hold a live committed recipient record, so naming a target is a
   * request the durable ledger either justifies or drops. Bounded at
   * MAX_TARGETS * kinds + mailbox endpoints, well inside the contract's capability ceiling.
   */
  function capabilitiesFor(sessionId: string, targets: unknown): readonly string[] {
    const granted: string[] = MAILBOX_ENDPOINTS.map(
      (endpoint) => coordinationCapability(endpoint, sessionId),
    );
    if (!Array.isArray(targets)) return Object.freeze(granted);
    const seen = new Set<string>();
    for (const target of targets.slice(0, MAX_TARGETS)) {
      if (!isBoundedId(target) || seen.has(target)) continue;
      seen.add(target);
      if (!liveRecipient(target)) continue;
      for (const kind of COORDINATION_ENVELOPE_KINDS) {
        granted.push(coordinationCapability("SEND", target, kind));
      }
    }
    return Object.freeze(granted);
  }

  /**
   * Derives the binding from a durable authentication. The proof is verified by the session
   * authority against the credential's committed public key over a challenge that binds the
   * endpoint, transport, session, and request id, and its nonce is burned durably, so a
   * presentation is single-use and cannot be moved to another request.
   */
  function authenticate(request: CoordinationAuthRequest): unknown {
    try {
      if (request.scope !== COORDINATION_SCOPE) {
        return refused("SESSION_AUTHORITY_INVALID", "BINDING");
      }
      if (request.endpointVersion !== COORDINATION_ENDPOINT_VERSION) {
        return refused("SESSION_AUTHORITY_INVALID", "BINDING");
      }
      const raw = readExactRecord(request.presentation, PRESENTATION_KEYS);
      if (raw === null) return refused("SESSION_AUTHORITY_INVALID", "BINDING");
      const { requestId, sessionId } = raw;
      if (!isBoundedId(requestId) || !isBoundedId(sessionId)) {
        return refused("SESSION_AUTHORITY_INVALID", "BINDING");
      }
      if (!isBoundedId(request.transportId)) {
        return refused("SESSION_AUTHORITY_INVALID", "BINDING");
      }
      const outcome = sessions.authenticate({
        clientKeyId: raw.clientKeyId,
        credentialId: raw.credentialId,
        generation: raw.generation,
        principalId: raw.principalId,
        projectId,
        proof: raw.proof,
        requestDigest: coordinationPresentationDigest({
          endpoint: request.endpoint, requestId, sessionId, transportId: request.transportId,
        }),
        requestId,
        sessionId,
        transportId: request.transportId,
      });
      if (!outcome.ok) return refused(outcome.code, outcome.layer);
      const { principalId, projectId: owner, sessionId: authenticated } = outcome.facts;
      if (authenticated !== sessionId || owner !== projectId) {
        return refused("SESSION_AUTHORITY_INVALID", "BINDING");
      }
      return Object.freeze({
        capabilities: capabilitiesFor(authenticated, raw.targets),
        ok: true as const,
        principalId,
        sessionId: authenticated,
      });
    } catch {
      return refused("SESSION_AUTHORITY_UNREADABLE", "BINDING");
    }
  }

  /** The durable binding, read from THIS adapter's own store. There is deliberately no
   *  injectable positive resolver: a caller able to supply one could name a terminal binding
   *  into existence. The positive is rebuilt from COMMITTED values — intentId from the intent,
   *  sessionId from the lease owner — so the query is only ever an equality test. */
  const resolveEffectBinding: CoordinationEffectBindingPort = (query) => {
    try {
      const binding = readCurrentEffectSessionBinding(
        store, projectId, query.effectId, query.sessionId, query.now,
      );
      return binding.status === "BOUND" ? Object.freeze({
        bound: true as const, effectId: binding.effectId, sessionId: binding.sessionId,
      }) : NO_EFFECT_BINDING;
    } catch {
      return NO_EFFECT_BINDING;
    }
  };

  const service = createCoordinationService({
    authenticate,
    mailbox: createDurableMailbox(store),
    now: clock,
    resolveEffectBinding,
    resolveRecipient: recipients.resolveRecipient,
  });

  return Object.freeze({
    acknowledge: (request: CoordinationAcknowledgeRequest): CoordinationAckResult =>
      service.acknowledge(request),
    authenticate,
    read: (request: CoordinationMailboxRequest): CoordinationReadResult => service.read(request),
    recipients,
    replay: (request: CoordinationReplayRequest): CoordinationReadResult =>
      service.replay(request),
    resolveEffectBinding,
    resolveRecipient: recipients.resolveRecipient,
    send: (request: CoordinationSendRequest): CoordinationSendResult => service.send(request),
    sessions,
  });
}
