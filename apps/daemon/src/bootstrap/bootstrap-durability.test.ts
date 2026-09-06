import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import { SQLITE_APPLICATION_ID } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { BOOTSTRAP_COMMAND_KINDS, decodeBootstrapRequestBytes } from "./bootstrap-contracts.js";
import {
  commitAccepted, humanReviewWitness, missingPrerequisites, readDurableLedger, stateOf,
} from "./bootstrap-ledger.js";
import { PREREQUISITE_ALTERNATIVES } from "./bootstrap-sequence.js";
import type { ServiceOutcome } from "./bootstrap-ledger.js";
import {
  ACTIVATION_WITNESS,
  FIXTURE_ACTIVATION_RECEIPTS,
  FIXTURE_PUBLICATION_APPROVAL,
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  OBSERVATION,
  PROJECT_ID,
  RUN_ID,
  acceptancePayload,
  activatePayload,
  approvalPayload,
  approvalRecord,
  bootstrapSequence,
  closeStores,
  decisionCount,
  driveThrough,
  envelope,
  evaluationInput,
  goalPayload,
  hex64,
  openStore,
  receiptsWithout,
  sealedPlanningChain,
  send,
  sendUnmeasured,
} from "./bootstrap-test-fixtures.js";
import {
  ACTIVATION_RECEIPT_CODES,
  ACTIVATION_RECEIPT_MEMBERS,
  SIGNING_UNSIGNED_REF,
  sha256Hex,
} from "./activation-receipts.js";
import type { ActivationReceiptMember } from "./activation-receipts.js";
import {
  measureActivationReceipts,
  nodeActivationReceiptPorts,
} from "./activation-receipts-measure.js";
import type { ActivationReceiptInput } from "./activation-receipts-measure.js";
import type { ActivationReceiptPorts } from "./activation-receipts-ports.js";
import { driveTo } from "./bootstrap-journey-fixtures.js";
import { seedActivationWorldWithGatePolicy } from "../activation/activation-world-fixtures.js";
import type { Envelope } from "./bootstrap-test-fixtures.js";
import { readApprovedNodeScope } from "../goals/goal-close-prerequisite.js";
import { scanGlobalEvents, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { qualifyGoalClosure } from "../goals/goal-qualification.js";
import { runApprovalIntentCommand } from "../planning/approval-intent.js";

/**
 * Durability behaviour of the nine bootstrap services: the command-driven sequence (DoD 1),
 * one durable terminal decision with an exact idempotent replay (DoD 2), and the four hostile
 * inputs that must commit nothing (DoD 3).
 *
 * Every refusal assertion names the stable code AND the layer that produced it. Three layers
 * can refuse here — the ingress gate, the daemon's durable-sequence gate, and a core reducer —
 * so asserting only "it refused" would go vacuous the moment an earlier layer starts answering.
 *
 * `goal.close` IS THE ONE REQUEST THIS JOURNEY CANNOT DRIVE TO A DECISION. Its daemon
 * prerequisite demands a durable Foundation verification receipt, and no test world can commit
 * the activation that chain starts from — `runEffectActivateCommand` refuses. Rather than delete
 * the row from the generated matrix (which would silently shrink the sweep) or rebuild the world
 * below the admission path (governor ruling comment-937524c83a1945a5afae3ed8ac2405b9 forbids it),
 * the matrix keeps every request and asserts the answer `goal.close` GENUINELY returns here: the
 * exact no-receipt refusal, twice, with no durable row either time.
 */

afterEach(closeStores);

/**
 * The frozen tuple `goal.close` answers on this journey, restated by hand so a code, a layer or
 * an authority quietly changing is a red rather than a shrug.
 *
 * THE CODE MOVED UP ONE FENCE (task-ae6fd9ac). Qualification no longer demands a Foundation
 * verification receipt — the live leg closes on the running loop's own evidence — so the guard
 * this journey reaches first is the REVIEW one: it drives the bootstrap sequence and never
 * accepts a node's output, so no durable acceptance names the approved node. Same layer, same
 * authority, one fence earlier.
 */
const NO_ACCEPTANCE_REFUSAL = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
  ok: false,
  refusedBy: "DAEMON_PREREQUISITE",
});

function registerAndBind(store: SqliteEventStore): void {
  const sequence = bootstrapSequence();
  expect(send(store, sequence[0] as Envelope).ok).toBe(true);
  expect(send(store, sequence[1] as Envelope).ok).toBe(true);
}

describe("bootstrap sequence is command-driven (DoD 1)", () => {
  it("refuses activation while the provider probe has no durable decision", () => {
    const store = openStore();
    registerAndBind(store);
    const before = decisionCount(store);

    const outcome = send(store, envelope("project.activate", 2, activatePayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(outcome.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("project.activate")).toBe(false);
  });

  /**
   * INVERTED BY task-4b9c394d. This arm used to assert the opposite: that a payload carrying NO
   * witness was refused BOOTSTRAP_PAYLOAD_INVALID. An empty payload is now the CORRECT one — the
   * daemon mints the witness — so the refusal this file must pin is the reverse, and pinning the
   * old direction would have kept a green test guarding behaviour the product no longer wants.
   */
  it("refuses activation CARRYING a witness, at the ingress layer", () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const before = decisionCount(store);

    const outcome = send(
      store, envelope("project.activate", 2, { witness: { ...ACTIVATION_WITNESS } }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("ACTIVATION_WITNESS_CALLER_SUPPLIED");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("project.activate")).toBe(false);
  });

  it.each([
    ["a string", "x"], ["a number", 42], ["a boolean", true], ["an array", []], ["null", null],
  ])("refuses activation carrying %s as its witness the same way", (_shape, witness) => {
    // Only an object witness used to be refused; every other shape was ignored silently, which
    // is the same caller attempt to present a witness with a quieter answer.
    const store = openStore();
    driveThrough(store, "project.activate");
    const before = decisionCount(store);

    const outcome = send(store, envelope("project.activate", 2, { witness }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("ACTIVATION_WITNESS_CALLER_SUPPLIED");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("project.activate")).toBe(false);
  });

  it("refuses an out-of-order sequence: bind before register", () => {
    const store = openStore();

    const outcome = send(store, envelope("project.bind_repository", 0, {
      observation: OBSERVATION,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(0);
  });

  it("refuses a goal against a project that is not durably activated", () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const before = decisionCount(store);

    const outcome = send(store, envelope("goal.create", 0, goalPayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
  });
});

/**
 * Bootstrap-family kinds this SYNCHRONOUS journey does not drive, each for a stated reason.
 * Naming them here rather than filtering by predicate keeps the set assertion below exact.
 */
const UNDRIVEN_KINDS: readonly string[] = Object.freeze([
  // Exercised through the real registry describe instead of this legacy goal.create journey.
  "goal.create_with_source",
  // Served on the ASYNC entry: its service runs `git`, optionally `gh` and a filesystem tree
  // write, none of which `send` -- a synchronous ledger drive -- can express. Driven end to end
  // in repository/repository-bootstrap-journey.test.ts instead.
  "repository.bootstrap",
]);

/** `plan.propose` and `policy.install` each appear twice; both repeats are asserted below. */
const REPEATED_REQUESTS = 2;

describe("one durable terminal decision and exact replay (DoD 2)", () => {
  const sequence = bootstrapSequence();

  it("drives every owned command kind, with plan.propose and policy.install twice each", () => {
    // Thirteen requests over eleven driven kinds: `goal.create_with_source` is exercised through the
    // real registry describe instead of this legacy goal.create journey. TWO kinds repeat, and
    // each repetition is load-bearing rather than incidental: the second `plan.propose` is the
    // finalize terminal, and the second `policy.install` is the RISK-CLASSIFYING slice the
    // finalize terminal now requires (task-a888038d) — without it every sealed run refuses
    // RUN_POLICY_UNCLASSIFIABLE, so the world could not reach approval at all.
    expect(sequence).toHaveLength(13);
    // Derived from the roster and the two stated exclusions, so a kind added to the bootstrap
    // family without a decision here still reds -- the arithmetic cannot absorb it silently.
    expect(sequence.length)
      .toBe(BOOTSTRAP_COMMAND_KINDS.length - UNDRIVEN_KINDS.length + REPEATED_REQUESTS);
    expect(new Set(sequence.map((entry) => entry.kind)))
      .toEqual(new Set<string>(
        BOOTSTRAP_COMMAND_KINDS.filter((kind) => !UNDRIVEN_KINDS.includes(kind)),
      ));
    expect(sequence.filter((entry) => entry.kind === "plan.propose")).toHaveLength(2);
    expect(sequence.filter((entry) => entry.kind === "policy.install")).toHaveLength(2);
  });

  it.each(sequence.map((request, index) => [request.kind, index] as const))(
    "%s commits one decision and replays it exactly",
    (kind, index) => {
      const store = openStore();
      // By INDEX: `driveThrough` keys on kind and would rewind the finalize request's prefix
      // back to the proposal, sending a finalize against a run that never proposed.
      driveTo(store, index);
      // The FUNDED world before this journey's approval (task-1de7b81a). A budget root is
      // once-only and nothing can top one up, so a project approved without a funded root holds
      // the zero-amount genesis root forever and its later effect.activate refuses. `driveTo`
      // seeds the world for every index PAST the approval; this line covers the index that IS
      // the approval, whose request the test sends itself.
      if (kind === "approval.decide") {
        seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
      }
      const before = decisionCount(store);

      const request = sequence[index] as Envelope;
      if (kind === "goal.close") {
        // STORE-WIDE, not one guessed aggregate: a committed activation anywhere would make this
        // arm's refusal the wrong subject. `total` is the positive control — the journey really
        // did write events — so a zero activation count is measured, not vacuous.
        const scan = scanGlobalEvents(store);
        expect(scan.total).toBeGreaterThan(0);
        expect(scan.exhausted).toBe(true);
        expect(scan.activationRows).toBe(0);

        expect(send(store, request)).toMatchObject(NO_ACCEPTANCE_REFUSAL);
        expect(decisionCount(store)).toBe(before);
        // A refusal is not a decision, so the SECOND call re-derives it rather than replaying a
        // row: identical answer, still nothing durable.
        expect(send(store, request)).toMatchObject(NO_ACCEPTANCE_REFUSAL);
        expect(decisionCount(store)).toBe(before);
        return;
      }
      const first = send(store, request);
      expect(first.ok, `first ${kind}: ${first.ok ? "" : first.code}`).toBe(true);
      if (!first.ok) throw new Error("expected acceptance");
      expect(first.disposition).toBe("DECIDED");
      expect(first.authority).toBe("DURABLE_DECISION");
      expect(first.advisoryOnly).toBe(false);
      expect(decisionCount(store)).toBe(before + 1);

      const second = send(store, request);
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("expected replay");
      expect(second.disposition).toBe("REPLAYED");
      expect(second.decision.decisionId).toBe(first.decision.decisionId);
      expect(second.decision.resultSha256).toBe(first.decision.resultSha256);
      expect(second.decision.decisionSha256).toBe(first.decision.decisionSha256);
      expect(decisionCount(store)).toBe(before + 1);
    },
    90_000,
  );
});

describe("hostile inputs commit no unauthorized mutation (DoD 3)", () => {
  const HOSTILE = ["STALE_VERSION", "WRONG_HASH", "MISSING_PROBE", "UNKNOWN_POLICY"] as const;

  it("declares all four named hostile inputs", () => {
    expect(HOSTILE).toHaveLength(4);
    expect(new Set(HOSTILE).size).toBe(4);
  });

  it("STALE_VERSION is refused by the core reducer and writes no decision", () => {
    const store = openStore();
    // Register, bind and probe are durable, so the sequence gate passes and the core answers.
    // The payload carries NO witness on purpose (task-4b9c394d): a caller-supplied one would be
    // refused at DAEMON_INGRESS first and this arm would pass for the wrong reason, never
    // reaching the reducer whose refusal it exists to pin.
    driveThrough(store, "project.activate");
    const before = decisionCount(store);
    const head = readDurableLedger(store, PROJECT_ID).aggregates.get(PROJECT_ID);

    const outcome = send(store, envelope("project.activate", 99, activatePayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).aggregates.get(PROJECT_ID)).toEqual(head);
  });

  it("WRONG_HASH is refused by the daemon's revision gate and writes no decision", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      record: approvalRecord(hex64("ffff")),
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_REVISION_HASH_MISMATCH");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("approval.decide")).toBe(false);
  });

  it("MISSING_PROBE is refused by the sequence gate and writes no decision", () => {
    const store = openStore();
    registerAndBind(store);
    const before = decisionCount(store);

    const outcome = send(store, envelope("project.activate", 2, activatePayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("project.activate")).toBe(false);
  });

  it("UNKNOWN_POLICY is refused by the daemon's policy gate and writes no decision", () => {
    const store = openStore();
    driveThrough(store, "policy.validate");
    const before = decisionCount(store);

    const outcome = send(store, envelope("policy.validate", 1, {
      input: evaluationInput(hex64("9999")),
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_POLICY_UNKNOWN");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("policy.validate")).toBe(false);
  });

  it("refuses a commandId reused under a different kind, claiming no authority", () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const before = decisionCount(store);

    // "cmd-project.register" already holds a durable decision. Replaying it as an activate
    // must not hand back the register decision dressed as an accepted activation.
    const outcome = send(
      store,
      envelope("project.activate", 2, activatePayload(), "cmd-project.register"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_COMMAND_ID_REUSED");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(outcome.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("project.activate")).toBe(false);
  });

  it("refuses at the store layer when the durable head moved under the commit", () => {
    const store = openStore();
    driveThrough(store, "project.bind_repository");
    const before = decisionCount(store);
    const decoded = decodeBootstrapRequestBytes(
      new TextEncoder().encode(JSON.stringify(
        envelope("project.bind_repository", 1, { observation: OBSERVATION }, "cmd-raced"),
      )),
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected an accepted envelope");

    // Commit directly against the production seam with a head that has already advanced, which
    // is what a concurrent writer produces between the ledger read and the commit.
    const outcome = commitAccepted(store, decoded.request, {
      aggregateId: PROJECT_ID,
      eventPayload: { raced: true },
      eventType: "RepositoryBound",
      expectedVersion: 99,
      result: { raced: true },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("DURABLE_STORE");
    expect(outcome.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(outcome.authority).toBe("NONE");
    // The store's audit row is durable, so the count moves; the aggregate head must not.
    expect(decisionCount(store)).toBe(before + 1);
    // Only project.register has run at this point, so the head sits at version 1.
    const head = readDurableLedger(store, PROJECT_ID).aggregates.get(PROJECT_ID)?.currentVersion;
    expect(head).toBe(1);
    // The refusal names the version the store OBSERVED, decoded from the store's own result
    // bytes. `actualVersion` is read back off the ledger, never copied from the request, so a
    // daemon that echoed its own `expectedVersion` here would fail this arm.
    expect(outcome.error).not.toBeNull();
    expect(outcome.error?.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect({ ...outcome.error?.details }).toEqual({ actualVersion: head, expectedVersion: 99 });
  });

  it("keeps the bare code when the store's conflict result bytes do not decode", () => {
    // Undecodable bytes must not become an invented version: the refusal falls back to the bare
    // code with no error. Driven through the production seam with a store double, because a real
    // store never emits corrupt bytes — this arm pins the fail-closed branch, not the store.
    const decoded = decodeBootstrapRequestBytes(
      new TextEncoder().encode(JSON.stringify(
        envelope("project.bind_repository", 1, { observation: OBSERVATION }, "cmd-corrupt"),
      )),
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected an accepted envelope");

    const corruptStore = {
      commitExpectedVersionDecision: () => ({
        decision: {
          currentVersion: null,
          effectDisposition: "NO_BUSINESS_EFFECT",
          resultBytes: new TextEncoder().encode("not json"),
          resultCode: "EXPECTED_VERSION_CONFLICT",
        },
        disposition: "DECIDED",
      }),
    } as unknown as SqliteEventStore;

    const outcome = commitAccepted(corruptStore, decoded.request, {
      aggregateId: PROJECT_ID,
      eventPayload: { raced: true },
      eventType: "RepositoryBound",
      expectedVersion: 7,
      result: { raced: true },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(outcome.refusedBy).toBe("DURABLE_STORE");
    expect(outcome.error).toBeNull();
  });

  /**
   * Bytes that DECODE but carry something that is not a version. A daemon that coerced these
   * would put an invented number on the wire and a seat would retry at it, so each planted
   * shape must fail closed to the bare code exactly as undecodable bytes do.
   */
  it("keeps the bare code when the conflict bytes carry versions that are not versions", () => {
    const decoded = decodeBootstrapRequestBytes(
      new TextEncoder().encode(JSON.stringify(
        envelope("project.bind_repository", 1, { observation: OBSERVATION }, "cmd-nonnumeric"),
      )),
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected an accepted envelope");

    const planted = [
      { expectedVersion: 0, observedVersion: "1" },
      { expectedVersion: 0, observedVersion: { value: 1 } },
      { expectedVersion: 0, observedVersion: 1.5 },
      { expectedVersion: 0, observedVersion: -1 },
      { expectedVersion: "zero", observedVersion: 1 },
      { expectedVersion: 0 },
      { observedVersion: 1 },
    ];
    expect(planted).toHaveLength(7);

    for (const result of planted) {
      const store = {
        commitExpectedVersionDecision: () => ({
          decision: {
            currentVersion: null,
            effectDisposition: "NO_BUSINESS_EFFECT",
            resultBytes: new TextEncoder().encode(JSON.stringify({
              code: "EXPECTED_VERSION_CONFLICT", ...result, version: 1,
            })),
            resultCode: "EXPECTED_VERSION_CONFLICT",
          },
          disposition: "DECIDED",
        }),
      } as unknown as SqliteEventStore;

      const outcome = commitAccepted(store, decoded.request, {
        aggregateId: PROJECT_ID,
        eventPayload: { raced: true },
        eventType: "RepositoryBound",
        expectedVersion: 7,
        result: { raced: true },
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected refusal");
      expect(outcome.code).toBe("EXPECTED_VERSION_CONFLICT");
      expect(outcome.error).toBeNull();
    }
  });

  /** A NON-conflict store refusal must not pick up conflict details from a decision that
   *  happens to carry decodable version bytes: the resultCode is what selects the branch. */
  it("attaches nothing when the store refused with some other code", () => {
    const decoded = decodeBootstrapRequestBytes(
      new TextEncoder().encode(JSON.stringify(
        envelope("project.bind_repository", 1, { observation: OBSERVATION }, "cmd-other-code"),
      )),
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected an accepted envelope");

    const store = {
      commitExpectedVersionDecision: () => ({
        decision: {
          currentVersion: null,
          effectDisposition: "NO_BUSINESS_EFFECT",
          resultBytes: new TextEncoder().encode(JSON.stringify({
            code: "SOME_OTHER_REFUSAL", expectedVersion: 0, observedVersion: 1, version: 1,
          })),
          resultCode: "SOME_OTHER_REFUSAL",
        },
        disposition: "DECIDED",
      }),
    } as unknown as SqliteEventStore;

    const outcome = commitAccepted(store, decoded.request, {
      aggregateId: PROJECT_ID,
      eventPayload: { raced: true },
      eventType: "RepositoryBound",
      expectedVersion: 7,
      result: { raced: true },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("SOME_OTHER_REFUSAL");
    expect(outcome.error).toBeNull();
  });

  it("a durably proposed hash is what the approval gate compares against", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");

    const accepted = send(store, envelope("approval.decide", 0, approvalPayload()));

    expect(accepted.ok, accepted.ok ? "" : accepted.code).toBe(true);
    expect(readDurableLedger(store, PROJECT_ID).aggregates.get(RUN_ID)).toBeDefined();
  });
});

/**
 * A SOURCE-CREATED GOAL MUST BE ABLE TO CONTINUE THE JOURNEY (task-e87cfddf).
 *
 * `COMMAND_PREREQUISITES["plan.propose"]` names `goal.create` alone and `missingPrerequisites`
 * requires EVERY listed kind to hold a committed decision, so a goal landed through
 * `goal.create_with_source` — a real durable GoalCreated on the very aggregate the planning
 * chain names as its `goalRef` — strands the run at BOOTSTRAP_PREREQUISITE_MISSING.
 *
 * THREE ARMS, BECAUSE ONE WOULD NOT SEPARATE A FIX FROM A BYPASS. The with-source arm is the
 * reproduction; the legacy arm proves the widening did not move `goal.create`; the no-goal arm
 * proves the gate still refuses, and reads the unmet kind off the PRODUCTION reader rather than
 * off the refusal (which carries no missing-kind detail by design). Loosen the gate into
 * "always satisfied" and the third arm reds; collapse the alternatives and the first reds.
 */
const WITH_SOURCE_PRD = Object.freeze({
  displayPath: "docs/prd.md",
  mediaType: "text/markdown",
  text: "# Build the widget\n\nAn operator dropped this PRD in the browser.\n",
});

/**
 * The with-source create under the SAME command id `goal.create` uses. `goalAggregateIdOf`
 * derives the goal from that id, so BOTH arms land `goal-1` and the planning chain that follows
 * is byte-identical between them: the creation KIND is the only difference the gate can see.
 */
function createWithSource(store: SqliteEventStore): ServiceOutcome {
  return send(store, envelope(
    "goal.create_with_source",
    0,
    { ...goalPayload(), source: WITH_SOURCE_PRD },
    GOAL_CREATE_COMMAND_ID,
  ));
}

function proposeAfterCreate(store: SqliteEventStore): ServiceOutcome {
  return send(
    store, envelope("plan.propose", 0, { commands: sealedPlanningChain(), runId: RUN_ID }));
}

describe("plan.propose admits either creation kind (task-e87cfddf)", () => {
  it("accepts plan.propose after goal.create_with_source, with no goal.create in the ledger", () => {
    const store = openStore();
    driveThrough(store, "goal.create");

    const created = createWithSource(store);
    expect(created.ok, created.ok ? "" : `${created.code}@${created.refusedBy}`).toBe(true);
    const ledger = readDurableLedger(store, PROJECT_ID);
    expect(ledger.kinds.has("goal.create_with_source")).toBe(true);
    // The divergence this arm rests on: the legacy kind is ABSENT, so nothing but the
    // alternative can satisfy the gate. Were it present the arm would pass on the old table.
    expect(ledger.kinds.has("goal.create")).toBe(false);

    const proposed = proposeAfterCreate(store);

    expect(proposed.ok, proposed.ok ? "" : `${proposed.code}@${proposed.refusedBy}`).toBe(true);
  });

  it("still accepts plan.propose after the legacy goal.create", () => {
    const store = openStore();
    driveThrough(store, "goal.create");

    const created = send(
      store, envelope("goal.create", 0, goalPayload(), GOAL_CREATE_COMMAND_ID));
    expect(created.ok, created.ok ? "" : `${created.code}@${created.refusedBy}`).toBe(true);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("goal.create_with_source")).toBe(false);

    const proposed = proposeAfterCreate(store);

    expect(proposed.ok, proposed.ok ? "" : `${proposed.code}@${proposed.refusedBy}`).toBe(true);
  });

  it("refuses plan.propose with no goal of EITHER kind, naming goal.create", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const before = decisionCount(store);

    const proposed = proposeAfterCreate(store);

    expect(proposed.ok).toBe(false);
    if (proposed.ok) throw new Error("expected refusal");
    expect(proposed.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
    expect(proposed.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(proposed.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
    // The refusal response carries no missing-kind detail on purpose, so the STABLE MEMBER KIND
    // is read off the production reader itself. The control room parses `missing` as plain
    // strings (live/live-board-feed.ts:118-127); a group literal leaking here would take the
    // board's BLOCKED card dark rather than merely rename it.
    expect(missingPrerequisites(readDurableLedger(store, PROJECT_ID), "plan.propose"))
      .toEqual(["goal.create"]);
  });

  /**
   * THE TWO SIDES MEASURE AGAINST DIFFERENT ROSTERS, AND THAT IS THE POINT — do not "tidy" them
   * back into one (task-ebbcbdb4).
   *
   * KEY side: `BOOTSTRAP_COMMAND_KINDS`. A prerequisite always IS a bootstrap kind, because the
   * keys of this table only ever name entries of `COMMAND_PREREQUISITES`. Widening this side
   * would admit a key nothing could ever consult, and lose a real check.
   *
   * ALTERNATIVE side: `RUNTIME_COMMAND_KINDS`. An alternative is tested against the set
   * `readDurableLedger` builds, which holds EVERY committed decision kind — bootstrap or not.
   * `approval.decide_intent` is served by the runtime registry rather than this pipeline, so the
   * narrower roster would reject a legitimate widening. The guard's own rationale survives
   * intact: a kind NO dispatch anywhere serves still could never appear in a committed set, and
   * `RUNTIME_COMMAND_KINDS` is exactly the roster of kinds that can. `BOOTSTRAP_COMMAND_KINDS` is
   * declared `as const satisfies readonly RuntimeCommandKind[]` (bootstrap-contracts.ts:43), so
   * bootstrap kinds stay a strict subset and nothing that passed before starts failing.
   */
  it("names only real command kinds on both sides of the alternatives table", () => {
    const prerequisiteRoster: readonly string[] = BOOTSTRAP_COMMAND_KINDS;
    const alternativeRoster: readonly string[] = RUNTIME_COMMAND_KINDS;
    const entries = Object.entries(PREREQUISITE_ALTERNATIVES);

    // A sweep that generates zero checks passes while testing nothing.
    expect(entries.length).toBeGreaterThan(0);
    let checked = 0;
    for (const [prerequisite, alternatives] of entries) {
      expect({ kind: prerequisite, real: prerequisiteRoster.includes(prerequisite) })
        .toEqual({ kind: prerequisite, real: true });
      // A widening is only ever explicit and only ever a NAMED kind: an empty list would admit
      // nothing, and a kind no dispatch serves could never appear in a committed set — but it
      // would also never be caught by a runtime arm that only asked "did it refuse".
      expect(alternatives?.length ?? 0).toBeGreaterThan(0);
      for (const alternative of alternatives ?? []) {
        checked += 1;
        expect({ alternative, of: prerequisite, real: alternativeRoster.includes(alternative) })
          .toEqual({ alternative, of: prerequisite, real: true });
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});


/**
 * THE BROWSER'S APPROVAL SATISFIES CLOSE AND PUBLISH (task-ebbcbdb4).
 *
 * `goal.close` and `repository.publish` both require a durable `approval.decide`
 * (bootstrap-sequence.ts:22 and :25). The browser's paired session approves through
 * `approval.decide_intent` instead, so a goal approved IN THE BROWSER commits no
 * `approval.decide` and its prerequisite was unsatisfiable FOREVER — measured live on the UnAI
 * project, where a goal at 10/10 criteria VERIFIED refused BOOTSTRAP_PREREQUISITE_MISSING while
 * `/affordances/read` went on offering the operator a Close button.
 *
 * These arms drive the REAL intent seam (`runApprovalIntentCommand`), never a hand-built ledger
 * row: the claim is about what the production approval commits, so a fixture that added the kind
 * itself would prove nothing about production.
 */
describe("close and publish admit either approval kind (task-ebbcbdb4)", () => {
  const INTENT_OPERATOR = "principal-1";
  const REJECT_REASON = "the plan does not close the goal";

  const label = (outcome: ServiceOutcome): string =>
    outcome.ok ? "ACCEPTED" : `${outcome.code}@${outcome.refusedBy}`;

  /** The browser's approve wire, driven at its own production seam against a real store. */
  function decideIntent(
    store: SqliteEventStore,
    commandId: string,
    decision: "APPROVE" | "REJECT",
  ): ServiceOutcome {
    return runApprovalIntentCommand({
      commandId,
      correlationId: "corr-intent-close",
      decidedAt: "2026-09-05T12:00:00.000Z",
      expectedVersion: store.getAggregateVersion(RUN_ID),
      humanReview: humanReviewWitness(INTENT_OPERATOR, commandId),
      payload: {
        decision,
        decisionReason: decision === "APPROVE" ? "the plan is sound" : REJECT_REASON,
        dependencyChanges: { additions: [], challenges: [], removals: [] },
        runId: RUN_ID,
      },
      principalId: INTENT_OPERATOR,
      projectId: PROJECT_ID,
      store,
      targetAggregateId: RUN_ID,
    });
  }

  /** Everything the journey commits BEFORE its approval — the world with neither approval kind. */
  function unapprovedWorld(): SqliteEventStore {
    const store = openStore();
    driveThrough(store, "approval.decide");
    return store;
  }

  /** A goal approved the way the BROWSER approves it, and no other way. */
  function intentApprovedWorld(commandId = "cmd-intent-approve-close"): SqliteEventStore {
    const store = unapprovedWorld();
    const approved = decideIntent(store, commandId, "APPROVE");
    expect(approved.ok, approved.ok ? "" : `${approved.code}@${approved.refusedBy}`).toBe(true);

    const ledger = readDurableLedger(store, PROJECT_ID);
    // The divergence every arm below rests on: the SEEDED kind is absent, so nothing but the
    // alternative can satisfy the gate. Were it present these arms would pass on the old table.
    expect(ledger.kinds.has("approval.decide_intent")).toBe(true);
    expect(ledger.kinds.has("approval.decide")).toBe(false);
    return store;
  }

  /**
   * The ONE execution-bearing node of the graph the shipped journey seals
   * (`bootstrap-test-fixtures.ts:149`, `nodeIds: ["node-a"]`, which `journey-authority-bodies.ts:166`
   * turns into `nodes: [{ executionBearing: true, nodeKey }]`).
   *
   * A GOLDEN LITERAL, deliberately, rather than a value re-derived here from the store. Deriving
   * it in the test would be a second copy of the very derivation the mint now performs, and the
   * two would move together — a scope naming the wrong node would then agree with itself and the
   * arm would stay green. It is NOT `node-1`: that literal is the caller-authored scope on the
   * `approval.decide` fixture record (`bootstrap-test-fixtures.ts:732`) and `seedReviewAcceptance`'s
   * default, and the distance between the two is exactly what a size-only assertion would miss.
   */
  const SEALED_EXECUTION_NODE = "node-a";

  /** The goal's durable lifecycle, folded off the committed ledger rather than off a return value. */
  function goalLifecycle(store: SqliteEventStore): unknown {
    const state = stateOf(readDurableLedger(store, PROJECT_ID), GOAL_ID);
    return state === undefined || state === null || typeof state !== "object"
      || Array.isArray(state)
      ? undefined
      : (state as Record<string, unknown>)["lifecycle"];
  }

  /** The world the browser leaves behind once its node has been reviewed and accepted. */
  function intentApprovedAcceptedWorld(commandId: string): SqliteEventStore {
    const store = intentApprovedWorld(commandId);
    seedReviewAcceptance(store, SEALED_EXECUTION_NODE);
    return store;
  }

  /**
   * THIS WORLD IS LEGACY, AND LEGACY NOW NEEDS FOUNDATION RECEIPTS.
   *
   * THE ANSWER MOVED WHILE THIS ROW WAS OPEN, AND HERE IS WHY. As shipped by task-8bdd14af this
   * arm CLOSED the goal: the mint names the sealed revision's execution-bearing node, so the
   * scope fence clears and the review acceptance seeded on that node carried the live leg. Commit
   * 4b6d2bc2 then landed `goal-approved-execution-scope.ts`, which routes an approval whose
   * planning run has NO compiled Product Contract binding — exactly this bootstrap world — down a
   * `requiresFoundation` branch: a raw local key may no longer qualify through a review
   * acceptance alone, because one execution's acceptance must not be inheritable by another's
   * identically-named node. `goal-qualification.ts` therefore refuses any in-scope node holding
   * no Foundation verification receipt, and this world holds none.
   *
   * THE ARM IS KEPT, NOT DELETED, AND IT STILL GRADES THIS ROW'S FIX: the scope fence is asserted
   * SATISFIED — a named, non-null scope over the sealed node — so the refusal below is provably
   * the newer fence and not the empty-scope defect this row removed. The refusal MESSAGE is the
   * discriminator, because both fences raise the same code at the same layer.
   *
   * THE CLOSE ITSELF NOW LIVES WHERE IT IS REACHABLE:
   * `goals/goal-intent-approved-closure.test.ts` drives a CONTRACT-BOUND world approved only
   * through `approval.decide_intent` and asserts `qualifyGoalClosure` answers `ok: true` with a
   * DAEMON_VERIFIED witness. `goalLifecycle` is asserted here too, so an accidental close would
   * still fail this arm rather than pass it quietly.
   */
  it("refuses the legacy close at the Foundation fence, with the approved scope named", () => {
    const store = intentApprovedAcceptedWorld("cmd-intent-approve-closes");
    // The fence this row fixed is SATISFIED, so it cannot be what refuses below.
    expect(readApprovedNodeScope(store, GOAL_ID))
      .toEqual({ approvalRef: `approval:${RUN_ID}`, scope: [SEALED_EXECUTION_NODE] });

    const closed = send(
      store, envelope("goal.close", store.getAggregateVersion(GOAL_ID), acceptancePayload()));

    expect(label(closed)).toBe("GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED@DAEMON_PREREQUISITE");
    expect(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID)).toMatchObject({
      code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      layer: "DAEMON_PREREQUISITE",
      message: "no Foundation receipt proves the legacy approved node",
      ok: false,
    });
    expect(goalLifecycle(store)).not.toBe("COMPLETED");
  }, 90_000);

  /**
   * THE SCOPE IS NAMED, AND IT NAMES THE RIGHT NODES.
   *
   * Asserted by SET EQUALITY on the whole record, never by `scope.length`: a scope of the right
   * size naming the wrong node would send `goal-qualification.ts:163` walking receipts that
   * belong to nobody, and — because a node with no receipt falls through to the live leg — could
   * still close the goal against evidence it never had. `approvalRef` is asserted alongside it
   * because the mint derives both from the same run identity.
   */
  it("names the sealed revision's execution-bearing nodes as the approved node scope", () => {
    const store = intentApprovedWorld("cmd-intent-approve-scope");

    expect(readApprovedNodeScope(store, GOAL_ID))
      .toEqual({ approvalRef: `approval:${RUN_ID}`, scope: [SEALED_EXECUTION_NODE] });
  });

  /**
   * FAIL-CLOSED AT THE CLOSE IS UNCHANGED: an approved node the live loop never accepted still
   * refuses, and the ACCEPTANCE fence is provably the one that answered.
   *
   * THE DISCRIMINATOR IS THE MESSAGE, and it has to be. `GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED`
   * at `DAEMON_PREREQUISITE` is ALSO what the scope fence answers, so an arm reading the code and
   * the layer alone would have passed before this row shipped — while testing nothing about
   * acceptance at all. `qualifyGoalClosure` carries the exact sentence each fence raises, so the
   * two are told apart; the non-null scope assertion is the second leg of the same proof.
   */
  it("still refuses the close when no review acceptance names the approved node", () => {
    const store = intentApprovedWorld("cmd-intent-approve-unaccepted");
    // The scope fence is SATISFIED — so it cannot be what refuses below.
    expect(readApprovedNodeScope(store, GOAL_ID))
      .toEqual({ approvalRef: `approval:${RUN_ID}`, scope: [SEALED_EXECUTION_NODE] });

    const closed = send(
      store, envelope("goal.close", store.getAggregateVersion(GOAL_ID), acceptancePayload()));

    expect(label(closed)).toBe("GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED@DAEMON_PREREQUISITE");
    // ORDERING, PINNED (task-8bdd14af, after 4b6d2bc2). This world holds NO review acceptance at
    // all, and the arm above holds one naming the approved node exactly; both answer the SAME
    // message, so the legacy Foundation-receipt fence provably PRECEDES the acceptance fence. The
    // acceptance fence's own message is graded where it can still answer — on the contract-bound
    // world of `goals/goal-intent-approved-closure.test.ts`. Reverting `requiresFoundation` would
    // split these two arms apart, which is what makes this assertion load-bearing rather than a
    // restatement of its neighbour.
    expect(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID)).toMatchObject({
      code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      layer: "DAEMON_PREREQUISITE",
      message: "no Foundation receipt proves the legacy approved node",
      ok: false,
    });
  });

  /**
   * `goal.close` REACHES THE GOAL'S OWN AUTHORITY, which is the whole of what this row owns.
   *
   * Before the fix this dispatch died at the SEQUENCE gate with a code that names nothing about
   * goals — the live UnAI symptom. After it, the sequence gate has nothing left to report and the
   * refusal that answers is the goal's own, from the closure vocabulary an operator can act on.
   *
   * THE ANSWER MOVED, AND HERE IS WHY (task-8bdd14af). This arm used to assert the opposite: a
   * NULL scope and a `GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED` refusal. It was written that way on
   * purpose, as a tripwire, because the intent seam then minted
   * `approvedNodeScope: Object.freeze([])` on the reasoning that "an initial-graph approval
   * approves the sealed revision, and there is no durable per-node selection for it to restate" —
   * while `goal-close-prerequisite.ts:87` reads an EMPTY scope as "unknown", and an unknown
   * closure confers nothing. A browser-approved goal was therefore refused forever, one fence
   * deeper than the one task-ebbcbdb4 corrected. The mint now derives the sealed revision's
   * execution-bearing nodes from the graph body its own bodies event names, so the scope is no
   * longer null and the goal's own authority proceeds to the receipt walk instead of stopping at
   * the scope fence.
   *
   * WHAT THIS ARM STILL GUARDS is unchanged: `goal.close` REACHES THE GOAL'S OWN AUTHORITY, past
   * a sequence gate that reports nothing missing. That is asserted on the production reader
   * rather than inferred from the refusal, because more than one authority shares this code and
   * layer. Its `seedReviewAcceptance(store)` setup is kept VERBATIM, and it now carries a second
   * meaning worth having: the default seeds `node-1`, which is NOT the sealed revision's node, so
   * this world proves an acceptance naming a node OUTSIDE the approved scope confers nothing. The
   * accepted close — acceptance on the node the scope actually names — is the arm above.
   */
  it("lets goal.close past the sequence gate, where the GOAL's own authority answers", () => {
    const store = intentApprovedWorld();
    seedReviewAcceptance(store);
    expect(SEALED_EXECUTION_NODE).not.toBe("node-1");
    // The sequence gate is SATISFIED — asserted on the production reader, not inferred from the
    // refusal, because the fence below reuses this same code and layer for its own reasons.
    expect(missingPrerequisites(readDurableLedger(store, PROJECT_ID), "goal.close")).toEqual([]);

    const closed = send(
      store, envelope("goal.close", store.getAggregateVersion(GOAL_ID), acceptancePayload()));

    expect(label(closed)).toBe("GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED@DAEMON_PREREQUISITE");
    expect(readApprovedNodeScope(store, GOAL_ID))
      .toEqual({ approvalRef: `approval:${RUN_ID}`, scope: [SEALED_EXECUTION_NODE] });
  });

  it("accepts repository.publish on a goal approved through approval.decide_intent", () => {
    const store = intentApprovedWorld("cmd-intent-approve-publish");

    const published = send(store, envelope(
      "repository.publish", 0,
      { approval: FIXTURE_PUBLICATION_APPROVAL, goalId: GOAL_ID, remoteUrl: "https://github.com/fixture/repo.git" }, "cmd-publish",
    ));

    expect(published.ok, published.ok ? "" : `${published.code}@${published.refusedBy}`).toBe(true);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("repository.publish")).toBe(true);
  });

  it("still refuses goal.close at DAEMON_PREREQUISITE when NEITHER approval kind is committed", () => {
    const store = unapprovedWorld();
    const ledger = readDurableLedger(store, PROJECT_ID);
    expect(ledger.kinds.has("approval.decide")).toBe(false);
    expect(ledger.kinds.has("approval.decide_intent")).toBe(false);
    const before = decisionCount(store);

    const closed = send(store, envelope("goal.close", 2, acceptancePayload()));

    // The gate is CORRECTED, not REMOVED: the code and the LAYER are both pinned, because three
    // layers can refuse here and a goal-shaped refusal would mean the sequence gate never ran.
    expect(closed.ok).toBe(false);
    if (closed.ok) throw new Error("expected refusal");
    expect(closed.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
    expect(closed.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
  });

  /**
   * THE PUBLISH FAIL-CLOSED ARM NEEDS A DISCRIMINATOR, and this is not a hypothetical.
   *
   * Neutering `unmetPrerequisites` to report nothing missing left this arm GREEN when it was
   * first written to read the code alone (drill, worker-2739fee7): `publishRepository`
   * (publish-services.ts:86 and :89) answers BOOTSTRAP_PREREQUISITE_MISSING at
   * DAEMON_PREREQUISITE for a goal whose lifecycle is not publishable — the SAME code, the SAME
   * layer. One added layer answered first and the arm stopped testing its subject while staying
   * green. The `missingPrerequisites` assertion below is what makes it bite: it names the
   * SEQUENCE gate as the authority with something to say.
   */
  it("still refuses repository.publish at DAEMON_PREREQUISITE when NEITHER kind is committed", () => {
    const store = unapprovedWorld();
    const before = decisionCount(store);

    const published = send(store, envelope(
      "repository.publish", 0,
      { approval: FIXTURE_PUBLICATION_APPROVAL, goalId: GOAL_ID, remoteUrl: "https://github.com/fixture/repo.git" }, "cmd-publish",
    ));

    expect(published.ok).toBe(false);
    if (published.ok) throw new Error("expected refusal");
    expect(missingPrerequisites(readDurableLedger(store, PROJECT_ID), "repository.publish"))
      .toEqual(["approval.decide"]);
    expect(published.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
    expect(published.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
  });

  it("names the PRIMARY approval kind as missing, never the alternative", () => {
    const store = unapprovedWorld();
    const ledger = readDurableLedger(store, PROJECT_ID);

    // The refusal response carries no missing-kind detail, so the STABLE MEMBER KIND is read off
    // the production reader itself. The control room parses `missing` as plain strings
    // (live/live-board-feed.ts:118-127); leaking `approval.decide_intent` here would rename the
    // board's BLOCKED card after an act no operator can perform on a project that never paired.
    expect(missingPrerequisites(ledger, "goal.close")).toEqual(["approval.decide"]);
    expect(missingPrerequisites(ledger, "repository.publish")).toEqual(["approval.decide"]);
  });

  /**
   * THE ASYMMETRY THE WIDENING INTRODUCES, MEASURED RATHER THAN ASSUMED.
   *
   * `approval.decide` has no REJECT branch at all (PLANNING_HANDLERS, planning-services.ts:341),
   * but `approval.decide_intent` does, and a rejection "is a human decision, not an error path"
   * that "commits through the same one-decision seam" (approval-intent-rejection.ts:18-24). So a
   * REJECTED browser approval DOES put `approval.decide_intent` in the committed set and DOES
   * satisfy this project-wide sequence gate.
   *
   * That is safe only because the sequence gate was never the per-goal authority: it asks whether
   * the project has been through an approval at all, and each command's OWN fence then answers.
   * This arm pins BOTH answers, so a future change that dropped either would redden here instead
   * of shipping a rejected plan that can be published.
   *
   * THE DISCRIMINATOR IS `missingPrerequisites`, NOT THE REFUSAL CODE. `publishRepository`
   * (publish-services.ts:86 and :89) refuses BOOTSTRAP_PREREQUISITE_MISSING at
   * DAEMON_PREREQUISITE too — the same code and the same layer the sequence gate uses — so an arm
   * that read the code alone could not tell which authority answered, and would stay green if the
   * widening silently stopped working. Asserting the gate reports NOTHING missing is what makes
   * the refusals below provably the second fence's.
   */
  it("admits a REJECTED approval.decide_intent at the sequence gate, and no further", () => {
    const store = unapprovedWorld();
    const rejected = decideIntent(store, "cmd-intent-reject-close", "REJECT");
    expect(rejected.ok, rejected.ok ? "" : `${rejected.code}@${rejected.refusedBy}`).toBe(true);
    const ledger = readDurableLedger(store, PROJECT_ID);
    expect(ledger.kinds.has("approval.decide_intent")).toBe(true);
    // The widening admits a KIND, not a verdict: a rejection satisfies this gate exactly as an
    // approval does. Everything that keeps a rejected plan unpublishable is downstream of here.
    expect(missingPrerequisites(ledger, "goal.close")).toEqual([]);
    expect(missingPrerequisites(ledger, "repository.publish")).toEqual([]);

    const closed = send(
      store, envelope("goal.close", store.getAggregateVersion(GOAL_ID), acceptancePayload()));
    const published = send(store, envelope(
      "repository.publish", 0,
      { approval: FIXTURE_PUBLICATION_APPROVAL, goalId: GOAL_ID, remoteUrl: "https://github.com/fixture/repo.git" }, "cmd-publish",
    ));

    // Neither is accepted. The rejection enabled no execution, so the goal never reached a
    // publishable lifecycle and no acceptance names an approved node.
    expect(label(closed)).toBe("GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED@DAEMON_PREREQUISITE");
    expect(label(published)).toBe("BOOTSTRAP_PREREQUISITE_MISSING@DAEMON_PREREQUISITE");
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("repository.publish")).toBe(false);
    // WHICH FENCE ANSWERED, named rather than inferred, and load-bearing since the mint began
    // deriving a real `approvedNodeScope`: a rejection enables no execution, so there is no
    // `GoalExecutionEnabled` for `readApprovedNodeScope` to read and the closure fence answers on
    // an UNKNOWN scope. A rejection that minted a scope would close this goal, and this is the
    // assertion that would redden.
    expect(readApprovedNodeScope(store, GOAL_ID)).toBeNull();
  });
});


/**
 * THE DAEMON MINTS THE ACTIVATION WITNESS (task-4b9c394d).
 *
 * Before this row `activateProject` read `payload.witness` and handed the CALLER'S OBJECT
 * straight to the core reducer, so any caller could invent `artifact-1` / `backup-1` and the
 * daemon would commit it as DAEMON_VERIFIED authority. Now the payload carries nothing and the
 * daemon assembles the nine keys from its OWN measured receipts.
 *
 * Every arm below names the code AND the layer. Four layers can refuse a `project.activate`
 * and they answer in a fixed order — ingress decode, replay, prerequisites, then this handler —
 * so an arm asserting only "it refused" would go vacuous the moment an earlier layer starts
 * answering (global rail 1).
 */
describe("project.activate mints its own witness and refuses a caller-supplied one", () => {
  const PROJECT_ROOT = join(tmpdir(), "moe-mint-project");
  const STORE_PATH = join(PROJECT_ROOT, "moe.sqlite");
  const HEAD_SHA = "1".repeat(40);
  const BACKUP_SHA = "a".repeat(64);
  const POLICY_SLICE_REF = "b".repeat(64);
  /** Must match the ref `driveThrough` commits via `provider.probe`, not an invented one. */
  const PROBE_REF = "provider-profile-1";
  const CLOCK = "2026-09-04T09:15:00.123Z";
  const BACKUP_PATH = join(PROJECT_ROOT, ".moe-next", "backups", "20260904091500123.sqlite");

  const MEASURE_INPUT: ActivationReceiptInput = {
    agentCommand: "fixture-agent", artifactRoot: PROJECT_ROOT, projectId: PROJECT_ID,
    projectRoot: PROJECT_ROOT, storePath: STORE_PATH,
  };

  /** Deterministic ports, so every expected value below is a KNOWN LITERAL, never a re-derivation. */
  function measurePorts(): ActivationReceiptPorts {
    const present = new Set([STORE_PATH]);
    return nodeActivationReceiptPorts({
      backup: () => Promise.resolve({ byteLength: 2048, ok: true as const, sha256: BACKUP_SHA }),
      committedProbeRef: () => Promise.resolve(PROBE_REF),
      env: {},
      fs: {
        exists: (path: string) => present.has(path),
        mkdir: (path: string) => { present.add(path); },
        readBytes: () => null,
        list: () => [],
        remove: () => undefined,
        stat: (path: string) => (present.has(path) ? { size: 4096 } : null),
      },
      git: (_cwd: string, args: readonly string[]) => Promise.resolve(
        args[1] === "--show-toplevel"
          ? { code: 0, stderr: "", stdout: `${PROJECT_ROOT}
` }
          : { code: 0, stderr: "", stdout: `${HEAD_SHA}
` },
      ),
      installedPolicySliceRefs: () => Promise.resolve([POLICY_SLICE_REF]),
      now: () => new Date(CLOCK),
      // A KNOWN LITERAL like every other port here. The real reader would refuse
      // `fixture-agent` ACTIVATION_PROVIDER_UNMEASURED — correctly, since no such CLI is
      // installed anywhere — and these arms are about the WITNESS the daemon mints, not about
      // which agent this host happens to have.
      providerVersion: () =>
        Promise.resolve({ code: 0, stderr: "", stdout: "fixture-agent 1.0.0\n" }),
      sqliteApplicationId: () => SQLITE_APPLICATION_ID,
    });
  }

  /** The witness as the store actually holds it, decoded from the committed event payload. */
  function committedWitness(store: SqliteEventStore): Record<string, unknown> {
    const decoder = new TextDecoder();
    for (const event of store.readEventsAfter(0n, 1000).items) {
      const body = JSON.parse(decoder.decode(event.payload)) as Record<string, unknown>;
      if (body["kind"] === "ProjectActivated") return body["witness"] as Record<string, unknown>;
    }
    throw new Error("no ProjectActivated event was committed");
  }

  it("commits the MEASURED values, not nine keys of any shape (DoD 1)", async () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const receipts = await measureActivationReceipts(MEASURE_INPUT, measurePorts());

    const outcome = send(store, envelope("project.activate", 2, {}), receipts);

    expect(outcome.ok, JSON.stringify(receipts.members)).toBe(true);
    // EXACT VALUES, each traceable to a port return above. `toEqual` on the whole object is
    // what makes this fail when a member is defaulted rather than measured.
    expect(committedWitness(store)).toEqual({
      artifactPathRef: `source-checkout/${PROJECT_ROOT}@${HEAD_SHA}`,
      backupPathRef: `${BACKUP_PATH}@sha256:${BACKUP_SHA}`,
      credentialRef: "credential/fixture-agent/ungated",
      distributionManifestHash: sha256Hex(`moe-distribution/source-checkout
${HEAD_SHA}
`),
      policyRevisionHash: sha256Hex(`moe-policy-revision
${POLICY_SLICE_REF}
`),
      providerMinimumProfileRef: PROBE_REF,
      signingKeyRef: SIGNING_UNSIGNED_REF,
      storeDriverRef: `store/node-sqlite/${SQLITE_APPLICATION_ID}`,
      truthClass: "DAEMON_VERIFIED",
    });
    // The repository measurement reaches the receipts even though no witness key carries it.
    expect(receipts.repository).toEqual({ headSha: HEAD_SHA, toplevel: PROJECT_ROOT });
    expect(receipts.store).toEqual({ storePath: STORE_PATH });
  });

  it("drives the REAL core reducer with the minted witness and is accepted (DoD 4)", async () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const receipts = await measureActivationReceipts(MEASURE_INPUT, measurePorts());
    const before = decisionCount(store);

    const outcome = send(store, envelope("project.activate", 2, {}), receipts);

    // Acceptance IS the proof that `packages/core`'s unchanged `validActivation` took it: the
    // reducer refuses `PROJECT_COMMAND_ILLEGAL` on a witness that misses its exact nine keys,
    // a non-64-hex digest, or a weak truthClass. Core is not edited by this row.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`${outcome.code} @ ${outcome.refusedBy}`);
    expect(outcome.authority).toBe("DURABLE_DECISION");
    expect(decisionCount(store)).toBe(before + 1);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("project.activate")).toBe(true);
  });

  it("mints a witness core accepts from the fixture receipts every other suite drives", () => {
    const store = openStore();
    driveThrough(store, "project.activate");

    const outcome = send(store, envelope("project.activate", 2, {}));

    expect(outcome.ok).toBe(true);
    // Byte identity with the long-standing fixture constant is what keeps ~60 downstream
    // suites asserting the same durable activation they asserted before the daemon minted it.
    expect(committedWitness(store)).toEqual({ ...ACTIVATION_WITNESS });
  });
});

/**
 * FAIL CLOSED, PER MEMBER (task-4b9c394d, task rail 1).
 *
 * There is no partial witness and no defaulted member: ONE unmeasurable receipt refuses the
 * WHOLE activation with THAT member's own code, and nothing is committed. Every arm asserts the
 * code AND the layer AND that no `ProjectActivated` event exists — asserting only "it refused"
 * would stay green if the ingress or prerequisite layer started answering first (global rail 1).
 */
describe("an unmeasurable receipt refuses the whole activation, committing nothing", () => {
  /** No `ProjectActivated` event at all — the shape a PARTIAL witness would still produce one of. */
  function activationEvents(store: SqliteEventStore): number {
    const decoder = new TextDecoder();
    return store.readEventsAfter(0n, 1000).items.filter((event) => {
      const body = JSON.parse(decoder.decode(event.payload)) as Record<string, unknown>;
      return body["kind"] === "ProjectActivated";
    }).length;
  }

  function refusalOf(outcome: ServiceOutcome): { readonly code: string; readonly layer: string } {
    if (outcome.ok) throw new Error("expected a refusal, got an accepted decision");
    return { code: outcome.code, layer: outcome.refusedBy };
  }

  it("refuses a CALLER-SUPPLIED witness by its own code, at the ingress layer (DoD 2)", () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const before = decisionCount(store);

    // The exact payload the daemon used to REQUIRE, and every browser and seed used to send.
    const outcome = send(
      store, envelope("project.activate", 2, { witness: { ...ACTIVATION_WITNESS } }),
    );

    expect(refusalOf(outcome)).toEqual({
      code: "ACTIVATION_WITNESS_CALLER_SUPPLIED", layer: "DAEMON_INGRESS",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.authority).toBe("NONE");
    // NOTHING COMMITTED.
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("project.activate")).toBe(false);
    expect(activationEvents(store)).toBe(0);
  });

  it("refuses a caller witness even when it is the one the daemon would have minted", () => {
    const store = openStore();
    driveThrough(store, "project.activate");

    // The refusal is about WHO measured, not about whether the values happen to be right.
    // Honouring a witness that merely LOOKS correct would restore the whole product gap.
    const outcome = send(store, envelope("project.activate", 2, activatePayload({})));

    expect(refusalOf(outcome)).toEqual({
      code: "ACTIVATION_WITNESS_CALLER_SUPPLIED", layer: "DAEMON_INGRESS",
    });
    expect(activationEvents(store)).toBe(0);
  });

  it("refuses when the composition measured NOTHING, rather than inventing a witness", () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const before = decisionCount(store);

    // An unwired composition root. Child A defaults its two durable-reader ports to ABSENT on
    // purpose, so this is the honest answer a daemon that forgot to wire them must give.
    const outcome = refusalOf(sendUnmeasured(store, envelope("project.activate", 2, {})));

    expect(outcome).toEqual({
      code: ACTIVATION_RECEIPT_CODES.repository, layer: "DAEMON_ACTIVATION_RECEIPTS",
    });
    expect(decisionCount(store)).toBe(before);
    expect(activationEvents(store)).toBe(0);
  });

  // Driven off the EXPORTED member roster, so a member added to child A joins this sweep
  // automatically instead of silently escaping it.
  const MEMBERS: readonly ActivationReceiptMember[] = [...ACTIVATION_RECEIPT_MEMBERS];

  it("generates one arm per measured member, and there are six of them", () => {
    // A sweep that silently yields zero cases passes while testing nothing (global rail 1).
    expect(MEMBERS).toHaveLength(6);
    expect(new Set(MEMBERS).size).toBe(6);
    expect([...MEMBERS].sort()).toEqual(
      ["backup", "distribution", "policy", "provider", "repository", "store"],
    );
    // Every member has its own distinct code: a shared code could not say WHICH receipt failed.
    expect(new Set(MEMBERS.map((m) => ACTIVATION_RECEIPT_CODES[m])).size).toBe(6);
  });

  it.each(MEMBERS)(
    "refuses the whole activation with %s's own code and writes no partial witness (DoD 3)",
    (member) => {
      const store = openStore();
      driveThrough(store, "project.activate");
      const before = decisionCount(store);

      const outcome = send(
        store, envelope("project.activate", 2, {}), receiptsWithout(member),
      );

      expect(refusalOf(outcome)).toEqual({
        code: ACTIVATION_RECEIPT_CODES[member], layer: "DAEMON_ACTIVATION_RECEIPTS",
      });
      expect(decisionCount(store)).toBe(before);
      expect(readDurableLedger(store, PROJECT_ID).kinds.has("project.activate")).toBe(false);
      // NO PARTIAL WITNESS: not a witness missing one key, not a witness with a defaulted key.
      expect(activationEvents(store)).toBe(0);
    },
  );

  it("still mints when every member IS measured, so the arms above are not vacuously red", () => {
    const store = openStore();
    driveThrough(store, "project.activate");

    // The positive control for the sweep: same store, same envelope, complete receipts.
    const outcome = send(store, envelope("project.activate", 2, {}), FIXTURE_ACTIVATION_RECEIPTS);

    expect(outcome.ok).toBe(true);
    expect(activationEvents(store)).toBe(1);
  });
});
