import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { BOOTSTRAP_COMMAND_KINDS, decodeBootstrapRequestBytes } from "./bootstrap-contracts.js";
import { commitAccepted, readDurableLedger } from "./bootstrap-ledger.js";
import {
  ACTIVATION_WITNESS,
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
  send,
} from "./bootstrap-test-fixtures.js";
import type { Envelope } from "./bootstrap-test-fixtures.js";
import { REVIEW_SCHEMA_VERSION } from "../review/review-contracts.js";
import { runReviewCommand } from "../review/review-services.js";
import { seedVerifierReceipt } from "../review/review-test-fixtures.js";

/**
 * Durability behaviour of the nine bootstrap services: the command-driven sequence (DoD 1),
 * one durable terminal decision with an exact idempotent replay (DoD 2), and the four hostile
 * inputs that must commit nothing (DoD 3).
 *
 * Every refusal assertion names the stable code AND the layer that produced it. Three layers
 * can refuse here — the ingress gate, the daemon's durable-sequence gate, and a core reducer —
 * so asserting only "it refused" would go vacuous the moment an earlier layer starts answering.
 */

afterEach(closeStores);

const encoder = new TextEncoder();

/**
 * Seeds the non-human review decision required before final goal acceptance. The fixture goes
 * through the production review pipeline so the close test cannot pass on a fabricated store
 * row that no real review command could produce.
 */
function acceptReviewedNode(store: SqliteEventStore, nodeRef: string): void {
  const receipt = seedVerifierReceipt(store, nodeRef, PROJECT_ID);
  const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-bootstrap-review-accept-${nodeRef}`,
    correlationId: "corr-bootstrap-review",
    decidedAt: "2026-08-08T00:00:00.000Z",
    expectedVersion: receipt.currentVersion,
    kind: "integration.accept_output",
    payload: { receiptId: receipt.receiptId, subjectRef: nodeRef },
    principalId: "reviewer-1",
    projectId: PROJECT_ID,
    schemaVersion: REVIEW_SCHEMA_VERSION,
  })));
  if (!outcome.ok) throw new Error(`review setup failed for ${nodeRef}: ${outcome.code}`);
}

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

  it("drives every owned command kind exactly once", () => {
    expect(sequence).toHaveLength(10);
    expect(sequence).toHaveLength(BOOTSTRAP_COMMAND_KINDS.length);
    expect(new Set(sequence.map((entry) => entry.kind)))
      .toEqual(new Set<string>(BOOTSTRAP_COMMAND_KINDS));
  });

  it.each(sequence.map((request, index) => [request.kind, index] as const))(
    "%s commits one decision and replays it exactly",
    (kind, index) => {
      const store = openStore();
      driveThrough(store, kind);
      if (kind === "goal.close") acceptReviewedNode(store, "node-1");
      const before = decisionCount(store);

      const request = sequence[index] as Envelope;
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
