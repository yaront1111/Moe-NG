import { describe, expect, it, vi } from "vitest";

import type { RuntimeCommandEnvelope } from "@moe/contracts";
import type { SendResult } from "@moe/control-room-client";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { LiveSetup } from "../../live/live-config.js";
import type { GoalDraft } from "./goal-model.js";
import { createGoalDispatcher } from "./live-goal-create.js";

const LOCKED = "AMBIGUOUS_CREATE_RETRY_LOCKED @ CONTROL_ROOM_GOAL_CREATE: retry the unchanged goal before editing or replacing its PRD.";
const UNREADABLE = "UNDELIVERED · TRANSPORT_RESPONSE_UNREADABLE @ CONTROL_ROOM_GOAL_CREATE";
const DRAFT: GoalDraft = { acceptanceCriteria: [], budgetEnvelope: "", outcome: "Create once", title: "One goal" };
const SOURCE = { localSha256: "a".repeat(64), mediaType: "text/markdown" as const, name: "goal.md", size: 6, text: "# Goal" };
const lost: SendResult = { code: "TRANSPORT_REQUEST_FAILED", delivered: false, layer: "CONTROL_ROOM_TRANSPORT" };

function accepted(commandId: string): SendResult {
  return { delivered: true, status: 200, response: {
    ok: true, outcome: "ACCEPTED", decision: {
      commandId, disposition: "REPLAYED", effectId: "durable-effect", resultCode: "EFFECTS_COMMITTED",
    },
  } };
}

function refused(): SendResult {
  return { delivered: true, status: 403, response: {
    ok: false, outcome: "REFUSED", refusal: { code: "SESSION_AUTHORITY_REQUIRED", layer: "DAEMON_AUTHORIZATION" },
  } };
}

function fixture(withSource = false) {
  const kind = withSource ? "goal.create_with_source" : "goal.create";
  let commandId = "command-original";
  const frame = (): SurfaceFrame => ({
    connection: "CONNECTED", detail: "", outcome: "SURFACE", steps: [], offers: [{
      commandEnvelopeVersion: "moe-runtime-command/1", commandId, commandKind: kind,
      expectedVersion: 0, inputSchemaVersion: withSource ? "moe-goal-create-with-source/1" : "moe-goal-create/1",
      targetAggregateId: `goal-${commandId}`,
    }],
  });
  const send = vi.fn<(envelope: RuntimeCommandEnvelope) => Promise<SendResult>>();
  const setup = { headers: {}, sessionCredential: "test-only", transport: { sendCommand: send } } as unknown as LiveSetup;
  const read = vi.fn(async () => frame());
  return {
    dispatch: createGoalDispatcher(setup, frame, read),
    draft: { ...DRAFT, ...(withSource ? { prd: { ...SOURCE } } : {}) },
    refresh: (next = "command-refreshed") => { commandId = next; }, read, send,
  };
}

describe.each([false, true])("exact retry with source=%s", (withSource) => {
  it.each(["request", "response", "body", "throw"])("retains the built bytes after %s ambiguity and an offer refresh", async (failure) => {
    const run = fixture(withSource);
    if (failure === "throw") run.send.mockRejectedValueOnce(new Error("socket closed"));
    else if (failure === "body") run.send.mockResolvedValueOnce({ delivered: true, response: {}, status: 200 });
    else run.send.mockResolvedValueOnce(failure === "request" ? lost : {
      code: "TRANSPORT_RESPONSE_UNREADABLE", delivered: false, layer: "CONTROL_ROOM_TRANSPORT",
    });
    run.send.mockResolvedValueOnce(accepted("command-original"));
    const first = await run.dispatch(run.draft);
    expect(first.ok).toBe(false);
    expect(first.report).toContain(failure === "response" || failure === "body"
      ? "TRANSPORT_RESPONSE_UNREADABLE" : "TRANSPORT_REQUEST_FAILED");
    const original = JSON.stringify(run.send.mock.calls[0]?.[0]);
    run.refresh();
    const second = await run.dispatch({ ...run.draft, acceptanceCriteria: [] });
    expect(second).toMatchObject({ ok: true, commandId: "command-original" });
    expect(JSON.stringify(run.send.mock.calls[1]?.[0])).toBe(original);
    expect(run.send).toHaveBeenCalledTimes(2);
    expect(run.read).toHaveBeenCalledTimes(0);
  });
});

it.each(["title", "source", "filename", "kind"])("refuses changed %s instead of spending a fresh offer", async (change) => {
  const run = fixture(true);
  run.send.mockResolvedValue(lost);
  await run.dispatch(run.draft);
  run.refresh();
  const edited = change === "title" ? { ...run.draft, title: "Another goal" }
    : change === "source" ? { ...run.draft, prd: { ...SOURCE, text: "# Other" } }
      : change === "filename" ? { ...run.draft, prd: { ...SOURCE, name: "renamed.md" } }
      : { ...DRAFT };
  expect(await run.dispatch(edited)).toEqual({ ok: false, report: LOCKED });
  expect(run.send).toHaveBeenCalledTimes(1);
});

it("single-flights concurrent sends and refuses an edited draft while sending", async () => {
  const run = fixture();
  const answer = Promise.withResolvers<SendResult>();
  run.send.mockReturnValue(answer.promise);
  const first = run.dispatch(run.draft);
  const second = run.dispatch({ ...run.draft });
  const edited = run.dispatch({ ...run.draft, title: "Another" });
  try {
    await vi.waitFor(() => expect(run.send).toHaveBeenCalled());
  } finally {
    answer.resolve(accepted("command-original"));
  }
  expect(await edited).toEqual({ ok: false, report: LOCKED });
  expect(await first).toMatchObject({ ok: true });
  expect(await second).toMatchObject({ ok: true });
  expect(run.send).toHaveBeenCalledTimes(1);
});

it("keeps uncertainty after later authorization refusal or an unrelated accepted decision", async () => {
  const run = fixture();
  run.send.mockResolvedValueOnce(lost).mockResolvedValueOnce(refused())
    .mockResolvedValueOnce(accepted("unrelated-command"))
    .mockResolvedValueOnce(accepted("command-original"));
  await run.dispatch(run.draft);
  run.refresh();
  expect(await run.dispatch(run.draft)).toEqual({ ok: false, report: "SESSION_AUTHORITY_REQUIRED @ DAEMON_AUTHORIZATION" });
  expect(await run.dispatch({ ...run.draft, title: "Another" })).toEqual({ ok: false, report: LOCKED });
  expect(await run.dispatch(run.draft)).toEqual({ ok: false, report: UNREADABLE });
  expect(await run.dispatch(run.draft)).toMatchObject({ ok: true, commandId: "command-original" });
  expect(run.send.mock.calls.map(([envelope]) => envelope.commandId)).toEqual(Array(4).fill("command-original"));
});

it.each(["missing", "commandId", "disposition", "resultCode", "effectId"])(
  "does not clear the initial command on accepted evidence with invalid %s", async (field) => {
    const run = fixture();
    const answer = accepted("command-original") as { delivered: true; status: number; response: {
      ok: boolean; decision?: Record<string, string>;
    } };
    if (field === "missing") delete answer.response.decision;
    else if (answer.response.decision !== undefined) answer.response.decision[field] = "";
    run.send.mockResolvedValueOnce(answer).mockResolvedValueOnce(accepted("command-original"));
    expect(await run.dispatch(run.draft)).toEqual({ ok: false, report: UNREADABLE });
    run.refresh();
    expect(await run.dispatch(run.draft)).toMatchObject({ ok: true, commandId: "command-original" });
    expect(run.send.mock.calls.map(([envelope]) => envelope.commandId)).toEqual(["command-original", "command-original"]);
  },
);

it("snapshots getter-backed draft values once before asynchronous preparation", async () => {
  const run = fixture();
  const title = vi.fn().mockReturnValueOnce("One goal").mockReturnValue("Later mutation");
  Object.defineProperty(run.draft, "title", { enumerable: true, get: title });
  run.send.mockResolvedValueOnce(lost).mockResolvedValueOnce(accepted("command-original"));
  await run.dispatch(run.draft);
  expect(title).toHaveBeenCalledTimes(1);
  expect(await run.dispatch({ ...DRAFT })).toMatchObject({ ok: true });
  expect(run.send.mock.calls[0]?.[0].payload["title"]).toBe("One goal");
  expect(run.send.mock.calls[1]?.[0]).toEqual(run.send.mock.calls[0]?.[0]);
});

it.each(["getter", "cycle"])("refuses an unreadable %s draft without exposing its error or locking a fresh draft", async (shape) => {
  const run = fixture();
  if (shape === "getter") Object.defineProperty(run.draft, "title", {
    enumerable: true, get: () => { throw new Error("untrusted getter detail"); },
  });
  else Object.assign(run.draft, { cycle: run.draft });
  await expect(run.dispatch(run.draft)).resolves.toEqual({
    ok: false, report: "GOAL_CREATE_DRAFT_UNREADABLE @ CONTROL_ROOM_GOAL_CREATE",
  });
  expect(run.send).toHaveBeenCalledTimes(0);
  run.send.mockResolvedValueOnce(accepted("command-original"));
  expect(await run.dispatch({ ...DRAFT })).toMatchObject({ ok: true });
});

it("releases an unambiguous refusal and a correlated success for a subsequent fresh goal", async () => {
  const run = fixture();
  run.send.mockResolvedValueOnce(refused()).mockResolvedValueOnce(accepted("command-refreshed"))
    .mockResolvedValueOnce(accepted("command-next"));
  expect(await run.dispatch(run.draft)).toEqual({ ok: false, report: "SESSION_AUTHORITY_REQUIRED @ DAEMON_AUTHORIZATION" });
  run.refresh();
  expect(await run.dispatch({ ...run.draft, title: "Second goal" })).toMatchObject({ ok: true, commandId: "command-refreshed" });
  run.refresh("command-next");
  expect(await run.dispatch({ ...run.draft, title: "Third goal" })).toMatchObject({ ok: true, commandId: "command-next" });
  expect(run.send.mock.calls.map(([envelope]) => envelope.commandId)).toEqual(["command-original", "command-refreshed", "command-next"]);
});

it("does not retain mutable draft or transport envelope aliases", async () => {
  const run = fixture(true);
  run.send.mockResolvedValueOnce(lost).mockResolvedValueOnce(accepted("command-original"));
  await run.dispatch(run.draft);
  const originalBytes = JSON.stringify(run.send.mock.calls[0]?.[0]);
  const firstEnvelope = run.send.mock.calls[0]?.[0] as unknown as { payload: { title: string } };
  try { firstEnvelope.payload.title = "transport mutation"; } catch { /* Frozen builders are also safe. */ }
  run.draft.title = "edited";
  expect(await run.dispatch(run.draft)).toEqual({ ok: false, report: LOCKED });
  expect(await run.dispatch({ ...DRAFT, prd: { ...SOURCE } })).toMatchObject({ ok: true });
  expect(JSON.stringify(run.send.mock.calls[1]?.[0])).toBe(originalBytes);
});
