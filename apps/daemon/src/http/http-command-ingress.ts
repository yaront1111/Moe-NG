import {
  EMPTY_NEXT_ALLOWED_COMMANDS,
  RUNTIME_ERROR_REGISTRY_VERSION,
  createRuntimeError,
  decodeRuntimeCommandEnvelopeBytes,
  lookupRuntimeError,
} from "@moe/contracts";
import type { JsonObject, RuntimeCommandEnvelope, RuntimeError, RuntimeErrorDetails }
  from "@moe/contracts";

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
  HttpPortRefused,
  HttpRefusalStage,
  HttpRefused,
} from "./http-contract.js";

/**
 * THE INGRESS ORDER, and nothing else. Moved here VERBATIM from `./http-adapter.js` when
 * the asynchronous entry landed: one authority decides authenticate -> compatibility ->
 * bounded decode -> registry -> authorize -> payload shape, and both entries in the
 * adapter call it. Two entries that each re-implemented this order could drift, and a
 * drift here would move authentication relative to payload decoding.
 *
 * `authenticateHttpRequest` is re-exported from `./http-adapter.js` on its original path,
 * so every consumer that already imported it from there keeps resolving unchanged.
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

export type HttpAccessResult = HttpPortRefused | HttpRefused | {
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
  if (authenticated.verdict === "REFUSED") {
    return Object.freeze({
      httpStatus: authenticated.refusal.httpStatus,
      ok: false as const,
      outcome: "PORT_REFUSED" as const,
      refusal: authenticated.refusal,
      stage: "AUTHENTICATE" as const,
    });
  }
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

/** Everything the ingress order decided, once, for whichever entry asked. */
export interface PreparedCommand {
  readonly entry: CommandRegistryEntry;
  readonly envelope: RuntimeCommandEnvelope;
  readonly ok: true;
  readonly principal: AuthenticatedPrincipal;
}

/**
 * THE SINGLE ORDERING AUTHORITY, shared verbatim by both entries: authenticate ->
 * compatibility -> bounded decode -> registry -> authorize -> payload shape. Neither
 * entry may re-check or skip a step it decided here.
 */
export function prepareCommand(
  deps: CommandAdapterDeps,
  request: HttpCommandRequest,
): HttpPortRefused | HttpRefused | PreparedCommand {
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

  return Object.freeze({
    entry,
    envelope: decoded.envelope,
    ok: true as const,
    principal: access.principal,
  });
}
