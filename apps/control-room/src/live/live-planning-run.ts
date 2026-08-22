/**
 * The PLAN-REVIEW read client (UI-6): reads the daemon's bespoke read route
 * POST /planning/run/read and shapes what it says - verbatim - into one of three
 * honest outcomes (RUN / REFUSED / ERROR). This module READS ONLY: it never posts
 * an approval and imports nothing that dispatches, because the daemon is the only
 * author of state and the control room authors none of its own.
 *
 * Discipline copied from live-document-ingest.ts:
 *  - exactDataRecord: an own-enumerable EXACT-key snapshot. A daemon frame is
 *    accepted only when its key set is precisely the one this reader vouches for,
 *    so an extra or renamed field is a shape miss, never a silent pass.
 *  - refusalFrom: the refusal envelopes this route can emit each travel out at
 *    their OWN layer - the listener's two-key { code, layer }, the route's own
 *    three-key { code, layer, outcome:"REFUSED" }, and the auth adapter's
 *    { error, stage } frame - carried through unchanged rather than flattened.
 *  - the RUN frame's nested plan/acceptance are read with per-item shape guards
 *    (mirroring live-board-feed.ts stepOf): a body field that drifts yields a
 *    clean ERROR, never a half-plan and never a throw.
 *
 * The request body is EXACTLY { runId } - the route refuses any extra key with
 * LISTENER_PLANNING_RUN_REQUEST_INVALID - so this client sends nothing but the id
 * it was handed.
 *
 * SEALED vs UNSEALED is an honest data state, not an error: the route replies RUN
 * with plan/acceptance null when the run's sealed bodies do not re-verify. A null
 * plan stays null (sealed:false); a PRESENT plan that fails its shape guard is an
 * ERROR, because a half-rendered plan is worse than an honest failure.
 */

const LIVE_PLANNING_LAYER = "CONTROL_ROOM_LIVE_PLANNING";
const INVALID_RESPONSE_CODE = "PLANNING_RUN_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const PLANNING_RUN_READ_PATH = "/planning/run/read";
const REQUEST_TIMEOUT_MS = 15_000;

export interface PlanningRunStepView {
  readonly stepId: string;
  readonly description: string;
  readonly kind: string;
}

export interface PlanningRunPlanView {
  readonly steps: readonly PlanningRunStepView[];
  readonly affectedNodeIds: readonly string[];
  readonly affectedCriterionIds: readonly string[];
  readonly planHash: string;
}

export interface PlanningRunEvidenceView {
  readonly evidenceRef: string;
  readonly kind: string;
  readonly requirementId: string;
}

export interface PlanningRunObligationView {
  readonly criterionId: string;
  readonly statement: string;
  readonly evidenceRequirements: readonly PlanningRunEvidenceView[];
  readonly verificationRecipeRefs: readonly string[];
}

export interface PlanningRunAcceptanceView {
  readonly obligations: readonly PlanningRunObligationView[];
  readonly criteriaDigest: string;
}

export type PlanningRunOutcome =
  | {
    readonly status: "RUN";
    readonly runId: string;
    readonly lifecycle: string;
    readonly submissionHash: string;
    readonly reviewable: boolean;
    readonly sealed: boolean;
    readonly plan: PlanningRunPlanView | null;
    readonly acceptance: PlanningRunAcceptanceView | null;
  }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

/** The exact key set of the route's success frame (PlanningRunView on the wire). */
const RUN_KEYS = [
  "acceptance", "authority", "lifecycle", "outcome", "plan", "reviewable", "runId", "submissionHash",
] as const;

function refused(code: string, layer: string): PlanningRunOutcome {
  return Object.freeze({ code, layer, status: "REFUSED" as const });
}

function errored(code: string, layer: string): PlanningRunOutcome {
  return Object.freeze({ code, layer, status: "ERROR" as const });
}

function invalidResponse(): PlanningRunOutcome {
  return errored(INVALID_RESPONSE_CODE, LIVE_PLANNING_LAYER);
}

/**
 * An own-enumerable EXACT-key snapshot: the value must be a plain object whose
 * key set is precisely `expectedKeys`, every one an own, enumerable data
 * property. Anything else - a prototype, an array, a missing or extra key, an
 * accessor - returns null so the caller never reads a field this reader has not
 * vouched for. (Copied verbatim from live-document-ingest.ts.)
 */
function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
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
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

/**
 * Recognises the refusal envelopes this route can emit and carries each out at
 * its OWN layer: the listener's two-key { code, layer } (403 origin / 400 invalid
 * body / 503 unavailable), the route's own three-key { code, layer,
 * outcome:"REFUSED" } (the capability/project/unknown-run refusals reply 200 with
 * exactly this shape), the auth adapter's frame { error, httpStatus, ok,
 * outcome:"REFUSED", stage } (a 401), and the authenticator's PORT_REFUSED frame
 * { httpStatus, ok, outcome:"PORT_REFUSED", refusal, stage } that a revoked or
 * expired credential produces at read time. Any other answer is not a refusal this
 * reader can vouch for and returns null.
 */
function refusalFrom(response: unknown): PlanningRunOutcome | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && typeof listener.code === "string" && typeof listener.layer === "string") {
    return refused(listener.code, listener.layer);
  }
  // The route's own refusal frame is a 200; without this branch it would fall
  // through the RUN guard and be mislabelled a generic INVALID, hiding the real
  // capability/project/unknown-run code.
  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED"
    && typeof route.code === "string" && typeof route.layer === "string") {
    return refused(route.code, route.layer);
  }
  // The authenticator's PORT_REFUSED frame: a distinct key set and outcome from the
  // adapter's REFUSED, so a revoked/expired credential needs its own branch or it
  // flattens to a generic INVALID that hides the real auth code.
  const port = exactDataRecord(response, ["httpStatus", "ok", "outcome", "refusal", "stage"]);
  if (port !== null && port.ok === false && port.outcome === "PORT_REFUSED"
    && typeof port.stage === "string") {
    const portCode = typeof port.refusal === "object" && port.refusal !== null
      ? Object.getOwnPropertyDescriptor(port.refusal, "code") : undefined;
    if (portCode !== undefined && "value" in portCode && typeof portCode.value === "string") {
      return refused(portCode.value, port.stage);
    }
  }
  const http = exactDataRecord(response, ["error", "httpStatus", "ok", "outcome", "stage"]);
  if (http === null || http.ok !== false || http.outcome !== "REFUSED"
    || typeof http.stage !== "string") return null;
  const runtimeError = typeof http.error === "object" && http.error !== null
    ? Object.getOwnPropertyDescriptor(http.error, "code") : undefined;
  return runtimeError !== undefined && "value" in runtimeError
    && typeof runtimeError.value === "string"
    ? refused(runtimeError.value, http.stage) : null;
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function stringArrayOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return Object.freeze([...(value as string[])]);
}

/** One plan step, or null when its shape drifts (which reddens the whole answer). */
function stepViewOf(value: unknown): PlanningRunStepView | null {
  const record = exactDataRecord(value, ["description", "kind", "stepId"]);
  if (record === null
    || typeof record.description !== "string"
    || !nonEmptyString(record.kind) || !nonEmptyString(record.stepId)) return null;
  return Object.freeze({
    description: record.description, kind: record.kind, stepId: record.stepId,
  });
}

/** The plan body, or null when a PRESENT plan fails its shape guard. */
function planViewOf(value: unknown): PlanningRunPlanView | null {
  const record = exactDataRecord(value, [
    "affectedCriterionIds", "affectedNodeIds", "planHash", "steps",
  ]);
  if (record === null || !nonEmptyString(record.planHash) || !Array.isArray(record.steps)) {
    return null;
  }
  const affectedNodeIds = stringArrayOf(record.affectedNodeIds);
  const affectedCriterionIds = stringArrayOf(record.affectedCriterionIds);
  if (affectedNodeIds === null || affectedCriterionIds === null) return null;
  const steps: PlanningRunStepView[] = [];
  for (const raw of record.steps) {
    const step = stepViewOf(raw);
    if (step === null) return null;
    steps.push(step);
  }
  return Object.freeze({
    affectedCriterionIds, affectedNodeIds, planHash: record.planHash,
    steps: Object.freeze(steps),
  });
}

function evidenceViewOf(value: unknown): PlanningRunEvidenceView | null {
  const record = exactDataRecord(value, ["evidenceRef", "kind", "requirementId"]);
  if (record === null
    || !nonEmptyString(record.evidenceRef) || !nonEmptyString(record.kind)
    || !nonEmptyString(record.requirementId)) return null;
  return Object.freeze({
    evidenceRef: record.evidenceRef, kind: record.kind, requirementId: record.requirementId,
  });
}

function obligationViewOf(value: unknown): PlanningRunObligationView | null {
  const record = exactDataRecord(value, [
    "criterionId", "evidenceRequirements", "statement", "verificationRecipeRefs",
  ]);
  if (record === null
    || !nonEmptyString(record.criterionId) || typeof record.statement !== "string"
    || !Array.isArray(record.evidenceRequirements)) return null;
  const recipeRefs = stringArrayOf(record.verificationRecipeRefs);
  if (recipeRefs === null) return null;
  const evidenceRequirements: PlanningRunEvidenceView[] = [];
  for (const raw of record.evidenceRequirements) {
    const evidence = evidenceViewOf(raw);
    if (evidence === null) return null;
    evidenceRequirements.push(evidence);
  }
  return Object.freeze({
    criterionId: record.criterionId,
    evidenceRequirements: Object.freeze(evidenceRequirements),
    statement: record.statement,
    verificationRecipeRefs: recipeRefs,
  });
}

/** The acceptance body, or null when a PRESENT acceptance fails its shape guard. */
function acceptanceViewOf(value: unknown): PlanningRunAcceptanceView | null {
  const record = exactDataRecord(value, ["criteriaDigest", "obligations"]);
  if (record === null || !nonEmptyString(record.criteriaDigest)
    || !Array.isArray(record.obligations)) return null;
  const obligations: PlanningRunObligationView[] = [];
  for (const raw of record.obligations) {
    const obligation = obligationViewOf(raw);
    if (obligation === null) return null;
    obligations.push(obligation);
  }
  return Object.freeze({
    criteriaDigest: record.criteriaDigest, obligations: Object.freeze(obligations),
  });
}

/**
 * Maps only an exact daemon RUN frame; every other answer becomes a visible
 * REFUSED (a daemon refusal, carried at its own layer) or ERROR (a shape this
 * client cannot vouch for). PURE - it performs no I/O.
 *
 * plan/acceptance are mapped DEFENSIVELY: null stays null (an honest UNSEALED run,
 * sealed:false), but a present body that fails its shape guard reddens the WHOLE
 * answer to ERROR rather than rendering a half-plan a human might approve.
 */
export function mapPlanningRunAnswer(status: number, response: unknown): PlanningRunOutcome {
  // A refusal can arrive at HTTP 200 (route) or a transport status (listener /
  // adapter), so it is recognised BEFORE the status gate - otherwise a 400/401/503
  // refusal would be flattened into a generic INVALID rather than carrying its code.
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, RUN_KEYS);
  if (record === null || record.outcome !== "RUN"
    || !nonEmptyString(record.runId) || !nonEmptyString(record.lifecycle)
    || !nonEmptyString(record.submissionHash) || typeof record.reviewable !== "boolean") {
    return invalidResponse();
  }
  let plan: PlanningRunPlanView | null;
  if (record.plan === null) {
    plan = null;
  } else {
    plan = planViewOf(record.plan);
    if (plan === null) return invalidResponse();
  }
  let acceptance: PlanningRunAcceptanceView | null;
  if (record.acceptance === null) {
    acceptance = null;
  } else {
    acceptance = acceptanceViewOf(record.acceptance);
    if (acceptance === null) return invalidResponse();
  }
  return Object.freeze({
    acceptance,
    lifecycle: record.lifecycle,
    plan,
    reviewable: record.reviewable,
    runId: record.runId,
    sealed: plan !== null,
    status: "RUN" as const,
    submissionHash: record.submissionHash,
  });
}

/**
 * POSTs { runId } to the daemon's plan-review read route and maps the answer. The
 * body is JSON of exactly { runId } because the route refuses any extra field.
 * `post` is injectable for tests; the default carries the authenticated header set
 * and its own deadline (mirroring the board feed), so a daemon that accepts and
 * never answers becomes a mapped ERROR rather than a hung screen.
 */
export async function readPlanningRun(
  headers: Readonly<Record<string, string>>,
  runId: string,
  post?: (body: string) => Promise<Response>,
): Promise<PlanningRunOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(PLANNING_RUN_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send(JSON.stringify({ runId }));
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LIVE_PLANNING_LAYER);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapPlanningRunAnswer(response.status, body);
}
