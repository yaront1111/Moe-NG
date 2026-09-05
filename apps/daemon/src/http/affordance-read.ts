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
import { goalCloseReadinessFor } from "../goals/goal-close-readiness.js";
import type { GoalCloseReadiness } from "../goals/goal-close-readiness.js";
import { SESSION_SCHEMA_VERSION } from "../identity/session-contracts.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { REVIEW_SCHEMA_VERSION } from "../review/review-contracts.js";
import { REVIEW_ESCALATION_ROUND_LIMIT } from "@moe/review";
import { currentPlanningRun } from "../planning/current-planning-run.js";

import { createGoalLandingReader } from "../repository/goal-landing-facts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { readVerifierStandingAuthority } from "../review/verifier-authority-provider.js";
import { activeClaim, readWorkClaimLedger } from "../work/work-claim-services.js";
import type { WorkClaimLedger } from "../work/work-claim-services.js";
import { AFFORDANCE_SURFACE_LAYER, NODE_DELIVER_KIND } from "./affordance-contract.js";
import { createCompilerLanePort } from "./affordance-compiler-lane.js";
import { resolvePlanningAuthorities } from "./affordance-planning-authorities.js";
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
  /** The kind is stated so a composition root can supply deterministic fixture identities. */
  readonly mintId: (kind: string) => string;
  /**
   * Operator-authored code nodes. Read per surface call so a spec added while
   * the daemon runs appears on the next poll. Absent means no node steps —
   * never an invented one.
   */
  readonly nodes?: () => readonly NodeSpec[];
  /**
   * The daemon's configured principal, the ONLY author admitted onto planning authority material.
   * OPTIONAL because a bounded harness composition may hold none: absence yields an EMPTY
   * authority map, never the project owner, the command issuer or a DEFAULT_* stand-in.
   */
  readonly principalId?: string | undefined;
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
  kind: BootstrapCommandKind, projectId: string, planningSubject: PlanningSubject | null = null,
): string {
  if (planningSubject !== null) {
    if (kind === "plan.propose" || kind === "approval.decide") return planningSubject.runId;
    if (kind === "goal.close") return planningSubject.goalId;
    if (kind === "repository.publish") return `publish:${planningSubject.goalId}`;
  }
  return aggregateIdFor(
    { kind, projectId } as Parameters<typeof aggregateIdFor>[0],
    DEFAULT_SUBJECTS[kind] ?? null,
  );
}

interface PlanningSubject {
  readonly goalId: string;
  readonly runId: string;
}

/**
 * The legacy all-project board has room for one planning chain. It may borrow the
 * per-goal producer's identity only when that answer is unambiguous AND the same
 * surface carries a legacy planning offer for it. Two goals stay unselected, and
 * a source-bound compiler lane stays compiler-only; neither case is collapsed to
 * a global default or an arbitrary first map entry.
 */
function soleLegacyPlanningSubject(
  planningGoalRefs: Readonly<Record<string, string>>,
  offers: readonly NextAllowedCommand[],
): PlanningSubject | null {
  const entries = Object.entries(planningGoalRefs);
  if (entries.length !== 1) return null;
  const [runId, goalId] = entries[0] ?? [];
  if (runId === undefined || goalId === undefined) return null;
  const hasLegacyOffer = offers.some((entry) =>
    ((entry.commandKind === "plan.propose"
      || entry.commandKind === "approval.decide"
      || entry.commandKind === "approval.decide_intent")
      && entry.targetAggregateId === runId)
    || (entry.commandKind === "goal.close" && entry.targetAggregateId === goalId));
  return hasLegacyOffer ? Object.freeze({ goalId, runId }) : null;
}

export function createAffordancePort(config: AffordancePortConfig): AffordancePort {
  const offer = (
    kind: string, aggregateId: string, version: number, inputSchemaVersion: string,
    commandId: string = config.mintId(kind),
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
    claims: WorkClaimLedger, now: string, planningSubject: PlanningSubject | null,
  ): ChainStep[] => {
    const ledger = effectiveLedger(
      durable, bootstrapAggregateId("plan.propose", config.projectId, planningSubject));
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
        const commandId = config.mintId(kind);
        const aggregateId = `goal-${commandId}`;
        offers.push(offer(kind, aggregateId, 0, BOOTSTRAP_SCHEMA_VERSION, commandId));
        return Object.freeze({
          aggregateId, ...claimFields(claims, kind, aggregateId, now), kind,
          missing: [], status: "READY" as const, version: 0,
        });
      }
      const aggregateId = bootstrapAggregateId(kind, config.projectId, planningSubject);
      if (ledger.kinds.has(kind)) {
        // policy.install is REPEATABLE: every slice is one more install on the same
        // aggregate (the seed installs three at versions 0, 1, 2), so a committed
        // install still offers the next one at the aggregate's current version. The
        // step stays COMMITTED - the chain has its policy - only the offer continues.
        if (kind === "policy.install") {
          offers.push(offer(kind, aggregateId, versionOf(ledger, aggregateId), BOOTSTRAP_SCHEMA_VERSION));
        }
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
      if (kind !== "plan.propose" && kind !== "approval.decide" && kind !== "goal.close"
        && kind !== "repository.publish") {
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
    // ONE read of the roster per surface call. It used to be read only inside the node-step gate
    // below; the authority map needs it too, and two reads of a live directory could disagree
    // within a single answer — one roster is what makes the map and the node steps consistent.
    const nodes = config.nodes?.() ?? [];
    const ledger = readDurableLedger(config.store, config.projectId);
    const landings = createGoalLandingReader(config.store, config.projectId, ledger);
    const planning = resolvePlanningOffers({
      // Derived per call, never cached: an acceptance that lands between two polls shows up on
      // the next one. The ladder invokes this only for a goal it could offer a close.
      closeReadiness: (goalId): GoalCloseReadiness["kind"] =>
        goalCloseReadinessFor(config.store, config.projectId, goalId).kind,
      compilerLane: createCompilerLanePort({
        ledger, projectId: config.projectId, store: config.store,
      }),
      // The goal's IMMUTABLE ref resolved to the run that matters NOW. The walk is a bounded
      // per-aggregate event read (16 hops, cycle-guarded) that never throws: a corrupt chain
      // degrades to the last id it could read, so one broken goal cannot cost the whole surface.
      currentRun: (planningRunRef): string =>
        currentPlanningRun(config.store, planningRunRef).runId,
      // ONE reader for the whole poll, reusing the ledger folded just above: its graph and
      // review-ledger walks are deferred to the first publishable goal and then shared by all of
      // them, so the surface cost does not multiply by the goal count. Derived per call for the
      // same reason readiness is — a commit that lands between two polls shows up on the next.
      landedCommit: landings.hasLandedCommit,
      ledger, mintId: config.mintId, projectId: config.projectId,
    });
    offers.push(...planning.offers);
    // Derived from the SAME `planning` resolution that produced planningGoalRefs and the offers,
    // so the carried material and the binding it claims cannot disagree.
    const planningAuthorityByRun = resolvePlanningAuthorities({
      nodes,
      offers: planning.offers,
      planningGoalRefs: planning.planningGoalRefs,
      principalId: config.principalId,
    });
    const boundGoalRef = planning.planningGoalRefs[DEFAULT_RUN_SUBJECT] ?? null;
    const claims = readWorkClaimLedger(config.store, config.projectId);
    const planningSubject = soleLegacyPlanningSubject(planning.planningGoalRefs, planning.offers);
    const steps: ChainStep[] = bootstrapSteps(ledger, offers, claims, now, planningSubject);
    // Compiler-lane steps: what makes the WRAPPER staff a planning agent onto a
    // source-bound goal. READY at the goal aggregate's own version — the offer
    // above and this step share identity, so claim fencing works unchanged.
    for (const compiler of planning.compilerSteps) {
      steps.push(Object.freeze({
        aggregateId: compiler.aggregateId,
        ...claimFields(claims, compiler.kind, compiler.aggregateId, now),
        kind: compiler.kind, missing: [], status: "READY" as const,
        version: versionOf(ledger, compiler.aggregateId),
      }));
    }

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
    // EITHER approval wire: the browser's paired session approves through
    // `approval.decide_intent` (mint + activation, task-6093483c), and a goal it
    // enabled must surface its code nodes exactly as the seeded `approval.decide`
    // journey always has. Measured live: the first real project's approved goal
    // sat EXECUTION_ENABLED with zero node.deliver steps behind this gate.
    if (config.nodes !== undefined
      && (ledger.kinds.has("approval.decide") || ledger.kinds.has("approval.decide_intent"))) {
      // "verification" alone hides WHY a clean round waits. The verifier refuses
      // VERIFICATION_AUTHORITY_UNAVAILABLE to its own stdout when the project's standing
      // slices were never installed, so the board names each absent slice as a prerequisite.
      let verificationMissing: readonly string[] | null = null;
      const missingForVerification = (): readonly string[] => {
        if (verificationMissing === null) {
          const standing = readVerifierStandingAuthority(config.store, config.projectId);
          verificationMissing = Object.freeze([
            "verification",
            ...(standing.policy ? [] : ["verifier-policy"]),
            ...(standing.calibration ? [] : ["verifier-calibration"]),
          ]);
        }
        return verificationMissing;
      };
      // A node is a satisfied dependency exactly when this loop would call it
      // COMMITTED — the review ledger's acceptance record, nothing else. An
      // unresolvable producer key has no acceptance, so it blocks rather than
      // silently un-gating the node that named it.
      const acceptedByRef = new Map<string, boolean>();
      const isAccepted = (nodeRef: string): boolean => {
        const known = acceptedByRef.get(nodeRef);
        if (known !== undefined) return known;
        const accepted = readReviewLedger(config.store, config.projectId, nodeRef)
          .accepted !== undefined;
        acceptedByRef.set(nodeRef, accepted);
        return accepted;
      };
      for (const spec of nodes) {
        const review = readReviewLedger(config.store, config.projectId, spec.nodeRef);
        acceptedByRef.set(spec.nodeRef, review.accepted !== undefined);
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
        // A human answered the exhausted review with REPLAN: the node takes no further round
        // and offers nothing; its work continues under the successor plan.
        if (review.replanned) {
          steps.push(Object.freeze({
            aggregateId: spec.nodeRef, ...claim, kind: NODE_DELIVER_KIND,
            missing: ["replan"], status: "BLOCKED" as const, version: review.version,
          }));
          continue;
        }
        // Three unsuccessful rounds and no escalation decision: the review kernel refuses
        // every further round (REVIEW_ESCALATION_REQUIRED), so the node is BLOCKED on a human
        // and the only command the surface offers for it is the escalation decision itself.
        // Offering review.submit here would staff agents into a refusal loop.
        if (!review.unreadable && !review.escalated
          && review.lineage.unsuccessfulRounds >= REVIEW_ESCALATION_ROUND_LIMIT) {
          offers.push(offer("escalation.decide", spec.nodeRef, review.version, REVIEW_SCHEMA_VERSION));
          steps.push(Object.freeze({
            aggregateId: spec.nodeRef, ...claim, kind: NODE_DELIVER_KIND,
            missing: ["escalation"], status: "BLOCKED" as const, version: review.version,
          }));
          continue;
        }
        // Build order. Every dependency whose review is not accepted is named,
        // so the operator reads WHICH node is in the way rather than "blocked".
        // A dependency-blocked node is offered nothing: the wrapper staffs from
        // these offers, and one review.submit here staffs a node beside the
        // parent it is waiting on. Reported BEFORE the verification tokens —
        // a node that cannot start yet is not usefully described by its
        // verifier queue — and the other blocking reasons keep their own
        // earlier branches untouched.
        const unmet = spec.dependsOn.filter((nodeRef) => !isAccepted(nodeRef))
          .map((nodeRef) => `depends:${nodeRef}`);
        if (unmet.length === 0) {
          offers.push(offer("review.submit", spec.nodeRef, review.version, REVIEW_SCHEMA_VERSION));
        }
        const blocked = unmet.length > 0 || awaitingVerify;
        steps.push(Object.freeze({
          aggregateId: spec.nodeRef, ...claim, kind: NODE_DELIVER_KIND,
          missing: [...unmet, ...(awaitingVerify ? missingForVerification() : [])],
          status: blocked ? ("BLOCKED" as const) : ("READY" as const),
          version: review.version,
        }));
      }
    }

    return Object.freeze({
      nextAllowedCommands: Object.freeze(offers),
      outcome: "SURFACE",
      planningAuthorityByRun,
      planningGoalRefs: planning.planningGoalRefs,
      planningGoalRef: boundGoalRef,
      steps: Object.freeze(steps),
    } as const);
  };

  return Object.freeze({ boundProjectId: config.projectId, readSurface });
}
