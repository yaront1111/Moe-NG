/**
 * ACTIVITY: what the daemon decided, in order. Every committed command and every
 * version conflict is a durable decision record; this read lists the latest ones for the
 * project, or for one goal (the goal, its planning run, its sealed nodes). It states the
 * record's own facts (kind, target, principal, instant, disposition, version) and adds no
 * interpretation; the browser puts the words on. Refused commands are not decisions and do
 * not appear, which the response says in `refusalsRecorded: false` so nobody reads an
 * empty list as "nothing was refused".
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import type { ActiveCompiledGraph } from "../orchestrator/compiled-node-source.js";
import { catalogBoundGoals } from "./document-coverage-goals.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const ACTIVITY_READ_PATH = "/activity/read" as const;
const LAYER = "ACTIVITY_READ" as const;
const DECISION_PAGE_SIZE = 512;
const PROJECT_LIMIT = 80;
const GOAL_LIMIT = 200;
const ACTIVITY_LIFECYCLES: ReadonlySet<string> = new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]);
/**
 * Seat and pairing records: the handshake's own decisions and every session command. They
 * are not work on the project (the sessions read reports seats), and on a daemon with many
 * paired browsers they outnumber work decisions many times over, so they are left out of
 * the ledger rather than allowed to push every work decision past the page limit.
 */
const SEAT_KINDS: ReadonlySet<string> = new Set(["CLOSE_SESSION", "CREATE_PRINCIPAL", "OPEN_SESSION"]);
const SEAT_TARGET_PREFIX = "moe.session-authority";
export function isSeatRecord(commandKind: string, targetAggregateId: string): boolean {
  return SEAT_KINDS.has(commandKind) || commandKind.startsWith("session.") || targetAggregateId.startsWith(SEAT_TARGET_PREFIX);
}

export const ACTIVITY_READ_CODES = Object.freeze([
  "ACTIVITY_READ_CAPABILITY_DENIED", "ACTIVITY_READ_GOAL_UNKNOWN",
  "ACTIVITY_READ_PROJECT_MISMATCH", "ACTIVITY_READ_UNREADABLE",
] as const);

export type ActivityDisposition = "COMMITTED" | "VERSION_CONFLICT";
export interface ActivityEntry {
  readonly commandKind: string;
  readonly decidedAt: string;
  readonly disposition: ActivityDisposition;
  readonly principalId: string;
  readonly targetAggregateId: string;
  /**
   * WHAT the decision decided, when its committed result carries a word for it: the route a
   * `review.submit` round took (`routing.route`), the `escalation.decide` answer (`decision`).
   * Null for every other kind and for a conflict; the browser puts the words on.
   */
  readonly verdict: string | null;
  /** The aggregate version after the decision; null for a conflict, which moved nothing. */
  readonly version: number | null;
}
export interface ActivityView {
  readonly entries: readonly ActivityEntry[];
  readonly outcome: "ACTIVITY";
  /** Refused commands are not decision records; an absent refusal is not proof of none. */
  readonly refusalsRecorded: false;
  readonly scope: { readonly goalId: string | null; readonly targets: number };
  readonly totalDecisions: number;
}
export interface ActivityRefused { readonly code: string; readonly layer: string; readonly outcome: "REFUSED" }
export type ActivityReadResult = ActivityRefused | ActivityView;
export type ActivitySelector = { readonly goalRef: string } | Record<never, never>;
export interface ActivityReadPort {
  readonly boundProjectId: string;
  readActivity(selector: ActivitySelector): ActivityReadResult;
}

const refused = (code: string): ActivityRefused => Object.freeze({ code, layer: LAYER, outcome: "REFUSED" as const });

const VERDICT_KINDS: ReadonlySet<string> = new Set([
  "approval.decide", "approval.decide_intent", "escalation.decide", "review.submit",
]);

/** A REJECT commits the run record with `decision` on it, so the word is READ. An APPROVE commits
 *  a GoalState - no decision word, a `lifecycle` - and the approval seams admit APPROVE ONLY
 *  (planning-services.ts:290), so for those kinds a lifecycle IS the verdict. Narrow on purpose,
 *  and not offered to `escalation.decide`: wider, and an unrelated record renders as an approval. */
function decisionWord(commandKind: string, record: Record<string, unknown>): unknown {
  const decision = record["decision"];
  if (typeof decision === "string" && decision.length > 0) return decision;
  const lifecycle = record["lifecycle"];
  return commandKind !== "escalation.decide" && typeof lifecycle === "string" && lifecycle.length > 0
    ? "APPROVE" : undefined;
}

/** The one word a committed result carries for what was decided, or null. Never throws. */
export function verdictOf(commandKind: string, resultBytes: Uint8Array): string | null {
  if (!VERDICT_KINDS.has(commandKind)) return null;
  const decoded = decodeBoundedJsonBytes(resultBytes);
  if (!decoded.ok) return null;
  const result: unknown = decoded.value;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  const word = commandKind === "review.submit"
    ? typeof record["routing"] === "object" && record["routing"] !== null && !Array.isArray(record["routing"])
      ? (record["routing"] as Record<string, unknown>)["route"] : undefined
    : decisionWord(commandKind, record);
  return typeof word === "string" && word.length > 0 ? word : null;
}

export interface ActivityReadOptions {
  readonly projectId: string;
  readonly readActive?: (store: SqliteEventStore, projectId: string) => readonly ActiveCompiledGraph[];
  readonly store: SqliteEventStore;
}

export function createActivityReadPort(options: ActivityReadOptions): ActivityReadPort {
  const { projectId, store } = options;
  const readActive = options.readActive
    ?? ((s: SqliteEventStore, p: string) => activeCompiledGraphs(s, p, ACTIVITY_LIFECYCLES));

  /** The aggregates a goal's activity lives on: the goal, its run, its sealed nodes. */
  const targetsOf = (goalRef: string): ReadonlySet<string> | null => {
    const goals = catalogBoundGoals(store, projectId);
    const goal = goals?.find((row) => row.goalId === goalRef);
    if (goals === null || goal === undefined) return null;
    const targets = new Set<string>([goal.goalId]);
    if (goal.planningRunRef !== null) targets.add(goal.planningRunRef);
    for (const graph of readActive(store, projectId)) {
      if (graph.goalRef !== goalRef) continue;
      for (const node of graph.content.snapshot.nodes) targets.add(node.nodeKey);
    }
    return targets;
  };

  const readActivity = (selector: ActivitySelector): ActivityReadResult => {
    try {
      const goalId = "goalRef" in selector ? selector.goalRef : null;
      const targets = goalId === null ? null : targetsOf(goalId);
      if (goalId !== null && targets === null) return refused("ACTIVITY_READ_GOAL_UNKNOWN");
      const limit = goalId === null ? PROJECT_LIMIT : GOAL_LIMIT;
      const entries: ActivityEntry[] = [];
      let totalDecisions = 0;
      let cursor = 0n;
      for (;;) {
        const page = store.readCommandDecisionsAfter(cursor, DECISION_PAGE_SIZE);
        for (const decision of page.items) {
          if (decision.key.projectId !== projectId) continue;
          if (targets !== null && !targets.has(decision.targetAggregateId)) continue;
          if (isSeatRecord(decision.commandKind, decision.targetAggregateId)) continue;
          totalDecisions += 1;
          const committed = decision.effectDisposition === "EFFECTS_COMMITTED";
          entries.push(Object.freeze({
            commandKind: decision.commandKind,
            decidedAt: decision.decidedAt,
            disposition: committed ? "COMMITTED" as const : "VERSION_CONFLICT" as const,
            principalId: decision.key.principalId,
            targetAggregateId: decision.targetAggregateId,
            verdict: committed ? verdictOf(decision.commandKind, decision.resultBytes) : null,
            version: committed ? decision.currentVersion : null,
          }));
          if (entries.length > limit) entries.shift();
        }
        if (!page.hasMore || page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      entries.reverse();
      return Object.freeze({
        entries: Object.freeze(entries),
        outcome: "ACTIVITY" as const,
        refusalsRecorded: false as const,
        scope: Object.freeze({ goalId, targets: targets === null ? 0 : targets.size }),
        totalDecisions,
      });
    } catch {
      return refused("ACTIVITY_READ_UNREADABLE");
    }
  };
  return Object.freeze({ boundProjectId: projectId, readActivity });
}

export type ActivityReadDispatch =
  | { readonly body: ActivityReadResult | HttpPortRefused | HttpRefused; readonly httpStatus: number; readonly kind: "REPLY" }
  | { readonly code: "LISTENER_ACTIVITY_REQUEST_INVALID" | "LISTENER_ACTIVITY_UNAVAILABLE"; readonly kind: "LISTENER_REFUSAL" };

/** `{}` or `{ goalRef: string }`, nothing else; an empty body counts as `{}`. */
export function activitySelectorOf(body: unknown): ActivitySelector | null {
  if (body instanceof Uint8Array && body.length === 0) return Object.freeze({});
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const value: unknown = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0) return Object.freeze({});
  const goalRef = (value as Record<string, unknown>)["goalRef"];
  if (keys.length !== 1 || keys[0] !== "goalRef" || typeof goalRef !== "string" || goalRef.length === 0) return null;
  return Object.freeze({ goalRef });
}

export function handleActivityReadRequest(
  dependencies: { readonly activity?: ActivityReadPort | undefined; readonly authenticator: Authenticator },
  request: { readonly body: unknown; readonly credential: string | null; readonly protocolVersion: unknown },
): ActivityReadDispatch {
  const access = authenticateHttpRequest(dependencies.authenticator, request.credential, request.protocolVersion);
  if (!access.ok) return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({ body: refused("ACTIVITY_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY" });
  }
  const port = dependencies.activity;
  if (port === undefined) return Object.freeze({ code: "LISTENER_ACTIVITY_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  if (access.principal.projectId !== port.boundProjectId) {
    return Object.freeze({ body: refused("ACTIVITY_READ_PROJECT_MISMATCH"), httpStatus: 200, kind: "REPLY" });
  }
  const selector = activitySelectorOf(request.body);
  if (selector === null) return Object.freeze({ code: "LISTENER_ACTIVITY_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  return Object.freeze({ body: port.readActivity(selector), httpStatus: 200, kind: "REPLY" });
}
