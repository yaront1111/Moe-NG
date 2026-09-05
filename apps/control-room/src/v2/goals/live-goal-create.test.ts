import { describe, expect, it, vi } from "vitest";

import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
import type { LiveSetup } from "../../live/live-config.js";
import type { GoalDraft } from "./goal-model.js";
import type { SurfaceReader } from "./live-goal-create.js";
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
      "goal.create is blocked until Activate the project commits. Next step: use the Activate"
      + " project card on this screen; it drives the whole chain from the browser.",
    );
    const twoTokens = frame({
      offers: [],
      steps: [step({
        missing: ["project.activate", "provider.probe"], status: "BLOCKED", version: null,
      })],
    });
    expect(goalCreateRefusal(twoTokens)).toBe(
      "goal.create is blocked until Activate the project and Probe the model provider commits."
      + " Next step: use the Activate project card on this screen; it drives the whole chain"
      + " from the browser.",
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

  /**
   * THE ACCEPTED BANNER IS COPY. It used to be the decision's
   * `${disposition} ${resultCode}` pair - "ACCEPTED COMMITTED" against this stub,
   * and "DECIDED EFFECTS_COMMITTED" against a real daemon - rendered straight
   * into the status region a human reads.
   *
   * Pinned as an EXACT sentence rather than a `not.toContain` on one spelling of
   * the enums, and written out here rather than imported from the module under
   * test: an imported literal is a fixed point a hardcoded-return mutant would
   * satisfy. The shape assertion is the second half - it fails for ANY raw enum
   * pair, including ones this stub does not produce.
   */
  it("reports an accepted create in plain words that name the goal", async () => {
    const sent: SentEnvelope[] = [];
    const result = await createGoalDispatcher(setupWith(sent), () => frame())(DRAFT);
    expect(result.ok).toBe(true);
    expect(result.report).toBe("Goal created: Second goal");
    expect(result.report).not.toMatch(/^[A-Z_]+ [A-Z_]+$/u);
  });
});

/**
 * task-9ade7f88 - THE PREREQUISITE THAT COMMITTED BETWEEN THE POLL AND THE CLICK.
 *
 * The frame the dispatcher reads is a 2000 ms poll (live-goals.tsx), so an operator
 * who activates the project and immediately opens New Goal was refused against a
 * PRE-ACTIVATION surface - and never told otherwise, because the report is a one-shot
 * submit result rather than a polled one. The fix re-reads /affordances/read once on
 * the refusal path and decides on THAT frame.
 *
 * These arms drive the sequence through the INJECTED reader, never by timing: a 2 s
 * race can pass an e2e run by luck, so a green browser run is not evidence the defect
 * is closed. The refusal SENTENCES are written out here rather than imported from the
 * module under test, following this file's own rule at "reports an accepted create":
 * an imported literal is a fixed point a hardcoded-return mutant would satisfy.
 */

const BLOCKED_ON_ACTIVATE = "goal.create is blocked until Activate the project commits."
  + " Next step: use the Activate project card on this screen; it drives the whole chain"
  + " from the browser.";
const BLOCKED_ON_PROBE = "goal.create is blocked until Probe the model provider commits."
  + " Next step: use the Activate project card on this screen; it drives the whole chain"
  + " from the browser.";

/** The pre-activation surface the 2 s poll is still holding. */
function blockedOn(missing: string): SurfaceFrame {
  return frame({ offers: [], steps: [step({ missing: [missing], status: "BLOCKED", version: null })] });
}

/** Counts its calls so an arm can prove the happy path never re-reads. */
function readerOf(frames: SurfaceFrame[]): { calls: number; read: SurfaceReader } {
  const reader = {
    calls: 0,
    read: (): Promise<SurfaceFrame> => {
      const next = frames[reader.calls] ?? frames[frames.length - 1];
      reader.calls += 1;
      return Promise.resolve(next as SurfaceFrame);
    },
  };
  return reader;
}

describe("live goal.create dispatch re-reads the surface before refusing", () => {
  it("dispatches when the prerequisite committed after the poll that fed the frame", async () => {
    const sent: SentEnvelope[] = [];
    const setup = setupWith(sent);
    const reader = readerOf([frame()]);
    // Polled BEFORE the activation committed; the re-read sees the committed surface.
    const result = await createGoalDispatcher(
      setup, () => blockedOn("project.activate"), reader.read,
    )(DRAFT);
    // The command reached the transport - not merely "the result was ok".
    expect(sent).toHaveLength(1);
    expect(sent[0]?.commandId).toBe("c1");
    expect(sent[0]?.commandKind).toBe("goal.create");
    expect(result.ok).toBe(true);
    expect(result.report).toBe("Goal created: Second goal");
    expect(reader.calls).toBe(1);
  });

  it("builds the refusal from the re-read frame, not the stale one", async () => {
    const sent: SentEnvelope[] = [];
    const setup = setupWith(sent);
    // Still no offer on the re-read, but a DIFFERENT prerequisite is outstanding, so
    // the two frames produce different sentences and the arm can tell them apart. A
    // fix that re-read for the LOOKUP but refused from the cached frame passes the
    // arm above and still describes a surface that no longer exists; this is the arm
    // that catches it.
    const reader = readerOf([blockedOn("provider.probe")]);
    const result = await createGoalDispatcher(
      setup, () => blockedOn("project.activate"), reader.read,
    )(DRAFT);
    expect(result.ok).toBe(false);
    expect(result.report).toBe(BLOCKED_ON_PROBE);
    expect(result.report).not.toBe(BLOCKED_ON_ACTIVATE);
    expect(sent).toHaveLength(0);
    expect(setup.transport.sendCommand).toHaveBeenCalledTimes(0);
  });

  it("keeps the frame in hand when the re-read rejects, with no new error class", async () => {
    const sent: SentEnvelope[] = [];
    const setup = setupWith(sent);
    const result = await createGoalDispatcher(
      setup,
      () => blockedOn("project.activate"),
      () => Promise.reject(new DOMException("signal timed out", "TimeoutError")),
    )(DRAFT);
    expect(result.ok).toBe(false);
    // The behaviour from before the re-read existed: the daemon's own prerequisite
    // words, NOT a transport error and NOT the not-connected sentence.
    expect(result.report).toBe(BLOCKED_ON_ACTIVATE);
    expect(result.report).not.toContain("TimeoutError");
    expect(sent).toHaveLength(0);
  });

  it("keeps the frame in hand when the re-read answers an unreadable surface", async () => {
    const sent: SentEnvelope[] = [];
    // `frameOfSurface` does NOT throw on a body it cannot read - it answers a
    // LAGGING/UNREADABLE frame - so a bare try/catch would adopt it and the operator
    // would be told the board is disconnected instead of what is actually missing.
    for (const answered of [
      frame({ connection: "LAGGING", detail: "UNREADABLE", offers: [], outcome: "UNREADABLE", steps: [] }),
      frame({ connection: "DISCONNECTED", offers: [], steps: [] }),
    ]) {
      const setup = setupWith(sent);
      const result = await createGoalDispatcher(
        setup, () => blockedOn("project.activate"), readerOf([answered]).read,
      )(DRAFT);
      expect(result.ok).toBe(false);
      expect(result.report).toBe(BLOCKED_ON_ACTIVATE);
      expect(result.report).not.toBe(NOT_CONNECTED_SENTENCE);
    }
    expect(sent).toHaveLength(0);
  });

  it("makes no extra request when the polled frame already carries the offer", async () => {
    const sent: SentEnvelope[] = [];
    const reader = readerOf([frame()]);
    const result = await createGoalDispatcher(setupWith(sent), () => frame(), reader.read)(DRAFT);
    expect(result.ok).toBe(true);
    // The happy path pays nothing: the re-read lives inside the branch that was
    // already about to fail.
    expect(reader.calls).toBe(0);
    expect(sent).toHaveLength(1);
  });
});
