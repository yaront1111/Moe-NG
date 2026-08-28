import { describe, expect, it, vi } from "vitest";

import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
import type { LiveSetup } from "../../live/live-config.js";
import type { GoalDraft } from "./goal-model.js";
import { createGoalDispatcher, goalCreateOffer, goalCreateRefusal } from "./live-goal-create.js";
import { labelForMissing } from "./work-labels.js";

/**
 * task-9d2d44aa5d0b476a9a355b9492aebe40 - the create route's read of the daemon's
 * surface, and what it tells the operator when there is no create to make.
 *
 * No DOM: these are the two pure readers plus the dispatcher's refusal path. The
 * point of the exact sentences is that every reachable state names a NEXT STEP;
 * "goal.create is not on the affordance surface" is a diagnosis with no
 * instruction, which is what the free agent met in the browser.
 */

const OFFER = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1",
  commandId: "c1",
  commandKind: "goal.create",
  expectedVersion: 0,
  inputSchemaVersion: "moe-goal-create/1",
  targetAggregateId: "goal-c1",
});

function step(overrides: Partial<SurfaceStep> = {}): SurfaceStep {
  return {
    aggregateId: null, claim: null, kind: "goal.create", missing: [],
    status: "READY", version: 0, ...overrides,
  };
}

function frame(overrides: Partial<SurfaceFrame> = {}): SurfaceFrame {
  return {
    connection: "CONNECTED", detail: "", offers: [{ ...OFFER }], outcome: "SURFACE",
    steps: [step({ aggregateId: "goal-c1" })], ...overrides,
  };
}

const DRAFT: GoalDraft = Object.freeze({
  acceptanceCriteria: ["The board lists the new goal."],
  budgetEnvelope: "",
  outcome: "A second durable goal exists.",
  title: "Second goal",
});

interface SentEnvelope {
  readonly commandId: string;
  readonly commandKind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function setupWith(sent: SentEnvelope[]): LiveSetup {
  return {
    client: { commands: {} },
    headers: {},
    ok: true,
    projectId: "project-live-1",
    projection: "moe.board",
    sessionCredential: "cred",
    subscriberId: "control-room-1",
    transport: {
      sendCommand: vi.fn(async (envelope: SentEnvelope) => {
        sent.push(envelope);
        return {
          delivered: true,
          response: { decision: { disposition: "ACCEPTED", resultCode: "COMMITTED" }, ok: true },
        };
      }),
    },
  } as unknown as LiveSetup;
}

const NOT_CONNECTED_SENTENCE = "goal.create is not available: the board is not connected to the"
  + " daemon. Next step: wait for the board to reconnect; if the session expired, pair again from"
  + " the terminal.";

describe("live goal.create surface reading", () => {
  it("returns the daemon's goal.create offer only from a valid SURFACE frame", () => {
    expect(goalCreateOffer(frame())).toMatchObject({ commandId: "c1", targetAggregateId: "goal-c1" });
    expect(goalCreateOffer(frame({ offers: [] }))).toBeNull();
    expect(goalCreateOffer(null)).toBeNull();
    expect(goalCreateOffer(frame({ outcome: "REFUSED" }))).toBeNull();
  });

  it("names the next step when the board is not connected", () => {
    expect(goalCreateRefusal(null)).toBe(NOT_CONNECTED_SENTENCE);
    expect(goalCreateRefusal(frame({ connection: "DISCONNECTED" }))).toBe(NOT_CONNECTED_SENTENCE);
    expect(goalCreateRefusal(frame({ connection: "LAGGING" }))).toBe(NOT_CONNECTED_SENTENCE);
  });

  it("names the missing prerequisite in the daemon's own words when goal.create is BLOCKED", () => {
    // The label is READ from work-labels, not paraphrased: a rename there must
    // travel into the sentence rather than leaving a stale phrase behind.
    expect(labelForMissing("project.activate")).toBe("Activate the project");
    const blocked = frame({
      offers: [],
      steps: [step({ missing: ["project.activate"], status: "BLOCKED", version: null })],
    });
    expect(goalCreateRefusal(blocked)).toBe(
      "goal.create is blocked until Activate the project commits. Next step: finish the project"
      + " bootstrap from the terminal (moe init / demo seed); the browser cannot drive the"
      + " pre-activation chain.",
    );
    const twoTokens = frame({
      offers: [],
      steps: [step({
        missing: ["project.activate", "provider.probe"], status: "BLOCKED", version: null,
      })],
    });
    expect(goalCreateRefusal(twoTokens)).toBe(
      "goal.create is blocked until Activate the project and Probe the model provider commits."
      + " Next step: finish the project bootstrap from the terminal (moe init / demo seed); the"
      + " browser cannot drive the pre-activation chain.",
    );
  });

  it("names the daemon build when a step exists but carries no offer", () => {
    for (const status of ["COMMITTED", "READY"] as const) {
      expect(goalCreateRefusal(frame({ offers: [], steps: [step({ status })] }))).toBe(
        `goal.create is not offered by this daemon (step ${status}). Next step: restart the daemon`
        + " from a build that offers goal.create on every read.",
      );
    }
  });

  it("names the daemon build when the surface carries no goal.create step at all", () => {
    // An older daemon that does not know the kind: still an instruction, never a
    // bare diagnosis, and never a claim about prerequisites nobody reported.
    expect(goalCreateRefusal(frame({ offers: [], steps: [] }))).toBe(
      "goal.create is not offered by this daemon (step ABSENT). Next step: restart the daemon"
      + " from a build that offers goal.create on every read.",
    );
  });
});

describe("live goal.create dispatch", () => {
  it("sends nothing and reports the blocked sentence when the surface carries no offer", async () => {
    const sent: SentEnvelope[] = [];
    const setup = setupWith(sent);
    const blocked = frame({
      offers: [],
      steps: [step({ missing: ["project.activate"], status: "BLOCKED", version: null })],
    });
    const result = await createGoalDispatcher(setup, () => blocked)(DRAFT);
    expect(result.ok).toBe(false);
    expect(result.report).toBe(goalCreateRefusal(blocked));
    expect(sent).toHaveLength(0);
    expect(setup.transport.sendCommand).toHaveBeenCalledTimes(0);
  });

  it("presents the daemon's own identity back to it when the offer is there", async () => {
    const sent: SentEnvelope[] = [];
    const result = await createGoalDispatcher(setupWith(sent), () => frame())(DRAFT);
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.commandId).toBe("c1");
    expect(sent[0]?.commandKind).toBe("goal.create");
    expect(sent[0]?.payload["title"]).toBe("Second goal");
  });
});
