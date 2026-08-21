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
import { describe, expect, it, afterEach } from "vitest";

import type { DemoSeedInput, SeedCommand } from "../orchestrator/demo-seed-plan.js";
import { buildDemoSeedPlan } from "../orchestrator/demo-seed-plan.js";
import { FINALIZE_COMMAND_KIND } from "../planning/planning-authority-finalize-ingress.js";
import { readDurableLedger } from "./bootstrap-ledger.js";
import { finalizeRequestIndex, proposedNotFinalizedStore } from "./bootstrap-journey-fixtures.js";
import type { Envelope } from "./bootstrap-test-fixtures.js";
import {
  PROJECT_ID,
  RUN_ID,
  bootstrapSequence,
  closeStores,
  driveThrough,
  openStore,
  send,
} from "./bootstrap-test-fixtures.js";

const APPROVAL_KIND = "approval.decide";

const NODE = Object.freeze({
  instructions: "Land the shipped finalize routing.",
  nodeRef: "node-demo",
  test: "pnpm --filter @moe/daemon test",
  title: "Demo node",
  workspace: "workspace-demo",
});

const DEMO_INPUT: DemoSeedInput = Object.freeze({
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
