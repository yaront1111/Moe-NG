/**
 * WHAT THE ORDINARY JOURNEY DOES NOT RECORD, AND WHY — task-c7a66b70.
 *
 * `withPolicyRiskLeg` used to drop its refused leg and tell nobody: no code, no layer, no line.
 * "No risk authority was recorded, for reason X" was indistinguishable from "the writer ran and
 * everything was fine", and task-510340a3's consumer bug sat behind a green suite for weeks
 * because of it. These arms make the omission observable and pin the shape it is observable in.
 *
 * WHY THESE ARMS AND NOT `approval-activation.test.ts`'s. That suite's `expectPolicyRiskRefusal`
 * (:211-222) calls `buildPolicyRiskLeg` a SECOND time against a hand-built input and asserts the
 * code it returns. That proves the builder's arithmetic, not that the approval that actually ran
 * omitted the record for that reason — it is green whether or not the decision path ever consulted
 * the builder. Every arm here observes what the REAL run reported, through the production sink.
 *
 * THE MEASUREMENT THAT CORRECTED THE BOARD. The row, its plan and one prior attempt all recorded
 * the journey as refusing POLICY_RISK_SUBJECT_UNAVAILABLE from an absent active graph. It refuses
 * POLICY_RISK_DECISION_REF_MISSING: `buildPolicyRiskLeg` tests `policyDecisionRef` at :63 and
 * never reaches the subject check at :72, because the approval record the production seam mints
 * carries a null `policyDecisionRef`. Three readers held the wrong cause and no gate could
 * contradict them. That is this row's own argument, so the arms assert the measured code.
 */

import { applyApprovalCommand } from "@moe/core";
import type { ApprovalDecisionRecord } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  POLICY_REF, SEALED_SUBMISSION_HASH, approvalCommand, approvalRecord,
  closeStores as closeBootstrapStores, driveThrough, envelope, evaluationInput, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { resolvePolicyFact } from "../bootstrap/policy-fact-resolver.js";
import { readPolicyRisk } from "../bootstrap/policy-risk-reader.js";
import { seedActivationGraph } from "../activation/activation-world-fixtures.js";
import { GOAL_ID, PROJECT_ID, closeStores, journeyWorld } from "../gates-journey-fixtures.js";
import { activateInitialGraph } from "./approval-activation.js";
import {
  approvableStore, closeStores as closeGraphStores, contextFor, inputFor, requestFor,
} from "./graph-activation-test-fixtures.js";
import {
  OPERATOR, approveGate1, boundWorld, committedRevision, approvePlan, submit,
} from "./plan-reject-test-fixtures.js";
import { POLICY_RISK_APPROVAL_ACTION, formatPolicyRiskOmission } from "./policy-risk-leg.js";
import type { PolicyRiskOmission } from "./policy-risk-leg.js";

const RISK_RECORD_PREFIX = "policy-risk:sha256:";
const LAYER = "DAEMON_POLICY_RISK";
const POLICY_DECISION_REF = "9".repeat(64);
/** The composition root's witness — only an operator dispatch can mint one. */
const OPERATOR_REVIEW = Object.freeze({ principalId: "principal-1" });

/** An approval that satisfies every one of the builder's five checks, so the leg BUILDS. */
function qualifyingApproval(): ApprovalDecisionRecord {
  const verdict = applyApprovalCommand(
    { ...approvalRecord(SEALED_SUBMISSION_HASH), policyDecisionRef: POLICY_DECISION_REF },
    approvalCommand(),
  );
  if (!verdict.ok) throw new Error(`fixture approval refused: ${verdict.error.code}`);
  return verdict.value;
}

/**
 * THE EIGHT AGGREGATES THE ORDINARY PLAN APPROVAL COMMITS, in order. `MAX_DECISION_LEGS` is 8,
 * so this decision is AT the store's ceiling and a ninth leg throws `STORE_LIMIT_EXCEEDED` —
 * turning a fail-OPEN approval into a hard failure on every project. Two designs have now been
 * built against the assumption that there was room here; the second discovered the ceiling four
 * steps into implementation. Arm (c) exists so the third discovers it in a test instead.
 */
const APPROVAL_LEG_AGGREGATES = Object.freeze([
  "goal-1",
  "moe-budget-ledger/1|aggregate|9:project-1|16:budget-account-1",
  "run-1",
  "planning-authority/run-1",
  "project-1-policy",
  "policy-run-evaluation:run-1",
  "active-graph-slot:project-1",
  "moe.session-authority.v1/replay/"
    + "ada2f8913ac49c11186f6dad1447538666a967d2dec449c3f269ee967eec81d5",
]);

interface CommittedLegs {
  readonly ids: readonly string[];
}

/**
 * A store that LOGS what the decision committed and calls through. Every method is bound to the
 * real target: better-sqlite3 reaches private fields through `this`, and an unbound copy makes
 * every other call throw where a total catch would quietly reclassify it.
 */
function legRecorder(store: SqliteEventStore): {
  readonly commits: CommittedLegs[]; readonly store: SqliteEventStore
} {
  const commits: CommittedLegs[] = [];
  const proxy = new Proxy(store, {
    get(target, property) {
      if (property === "commitExpectedVersionDecisionLegs") {
        return (input: { readonly legs: readonly { readonly aggregateId: string }[] }) => {
          commits.push({ ids: input.legs.map((leg) => leg.aggregateId) });
          return (target as unknown as Record<string, (value: unknown) => unknown>)[
            "commitExpectedVersionDecisionLegs"
          ]!.call(target, input);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { commits, store: proxy as SqliteEventStore };
}

/** Every line the DEFAULT sink wrote — no observer injected, which is the production shape. */
function captureDefaultSink(): { readonly lines: string[] } {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown): boolean => {
    if (typeof chunk === "string" && chunk.startsWith("policy-risk:")) lines.push(chunk.trim());
    return true;
  }) as unknown as typeof process.stderr.write);
  return { lines };
}

/** bound goal -> revision -> Gate 1 -> sealed plan, ready for the approval under test. */
function submittedRun(store: SqliteEventStore): string {
  const ref = committedRevision(store);
  approveGate1(store, ref);
  const sealed = submit(store, ref);
  if (!sealed.ok) throw new Error(`fixture submit refused: ${sealed.code} @ ${sealed.layer}`);
  return sealed.runId;
}

afterEach(() => {
  vi.restoreAllMocks();
  closeStores();
  closeBootstrapStores();
  closeGraphStores();
});

describe("the ordinary journey's omitted policy-risk authority is observable", () => {
  // (a) DoD 1. The REAL journey world, the production approval inside it, and NO observer
  // injected anywhere — so what this arm reads is what a running daemon prints.
  it("records no risk authority and says which refusal omitted it, through the default sink", () => {
    const sink = captureDefaultSink();

    const world = journeyWorld("SUBMITTED");

    expect(world.store.enumerateAggregateIdsByPrefix(RISK_RECORD_PREFIX)).toStrictEqual([]);
    // NOT "a line was printed": the CODE and the LAYER, which is the whole point of the row.
    expect(sink.lines).toContain(formatPolicyRiskOmission({
      actionKind: POLICY_RISK_APPROVAL_ACTION,
      code: "POLICY_RISK_DECISION_REF_MISSING",
      commandId: "cmd-approve-run-1",
      layer: LAYER,
      projectId: PROJECT_ID,
    }));
    expect(sink.lines.some((line) => line.includes(`POLICY_RISK_DECISION_REF_MISSING @ ${LAYER}`)))
      .toBe(true);
    // The reader's half of the same absence, so the two sides are pinned together.
    const read = readPolicyRisk(world.store, PROJECT_ID, OPERATOR, POLICY_RISK_APPROVAL_ACTION);
    expect(read).toMatchObject({ code: "POLICY_RISK_RECORD_MISSING", layer: LAYER, ok: false });
  });

  // (b) DoD 2, cause 1. The approval whose risk leg was refused still COMMITS. The reason it
  // tolerated is named, not implied.
  it("commits the approval it could not record risk for, naming the refusal it tolerated", () => {
    const sink = captureDefaultSink();
    const store = boundWorld();
    const runId = submittedRun(store);
    const goalVersionBefore = store.getAggregateVersion(GOAL_ID);

    approvePlan(store, runId);

    expect(store.getAggregateVersion(GOAL_ID)).toBeGreaterThan(goalVersionBefore);
    expect(store.enumerateAggregateIdsByPrefix(RISK_RECORD_PREFIX)).toStrictEqual([]);
    expect(sink.lines).toContain(formatPolicyRiskOmission({
      actionKind: POLICY_RISK_APPROVAL_ACTION,
      code: "POLICY_RISK_DECISION_REF_MISSING",
      commandId: `cmd-approve-${runId}`,
      layer: LAYER,
      projectId: PROJECT_ID,
    }));
  });

  // (c) THE LEG-COUNT REGRESSION ARM. The diagnosis must cost NO leg, and nothing else may take
  // the last slot either. A ninth leg throws inside the write transaction, not at compile time,
  // so only a measurement catches it.
  it("commits exactly MAX_DECISION_LEGS legs, and the named eight", () => {
    captureDefaultSink();
    const base = boundWorld();
    const runId = submittedRun(base);
    const recorder = legRecorder(base);

    approvePlan(recorder.store, runId);

    expect(recorder.commits).toHaveLength(1);
    expect(recorder.commits[0]?.ids).toStrictEqual([...APPROVAL_LEG_AGGREGATES]);
    expect(recorder.commits[0]?.ids).toHaveLength(8);
  });
});

describe("the refused risk leg never widens the decision", () => {
  // (d) THE SLOT-FENCE GUARD. The fence is taken on exactly the same inputs as before: the
  // caller now reads `risk.refusal !== null` where it read `riskLegs.length === 0`. On the
  // approval-replay path the source fences supply the slot leg instead, and the refusal must not
  // add a SECOND observation of the same aggregate.
  it("takes the active-graph-slot fence exactly once, from the source fences", () => {
    captureDefaultSink();
    const base = boundWorld();
    const runId = submittedRun(base);
    const recorder = legRecorder(base);

    approvePlan(recorder.store, runId);

    const slotObservations = (recorder.commits[0]?.ids ?? [])
      .filter((id) => id === `active-graph-slot:${PROJECT_ID}`);
    expect(slotObservations).toHaveLength(1);
    // And the risk leg itself is absent, which is what leaves room for the eight above.
    expect((recorder.commits[0]?.ids ?? []).filter((id) => id.startsWith(RISK_RECORD_PREFIX)))
      .toStrictEqual([]);
  });

  // (d) BOTH DIRECTIONS on the path that actually owns `slotFenceLegs` — `activateInitialGraph`,
  // where `approvalSourceFences` is undefined. A refused leg must still take NO fence and a built
  // one must still take exactly one. The caller now reads `risk.refusal !== null` where it read
  // `riskLegs.length === 0`; these two arms are what makes that a byte-identical swap rather than
  // an argument that it is one.
  it("omits the fence when the risk leg is refused and takes it when the leg builds", () => {
    captureDefaultSink();
    const refusedStore = approvableStore();
    seedActivationGraph(refusedStore);
    const refusedRecorder = legRecorder(refusedStore);

    const refused = activateInitialGraph(
      contextFor(refusedRecorder.store, requestFor("cmd-fence-refused")),
      inputFor(refusedRecorder.store),
    );

    expect(refused.ok, refused.ok ? "" : `${refused.code}@${String(refused.refusedBy)}`).toBe(true);
    const refusedIds = refusedRecorder.commits[0]?.ids ?? [];
    expect(refusedIds.filter((id) => id === `active-graph-slot:${PROJECT_ID}`)).toStrictEqual([]);
    expect(refusedIds.filter((id) => id.startsWith(RISK_RECORD_PREFIX))).toStrictEqual([]);

    const builtStore = approvableStore();
    seedActivationGraph(builtStore);
    const builtRecorder = legRecorder(builtStore);
    const base = inputFor(builtRecorder.store);

    const built = activateInitialGraph(
      contextFor(builtRecorder.store, requestFor("cmd-fence-built")),
      { ...base, approval: qualifyingApproval(), humanReview: OPERATOR_REVIEW },
    );

    expect(built.ok, built.ok ? "" : `${built.code}@${String(built.refusedBy)}`).toBe(true);
    const builtIds = builtRecorder.commits[0]?.ids ?? [];
    expect(builtIds.filter((id) => id === `active-graph-slot:${PROJECT_ID}`)).toHaveLength(1);
    expect(builtIds.filter((id) => id.startsWith(RISK_RECORD_PREFIX))).toHaveLength(1);
  });
});

describe("an injected observer replaces the default sink and nothing else", () => {
  // (b) DoD 2, cause 2 — a DIFFERENT refusal, so the sink is not hard-coded to one — and the
  // `HandlerContext.policyRiskOmissions` override carrying it. The activation still COMMITS.
  it("hands a second, different refusal to an injected observer and still commits", () => {
    const sink = captureDefaultSink();
    const store = approvableStore();
    seedActivationGraph(store);
    const seen: PolicyRiskOmission[] = [];
    const context = {
      ...contextFor(store, requestFor("cmd-observed-activation")),
      policyRiskOmissions: (omission: PolicyRiskOmission) => { seen.push(omission); },
    };

    // `inputFor` supplies no `humanReview` witness, so `approvedBy` is null and the FIRST check
    // in builder order refuses — a different cause than the journey's, reached by input.
    const result = activateInitialGraph(context, inputFor(store));

    expect(result.ok, result.ok ? "" : `${result.code}@${String(result.refusedBy)}`).toBe(true);
    expect(seen).toStrictEqual([{
      actionKind: POLICY_RISK_APPROVAL_ACTION,
      code: "POLICY_RISK_ACTOR_NOT_HUMAN",
      commandId: "cmd-observed-activation",
      layer: LAYER,
      projectId: PROJECT_ID,
    }]);
    expect(seen[0]?.code).not.toBe("POLICY_RISK_DECISION_REF_MISSING");
    // The override REPLACES the default sink; it does not double-report.
    expect(sink.lines).toStrictEqual([]);
    expect(store.enumerateAggregateIdsByPrefix(RISK_RECORD_PREFIX)).toStrictEqual([]);
  });

  // (f) The ABSENT case the override must never become. A `context.policyRiskOmissions?.(...)`
  // would restore the exact silence this row exists to end, and would still pass an arm that
  // only ever injects — so the same seam is driven with NO member present.
  it("reports through the default sink when no observer is supplied", () => {
    const sink = captureDefaultSink();
    const store = approvableStore();
    seedActivationGraph(store);
    const context = contextFor(store, requestFor("cmd-unobserved-activation"));
    expect("policyRiskOmissions" in context).toBe(false);

    const result = activateInitialGraph(context, inputFor(store));

    expect(result.ok, result.ok ? "" : `${result.code}@${String(result.refusedBy)}`).toBe(true);
    expect(sink.lines).toStrictEqual([formatPolicyRiskOmission({
      actionKind: POLICY_RISK_APPROVAL_ACTION,
      code: "POLICY_RISK_ACTOR_NOT_HUMAN",
      commandId: "cmd-unobserved-activation",
      layer: LAYER,
      projectId: PROJECT_ID,
    })]);
  });

  // The report must never become the block. A throwing sink propagating out of a decision that is
  // mid-commit would turn this fail-OPEN approval into a hard failure — the same inversion the leg
  // ceiling would cause, by a different door. DoD 2 forbids both, so both are pinned.
  it("commits the approval even when the observer itself throws", () => {
    captureDefaultSink();
    const store = approvableStore();
    seedActivationGraph(store);
    let called = 0;
    const context = {
      ...contextFor(store, requestFor("cmd-throwing-observer")),
      policyRiskOmissions: (): never => {
        called += 1;
        throw new Error("observer blew up");
      },
    };

    const result = activateInitialGraph(context, inputFor(store));

    expect(called).toBe(1);
    expect(result.ok, result.ok ? "" : `${result.code}@${String(result.refusedBy)}`).toBe(true);
    expect(store.enumerateAggregateIdsByPrefix(RISK_RECORD_PREFIX)).toStrictEqual([]);
  });

  it("formats one line carrying the action, project, command, code and layer", () => {
    const omission: PolicyRiskOmission = {
      actionKind: POLICY_RISK_APPROVAL_ACTION,
      code: "POLICY_RISK_SUBJECT_UNAVAILABLE",
      commandId: "cmd-observed",
      layer: LAYER,
      projectId: PROJECT_ID,
    };

    expect(formatPolicyRiskOmission(omission)).toBe(
      "policy-risk: no risk authority recorded for plan.approve on project-1"
      + " (command cmd-observed): POLICY_RISK_SUBJECT_UNAVAILABLE @ DAEMON_POLICY_RISK",
    );
  });
});

describe("the no-record state still fails closed for every remaining consumer", () => {
  // (e) DoD 3. `readPolicyRisk` has ONE production call site, `policy-fact-resolver.ts:143`
  // inside `resolvePolicyFact`; `resolvePolicyFact` has ONE, `bootstrap-policy-services.ts:173`
  // in `validatePolicy`. Automatic preview is NOT among them any more — task-510340a3 moved it
  // to `preview/preview-risk-fact.ts` and `apps/daemon/src/preview/**` holds zero calls to
  // either symbol. Both surviving surfaces are driven here.
  it("resolves the journey's absent record to an UNKNOWN, null-tier fact", () => {
    captureDefaultSink();
    const world = journeyWorld("SUBMITTED");

    const fact = resolvePolicyFact(
      world.store, PROJECT_ID, OPERATOR, POLICY_RISK_APPROVAL_ACTION,
    );

    expect(fact.tier).toBeNull();
    expect(fact.truthClass).toBe("UNKNOWN");
    expect(fact.factId.startsWith("policy-risk-unclassifiable:sha256:")).toBe(true);
  });

  it("carries that UNKNOWN into the durable policy.validate record", () => {
    const store = openStore();
    driveThrough(store, "policy.validate");

    const outcome = send(store, envelope("policy.validate", 2, {
      input: evaluationInput(POLICY_REF),
    }));

    expect(outcome.ok, outcome.ok ? "" : `${outcome.code}@${String(outcome.refusedBy)}`).toBe(true);
    const decision = store.getCommandDecision({
      commandId: "cmd-policy.validate", principalId: "principal-1", projectId: PROJECT_ID,
    });
    if (decision === null) throw new Error("policy.validate wrote no durable decision");
    const record = (JSON.parse(new TextDecoder().decode(decision.resultBytes)) as {
      readonly record: {
        readonly decision: string;
        readonly inputFacts: readonly { readonly factId: string; readonly truthClass: string }[];
        readonly reasonCodes: readonly string[];
      };
    }).record;

    // The REASON CODE, not merely that the evaluation did not allow: the absent risk record is
    // what makes the fact unclassifiable, and HOLD_UNKNOWN is what fails closed on it.
    expect(record.inputFacts).toHaveLength(1);
    expect(record.inputFacts[0]?.truthClass).toBe("UNKNOWN");
    expect(record.inputFacts[0]?.factId.startsWith("policy-risk-unclassifiable:sha256:")).toBe(true);
    expect(record.reasonCodes).toStrictEqual(["RISK_TIER_UNCLASSIFIABLE"]);
    expect(record.decision).toBe("HOLD_UNKNOWN");
  });
});
