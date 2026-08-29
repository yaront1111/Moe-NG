import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { BOOTSTRAP_COMMAND_KINDS, BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import type { BootstrapCommandKind } from "../bootstrap/bootstrap-contracts.js";
import {
  missingPrerequisites, readDurableLedger, versionOf,
} from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { aggregateIdFor } from "../bootstrap/bootstrap-sequence.js";
import { SESSION_SCHEMA_VERSION } from "../identity/session-contracts.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { REVIEW_SCHEMA_VERSION } from "../review/review-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { activeClaim, readWorkClaimLedger } from "../work/work-claim-services.js";
import type { WorkClaimLedger } from "../work/work-claim-services.js";
import { AFFORDANCE_SURFACE_LAYER, NODE_DELIVER_KIND } from "./affordance-contract.js";
import { planReviewable, resolvePlanningOffers } from "./affordance-planning-offers.js";
import type {
  AffordancePort,
  AffordanceSurfaceResult,
  ChainStep,
  ChainStepClaim,
  NodeSpec,
} from "./affordance-contract.js";

/**
 * Derives the surface from the durable decision ledgers alone. Every version it
 * offers was read from a committed aggregate; every BLOCKED list comes from the
 * same prerequisite table the services enforce, so the surface can never offer
 * a command the pipeline would refuse on ordering.
 *
 * DEVELOPMENT default-subject convention: planning and session kinds that do
 * not yet have a production catalog are offered against fixed dev subjects.
 * Goal creation is different: every READY surface mints a fresh goal aggregate
 * and binds the offer to it, so the browser never supplies lifecycle identity.
 */
/**
 * The two dev subjects, exported by name so every party to the convention can
 * bind to the SAME literal: this surface offers against them, the control
 * room's dev payloads address them, and the demo seed commits under them. A
 * seed that picked different ids produced a board whose one human action
 * refused with a misleading code — three copies of a literal drift silently,
 * one exported pair cannot.
 */
export const DEFAULT_RUN_SUBJECT = "run-live-1";
export const DEFAULT_GOAL_SUBJECT = "goal-live-1";

export const DEFAULT_SUBJECTS: Readonly<Partial<Record<BootstrapCommandKind, string>>> =
  Object.freeze({
    "approval.decide": DEFAULT_RUN_SUBJECT,
    "goal.close": DEFAULT_GOAL_SUBJECT,
    "plan.propose": DEFAULT_RUN_SUBJECT,
  });

const REPEATABLE_GOAL_CREATION_KINDS = Object.freeze([
  "goal.create", "goal.create_with_source",
] satisfies readonly BootstrapCommandKind[]);

export const DEFAULT_SESSION_SUBJECT = "sess-ui-1";

/**
 * A plan.propose commit is not one thing. The planning chain seals the plan
 * (lifecycle PLANNING) and a SECOND plan.propose request carries the finalize
 * terminal that moves the run to PLAN_REVIEW - the daemon refuses both in one
 * chain. The ledger's committed KINDS cannot tell the two apart, so a surface
 * keyed on kinds alone called a half-proposed run COMMITTED and offered
 * approval.decide against it, where the daemon refuses
 * APPROVAL_RUN_NOT_REVIEWABLE: a truthful-but-futile card. The run's own
 * durable lifecycle is the fact that answers, read off the same ledger.
 */
/**
 * The ledger as the bootstrap prerequisites should read it: plan.propose counts
 * as committed only once the run is reviewable. Until then the card stays
 * READY at its advanced version (the board dispatches the finalize against
 * that version) and approval.decide stays BLOCKED on it.
 */
function effectiveLedger(ledger: DurableLedger, runAggregateId: string): DurableLedger {
  if (!ledger.kinds.has("plan.propose") || planReviewable(ledger, runAggregateId)) return ledger;
  const kinds = new Set(ledger.kinds);
  kinds.delete("plan.propose");
  return Object.freeze({ aggregates: ledger.aggregates, decisionCount: ledger.decisionCount, kinds });
}

/** The finding rule the daemon's verifier records when a node's test run fails. */
export const VERIFIER_FAILURE_RULE = "verifier-test-failed";

export interface AffordancePortConfig {
  /** Canonical UTC instant used only to judge claim expiry; defaults to now. */
  readonly clock?: () => string;
  readonly mintId: () => string;
  /**
   * Operator-authored code nodes. Read per surface call so a spec added while
   * the daemon runs appears on the next poll. Absent means no node steps —
   * never an invented one.
   */
  readonly nodes?: () => readonly NodeSpec[];
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

/** The shared work-item key: the same one the live board renders per card. */
export function workItemIdFor(kind: string, aggregateId: string | null): string {
  return `${kind}@${aggregateId ?? "-"}`;
}

function claimFields(
  claims: WorkClaimLedger, kind: string, aggregateId: string | null, now: string,
): Pick<ChainStep, "claim" | "claimAggregateVersion"> {
  const record = claims.claims.get(workItemIdFor(kind, aggregateId));
  const active = activeClaim(record, now);
  return Object.freeze({
    claim: active === null ? null : Object.freeze({
      claimedBy: active.claimedBy,
      expiresAt: active.expiresAt,
      version: active.version,
    } satisfies ChainStepClaim),
    claimAggregateVersion: record?.version ?? 0,
  });
}

function bootstrapAggregateId(
  kind: BootstrapCommandKind, projectId: string,
): string {
  return aggregateIdFor(
    { kind, projectId } as Parameters<typeof aggregateIdFor>[0],
    DEFAULT_SUBJECTS[kind] ?? null,
  );
}

export function createAffordancePort(config: AffordancePortConfig): AffordancePort {
  const offer = (
    kind: string, aggregateId: string, version: number, inputSchemaVersion: string,
    commandId: string = config.mintId(),
  ): NextAllowedCommand => Object.freeze({
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandId,
    commandKind: kind as NextAllowedCommand["commandKind"],
    expectedVersion: version,
    inputSchemaVersion,
    targetAggregateId: aggregateId,
  });

  const bootstrapSteps = (
    durable: DurableLedger, offers: NextAllowedCommand[],
    claims: WorkClaimLedger, now: string,
  ): ChainStep[] => {
    const ledger = effectiveLedger(
      durable, bootstrapAggregateId("plan.propose", config.projectId));
    return BOOTSTRAP_COMMAND_KINDS.map((kind) => {
      // Both creation handlers derive the durable goal from request.commandId. The daemon
      // therefore mints and offers a fresh aggregate for each read; a prior GoalCreated row
      // never consumes either create route, and offer/commit identity stay aligned.
      if (REPEATABLE_GOAL_CREATION_KINDS.some((creationKind) => creationKind === kind)) {
        const missing = missingPrerequisites(ledger, kind);
        if (missing.length > 0) {
          return Object.freeze({
            aggregateId: null, ...claimFields(claims, kind, null, now), kind,
            missing, status: "BLOCKED" as const, version: null,
          });
        }
        // ONE mint: the `goal-` prefix mirrors `goalAggregateIdOf` in both goal writers
        // without importing them, so http stays free of the goals module while the offer
        // names the aggregate the commit will create.
        const commandId = config.mintId();
        const aggregateId = `goal-${commandId}`;
        offers.push(offer(kind, aggregateId, 0, BOOTSTRAP_SCHEMA_VERSION, commandId));
        return Object.freeze({
          aggregateId, ...claimFields(claims, kind, aggregateId, now), kind,
          missing: [], status: "READY" as const, version: 0,
        });
      }
      const aggregateId = bootstrapAggregateId(kind, config.projectId);
      if (ledger.kinds.has(kind)) {
        return Object.freeze({
          aggregateId, ...claimFields(claims, kind, aggregateId, now), kind,
          missing: [], status: "COMMITTED" as const,
          version: versionOf(ledger, aggregateId),
        });
      }
      const missing = missingPrerequisites(ledger, kind);
      if (missing.length > 0) {
        return Object.freeze({
          aggregateId: null, ...claimFields(claims, kind, null, now), kind,
          missing, status: "BLOCKED" as const, version: null,
        });
      }
      const version = versionOf(ledger, aggregateId);
      // Planning offers are emitted per durable goal below. These steps remain
      // the demo seed chain's compatibility status until R3-10b scopes the board.
      if (kind !== "plan.propose" && kind !== "approval.decide" && kind !== "goal.close") {
        offers.push(offer(kind, aggregateId, version, BOOTSTRAP_SCHEMA_VERSION));
      }
      return Object.freeze({
        aggregateId, ...claimFields(claims, kind, aggregateId, now), kind,
        missing: [], status: "READY" as const, version,
      });
    });
  };

  const readSurface = (): AffordanceSurfaceResult => {
    const offers: NextAllowedCommand[] = [];
    const now = (config.clock ?? ((): string => new Date().toISOString()))();
    const ledger = readDurableLedger(config.store, config.projectId);
    const planning = resolvePlanningOffers({ ledger, mintId: config.mintId, projectId: config.projectId });
    offers.push(...planning.offers);
    const boundGoalRef = planning.planningGoalRefs[DEFAULT_RUN_SUBJECT] ?? null;
    const claims = readWorkClaimLedger(config.store, config.projectId);
    const steps: ChainStep[] = bootstrapSteps(ledger, offers, claims, now);

    const sessions = readSessionLedger(config.store, config.projectId);
    if (sessions.unreadable) {
      // Fail closed on the whole surface: offering session commands over an
      // unreadable ledger could re-open a spent id.
      return Object.freeze({
        code: "SESSION_LEDGER_UNREADABLE",
        detail: "a committed session decision did not parse back as session facts",
        layer: AFFORDANCE_SURFACE_LAYER,
        outcome: "REFUSED",
      } as const);
    }

    const openAggregate = `session/${DEFAULT_SESSION_SUBJECT}`;
    const openExisting = sessions.sessions.get(DEFAULT_SESSION_SUBJECT);
    if (openExisting === undefined) {
      offers.push(offer("session.open", openAggregate, 0, SESSION_SCHEMA_VERSION));
      steps.push(Object.freeze({
        aggregateId: openAggregate,
        ...claimFields(claims, "session.open", openAggregate, now),
        kind: "session.open", missing: [], status: "READY" as const, version: 0,
      }));
    } else {
      steps.push(Object.freeze({
        aggregateId: openAggregate,
        ...claimFields(claims, "session.open", openAggregate, now),
        kind: "session.open", missing: [],
        status: "COMMITTED" as const, version: openExisting.version,
      }));
    }
    for (const record of sessions.sessions.values()) {
      if (record.status !== "OPEN") continue;
      const aggregateId = `session/${record.sessionId}`;
      for (const kind of ["session.close", "session.renew"] as const) {
        offers.push(offer(kind, aggregateId, record.version, SESSION_SCHEMA_VERSION));
        steps.push(Object.freeze({
          aggregateId, ...claimFields(claims, kind, aggregateId, now), kind,
          missing: [], status: "READY" as const, version: record.version,
        }));
      }
    }

    // Code nodes appear only behind a durably approved plan. Lifecycle, all
    // ledger-derived: READY (nothing submitted, or the LATEST round is a
    // verifier failure — recode), BLOCKED on "verification" (a clean round is
    // in and the daemon has not verified it yet — the verifier's queue, so a
    // coding agent is never staffed onto it), COMMITTED (accepted).
    if (config.nodes !== undefined && ledger.kinds.has("approval.decide")) {
      for (const spec of config.nodes()) {
        const review = readReviewLedger(config.store, config.projectId, spec.nodeRef);
        const claim = claimFields(claims, NODE_DELIVER_KIND, spec.nodeRef, now);
        if (review.accepted !== undefined) {
          steps.push(Object.freeze({
            aggregateId: spec.nodeRef, ...claim, kind: NODE_DELIVER_KIND,
            missing: [], status: "COMMITTED" as const, version: review.version,
          }));
          continue;
        }
        const latestRound = review.rounds[review.rounds.length - 1];
        // Aggregate versions also advance for the daemon's internal receipt,
        // so they cannot be compared with review round numbers. A clean latest
        // round remains blocked until the daemon consumes its receipt; an
        // unreadable ledger must never be staffed as writable work.
        const awaitingVerify = review.unreadable || latestRound?.routing.route === "ACCEPT";
        offers.push(offer("review.submit", spec.nodeRef, review.version, REVIEW_SCHEMA_VERSION));
        steps.push(Object.freeze({
          aggregateId: spec.nodeRef, ...claim, kind: NODE_DELIVER_KIND,
          missing: awaitingVerify ? ["verification"] : [],
          status: awaitingVerify ? ("BLOCKED" as const) : ("READY" as const),
          version: review.version,
        }));
      }
    }

    return Object.freeze({
      nextAllowedCommands: Object.freeze(offers),
      outcome: "SURFACE",
      planningGoalRefs: planning.planningGoalRefs,
      planningGoalRef: boundGoalRef,
      steps: Object.freeze(steps),
    } as const);
  };

  return Object.freeze({ boundProjectId: config.projectId, readSurface });
}
