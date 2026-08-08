import {
  MAX_JSON_BODY_BYTES,
  MAX_JSON_DEPTH,
  MAX_JSON_STRING_UTF8_BYTES,
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
} from "@moe/contracts";
import type {
  RuntimeCommandEnvelope,
  RuntimeCommandKind,
  RuntimeError,
  RuntimeErrorCode,
} from "@moe/contracts";

/**
 * The vocabulary of the control-room HTTP seam. Data and types only: no boundary logic
 * lives here, and nothing here knows any specific command.
 *
 * The seam is generic over a COMMAND REGISTRY. A command contributes an entry naming its
 * kind, the capability it demands, its exact payload key list, and its handler. Boundary
 * code reads only those four fields, so a command that does not exist yet is added by
 * registering an entry rather than by editing the boundary.
 */

/**
 * The closed wire error vocabulary. Every element is a `RuntimeErrorCode`, so the seam
 * borrows the daemon's registry rather than minting a second error language; the
 * type-level assertion below fails typecheck if an entry ever drifts out of the registry.
 */
export const HTTP_BOUNDARY_ERROR_CODES = Object.freeze([
  "AUTHENTICATION_FAILED",
  "CAPABILITY_DENIED",
  "DISTRIBUTION_MISMATCH",
  "INPUT_INVALID",
  "INPUT_LIMIT_EXCEEDED",
  "SCHEMA_VERSION_UNSUPPORTED",
] as const);

export type HttpBoundaryErrorCode = (typeof HTTP_BOUNDARY_ERROR_CODES)[number];

/** Compile-time proof the wire vocabulary is a subset of the runtime error registry. */
export type BoundaryCodesAreRuntimeCodes =
  HttpBoundaryErrorCode extends RuntimeErrorCode ? true : never;

/**
 * Which layer refused, in ingress order. Named on every refusal so a reviewer can tell
 * an authentication refusal from a decode refusal without re-deriving the order.
 */
export const HTTP_REFUSAL_STAGES = Object.freeze([
  "AUTHENTICATE",
  "COMPATIBILITY",
  "DECODE",
  "REGISTRY",
  "AUTHORIZE",
  "PAYLOAD_SHAPE",
  "DISPATCH",
] as const);

export type HttpRefusalStage = (typeof HTTP_REFUSAL_STAGES)[number];

/**
 * Input bounds. Body bytes, depth, and string bytes are the `@moe/contracts` limits
 * verbatim, so the seam cannot admit what the bounded decoder would refuse or refuse what
 * it would admit. `maxPayloadFields` is additive and stated as such: the contract bounds
 * body size and nesting but never key count, so a flat payload of a million one-character
 * keys passes every contract limit. That bound is owned here because nowhere else owns it.
 */
export const MAX_COMMAND_PAYLOAD_FIELDS = 64;

export const HTTP_INPUT_BOUNDS = Object.freeze({
  maxBodyBytes: MAX_JSON_BODY_BYTES,
  maxDepth: MAX_JSON_DEPTH,
  maxPayloadFields: MAX_COMMAND_PAYLOAD_FIELDS,
  maxStringUtf8Bytes: MAX_JSON_STRING_UTF8_BYTES,
});

/**
 * The pinned wire protocol version, DERIVED from the contract constants rather than
 * hand-typed. `createCompatGate` in `@moe/control-room-client` pins the same three values
 * through `GENERATED_CONTRACT_PINS`, which `generated-coverage.test.ts` asserts equal to
 * these live constants — so client and daemon share one authority and this is not a second
 * compatibility rule. The daemon cannot import the gate itself: `apps/daemon` does not
 * depend on the control-room client package, and the architecture map points dependencies
 * toward contracts, so daemon -> client would invert it.
 */
export const WIRE_PROTOCOL_VERSION =
  `${RUNTIME_COMMAND_ENVELOPE_VERSION}+${RUNTIME_QUERY_ENVELOPE_VERSION}+${RUNTIME_ERROR_REGISTRY_VERSION}` as const;

export type WireProtocolVersion = typeof WIRE_PROTOCOL_VERSION;

/** The three verdicts kept distinct: a caller we do not know is not a caller we deny. */
export type AuthVerdict = "AUTHENTICATED" | "UNAUTHENTICATED" | "UNAUTHORIZED";

export interface AuthenticatedPrincipal {
  readonly capabilities: readonly string[];
  readonly principalId: string;
  readonly projectId: string;
}

export type AuthenticationResult =
  | { readonly principal: AuthenticatedPrincipal; readonly verdict: "AUTHENTICATED" }
  | { readonly verdict: "UNAUTHENTICATED" };

/**
 * Credential verification. Takes the TRANSPORT-carried credential, never a body field:
 * the envelope's own `sessionCredential` is only readable after decoding, and decoding
 * attacker bytes for an unauthenticated caller is the thing this ordering exists to stop.
 */
export interface Authenticator {
  authenticate(credential: string | null): AuthenticationResult;
}

/**
 * A refusal raised by a port rather than by the seam. `code` and `layer` are the port's
 * OWN stable values, copied verbatim; the seam holds no translation table, so a port code
 * cannot be flattened into a generic boundary code on the way out.
 */
export interface PortRefusal {
  readonly code: string;
  readonly detail: string;
  readonly httpStatus: number;
  readonly layer: string;
}

/** What the durable command decision returns. Mirrors the store's decision disposition. */
export interface DurableDecision {
  readonly commandId: string;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly effectId: string | null;
  readonly resultCode: string;
}

export interface DecisionKey {
  readonly commandId: string;
  readonly principalId: string;
  readonly projectId: string;
}

export type DecisionPortResult =
  | { readonly decision: DurableDecision; readonly outcome: "DECIDED" }
  | { readonly outcome: "REFUSED"; readonly refusal: PortRefusal };

/**
 * The durable command decision. A replay MUST return the same terminal decision and MUST
 * NOT run `commit` a second time, which is what makes replay observable by state rather
 * than only by response: a double write and a correct replay produce identical responses.
 */
export interface CommandDecisionPort {
  decide(
    key: DecisionKey,
    requestDigest: string,
    commit: () => DurableDecision,
  ): DecisionPortResult;
}

export interface CommandHandlerInput {
  readonly envelope: RuntimeCommandEnvelope;
  readonly principal: AuthenticatedPrincipal;
}

export type CommandHandler = (input: CommandHandlerInput) => DurableDecision;

/**
 * One registered command. `payloadKeys` is the exact allow-list for the payload object:
 * a payload carrying an unlisted key is refused rather than trimmed, so an attacker
 * cannot smuggle a field past a handler that reads it later.
 */
export interface CommandRegistryEntry {
  readonly handler: CommandHandler;
  readonly kind: RuntimeCommandKind;
  readonly payloadKeys: readonly string[];
  readonly requiredCapability: string;
}

export type CommandRegistry = ReadonlyMap<RuntimeCommandKind, CommandRegistryEntry>;

/** Everything the seam needs, all injected: it constructs no authority of its own. */
export interface CommandAdapterDeps {
  readonly authenticator: Authenticator;
  readonly decisions: CommandDecisionPort;
  readonly registry: CommandRegistry;
}

/**
 * One request as the transport hands it over. `body` stays RAW and undecoded; `credential`
 * and `protocolVersion` arrive out of band precisely so authentication and compatibility
 * can both answer before anything parses the body.
 */
export interface HttpCommandRequest {
  readonly body: unknown;
  readonly credential: string | null;
  readonly protocolVersion: unknown;
}

export interface HttpRefused {
  readonly error: RuntimeError;
  readonly httpStatus: number;
  readonly ok: false;
  readonly outcome: "REFUSED";
  readonly stage: HttpRefusalStage;
}

export interface HttpPortRefused {
  readonly httpStatus: number;
  readonly ok: false;
  readonly outcome: "PORT_REFUSED";
  readonly refusal: PortRefusal;
  readonly stage: "DISPATCH";
}

export interface HttpAccepted {
  readonly decision: DurableDecision;
  readonly httpStatus: 200;
  readonly ok: true;
  readonly outcome: "ACCEPTED";
}

export type HttpCommandResult = HttpAccepted | HttpPortRefused | HttpRefused;

/**
 * Throws on a duplicate kind rather than letting the last registration win. A silent
 * overwrite at startup could replace a stricter `requiredCapability` with a laxer one and
 * leave no trace; registry construction is startup code, so failing loudly there is the
 * safe direction.
 */
export function buildCommandRegistry(
  entries: readonly CommandRegistryEntry[],
): CommandRegistry {
  const registry = new Map<RuntimeCommandKind, CommandRegistryEntry>();
  for (const entry of entries) {
    if (registry.has(entry.kind)) {
      throw new Error(`command kind registered twice: ${entry.kind}`);
    }
    registry.set(entry.kind, Object.freeze({ ...entry }));
  }
  return registry;
}
