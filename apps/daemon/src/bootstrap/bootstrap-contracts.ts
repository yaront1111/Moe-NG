import { decodeBoundedJsonBytes } from "@moe/contracts";
import type {
  BoundedJsonDecodeError,
  JsonObject,
  JsonValue,
  RuntimeCommandKind,
} from "@moe/contracts";

/**
 * Byte ingress for the bootstrap command surface.
 *
 * This module is the daemon's trust boundary and nothing more: it decides only whether an
 * input is a well-formed request envelope naming a command this task owns. Every domain
 * question — legality, authority, ordering, version agreement — belongs to a `@moe/core`
 * reducer, so refusals raised here always carry `refusedBy: "DAEMON_INGRESS"` to keep the
 * two layers distinguishable in evidence.
 */

export const BOOTSTRAP_SCHEMA_VERSION = "moe-bootstrap-command/1" as const;

/**
 * The ten kinds composed by this surface. Each is also a member of `RUNTIME_COMMAND_KINDS`;
 * that containment is asserted by test rather than derived, so widening this list cannot
 * silently widen the surface.
 *
 * `goal.close` is APPENDED, never inserted: existing suites assert against this array, and
 * J1's initial-graph activation deliberately adds no kind of its own — it composes inside
 * `approval.decide`, which is what keeps J1 at three human actions (design 299).
 */
export const BOOTSTRAP_COMMAND_KINDS = Object.freeze([
  "approval.decide",
  "goal.create",
  "goal.create_with_source",
  "plan.propose",
  "policy.install",
  "policy.validate",
  "project.activate",
  "project.bind_repository",
  "project.register",
  "provider.probe",
  "goal.close",
  "repository.publish",
  // APPENDED for the same reason `goal.close` is: existing suites assert against this array in
  // order. Bootstrap membership is what gives the kind the durable replay fence and the
  // prerequisite table below; its EFFECTS are asynchronous, so the registry serves it from an
  // async entry that admits through this surface first (daemon-command-registry.js).
  "repository.bootstrap",
  // APPENDED, same rule. `deployment.set_target` is an ordinary synchronous write; the DEPLOY
  // that follows it runs `docker` and `ssh`, so it admits through this surface and is then
  // served asynchronously, exactly as `repository.bootstrap` above.
  "deployment.set_target",
  "deployment.deploy",
  // APPENDED, same rule. Undoing a schema change dumps the database and then runs the generated
  // product's migration tool, so it admits through this surface and is then served
  // asynchronously, exactly as `deployment.deploy` above.
  "deployment.migrate_down",
] as const satisfies readonly RuntimeCommandKind[]);

export type BootstrapCommandKind = (typeof BOOTSTRAP_COMMAND_KINDS)[number];

/**
 * The bootstrap-family kinds that are NOT rows in `BOOTSTRAP_HANDLERS`.
 *
 * They admit through this surface (decode, replay fence, prerequisites) and are then served by
 * an ASYNC registry entry, because their effects are asynchronous and `CommandHandler` is not.
 * Named here so a consumer enumerating the served bootstrap family from the handler table alone
 * does not silently under-count: that table is no longer the whole seam.
 */
export const ASYNC_SERVED_BOOTSTRAP_KINDS: readonly BootstrapCommandKind[] = Object.freeze([
  "repository.bootstrap",
  // `docker build`, an optional `docker save | ssh docker load`, and a health poll that waits
  // out docker's own start-period. `deployment.set_target`, its sibling, writes one durable
  // binding and is a `BOOTSTRAP_HANDLERS` row like every other synchronous kind.
  "deployment.deploy",
  // Same shape: a dump, then a child process running `node-pg-migrate down`. A synchronous
  // handler would answer before the schema moved back.
  "deployment.migrate_down",
]);

export const BOOTSTRAP_REQUEST_KEYS = Object.freeze([
  "commandId",
  "correlationId",
  "decidedAt",
  "expectedVersion",
  "kind",
  "payload",
  "principalId",
  "projectId",
  "schemaVersion",
] as const);

export const BOOTSTRAP_REFUSAL_CODES = Object.freeze([
  "BOOTSTRAP_INPUT_REJECTED",
  "BOOTSTRAP_REQUEST_INVALID",
  "BOOTSTRAP_COMMAND_UNKNOWN",
] as const);

export type BootstrapRefusalCode = (typeof BOOTSTRAP_REFUSAL_CODES)[number];

/** The single marker distinguishing an ingress refusal from a core reducer refusal. */
export type BootstrapRefusedBy = "DAEMON_INGRESS";

export interface BootstrapRequest {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly kind: BootstrapCommandKind;
  readonly payload: JsonObject;
  readonly principalId: string;
  readonly projectId: string;
  readonly schemaVersion: typeof BOOTSTRAP_SCHEMA_VERSION;
}

export interface BootstrapInputRejected {
  readonly code: "BOOTSTRAP_INPUT_REJECTED";
  readonly decodeError: BoundedJsonDecodeError;
  readonly ok: false;
  readonly refusedBy: BootstrapRefusedBy;
}

export interface BootstrapRequestRefused {
  readonly code: "BOOTSTRAP_REQUEST_INVALID" | "BOOTSTRAP_COMMAND_UNKNOWN";
  readonly ok: false;
  readonly refusedBy: BootstrapRefusedBy;
}

export interface BootstrapRequestAccepted {
  readonly ok: true;
  readonly request: BootstrapRequest;
}

export type BootstrapDecodeRefusal = BootstrapInputRejected | BootstrapRequestRefused;

export type BootstrapDecodeResult = BootstrapRequestAccepted | BootstrapDecodeRefusal;

const REQUEST_INVALID: BootstrapRequestRefused = Object.freeze({
  code: "BOOTSTRAP_REQUEST_INVALID",
  ok: false,
  refusedBy: "DAEMON_INGRESS",
});

const COMMAND_UNKNOWN: BootstrapRequestRefused = Object.freeze({
  code: "BOOTSTRAP_COMMAND_UNKNOWN",
  ok: false,
  refusedBy: "DAEMON_INGRESS",
});

const KIND_SET: ReadonlySet<string> = new Set<string>(BOOTSTRAP_COMMAND_KINDS);
const KEY_SET: ReadonlySet<string> = new Set<string>(BOOTSTRAP_REQUEST_KEYS);

/**
 * `decodeBoundedJsonBytes` yields null-prototype objects, so a prototype other than null
 * means the value did not come from the bounded decoder and is not trusted here.
 */
function isPlainJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== null
    && value !== undefined
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === null
  );
}

function isRef(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasExactKeys(request: JsonObject): boolean {
  const keys = Object.keys(request);
  if (keys.length !== BOOTSTRAP_REQUEST_KEYS.length) return false;
  return keys.every((key) => KEY_SET.has(key));
}

function isBootstrapKind(value: JsonValue | undefined): value is BootstrapCommandKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/** Envelope-shape agreement, excluding the command kind, which refuses under its own code. */
function isExactEnvelope(request: JsonObject): boolean {
  return (
    hasExactKeys(request)
    && request["schemaVersion"] === BOOTSTRAP_SCHEMA_VERSION
    && isRef(request["commandId"])
    && isRef(request["correlationId"])
    && isRef(request["decidedAt"])
    && isRef(request["principalId"])
    && isRef(request["projectId"])
    && typeof request["expectedVersion"] === "number"
    && Number.isSafeInteger(request["expectedVersion"])
    && request["expectedVersion"] >= 0
    && isPlainJsonObject(request["payload"])
  );
}

function accepted(request: JsonObject, kind: BootstrapCommandKind): BootstrapRequestAccepted {
  return Object.freeze({
    ok: true as const,
    request: Object.freeze({
      commandId: request["commandId"] as string,
      correlationId: request["correlationId"] as string,
      decidedAt: request["decidedAt"] as string,
      expectedVersion: request["expectedVersion"] as number,
      kind,
      payload: request["payload"] as JsonObject,
      principalId: request["principalId"] as string,
      projectId: request["projectId"] as string,
      schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    }),
  });
}

/**
 * Decodes request bytes into an owned bootstrap command envelope.
 *
 * Decode failures surface the bounded decoder's own error unchanged; translating it would
 * erase which layer refused and which resource bound was exceeded.
 */
export function decodeBootstrapRequestBytes(input: unknown): BootstrapDecodeResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) {
    return Object.freeze({
      code: "BOOTSTRAP_INPUT_REJECTED" as const,
      decodeError: decoded,
      ok: false as const,
      refusedBy: "DAEMON_INGRESS" as const,
    });
  }
  if (!isPlainJsonObject(decoded.value)) return REQUEST_INVALID;

  const request = decoded.value;
  if (!isExactEnvelope(request)) return REQUEST_INVALID;

  const kind = request["kind"];
  if (typeof kind !== "string") return REQUEST_INVALID;
  if (!isBootstrapKind(kind)) return COMMAND_UNKNOWN;

  return accepted(request, kind);
}
