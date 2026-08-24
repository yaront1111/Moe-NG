import { decodeCoordinationEnvelope } from "./coordination-codec.js";
import {
  COORDINATION_ENDPOINT_VERSION, COORDINATION_LIMITS, COORDINATION_SCOPE,
  coordinationCapability, refuse,
} from "./coordination-contracts.js";
import type {
  CoordinationAckResult, CoordinationAddress, CoordinationEndpoint, CoordinationReadResult,
  CoordinationRefused, CoordinationSendResult,
} from "./coordination-contracts.js";
import { isBoundEffect, isKnownRecipient, readBinding } from "./coordination-ports.js";
import type { CoordinationBinding, CoordinationDependencies } from "./coordination-ports.js";
import {
  digestValidatedCoordinationMailboxRequest, digestValidatedCoordinationSendRequest,
  readCoordinationAcknowledgeRequest, readCoordinationMailboxRequest,
  readCoordinationReplayRequest, readCoordinationSendRequest,
} from "./coordination-request-digest.js";
import type {
  CoordinationAcknowledgeRequest, CoordinationMailboxRequest, CoordinationReplayRequest,
  CoordinationSendRequest,
} from "./coordination-request-digest.js";
import { addressLabel, checkCorrelation, readLimit, readMailboxAddress } from "./coordination-service-input.js";
import { isIdentifier, textBytes } from "./coordination-shape.js";

export type {
  CoordinationAuthRequest, CoordinationAuthenticator, CoordinationBinding,
  CoordinationDependencies, CoordinationEffectBindingPort, CoordinationEffectQuery,
  CoordinationRecipientRegistry,
} from "./coordination-ports.js";
export type {
  CoordinationAcknowledgeRequest, CoordinationMailboxRequest, CoordinationReplayRequest,
  CoordinationSendRequest,
} from "./coordination-request-digest.js";

export interface CoordinationService {
  acknowledge(request: CoordinationAcknowledgeRequest): CoordinationAckResult;
  read(request: CoordinationMailboxRequest): CoordinationReadResult;
  replay(request: CoordinationReplayRequest): CoordinationReadResult;
  send(request: CoordinationSendRequest): CoordinationSendResult;
}

interface Session { readonly binding: CoordinationBinding; readonly now: number }
interface OpenMailbox extends Session {
  readonly address: CoordinationAddress; readonly limit: number;
}
type MailboxEndpoint = Exclude<CoordinationEndpoint, "SEND">;

function badInput(detail: string): CoordinationRefused {
  return refuse("COORDINATION_INPUT_INVALID", "DECODE", detail);
}

export function createCoordinationService(
  dependencies: CoordinationDependencies,
): CoordinationService {
  function clock(): number | null {
    try {
      const now = dependencies.now();
      return Number.isSafeInteger(now) && now >= 0 ? now : null;
    } catch {
      return null;
    }
  }

  function authenticate(
    endpoint: CoordinationEndpoint, requestDigest: string, presentation: unknown,
    transportId: string, now: number,
  ): CoordinationBinding | null {
    try {
      return readBinding(dependencies.authenticate(Object.freeze({
        endpoint, endpointVersion: COORDINATION_ENDPOINT_VERSION, now, presentation,
        requestDigest, scope: COORDINATION_SCOPE, transportId,
      })));
    } catch {
      return null;
    }
  }

  /** Every address an endpoint touches is resolved through the registry, and any terminal /
   *  effect-wrapper address additionally needs a current positive effect binding. */
  function checkAddress(address: CoordinationAddress, now: number): CoordinationRefused | null {
    let answer: unknown;
    try {
      answer = dependencies.resolveRecipient(address);
    } catch {
      answer = undefined;
    }
    if (!isKnownRecipient(answer, address)) {
      return refuse(
        "COORDINATION_RECIPIENT_UNKNOWN", "ADDRESS",
        `the ${addressLabel(address)} address is not a known coordination session`,
      );
    }
    if (address.effectId === null) return null;
    const query = { effectId: address.effectId, now, sessionId: address.sessionId };
    let bound: unknown;
    try {
      bound = dependencies.resolveEffectBinding(query);
    } catch {
      bound = undefined;
    }
    return isBoundEffect(bound, query) ? null : refuse(
      "COORDINATION_TERMINAL_BINDING_INVALID", "ADDRESS",
      "the terminal address has no current effect binding for that session",
    );
  }

  function begin(
    endpoint: CoordinationEndpoint, requestDigest: string, presentation: unknown,
    transportId: string, sessionId: string, capability: string,
  ): CoordinationRefused | Session {
    const now = clock();
    if (now === null) return badInput("the server clock is not usable");
    const binding = authenticate(endpoint, requestDigest, presentation, transportId, now);
    if (binding === null) {
      return refuse(
        "COORDINATION_AUTHENTICATION_FAILED", "AUTHENTICATION",
        "the authenticator did not return a frozen positive binding for this request",
      );
    }
    if (binding.sessionId !== sessionId) {
      return refuse(
        "COORDINATION_SENDER_MISMATCH", "AUTHENTICATION",
        "the authenticated session does not own the addressed identity",
      );
    }
    if (!binding.capabilities.includes(capability)) {
      return refuse(
        "COORDINATION_CAPABILITY_DENIED", "CAPABILITY",
        "the authenticated session lacks the exact capability this endpoint requires",
      );
    }
    return { binding, now };
  }

  function send(input: CoordinationSendRequest): CoordinationSendResult {
    const request = readCoordinationSendRequest(input);
    if (request === null) return badInput("send request must be an exact data record");
    if (!isIdentifier(request.transportId, COORDINATION_LIMITS.maxIdentifierUtf8Bytes)) {
      return badInput("transportId is not a valid identifier");
    }
    const decoded = decodeCoordinationEnvelope(request.envelope);
    if (!decoded.ok) return refuse(decoded.code, decoded.layer, decoded.detail);
    const envelope = decoded.envelope;
    const started = begin(
      "SEND", digestValidatedCoordinationSendRequest(request.transportId, decoded.canonicalBytes),
      request.presentation, request.transportId, envelope.sender.sessionId,
      coordinationCapability("SEND", envelope.recipient.sessionId, envelope.kind),
    );
    if ("outcome" in started) return started;
    const senderRefusal = checkAddress(envelope.sender, started.now);
    if (senderRefusal !== null) return senderRefusal;
    const recipientRefusal = checkAddress(envelope.recipient, started.now);
    if (recipientRefusal !== null) return recipientRefusal;
    if (envelope.kind === "RESPONSE") {
      const stored = dependencies.mailbox.lookup({
        mailbox: envelope.sender, messageId: envelope.inReplyTo, now: started.now,
      });
      // A refused lookup IS the command's answer: a store failure must never be narrowed
      // into the permanent REPLY_TARGET_MISSING verdict that a true null absence earns.
      if (stored !== null && "outcome" in stored) return stored;
      const correlation = checkCorrelation(envelope, stored);
      if (correlation !== null) return correlation;
    }
    return dependencies.mailbox.send({
      canonicalBytes: decoded.canonicalBytes, digest: decoded.digest, envelope,
      now: started.now,
    });
  }

  function openMailbox(
    endpoint: MailboxEndpoint, request: CoordinationMailboxRequest,
    extra: readonly Uint8Array[],
  ): CoordinationRefused | OpenMailbox {
    if (!isIdentifier(request.transportId, COORDINATION_LIMITS.maxIdentifierUtf8Bytes)) {
      return badInput("transportId is not a valid identifier");
    }
    const address = readMailboxAddress(request.mailbox);
    if (address === null) return badInput("mailbox must be an exact address record");
    const limit = readLimit(request.limit);
    if ("outcome" in limit) return limit;
    // Each component is separately length-framed by the shared signer/verifier helper.
    const digest = digestValidatedCoordinationMailboxRequest(
      endpoint, request.transportId, address, limit.value, extra,
    );
    const started = begin(
      endpoint, digest, request.presentation, request.transportId, address.sessionId,
      coordinationCapability(endpoint, address.sessionId),
    );
    if ("outcome" in started) return started;
    const refusal = checkAddress(address, started.now);
    // The VALIDATED frozen address travels onward; the caller's raw object never does.
    return refusal ?? { ...started, address, limit: limit.value };
  }

  function read(input: CoordinationMailboxRequest): CoordinationReadResult {
    const request = readCoordinationMailboxRequest(input);
    if (request === null) return badInput("read request must be an exact data record");
    const opened = openMailbox("READ", request, []);
    if ("outcome" in opened) return opened;
    return dependencies.mailbox.read({
      limit: opened.limit, mailbox: opened.address, now: opened.now,
    });
  }

  function replay(input: CoordinationReplayRequest): CoordinationReadResult {
    const request = readCoordinationReplayRequest(input);
    if (request === null) return badInput("replay request must be an exact data record");
    if (!Number.isSafeInteger(request.fromSequence) || request.fromSequence < 0) {
      return badInput("fromSequence must be a non-negative safe integer");
    }
    const opened = openMailbox("REPLAY", request, [textBytes(String(request.fromSequence))]);
    if ("outcome" in opened) return opened;
    return dependencies.mailbox.replay({
      fromSequence: request.fromSequence, limit: opened.limit, mailbox: opened.address,
      now: opened.now,
    });
  }

  function acknowledge(input: CoordinationAcknowledgeRequest): CoordinationAckResult {
    const request = readCoordinationAcknowledgeRequest(input);
    if (request === null) return badInput("acknowledge request must be an exact data record");
    const limits = COORDINATION_LIMITS;
    if (!isIdentifier(request.messageId, limits.maxIdentifierUtf8Bytes)) {
      return badInput("messageId is not a valid identifier");
    }
    if (!isIdentifier(request.digest, limits.maxIdentifierUtf8Bytes)) {
      return badInput("digest is not a valid identifier");
    }
    if (!Number.isSafeInteger(request.sequence) || request.sequence <= 0) {
      return badInput("sequence must be a positive safe integer");
    }
    const opened = openMailbox("ACKNOWLEDGE", request, [
      textBytes(request.messageId), textBytes(request.digest),
      textBytes(String(request.sequence)),
    ]);
    if ("outcome" in opened) return opened;
    return dependencies.mailbox.acknowledge({
      digest: request.digest, mailbox: opened.address, messageId: request.messageId,
      now: opened.now, sequence: request.sequence,
    });
  }

  return Object.freeze({ acknowledge, read, replay, send });
}
