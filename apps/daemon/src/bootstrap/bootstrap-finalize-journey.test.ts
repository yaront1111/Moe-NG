/**
 * The SHIPPED planning journey's finalize routing.
 *
 * Before this row the seeded journey ran [create_draft, ready, claim, plan.propose] and then
 * dispatched `approval.decide` directly, so every shipped world reached approval at lifecycle
 * SUBMISSION_DRAINING with `graphRevisionRef` null. Lifecycle PLAN_REVIEW and that ref are
 * written by ONE production writer — core's `finalize` fold — in a single `clonedState` call,
 * so nothing but a real `planning.finalize_submission` can produce them.
 *
 * The finalize terminal does NOT append to `planningChain()`: `classifyPlanningChain` refuses a
 * chain holding both terminals with PLANNING_FINALIZE_CHAIN_MIXED, deliberately. It therefore
 * rides a SECOND `plan.propose` request whose chain holds only the finalize command, issued
 * between the existing propose and `approval.decide`.
 *
 * `FINALIZE_COMMAND_KIND` is imported rather than restated: the literal already exists as four
 * unexported copies across the seam, and a fifth private copy would be one more thing a rename
 * could silently desynchronize.
 */
import type { SqliteEventStore } from "@moe/store";
import { describe, expect, it, afterEach } from "vitest";

import {
  seedActivationWorldWithoutGoal,
  seedActivationWorldWithoutGraph,
} from "../activation/activation-world-fixtures.js";
import type { DemoSeedInput, SeedCommand } from "../orchestrator/demo-seed-plan.js";
import { buildDemoSeedPlan } from "../orchestrator/demo-seed-plan.js";
import { PLANNING_AUTHORITY_ENVELOPE_EVENT_TYPE } from "../planning/planning-authority-finalize.js";
import { FINALIZE_COMMAND_KIND } from "../planning/planning-authority-finalize-ingress.js";
import { planningAuthorityAggregateId } from "../planning/planning-authority-persistence.js";
import { readDurableLedger } from "./bootstrap-ledger.js";
import {
  driveTo,
  finalizeRequestIndex,
  legacyProposedStore,
  proposedNotFinalizedStore,
} from "./bootstrap-journey-fixtures.js";
import type { Envelope } from "./bootstrap-test-fixtures.js";
import {
  AUTHORITY_MEMBER,
  PROJECT_ID,
  RUN_ID,
  bootstrapSequence,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  planningChain,
  send,
} from "./bootstrap-test-fixtures.js";

const APPROVAL_KIND = "approval.decide";

/**
 * The bodies event type. The ENVELOPE half is imported above because
 * `planning-authority-finalize.ts:48` exports it; this one is a fifth private copy only because
 * no site exports it. The literal lives UNEXPORTED at four places today —
 * `planning-authority-persistence.ts:38` (the writer), and the private copies in
 * `planning-authority-finalize.test.ts:47`, `planning-authority-persistence.test.ts:52` and
 * here. A rename at the writer silently nulls every selector keyed on the string and presents
 * as "the journey carried no authority", so consolidating the constant is filed for the seam's
 * owner (out of this row's scope under taskRail 1) rather than done here.
 */
const BODIES_EVENT_TYPE = "PlanningAuthorityBodiesSealed";

const decoder = new TextDecoder();

const NODE = Object.freeze({
  instructions: "Land the shipped finalize routing.",
  nodeRef: "node-demo",
  test: "pnpm --filter @moe/daemon test",
  title: "Demo node",
  workspace: "workspace-demo",
});

/**
 * A shape-valid STAND-IN for the decide-time budget commitment, used only by arms that read
 * the plan's SHAPE. The real value is `budgetCommitmentDigest(budgetCommitmentMaterial(...))`
 * over durable state, which does not exist for a plan nobody has driven; the arms that DO
 * drive one derive theirs from the seeded store through the production builder. Deliberately
 * not `hex64("bb")` — that spelling is the defect this row retired.
 */
const PLANNED_BUDGET_REF = "7".repeat(64);

const DEMO_INPUT: DemoSeedInput = Object.freeze({
  budgetRef: PLANNED_BUDGET_REF,
  correlationId: "corr-demo",
  decidedAt: "2026-08-18T00:00:00.000Z",
  goalId: "goal-demo",
  node: NODE,
  principalId: "principal-demo",
  projectId: "project-demo",
  runId: "run-demo",
});

afterEach(() => {
  closeStores();
});

/** A plain own-property read: no getter runs and a hostile prototype contributes nothing. */
const own = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

/** The kind of the LAST element of a request's planning chain — the terminal the seam reads. */
function chainTerminalKind(payload: unknown): string | null {
  const commands = own(payload, "commands");
  if (!Array.isArray(commands) || commands.length === 0) return null;
  const kind = own(commands[commands.length - 1], "kind");
  return typeof kind === "string" ? kind : null;
}

interface Routed {
  readonly approvalAt: number;
  readonly finalizeAt: number;
}

/** Where each builder puts its finalize terminal relative to the approval it must precede. */
function routedTerminals(
  kinds: readonly string[], payloads: readonly unknown[],
): Routed {
  return {
    approvalAt: kinds.indexOf(APPROVAL_KIND),
    finalizeAt: payloads.findIndex(
      (payload) => chainTerminalKind(payload) === FINALIZE_COMMAND_KIND,
    ),
  };
}

/**
 * The expected `graphRevisionRef` is READ OUT OF THE BUILDER's seal input, never restated here:
 * two hand-authored operands agreeing would prove only that this file agrees with itself.
 */
function sealedGraphRevisionRef(payloads: readonly unknown[]): string {
  for (const payload of payloads) {
    if (chainTerminalKind(payload) !== FINALIZE_COMMAND_KIND) continue;
    const commands = own(payload, "commands");
    if (!Array.isArray(commands)) continue;
    const ref = own(own(commands[commands.length - 1], "revision"), "graphRevisionRef");
    if (typeof ref === "string" && ref.length > 0) return ref;
  }
  throw new Error("no finalize terminal carries a graphRevisionRef seal");
}

const sequencePayloads = (requests: readonly Envelope[]): readonly unknown[] =>
  requests.map((request) => request.payload);

const planPayloads = (plan: readonly SeedCommand[]): readonly unknown[] =>
  plan.map((command) => command.payload);

/**
 * Epic rail 6's vacuity guard. Each builder is asserted SEPARATELY: a harness-only edit would
 * leave the shipped journey never reaching PLAN_REVIEW while a single combined assertion went
 * green, which is precisely the state task-2cc6c59d blocked on.
 */
describe("the finalize terminal is routed by BOTH shipped builders", () => {
  it("bootstrapSequence issues a finalize terminal before approval.decide", () => {
    const requests = bootstrapSequence();
    const { approvalAt, finalizeAt } = routedTerminals(
      requests.map((request) => request.kind), sequencePayloads(requests),
    );
    expect(finalizeAt).toBeGreaterThanOrEqual(0);
    expect(approvalAt).toBeGreaterThanOrEqual(0);
    expect(finalizeAt).toBeLessThan(approvalAt);
  });

  it("buildDemoSeedPlan issues a finalize terminal before approval.decide", () => {
    const plan = buildDemoSeedPlan(DEMO_INPUT);
    const { approvalAt, finalizeAt } = routedTerminals(
      plan.map((command) => command.commandKind), planPayloads(plan),
    );
    expect(finalizeAt).toBeGreaterThanOrEqual(0);
    expect(approvalAt).toBeGreaterThanOrEqual(0);
    expect(finalizeAt).toBeLessThan(approvalAt);
  });

  it("neither builder mixes the two terminals inside one chain", () => {
    const mixed = (payload: unknown): boolean => {
      const commands = own(payload, "commands");
      if (!Array.isArray(commands)) return false;
      const kinds = commands.map((entry) => own(entry, "kind"));
      return kinds.includes(FINALIZE_COMMAND_KIND) && kinds.includes("plan.propose");
    };
    expect(sequencePayloads(bootstrapSequence()).some(mixed)).toBe(false);
    expect(planPayloads(buildDemoSeedPlan(DEMO_INPUT)).some(mixed)).toBe(false);
  });
});

/**
 * The positive control, read through the PRODUCTION durable reader in the production
 * vocabulary. `driveThrough` stops at the approval boundary on purpose: the DoD is the state the
 * journey REACHES approval in, and the approval's own decision would immediately overwrite it.
 */
describe("the shipped journey reaches approval finalized", () => {
  it("reports lifecycle PLAN_REVIEW and a non-null graphRevisionRef on the durable record", () => {
    const store = openStore();
    driveThrough(store, APPROVAL_KIND);
    const ledger = readDurableLedger(store, PROJECT_ID);
    const run = ledger.aggregates.get(RUN_ID);
    if (run === undefined) throw new Error(`the journey wrote no durable decision for ${RUN_ID}`);
    const state = own(run.result, "state");
    expect(own(state, "lifecycle")).toBe("PLAN_REVIEW");
    expect(own(state, "graphRevisionRef")).toBe(
      sealedGraphRevisionRef(sequencePayloads(bootstrapSequence())),
    );
    expect(own(state, "graphRevisionRef")).not.toBeNull();
  });

  it("still admits the approval that follows, so no approval-path check is weakened", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    const ledger = readDurableLedger(store, PROJECT_ID);
    expect(ledger.kinds.has(APPROVAL_KIND)).toBe(true);
  });
});

/**
 * The preserved negative world, on the LIFECYCLE axis. It exists so that a guard refusing a
 * not-PLAN_REVIEW run has an operand: with `bootstrapSequence()` now finalizing, a daemon
 * holding no un-finalized world would leave task-2cc6c59d's refusal arm green forever and
 * killable by deleting the check. task-acc1a3b4's negative worlds are on the BUDGET axis and
 * neither row's world is a candidate for the other's treatment.
 */
describe("a world that proposed but deliberately did NOT finalize is preserved", () => {
  it("sits at a non-PLAN_REVIEW lifecycle with a null graphRevisionRef", () => {
    const ledger = readDurableLedger(proposedNotFinalizedStore(), PROJECT_ID);
    const run = ledger.aggregates.get(RUN_ID);
    if (run === undefined) throw new Error(`the proposal wrote no durable decision for ${RUN_ID}`);
    const state = own(run.result, "state");
    expect(own(state, "lifecycle")).not.toBe("PLAN_REVIEW");
    expect(own(state, "lifecycle")).toBe("PLANNING");
    expect(own(state, "graphRevisionRef")).toBeNull();
  });

  it("stops exactly one request short of the finalize the sequence does issue", () => {
    const index = finalizeRequestIndex();
    const requests = bootstrapSequence();
    expect(chainTerminalKind(requests[index]?.payload)).toBe(FINALIZE_COMMAND_KIND);
    expect(chainTerminalKind(requests[index - 1]?.payload)).toBe("plan.propose");
  });
});

/**
 * The refusal drill. `finalize` may not be folded onto a run that never proposed, and the arm
 * asserts the CODE and the REFUSING LAYER as a tuple — "it refused" would stay green if a
 * different layer started answering first.
 */
describe("finalize against an unproposed run fails closed", () => {
  it("refuses with the run reducer's own code and layer, committing nothing", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const requests = bootstrapSequence();
    const request = requests[finalizeRequestIndex()];
    if (request === undefined) throw new Error("no finalize request to drill");
    const outcome = send(store, request);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected the finalize to be refused");
    // MEASURED, and pinned as a tuple so a change in either half reddens here. The LAYER is
    // specific; the CODE is not. `UNKNOWN_ERROR` is fail-closed but opaque, so this arm pins
    // what production actually answers today rather than the stable code epic rail 4 wants.
    // The seam is bb923a7b's landed surface (taskRail 1: compose, never edit), so the opaque
    // code is REPORTED on the row for routing, not repaired here - and when it is repaired,
    // this assertion is the thing that reddens and forces the update.
    expect(outcome.code).toBe("UNKNOWN_ERROR");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
  });
});

/**
 * DoD 1's operand: the shipped journey does not merely ROUTE a finalize, it SEALS authority.
 *
 * BEFORE-STATE, measured at HEAD 6755d22 by driving all of `bootstrapSequence()` through the
 * production `send()` pipeline with every send ok=true: `planning-authority/run-1` held EXACTLY
 * ZERO events, and the approved run record carried no `authorityRef`, no `envelopeDigest` and no
 * `bodiesDigest`. `authorityOf` found no `authority` member on the propose terminal, took the
 * ABSENT branch, and finalize spread an empty `carried` onto the record.
 *
 * The AGGREGATE is asserted, not only the record: record fields could in principle be populated
 * by some other route, whereas the two sealed events are the seal itself having happened.
 *
 * Events are selected BY TYPE, never by index. Both halves land on the SAME aggregate — the
 * bodies event from `planning-authority-persistence.ts` at propose, the envelope event from
 * `planning-authority-finalize.ts` at finalize — and their write order is unpinned, so a
 * take-first read would name whichever landed first and stay green while reading the wrong one.
 *
 * `bodiesDigest` is asserted WHERE IT LIVES, in the bodies event's payload, not on the run
 * record: `planning-authority-finalize.ts:184-185` freezes the record's binding to
 * `{authorityRef, envelopeDigest}` exactly, and widening it would mean editing a writer taskRail
 * 1 forbids. It is also the operand task-2cc6c59d consumes.
 */
describe("the shipped journey seals planning authority", () => {
  const sealedStore = (): SqliteEventStore => {
    const store = openStore();
    driveThrough(store, "goal.close");
    return store;
  };

  const authorityEvents = (
    store: SqliteEventStore,
  ): readonly { readonly eventType: string; readonly payload: Uint8Array }[] =>
    store.readEvents(planningAuthorityAggregateId(RUN_ID));

  const payloadOfType = (store: SqliteEventStore, eventType: string): unknown => {
    const found = authorityEvents(store).find((event) => event.eventType === eventType);
    if (found === undefined) throw new Error(`the authority aggregate holds no ${eventType}`);
    return JSON.parse(decoder.decode(found.payload)) as unknown;
  };

  it("writes both sealed events to the run's authority aggregate", () => {
    const store = sealedStore();
    const events = authorityEvents(store);

    // The before-state was ZERO; anything non-empty is already a change, so the TYPES are what
    // this arm actually pins.
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((event) => event.eventType)))
      .toEqual(new Set([BODIES_EVENT_TYPE, PLANNING_AUTHORITY_ENVELOPE_EVENT_TYPE]));
  });

  it("carries authorityRef and envelopeDigest on the durable run record", () => {
    const store = sealedStore();
    const run = readDurableLedger(store, PROJECT_ID).aggregates.get(RUN_ID);
    if (run === undefined) throw new Error(`the journey wrote no durable decision for ${RUN_ID}`);

    // The ref is READ OUT of the production id builder rather than restated: two hand-authored
    // operands agreeing would prove only that this file agrees with itself.
    expect(own(run.result, "authorityRef")).toBe(planningAuthorityAggregateId(RUN_ID));
    const envelopeDigest = own(run.result, "envelopeDigest");
    expect(typeof envelopeDigest).toBe("string");
    expect(envelopeDigest).not.toBeNull();
  });

  it("carries bodiesDigest in the bodies event, joined to the run's submission hash", () => {
    const store = sealedStore();
    const bodies = payloadOfType(store, BODIES_EVENT_TYPE);
    const envelope = payloadOfType(store, PLANNING_AUTHORITY_ENVELOPE_EVENT_TYPE);

    const bodiesDigest = own(bodies, "bodiesDigest");
    expect(typeof bodiesDigest).toBe("string");
    expect(bodiesDigest).not.toBeNull();

    // The join task-2cc6c59d reads: the sealed plan body's own hash IS the run's submission
    // hash. `buildPlanningAuthorityLeg` refuses PLANNING_AUTHORITY_SUBMISSION_HASH_MISMATCH
    // when they disagree, so a seal that reached here has already survived that check --
    // pinning it keeps a later relaxation of the check visible from the journey.
    expect(own(bodies, "planHash")).toBe(own(bodies, "submissionHash"));
    expect(own(bodies, "runId")).toBe(RUN_ID);
    expect(own(envelope, "runId")).toBe(RUN_ID);
  });

  /**
   * The NEGATIVE CONTROL, and it is the leg that binds the three arms above to the mechanism
   * rather than to their own fixture. `planningChain()` is the shipped chain MINUS the authority
   * member -- it is the row's preserved authority-less world, not a mutation invented here -- so
   * driving it proves the same reads collapse to the ABSENT shape when the member is gone.
   * Without this, a world that reached sealed-looking fields by any other route would satisfy
   * every assertion above identically.
   */
  it("carries none of the sealed fields on a LEGACY run proposed without an authority member",
    () => {
      // RE-GRADED by task-16a6a2b1, which retired the ABSENT shape this arm was named for: the
      // propose seam now REFUSES an authority-less terminal, so `authorityLessProposedStore()`
      // no longer yields a proposed run at all. The negative control it provides is unchanged in
      // PURPOSE — binding the three arms above to the mechanism rather than to their fixture —
      // so the same world is PLANTED as pre-flip durable history instead of driven.
      const store = legacyProposedStore();

      expect(authorityEvents(store)).toEqual([]);
      const run = readDurableLedger(store, PROJECT_ID).aggregates.get(RUN_ID);
      if (run === undefined) throw new Error(`the plant wrote no durable decision for ${RUN_ID}`);
      expect(own(run.result, "authorityRef")).toBeUndefined();
      expect(own(run.result, "envelopeDigest")).toBeUndefined();
      expect(own(run.result, "bodiesDigest")).toBeUndefined();
    });

  it("REFUSES that terminal at the propose seam, which is why the world above must be planted",
    () => {
      // The other half of the same re-grade, and the arm that keeps the plant honest: if the
      // propose seam ever started accepting an authority-less terminal again, the planted world
      // would silently stop being the only way to reach it and this arm reds.
      const store = openStore();
      driveTo(store, finalizeRequestIndex() - 1);

      const outcome = send(store, envelope("plan.propose", 0, {
        commands: planningChain(), runId: RUN_ID,
      }));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("PLANNING_AUTHORITY_REQUIRED");
    });
});

/**
 * THE THREE-AXIS NEGATIVE-WORLD ROSTER (governor-7211ec87, comment-7a053f8c, condition 1).
 *
 * Three rows in the same shared-harness lineage each preserve a DELIBERATE negative world, on a
 * different axis, in a different file, for a different reason. Row N+1's world-enrichment
 * destroys row N's world while looking exactly like a bug being fixed — and a COMMENT saying
 * "do not fix this" does not red. This describe is the only artifact that fails when someone
 * tidies one away, which is why it asserts across all three rather than living beside any one.
 *
 * Each arm names the branch it protects and the row that required it. The BUDGET arm is
 * asserted STRUCTURALLY here — its behavioural arms are owned by
 * `activation-world-fixtures.test.ts` ("the deliberate negative worlds stay negative"), and
 * duplicating them would put this file in the business of grading another row's seam. What this
 * arm adds is the thing that suite cannot see: that the world still EXISTS at all when the
 * other two axes are being edited.
 */
describe("all three deliberate negative worlds still exist", () => {
  it("AUTHORITY axis (task-074e6d2e): a proposed run whose authority aggregate is EMPTY", () => {
    // Protects task-2cc6c59d's INCONSISTENCY refusal and the finalize seam's authority-absent
    // arm. The branch it used to protect first — the ABSENT leg of `buildPlanningAuthorityLeg` —
    // was RETIRED by task-16a6a2b1, which is also why the world is now PLANTED rather than
    // proposed: production refuses that terminal, so only pre-flip durable history reaches here.
    // The world itself is unchanged and the roster still fails if someone tidies it away.
    const store = legacyProposedStore();
    expect(store.readEvents(planningAuthorityAggregateId(RUN_ID))).toEqual([]);
    expect(store.getAggregateVersion(planningAuthorityAggregateId(RUN_ID))).toBe(0);
  });

  it("LIFECYCLE axis (task-f216f085): a proposed run that deliberately never finalized", () => {
    // Protects any guard refusing a not-PLAN_REVIEW run — task-2cc6c59d's lifecycle arm.
    const run = readDurableLedger(proposedNotFinalizedStore(), PROJECT_ID).aggregates.get(RUN_ID);
    if (run === undefined) throw new Error("the lifecycle-axis world wrote no durable decision");
    expect(own(own(run.result, "state"), "lifecycle")).not.toBe("PLAN_REVIEW");
    expect(own(own(run.result, "state"), "graphRevisionRef")).toBeNull();
  });

  it("BUDGET axis (task-acc1a3b4): the no-graph and no-goal activation seeders", () => {
    // Protect BUDGET_PROJECTION_GRAPH_UNAVAILABLE and BUDGET_PROJECTION_GOAL_ABSENT, which come
    // from DIFFERENT branches of readBudgetBinding, so one cannot stand in for the other.
    expect(typeof seedActivationWorldWithoutGraph).toBe("function");
    expect(typeof seedActivationWorldWithoutGoal).toBe("function");
  });
});

/**
 * WHICH LAYER REFUSES A BROKEN AUTHORITY MEMBER — measured, and it is NOT the layer the plan
 * for this row predicted. Recorded here rather than left in a drill log because the difference
 * is invisible afterwards and a later reader would otherwise "fix" these expectations back.
 *
 * `planning-authority-persistence.ts` owns two refusals for a bad member —
 * PLANNING_AUTHORITY_MALFORMED (the exact-arity check) and
 * PLANNING_AUTHORITY_SUBMISSION_HASH_MISMATCH (the plan hash must BE the run's submission hash).
 * Neither is reachable from a chain payload: the CORE reducer folds the chain first and refuses
 * ILLEGAL_TRANSITION @ CORE_REDUCER, so the daemon codes only answer when `lastCommand` is handed
 * straight to `buildPlanningAuthorityLeg`, which is exactly what
 * planning-authority-persistence.test.ts does at :310 and :333.
 *
 * Both arms are pinned as CODE + LAYER tuples, because "it refused" would stay green if the
 * daemon layer quietly started answering first — which is precisely the drift this pin exists
 * to catch. ILLEGAL_TRANSITION is fail-closed but OPAQUE against epic rail 4's stable-code
 * requirement; the core reducer is off-limits to this row (taskRail 1), so the opacity is
 * REPORTED for the seam owner and pinned here so its repair reddens this file.
 *
 * The POSITIVE CONTROLS are the sealed and legacy proposals above and in the roster describe:
 * the same drive with a well-formed member commits, and with no member at all commits into the
 * ABSENT world — so these two arms are refusing on the mutation, not on a broken fixture.
 */
describe("a malformed authority member fails closed at the core fold", () => {
  const proposeWith = (last: Record<string, unknown>): { code: string; layer: string } => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const chain = [...planningChain()];
    chain[chain.length - 1] = last;
    const outcome = send(store, envelope("plan.propose", 0, { commands: chain, runId: RUN_ID }));
    if (outcome.ok) throw new Error("expected the malformed member to be refused");
    return {
      code: String((outcome as { code?: string }).code),
      layer: String((outcome as { refusedBy?: string }).refusedBy),
    };
  };

  const proposeCommand = (): Record<string, unknown> => {
    const last = planningChain()[planningChain().length - 1];
    if (last === undefined) throw new Error("planningChain() is empty");
    return { ...last };
  };

  const sealedHash = (): unknown =>
    (AUTHORITY_MEMBER["planRevision"] as Record<string, unknown>)["planHash"];

  it("refuses a member whose paired submissionHash is missing", () => {
    expect(proposeWith({ ...proposeCommand(), authority: AUTHORITY_MEMBER }))
      .toEqual({ code: "ILLEGAL_TRANSITION", layer: "CORE_REDUCER" });
  });

  it("refuses a member carrying a THIRD key, which authorityOf's arity check forbids", () => {
    expect(proposeWith({
      ...proposeCommand(),
      authority: { ...AUTHORITY_MEMBER, extraKey: "smuggled" },
      submissionHash: sealedHash(),
    })).toEqual({ code: "ILLEGAL_TRANSITION", layer: "CORE_REDUCER" });
  });
});
