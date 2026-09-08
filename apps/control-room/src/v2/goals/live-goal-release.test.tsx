import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { LiveSetup } from "../../live/live-config.js";
import { LiveGoalRelease } from "./live-goal-release.js";

/**
 * A CLIENT-SIDE TIMEOUT IS NOT EVIDENCE THE COMMAND DID NOT HAPPEN.
 *
 * MEASURED, not imagined: pull request https://github.com/yaront1111/Moe-NG/pull/32 was opened
 * by the daemon on 2026-09-08 and the browser session that ordered it never rendered the link.
 * `release.decide` runs `publishOnce`, then `gh pr create`, then a `gh pr view` re-read, and
 * against a real remote that takes tens of seconds. The command transport gives up at 15s
 * (`client-transport.ts` DEFAULT_REQUEST_TIMEOUT_MS) and every `/release/read` poll fired into
 * the still-busy daemon aborts at its own 15s (`live-effect-read.ts`), so the card collapsed
 * into "The release evidence could not be read right now." about a command that was SUCCEEDING.
 *
 * THE FIX DOES NOT MAKE AN ABORT MEAN "SUCCESS". It makes it mean "unknown, still waiting",
 * which is what an undelivered round trip has always meant -- `client-transport.ts` says so
 * itself: `delivered` separates "a daemon that refused" from "a daemon that never answered".
 * The refusal vocabulary is untouched, and the two arms in the last describe block are the
 * proof: a DELIVERED refusal still renders its own code with its own layer, verbatim, and the
 * two paths still reach DIFFERENT codes at DIFFERENT layers.
 *
 * EVERYTHING RUNS AT THE COMPONENT LEVEL WITH FAKE TIMERS. The live browser lane opens a real
 * pull request on every run, which is not a thing a test suite may do.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const GOAL_ID = "goal-1";
const SHA = "a".repeat(40);
const DOSSIER = "b".repeat(64);
const PR_URL = "https://github.com/yaront1111/Moe-NG/pull/32";

/** The bound the browser's command transport gives up at, and the bound each read gives up at. */
const TRANSPORT_BOUND_MS = 15_000;
/** How long the real `gh pr create` + `gh pr view` kept the daemon busy: longer than the bound. */
const DAEMON_BUSY_MS = 40_000;

/** The daemon's own offer row, exactly as `affordance-planning-offers.ts` mints it. */
const OFFER = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1",
  commandId: "cmd-release-1",
  commandKind: "release.decide",
  expectedVersion: 3,
  inputSchemaVersion: "moe-bootstrap-command/1",
  targetAggregateId: `release:${GOAL_ID}`,
});
const OFFERED = {
  connection: "CONNECTED", detail: "", offers: [OFFER], outcome: "SURFACE", steps: [],
} as unknown as SurfaceFrame;

type ReceiptSeed = {
  readonly outcome: "RELEASED" | "REFUSED";
  readonly prUrl: string | null;
  readonly refusalCode: string | null;
};

/** The `/release/read` PRESENT body the daemon sends, decoded by the real exact-key decoder. */
function presentBody(receipt: ReceiptSeed | null): Readonly<Record<string, unknown>> {
  return {
    evidence: {
      ancestryMeasured: true,
      criteria: [{
        command: "pnpm test", criterionId: "crit-a", exitCode: "0", gaps: [], landing: SHA,
        nodeKey: "node-a", receiptSha: "c".repeat(40), title: "Criterion A",
      }],
      goalId: GOAL_ID, goalTitle: "Ship the orders screen",
      preview: { decidedAt: "2026-09-06T11:02:44.190Z", decisionId: "decision-preview-1", outcome: "APPROVED", url: null },
      receipt: receipt === null ? null : {
        dossierSha256: DOSSIER, outcome: receipt.outcome, prUrl: receipt.prUrl,
        receiptId: "release-receipt-0123456789", refusalCode: receipt.refusalCode, sha: SHA,
      },
      reviewRounds: [], sha: SHA,
    },
    kind: "PRESENT",
  };
}

const NO_RECEIPT = presentBody(null);
const RELEASED = presentBody({ outcome: "RELEASED", prUrl: PR_URL, refusalCode: null });

/** What `/release/read` answers next. Flipped by the arms to model the daemon's own timeline. */
type ReadMode = { readonly kind: "ABORT" } | { readonly kind: "BODY"; readonly body: unknown };
interface Wire {
  readonly reads: () => number;
  readonly sends: () => number;
  setRead(mode: ReadMode): void;
}

/**
 * ONE FAKE DAEMON for both transports, because the two are genuinely separate in production and
 * a fake that conflated them could not tell the story: `release.decide` goes out over
 * `setup.transport.sendCommand`, while `/release/read` is a bare `fetch` the transport never sees.
 */
function attach(send: () => Promise<unknown>): { readonly setup: LiveSetup; readonly wire: Wire } {
  let mode: ReadMode = { kind: "BODY", body: NO_RECEIPT };
  let reads = 0;
  let sends = 0;
  vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
    if (path !== "/release/read") throw new Error(`unexpected fetch path ${path}`);
    reads += 1;
    // An aborted read REJECTS, exactly as `AbortSignal.timeout` makes it reject in the browser.
    if (mode.kind === "ABORT") throw new Error("simulated read abort at 15s");
    // Read out of the narrowed value here: `mode` is reassigned by the arms, so the narrowing
    // does not survive into the `json` closure below.
    const { body } = mode;
    return { json: async (): Promise<unknown> => body, status: 200 } as unknown as Response;
  }));
  const setup = {
    client: { commands: { "release.decide": (_affordance: unknown, input: Record<string, unknown>) => ({
      envelope: { commandId: OFFER.commandId, kind: "release.decide", payload: input["payload"] }, ok: true,
    }) } },
    headers: { authorization: "Bearer live" }, ok: true, projectId: "project-1",
    projection: "moe.board", sessionCredential: "cred-1", subscriberId: "control-room-1",
    transport: { sendCommand: vi.fn(async (): Promise<unknown> => { sends += 1; return send(); }) },
  } as unknown as LiveSetup;
  return {
    setup,
    wire: { reads: (): number => reads, sends: (): number => sends, setRead: (next: ReadMode): void => { mode = next; } },
  };
}

const settle = async (ms = 0): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

/** Arms the two-click control and confirms it, which is the only way a decide is dispatched. */
async function confirmRelease(): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByTestId("cr.release.button")); });
  expect(screen.getByTestId("cr.release.button").textContent).toContain("Confirm:");
  await act(async () => { fireEvent.click(screen.getByTestId("cr.release.button")); });
}

describe("a decide that outruns the transport bound still shows the operator the PR link", () => {
  /**
   * DoD 1, literally: the decide takes LONGER than the transport bound, and the link appears in
   * the SAME MOUNT with no reload. The no-reload part is asserted three ways that a remount
   * would each break -- the `cr.release.root` DOM NODE is the same object, the operator's typed
   * base branch survives, and the answer note the submit produced is still on screen.
   */
  it("keeps the card, and delivers the link, when the daemon outlasts the 15s abort", async () => {
    // The daemon accepted the command and is opening the pull request; the browser gives up at
    // 15s and reports an UNDELIVERED round trip. Nothing here says the command failed.
    const { setup, wire } = attach(async () => new Promise((resolve) => {
      setTimeout(() => resolve({ code: "TRANSPORT_REQUEST_FAILED", delivered: false, layer: "CONTROL_ROOM_TRANSPORT" }), TRANSPORT_BOUND_MS);
    }));
    render(<LiveGoalRelease frame={OFFERED} goalId={GOAL_ID} setup={setup} />);
    await settle();
    const root = screen.getByTestId("cr.release.root");
    expect(screen.queryByTestId("cr.release.link")).toBeNull();

    // The operator types a base branch, so a remount is visible as its loss.
    fireEvent.change(screen.getByTestId("cr.release.base"), { target: { value: "release-train" } });
    await confirmRelease();
    // From here the daemon is busy with `gh` and every read into it aborts.
    wire.setRead({ kind: "ABORT" });

    // THE DEFECT, ASSERTED AS THE INTERMEDIATE STATE. Two poll cycles pass with the command in
    // flight and succeeding. A card that says the evidence "could not be read right now" here is
    // telling the operator something false, and that sentence is what sent this row to the board.
    await settle(5_000);
    expect(screen.queryByTestId("cr.release.read-refusal")).toBeNull();
    await settle(5_000);
    expect(screen.queryByTestId("cr.release.read-refusal")).toBeNull();
    expect(screen.getByTestId("cr.release.root")).toBe(root);

    // The transport gives up at 15s. The daemon has NOT.
    await settle(TRANSPORT_BOUND_MS);
    expect(screen.queryByTestId("cr.release.read-refusal")).toBeNull();
    await settle(DAEMON_BUSY_MS - TRANSPORT_BOUND_MS);
    expect(screen.queryByTestId("cr.release.read-refusal")).toBeNull();

    // The daemon finishes: the receipt is RELEASED and carries the pull request.
    wire.setRead({ kind: "BODY", body: RELEASED });
    await settle(5_000);
    const link = screen.getByTestId("cr.release.link");
    expect(link.getAttribute("href")).toBe(PR_URL);
    expect(link.textContent).toBe(PR_URL);

    // SAME MOUNT: the identical DOM node, and the operator's own typed value still in it.
    expect(screen.getByTestId("cr.release.root")).toBe(root);
    expect((screen.getByTestId("cr.release.base") as HTMLInputElement).value).toBe("release-train");
    // Exactly one decide left the browser across the whole flow.
    expect(wire.sends()).toBe(1);
  });
});

/** The daemon's own refusal of `release.decide`, at the layer `RELEASE_DECIDE_CODE_LAYER_MAP` maps
 *  that code to. DELIVERED: the round trip completed and this IS the daemon's answer. */
const EVIDENCE_DETAIL = "unverified evidence for: crit-unknown, crit-other";
const DAEMON_REFUSAL = Object.freeze({
  delivered: true,
  response: { ok: false, refusal: { code: "RELEASE_EVIDENCE_INCOMPLETE", detail: EVIDENCE_DETAIL, layer: "DAEMON_PREREQUISITE" } },
  status: 200,
});
/** What `client-transport.ts` returns when the round trip never delivered: its OWN code, its OWN
 *  layer. The daemon may have done the work, may not have; this shape says only "we do not know". */
const TRANSPORT_ABORT = Object.freeze({
  code: "TRANSPORT_REQUEST_FAILED", delivered: false, layer: "CONTROL_ROOM_TRANSPORT",
});

/** The `CODE @ LAYER` string `OutcomeNote` prints inside its Details block, read from the DOM. */
const answerCode = (): string =>
  screen.getByTestId("cr.release.answer").querySelector("code")?.textContent ?? "";

describe("the refusal path is unchanged by the fix", () => {
  /**
   * DoD 2(a). THE ONE WAY THIS FIX COULD DO HARM is by swallowing a real refusal into its
   * "still waiting" state, so this arm is written as though that is what it is hunting: the
   * daemon answers, DELIVERED, with the release vocabulary's own `RELEASE_EVIDENCE_INCOMPLETE`,
   * and the operator must read that code with that layer, verbatim and by exact equality --
   * not "a note rendered", not "it refused".
   *
   * `sends() === 1` is the positive control. With an empty command roster `spendOffer` refuses
   * OFFER_KIND_UNBUILDABLE at a NEARER layer and never reaches the transport, and this arm would
   * then be asserting about a refusal the daemon never sent.
   */
  it("renders a DELIVERED RELEASE_EVIDENCE_INCOMPLETE verbatim, with its layer, and keeps it", async () => {
    const { setup, wire } = attach(async () => DAEMON_REFUSAL);
    render(<LiveGoalRelease frame={OFFERED} goalId={GOAL_ID} setup={setup} />);
    await settle();
    await confirmRelease();

    expect(wire.sends()).toBe(1);
    expect(answerCode()).toBe("RELEASE_EVIDENCE_INCOMPLETE @ DAEMON_PREREQUISITE");
    // And WHAT to go and fix, which is the whole reason the daemon sends a detail.
    expect(screen.getByTestId("cr.release.answer-detail").textContent).toBe(EVIDENCE_DETAIL);

    // STILL THERE after several poll cycles: the fix must not let a later re-render quietly
    // replace a refusal the operator has not read yet.
    await settle(20_000);
    expect(answerCode()).toBe("RELEASE_EVIDENCE_INCOMPLETE @ DAEMON_PREREQUISITE");
  });

  /**
   * DoD 2(a), THE SCOPE HALF. A DELIVERED refusal ends the wait -- the daemon spoke, so the
   * command's fate is KNOWN -- and a read that fails afterwards is once again reported as a
   * failed read. Without this the guard would latch on any submit and blindfold the read path
   * for the rest of the card's life.
   *
   * The read is flipped to aborting from the instant the daemon answers, because that is the
   * only window in which the guard's scope is observable: a successful read would clear the
   * wait by itself and this arm would pass whatever the guard did.
   */
  it("stops waiting once the daemon has ANSWERED, so a later failed read is reported again", async () => {
    let flip = (): void => undefined;
    const { setup, wire } = attach(async () => { flip(); return DAEMON_REFUSAL; });
    flip = (): void => { wire.setRead({ kind: "ABORT" }); };
    render(<LiveGoalRelease frame={OFFERED} goalId={GOAL_ID} setup={setup} />);
    await settle();
    await confirmRelease();
    expect(wire.sends()).toBe(1);

    await settle(5_000);
    // The honest sentence, at the read's own layer, about a read that really did fail.
    expect(screen.getByTestId("cr.release.read-refusal").querySelector("code")?.textContent)
      .toBe("TRANSPORT_REQUEST_FAILED @ CONTROL_ROOM_RELEASE_READ");
  });

  /**
   * DoD 2(b). The two paths reach DIFFERENT codes at DIFFERENT layers, asserted by their literal
   * values in both directions -- neither may contain the other's code or the other's layer. The
   * discriminator is not invented here: `client-transport.ts` returns `delivered: false` with its
   * own `TRANSPORT_REQUEST_FAILED`, and `spendOffer` reports THAT case, and only that case, at
   * `CONTROL_ROOM_TRANSPORT`; a daemon that answered carries the engine's own code and layer.
   *
   * WHICH LAYER ANSWERED is the point. `CONTROL_ROOM_TRANSPORT` is the BROWSER saying it never
   * got an answer. `DAEMON_PREREQUISITE` is the DAEMON saying it looked at the evidence and said
   * no. An operator who could not tell those apart cannot know whether to go and fix a criterion
   * or simply wait.
   */
  it("keeps a transport abort and a daemon refusal at different codes AND different layers", async () => {
    const refusing = attach(async () => DAEMON_REFUSAL);
    render(<LiveGoalRelease frame={OFFERED} goalId={GOAL_ID} setup={refusing.setup} />);
    await settle();
    await confirmRelease();
    const refused = answerCode();
    expect(refusing.wire.sends()).toBe(1);
    cleanup();

    const aborting = attach(async () => new Promise((resolve) => {
      setTimeout(() => resolve(TRANSPORT_ABORT), TRANSPORT_BOUND_MS);
    }));
    render(<LiveGoalRelease frame={OFFERED} goalId={GOAL_ID} setup={aborting.setup} />);
    await settle();
    await confirmRelease();
    await settle(TRANSPORT_BOUND_MS);
    const aborted = answerCode();
    expect(aborting.wire.sends()).toBe(1);

    expect(refused).toBe("RELEASE_EVIDENCE_INCOMPLETE @ DAEMON_PREREQUISITE");
    expect(aborted).toBe("TRANSPORT_REQUEST_FAILED @ CONTROL_ROOM_TRANSPORT");
    expect(aborted).not.toBe(refused);
    // Neither may borrow the other's vocabulary, in either direction.
    expect(aborted).not.toContain("RELEASE_EVIDENCE_INCOMPLETE");
    expect(aborted).not.toContain("DAEMON_PREREQUISITE");
    expect(refused).not.toContain("TRANSPORT_REQUEST_FAILED");
    expect(refused).not.toContain("CONTROL_ROOM_TRANSPORT");
  });
});
