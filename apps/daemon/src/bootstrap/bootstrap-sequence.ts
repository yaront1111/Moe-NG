import type { JsonObject } from "@moe/contracts";

import type { BootstrapCommandKind, BootstrapRequest } from "./bootstrap-contracts.js";

/**
 * The durable command sequence and the payload accessors every service shares.
 *
 * Split out of `bootstrap-ledger.ts` to keep both files near the per-file target; this module
 * holds only data and total functions, and touches no store.
 */

/**
 * Each kind names the kinds that must already hold a committed decision for this project
 * before it may run. This table is what DoD 1 rests on: a project reaches READY only when
 * register, bind and probe are themselves durably recorded, so no hand-edited state can
 * activate one.
 */
export const COMMAND_PREREQUISITES = Object.freeze({
  "approval.decide": Object.freeze(["plan.propose"]),
  // Acceptance can only follow the approval that activated the graph, so the goal it accepts
  // is durably EXECUTION_ENABLED before the core is ever asked.
  "goal.close": Object.freeze(["approval.decide"]),
  // Publishing follows the approval that activated the graph: before it there is nothing
  // landed to push. The decision names a remote; the wrapper's publisher performs the push.
  "repository.publish": Object.freeze(["approval.decide"]),
  "goal.create": Object.freeze(["project.activate"]),
  "goal.create_with_source": Object.freeze(["project.activate"]),
  "plan.propose": Object.freeze(["goal.create"]),
  "policy.install": Object.freeze([]),
  "policy.validate": Object.freeze(["policy.install"]),
  "project.activate": Object.freeze([
    "project.register",
    "project.bind_repository",
    "provider.probe",
  ]),
  "project.bind_repository": Object.freeze(["project.register"]),
  "project.register": Object.freeze([]),
  "provider.probe": Object.freeze(["project.register"]),
} as const satisfies Readonly<Record<BootstrapCommandKind, readonly BootstrapCommandKind[]>>);

/**
 * Kinds whose own committed decision ALSO satisfies the keyed prerequisite.
 *
 * `goal.create_with_source` lands the SAME durable GoalCreated `goal.create` does — same
 * aggregate, same brief, one extra document-binding leg — so a run whose goal arrived through
 * it is as ready to be planned as any other. Without this, `plan.propose` refuses
 * BOOTSTRAP_PREREQUISITE_MISSING and a source-created goal can never continue the journey.
 *
 * `approval.decide_intent` is the browser's approval. A paired session approves through the
 * daemon-owned intent seam (`approval-intent.ts`), which mints the approval record and activates
 * the graph without ever committing an `approval.decide` — so a goal approved IN THE BROWSER had
 * no way to satisfy the `goal.close` (:22) and `repository.publish` (:25) prerequisite, and no
 * operator act existed that could ever supply one. Not a theory: measured on the live UnAI
 * project, where a goal at 10/10 criteria VERIFIED and an APPROVED contract answered
 * BOOTSTRAP_PREREQUISITE_MISSING in 212 ms while `/affordances/read` went on offering its
 * operator a Close button. `affordance-read.ts:366` already reads
 * `kinds.has("approval.decide") || kinds.has("approval.decide_intent")` off this very set, so
 * this entry does not invent a rule — it makes the prerequisite agree with one the read surface
 * has enforced for longer, ending a split where two authorities answered differently about the
 * same command on the same frame.
 *
 * THE VALUE TYPE IS `readonly string[]`, NOT `readonly BootstrapCommandKind[]`, because an
 * alternative need not be one of the twelve kinds this pipeline serves: `approval.decide_intent`
 * is served by the runtime registry. That is sound rather than lax, because an alternative is
 * only ever TESTED, with `committed.has(alternative)` below, against the set `readDurableLedger`
 * builds — a `Set<string>` over every committed decision kind, bootstrap or not. The KEY type
 * stays `BootstrapCommandKind`: a prerequisite always is one, since the keys come from
 * `COMMAND_PREREQUISITES`.
 *
 * WHY A SECOND TABLE RATHER THAN NESTED GROUPS INSIDE `COMMAND_PREREQUISITES`. Nesting changes
 * the map's VALUE TYPE, and that type is read by two suites this row does not own:
 * `daemon-command-registry.test.ts:1071` casts the whole map and `demo-seed-plan.test.ts:56`
 * iterates an entry as flat kinds — measured as TS2352 and TS2345 under a throwaway probe
 * (worker-9fe78697, comment-10e96d8f). Keyed alternatives leave every entry of
 * `COMMAND_PREREQUISITES` byte-identical, so those consumers keep asserting exactly what they
 * assert today, and the kind reported as unmet stays the PRIMARY — a plain string the board's
 * `missing` decoder already parses, never a group literal.
 *
 * IT FAILS CLOSED BY CONSTRUCTION: a kind with no entry, or an entry that is empty, admits
 * nothing but itself, and a listed alternative only ever satisfies by being genuinely present
 * in the committed set. Widening is therefore always explicit and always one named kind.
 */
export const PREREQUISITE_ALTERNATIVES:
  Readonly<Partial<Record<BootstrapCommandKind, readonly string[]>>> =
  Object.freeze({
    // ONE entry, TWO kinds fixed: `goal.close` and `repository.publish` both name
    // `approval.decide` as their prerequisite, so widening the requirement widens both.
    "approval.decide": Object.freeze(["approval.decide_intent"] as const),
    "goal.create": Object.freeze(["goal.create_with_source"] as const),
  });

/**
 * The prerequisites `kind` still lacks, each named by the PRIMARY kind of the requirement it
 * failed — the stable member wire consumers already parse.
 *
 * Total and store-free: the caller supplies the committed set, so this stays testable at the
 * table level while `missingPrerequisites` remains the one seam services call.
 */
export function unmetPrerequisites(
  kind: BootstrapCommandKind,
  committed: ReadonlySet<string>,
): readonly BootstrapCommandKind[] {
  return COMMAND_PREREQUISITES[kind].filter((entry: BootstrapCommandKind) => {
    if (committed.has(entry)) return false;
    const alternatives = PREREQUISITE_ALTERNATIVES[entry];
    if (alternatives === undefined) return true;
    return !alternatives.some((alternative) => committed.has(alternative));
  });
}

/**
 * The ONE stream `policy.install` and `policy.validate` commit to, named once.
 *
 * Exported because a READER now depends on it: `admission-gate-resolver.ts` resolves a
 * POLICY_ALLOWANCE node's witness from the latest `PolicyEvaluated` on this aggregate, and a
 * reader that restated the template literal would answer "no durable witness" forever if the
 * writer's naming ever moved — a fail-closed refusal for a world that actually decided.
 */
export const policyAggregateId = (projectId: string): string => `${projectId}-policy`;

/**
 * Aggregate stream per kind.
 *
 * Probe and policy get streams of their own so their events never bump the project's version
 * out from under `reduceProject`'s expected-version check.
 */
export function aggregateIdFor(request: BootstrapRequest, subject: string | null): string {
  switch (request.kind) {
    case "project.register":
    case "project.bind_repository":
    case "project.activate":
      return request.projectId;
    case "provider.probe":
      return `${request.projectId}-provider`;
    case "policy.install":
    case "policy.validate":
      return policyAggregateId(request.projectId);
    case "repository.publish": {
      // The chain card carries no payload; a real request names its goal.
      const goalId = request.payload === undefined ? null : payloadRef(request.payload, "goalId");
      return `publish:${goalId ?? subject ?? request.projectId}`;
    }
    default:
      return subject ?? request.projectId;
  }
}

export function payloadRef(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function payloadObject(payload: JsonObject, key: string): JsonObject | null {
  const value = payload[key];
  if (value === null || value === undefined || typeof value !== "object") return null;
  if (Array.isArray(value)) return null;
  return value as JsonObject;
}
