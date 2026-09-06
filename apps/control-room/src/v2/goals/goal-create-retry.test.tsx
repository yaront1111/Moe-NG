import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { LiveSetup } from "../../live/live-config.js";
import { deriveGoalCatalog } from "./goal-catalog-model.js";
import { GoalsHome } from "./goals-home.js";
import { createGoalDispatcher, goalCreateDisabledReason } from "./live-goals.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

it.each(["before", "after"] as const)(
  "preserves the exact retry when the slot becomes bound %s the ambiguous answer",
  async (pollTiming) => {
    const user = userEvent.setup();
    const offer = {
      commandId: "cmd-retry", commandKind: "goal.create",
      expectedVersion: 0, targetAggregateId: "goal-retry",
    };
    let frame: SurfaceFrame = {
      connection: "CONNECTED", detail: "", goalCreatePlanningRunRef: "run-retry",
      offers: [offer], outcome: "SURFACE", steps: [],
    };
    const firstAnswer = Promise.withResolvers<Awaited<ReturnType<LiveSetup["transport"]["sendCommand"]>>>();
    const sendCommand = vi.fn<LiveSetup["transport"]["sendCommand"]>()
      .mockReturnValueOnce(firstAnswer.promise)
      .mockResolvedValueOnce({
        delivered: true, status: 200,
        response: {
          decision: {
            commandId: "cmd-retry", disposition: "REPLAYED",
            effectId: "effect-retry", resultCode: "EFFECTS_COMMITTED",
          },
          httpStatus: 200, ok: true, outcome: "ACCEPTED",
        },
      });
    const builder = vi.fn((affordance: Record<string, unknown>, caller: unknown) => ({
      ok: true, envelope: { ...affordance, caller },
    }));
    const setup = {
      client: { commands: { "goal.create": builder } }, sessionCredential: "test-credential",
      transport: { sendCommand },
    } as unknown as LiveSetup;
    const props = {
      data: deriveGoalCatalog(null), initialCreating: true,
      onCreateGoal: createGoalDispatcher(setup, () => frame), onOpenBoard: vi.fn(),
    };
    const rendered = render(<GoalsHome {...props} />);
    const prd = new File(["Keep the original PRD bytes."], "retry.md", { type: "text/markdown" });
    const readText = vi.fn(async () => "Keep the original PRD bytes.");
    Object.defineProperty(prd, "text", { value: readText });
    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Deliver this exact goal");
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), prd);
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(1));

    const bindSlot = (): void => {
      frame = { ...frame, goalCreatePlanningRunRef: null, offers: [], planningGoalRef: "goal-retry" };
      const reason = goalCreateDisabledReason(frame);
      expect(reason).toBeDefined();
      rendered.rerender(<GoalsHome {...props} createDisabledReason={reason} />);
    };
    if (pollTiming === "before") {
      bindSlot();
      expect(screen.queryByTestId("cr.goals.newgoal.form")).not.toBeNull();
      expect((screen.getByTestId("cr.goals.newgoal.create") as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => {
      firstAnswer.resolve({ delivered: false, code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_TRANSPORT" });
    });
    await waitFor(() => expect(screen.getByTestId("cr.goals.newgoal.create").textContent).toBe("Retry unchanged goal"));
    if (pollTiming === "after") bindSlot();

    expect(screen.queryByTestId("cr.goals.newgoal.form")).not.toBeNull();
    const outcome = screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement;
    expect(outcome.value).toBe("Deliver this exact goal");
    expect(outcome.disabled).toBe(true);
    expect(screen.getByTestId("cr.goals.newgoal.prd.file").textContent).toContain("retry.md");
    expect((screen.getByTestId("cr.goals.newgoal.cancel") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("cr.goals.new") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("cr.goals.new").getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));
    await waitFor(() => expect(screen.queryByTestId("cr.goals.newgoal.form")).toBeNull());

    expect(screen.getByTestId("cr.goals.createreport").textContent).toContain("REPLAYED EFFECTS_COMMITTED");
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(sendCommand.mock.calls[1]).toStrictEqual(sendCommand.mock.calls[0]);
    expect(builder.mock.calls[1]?.[0]).toBe(offer);
    expect(readText).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("cr.goals.new") as HTMLButtonElement).disabled).toBe(true);
  },
);
