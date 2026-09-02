import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import type { LiveRefused, LiveSetup } from "../../live/live-config.js";
import { FIXTURE_GOALS_DATA } from "./goals-fixtures.js";
import { GoalsHome } from "./goals-home.js";
import { LiveGoalsHome } from "./live-goals.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The exact bootstrap refusal `resolveLiveSetupFromHandshake` fails closed with
 * (live-handshake.ts:144). Typed as `LiveRefused`, so a code that drifted out of
 * `LIVE_CONFIG_REFUSAL_CODES` would fail the typecheck rather than assert prose
 * this app can never actually produce.
 */
const REFUSED: LiveRefused = Object.freeze({
  code: "LIVE_BOOTSTRAP_UNAVAILABLE",
  detail: "daemon bootstrap unavailable",
  ok: false,
});

/** Enough attached setup to render; the transport is never reached in these arms. */
function attachedSetup(): LiveSetup {
  return {
    client: { commands: {} },
    commandAuthorityPlane: "V1",
    headers: { authorization: "Bearer live" },
    ok: true,
    projectId: "project-live-1",
    projection: "moe.board",
    sessionCredential: "cred-live-1",
    subscriberId: "control-room-1",
    transport: { sendCommand: vi.fn() },
  } as unknown as LiveSetup;
}

it("disables goal creation with the exact backend prerequisite instead of discarding prose", async () => {
  const user = userEvent.setup();
  const create = vi.fn();
  const reason = "Goal creation is unavailable until this daemon persists the operator's goal prose.";
  render(
    <GoalsHome
      createDisabledReason={reason}
      data={FIXTURE_GOALS_DATA}
      initialCreating
      onCreateGoal={create}
      onOpenBoard={vi.fn()}
    />,
  );

  const button = screen.getByTestId("cr.goals.new") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.title).toBe(reason);
  expect(button.textContent).toContain("New goal");
  await user.click(button);
  expect(screen.queryByTestId("cr.goals.newgoal.form")).toBeNull();
  expect(create).not.toHaveBeenCalled();
});

/**
 * THE DIVERGENCE ARM. It renders LiveGoalsHome DIRECTLY with a refused setup and
 * NO `createDisabledReason` prop, so the only thing that can disable the control
 * is the component's own derivation. CordumApp computes a reason of its own
 * (cordum-app.tsx:250-255) and passes it down, which is why the app-level arm at
 * cordum-app.test.tsx:269 passes today with this guard missing entirely - that
 * outer fence is out of the picture here and cannot answer on the component's
 * behalf.
 */
it("refuses goal creation on its own when live bootstrap refused, naming the code", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  const onOpenBoard = vi.fn();

  render(<LiveGoalsHome onOpenBoard={onOpenBoard} setup={REFUSED} />);

  const button = screen.getByTestId("cr.goals.new") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.title).toContain(REFUSED.code);
  expect(button.title).toContain(REFUSED.detail);

  // Matched on its own text node, so the NOT ATTACHED note in the sibling
  // paragraph cannot satisfy this assertion for it.
  const explanation = screen.getByText(/^New goal unavailable/u);
  expect(explanation.textContent).toContain(REFUSED.code);
  expect(explanation.textContent).toContain(REFUSED.detail);
  // The rendered explanation ends with the very reason the control carries -
  // proving one derivation feeds both without respelling it here.
  expect(explanation.textContent?.endsWith(button.title)).toBe(true);

  await user.click(button);
  expect(screen.queryByTestId("cr.goals.newgoal.form")).toBeNull();
  expect(onOpenBoard).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

/**
 * The negative arm: the derivation is CONDITIONAL. An unconditional one would
 * disable create on an attached session and red live-goals.test.tsx:160, which
 * this row does not own.
 */
it("leaves goal creation enabled and the reason undefined when the setup is attached", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => ({
    json: async () => (path === "/goals/read"
      ? { goals: [], nextCursor: null, outcome: "GOALS" }
      : { nextAllowedCommands: [], outcome: "SURFACE", steps: [] }),
    status: 200,
  } as unknown as Response)));
  const user = userEvent.setup();

  render(<LiveGoalsHome onOpenBoard={vi.fn()} setup={attachedSetup()} />);

  const button = screen.getByTestId("cr.goals.new") as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(button.title).toBe("");
  expect(screen.queryByText(/^New goal unavailable/u)).toBeNull();

  await user.click(button);
  expect(await screen.findByTestId("cr.goals.newgoal.form")).toBeTruthy();
});
