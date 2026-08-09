import {
  EMPTY_NEXT_ALLOWED_COMMANDS,
  RUNTIME_ERROR_REGISTRY_VERSION,
  createRuntimeError,
  decodeRuntimeCommandEnvelopeBytes,
  lookupRuntimeError,
} from "@moe/contracts";
import type {
  JsonObject,
  RuntimeCommandEnvelope,
  RuntimeError,
  RuntimeErrorDetails,
} from "@moe/contracts";

import {
  MAX_COMMAND_PAYLOAD_FIELDS,
  WIRE_PROTOCOL_VERSION,
} from "./http-contract.js";
import type {
  AuthenticatedPrincipal,
  Authenticator,
  CommandAdapterDeps,
  CommandRegistryEntry,
  HttpCommandRequest,
  HttpCommandResult,
  HttpRefusalStage,
  HttpRefused,
} from "./http-contract.js";

/**
 * The control-room command seam.
 *
 * Ingress order is load-bearing and is not a style choice:
 *   authenticate -> compatibility -> bounded decode -> registry -> authorize
 *   -> payload shape -> durable decision -> dispatch.
 *
 * Authentication answers FIRST because the envelope's own `sessionCredential` is only
 * readable after decoding, so any other order makes the daemon parse attacker-controlled
 * bytes on behalf of a caller it has not identified. Compatibility answers second for the
 * same reason: a build the daemon cannot talk to should never reach the parser.
 *
 * Authorization answers before the payload is shape-checked, and nothing consults storage
 * for the target before authorization passes, so no refusal can reveal whether the target
 * exists. Both refusals are constant values with no request-derived content.
 */

const EMPTY_DETAILS: RuntimeErrorDetails = Object.freeze(
  Object.create(null) as Record<string, boolean | number | string>,
);

const AUTHENTICATION_FAILED = createRuntimeError({ code: "AUTHENTICATION_FAILED" });
const CAPABILITY_DENIED = createRuntimeError({ code: "CAPABILITY_DENIED" });
const INPUT_INVALID = createRuntimeError({ code: "INPUT_INVALID" });
const PAYLOAD_FIELDS_EXCEEDED = createRuntimeError({
  code: "INPUT_LIMIT_EXCEEDED",
  details: { limitName: "COMMAND_PAYLOAD_FIELDS" },
});

/**
 * `DISTRIBUTION_MISMATCH` declares a `PROJECT` lifecycle source, and `createRuntimeError`
 * fails closed to `UNKNOWN_ERROR` unless one is supplied. The seam refuses before it has
 * read any project state — that is the point of checking compatibility this early — so
 * claiming a source would invent daemon truth. Retryability, recovery and transport are
 * projected VERBATIM from the registry row because those are facts about the code;
 * `truthClass` is `OBSERVED` because the seam itself compared the two pinned versions.
 * This mirrors the same decision `client-compat.ts` made on the control-room side.
 */
const MISMATCH_ROW = lookupRuntimeError("DISTRIBUTION_MISMATCH");

const DISTRIBUTION_MISMATCH: RuntimeError = Object.freeze({
  code: "DISTRIBUTION_MISMATCH",
  correlationId: null,
  details: EMPTY_DETAILS,
  nextAllowedCommands: EMPTY_NEXT_ALLOWED_COMMANDS,
  recoveryCategory: MISMATCH_ROW.recoveryCategory,
  recoveryCommands: MISMATCH_ROW.recoveryCommands,
  registryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
  retryability: MISMATCH_ROW.retryability,
  transport: MISMATCH_ROW.transport,
  truthClass: "OBSERVED",
});

function refuse(stage: HttpRefusalStage, error: RuntimeError): HttpRefused {
  return Object.freeze({
    error,
    httpStatus: error.transport.httpStatus,
    ok: false as const,
    outcome: "REFUSED" as const,
    stage,
  });
}

export type HttpAccessResult = HttpRefused | {
  readonly ok: true;
  readonly principal: AuthenticatedPrincipal;
};

/** Shared authenticate -> compatibility gate for commands and authenticated reads. */
export function authenticateHttpRequest(
  authenticator: Authenticator,
  credential: string | null,
  protocolVersion: unknown,
): HttpAccessResult {
  const authenticated = authenticator.authenticate(credential);
  if (authenticated.verdict !== "AUTHENTICATED") {
    return refuse("AUTHENTICATE", AUTHENTICATION_FAILED);
  }
  if (protocolVersion !== WIRE_PROTOCOL_VERSION) {
    return refuse("COMPATIBILITY", DISTRIBUTION_MISMATCH);
  }
  return Object.freeze({ ok: true, principal: authenticated.principal });
}

/**
 * Field count first, then the allow-list. A payload one field over the bound is a bound
 * refusal even when every one of its keys is listed, so the two rules cannot mask each
 * other and the reason code always names the rule that actually fired.
 */
function checkPayload(payload: JsonObject, allowed: readonly string[]): RuntimeError | null {
  const keys = Object.keys(payload);
  if (keys.length > MAX_COMMAND_PAYLOAD_FIELDS) return PAYLOAD_FIELDS_EXCEEDED;
  const permitted = new Set(allowed);
  for (const key of keys) {
    if (!permitted.has(key)) return INPUT_INVALID;
  }
  return null;
}

/**
 * The durable decision owns replay. The seam hands it a commit thunk and never calls the
 * handler itself, so a replay that returns the stored decision provably runs no second
 * effect — the seam has no other path to the handler.
 */
function dispatch(
  deps: CommandAdapterDeps,
  entry: CommandRegistryEntry,
  envelope: RuntimeCommandEnvelope,
  principal: AuthenticatedPrincipal,
): HttpCommandResult {
  const result = deps.decisions.decide(
    {
      commandId: envelope.commandId,
      principalId: principal.principalId,
      projectId: principal.projectId,
    },
    envelope.requestDigest,
    () => entry.handler({ envelope, principal }),
  );

  if (result.outcome === "REFUSED") {
    return Object.freeze({
      httpStatus: result.refusal.httpStatus,
      ok: false as const,
      outcome: "PORT_REFUSED" as const,
      refusal: Object.freeze({ ...result.refusal }),
      stage: "DISPATCH" as const,
    });
  }
  return Object.freeze({
    decision: Object.freeze({ ...result.decision }),
    httpStatus: 200 as const,
    ok: true as const,
    outcome: "ACCEPTED" as const,
  });
}

/**
 * Handles one command request. Knows no command: everything specific arrives through the
 * injected registry, so a command seam that does not exist yet is added by registering an
 * entry rather than by editing this function.
 */
export function handleCommandRequest(
  deps: CommandAdapterDeps,
  request: HttpCommandRequest,
): HttpCommandResult {
  const access = authenticateHttpRequest(
    deps.authenticator,
    request.credential,
    request.protocolVersion,
  );
  if (!access.ok) return access;

  const decoded = decodeRuntimeCommandEnvelopeBytes(request.body);
  if (!decoded.ok) return refuse("DECODE", decoded.error);

  const entry = deps.registry.get(decoded.envelope.commandKind);
  if (entry === undefined) return refuse("REGISTRY", INPUT_INVALID);

  if (!access.principal.capabilities.includes(entry.requiredCapability)) {
    return refuse("AUTHORIZE", CAPABILITY_DENIED);
  }

  const shapeError = checkPayload(decoded.envelope.payload, entry.payloadKeys);
  if (shapeError !== null) return refuse("PAYLOAD_SHAPE", shapeError);

  return dispatch(deps, entry, decoded.envelope, access.principal);
}
