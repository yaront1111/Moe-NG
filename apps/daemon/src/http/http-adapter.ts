import type { RuntimeCommandEnvelope } from "@moe/contracts";

import {
  ASYNC_ENTRY_REQUIRED_CODE,
  ASYNC_PORT_UNAVAILABLE_CODE,
  ASYNC_SEAM_REFUSAL_STATUS,
  DAEMON_COMMAND_SEAM,
} from "./http-async-contract.js";
import { prepareCommand } from "./http-command-ingress.js";
import type {
  AuthenticatedPrincipal,
  CommandAdapterDeps,
  CommandHandlerInput,
  CommandRegistryEntry,
  DecisionKey,
  DecisionPortResult,
  HttpCommandRequest,
  HttpCommandResult,
  HttpPortRefused,
  TransportOrigin,
} from "./http-contract.js";

/** On their original path: this module owned the gate before the ingress order moved. */
export { authenticateHttpRequest } from "./http-command-ingress.js";
export type { HttpAccessResult } from "./http-command-ingress.js";

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
 *
 * ONE SHARED CORE, TWO ENTRIES — the decision, recorded so it is not re-opened.
 * Some services are genuinely asynchronous: `createFoundationAttemptService(...).dispatch`
 * awaits a launch port that MUST answer with a native Promise (`contained(..., true)` in
 * `work/foundation-attempt-service.ts` discards any non-Promise answer as `null`), so no
 * async-to-sync adapter can exist — one would have to invent a decision before the launch
 * resolved, which is the fabricated authority this daemon exists to refuse.
 *
 * So `prepareCommand` below owns the ingress ORDER and both entries call it:
 *   - `handleCommandRequest` keeps its legacy two-argument overload and stays SYNCHRONOUS.
 *     No promise, no microtask and no added try/catch is on its path, which is what makes "every
 *     pre-existing kind behaves identically" provable rather than argued.
 *   - `handleAsyncCommandRequest` awaits an async commit and serves BOTH kinds of entry,
 *     awaiting a synchronous handler unchanged.
 * Neither entry re-checks anything `prepareCommand` already decided; two entries that each
 * re-implemented the guard order could drift, and a drift there would move authentication
 * relative to payload decoding.
 */

/** One projection of a decided command, so both entries answer in the same shape. */
function answer(result: DecisionPortResult): HttpCommandResult {
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

/** The seam's own refusal, named as such: a wiring fact, never a port's answer. */
function seamRefusal(code: string, detail: string): HttpPortRefused {
  return Object.freeze({
    httpStatus: ASYNC_SEAM_REFUSAL_STATUS,
    ok: false as const,
    outcome: "PORT_REFUSED" as const,
    refusal: Object.freeze({
      code,
      detail,
      httpStatus: ASYNC_SEAM_REFUSAL_STATUS,
      layer: DAEMON_COMMAND_SEAM,
    }),
    stage: "DISPATCH" as const,
  });
}

function decisionKey(
  envelope: RuntimeCommandEnvelope,
  principal: AuthenticatedPrincipal,
): DecisionKey {
  return {
    commandId: envelope.commandId,
    principalId: principal.principalId,
    projectId: principal.projectId,
  };
}

const TRANSPORT_ORIGIN = Symbol("daemon-command-transport-origin");

function handlerInput(
  envelope: RuntimeCommandEnvelope,
  principal: AuthenticatedPrincipal,
  transportOrigin?: TransportOrigin,
): CommandHandlerInput {
  const input: CommandHandlerInput = { envelope, principal };
  if (transportOrigin === undefined) return input;
  Object.defineProperty(input, TRANSPORT_ORIGIN, { value: transportOrigin });
  return Object.freeze(input);
}

/** Read-only half of the adapter-private carrier; wire callers get no stamper or mutable setter. */
export function readCommandTransportOrigin(input: CommandHandlerInput): unknown {
  return Object.getOwnPropertyDescriptor(input, TRANSPORT_ORIGIN)?.value;
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
  transportOrigin?: TransportOrigin,
): HttpCommandResult {
  return answer(deps.decisions.decide(
    decisionKey(envelope, principal),
    envelope.requestDigest,
    () => entry.handler(handlerInput(envelope, principal, transportOrigin)),
  ));
}

/**
 * Handles one command request. Knows no command: everything specific arrives through the
 * injected registry, so a command seam that does not exist yet is added by registering an
 * entry rather than by editing this function.
 */
export function handleCommandRequest(
  deps: CommandAdapterDeps,
  request: HttpCommandRequest,
  transportOrigin: TransportOrigin,
): HttpCommandResult;
export function handleCommandRequest(
  deps: CommandAdapterDeps,
  request: HttpCommandRequest,
): HttpCommandResult;
export function handleCommandRequest(
  deps: CommandAdapterDeps,
  request: HttpCommandRequest,
  ...origin: readonly [transportOrigin?: TransportOrigin]
): HttpCommandResult {
  const prepared = prepareCommand(deps, request);
  if (!prepared.ok) return prepared;

  // An async entry has no synchronous answer to give, so this refuses rather than
  // handing back a promise typed as a decision.
  if (prepared.entry.asyncHandler !== undefined) {
    return seamRefusal(
      ASYNC_ENTRY_REQUIRED_CODE,
      "this command kind is served only on the asynchronous entry",
    );
  }

  return dispatch(deps, prepared.entry, prepared.envelope, prepared.principal, origin[0]);
}

/**
 * The asynchronous entry. Serves BOTH entry shapes: a synchronous handler runs through
 * the unchanged synchronous decision port, so routing a transport here changes nothing
 * for the kinds registered before async existed.
 *
 * A rejecting handler is the async path's own hazard: the synchronous port's try/catch
 * cannot see a rejection, so the async port owns it and maps it to the same refusal
 * shape. A crash is not a refusal.
 */
export function handleAsyncCommandRequest(
  deps: CommandAdapterDeps,
  request: HttpCommandRequest,
  transportOrigin: TransportOrigin,
): Promise<HttpCommandResult>;
export function handleAsyncCommandRequest(
  deps: CommandAdapterDeps,
  request: HttpCommandRequest,
): Promise<HttpCommandResult>;
export async function handleAsyncCommandRequest(
  deps: CommandAdapterDeps,
  request: HttpCommandRequest,
  ...origin: readonly [transportOrigin?: TransportOrigin]
): Promise<HttpCommandResult> {
  const prepared = prepareCommand(deps, request);
  if (!prepared.ok) return prepared;

  const { entry, envelope, principal } = prepared;
  const asyncHandler = entry.asyncHandler;
  if (asyncHandler === undefined) return dispatch(deps, entry, envelope, principal, origin[0]);

  const decisions = deps.decisions;
  if (decisions.decideAsync === undefined) {
    return seamRefusal(
      ASYNC_PORT_UNAVAILABLE_CODE,
      "this decision port cannot commit an asynchronous command",
    );
  }

  return answer(await decisions.decideAsync(
    decisionKey(envelope, principal),
    envelope.requestDigest,
    async () => await asyncHandler({ envelope, principal }),
  ));
}
