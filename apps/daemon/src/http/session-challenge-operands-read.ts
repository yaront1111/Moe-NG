/**
 * The three store-held operands `openSession` verifies a client signature
 * against, published on an AUTHENTICATED read (task-c338dd23).
 *
 * `openSession` (identity/session-authority.ts:141) takes `sessionId` and
 * `credentialId` from its own caller, so a browser already chooses those. What
 * it does NOT hand out are the operands it folds in server-side: the project's
 * active recovery binding, which `SessionProofChallengeFields` extends, and the
 * principal's `profileRevisionId`, which `sessionAuthorityRequestDigest`
 * absorbs. Without them no client can compute the signature the mint demands.
 *
 * THIS ROUTE MINTS NOTHING AND ADJUDICATES NO SESSION AUTHORITY. It answers
 * with durable values it did not author, to the authenticated principal those
 * values already describe.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import {
  readCurrentRecoveryAuthenticationBinding,
} from "../identity/recovery-authentication-binding.js";
import { readPrincipalRecord } from "../identity/session-authority-store.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const SESSION_CHALLENGE_OPERANDS_READ_PATH = "/session/challenge-operands/read" as const;

/**
 * PRIVATE ON PURPOSE, mirroring product-contract-gate-1-read.ts:29-34. An
 * exported `*_LAYER` constant is a rostered security boundary owing its own
 * coverage arms; this route declares no boundary beyond the codes below, all of
 * which are local facts about its caller or about durable absence.
 */
const SESSION_CHALLENGE_OPERANDS_READ_LAYER = "SESSION_CHALLENGE_OPERANDS_READ" as const;

/**
 * The published operand roster, sorted and frozen. It is the SINGLE source for
 * the answer's key set: the view is assembled from it rather than from a
 * literal, so deleting a member changes the shipped response and the suite's
 * exact-count assertion fires.
 */
export const SESSION_CHALLENGE_OPERAND_KEYS = Object.freeze([
  "keyEpochRef", "profileRevisionId", "recoveryIncarnationRef",
] as const);

export type SessionChallengeOperandKey = (typeof SESSION_CHALLENGE_OPERAND_KEYS)[number];

/** A caller names NOTHING: the principal is the authenticated one, never a body field. */
const REQUEST_KEYS: readonly string[] = Object.freeze([]);

/**
 * ROUTE-LOCAL codes. Capability, project binding and caller-supplied operands
 * are this route's OWN questions about its caller; the two absence codes report
 * durable state that no upstream reader stamps a refusal for, because both
 * readers answer with `null`/`ABSENT` rather than a coded refusal.
 */
export const SESSION_CHALLENGE_OPERANDS_READ_CODES = Object.freeze([
  "SESSION_CHALLENGE_OPERANDS_CALLER_SUPPLIED",
  "SESSION_CHALLENGE_OPERANDS_CAPABILITY_DENIED",
  "SESSION_CHALLENGE_OPERANDS_PRINCIPAL_ABSENT",
  "SESSION_CHALLENGE_OPERANDS_PROJECT_MISMATCH",
  "SESSION_CHALLENGE_OPERANDS_RECOVERY_BINDING_ABSENT",
] as const);

export type SessionChallengeOperandsReadCode =
  (typeof SESSION_CHALLENGE_OPERANDS_READ_CODES)[number];

export type SessionChallengeOperandsReadLayer = typeof SESSION_CHALLENGE_OPERANDS_READ_LAYER;

export type SessionChallengeOperands = Readonly<Record<SessionChallengeOperandKey, string>>;

export interface SessionChallengeOperandsView {
  readonly operands: SessionChallengeOperands;
  readonly outcome: "OPERANDS";
}

export interface SessionChallengeOperandsRefused {
  readonly code: SessionChallengeOperandsReadCode;
  readonly layer: SessionChallengeOperandsReadLayer;
  readonly outcome: "REFUSED";
}

export type SessionChallengeOperandsReadResult =
  | SessionChallengeOperandsRefused
  | SessionChallengeOperandsView;

export interface SessionChallengeOperandsReadPort {
  readonly boundProjectId: string;
  readOperands(principalId: string): SessionChallengeOperandsReadResult;
}

function refused(code: SessionChallengeOperandsReadCode): SessionChallengeOperandsRefused {
  return Object.freeze({
    code, layer: SESSION_CHALLENGE_OPERANDS_READ_LAYER, outcome: "REFUSED" as const,
  });
}

/**
 * Projects the durable values THROUGH the roster, so the roster is the single
 * source of the shipped key set rather than a decorative mirror of a literal.
 *
 * This is what makes the denominator drill meaningful: delete a roster member
 * and the published response loses that key, which the suite's exact
 * set-equality arm catches. A literal object here would leave the roster
 * unfalsifiable — deletable without changing a single shipped byte.
 */
function operandsFrom(
  values: Readonly<Record<SessionChallengeOperandKey, string>>,
): SessionChallengeOperands {
  const projected: Record<string, string> = {};
  for (const key of SESSION_CHALLENGE_OPERAND_KEYS) projected[key] = values[key];
  return Object.freeze(projected) as SessionChallengeOperands;
}

/**
 * Reads the operands for ONE authenticated principal.
 *
 * Every value is taken from the durable store: none is recomputed, defaulted,
 * or accepted from a caller. A missing principal and a missing recovery binding
 * are distinct codes, so "we have no record of you" is never confused with
 * "this project has no active binding".
 */
export function readSessionChallengeOperands(
  store: SqliteEventStore, principalId: string,
): SessionChallengeOperandsReadResult {
  const owner = readPrincipalRecord(store, principalId);
  if (owner.status !== "FOUND") return refused("SESSION_CHALLENGE_OPERANDS_PRINCIPAL_ABSENT");
  const recovery = readCurrentRecoveryAuthenticationBinding(store);
  if (recovery === null) {
    return refused("SESSION_CHALLENGE_OPERANDS_RECOVERY_BINDING_ABSENT");
  }
  return Object.freeze({
    operands: operandsFrom({
      keyEpochRef: recovery.keyEpochRef,
      profileRevisionId: owner.principal.profileRevisionId,
      recoveryIncarnationRef: recovery.recoveryIncarnationRef,
    }),
    outcome: "OPERANDS" as const,
  });
}

export function createSessionChallengeOperandsReadPort(config: {
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): SessionChallengeOperandsReadPort {
  return Object.freeze({
    boundProjectId: config.projectId,
    readOperands: (principalId: string): SessionChallengeOperandsReadResult =>
      readSessionChallengeOperands(config.store, principalId),
  });
}

type SessionChallengeOperandsListenerCode =
  | "LISTENER_SESSION_CHALLENGE_OPERANDS_REQUEST_INVALID"
  | "LISTENER_SESSION_CHALLENGE_OPERANDS_UNAVAILABLE";

export type SessionChallengeOperandsReadDispatch =
  | { readonly body: HttpPortRefused | HttpRefused | SessionChallengeOperandsReadResult;
      readonly httpStatus: number; readonly kind: "REPLY" }
  | { readonly code: SessionChallengeOperandsListenerCode; readonly kind: "LISTENER_REFUSAL" };

type BodyVerdict =
  | { readonly outcome: "ACCEPTED" }
  | { readonly outcome: "CALLER_SUPPLIED" }
  | { readonly outcome: "INVALID" };

/**
 * The exact-key body fence, with the caller-supplied check FIRST.
 *
 * A body naming one of the published operands is a caller trying to shape an
 * answer this route derives from durable state. It gets its own stable code
 * rather than the generic transport refusal, because collapsing the two would
 * make the attempt indistinguishable from a typo.
 */
function readRequestBody(body: unknown): BodyVerdict {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return { outcome: "INVALID" };
  const record = decoded.value;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return { outcome: "INVALID" };
  }
  const keys = Object.keys(record as Readonly<Record<string, unknown>>);
  if (keys.some((key) => (SESSION_CHALLENGE_OPERAND_KEYS as readonly string[]).includes(key))) {
    return { outcome: "CALLER_SUPPLIED" };
  }
  return keys.length === REQUEST_KEYS.length ? { outcome: "ACCEPTED" } : { outcome: "INVALID" };
}

function reply(
  body: HttpPortRefused | HttpRefused | SessionChallengeOperandsReadResult, httpStatus: number,
): SessionChallengeOperandsReadDispatch {
  return Object.freeze({ body, httpStatus, kind: "REPLY" as const });
}

export function handleSessionChallengeOperandsReadRequest(
  dependencies: {
    readonly authenticator: Authenticator;
    readonly sessionChallengeOperands?: SessionChallengeOperandsReadPort | undefined;
  },
  request: {
    readonly body: unknown; readonly credential: string | null;
    readonly protocolVersion: unknown;
  },
): SessionChallengeOperandsReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) return reply(access, access.httpStatus);
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return reply(refused("SESSION_CHALLENGE_OPERANDS_CAPABILITY_DENIED"), 200);
  }
  const port = dependencies.sessionChallengeOperands;
  if (port === undefined) {
    return Object.freeze({
      code: "LISTENER_SESSION_CHALLENGE_OPERANDS_UNAVAILABLE", kind: "LISTENER_REFUSAL" as const,
    });
  }
  if (access.principal.projectId !== port.boundProjectId) {
    return reply(refused("SESSION_CHALLENGE_OPERANDS_PROJECT_MISMATCH"), 200);
  }
  const verdict = readRequestBody(request.body);
  if (verdict.outcome === "CALLER_SUPPLIED") {
    return reply(refused("SESSION_CHALLENGE_OPERANDS_CALLER_SUPPLIED"), 200);
  }
  if (verdict.outcome === "INVALID") {
    return Object.freeze({
      code: "LISTENER_SESSION_CHALLENGE_OPERANDS_REQUEST_INVALID",
      kind: "LISTENER_REFUSAL" as const,
    });
  }
  return reply(port.readOperands(access.principal.principalId), 200);
}
