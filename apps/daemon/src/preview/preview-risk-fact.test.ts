/**
 * THE ORDINARY PRODUCT JOURNEY MUST REACH THE AUTOMATIC PREVIEW GATE, and the gate must still
 * fail closed when the evidence it reads is absent, foreign or unverifiable.
 *
 * WHY THIS FILE EXISTS AT ALL. Gate 2 asked `readPolicyRisk` for a risk fact bound to
 * `preview.decide`, and NOTHING on the ordinary journey writes one -- measured at HEAD f6e97a6b,
 * `store.enumerateAggregateIdsByPrefix("policy-risk:sha256:")` over a completed `journeyWorld`
 * returns the EMPTY list, so both `readPolicyRisk("plan.approve")` and
 * `readPolicyRisk("preview.decide")` answer POLICY_RISK_RECORD_MISSING @ DAEMON_POLICY_RISK and
 * the gate reached RISK_TIER_UNCLASSIFIABLE on every real project. The suite was green anyway
 * because the unattended fixtures INSERTED the missing record by hand, so the gate was proven
 * against a world production never produces.
 *
 * THE HONESTY ASSERTION IS THE POINT, NOT DECORATION. Every arm that claims to drive the ordinary
 * journey CENSUSES THE STORE for policy-risk aggregates and requires zero. That census reads the
 * store's own prefix enumeration -- the same primitive `readPolicyRisk` loads records through --
 * so it sees a raw `store.commit` seed exactly as it sees a production write. An arm here cannot
 * later be "fixed" by quietly seeding a record: the seed reddens the census before it can help.
 *
 * WHY EVERY NEGATIVE PINS BOTH HALVES OF THE FACT. `assessRisk` (policy-evaluation.ts:67-71)
 * skips a fact whose truth class is not DAEMON_VERIFIED or HUMAN_APPROVED, but for a fact that
 * CLEARS that floor it takes `maxTier(fact.tier, declared.get(fact.factId))` -- so an operator
 * classification can hand a strong NULL-TIER fact a tier, and cannot rescue an UNKNOWN one.
 * UNKNOWN is therefore the only safe absence, and each negative below asserts BOTH `tier === null`
 * AND `truthClass === "UNKNOWN"` on the resolved fact, then the gate's own
 * PREVIEW_AUTO_NOT_ALLOWED @ CORE_REDUCER carrying the engine's RISK_TIER_UNCLASSIFIABLE. An arm
 * asserting only "not approved" would stay green if a second refusal layer answered first.
 */
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import type { PolicyEvaluationAuthority } from "../bootstrap/bootstrap-policy-authority-reader.js";
import { driveThrough, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { readPolicyRisk } from "../bootstrap/policy-risk-reader.js";
import { readRunPolicyEvaluation } from "../bootstrap/run-policy-selection.js";
import { readCriterionGoal } from "../criterion-evidence/criterion-goal.js";
import {
  GOAL_ID, PROJECT_ID, closeStores, journeyWorld,
} from "../gates-journey-fixtures.js";
import type { JourneyWorld } from "../gates-journey-fixtures.js";
import {
  autoPreviewDecision, installGateOptIns, resolveUnattendedPreview, startPreviewUnattended,
} from "../gates-unattended-fixtures.js";
import type { GateClassification } from "../gates-unattended-fixtures.js";
import { OPERATOR } from "../planning/plan-reject-test-fixtures.js";
import { evaluateRunPolicy } from "../planning/run-policy-evaluation.js";
import { RUN_POLICY_EVENT_TYPE, runPolicyAggregateId } from "../planning/run-policy-record.js";
import { PREVIEW_DECIDE_COMMAND_KIND } from "./preview-contracts.js";
import type { PreviewAutoDecision } from "./preview-auto-decision.js";
import {
  PREVIEW_RISK_FACT_CODES, previewRiskFactFrom, previewRunRiskFactId, resolvePreviewRiskFact,
} from "./preview-risk-fact.js";
import type { PreviewRiskFactCode } from "./preview-risk-fact.js";
import { RELEASE_DECIDE_COMMAND_KIND } from "../release/release-decide-contracts.js";

/** The store prefix `policy-risk-reader.ts:45` loads every risk record through. Spelled once. */
const POLICY_RISK_PREFIX = "policy-risk:sha256:";

/** The tier the journey's own planning run carries, measured rather than chosen: run-1's
 *  replay-verified `PolicyEvaluated` row is R1, produced by `plan.finalize`. */
const JOURNEY_RUN_TIER = "R1";

afterEach(() => { closeStores(); });

/**
 * THE ORDINARY JOURNEY WITH THE OPERATOR'S STANDING OPT-INS IN FORCE, AND NOTHING ELSE.
 *
 * `journeyWorld` is the production journey and `installGateOptIns` goes through the production
 * `policy.install` command. NO risk record is inserted and NO active graph revision is
 * fabricated: that absence is exactly what this file is for, so it is asserted, not trusted.
 */
function armBothGates(
  world: JourneyWorld, classifications: readonly GateClassification[] = [],
): JourneyWorld {
  installGateOptIns(world, [
    { action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" },
    { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" },
  ], classifications);
  return world;
}

function ordinaryWorld(classifications: readonly GateClassification[] = []): JourneyWorld {
  return armBothGates(journeyWorld("SUBMITTED"), classifications);
}

/** Zero policy-risk aggregates in the store, read through the store's own enumeration. Called by
 *  every arm: it is what makes "no hand-inserted record" a measurement instead of a claim. */
function censusNoRiskRecord(world: JourneyWorld): void {
  expect(world.store.enumerateAggregateIdsByPrefix(POLICY_RISK_PREFIX)).toEqual([]);
  const read = readPolicyRisk(world.store, PROJECT_ID, OPERATOR, PREVIEW_DECIDE_COMMAND_KIND);
  expect(read.ok).toBe(false);
  expect(read.tier).toBeNull();
  expect(read.truthClass).toBe("UNKNOWN");
}

/** An approval, or a failure naming the code, the layer and the engine's reason codes -- so a
 *  red here says WHICH condition answered instead of "expected true, got false". */
function approved(decision: PreviewAutoDecision): { readonly action: string; readonly tier: string } {
  if (!decision.ok) {
    throw new Error(`expected an automatic preview approval, got ${decision.code} @ `
      + `${decision.layer} reasonCodes=${JSON.stringify(decision.reasonCodes)}`);
  }
  return decision.provenance;
}

describe("the ORDINARY journey reaches an automatic preview decision", () => {
  it("auto-approves through production handlers only, with ZERO risk records in the store", async () => {
    const world = ordinaryWorld();
    // THE HONESTY HALF, before anything is decided: the journey wrote no risk record and this
    // arm inserts none, so whatever grounds the tier below came from the journey itself.
    censusNoRiskRecord(world);

    // THE COMPOSITION'S OWN ANSWER FIRST, so a declination names its condition rather than
    // vanishing -- and BEFORE the start handler, because once that commits, the precedence gate
    // answers PREVIEW_AUTO_ALREADY_DECIDED and would mask what this arm is about.
    expect(approved(resolveUnattendedPreview(world)))
      .toEqual({ action: PREVIEW_DECIDE_COMMAND_KIND, tier: JOURNEY_RUN_TIER });

    const receiptId = await startPreviewUnattended(world);

    // AND THE COMMITTED RECORD, through the production reader under the automatic command id.
    const record = autoPreviewDecision(world, receiptId);
    if (record === null) throw new Error("the production start handler committed no decision");
    expect(record.decision).toBe("APPROVE");
    // A verdict-only assertion would pass against a human approval; the provenance is what makes
    // this an AUTOMATIC decision naming the tier it acted at.
    expect(record.provenance)
      .toEqual({ action: PREVIEW_DECIDE_COMMAND_KIND, tier: JOURNEY_RUN_TIER });
    expect(record.goalId).toBe(GOAL_ID);

    // STILL zero after the decision: the gate resolved its tier without writing a risk record.
    expect(world.store.enumerateAggregateIdsByPrefix(POLICY_RISK_PREFIX)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// THE FAIL-CLOSED NEGATIVES.
//
// WHAT IS AND IS NOT CONSTRUCTIBLE, measured rather than assumed. The goal's run aggregate
// already carries the honest row its own finalize leg filed, so ANY row added to it makes the
// selector answer RUN_POLICY_SELECTION_AMBIGUOUS before either pin is reached -- a world where
// that aggregate holds exactly ONE adverse row is not constructible. The two pins are therefore
// driven against `previewRiskFactFrom`, the PRODUCTION pin function, over a REAL evaluation built
// by the production `evaluateRunPolicy` and read back through the strict reader, with exactly one
// operand varied per arm. Nothing below reimplements a pin: every arm calls production.
// ---------------------------------------------------------------------------------------------

const FOREIGN_DIGEST = "f".repeat(64);
const SECOND_DIGEST = "e".repeat(64);
const FIXTURE_AT = "2026-09-10T08:00:00.000Z";
const EVALUATION_PRINCIPAL = "principal-1";

type Resolved = ReturnType<typeof previewRiskFactFrom>;

/** The refusal the gate must answer with when its fact is withheld, in full. */
function refusedByCore(decision: PreviewAutoDecision): void {
  if (decision.ok) throw new Error("the gate approved on a withheld risk fact");
  expect(decision.code).toBe("PREVIEW_AUTO_NOT_ALLOWED");
  expect(decision.layer).toBe("CORE_REDUCER");
  expect(decision.reasonCodes).toContain("RISK_TIER_UNCLASSIFIABLE");
}

/** Both halves of a withheld fact, and the code naming WHICH pin withheld it. */
function withheldWith(resolved: Resolved, code: PreviewRiskFactCode): void {
  expect(resolved.code).toBe(code);
  // BOTH, always. A strong null-tier fact is one the operator's `riskClassifications` overlay can
  // hand a tier (assessRisk:68); only UNKNOWN is skipped outright, so only UNKNOWN is safe.
  expect(resolved.fact.tier).toBeNull();
  expect(resolved.fact.truthClass).toBe("UNKNOWN");
}

/** This goal's own verified evaluation and the binding digest it must match. */
function journeyEvidence(world: JourneyWorld): {
  readonly evaluation: PolicyEvaluationAuthority;
  readonly graphContentHash: string;
  readonly runId: string;
} {
  const goal = readCriterionGoal(world.store, PROJECT_ID, GOAL_ID);
  if (!goal.ok) throw new Error(`the journey goal is unreadable: ${goal.code}`);
  const runId = goal.graph.planningRunRef;
  if (runId === undefined || runId === "") {
    throw new Error("the journey goal carries no planning run");
  }
  const selected = readRunPolicyEvaluation(world.store, { projectId: PROJECT_ID, runId });
  if (!selected.ok) throw new Error(`the journey run has no evaluation: ${selected.code}`);
  return { evaluation: selected.evaluation, graphContentHash: goal.binding.graphContentHash, runId };
}

/** Files `bytes` on `aggregateId` through the store's own decision seam, the way the production
 *  finalize leg does -- run-policy-selection.test.ts:81-103 is the same fixture. */
function fileRow(
  world: JourneyWorld, aggregateId: string, eventId: string, payload: string,
): void {
  const encoder = new TextEncoder();
  const response = world.store.commitExpectedVersionDecisionLegs({
    commandKind: "plan.finalize",
    committedResultBytes: encoder.encode("{}"),
    correlationId: `correlation-${eventId}`,
    decidedAt: FIXTURE_AT,
    key: { commandId: `command-${eventId}`, principalId: OPERATOR, projectId: PROJECT_ID },
    legs: [{
      aggregateId,
      events: [{ eventId, eventType: RUN_POLICY_EVENT_TYPE, payload: encoder.encode(payload) }],
      expectedVersion: world.store.getAggregateVersion(aggregateId),
    }],
    requestBytes: encoder.encode("plan.finalize/v1"),
  });
  // The decision's own result code, not truthiness: a fence conflict returns NO_BUSINESS_EFFECT
  // and an arm built on a silent no-op would assert against the untouched aggregate.
  if (response.decision.resultCode !== "EFFECTS_COMMITTED") {
    throw new Error(`the fixture commit refused: ${response.decision.resultCode}`);
  }
}

/** A store with no journey at all, so the goal has no compiled contract binding to read. */
function unboundStore(): ReturnType<typeof openStore> {
  const store = openStore();
  driveThrough(store, "goal.close");
  return store;
}

/**
 * The ordinary world plus a SECOND, fully replay-valid evaluation for a FOREIGN run, filed on
 * THIS goal's run aggregate. A DIVERGENCE fixture, not a corruption one.
 *
 * THE FOREIGN ROW IS BUILT BEFORE THE OPT-INS ARE INSTALLED, and that ORDER IS LOAD-BEARING.
 * `evaluateRunPolicy` re-derives a tier under whichever slice
 * `captureStableRunPolicySelection` picks, and the gate's opt-in slice declares no
 * `riskClassifications` -- so evaluating after installing it refuses
 * RUN_POLICY_UNCLASSIFIABLE and there is no honest foreign row to file at all. Measured: that is
 * exactly how this fixture failed on the first attempt.
 */
function foreignRunWorld(): { readonly foreignRunId: string; readonly world: JourneyWorld } {
  const world = journeyWorld("SUBMITTED");
  const { graphContentHash, runId } = journeyEvidence(world);
  const foreignRunId = `${runId}-foreign`;
  const evaluated = evaluateRunPolicy(
    world.store, readDurableLedger(world.store, PROJECT_ID),
    {
      decidedAt: FIXTURE_AT, graphContentHash, principalId: EVALUATION_PRINCIPAL,
      projectId: PROJECT_ID, runId: foreignRunId,
    },
  );
  if (!evaluated.ok) throw new Error(`the foreign evaluation refused ${evaluated.code}`);
  const bytes = JSON.stringify(evaluated.payload);
  // THE SAME BYTES ON BOTH ADDRESSES. On THIS goal's run aggregate they are the divergent second
  // row the selector must refuse; on the foreign run's OWN aggregate they read back VERIFIED,
  // which is the proof that the refusal is the uniqueness/linkage rule and not a corrupt payload.
  fileRow(world, runPolicyAggregateId(runId), `${foreignRunId}-diverged`, bytes);
  fileRow(world, runPolicyAggregateId(foreignRunId), `${foreignRunId}-own`, bytes);
  armBothGates(world);
  return { foreignRunId, world };
}

describe("the pins hold, and each is the only mechanism that answers its own arm", () => {
  it("positive control: this goal's own verified evaluation publishes DAEMON_VERIFIED at R1", () => {
    const { evaluation, graphContentHash, runId } = journeyEvidence(ordinaryWorld());
    // The MEASURED shape of the production row, so a change to the writer reddens here first.
    expect(evaluation.action).toBe("plan.finalize");
    expect(evaluation.graphNodeRevisionRefs).toEqual([graphContentHash]);

    const resolved = previewRiskFactFrom(evaluation, graphContentHash, PROJECT_ID, GOAL_ID);
    expect(resolved.code).toBeNull();
    expect(resolved.fact).toEqual({
      factId: previewRunRiskFactId(runId), tier: JOURNEY_RUN_TIER, truthClass: "DAEMON_VERIFIED",
    });
  });

  it("withholds when the PRODUCER ACTION is not plan.finalize", () => {
    const { evaluation, graphContentHash } = journeyEvidence(ordinaryWorld());
    // `plan.approve` specifically: the action the risk ledger's OTHER writer uses
    // (policy-risk-leg.ts:17), so this is the exact confusion a future writer would make.
    withheldWith(
      previewRiskFactFrom(
        { ...evaluation, action: "plan.approve" }, graphContentHash, PROJECT_ID, GOAL_ID,
      ),
      "PREVIEW_RISK_PRODUCER_ACTION_FOREIGN",
    );
  });

  it("withholds when the evaluation's graph digest is not the goal binding's", () => {
    const { evaluation, graphContentHash } = journeyEvidence(ordinaryWorld());
    expect(FOREIGN_DIGEST).not.toBe(graphContentHash);
    withheldWith(
      previewRiskFactFrom(evaluation, FOREIGN_DIGEST, PROJECT_ID, GOAL_ID),
      "PREVIEW_RISK_GRAPH_BINDING_MISMATCH",
    );
  });

  it("withholds when the evaluation names MORE THAN ONE graph revision", () => {
    const { evaluation, graphContentHash } = journeyEvidence(ordinaryWorld());
    // EXACT SINGLE, not "contains": a row naming this subject alongside another has assessed a
    // union the goal never bound, and `buildRunPolicyRow:152` writes exactly one ref.
    withheldWith(
      previewRiskFactFrom(
        { ...evaluation, graphNodeRevisionRefs: [graphContentHash, SECOND_DIGEST] },
        graphContentHash, PROJECT_ID, GOAL_ID,
      ),
      "PREVIEW_RISK_GRAPH_BINDING_MISMATCH",
    );
  });

  it("withholds when a verified evaluation carries NO tier", () => {
    const { evaluation, graphContentHash } = journeyEvidence(ordinaryWorld());
    withheldWith(
      previewRiskFactFrom({ ...evaluation, riskTier: null }, graphContentHash, PROJECT_ID, GOAL_ID),
      "PREVIEW_RISK_TIER_ABSENT",
    );
  });

  /**
   * EVERY WITHHELD CODE, IN BOTH DIRECTIONS, so a code added later cannot publish a tier and a
   * code retired later cannot leave the roster advertising a refusal nothing reaches. Each case
   * is driven through the ONE production surface that can return it; `withheld` is module-private
   * so no case can fabricate the shape it is asserting.
   */
  it("every reachable withheld code yields a fact that is BOTH null-tier and UNKNOWN", () => {
    const { evaluation, graphContentHash } = journeyEvidence(ordinaryWorld());
    const cases: readonly Resolved[] = [
      resolvePreviewRiskFact(unboundStore(), PROJECT_ID, GOAL_ID),
      resolvePreviewRiskFact(foreignRunWorld().world.store, PROJECT_ID, GOAL_ID),
      previewRiskFactFrom(
        { ...evaluation, action: "plan.approve" }, graphContentHash, PROJECT_ID, GOAL_ID,
      ),
      previewRiskFactFrom(evaluation, FOREIGN_DIGEST, PROJECT_ID, GOAL_ID),
      previewRiskFactFrom({ ...evaluation, riskTier: null }, graphContentHash, PROJECT_ID, GOAL_ID),
    ];
    const reached = new Set<PreviewRiskFactCode>();
    for (const resolved of cases) {
      if (resolved.code === null) throw new Error("an adverse case published a verified fact");
      expect(resolved.fact.tier).toBeNull();
      expect(resolved.fact.truthClass).toBe("UNKNOWN");
      reached.add(resolved.code);
    }
    // THE SWEEP ACTUALLY SWEPT. A generated set that silently yielded nothing would pass the
    // "every one is UNKNOWN" loop above vacuously, so the count is asserted against the cases.
    expect(cases.length).toBe(5);
    expect([...reached].sort()).toEqual([
      "PREVIEW_RISK_GOAL_UNREADABLE",
      "PREVIEW_RISK_GRAPH_BINDING_MISMATCH",
      "PREVIEW_RISK_PRODUCER_ACTION_FOREIGN",
      "PREVIEW_RISK_RUN_EVALUATION_UNAVAILABLE",
      "PREVIEW_RISK_TIER_ABSENT",
    ]);
    // Direction 2: the advertised roster holds exactly those five, plus the two this sweep does
    // not build a world for. EVIDENCE_UNREADABLE has its own arm below (a throwing store), and
    // RUN_UNBOUND is a structural guard no reachable world produces -- `readCriterionGoal`
    // refuses (GOAL_ABSENT, GOAL_UNBOUND, GOAL_CANCELLED or UNREADABLE) before a goal with an
    // absent planning run can be returned, so it protects against that reader changing rather
    // than being a dead entry.
    expect([...PREVIEW_RISK_FACT_CODES].filter((code) => !reached.has(code)))
      .toEqual(["PREVIEW_RISK_EVIDENCE_UNREADABLE", "PREVIEW_RISK_RUN_UNBOUND"]);
  });
});

describe("the gate still refuses RISK_TIER_UNCLASSIFIABLE when the evidence is not there", () => {
  it("no readable goal at all: the fact is withheld, with no tier and no strong truth", () => {
    withheldWith(
      resolvePreviewRiskFact(unboundStore(), PROJECT_ID, GOAL_ID),
      "PREVIEW_RISK_GOAL_UNREADABLE",
    );
  });

  it("a FOREIGN run's evaluation filed on this goal's run aggregate", () => {
    const { foreignRunId, world } = foreignRunWorld();
    const goal = readCriterionGoal(world.store, PROJECT_ID, GOAL_ID);
    if (!goal.ok) throw new Error(`the journey goal is unreadable: ${goal.code}`);
    const runId = goal.graph.planningRunRef as string;

    // THE WORLD THIS ARM MEANT TO BUILD, asserted rather than assumed: the selector answers
    // AMBIGUOUS with its own layer, and the foreign row is INTERNALLY HONEST -- it reads back
    // VERIFIED on its own aggregate. So the refusal is the uniqueness/linkage rule, never a
    // corrupt payload, which is what makes this a divergence fixture.
    const selected = readRunPolicyEvaluation(world.store, { projectId: PROJECT_ID, runId });
    if (selected.ok) throw new Error("the fixture filed no second row");
    expect(selected.code).toBe("RUN_POLICY_SELECTION_AMBIGUOUS");
    expect(selected.layer).toBe("DAEMON_RUN_POLICY_SELECTION");
    expect(readRunPolicyEvaluation(
      world.store, { projectId: PROJECT_ID, runId: foreignRunId },
    ).ok).toBe(true);

    withheldWith(
      resolvePreviewRiskFact(world.store, PROJECT_ID, GOAL_ID),
      "PREVIEW_RISK_RUN_EVALUATION_UNAVAILABLE",
    );
    expect(world.store.enumerateAggregateIdsByPrefix(POLICY_RISK_PREFIX)).toEqual([]);
    refusedByCore(resolveUnattendedPreview(world));
  });

  it("a CORRUPT evaluation row on this goal's run aggregate", () => {
    const world = ordinaryWorld();
    const { runId } = journeyEvidence(world);
    fileRow(world, runPolicyAggregateId(runId), `${runId}-corrupt`, "{not json");
    withheldWith(
      resolvePreviewRiskFact(world.store, PROJECT_ID, GOAL_ID),
      "PREVIEW_RISK_RUN_EVALUATION_UNAVAILABLE",
    );
    refusedByCore(resolveUnattendedPreview(world));
  });

  /**
   * THE SELECTOR'S OTHER REFUSALS TAKE THE IDENTICAL `!selected.ok` FOLD, and this arm proves the
   * selector actually produces them rather than asserting that it would. ABSENT and ROW_UNREADABLE
   * are unreachable on a journey world -- the honest row is already filed, so an addition is
   * AMBIGUOUS -- and are driven here over runs the journey never had.
   * `run-policy-selection.test.ts` owns pinning all five codes against their worlds.
   */
  /**
   * A THROW IS AN ABSENCE, NOT AN ESCAPE, AND THE CONTAINMENT IS LAYERED. Both halves matter
   * because `preview-start-command.ts:207` calls the gate OUTSIDE the `try` at :209: an
   * uncontained throw would fail the operator's `preview.start` rather than leave the gate pending
   * for a human. The path this row replaced (`resolvePolicyFact` -> `readPolicyRisk`) guarded
   * every store read itself, so this is exposure the row had to not introduce.
   *
   * MEASURED, and it is why the arm has two halves rather than one: a store whose `readEvents`
   * THROWS is already contained UPSTREAM, by `run-policy-selection.ts:90-98`, and surfaces as the
   * ordinary RUN_EVALUATION_UNAVAILABLE. What is NOT guarded there is everything the selector does
   * after that read, so the resolver's own backstop is reached by a row the store hands back
   * whose bytes cannot be touched at all.
   *
   * EACH STUB IS BOUND TO THE REAL STORE. Handing a method back unbound makes it run with the
   * PROXY as `this`, which throws on better-sqlite3's private fields -- `readCriterionGoal`'s own
   * catch swallows that and the arm silently becomes a GOAL_UNREADABLE test. Measured: that is
   * exactly how this failed first.
   */
  function storeWithRunEvents(
    real: JourneyWorld["store"], runEvents: (aggregateId: string) => unknown,
  ): JourneyWorld["store"] {
    return new Proxy(real, {
      get(target, property): unknown {
        if (property === "readEvents") {
          return (aggregateId: string): unknown => aggregateId
            .startsWith("policy-run-evaluation:")
            ? runEvents(aggregateId)
            : real.readEvents(aggregateId);
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as JourneyWorld["store"];
  }

  it("contains a throwing evidence read, and an unreadable row, as UNKNOWN either way", () => {
    const real = ordinaryWorld().store;
    // THE POSITIVE CONTROL, on the SAME world through the real store: it publishes. So each
    // withholding below is the stub and not the world.
    expect(resolvePreviewRiskFact(real, PROJECT_ID, GOAL_ID).code).toBeNull();

    // HALF 1 -- the read itself throws. Contained by the SELECTOR's guard, which turns the empty
    // result into ABSENT, so it arrives as the ordinary unavailable fold rather than a crash.
    const throwingRead = storeWithRunEvents(real, () => {
      throw new Error("the evidence store is unreadable");
    });
    withheldWith(
      resolvePreviewRiskFact(throwingRead, PROJECT_ID, GOAL_ID),
      "PREVIEW_RISK_RUN_EVALUATION_UNAVAILABLE",
    );

    // HALF 2 -- the read SUCCEEDS and hands back a row whose bytes cannot be touched. That is
    // past the selector's guard, so only this resolver's own backstop can answer it.
    const unreadableRow = storeWithRunEvents(real, (aggregateId) => [{
      aggregateId,
      committedAt: FIXTURE_AT,
      eventId: `${aggregateId}-hostile`,
      eventType: RUN_POLICY_EVENT_TYPE,
      get payload(): never { throw new Error("the row's bytes cannot be read"); },
    }]);
    withheldWith(
      resolvePreviewRiskFact(unreadableRow, PROJECT_ID, GOAL_ID),
      "PREVIEW_RISK_EVIDENCE_UNREADABLE",
    );
  });

  it("the selector's ABSENT and ROW_UNREADABLE are refusals the fold catches", () => {
    const world = ordinaryWorld();
    const absent = readRunPolicyEvaluation(
      world.store, { projectId: PROJECT_ID, runId: "run-never-evaluated" },
    );
    if (absent.ok) throw new Error("an unevaluated run answered verified");
    expect(absent.code).toBe("RUN_POLICY_SELECTION_ABSENT");
    expect(absent.layer).toBe("DAEMON_RUN_POLICY_SELECTION");

    fileRow(
      world, runPolicyAggregateId("run-corrupt-only"), "run-corrupt-only-row", "{not json",
    );
    const unreadable = readRunPolicyEvaluation(
      world.store, { projectId: PROJECT_ID, runId: "run-corrupt-only" },
    );
    if (unreadable.ok) throw new Error("a corrupt row answered verified");
    expect(unreadable.code).toBe("RUN_POLICY_SELECTION_ROW_UNREADABLE");
    expect(unreadable.layer).toBe("DAEMON_RUN_POLICY_SELECTION");
  });

  /**
   * PER-ACTION OPERATOR CONTROL, WHICH MOVING THE FACT MUST NOT HAVE WIDENED. The run's tier is
   * evidence about the SUBJECT; the opt-in is the operator's authority PER ACTION. An operator who
   * opted in to `plan.approve` -- and to the release gate -- but NOT to `preview.decide` still
   * gets no automatic preview, and the ENGINE is what says so.
   */
  it("an operator opted in to plan.approve but NOT preview.decide gets no automatic preview", () => {
    const world = journeyWorld("SUBMITTED");
    installGateOptIns(world, [
      { action: "plan.approve", tier: "R1" },
      { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" },
    ]);
    const decision = resolveUnattendedPreview(world);
    if (decision.ok) throw new Error("an unrelated opt-in auto-approved the preview gate");
    expect(decision.code).toBe("PREVIEW_AUTO_NOT_ALLOWED");
    expect(decision.layer).toBe("CORE_REDUCER");
    // The ENGINE's own reason, and specifically NOT unclassifiable: the tier resolved fine, the
    // AUTHORITY did not. That distinction is the whole point of keeping preview.decide the key.
    expect(decision.reasonCodes).toContain("AUTO_APPROVAL_NOT_OPTED_IN");
    expect(decision.reasonCodes).not.toContain("RISK_TIER_UNCLASSIFIABLE");
  });
});
