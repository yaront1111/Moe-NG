import { readFileSync } from "node:fs";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { mapDesignAnswer } from "../../live/live-design.js";
import type { DesignOutcome } from "../../live/live-design.js";
import { DesignVersionNote, LiveDesignVersionNote } from "./design-version-note.js";

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { cleanup(); });

const TEST_ID = "cr.approve.design-version";

function designAt(version: number): Extract<DesignOutcome, { status: "DESIGN" }> {
  return {
    status: "DESIGN", versions: [1, version],
    record: {
      contractRef: { contractId: "contract-1", revisionDigest: "a".repeat(64), revisionId: "rev-1" },
      goalRef: "goal-1", projectId: "project-1", profile: "typescript-web-app/react-node-postgresql",
      schemaVersion: "moe-design-revision/1", submittedAt: "2026-09-05T09:00:00.000Z", version,
      revision: {
        apiSurface: [{ route: "GET /orders", payload: "{ orders }" }], componentList: ["OrderList"],
        dataModel: [{ entity: "Order", fields: ["id"], relations: ["Customer.id"] }],
        nonFunctional: { auth: "Session cookie", accessibility: "Keyboard support", performance: "p95 200ms" },
        openDecisions: ["Allow exports?"],
        screens: [{ journey: "Read orders", screens: [{ screen: "Orders", states: ["LOADED"] }] }],
      },
    },
  };
}

describe("DesignVersionNote", () => {
  it("names the design version the plan was compiled against", () => {
    render(<DesignVersionNote outcome={designAt(2)} />);
    const note = screen.getByTestId(TEST_ID);
    // BY VALUE: the operator's anchor is the number, so assert the number is in the words.
    expect(note.textContent).toContain("Design version 2");
    expect(note.textContent).toContain("Approving this plan accepts that design");
  });

  it("says a plan was compiled with NO design rather than showing a blank or a zero", () => {
    // The exact refusal the ledger answers when a goal never had a design.
    render(<DesignVersionNote
      outcome={{ status: "REFUSED", code: "DESIGN_REVISION_ABSENT", layer: "LEDGER" }}
    />);
    const note = screen.getByTestId(TEST_ID);
    expect(note.textContent).toContain("compiled with no design");
    // The two failure modes this row exists to prevent, asserted as absences.
    expect(note.textContent).not.toBe("");
    expect(note.textContent).not.toContain("version 0");
    expect(note.textContent).not.toContain("Design version");
  });

  it("says the design step was SKIPPED, with the reason, rather than reading as blank", () => {
    const skipped: DesignOutcome = {
      status: "DESIGN", versions: [1],
      record: {
        ...designAt(1).record,
        revision: { skipped: true, reason: "The change is a copy edit." },
      } as unknown as Extract<DesignOutcome, { status: "DESIGN" }>["record"],
    };
    render(<DesignVersionNote outcome={skipped} />);
    const note = screen.getByTestId(TEST_ID);
    expect(note.textContent).toContain("design step was skipped");
    expect(note.textContent).toContain("The change is a copy edit.");
    expect(note.textContent).not.toContain("Design version");
  });

  it("reports any OTHER refusal with its CODE and LAYER, never as an absent design", () => {
    render(<DesignVersionNote
      outcome={{ status: "REFUSED", code: "DESIGN_READ_CAPABILITY_DENIED", layer: "DAEMON_INGRESS" }}
    />);
    const note = screen.getByTestId(TEST_ID);
    // A read failure is not a fact about the plan: it must NOT read as "no design".
    expect(note.textContent).not.toContain("compiled with no design");
    expect(note.textContent).toContain("could not be read right now");
    expect(note.textContent).toContain("DESIGN_READ_CAPABILITY_DENIED @ DAEMON_INGRESS");
  });

  it("says it is still reading before the answer arrives, never an empty slot", () => {
    render(<DesignVersionNote outcome={null} />);
    expect(screen.getByTestId(TEST_ID).textContent).toContain("Reading which design");
  });
});

describe("LiveDesignVersionNote", () => {
  it("reads through the injected reader and renders the version it answers", async () => {
    await act(async () => {
      render(<LiveDesignVersionNote
        goalRef="goal-1"
        headers={{ "x-moe-session": "sess-1" }}
        planningRunRef="run-1"
        read={() => Promise.resolve(designAt(3))}
      />);
    });
    expect(screen.getByTestId(TEST_ID).textContent).toContain("Design version 3");
  });

  it("reads BY THE PLANNING RUN, so the note names the version that run compiled against", async () => {
    // The provenance is the point: the fold must ask for the design THIS plan run selected,
    // not the goal's newest one. Assert the selector reaches the reader, because a note that
    // silently read the latest revision would tell a human they are accepting a design the
    // plan was never compiled on.
    const seen: { goalRef: string; planningRunRef: string }[] = [];
    await act(async () => {
      render(<LiveDesignVersionNote
        goalRef="goal-1"
        headers={{ "x-moe-session": "sess-1" }}
        planningRunRef="run-7"
        read={(goalRef, planningRunRef) => {
          seen.push({ goalRef, planningRunRef });
          return Promise.resolve(designAt(1));
        }}
      />);
    });
    expect(seen).toEqual([{ goalRef: "goal-1", planningRunRef: "run-7" }]);
    expect(screen.getByTestId(TEST_ID).textContent).toContain("Design version 1");
  });

  it("turns a thrown read into a coded note rather than an empty slot", async () => {
    await act(async () => {
      render(<LiveDesignVersionNote
        goalRef="goal-1"
        headers={{ "x-moe-session": "sess-1" }}
        planningRunRef="run-1"
        read={() => Promise.reject(new Error("network"))}
      />);
    });
    expect(screen.getByTestId(TEST_ID).textContent)
      .toContain("DESIGN_READ_FAILED @ CONTROL_ROOM_GOALS");
  });
});

describe("the note is mounted on the plan fold", () => {
  const source = readFileSync("src/v2/cordum-app.tsx", "utf8");

  it("is imported and rendered with the opened goal and the attached session", () => {
    expect(source).toContain('import { LiveDesignVersionNote } from "./goals/design-version-note.js";');
    expect(source)
      .toContain("<LiveDesignVersionNote goalRef={open.goalId} planningRunRef={planRunId}"
        + " headers={attached.headers} />");
  });

  it("renders INSIDE the plan fold, immediately after the plan card it qualifies", () => {
    // Position is the claim: a version note outside the fold would not be part of the
    // approval the human is giving. Assert the order rather than mere presence.
    const plan = source.indexOf("<ApprovePlan");
    const note = source.indexOf("<LiveDesignVersionNote");
    const foldEnd = source.indexOf("</details>", plan);
    expect(plan).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(plan);
    expect(note).toBeLessThan(foldEnd);
  });

  it("does not edit approve-plan.tsx, which another row owns", () => {
    const approve = readFileSync("src/v2/goals/approve-plan.tsx", "utf8");
    expect(approve).not.toContain("DesignVersionNote");
  });
});

/**
 * REAL DAEMON FRAMES, not a hand-written shape. `design-read-frame.captured.json` holds the
 * two `POST /design/read` bodies a run of tests/e2e/control-room/design-operator.spec.ts
 * captured verbatim from a live daemon: the latest revision (version 2) and the superseded
 * one (version 1). They are decoded here by the PRODUCTION decoder, so a daemon that changed
 * its wire shape reds this file instead of silently drifting from the fixture.
 */
describe("the captured daemon frames", () => {
  const frames = JSON.parse(
    readFileSync("src/v2/goals/design-read-frame.captured.json", "utf8"),
  ) as { readonly latest: unknown; readonly older: unknown };

  it("decode to the version the plan fold then names", () => {
    const outcome = mapDesignAnswer(200, frames.latest);
    expect(outcome.status, JSON.stringify(outcome)).toBe("DESIGN");
    render(<DesignVersionNote outcome={outcome} />);
    expect(screen.getByTestId(TEST_ID).textContent).toContain("Design version 2");
  });

  it("keep the superseded revision readable as version 1, with ITS entity", () => {
    const outcome = mapDesignAnswer(200, frames.older);
    expect(outcome.status).toBe("DESIGN");
    if (outcome.status !== "DESIGN") return;
    expect(outcome.record.version).toBe(1);
    const revision = outcome.record.revision;
    expect("skipped" in revision).toBe(false);
    if ("skipped" in revision) return;
    // The operator's real question is what CHANGED, so the older frame must still carry
    // its own data model rather than the newer one's.
    expect(revision.dataModel.map((entity) => entity.entity)).toContain("ShelfItemV1Marker");
    expect(revision.dataModel.map((entity) => entity.entity)).not.toContain("ShelfItemV2Marker");
  });

  it("are REFUSED by the exact-key decoder once a key is added or removed", () => {
    const body = frames.latest as Readonly<Record<string, unknown>>;
    const record = body["record"] as Readonly<Record<string, unknown>>;
    const extra = mapDesignAnswer(200, { ...body, record: { ...record, extra: "surplus" } });
    expect(extra.status, "an extra key must not decode").toBe("ERROR");
    expect(extra.status === "ERROR" ? extra.code : null).toBe("DESIGN_RESPONSE_INVALID");
    const { version: _dropped, ...missing } = record;
    const short = mapDesignAnswer(200, { ...body, record: missing });
    expect(short.status, "a missing key must not decode").toBe("ERROR");
    expect(short.status === "ERROR" ? short.code : null).toBe("DESIGN_RESPONSE_INVALID");
    // The note must then say it could not READ the design, never that there is none.
    render(<DesignVersionNote outcome={short} />);
    const note = screen.getByTestId(TEST_ID).textContent ?? "";
    expect(note).toContain("DESIGN_RESPONSE_INVALID @ CONTROL_ROOM_LIVE_DESIGN");
    expect(note).not.toContain("compiled with no design");
  });
});
