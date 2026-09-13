import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createBoardFeed } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { LiveWorkBoard } from "./live-work-board.js";

vi.mock("../../live/live-board-feed.js", async original => ({
  ...await original<typeof import("../../live/live-board-feed.js")>(), createBoardFeed: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const headers = {};
it("uses the workspace frame through loading and refresh without creating a second poll", () => {
  const view = render(<LiveWorkBoard goalId="goal-a" runId="run-a" headers={headers} surface={null} />);
  expect(createBoardFeed).not.toHaveBeenCalled();
  expect(screen.queryByTestId("cr.board.subject")).toBeNull();
  const frame: SurfaceFrame = { connection: "CONNECTED", detail: "", outcome: "SURFACE", offers: [], steps: [],
    planningGoalRefs: { "run-a": "goal-a" } };
  view.rerender(<LiveWorkBoard goalId="goal-a" runId="run-a" headers={headers} surface={frame} />);
  expect(screen.getByTestId("cr.board.subject").textContent).toBe("goal-a");
  view.rerender(<LiveWorkBoard goalId="goal-b" runId="run-b" headers={headers} surface={null} />);
  expect(screen.queryByTestId("cr.board.subject")).toBeNull();
  expect(createBoardFeed).not.toHaveBeenCalled();
});
