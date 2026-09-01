import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { BOOTSTRAP_COMMAND_KINDS, decodeBootstrapRequestBytes } from "./bootstrap-contracts.js";
import { commitAccepted, missingPrerequisites, readDurableLedger } from "./bootstrap-ledger.js";
import { PREREQUISITE_ALTERNATIVES } from "./bootstrap-sequence.js";
import type { ServiceOutcome } from "./bootstrap-ledger.js";
import {
  ACTIVATION_WITNESS,
  GOAL_CREATE_COMMAND_ID,
  OBSERVATION,
  PROJECT_ID,
  RUN_ID,
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
  sealedPlanningChain,
  send,
} from "./bootstrap-test-fixtures.js";
import { driveTo } from "./bootstrap-journey-fixtures.js";
import { seedActivationWorldWithGatePolicy } from "../activation/activation-world-fixtures.js";
import type { Envelope } from "./bootstrap-test-fixtures.js";
import { scanGlobalEvents } from "../goals/goal-closure-test-fixtures.js";

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

/** The frozen tuple `goal.close` answers on this journey, restated by hand so a code, a layer or
 *  an authority quietly changing is a red rather than a shrug. */
const NO_RECEIPT_REFUSAL = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  code: "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT",
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

    const outcome = send(store, envelope("project.activate", 2, { witness: ACTIVATION_WITNESS }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(outcome.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("project.activate")).toBe(false);
  });

  it("refuses activation carrying no witness, at the ingress layer", () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const before = decisionCount(store);

    const outcome = send(store, envelope("project.activate", 2, {}));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PAYLOAD_INVALID");
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

describe("one durable terminal decision and exact replay (DoD 2)", () => {
  const sequence = bootstrapSequence();

  it("drives every owned command kind, with plan.propose and policy.install twice each", () => {
    // Twelve requests over ten driven kinds: `goal.create_with_source` is exercised through the
    // real registry describe instead of this legacy goal.create journey. TWO kinds repeat, and
    // each repetition is load-bearing rather than incidental: the second `plan.propose` is the
    // finalize terminal, and the second `policy.install` is the RISK-CLASSIFYING slice the
    // finalize terminal now requires (task-a888038d) — without it every sealed run refuses
    // RUN_POLICY_UNCLASSIFIABLE, so the world could not reach approval at all.
    expect(sequence).toHaveLength(12);
    expect(sequence.length).toBe(BOOTSTRAP_COMMAND_KINDS.length + 1);
    expect(new Set(sequence.map((entry) => entry.kind)))
      .toEqual(new Set<string>(
        BOOTSTRAP_COMMAND_KINDS.filter((kind) => kind !== "goal.create_with_source"),
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

        expect(send(store, request)).toMatchObject(NO_RECEIPT_REFUSAL);
        expect(decisionCount(store)).toBe(before);
        // A refusal is not a decision, so the SECOND call re-derives it rather than replaying a
        // row: identical answer, still nothing durable.
        expect(send(store, request)).toMatchObject(NO_RECEIPT_REFUSAL);
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
    driveThrough(store, "project.activate");
    const before = decisionCount(store);
    const head = readDurableLedger(store, PROJECT_ID).aggregates.get(PROJECT_ID);

    const outcome = send(store, envelope("project.activate", 99, {
      witness: ACTIVATION_WITNESS,
    }));

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

    const outcome = send(store, envelope("project.activate", 2, { witness: ACTIVATION_WITNESS }));

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
      envelope("project.activate", 2, { witness: ACTIVATION_WITNESS }, "cmd-project.register"),
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
    expect(readDurableLedger(store, PROJECT_ID).aggregates.get(PROJECT_ID)?.currentVersion)
      .toBe(1);
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

  it("names only real command kinds on both sides of the alternatives table", () => {
    const roster: readonly string[] = BOOTSTRAP_COMMAND_KINDS;
    const entries = Object.entries(PREREQUISITE_ALTERNATIVES);

    // A sweep that generates zero checks passes while testing nothing.
    expect(entries.length).toBeGreaterThan(0);
    let checked = 0;
    for (const [prerequisite, alternatives] of entries) {
      expect({ kind: prerequisite, real: roster.includes(prerequisite) })
        .toEqual({ kind: prerequisite, real: true });
      // A widening is only ever explicit and only ever a NAMED kind: an empty list would admit
      // nothing, and a kind no dispatch serves could never appear in a committed set — but it
      // would also never be caught by a runtime arm that only asked "did it refuse".
      expect(alternatives?.length ?? 0).toBeGreaterThan(0);
      for (const alternative of alternatives ?? []) {
        checked += 1;
        expect({ alternative, of: prerequisite, real: roster.includes(alternative) })
          .toEqual({ alternative, of: prerequisite, real: true });
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
