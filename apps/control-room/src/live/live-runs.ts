/**
 * The RUNS & LEASES read client: POST /runs/read with EXACTLY `{}` and shape what the daemon
 * says - verbatim - into RUNS / REFUSED / ERROR. READS ONLY. Exact-key snapshots at every
 * level (the discipline of live-planning-run.ts); a nested row that drifts reddens the whole
 * answer, never a half-board.
 */

const LIVE_RUNS_LAYER = "CONTROL_ROOM_LIVE_RUNS";
const INVALID_RESPONSE_CODE = "RUNS_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const RUNS_READ_PATH = "/runs/read";
const REQUEST_TIMEOUT_MS = 15_000;

export const RUN_NODE_STATUSES = [
  "ACCEPTED", "BLOCKED", "DELIVERED", "ESCALATED", "ESCALATION_REQUIRED", "IN_PROGRESS", "READY",
  "REPLANNED", "UNATTRIBUTABLE",
] as const;
export type RunNodeStatus = (typeof RUN_NODE_STATUSES)[number];
const APPROVAL_STATES = ["ABSENT", "BOUND", "UNREADABLE"] as const;

export interface RunNodeClaimView {
  readonly active: boolean;
  readonly claimedBy: string;
  readonly expiresAt: string;
  readonly status: "OPEN" | "RELEASED";
}
export interface RunNodeFindingView {
  readonly detail: string;
  readonly round: number;
  readonly ruleId: string;
  readonly severity: string;
  readonly subject: string;
}
export interface RunNodeReceiptView {
  readonly testedTreeSha: string | null;
  readonly byteCount: number;
  readonly exitCode: number;
  readonly outputSha256: string;
  readonly test: string;
  readonly workspace: string;
}
export interface RunNodeReviewView {
  readonly escalated: boolean;
  readonly findings: readonly RunNodeFindingView[];
  readonly latestRoute: string | null;
  readonly rounds: number;
  readonly unreadable: boolean;
  readonly unsuccessfulRounds: number;
  readonly version: number;
}
/** The git landing of an accepted delivery: a commit on the workspace's branch, or a refusal. */
export interface RunNodeLandingView {
  readonly branch: string | null;
  readonly code: string | null;
  readonly files: readonly string[];
  readonly outcome: "COMMITTED" | "REFUSED";
  readonly sha: string | null;
}
export interface RunNodeView {
  readonly accepted: { readonly verifierReceiptId: string } | null;
  readonly claim: RunNodeClaimView | null;
  readonly criterionIds: readonly string[];
  readonly dependsOn: readonly string[];
  readonly landing: RunNodeLandingView | null;
  readonly lastActivityAt: string | null;
  readonly nodeKey: string;
  readonly nodeRef: string;
  readonly objective: string;
  readonly receipt: RunNodeReceiptView | null;
  readonly review: RunNodeReviewView;
  readonly sharedKey: boolean;
  readonly status: RunNodeStatus;
}
/** The goal's latest publish decision and what the publisher did with it. */
export interface RunGoalPublishView {
  readonly branch: string | null;
  readonly code: string | null;
  readonly decisionId: string;
  readonly outcome: "PENDING" | "PUSHED" | "REFUSED" | "UNKNOWN";
  readonly remoteUrl: string;
  readonly requestedAt: string;
  readonly sha: string | null;
  readonly url: string | null;
}
export interface RunGoalView {
  readonly goalId: string;
  readonly lifecycle: string | null;
  readonly nodes: readonly RunNodeView[];
  readonly publish: RunGoalPublishView | null;
  readonly run: {
    readonly approval: (typeof APPROVAL_STATES)[number];
    readonly lifecycle: string;
    readonly reviewable: boolean;
    readonly runId: string;
  } | null;
  readonly title: string | null;
}
export type RunsTotals = Readonly<Record<RunNodeStatus, number>> & {
  readonly goals: number; readonly nodes: number;
};

export type RunsOutcome =
  | { readonly status: "RUNS"; readonly goals: readonly RunGoalView[]; readonly totals: RunsTotals }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

const refused = (code: string, layer: string): RunsOutcome =>
  Object.freeze({ code, layer, status: "REFUSED" as const });
const errored = (code: string, layer: string): RunsOutcome =>
  Object.freeze({ code, layer, status: "ERROR" as const });
const invalidResponse = (): RunsOutcome => errored(INVALID_RESPONSE_CODE, LIVE_RUNS_LAYER);

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

function refusalFrom(response: unknown): RunsOutcome | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && typeof listener.code === "string" && typeof listener.layer === "string") {
    return refused(listener.code, listener.layer);
  }
  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED"
    && typeof route.code === "string" && typeof route.layer === "string") {
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
const stringList = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? Object.freeze([...(value as string[])]) : null;

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

function claimOf(value: unknown): RunNodeClaimView | null {
  const record = exactDataRecord(value, ["active", "claimedBy", "expiresAt", "status"]);
  if (record === null || typeof record.active !== "boolean" || !nonEmptyString(record.claimedBy)
    || !nonEmptyString(record.expiresAt) || (record.status !== "OPEN" && record.status !== "RELEASED")) return null;
  return Object.freeze({ active: record.active, claimedBy: record.claimedBy, expiresAt: record.expiresAt, status: record.status });
}

function findingOf(value: unknown): RunNodeFindingView | null {
  const record = exactDataRecord(value, ["detail", "round", "ruleId", "severity", "subject"]);
  if (record === null || typeof record.detail !== "string" || !count(record.round) || !nonEmptyString(record.ruleId)
    || !nonEmptyString(record.severity) || typeof record.subject !== "string") return null;
  return Object.freeze({ detail: record.detail, round: record.round, ruleId: record.ruleId, severity: record.severity, subject: record.subject });
}

function receiptOf(value: unknown): RunNodeReceiptView | null {
  const record = exactDataRecord(value, ["byteCount", "exitCode", "outputSha256", "test", "workspace", "testedTreeSha"]);
  if (record === null || !count(record.byteCount) || !count(record.exitCode) || !nonEmptyString(record.outputSha256)
    || typeof record.test !== "string" || typeof record.workspace !== "string"
    || (record.testedTreeSha !== null && (typeof record.testedTreeSha !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(record.testedTreeSha)))) return null;
  return Object.freeze({ byteCount: record.byteCount, exitCode: record.exitCode, outputSha256: record.outputSha256,
    test: record.test, workspace: record.workspace, testedTreeSha: record.testedTreeSha });
}

function landingOf(value: unknown): RunNodeLandingView | null {
  const record = exactDataRecord(value, ["branch", "code", "files", "outcome", "sha"]);
  if (record === null || !nullableString(record.branch) || !nullableString(record.code)
    || !nullableString(record.sha) || (record.outcome !== "COMMITTED" && record.outcome !== "REFUSED")) return null;
  const files = stringList(record.files);
  if (files === null) return null;
  return Object.freeze({ branch: record.branch, code: record.code, files, outcome: record.outcome, sha: record.sha });
}

function reviewOf(value: unknown): RunNodeReviewView | null {
  const record = exactDataRecord(value, ["escalated", "findings", "latestRoute", "rounds", "unreadable", "unsuccessfulRounds", "version"]);
  if (record === null || typeof record.escalated !== "boolean" || !nullableString(record.latestRoute)
    || !count(record.rounds) || typeof record.unreadable !== "boolean" || !count(record.unsuccessfulRounds)
    || !count(record.version)) return null;
  const findings = listOf(record.findings, findingOf);
  if (findings === null) return null;
  return Object.freeze({
    escalated: record.escalated, findings, latestRoute: record.latestRoute, rounds: record.rounds,
    unreadable: record.unreadable, unsuccessfulRounds: record.unsuccessfulRounds, version: record.version,
  });
}

function nodeOf(value: unknown): RunNodeView | null {
  const record = exactDataRecord(value, [
    "accepted", "claim", "criterionIds", "dependsOn", "landing", "lastActivityAt", "nodeKey", "nodeRef", "objective", "receipt",
    "review", "sharedKey", "status",
  ]);
  if (record === null || !nonEmptyString(record.nodeKey) || !nonEmptyString(record.nodeRef) || typeof record.objective !== "string"
    || !nullableString(record.lastActivityAt) || typeof record.status !== "string"
    || typeof record.sharedKey !== "boolean"
    || !(RUN_NODE_STATUSES as readonly string[]).includes(record.status)) return null;
  const criterionIds = stringList(record.criterionIds);
  const dependsOn = stringList(record.dependsOn);
  const review = reviewOf(record.review);
  if (criterionIds === null || dependsOn === null || review === null) return null;
  let accepted: RunNodeView["accepted"] = null;
  if (record.accepted !== null) {
    const row = exactDataRecord(record.accepted, ["verifierReceiptId"]);
    if (row === null || !nonEmptyString(row.verifierReceiptId)) return null;
    accepted = Object.freeze({ verifierReceiptId: row.verifierReceiptId });
  }
  let claim: RunNodeClaimView | null = null;
  if (record.claim !== null) {
    claim = claimOf(record.claim);
    if (claim === null) return null;
  }
  let receipt: RunNodeReceiptView | null = null;
  if (record.receipt !== null) {
    receipt = receiptOf(record.receipt);
    if (receipt === null) return null;
  }
  let landing: RunNodeLandingView | null = null;
  if (record.landing !== null) {
    landing = landingOf(record.landing);
    if (landing === null) return null;
  }
  return Object.freeze({
    accepted, claim, criterionIds, dependsOn, landing, lastActivityAt: record.lastActivityAt,
    nodeKey: record.nodeKey, nodeRef: record.nodeRef, objective: record.objective, receipt, review, sharedKey: record.sharedKey,
    status: record.status as RunNodeStatus,
  });
}

function publishOf(value: unknown): RunGoalPublishView | null {
  const record = exactDataRecord(value, ["branch", "code", "decisionId", "outcome", "remoteUrl", "requestedAt", "sha", "url"]);
  if (record === null || !nullableString(record.branch) || !nullableString(record.code) || !nonEmptyString(record.decisionId)
    || !nonEmptyString(record.remoteUrl) || !nonEmptyString(record.requestedAt) || !nullableString(record.sha)
    || !nullableString(record.url)
    || (record.outcome !== "PENDING" && record.outcome !== "PUSHED" && record.outcome !== "REFUSED" && record.outcome !== "UNKNOWN")) return null;
  return Object.freeze({
    branch: record.branch, code: record.code, decisionId: record.decisionId, outcome: record.outcome,
    remoteUrl: record.remoteUrl, requestedAt: record.requestedAt, sha: record.sha, url: record.url,
  });
}

function goalOf(value: unknown): RunGoalView | null {
  const record = exactDataRecord(value, ["goalId", "lifecycle", "nodes", "publish", "run", "title"]);
  if (record === null || !nonEmptyString(record.goalId) || !nullableString(record.lifecycle)
    || !nullableString(record.title)) return null;
  const nodes = listOf(record.nodes, nodeOf);
  if (nodes === null) return null;
  let run: RunGoalView["run"] = null;
  if (record.run !== null) {
    const row = exactDataRecord(record.run, ["approval", "lifecycle", "reviewable", "runId"]);
    if (row === null || typeof row.approval !== "string" || !(APPROVAL_STATES as readonly string[]).includes(row.approval)
      || !nonEmptyString(row.lifecycle) || typeof row.reviewable !== "boolean" || !nonEmptyString(row.runId)) return null;
    run = Object.freeze({
      approval: row.approval as (typeof APPROVAL_STATES)[number], lifecycle: row.lifecycle,
      reviewable: row.reviewable, runId: row.runId,
    });
  }
  let publish: RunGoalPublishView | null = null;
  if (record.publish !== null) {
    publish = publishOf(record.publish);
    if (publish === null) return null;
  }
  return Object.freeze({ goalId: record.goalId, lifecycle: record.lifecycle, nodes, publish, run, title: record.title });
}

const TOTAL_KEYS = [...RUN_NODE_STATUSES, "goals", "nodes"] as const;

/** Maps only an exact daemon RUNS frame; every other answer is REFUSED or ERROR. PURE. */
export function mapRunsAnswer(status: number, response: unknown): RunsOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, ["goals", "outcome", "totals"]);
  if (record === null || record.outcome !== "RUNS") return invalidResponse();
  const goals = listOf(record.goals, goalOf);
  const totals = exactDataRecord(record.totals, TOTAL_KEYS);
  if (goals === null || totals === null || !TOTAL_KEYS.every((key) => count(totals[key]))) return invalidResponse();
  return Object.freeze({
    goals, status: "RUNS" as const,
    totals: Object.freeze(Object.fromEntries(TOTAL_KEYS.map((key) => [key, totals[key] as number]))) as RunsTotals,
  });
}

/** POSTs exactly `{}` and maps the reply; `post` is injectable for tests. */
/** POSTs exactly `{}` (every goal) or `{ goalRef }` (one goal) and maps the reply; `post` is injectable for tests. */
export async function readRuns(
  headers: Readonly<Record<string, string>>, post?: (body: string) => Promise<Response>, goalRef?: string,
): Promise<RunsOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(RUNS_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send(goalRef === undefined ? "{}" : JSON.stringify({ goalRef }));
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LIVE_RUNS_LAYER);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapRunsAnswer(response.status, body);
}
