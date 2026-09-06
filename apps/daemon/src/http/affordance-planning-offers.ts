import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";

import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import { stateOf, versionOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { PRODUCT_CONTRACT_COMPILER_SCHEMA_VERSION }
  from "../product-contract/product-contract-command-contracts.js";
import type { GoalCloseReadiness } from "../goals/goal-close-readiness.js";
import { previewAggregateId } from "../preview/preview-receipt-contracts.js";
import { releaseDossierAggregateId } from "../release/release-dossier-contracts.js";
import { designAggregateId } from "../design/design-contracts.js";
import type { CompilerLanePort } from "./affordance-compiler-lane.js";

const REVIEWABLE_LIFECYCLE = "PLAN_REVIEW";

/** Which offers also render as staffable steps, independent of their payload schema family. */
const COMPILER_OFFER_KINDS = Object.freeze([
  "design.submit", "planning.submit_decomposition", "product_contract.propose_revision",
] as const);
/** Which kinds use the compiler schema; sharing a staffing lane does not imply sharing a wire. */
const COMPILER_SCHEMA_KINDS = Object.freeze([
  "planning.submit_decomposition", "product_contract.propose_revision",
] as const);
type CompilerOfferKind = (typeof COMPILER_OFFER_KINDS)[number];

type JsonRecord = Readonly<Record<string, unknown>>;

interface DurableGoal {
  readonly goalId: string;
  readonly planningRunRef: string;
  readonly state: JsonRecord;
}

export interface PlanningOfferResolution {
  /** Compiler-lane work the WRAPPER staffs: one entry per offered compiler kind,
   *  targeted at the goal aggregate, surfaced by affordance-read as READY steps. */
  readonly compilerSteps: readonly {
    readonly aggregateId: string; readonly kind: CompilerOfferKind;
  }[];
  readonly offers: readonly NextAllowedCommand[];
  readonly planningGoalRefs: Readonly<Record<string, string>>;
}

export interface PlanningOfferInput {
  /**
   * Whether this goal's approved Product Contract has any criterion the coverage read does not
   * call VERIFIED. A FACT rather than a store handle, and LAZY: the ladder stays pure, the
   * coverage walk happens only for a goal that could actually be offered a close, and a later
   * gate (landing, say) adds its own fact here rather than reaching for the store.
   */
  readonly closeReadiness: (goalId: string) => GoalCloseReadiness["kind"];
  readonly compilerLane: CompilerLanePort;
  /**
   * A LAZY design fact, not a store handle: only an approved compiler goal needs this read.
   * The skip marker belongs to task-365e5d97; task-06ac0da1 publishes the design kind.
   */
  readonly designState: (goalId: string) => "ABSENT" | "PRESENT" | "SKIPPED";
  /**
   * The goal's CURRENT planning run, resolved from its IMMUTABLE `planningRunRef`.
   *
   * A goal carries one `planningRunRef` for life, so after a REJECT mints a REVISION successor
   * every read that starts at the goal would otherwise land on the run the operator just
   * rejected: the ladder would keep offering `approval.decide_intent` against it and would never
   * offer the compiler the successor needs. A FACT, not a store handle, for the same reason
   * `closeReadiness` and `landedCommit` are - the ladder stays pure and the chain walk is the
   * composition root's to supply.
   */
  readonly currentRun: (planningRunRef: string) => string;
  /**
   * Whether any node of this goal has been landed as a commit. A FACT and LAZY for the same
   * reasons as `closeReadiness` above: the ladder stays pure, and the goal's graph walk plus
   * the review-ledger read happen only for a goal that could actually be offered a publish.
   */
  readonly landedCommit: (goalId: string) => boolean;
  readonly ledger: DurableLedger;
  readonly mintId: (kind: string) => string;
  /**
   * Whether a preview has actually RUN for this goal, and how it ended. A FACT and LAZY for the
   * same reasons as `closeReadiness` and `landedCommit` above: the ladder stays pure, and the
   * receipt walk happens only for a goal that could actually be offered a decision.
   *
   * `null` is "no preview has ever run", NOT "it failed" — and `"REFUSED"` is a RECORD of a
   * preview that never became answerable. Both withhold the card, because an operator handed a
   * Decide control for a preview that is not serving would be judging a product that is not
   * there; only `"STARTED"` is offered.
   */
  readonly previewReceipt: (goalId: string) => "REFUSED" | "STARTED" | null;
  readonly projectId: string;
}

export function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function durableGoalMatches(
  ledger: DurableLedger,
  aggregateId: string,
  projectId: string,
  runId: string,
): boolean {
  const goal = record(stateOf(ledger, aggregateId));
  return goal?.["goalId"] === aggregateId
    && goal["planningRunRef"] === runId
    && goal["projectId"] === projectId;
}

export function planningGoalRef(
  ledger: DurableLedger,
  projectId: string,
  runId: string,
): string | null {
  const run = record(record(stateOf(ledger, runId))?.["state"]);
  const bound = run?.["goalRef"];
  if (typeof bound === "string") {
    return durableGoalMatches(ledger, bound, projectId, runId) ? bound : null;
  }
  const candidates: string[] = [];
  for (const [aggregateId] of ledger.aggregates) {
    if (durableGoalMatches(ledger, aggregateId, projectId, runId)) candidates.push(aggregateId);
  }
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

export function planReviewable(ledger: DurableLedger, runId: string): boolean {
  const run = record(record(stateOf(ledger, runId))?.["state"]);
  return run?.["lifecycle"] === REVIEWABLE_LIFECYCLE;
}

function durableGoals(ledger: DurableLedger, projectId: string): readonly DurableGoal[] {
  const goals: DurableGoal[] = [];
  for (const [aggregateId] of ledger.aggregates) {
    const state = record(stateOf(ledger, aggregateId));
    if (state?.["goalId"] !== aggregateId || state["projectId"] !== projectId) continue;
    const planningRunRef = state["planningRunRef"];
    if (typeof planningRunRef !== "string") continue;
    goals.push({ goalId: aggregateId, planningRunRef, state });
  }
  return goals.sort((left, right) => left.goalId.localeCompare(right.goalId));
}

function offer(
  input: PlanningOfferInput,
  kind: CompilerOfferKind
    | "approval.decide" | "approval.decide_intent" | "goal.close" | "plan.propose"
    | "preview.decide" | "release.decide" | "repository.publish",
  aggregateId: string,
): NextAllowedCommand {
  return Object.freeze({
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandId: input.mintId(kind),
    commandKind: kind,
    expectedVersion: versionOf(input.ledger, aggregateId),
    inputSchemaVersion: COMPILER_SCHEMA_KINDS.some((compiler) => compiler === kind)
      ? PRODUCT_CONTRACT_COMPILER_SCHEMA_VERSION
      : BOOTSTRAP_SCHEMA_VERSION,
    targetAggregateId: aggregateId,
  });
}

/**
 * What one goal answers: everything the operator is OFFERED, and the subset the WRAPPER may
 * STAFF. The two differ in exactly one place — the PRESENT-arm design resubmit — and are the
 * SAME array everywhere else. Splitting them is what keeps an operator affordance from becoming
 * agent work: `resolvePlanningOffers` fills `compilerSteps` from `staffable` alone, and
 * `affordance-read.ts` turns every compilerStep into a READY step a seat picks up.
 */
interface GoalOffers {
  readonly offers: readonly NextAllowedCommand[];
  readonly staffable: readonly NextAllowedCommand[];
}

/** The default and the answer at every site but one: what is offered is also staffable. */
function staffAll(offers: readonly NextAllowedCommand[]): GoalOffers {
  return Object.freeze({ offers, staffable: offers });
}

/** `runId` is the goal's CURRENT run, resolved once by the caller and used at every run site. */
function offersForGoal(
  input: PlanningOfferInput, goal: DurableGoal, runId: string,
): GoalOffers {
  if (!planReviewable(input.ledger, runId)) {
    // THE COMPILER LADDER. A source-bound goal is compiled, never hand-planned:
    // `plan.propose` is WITHHELD (the wrapper staffing the demo payload against
    // a real PRD is the race this closes) and the goal offers the writer until
    // Gate 1 approves a revision citing its source, the dispatcher after. Both
    // target the GOAL aggregate — the compiled chain drives the run itself. A
    // binding that fails integrity offers NOTHING (fail closed, never legacy).
    // Before dispatch, offer the design on its OWN aggregate until present or explicitly skipped.
    const facts = input.compilerLane.factsFor(goal.goalId);
    if (facts.lane === "WITHHELD") return staffAll([]);
    if (facts.lane === "COMPILER") {
      if (facts.approvedGateRef !== null) {
        // Read ONCE: the three states are exhaustive here and a second read could disagree
        // with the first if a design landed between them.
        const design = input.designState(goal.goalId);
        // ABSENT offers the design and nothing else — the goal is not ready to compile yet.
        if (design === "ABSENT") {
          return staffAll([offer(input, "design.submit", designAggregateId(goal.goalId))]);
        }
        // PRESENT offers BOTH. `design.submit` is a VERSIONED revision command
        // (design-store.ts selects a wanted version; the approve fold renders "Version 2"),
        // so a designed goal must keep an operator route to revise it — without this arm
        // nothing in production can ever produce version 2. The decomposition stays offered
        // because the goal is ALSO ready to compile; this is an addition, not a swap, and the
        // four-state MEANINGS are unchanged. SKIPPED deliberately does NOT get the design back:
        // a goal whose operator chose to skip must never be offered one again.
        if (design === "PRESENT") {
          // THE ONE PLACE THE TWO SETS DIVERGE. The resubmit is offered to the OPERATOR and
          // never staffed: `design.submit` is in COMPILER_OFFER_KINDS, so leaving it in
          // `staffable` would make affordance-read mint a READY step for it on EVERY poll and
          // the wrapper would staff a design agent onto every already-designed goal, forever.
          const decomposition = offer(input, "planning.submit_decomposition", goal.goalId);
          return Object.freeze({
            offers: Object.freeze([
              offer(input, "design.submit", designAggregateId(goal.goalId)),
              decomposition,
            ]),
            staffable: Object.freeze([decomposition]),
          });
        }
        return staffAll([offer(input, "planning.submit_decomposition", goal.goalId)]);
      }
      // A revision awaiting Gate 1 is the human's turn: nothing to staff until they decide.
      return staffAll((facts.pendingRevision ?? null) === null
        ? [offer(input, "product_contract.propose_revision", goal.goalId)]
        : []);
    }
    return staffAll([offer(input, "plan.propose", runId)]);
  }
  const lifecycle = goal.state["lifecycle"];
  if (lifecycle === "DRAFT") {
    // Both human approval wires ride the same reviewable run: `approval.decide`
    // carries the seeded approve-and-activate journey, `approval.decide_intent`
    // is the only kind the browser's plan-approval gate authorizes against.
    return staffAll([
      offer(input, "approval.decide", runId),
      offer(input, "approval.decide_intent", runId),
    ]);
  }
  // Publishing is offered only once at least one node of the goal is landed as a commit — a
  // goal with nothing to push gets no PUBLISH card. The surface used to mint one for every
  // activated goal, so an operator was handed a Publish control directly above the words "No
  // node of this goal is landed as a commit yet" (seen live on UnAI 2026-09-04). Targets the
  // goal's publish aggregate so the decision's own version fence never moves the goal's; read
  // here rather than above so the landing walk is skipped for a goal that could not publish.
  const built = lifecycle === "EXECUTION_ENABLED" || lifecycle === "CLOSING"
    || lifecycle === "COMPLETED";
  // ASKED ONCE PER GOAL PER POLL, and read by BOTH the publish and the release rungs below.
  // The fact walks the goal's graph AND the review ledger, so a second call would double that
  // walk on every surface read for every built goal — the 2026-09-05 affordances hot-path
  // incident, re-entered by a rung that merely looked like an independent gate. The `built &&`
  // short-circuit keeps the walk skipped entirely for a goal that could offer neither.
  const landed = built && input.landedCommit(goal.goalId);
  const publish = landed
    ? [offer(input, "repository.publish", `publish:${goal.goalId}`)]
    : [];
  // The product-preview verdict, offered only once a preview really STARTED for this goal — a
  // Decide card for a preview that never became answerable would ask the operator to judge a
  // product that is not serving, the same defect PUBLISH had before `landedCommit` gated it.
  // A null receipt (none ever ran) and a REFUSED one both withhold, fail closed. Targets the
  // goal's PREVIEW aggregate so the decision's own version fence never moves the goal's — the
  // same reason publish takes `publish:<goalId>`, and here it is load-bearing rather than tidy:
  // `readDurableLedger` keeps the last committed result per targetAggregateId, so a decide on
  // the goal itself would overwrite the goal's state and drop it from `durableGoals` entirely.
  // Read HERE rather than above so the receipt walk is skipped for every goal with nothing built.
  const preview = built && input.previewReceipt(goal.goalId) === "STARTED"
    ? [offer(input, "preview.decide", previewAggregateId(goal.goalId))]
    : [];
  // THE RELEASE VERDICT, GATED ON THE SAME LANDED COMMIT PUBLISH USES AND ON NOTHING ELSE.
  // The withholding rule, decided deliberately because the Release card's row depends on it:
  // WITHHOLD ONLY WHERE THERE IS NO RELEASE OBJECT. `release-decide-service.ts:182` keys the
  // receipt by the SHA, so a goal with no landed commit has nothing to decide about and the
  // card would be a control over an absent thing. PAST that point NOTHING is withheld — and
  // this is the OPPOSITE of `goal.close` below, on purpose. Close withholds because its
  // refusal tells the operator nothing they could act on. Release's refusals are the answer to
  // the operator's actual question, "why can't I release?": :160-161 answers
  // `unverified evidence for: ${criteria}` with the criterion ids themselves, :146 names the
  // unbound remote, :169 names the missing dossier and its code. Withholding here would
  // replace a precise diagnostic with an absent card, so the surface offers the decide and
  // lets the dispatch refuse RELEASE_EVIDENCE_INCOMPLETE where the operator can read it.
  // Targets the goal's RELEASE aggregate, and here the key is DICTATED rather than chosen:
  // `release-decide-command.ts:47` refuses RELEASE_TARGET_INVALID unless the target is exactly
  // `releaseDossierAggregateId(goalId)`, so this CALLS that function instead of spelling
  // `release:${goalId}` the way `publish:` is spelled above — a hand-spelled key that drifts
  // from the contract passes every grep and is refused at dispatch. It is also the same
  // load-bearing hazard preview names: `readDurableLedger` keeps the last committed result per
  // targetAggregateId, so a decide on the bare goal id would overwrite the goal's own state
  // and drop it out of `durableGoals` entirely, taking every offer for that goal with it.
  // Read HERE rather than above so the landing walk is skipped for a goal with nothing built.
  const release = landed
    ? [offer(input, "release.decide", releaseDossierAggregateId(goal.goalId))]
    : [];
  if (lifecycle === "EXECUTION_ENABLED" || lifecycle === "CLOSING") {
    // A goal is offered to close only when its product is DONE: every approved criterion of its
    // Product Contract is verified. A goal with no contract — the seed/Foundation journey — is
    // offered exactly as it always was, because this gate has nothing to say about it. An
    // unreadable coverage WITHHOLDS (fail closed): it is not evidence the work is finished, and
    // the surface must never offer a close the command would refuse. Read here rather than
    // above so the coverage walk is skipped for every goal that could not be offered one.
    const readiness = input.closeReadiness(goal.goalId);
    return staffAll(readiness === "NO_CONTRACT" || readiness === "READY"
      ? [offer(input, "goal.close", goal.goalId), ...publish, ...preview, ...release]
      : [...publish, ...preview, ...release]);
  }
  if (lifecycle === "COMPLETED") return staffAll([...publish, ...preview, ...release]);
  return staffAll([]);
}

export function resolvePlanningOffers(input: PlanningOfferInput): PlanningOfferResolution {
  const compilerSteps: { aggregateId: string; kind: CompilerOfferKind }[] = [];
  const offers: NextAllowedCommand[] = [];
  const refs: Record<string, string> = {};
  const goals = durableGoals(input.ledger, input.projectId);
  const runCounts = new Map<string, number>();
  for (const goal of goals) {
    runCounts.set(goal.planningRunRef, (runCounts.get(goal.planningRunRef) ?? 0) + 1);
  }
  for (const goal of goals) {
    if (runCounts.get(goal.planningRunRef) !== 1) continue;
    // ONE resolution per goal per surface read, used by the ladder AND by the binding below,
    // so the run an offer targets and the run the authority map binds cannot disagree.
    const current = input.currentRun(goal.planningRunRef);
    const run = record(record(stateOf(input.ledger, current))?.["state"]);
    const bound = run?.["goalRef"];
    // The RUN side of the binding moves to the current run; the GOAL side keeps the immutable
    // ref, because that is the field the goal's own durable record carries and it never moves.
    if (typeof bound === "string"
      && (bound !== goal.goalId
        || !durableGoalMatches(input.ledger, bound, input.projectId, goal.planningRunRef))) continue;
    refs[current] = goal.goalId;
    // ONE resolution, TWO reads of it: everything minted is offered, but only the STAFFABLE
    // subset can become a compiler step. Running the kind filter over every minted offer —
    // as this loop used to — is what would staff the design resubmit forever.
    const resolved = offersForGoal(input, goal, current);
    offers.push(...resolved.offers);
    for (const minted of resolved.staffable) {
      const kind = COMPILER_OFFER_KINDS.find((compiler) => compiler === minted.commandKind);
      if (kind !== undefined) {
        compilerSteps.push(Object.freeze({ aggregateId: minted.targetAggregateId, kind }));
      }
    }
  }
  return Object.freeze({
    compilerSteps: Object.freeze(compilerSteps),
    offers: Object.freeze(offers),
    planningGoalRefs: Object.freeze(refs),
  });
}
