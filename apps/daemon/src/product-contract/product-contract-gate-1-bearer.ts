import { createHash } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";

import type { TransportOrigin } from "../http/http-contract.js";
import {
  SESSION_PROOF_MAX_AGE_MS, SESSION_PROOF_MAX_FUTURE_SKEW_MS,
} from "../identity/session-authority-contracts.js";
import {
  isBoundedId, isSessionDigest, isUnsignedSafeInteger, readExactRecord,
} from "../identity/session-authority-protocol.js";
import {
  observeReplayMarker, readPrincipalRecord,
} from "../identity/session-authority-store.js";

/**
 * Ruling comment-07a17d40's stage-E bearer branch.
 *
 * `payload.authentication` is only a presentation of request pointers. The
 * bearer credential NEVER enters command payload bytes because requestBytes
 * are durable. The witness instead travels in the composition root's own
 * arguments after ingress has authenticated the credential.
 */

const LAYER = "DAEMON_GATE_1_BEARER" as const;
const REPLAY_DOMAIN = "moe/product-contract/gate-1/bearer-replay/v1";

export const PRODUCT_CONTRACT_GATE_1_BEARER_CODES = Object.freeze([
  "PRODUCT_CONTRACT_GATE_1_BEARER_WITNESS_MISSING",
  "PRODUCT_CONTRACT_GATE_1_BEARER_PRESENTATION_INVALID",
  "PRODUCT_CONTRACT_GATE_1_BEARER_PRESENTATION_STALE",
  "PRODUCT_CONTRACT_GATE_1_BEARER_PRINCIPAL_ABSENT",
  "PRODUCT_CONTRACT_GATE_1_BEARER_KIND_REFUSED",
  "PRODUCT_CONTRACT_GATE_1_BEARER_ORIGIN_REFUSED",
  "PRODUCT_CONTRACT_GATE_1_BEARER_REPLAYED",
  "PRODUCT_CONTRACT_GATE_1_BEARER_UNREADABLE",
] as const);

export const PRODUCT_CONTRACT_GATE_1_BEARER_ORIGINS = Object.freeze([
  "MCP_STDIO", "MCP_HTTP",
] satisfies readonly TransportOrigin[]);

export type ProductContractGate1BearerCode =
  (typeof PRODUCT_CONTRACT_GATE_1_BEARER_CODES)[number];
export type ProductContractGate1BearerLayer = typeof LAYER;

export interface BearerSessionWitness {
  readonly sessionId: string;
  readonly transportOrigin?: unknown;
}

export interface BearerPresentation {
  readonly issuedAt: number;
  readonly kind: "BEARER";
  readonly requestId: string;
  readonly requestDigest: string;
}

export const BEARER_PRESENTATION_KEYS = Object.freeze([
  "issuedAt", "kind", "requestId", "requestDigest",
] as const);

type BearerRefusal = Readonly<{
  code: ProductContractGate1BearerCode;
  layer: ProductContractGate1BearerLayer;
  ok: false;
}>;

type BearerAdmission =
  | Readonly<{ ok: true; facts: Readonly<{ principalId: string; principalKind: "HUMAN" }> }>
  | BearerRefusal;

type BearerWitnessOriginAdmission =
  | Readonly<{ ok: true; witness: BearerSessionWitness }>
  | BearerRefusal;

interface AuthorizeBearerInput {
  readonly commandId: string;
  readonly grantedAtEpochMs: number;
  readonly presentation: BearerPresentation;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  readonly subjectDigest: string;
  readonly witness: BearerSessionWitness | undefined;
}

const refuse = (code: ProductContractGate1BearerCode): BearerRefusal =>
  Object.freeze({ code, layer: LAYER, ok: false as const });

function isBearerTransportOrigin(value: unknown): value is TransportOrigin {
  return typeof value === "string"
    && (PRODUCT_CONTRACT_GATE_1_BEARER_ORIGINS as readonly string[]).includes(value);
}

export function admitBearerWitnessOrigin(
  witness: BearerSessionWitness | undefined,
): BearerWitnessOriginAdmission {
  if (witness === undefined) {
    return refuse("PRODUCT_CONTRACT_GATE_1_BEARER_WITNESS_MISSING");
  }
  if (!isBearerTransportOrigin(witness.transportOrigin)) {
    return refuse("PRODUCT_CONTRACT_GATE_1_BEARER_ORIGIN_REFUSED");
  }
  return Object.freeze({ ok: true as const, witness });
}

function readBearerPresentation(value: unknown): BearerPresentation | null {
  const raw = readExactRecord(value, BEARER_PRESENTATION_KEYS);
  if (raw === null || raw["kind"] !== "BEARER"
    || !isUnsignedSafeInteger(raw["issuedAt"])
    || !isBoundedId(raw["requestId"])
    || !isSessionDigest(raw["requestDigest"])) return null;
  return Object.freeze({
    issuedAt: raw["issuedAt"], kind: "BEARER" as const,
    requestDigest: raw["requestDigest"], requestId: raw["requestId"],
  });
}

export function isBearerPresentation(value: unknown): value is BearerPresentation {
  return readBearerPresentation(value) !== null;
}

function bearerReplayDigest(
  sessionId: string, requestId: string, requestDigest: string,
): string {
  return createHash("sha256")
    .update([REPLAY_DOMAIN, sessionId, requestId, requestDigest].join("\0"), "utf8")
    .digest("hex");
}

export function authorizeBearerPresentation(input: AuthorizeBearerInput): BearerAdmission {
  const origin = admitBearerWitnessOrigin(input.witness);
  if (!origin.ok) return origin;
  const witness = origin.witness;
  const presentation = readBearerPresentation(input.presentation);
  if (presentation === null) {
    return refuse("PRODUCT_CONTRACT_GATE_1_BEARER_PRESENTATION_INVALID");
  }
  const { issuedAt, requestDigest, requestId } = presentation;
  if (requestId !== input.commandId || requestDigest !== input.subjectDigest) {
    return refuse("PRODUCT_CONTRACT_GATE_1_BEARER_PRESENTATION_INVALID");
  }
  if (input.grantedAtEpochMs - issuedAt > SESSION_PROOF_MAX_AGE_MS
    || issuedAt - input.grantedAtEpochMs > SESSION_PROOF_MAX_FUTURE_SKEW_MS) {
    return refuse("PRODUCT_CONTRACT_GATE_1_BEARER_PRESENTATION_STALE");
  }
  const principal = readPrincipalRecord(input.store, witness.sessionId);
  if (principal.status === "ABSENT") {
    return refuse("PRODUCT_CONTRACT_GATE_1_BEARER_PRINCIPAL_ABSENT");
  }
  if (principal.status === "UNKNOWN") return refuse("PRODUCT_CONTRACT_GATE_1_BEARER_UNREADABLE");
  if (principal.principal.kind !== "HUMAN") {
    return refuse("PRODUCT_CONTRACT_GATE_1_BEARER_KIND_REFUSED");
  }
  const observation = observeReplayMarker(input.store, {
    decidedAt: new Date(input.grantedAtEpochMs).toISOString(),
    principalId: witness.sessionId,
    projectId: input.projectId,
    replayDigest: bearerReplayDigest(witness.sessionId, requestId, requestDigest),
  });
  if (observation.outcome === "UNKNOWN") {
    return refuse("PRODUCT_CONTRACT_GATE_1_BEARER_UNREADABLE");
  }
  if (observation.outcome === "REPLAYED") {
    return refuse("PRODUCT_CONTRACT_GATE_1_BEARER_REPLAYED");
  }
  return Object.freeze({
    facts: Object.freeze({ principalId: witness.sessionId, principalKind: "HUMAN" as const }),
    ok: true as const,
  });
}
