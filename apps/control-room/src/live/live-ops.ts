/**
 * The POLICY and HEALTH read clients: POST /policy/read and POST /health/read, each with
 * EXACTLY `{}`, shaped verbatim into their outcome or a refusal at its own layer. READS
 * ONLY, exact-key snapshots at every level (the discipline of live-planning-run.ts).
 */

const LIVE_OPS_LAYER = "CONTROL_ROOM_LIVE_OPS";
const INVALID_RESPONSE_CODE = "OPS_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const POLICY_READ_PATH = "/policy/read";
const HEALTH_READ_PATH = "/health/read";
const REQUEST_TIMEOUT_MS = 15_000;

export const POLICY_SLICE_KINDS = ["ARTIFACT", "EVALUATION", "REVIEWER_CALIBRATION", "VERIFIER_POLICY"] as const;
export type PolicySliceKind = (typeof POLICY_SLICE_KINDS)[number];

export interface PolicySliceView {
  readonly autoApprovalOptIns: number | null;
  readonly contentDigestMatches: boolean | null;
  readonly installedAt: string | null;
  readonly kind: PolicySliceKind;
  readonly riskClassifications: number | null;
  readonly rules: number | null;
  readonly sliceRef: string;
}
export interface PolicyEvaluationView {
  readonly decidedAt: string;
  readonly decision: string | null;
  readonly policyRef: string;
  readonly principalId: string | null;
}
export interface VerifierStanding { readonly calibration: boolean; readonly policy: boolean }
export type PolicyOutcome =
  | {
    readonly status: "POLICY";
    readonly aggregateVersion: number;
    readonly evaluations: readonly PolicyEvaluationView[];
    readonly slices: readonly PolicySliceView[];
    readonly verifier: VerifierStanding;
    readonly waivers: { readonly reason: string; readonly supported: false };
  }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

export type HealthOutcome =
  | {
    readonly status: "HEALTH";
    readonly daemon: {
      readonly commandAuthorityPlane: string;
      readonly nodeSpecsDir: string | null;
      readonly pid: number;
      readonly projectId: string;
      readonly protocolVersion: string;
      readonly startedAt: string;
      readonly storePath: string;
    };
    readonly ledger: {
      readonly aggregates: number;
      readonly commandKinds: number;
      readonly decisionCount: number;
      readonly goals: number | null;
      readonly lastDecidedAt: string | null;
    };
    readonly readAt: string;
    readonly verifier: VerifierStanding;
  }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

type Refusal = { readonly status: "REFUSED"; readonly code: string; readonly layer: string };
type Failure = { readonly status: "ERROR"; readonly code: string; readonly layer: string };
const refused = (code: string, layer: string): Refusal => Object.freeze({ code, layer, status: "REFUSED" as const });
const errored = (code: string, layer: string): Failure => Object.freeze({ code, layer, status: "ERROR" as const });
const invalidResponse = (): Failure => errored(INVALID_RESPONSE_CODE, LIVE_OPS_LAYER);

/** An own-enumerable EXACT-key snapshot (copied verbatim from live-planning-run.ts). */
function exactDataRecord(
  value: unknown, expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return null;
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function refusalFrom(response: unknown): Refusal | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && typeof listener.code === "string" && typeof listener.layer === "string") {
    return refused(listener.code, listener.layer);
  }
  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED" && typeof route.code === "string" && typeof route.layer === "string") {
    return refused(route.code, route.layer);
  }
  const port = exactDataRecord(response, ["httpStatus", "ok", "outcome", "refusal", "stage"]);
  if (port !== null && port.ok === false && port.outcome === "PORT_REFUSED" && typeof port.stage === "string") {
    const portCode = typeof port.refusal === "object" && port.refusal !== null
      ? Object.getOwnPropertyDescriptor(port.refusal, "code") : undefined;
    if (portCode !== undefined && "value" in portCode && typeof portCode.value === "string") {
      return refused(portCode.value, port.stage);
    }
  }
  const http = exactDataRecord(response, ["error", "httpStatus", "ok", "outcome", "stage"]);
  if (http === null || http.ok !== false || http.outcome !== "REFUSED" || typeof http.stage !== "string") return null;
  const runtimeError = typeof http.error === "object" && http.error !== null
    ? Object.getOwnPropertyDescriptor(http.error, "code") : undefined;
  return runtimeError !== undefined && "value" in runtimeError && typeof runtimeError.value === "string"
    ? refused(runtimeError.value, http.stage) : null;
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const nullableCount = (value: unknown): value is number | null => value === null || count(value);

function verifierOf(value: unknown): VerifierStanding | null {
  const record = exactDataRecord(value, ["calibration", "policy"]);
  if (record === null || typeof record.calibration !== "boolean" || typeof record.policy !== "boolean") return null;
  return Object.freeze({ calibration: record.calibration, policy: record.policy });
}

function sliceOf(value: unknown): PolicySliceView | null {
  const record = exactDataRecord(value, [
    "autoApprovalOptIns", "contentDigestMatches", "installedAt", "kind", "riskClassifications", "rules", "sliceRef",
  ]);
  if (record === null || !nullableCount(record.autoApprovalOptIns) || !nullableCount(record.riskClassifications)
    || !nullableCount(record.rules) || !nullableString(record.installedAt) || !nonEmptyString(record.sliceRef)
    || !(record.contentDigestMatches === null || typeof record.contentDigestMatches === "boolean")
    || typeof record.kind !== "string" || !(POLICY_SLICE_KINDS as readonly string[]).includes(record.kind)) return null;
  return Object.freeze({
    autoApprovalOptIns: record.autoApprovalOptIns, contentDigestMatches: record.contentDigestMatches,
    installedAt: record.installedAt, kind: record.kind as PolicySliceKind,
    riskClassifications: record.riskClassifications, rules: record.rules, sliceRef: record.sliceRef,
  });
}

function evaluationOf(value: unknown): PolicyEvaluationView | null {
  const record = exactDataRecord(value, ["decidedAt", "decision", "policyRef", "principalId"]);
  if (record === null || !nonEmptyString(record.decidedAt) || !nullableString(record.decision)
    || !nonEmptyString(record.policyRef) || !nullableString(record.principalId)) return null;
  return Object.freeze({
    decidedAt: record.decidedAt, decision: record.decision, policyRef: record.policyRef, principalId: record.principalId,
  });
}

function listOf<T>(value: unknown, itemOf: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const raw of value) {
    const item = itemOf(raw);
    if (item === null) return null;
    items.push(item);
  }
  return Object.freeze(items);
}

export function mapPolicyAnswer(status: number, response: unknown): PolicyOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, ["aggregateVersion", "evaluations", "outcome", "slices", "verifier", "waivers"]);
  if (record === null || record.outcome !== "POLICY" || !count(record.aggregateVersion)) return invalidResponse();
  const evaluations = listOf(record.evaluations, evaluationOf);
  const slices = listOf(record.slices, sliceOf);
  const verifier = verifierOf(record.verifier);
  const waivers = exactDataRecord(record.waivers, ["reason", "supported"]);
  if (evaluations === null || slices === null || verifier === null || waivers === null
    || waivers.supported !== false || typeof waivers.reason !== "string") return invalidResponse();
  return Object.freeze({
    aggregateVersion: record.aggregateVersion, evaluations, slices, status: "POLICY" as const, verifier,
    waivers: Object.freeze({ reason: waivers.reason, supported: false as const }),
  });
}

export function mapHealthAnswer(status: number, response: unknown): HealthOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, ["daemon", "ledger", "outcome", "readAt", "verifier"]);
  if (record === null || record.outcome !== "HEALTH" || !nonEmptyString(record.readAt)) return invalidResponse();
  const daemon = exactDataRecord(record.daemon, [
    "commandAuthorityPlane", "nodeSpecsDir", "pid", "projectId", "protocolVersion", "startedAt", "storePath",
  ]);
  const ledger = exactDataRecord(record.ledger, ["aggregates", "commandKinds", "decisionCount", "goals", "lastDecidedAt"]);
  const verifier = verifierOf(record.verifier);
  if (daemon === null || ledger === null || verifier === null
    || !nonEmptyString(daemon.commandAuthorityPlane) || !nullableString(daemon.nodeSpecsDir) || !count(daemon.pid)
    || !nonEmptyString(daemon.projectId) || !nonEmptyString(daemon.protocolVersion) || !nonEmptyString(daemon.startedAt)
    || typeof daemon.storePath !== "string" || !count(ledger.aggregates) || !count(ledger.commandKinds)
    || !count(ledger.decisionCount) || !nullableCount(ledger.goals) || !nullableString(ledger.lastDecidedAt)) {
    return invalidResponse();
  }
  return Object.freeze({
    daemon: Object.freeze({
      commandAuthorityPlane: daemon.commandAuthorityPlane, nodeSpecsDir: daemon.nodeSpecsDir, pid: daemon.pid,
      projectId: daemon.projectId, protocolVersion: daemon.protocolVersion, startedAt: daemon.startedAt,
      storePath: daemon.storePath,
    }),
    ledger: Object.freeze({
      aggregates: ledger.aggregates, commandKinds: ledger.commandKinds, decisionCount: ledger.decisionCount,
      goals: ledger.goals, lastDecidedAt: ledger.lastDecidedAt,
    }),
    readAt: record.readAt, status: "HEALTH" as const, verifier,
  });
}

type Reply = { readonly kind: "FAILED"; readonly failure: Failure } | { readonly body: unknown; readonly kind: "REPLY"; readonly status: number };

async function post(
  path: string, headers: Readonly<Record<string, string>>, send?: (body: string) => Promise<Response>,
): Promise<Reply> {
  const doSend = send ?? ((body: string): Promise<Response> => fetch(path, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await doSend("{}");
  } catch {
    return { failure: errored(TRANSPORT_FAILED_CODE, LIVE_OPS_LAYER), kind: "FAILED" };
  }
  try {
    return { body: await response.json(), kind: "REPLY", status: response.status };
  } catch {
    return { failure: invalidResponse(), kind: "FAILED" };
  }
}

/** POSTs exactly `{}` to the policy read; `send` is injectable for tests. */
export async function readPolicy(
  headers: Readonly<Record<string, string>>, send?: (body: string) => Promise<Response>,
): Promise<PolicyOutcome> {
  const reply = await post(POLICY_READ_PATH, headers, send);
  return reply.kind === "FAILED" ? reply.failure : mapPolicyAnswer(reply.status, reply.body);
}

/** POSTs exactly `{}` to the health read; `send` is injectable for tests. */
export async function readHealth(
  headers: Readonly<Record<string, string>>, send?: (body: string) => Promise<Response>,
): Promise<HealthOutcome> {
  const reply = await post(HEALTH_READ_PATH, headers, send);
  return reply.kind === "FAILED" ? reply.failure : mapHealthAnswer(reply.status, reply.body);
}
