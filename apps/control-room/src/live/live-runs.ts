/**
 * The RUNS & LEASES read client: POST /runs/read with EXACTLY `{}` and shape what the daemon
 * says - verbatim - into RUNS / REFUSED / ERROR. READS ONLY. Exact-key snapshots at every
 * level; malformed project deployment observations drop only that environment.
 */

import { claimOf, count, landingOf, nonEmptyString, nullableString, receiptOf, reviewOf, stringList } from "./live-runs-node-parts.js";
import { exactDataRecord, listOf } from "./live-wire-primitives.js";

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
  /** The node of the same plan that owns this finding (it does not charge this node); absent from older daemons. */
  readonly attributedTo?: { readonly criterionIds: readonly string[]; readonly nodeKey: string } | null;
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
  /** Rounds that repeated the same own findings on an unchanged review input; absent from older daemons. */
  readonly stalledRounds?: readonly number[];
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
  /** Authored order. `null` is UNKNOWN (the node declares nothing); `[]` is declared none. */
  readonly declaredMigrations: readonly string[] | null;
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
const DEPLOY_CODES = ["DEPLOY_BUILD_FAILED", "DEPLOY_DOCKER_UNAVAILABLE", "DEPLOY_HEALTH_TIMEOUT", "DEPLOY_TARGET_MISSING"] as const;
export interface RunDeploymentView {
  readonly environment: string;
  readonly target?: { readonly network: string; readonly host?: string };
  readonly sha?: string;
  readonly time?: string;
  readonly url?: string;
  readonly status?: "DEPLOYED" | "REFUSED";
  readonly code?: (typeof DEPLOY_CODES)[number];
}
export interface RunGoalView {
  /** Optional for existing view constructors; REQUIRED on the exact daemon wire. */
  readonly deployments?: readonly RunDeploymentView[];
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

function nodeOf(value: unknown): RunNodeView | null {
  const record = exactDataRecord(value, [
    "accepted", "claim", "criterionIds", "declaredMigrations", "dependsOn", "landing", "lastActivityAt", "nodeKey", "nodeRef",
    "objective", "receipt", "review", "sharedKey", "status",
  ]);
  if (record === null || !nonEmptyString(record.nodeKey) || !nonEmptyString(record.nodeRef) || typeof record.objective !== "string"
    || !nullableString(record.lastActivityAt) || typeof record.status !== "string"
    || typeof record.sharedKey !== "boolean"
    || !(RUN_NODE_STATUSES as readonly string[]).includes(record.status)) return null;
  const criterionIds = stringList(record.criterionIds);
  // UNKNOWN is null on the wire and `stringList` also answers null for "not an array": branch on
  // the literal null FIRST, so a malformed value refuses instead of decoding as UNKNOWN.
  const declared = record.declaredMigrations;
  const declaredMigrations = declared === null ? null : stringList(declared);
  const dependsOn = stringList(record.dependsOn);
  const review = reviewOf(record.review);
  if (criterionIds === null || (declared !== null && declaredMigrations === null)
    || dependsOn === null || review === null) return null;
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
    accepted, claim, criterionIds, declaredMigrations, dependsOn, landing, lastActivityAt: record.lastActivityAt,
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

function deploymentOf(value: unknown): RunDeploymentView | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const keys = ["environment", "target", "sha", "time", "url", "status", "code"];
    const row = exactDataRecord(value, keys.filter((key) => Object.hasOwn(value, key)));
    if (row === null || typeof row.environment !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(row.environment)) return null;
    for (const key of ["sha", "time", "url", "status", "code"]) {
      if (Object.hasOwn(row, key) && !nonEmptyString(row[key])) return null;
    }
    let target: RunDeploymentView["target"];
    if (Object.hasOwn(row, "target")) {
      const raw = row.target;
      const item = exactDataRecord(raw, typeof raw === "object" && raw !== null && Object.hasOwn(raw, "host")
        ? ["network", "host"] : ["network"]);
      if (item === null || typeof item.network !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u.test(item.network)
        || (Object.hasOwn(item, "host") && (typeof item.host !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,253}$/u.test(item.host)))) return null;
      target = Object.freeze({ network: item.network, ...(typeof item.host === "string" ? { host: item.host } : {}) });
    }
    if (row.status === undefined) {
      if (target === undefined || row.sha !== undefined || row.time !== undefined || row.url !== undefined || row.code !== undefined) return null;
    } else if ((row.status !== "DEPLOYED" && row.status !== "REFUSED")
      || typeof row.sha !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(row.sha) || !nonEmptyString(row.time)
      || (row.status === "REFUSED" ? !(DEPLOY_CODES as readonly unknown[]).includes(row.code) : row.code !== undefined)) return null;
    if (typeof row.url === "string") {
      const url = new URL(row.url);
      if (row.url.length > 512 || !["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") return null;
    }
    return Object.freeze({ ...row, ...(target === undefined ? {} : { target }) }) as unknown as RunDeploymentView;
  } catch { return null; }
}

function goalOf(value: unknown): RunGoalView | null {
  const record = exactDataRecord(value, ["deployments", "goalId", "lifecycle", "nodes", "publish", "run", "title"]);
  if (record === null || !nonEmptyString(record.goalId) || !nullableString(record.lifecycle)
    || !nullableString(record.title) || !Array.isArray(record.deployments)) return null;
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
  const deployments = Object.freeze(record.deployments
    .flatMap((value: unknown) => { const row = deploymentOf(value); return row === null ? [] : [row]; }));
  return Object.freeze({ deployments, goalId: record.goalId, lifecycle: record.lifecycle, nodes, publish, run, title: record.title });
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
