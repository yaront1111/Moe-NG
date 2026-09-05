import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { RepositoryRemoteOutcome } from "../../live/live-repository-remote.js";
import type { RunGoalView } from "../../live/live-runs.js";
import type { OfferWire } from "../approvals/offer-wire.js";
import { GoalPublish, boundRemoteUrl, landedCommits, publishLine, publishOffer } from "./goal-publish.js";
import { createPublishPort as createRealPublishPort } from "./publish-port.js";
const preparedApproval = { branch: "approved-branch", sha: "b".repeat(40), repositoryId: "c".repeat(64), remoteUrl: "https://github.com/owner/unai.git" };
const createPublishPort = (wire: OfferWire) => createRealPublishPort(wire, async (goalId, remoteUrl) => ({ ok: true,
  goalId, approval: { ...preparedApproval, remoteUrl: remoteUrl ?? preparedApproval.remoteUrl } }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const OFFER = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-pub", commandKind: "repository.publish",
  expectedVersion: 0, inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "publish:goal-1",
});
const FRAME = { connection: "LIVE", offers: [OFFER], outcome: "SURFACE", steps: [] } as unknown as SurfaceFrame;
const NO_OFFER = { connection: "LIVE", offers: [], outcome: "SURFACE", steps: [] } as unknown as SurfaceFrame;

/**
 * The REMOTE frames are the ones recorded off the daemon's own production port in
 * live-repository-remote.test.ts; the same bytes, so the card is driven by what the daemon
 * really answers rather than by a hand-written approximation of it.
 */
const BOUND: RepositoryRemoteOutcome = Object.freeze({
  boundAt: "2026-09-05T04:33:07.118Z", boundBy: "operator-local", readAt: "2026-09-05T04:41:12.503Z",
  remoteUrl: "https://github.com/owner/unai.git", status: "REMOTE" as const,
});
const UNBOUND: RepositoryRemoteOutcome = Object.freeze({
  boundAt: null, boundBy: null, readAt: "2026-09-05T04:41:12.907Z", remoteUrl: null, status: "REMOTE" as const,
});

const goal = (overrides: Partial<RunGoalView> = {}): RunGoalView => ({
  goalId: "goal-1", lifecycle: "EXECUTION_ENABLED",
  nodes: [{
    accepted: { verifierReceiptId: "r" }, claim: null, criterionIds: [], dependsOn: [],
    landing: { branch: "main", code: null, files: ["src/a.ts"], outcome: "COMMITTED", sha: "a".repeat(40) },
    lastActivityAt: null, nodeKey: "node-a", nodeRef: "node-a", objective: "o", receipt: null,
    review: { escalated: false, findings: [], latestRoute: "ACCEPT", rounds: 1, unreadable: false, unsuccessfulRounds: 0, version: 2 },
    sharedKey: false, status: "ACCEPTED",
  }],
  publish: null, run: null, title: "Alpha", ...overrides,
});
const unlanded = (): RunGoalView => {
  const base = goal();
  return { ...base, nodes: base.nodes.map((node) => ({ ...node, landing: null })) };
};

/** A wire that records the payload `publish-port.ts` builds, so the arms can read the bytes. */
function wireWith(answer: unknown): { readonly built: Record<string, unknown>[]; readonly wire: OfferWire } {
  const built: Record<string, unknown>[] = [];
  const wire = {
    client: { commands: { "repository.publish": (affordance: unknown, input: Record<string, unknown>) => {
      built.push({ affordance, ...input });
      return { envelope: { commandId: OFFER.commandId, payload: input["payload"] }, ok: true };
    } } },
    sessionCredential: "cred-1",
    transport: { sendCommand: vi.fn(async () => ({ delivered: true as const, response: answer, status: 200 })) },
  } as unknown as OfferWire;
  return { built, wire };
}
const payloadOf = (built: readonly Record<string, unknown>[]): string =>
  JSON.stringify(built[0]?.["payload"] ?? null);

describe("publishOffer, publishLine, boundRemoteUrl and landedCommits", () => {
  it("finds the goal's own publish offer and words every publish state", () => {
    expect(publishOffer(FRAME, "goal-1")).toBe(OFFER);
    expect(publishOffer(FRAME, "goal-2")).toBeNull();
    expect(publishOffer(null, "goal-1")).toBeNull();
    expect(publishLine(null)).toContain("Not published yet");
    expect(publishLine({ branch: null, code: null, decisionId: "d", outcome: "PENDING", remoteUrl: "https://x/y.git", requestedAt: "t", sha: null, url: null }))
      .toBe("Publishing to https://x/y.git · waiting for the wrapper to push");
    expect(publishLine({ branch: "main", code: null, decisionId: "d", outcome: "PUSHED", remoteUrl: "https://x/y.git", requestedAt: "t", sha: "0123456789abcdef", url: null }))
      .toBe("Pushed 0123456789 on main to https://x/y.git");
    expect(publishLine({ branch: null, code: "GIT_PUSH_FAILED", decisionId: "d", outcome: "REFUSED", remoteUrl: "https://x/y.git", requestedAt: "t", sha: null, url: null }))
      .toBe("Publish refused · GIT_PUSH_FAILED · decide again to retry");
  });

  it("reads the bound url only from a REMOTE frame, and treats unread, unbound and refused alike", () => {
    expect(boundRemoteUrl(BOUND)).toBe("https://github.com/owner/unai.git");
    expect(boundRemoteUrl(UNBOUND)).toBeNull();
    expect(boundRemoteUrl(null)).toBeNull();
    expect(boundRemoteUrl({ code: "REPOSITORY_REMOTE_READ_CAPABILITY_DENIED", layer: "REPOSITORY_REMOTE_READ", status: "REFUSED" })).toBeNull();
    expect(landedCommits(goal())).toStrictEqual([{ nodeKey: "node-a", sha: "a".repeat(40) }]);
    expect(landedCommits(unlanded())).toStrictEqual([]);
    expect(landedCommits(null)).toStrictEqual([]);
  });
});

describe("GoalPublish with a remote already bound", () => {
  it("shows the daemon's exact approved commit and branch before submitting, and keeps ambiguous effects held", async () => {
    const { wire, built } = wireWith({ ok: true });
    render(<GoalPublish frame={FRAME} goal={goal()} goalId="goal-1" port={createPublishPort(wire)} remote={BOUND} />);
    await userEvent.click(screen.getByTestId("cr.publish.button"));
    expect(screen.getByTestId("cr.publish.candidate").textContent).toContain(preparedApproval.sha);
    expect(screen.getByTestId("cr.publish.candidate").textContent).toContain("approved-branch");
    expect(built).toHaveLength(0);
    await userEvent.click(screen.getByTestId("cr.publish.button"));
    await waitFor(() => expect(built).toHaveLength(1));
    expect(built[0]?.["payload"]).toMatchObject({ approval: preparedApproval });
    expect(publishLine({ branch: preparedApproval.branch, code: "PUBLISH_EFFECT_RECONCILIATION_REQUIRED", decisionId: "d",
      outcome: "UNKNOWN", remoteUrl: preparedApproval.remoteUrl, requestedAt: "t", sha: preparedApproval.sha, url: null }))
      .toContain("Repository remains held");
  });
  it("asks for nothing, names the remote and the commits, and sends remoteUrl NULL", async () => {
    const { built, wire } = wireWith({ ok: true });
    render(<GoalPublish frame={FRAME} goal={goal()} goalId="goal-1" port={createPublishPort(wire)} remote={BOUND} />);
    expect(screen.queryByTestId("cr.publish.remote")).toBeNull();
    expect(screen.getByTestId("cr.publish.bound").textContent).toContain("https://github.com/owner/unai.git");
    expect(screen.getByTestId("cr.publish.commits").textContent).toContain("node-a");
    expect(screen.getByTestId("cr.publish.commits").textContent).toContain("aaaaaaaaaa");
    const button = screen.getByTestId("cr.publish.button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Publish to https://github.com/owner/unai.git");
    await userEvent.click(button);
    expect(built).toHaveLength(0);
    expect(button.textContent).toBe("Confirm: push to https://github.com/owner/unai.git");
    await userEvent.click(button);
    await waitFor(() => { expect(screen.getByTestId("cr.publish.answer").textContent).toContain("Recorded."); });
    // BYTE-EXACT through publish-port.ts: the key is present and its value is null, because a
    // MISSING remoteUrl arrives at the daemon as `undefined` and is read as malformed.
    expect(JSON.parse(payloadOf(built))).toEqual({ approval: preparedApproval, goalId: "goal-1", remoteUrl: null });
    expect(built[0]?.["affordance"]).toBe(OFFER);
  });

  it("reveals the field again on Change, and the next publish REBINDS to what was typed", async () => {
    const { built, wire } = wireWith({ ok: true });
    render(<GoalPublish frame={FRAME} goal={goal()} goalId="goal-1" port={createPublishPort(wire)} remote={BOUND} />);
    expect(screen.queryByTestId("cr.publish.remote")).toBeNull();
    await userEvent.click(screen.getByTestId("cr.publish.change"));
    const field = screen.getByTestId("cr.publish.remote") as HTMLInputElement;
    expect(field.value).toBe("");
    await userEvent.type(field, "git@github.com:owner/moved.git");
    await userEvent.click(screen.getByTestId("cr.publish.button"));
    await userEvent.click(screen.getByTestId("cr.publish.button"));
    await waitFor(() => { expect(screen.getByTestId("cr.publish.answer").textContent).toContain("Recorded."); });
    expect(JSON.parse(payloadOf(built))).toEqual({ approval: { ...preparedApproval, remoteUrl: "git@github.com:owner/moved.git" }, goalId: "goal-1", remoteUrl: "git@github.com:owner/moved.git" });
  });
});

describe("GoalPublish with no remote bound", () => {
  it("shows the field once and BINDS what was typed", async () => {
    const { built, wire } = wireWith({ ok: true });
    render(<GoalPublish frame={FRAME} goal={goal()} goalId="goal-1" port={createPublishPort(wire)} remote={UNBOUND} />);
    expect(screen.queryByTestId("cr.publish.bound")).toBeNull();
    const button = screen.getByTestId("cr.publish.button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Bind this remote and publish");
    await userEvent.type(screen.getByTestId("cr.publish.remote"), "https://github.com/o/r.git");
    expect(button.disabled).toBe(false);
    await userEvent.click(button);
    expect(built).toHaveLength(0);
    await userEvent.click(button);
    await waitFor(() => { expect(screen.getByTestId("cr.publish.answer").textContent).toContain("Recorded."); });
    expect(JSON.parse(payloadOf(built))).toEqual({ approval: { ...preparedApproval, remoteUrl: "https://github.com/o/r.git" }, goalId: "goal-1", remoteUrl: "https://github.com/o/r.git" });
  });

  it("does not yank the field away when the bound remote lands mid-keystroke", async () => {
    const { built, wire } = wireWith({ ok: true });
    const port = createPublishPort(wire);
    const { rerender } = render(
      <GoalPublish frame={FRAME} goal={goal()} goalId="goal-1" port={port} remote={UNBOUND} />);
    await userEvent.type(screen.getByTestId("cr.publish.remote"), "https://github.com/o/typed.git");
    // The POLL answers: the project turns out to be bound after all, mid-keystroke.
    rerender(<GoalPublish frame={FRAME} goal={goal()} goalId="goal-1" port={port} remote={BOUND} />);
    const field = screen.getByTestId("cr.publish.remote") as HTMLInputElement;
    expect(field.value, "the typed url must survive the poll").toBe("https://github.com/o/typed.git");
    await userEvent.click(screen.getByTestId("cr.publish.button"));
    await userEvent.click(screen.getByTestId("cr.publish.button"));
    await waitFor(() => { expect(screen.getByTestId("cr.publish.answer").textContent).toContain("Recorded."); });
    // What the operator typed is what is sent - never silently replaced by the remote it replaces.
    expect(JSON.parse(payloadOf(built))).toEqual({ approval: { ...preparedApproval, remoteUrl: "https://github.com/o/typed.git" }, goalId: "goal-1", remoteUrl: "https://github.com/o/typed.git" });
  });

  it("reports the daemon's refusal at its own code and layer", async () => {
    const submit = vi.fn(async () => ({ code: "PUBLISH_REMOTE_UNBOUND", layer: "DAEMON_PREREQUISITE", ok: false as const }));
    render(<GoalPublish frame={FRAME} goal={goal()} goalId="goal-1" port={{ submit,
      prepare: async () => ({ ok: true, goalId: "goal-1", approval: preparedApproval }) }} remote={UNBOUND} />);
    await userEvent.type(screen.getByTestId("cr.publish.remote"), "git@github.com:o/r.git");
    await userEvent.click(screen.getByTestId("cr.publish.button"));
    await userEvent.click(screen.getByTestId("cr.publish.button"));
    await waitFor(() => {
      expect(screen.getByTestId("cr.publish.answer").textContent).toContain("That didn't go through.");
    });
    expect(screen.getByTestId("cr.publish.answer").textContent).toContain("PUBLISH_REMOTE_UNBOUND");
  });
});

describe("GoalPublish with nothing landed", () => {
  it("renders NOTHING AT ALL when the daemon withholds the offer and no publish was ever decided", () => {
    const { container } = render(
      <GoalPublish frame={NO_OFFER} goal={unlanded()} goalId="goal-1" port={null} remote={BOUND} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("cr.publish.root")).toBeNull();
    expect(screen.queryByTestId("cr.publish.button")).toBeNull();
    expect(screen.queryByTestId("cr.publish.remote")).toBeNull();
  });

  it("still shows a decided publish and its receipt link once the offer has lapsed", () => {
    const pushed = goal({ publish: {
      branch: "main", code: null, decisionId: "d", outcome: "PUSHED", remoteUrl: "https://github.com/o/r.git",
      requestedAt: "t", sha: "b".repeat(40), url: "https://github.com/o/r/tree/main",
    } });
    render(<GoalPublish frame={NO_OFFER} goal={pushed} goalId="goal-1" port={null} remote={BOUND} />);
    expect(screen.getByTestId("cr.publish.state").textContent).toBe(`Pushed ${"b".repeat(10)} on main to https://github.com/o/r.git`);
    expect((screen.getByTestId("cr.publish.link") as HTMLAnchorElement).href).toBe("https://github.com/o/r/tree/main");
    expect(screen.queryByTestId("cr.publish.button")).toBeNull();
  });
});

describe("the card keeps NO remote of its own", () => {
  it("has no browser-local read or write left in the source", () => {
    // Assembled rather than spelled, so the repo-wide grep for the retired key stays at zero.
    const retiredKey = ["moe", "publish", "remoteUrl"].join(".");
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "goal-publish.tsx"), "utf8");
    expect(source).not.toContain(retiredKey);
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
  });
});
