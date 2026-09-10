import { createHash } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION, decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { DomainRefusal } from "../daemon-command-dispatch.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-registry.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { CommandHandlerInput, CommandRegistry } from "../http/http-contract.js";
import { readRunGoalPublication } from "../http/run-goal-publication.js";
import { readPublishLedger } from "../repository/publish-ledger.js";
import { evaluateReleaseAutoApproval } from "./release-auto-approval.js";
import { recordReleaseAutoApproval } from "./release-auto-approval-record.js";
import { RELEASE_DECIDE_COMMAND_KIND } from "./release-decide-contracts.js";
import type { ReleaseDossierFactsPort } from "./release-decide-service.js";
import { releaseDossierAggregateId } from "./release-dossier-contracts.js";
import { releaseDossierGaps } from "./release-dossier.js";
import { releaseReceiptId } from "./release-receipt-contracts.js";
import { readReleaseReceipt } from "./release-receipt-ledger.js";

/**
 * GATE 3, UNATTENDED: the reconciler that finds a pushed goal whose evidence is complete and
 * releases it under a recorded opt-in, without a human.
 *
 * WHY A SCHEDULED RECONCILER AND NOT GATE 2'S SHAPE. Gate 2 fires from `preview.start`'s own async
 * completion because that is where a preview becomes decidable. Gate 3 has NO in-daemon completion
 * moment: the criterion receipts and the PUSHED publish receipt are written by the WRAPPER's
 * `delivery.advance()`, the release dossier is recorded lazily INSIDE a `release.decide` dispatch,
 * and this daemon has no store reactor to hang an after-commit hook on. So the trigger is a tick on
 * the EXISTING `DurableSchedule`, which already gives single-flight per job id.
 *
 * ORDER IS THE DESIGN, AND IT IS LOAD-BEARING. Every cheap local check runs BEFORE anything is
 * written, because the expensive step writes to `release:<goalId>` -- two decision records and two
 * events -- and bumps the version a human's Decide card was minted against. A reconciler that
 * dispatched a doomed decide every tick would 409 that human's card once a minute for as long as
 * the goal stayed stuck. The checks are: already attempted, already released, a human REJECT, a
 * release in flight, evidence gaps, then policy. Only then does anything move.
 *
 * A HUMAN REJECT WINS, PER GOAL. Any recorded REJECT on the goal's release aggregate parks the
 * automatic path until a human decides; a new sha does not un-park it. The automatic path never
 * REJECTs, so a REJECTED terminal is a human's by construction -- which is why reading the terminal
 * is enough and no separate "who decided" fact is needed.
 *
 * ONE AUTOMATIC ATTEMPT PER (goal, sha), AND THAT IS A DOCUMENTED BOUND. The commandId is a pure
 * function of (project, goal, sha), so the store's own decision key answers a retry. A REFUSED
 * automatic terminal therefore PARKS that sha for a human rather than being retried: re-dispatching
 * the same id once the aggregate version has moved would hit RELEASE_COMMAND_BYTES_CONFLICT, and a
 * retry policy that minted fresh ids is a separate decision, not this row's.
 *
 * NOTHING HERE THROWS. `DurableSchedule` flattens any throw to SCHEDULE_CALLBACK_FAILED and
 * DISCARDS the reason, so a refusal that escaped as an exception would be an invisible refusal.
 * Every per-candidate answer is a returned outcome, including a `DomainRefusal` from the dispatch.
 */

export const RELEASE_AUTO_DECIDE_JOB_ID = "release/auto-decide" as const;

/**
 * HOST-SCOPED DAEMON-PROCESS CONFIGURATION, read once at composition and passed down RAW, exactly
 * as `DEPLOY_BUILD_CONTEXT_ENV_KEY` is. There is no server fact for a repository's base branch --
 * `ProjectRemote` carries only `{boundAt, boundBy, remoteUrl}` -- and it is deliberately NOT a
 * payload key. An unconfigured daemon releases NOTHING automatically and leaves the gate to a human
 * who supplies their own base, rather than guessing one.
 */
export const RELEASE_BASE_ENV_KEY = "MOE_RELEASE_BASE" as const;

/** Never authenticated on this path. The wrapper recomputes identity from the SERVER-KNOWN
 *  principal, so this string is a placeholder that carries no authority -- the same posture boot
 *  reconciliation takes when it dispatches under the configured operator id. */
const SESSION_CREDENTIAL_PLACEHOLDER = "daemon:release-auto-decide";

export type ReleaseAutoOutcomeCode =
  | "ALREADY_ATTEMPTED"
  | "ALREADY_RELEASED"
  | "BASE_UNCONFIGURED"
  | "DISPATCH_REFUSED"
  | "EVIDENCE_INCOMPLETE"
  | "HUMAN_REJECTED"
  | "NOT_ALLOWED"
  | "RECORD_FAILED"
  | "RELEASE_IN_FLIGHT"
  | "RELEASED"
  | "UNSERVED";

/**
 * One candidate's answer. `code` is this reconciler's own word for WHAT happened; `refusal` carries
 * the production vocabulary's (code, layer) pair whenever a gate refused, so an arm can assert the
 * stable code together with the layer that minted it rather than merely that nothing released.
 */
export interface ReleaseAutoOutcome {
  readonly code: ReleaseAutoOutcomeCode;
  readonly detail: string;
  readonly goalId: string;
  readonly refusal: { readonly code: string; readonly layer: string } | null;
  readonly sha: string;
}

export interface ReleaseAutoDecideDeps {
  /** The pull request's base branch. Host-scoped daemon config; ABSENT means nothing releases. */
  readonly base: string | null;
  readonly clock: () => string;
  readonly dossierFacts: ReleaseDossierFactsPort;
  /** The configured OPERATOR principal. A `daemon:*` id is refused 403 by the release fence. */
  readonly operatorPrincipalId: string;
  readonly projectId: string;
  /** The ALREADY-COMPOSED registry. A second composition would mint a second pull-request port. */
  readonly registry: CommandRegistry;
  readonly store: SqliteEventStore;
}

function outcome(
  goalId: string, sha: string, code: ReleaseAutoOutcomeCode, detail: string,
  refusal: { readonly code: string; readonly layer: string } | null = null,
): ReleaseAutoOutcome {
  return Object.freeze({ code, detail, goalId, refusal, sha });
}

/** DETERMINISTIC, so the store's own decision key answers a retry before any check here does. */
export function releaseAutoCommandId(projectId: string, goalId: string, sha: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["release-auto", projectId, goalId, sha]), "utf8")
    .digest("hex");
}

interface ReleaseWalk {
  readonly pending: boolean;
  readonly rejectedBy: string | null;
}

/**
 * ONE WALK OF THE RELEASE AGGREGATE, answering both questions the pre-checks ask of it: has a
 * human REJECTED, and is a release currently in flight. Two walks would be two chances to disagree.
 *
 * The REJECT test reads the terminal the wrapper committed (`release-decide-command.ts` writes the
 * 3-key DECIDED terminal as the `ReleaseCommandDecided` payload), not a paraphrase of it.
 */
function walkRelease(store: SqliteEventStore, goalId: string): ReleaseWalk {
  const inFlight = new Set<string>();
  let rejectedBy: string | null = null;
  for (const event of store.readEvents(releaseDossierAggregateId(goalId))) {
    if (event.eventType === "ReleaseCommandAdmitted") {
      inFlight.add(event.eventId.slice(0, -"-admitted".length));
      continue;
    }
    if (event.eventType !== "ReleaseCommandDecided") continue;
    inFlight.delete(event.eventId.slice(0, -"-decided".length));
    const decoded = decodeBoundedJsonBytes(event.payload);
    if (!decoded.ok || decoded.value === null || typeof decoded.value !== "object"
      || Array.isArray(decoded.value)) continue;
    const value = decoded.value as JsonObject;
    if (value["outcome"] === "DECIDED" && value["resultCode"] === "REJECTED"
      && value["effectId"] === null) {
      rejectedBy = event.decisionTrace?.principalId ?? "an unnamed principal";
    }
  }
  return { pending: inFlight.size > 0, rejectedBy };
}

/** Every (goal, sha) the publisher has PUSHED. The only candidates an automatic release considers. */
function candidatesOf(
  store: SqliteEventStore, projectId: string,
): readonly { readonly goalId: string; readonly sha: string }[] {
  const candidates: { readonly goalId: string; readonly sha: string }[] = [];
  for (const [goalId, state] of readPublishLedger(store, projectId)) {
    const publication = readRunGoalPublication(store, projectId, state);
    if (publication !== null && publication.outcome === "PUSHED" && publication.sha !== null) {
      candidates.push({ goalId, sha: publication.sha });
    }
  }
  return candidates;
}

/** The envelope the production wrapper will decode, re-admit and recompute identity from. */
function envelopeFor(
  deps: ReleaseAutoDecideDeps, goalId: string, sha: string, base: string,
  commandId: string, expectedVersion: number,
): CommandHandlerInput {
  const payload = { base, decision: "APPROVE", goalId, sha };
  return {
    envelope: {
      commandId,
      commandKind: RELEASE_DECIDE_COMMAND_KIND,
      correlationId: `release-auto-${commandId.slice(0, 16)}`,
      expectedVersion,
      payload,
      requestDigest: createHash("sha256")
        .update(JSON.stringify(payload), "utf8").digest("hex"),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: SESSION_CREDENTIAL_PLACEHOLDER,
      targetAggregateId: releaseDossierAggregateId(goalId),
    },
    principal: {
      capabilities: OPERATOR_CAPABILITIES,
      principalId: deps.operatorPrincipalId,
      projectId: deps.projectId,
    },
  } as unknown as CommandHandlerInput;
}

/** Whether this goal and sha may be released automatically right now, and why not when it may not. */
async function decideCandidate(
  deps: ReleaseAutoDecideDeps, goalId: string, sha: string,
): Promise<ReleaseAutoOutcome> {
  const { dossierFacts, operatorPrincipalId, projectId, registry, store } = deps;
  const commandId = releaseAutoCommandId(projectId, goalId, sha);
  // (0) ONE ATTEMPT PER (goal, sha). See the module header for why a REFUSED terminal parks it.
  if (store.getCommandDecision({ commandId, principalId: operatorPrincipalId, projectId })
    !== null) {
    return outcome(goalId, sha, "ALREADY_ATTEMPTED", "an automatic attempt is already recorded");
  }
  // (1) ALREADY RELEASED. The service's own pair for this condition, not a second vocabulary.
  if (readReleaseReceipt(
    store, projectId, releaseReceiptId(projectId, goalId, sha, "RELEASED", null),
  ).ok) {
    return outcome(goalId, sha, "ALREADY_RELEASED", "this sha is already released",
      { code: "RELEASE_COMMAND_ID_REQUIRED", layer: DAEMON_COMMAND_SEAM });
  }
  const walk = walkRelease(store, goalId);
  // (2) A HUMAN REJECT WINS. Per goal, and a new sha does not un-park it.
  if (walk.rejectedBy !== null) {
    return outcome(goalId, sha, "HUMAN_REJECTED",
      `${walk.rejectedBy} rejected this release; the automatic path does not overturn a human`,
      { code: "RELEASE_COMMAND_ID_REQUIRED", layer: DAEMON_COMMAND_SEAM });
  }
  // (3) A release is in flight: someone else owns this target.
  if (walk.pending) {
    return outcome(goalId, sha, "RELEASE_IN_FLIGHT", "a release command already owns this target");
  }
  // (4) EVIDENCE. The gap CODES, which the service's own detail does not carry.
  const facts = dossierFacts(goalId, sha);
  if (facts === null) {
    return outcome(goalId, sha, "EVIDENCE_INCOMPLETE", "no release evidence is readable",
      { code: "RELEASE_EVIDENCE_INCOMPLETE", layer: "DAEMON_PREREQUISITE" });
  }
  const gaps = releaseDossierGaps(facts.input, sha, facts.ancestry);
  if (gaps.length > 0) {
    return outcome(goalId, sha, "EVIDENCE_INCOMPLETE",
      [...new Set(gaps.map((gap) => gap.code))].sort().join(", "),
      { code: "RELEASE_EVIDENCE_INCOMPLETE", layer: "DAEMON_PREREQUISITE" });
  }
  // (5) POLICY. The engine decides; this module neither ranks a tier nor matches an opt-in.
  const decidedAt = deps.clock();
  const approval = evaluateReleaseAutoApproval(store, {
    decidedAt, goalId, operatorPrincipalId, projectId,
  });
  if (!approval.ok) {
    return outcome(goalId, sha, "NOT_ALLOWED", approval.reasonCodes.join(", "),
      { code: approval.code, layer: approval.layer });
  }
  // FAIL CLOSED ON AN UNCONFIGURED BASE. There is no server fact for the base branch, so with
  // none configured the human decides the release with their own base rather than the daemon
  // guessing one. Checked after policy so an arm can tell "not opted in" from "not configured".
  if (deps.base === null || deps.base === "") {
    return outcome(goalId, sha, "BASE_UNCONFIGURED", "no release base branch is configured");
  }
  // (6) THE RECORD, before the dispatch, so the receipt the service writes can NAME the opt-in.
  const recorded = recordReleaseAutoApproval(store, {
    commandId, decidedAt, goalId, optIn: approval.optIn, projectId,
    reasonCodes: approval.reasonCodes, sha, sliceRef: approval.sliceRef,
    subjectTier: approval.subjectTier,
  });
  if (!recorded.ok) {
    return outcome(goalId, sha, "RECORD_FAILED", recorded.code);
  }
  const handler = registry.get(RELEASE_DECIDE_COMMAND_KIND)?.asyncHandler;
  if (handler === undefined) {
    return outcome(goalId, sha, "UNSERVED", "release.decide has no async handler registered");
  }
  // (7) The version is read AFTER the walk, so a human who decided during the walk wins the fence.
  const expectedVersion = store.getAggregateVersion(releaseDossierAggregateId(goalId));
  try {
    const decision = await handler(
      envelopeFor(deps, goalId, sha, deps.base, commandId, expectedVersion),
    );
    // The DISPOSITION travels in the detail. A second tick that reaches the dispatch before the
    // store has its decision gets REPLAYED, not a second release: the commandId is deterministic,
    // so the wrapper answers from the stored terminal. A caller that could not see the difference
    // would read two releases where there was one.
    return outcome(goalId, sha, "RELEASED", `${decision.disposition} ${decision.resultCode}`);
  } catch (error) {
    // A refusal is an OUTCOME for this candidate, never a throw: the schedule flattens a throw to
    // SCHEDULE_CALLBACK_FAILED and discards the reason, so the reason would simply vanish.
    if (error instanceof DomainRefusal) {
      return outcome(goalId, sha, "DISPATCH_REFUSED", error.detail,
        { code: error.code, layer: error.layer });
    }
    return outcome(goalId, sha, "DISPATCH_REFUSED",
      error instanceof Error ? error.message : "unknown dispatch failure");
  }
}

/** One tick: every PUSHED candidate, answered independently. Exported so arms drive it directly. */
export async function releaseAutoDecideOnce(
  deps: ReleaseAutoDecideDeps,
): Promise<readonly ReleaseAutoOutcome[]> {
  const answers: ReleaseAutoOutcome[] = [];
  for (const candidate of candidatesOf(deps.store, deps.projectId)) {
    answers.push(await decideCandidate(deps, candidate.goalId, candidate.sha));
  }
  return Object.freeze(answers);
}

export interface ScheduleRegistrar {
  register(
    id: string, callback: (signal: AbortSignal) => void | Promise<void>, intervalMs?: number,
  ): { readonly ok: true } | { readonly code: string; readonly layer: string; readonly ok: false };
}

/** Arms the reconciler on the daemon's existing schedule. Single-flight per job is the schedule's. */
export function registerReleaseAutoDecide(
  schedules: ScheduleRegistrar, deps: ReleaseAutoDecideDeps,
): ReturnType<ScheduleRegistrar["register"]> {
  return schedules.register(RELEASE_AUTO_DECIDE_JOB_ID, async (): Promise<void> => {
    await releaseAutoDecideOnce(deps);
  });
}
