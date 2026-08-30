import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import { admitProductContractRevisionRef, grantHumanAuthority,
  productContractGate1Authority } from "@moe/core";
import type { HumanAuthorityGate, ProductContractRevisionRef } from "@moe/core";
import { identifyReplayRequest } from "@moe/store";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";

import type { SessionAuthorityService } from "../identity/session-authority-contracts.js";
import { isTransportOrigin } from "../http/http-contract.js";
import { readPresentedAuthentication, readSessionProof }
  from "../identity/session-authority-protocol.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_EVENT_TYPE,
  PRODUCT_CONTRACT_GATE_1_PAYLOAD_KEYS, PRODUCT_CONTRACT_GATE_1_REQUEST_KEYS,
  PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION, acceptedProductContractGate1,
  deriveProductContractGate1AggregateId, productContractGate1Refusal,
  productContractGate1SubjectDigest,
} from "./product-contract-gate-1-contract.js";
import type {
  ProductContractGate1Outcome, ProductContractGate1Refused, ProductContractGate1Request,
} from "./product-contract-gate-1-contract.js";
import {
  authorizeBearerPresentation, isBearerPresentation,
} from "./product-contract-gate-1-bearer.js";
import type { BearerSessionWitness } from "./product-contract-gate-1-bearer.js";

type TransportBoundBearerSessionWitness = BearerSessionWitness & {
  readonly transportOrigin?: unknown;
};

/**
 * `product_contract.approve_gate_1` — the daemon-owned writer that binds ONE
 * authenticated HUMAN grant to ONE product-contract revision.
 *
 * NOTHING THE CALLER SENDS IS AUTHORITY. The payload carries POINTERS: an
 * identity triple and either a signed or bearer presentation. The principal and
 * its KIND come from the selected stage-E authority, the moment from the
 * `decidedAt` the registry stamped, and the gate and its work reference from
 * `@moe/core`. This module reads no clock and mints no randomness.
 *
 * The authentication evidence is BURNED at (E) even when (F) then refuses, exactly as
 * `../recovery/recovery-completion.ts` documents: a proof a rejected attempt
 * could hand back unspent would not be single-use. That burn touches the
 * identity aggregate, never this command's.
 *
 * STAGE ORDER IS THE CONTRACT:
 *   A  envelope decode      structural, this layer
 *   B  durable replay       answered from the store, never re-adjudicated
 *   C  CORE ref admission   `admitProductContractRevisionRef`, verdict verbatim
 *   D  presentation binding requestId and subject digest, before authentication
 *   E  session authenticate — signed proof via sessions.authenticate, OR bearer via the
 *      ruling-(b) branch (product-contract-gate-1-bearer.ts); both burn before F
 *   F  human authority gate core's `grantHumanAuthority`, verdict verbatim
 *   G  ONE durable commit   one decision and one event, or none
 *
 * (B) MUST run above (E). The presented proof is single-use, so an honest retry
 * cannot present the same one twice; re-adjudicating a decided command would
 * refuse a replay the store can answer from its own record.
 *
 * IT CLAIMS NOTHING ABOUT THE REVISION'S CONTENT. `validateProductContractGate1`
 * is deliberately NOT called here: it demands a complete admitted revision, and
 * re-proving the stored grant against one is the reader row's seam
 * (task-db1a8566958f416b92105cc2c7e51591). This writer records that a named human
 * granted authority over core's work reference, and no more.
 */

const encoder = new TextEncoder();

const PAYLOAD_KEY_SET: ReadonlySet<string> = new Set<string>(
  PRODUCT_CONTRACT_GATE_1_PAYLOAD_KEYS,
);
const REQUEST_KEY_SET: ReadonlySet<string> = new Set<string>(
  PRODUCT_CONTRACT_GATE_1_REQUEST_KEYS,
);

const malformed = (reason: string): ProductContractGate1Refused =>
  productContractGate1Refusal({ code: "PRODUCT_CONTRACT_GATE_1_REQUEST_MALFORMED", reason });

const authInvalid = (): ProductContractGate1Refused => productContractGate1Refusal({
  code: "PRODUCT_CONTRACT_GATE_1_AUTHENTICATION_INVALID",
  reason: "The approval lacks a fresh proof bound to its exact subject.",
});

const transportOriginInvalid = (): ProductContractGate1Refused => productContractGate1Refusal({
  code: "PRODUCT_CONTRACT_GATE_1_TRANSPORT_ORIGIN_INVALID",
  reason: "Gate 1 requires a named server-stamped transport origin.",
});

/** A FOREIGN verdict, carried out under the layer that produced it. */
const upstream = (code: string, layer: string): ProductContractGate1Refused =>
  productContractGate1Refusal({
    code, reason: "An upstream authority refused this approval.", refusedBy: layer,
  });

/** `decodeBoundedJsonBytes` yields null-prototype objects; anything else is untrusted. */
function isPlainJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object"
    && !Array.isArray(value) && Object.getPrototypeOf(value) === null;
}

function isRef(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasExactKeys(record: JsonObject, roster: ReadonlySet<string>, size: number): boolean {
  const keys = Object.keys(record);
  return keys.length === size && keys.every((key) => roster.has(key));
}

type DecodeResult =
  | { readonly ok: true; readonly request: ProductContractGate1Request }
  | { readonly ok: false; readonly refusal: ProductContractGate1Refused };

/**
 * (A) The envelope the registry assembled. `prepareCommand` already refuses an
 * unlisted payload key INPUT_INVALID at PAYLOAD_SHAPE, so this is not a second
 * authority check — but the shapes are asserted anyway, because a handler that
 * trusted a roster it does not own would fail open if that roster moved.
 */
export function decodeProductContractGate1Request(input: unknown): DecodeResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) return { ok: false, refusal: malformed("The request bytes are not bounded JSON.") };
  const envelope = decoded.value;
  if (!isPlainJsonObject(envelope)
    || !hasExactKeys(envelope, REQUEST_KEY_SET, PRODUCT_CONTRACT_GATE_1_REQUEST_KEYS.length)) {
    return { ok: false, refusal: malformed("The request envelope is not the assembled shape.") };
  }
  const payload = envelope["payload"];
  if (envelope["kind"] !== PRODUCT_CONTRACT_GATE_1_COMMAND_KIND
    || envelope["schemaVersion"] !== PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION
    || !isRef(envelope["commandId"]) || !isRef(envelope["correlationId"])
    || !isRef(envelope["decidedAt"]) || !isRef(envelope["principalId"])
    || !isRef(envelope["projectId"]) || !isPlainJsonObject(payload)
    || !hasExactKeys(payload, PAYLOAD_KEY_SET, PRODUCT_CONTRACT_GATE_1_PAYLOAD_KEYS.length)) {
    return { ok: false, refusal: malformed("The request envelope is not the assembled shape.") };
  }
  const decidedAtEpochMs = Date.parse(envelope["decidedAt"]);
  if (!Number.isSafeInteger(decidedAtEpochMs) || decidedAtEpochMs < 0) {
    return { ok: false, refusal: malformed("The stamped decision moment is not a moment.") };
  }
  return {
    ok: true,
    request: Object.freeze({
      authentication: payload["authentication"],
      // The replay preimage deliberately EXCLUDES the stamped moment: the registry
      // re-stamps `decidedAt` from its clock on every submission, so including it
      // would make an honest retry a byte conflict instead of a replay.
      bytes: encoder.encode(JSON.stringify({
        kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, payload,
      })),
      commandId: envelope["commandId"],
      contractId: payload["contractId"],
      correlationId: envelope["correlationId"],
      decidedAt: envelope["decidedAt"],
      decidedAtEpochMs,
      principalId: envelope["principalId"],
      projectId: envelope["projectId"],
      revisionDigest: payload["revisionDigest"],
      revisionId: payload["revisionId"],
    }),
  };
}

export interface ProductContractGate1AuthorityInput {
  readonly authentication: unknown;
  readonly bearerWitness?: BearerSessionWitness;
  readonly commandId: string;
  readonly grantedAtEpochMs: number;
  readonly ref: ProductContractRevisionRef;
}

export type ProductContractGate1AuthorityOutcome =
  | { readonly gate: HumanAuthorityGate; readonly ok: true }
  | ProductContractGate1Refused;

export interface ProductContractGate1Authority {
  readonly authorize: (
    input: ProductContractGate1AuthorityInput,
  ) => ProductContractGate1AuthorityOutcome;
}

export interface ProductContractGate1AuthorityOptions {
  readonly projectId: string;
  readonly sessions: SessionAuthorityService;
  readonly store: SqliteEventStore;
}

/**
 * (D)+(E)+(F). Mirrors `../recovery/recovery-completion-authority.ts`: bind the
 * presentation to this exact subject FIRST, authenticate SECOND, and let core's
 * gate have the last word — so an AGENT holding ADMIN reach is refused by
 * `grantHumanAuthority` under core's own tuple, not a daemon restatement of it.
 */
export function createProductContractGate1Authority(
  options: ProductContractGate1AuthorityOptions,
): ProductContractGate1Authority {
  const { projectId, sessions, store } = options;

  function authorize(
    input: ProductContractGate1AuthorityInput,
  ): ProductContractGate1AuthorityOutcome {
    // The gate, and therefore the work reference, is CORE's. This module never
    // spells a work reference, which is what the reader row exists to police.
    const gate = productContractGate1Authority(input.ref);
    const subjectDigest = productContractGate1SubjectDigest({
      commandId: input.commandId, projectId, workRef: gate.workRef,
    });
    const grantFrom = (
      facts: Readonly<{ principalId: string; principalKind: string }>,
    ): ProductContractGate1AuthorityOutcome => {
      const human = grantHumanAuthority(
        gate,
        { kind: facts.principalKind, principalId: facts.principalId },
        input.grantedAtEpochMs,
      );
      if (!human.ok) return upstream(human.code, human.layer);
      return human.gate.grant === null ? authInvalid() : { gate: human.gate, ok: true as const };
    };
    if (isBearerPresentation(input.authentication)) {
      const bearer = authorizeBearerPresentation({
        commandId: input.commandId, grantedAtEpochMs: input.grantedAtEpochMs,
        presentation: input.authentication, projectId, store, subjectDigest,
        witness: input.bearerWitness,
      });
      if (!bearer.ok) return upstream(bearer.code, bearer.layer);
      return grantFrom(bearer.facts);
    }
    const presented = readPresentedAuthentication(input.authentication, projectId);
    if (presented === null) return authInvalid();
    if (readSessionProof(presented.proof, input.grantedAtEpochMs) === null) return authInvalid();
    if (presented.requestId !== input.commandId) return authInvalid();
    if (presented.requestDigest !== subjectDigest) return authInvalid();
    const authenticated = sessions.authenticate(input.authentication);
    if (!authenticated.ok) return upstream(authenticated.code, authenticated.layer);
    return grantFrom(authenticated.facts);
  }

  return Object.freeze({ authorize });
}

/** (G) ONE decision and ONE event, on this command's own domain-separated aggregate. */
function commit(
  store: SqliteEventStore,
  request: ProductContractGate1Request,
  ref: ProductContractRevisionRef,
  gate: HumanAuthorityGate,
): ProductContractGate1Outcome {
  const grant = gate.grant;
  if (grant === null) return authInvalid();
  const record = {
    contractId: ref.contractId, gateId: gate.gateId, grant: { ...grant },
    revisionDigest: ref.revisionDigest, revisionId: ref.revisionId, workRef: gate.workRef,
  };
  const body = encoder.encode(JSON.stringify(record));
  // The fence is this aggregate's OWN first version, not the caller's envelope
  // number: the envelope's `expectedVersion` observes the PROJECT aggregate and
  // says nothing about a gate approval. Holding it at 0 also keeps the durable
  // request identity stable across submissions, which is what makes an honest
  // retry a REPLAY; a second, different command over the same revision meets the
  // store's own expected-version answer instead of appending a rival grant.
  const response = store.commitExpectedVersionDecision({
    commandKind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    committedResultBytes: body,
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [{
      domainSchemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
      eventId: `${PRODUCT_CONTRACT_GATE_1_COMMAND_KIND}:${request.commandId}`,
      eventType: PRODUCT_CONTRACT_GATE_1_EVENT_TYPE,
      payload: body,
    }],
    expectedVersion: 0,
    key: {
      commandId: request.commandId, principalId: request.principalId,
      projectId: request.projectId,
    },
    requestBytes: request.bytes,
    targetAggregateId: deriveProductContractGate1AggregateId(gate.workRef),
  });
  return response.decision.effectDisposition === "EFFECTS_COMMITTED"
    ? acceptedProductContractGate1(response.decision, response.disposition)
    : upstream(response.decision.resultCode, "DURABLE_STORE");
}

/**
 * (B) The idempotent replay lookup, answered entirely from the STORE'S OWN
 * record. Same bytes echo the stored decision; different bytes under the same
 * key, or a different kind under it, carry the store's own conflict tuple — the
 * one `IdempotencyConflictError` raises when the commit path reaches it. This
 * layer mints no conflict vocabulary of its own.
 *
 * The digest is recomputed from the STORED decision's own fence, so the
 * resubmitted bytes are the only free variable and a match is byte equality.
 */
function answerReplay(
  request: ProductContractGate1Request, prior: CommandDecisionRecord,
): ProductContractGate1Outcome | null {
  const conflict = (): ProductContractGate1Refused =>
    upstream("IDEMPOTENCY_CONFLICT", "DURABLE_STORE");
  if (prior.commandKind !== PRODUCT_CONTRACT_GATE_1_COMMAND_KIND) return conflict();
  // A refused decision's receipt commits the rejection audit payload, so its
  // `replayRequestSha256` is null and nothing here could prove the resubmit is
  // the command that was decided. Falling through decides it again from scratch.
  if (prior.effectDisposition !== "EFFECTS_COMMITTED") return null;
  return identifyReplayRequest(prior, request.bytes) === prior.replayRequestSha256
    ? acceptedProductContractGate1(prior, "REPLAYED")
    : conflict();
}

/**
 * The command. Replay and byte conflict are the LEDGER's answers, never
 * re-implemented: the digest comparison above is the store's own, and a commit
 * that still races a concurrent writer raises the store's
 * `IdempotencyConflictError`, which `../daemon-command-dispatch.js` surfaces
 * under `DURABLE_STORE`. Deciding either locally would give one refusal two
 * authorities.
 */
export function runProductContractGate1Command(
  store: SqliteEventStore,
  input: unknown,
  authority: ProductContractGate1Authority,
  bearerWitness?: TransportBoundBearerSessionWitness,
): ProductContractGate1Outcome {
  const decoded = decodeProductContractGate1Request(input);
  if (!decoded.ok) return decoded.refusal;
  const request = decoded.request;
  if (!isTransportOrigin(bearerWitness?.transportOrigin)) return transportOriginInvalid();
  const prior = store.getCommandDecision({
    commandId: request.commandId, principalId: request.principalId,
    projectId: request.projectId,
  });
  if (prior !== null) {
    const replayed = answerReplay(request, prior);
    if (replayed !== null) return replayed;
  }
  const admission = admitProductContractRevisionRef({
    contractId: request.contractId,
    revisionDigest: request.revisionDigest,
    revisionId: request.revisionId,
  });
  if (!admission.ok) return upstream(admission.code, admission.layer);
  const granted = authority.authorize({
    authentication: request.authentication,
    ...(bearerWitness === undefined ? {} : { bearerWitness }),
    commandId: request.commandId,
    grantedAtEpochMs: request.decidedAtEpochMs,
    ref: admission.ref,
  });
  if (!granted.ok) return granted;
  return commit(store, request, admission.ref, granted.gate);
}
