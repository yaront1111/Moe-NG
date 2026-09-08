import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeploymentsHealthOutcome } from "../../live/live-deployments-health.js";
import type { DeploymentsOutcome } from "../../live/live-deployments.js";
import type { LiveSetup } from "../../live/live-config.js";
import { EnvironmentsSection } from "../ops/environments-section.js";
import { TARGET_SHA, health, rollbackOffer } from "./incident-frames.fixture.js";
import { LiveNeedsYou } from "./live-needs-you.js";

/**
 * DISMISS IS NOT RESOLVE, asserted in BOTH DIRECTIONS because either one alone permits the bug.
 *
 * DIRECTION 1 - the environment still reads DOWN on the ENVIRONMENTS SURFACE after a dismiss.
 * Asserted against `EnvironmentsSection`, the surface an operator actually looks at, NOT against
 * this queue's own state. A dismiss that clears the card and leaves the operator believing the
 * environment recovered is how an outage gets forgotten.
 *
 * DIRECTION 2 - the card COMES BACK at the next failure threshold. The probe row keeps ONE open
 * incident per outage, closes it on recovery and opens a NEW one, with a NEW id, at the next
 * threshold. This asserts against THAT lifecycle by advancing the health frame the way the
 * daemon would, through the real poll; no re-raise rule is invented here.
 *
 * THE DISMISS DISMISSES THIS INCIDENT, IT DOES NOT MUTE THE ENVIRONMENT. That is the whole
 * difference on the second outage, and direction 2 is what pins it. Both arms run through
 * `LiveNeedsYou` - the production composition - so the dismissal travels the real path: the
 * card's button, the queue's dismissal set, `deriveNeedsYou`.
 */

const KEY = "production#7";
const CARD = `cr.needsyou.item.incident.${KEY}`;
const NOW = Date.parse("2026-09-08T03:00:00.000Z");

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => { vi.useFakeTimers(); sendCommand.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

/**
 * A wire that CAN build and send `deployment.rollback`. That matters: with an empty command
 * roster `spendOffer` refuses OFFER_KIND_UNBUILDABLE before the transport is ever reached, and
 * the "nothing was sent" assertion below would pass because a NEARER layer answered first - the
 * exact way a refusal arm goes quietly vacuous. Measured: with `commands: {}` a deliberately
 * broken dismiss that dispatched a rollback still left `sendCommand` uncalled.
 */
const sendCommand = vi.fn(async () => ({ delivered: true as const, response: { ok: true },
  status: 200 }));
const SETUP = {
  client: { commands: { "deployment.rollback": (
    _affordance: unknown, input: Record<string, unknown>,
  ) => ({ envelope: { commandId: "cmd-rollback-1", kind: "deployment.rollback",
    payload: input["payload"] }, ok: true }) } },
  headers: { authorization: "Bearer live" }, ok: true,
  projectId: "project-live-1", projection: "moe.board", sessionCredential: "cred-live-1",
  subscriberId: "control-room-1", transport: { sendCommand },
} as unknown as LiveSetup;

const CATALOG = {
  goals: [{
    brief: { instructions: "i", title: "Alpha" }, goalId: "goal-a",
    planningRunRef: "run-goal-a", truthClass: "DAEMON_VERIFIED",
  }],
  nextCursor: null, outcome: "GOALS",
};
// The daemon DOES offer the rollback here, so the dismiss arms below are not passing merely
// because there was no command to send.
const SURFACE = {
  nextAllowedCommands: [rollbackOffer()], outcome: "SURFACE", planningGoalRefs: {}, steps: [],
};

/** One goal deployed to `production`: the authority the queue enumerates environments from. */
const DEPLOYED: DeploymentsOutcome = {
  environments: [{
    code: null, detail: null, environment: "production", outcome: "DEPLOYED",
    releaseDecision: null, sha: "9".repeat(40), target: "unai.example", time: null,
    url: "https://unai.example",
  }],
  goalRef: "goal-a", releaseDecision: null, sha: "9".repeat(40), status: "DEPLOYMENTS",
};

function stubWire(): void {
  vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
    if (path === "/affordances/read") {
      return { json: async () => SURFACE, status: 200 } as unknown as Response;
    }
    if (path === "/goals/read") {
      return { json: async () => CATALOG, status: 200 } as unknown as Response;
    }
    throw new Error(`unexpected fetch path ${path}`);
  }));
}

const settle = async (ms = 20_000): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

/** Renders the live queue over a health feed the caller advances, exactly as a poll would. */
async function mount(
  feed: { current: DeploymentsHealthOutcome },
  deployments: DeploymentsOutcome = DEPLOYED,
  readHealth?: (environment: string) => Promise<DeploymentsHealthOutcome>,
): Promise<void> {
  stubWire();
  render(
    <LiveNeedsYou
      onOpenBoard={(): void => undefined}
      readCoverage={async (): Promise<never> => { throw new Error("no coverage read"); }}
      readDeployments={async (): Promise<DeploymentsOutcome> => deployments}
      readHealth={readHealth ?? (async (): Promise<DeploymentsHealthOutcome> => feed.current)}
      readPreview={async (): Promise<never> => { throw new Error("no preview read"); }}
      readRelease={async (): Promise<never> => { throw new Error("no release read"); }}
      readRuns={async (): Promise<never> => { throw new Error("no runs read"); }}
      setup={SETUP}
    />,
  );
  await settle();
}

describe("dismissing an incident does not resolve it", () => {
  /**
   * DIRECTION 1. The Environments section is rendered from the SAME decoded health outcome the
   * queue was given. If a dismiss ever reached the health state itself, this card would stop
   * saying DOWN - which is exactly the silent recovery this arm exists to refuse.
   */
  it("leaves the environment reading DOWN on the Environments surface", async () => {
    const outcome = health();
    await mount({ current: outcome });
    expect(screen.getByTestId(CARD)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`cr.needsyou.incident.${KEY}.dismiss`));
    });
    expect(screen.queryByTestId(CARD)).toBeNull();

    // NOTHING WAS SENT. The Environments surface reads the DAEMON, so the only way this queue
    // could make an environment stop reading DOWN is by writing to it. A dismiss that dispatched
    // anything - an acknowledgement, a mute, a rollback - would be caught here.
    expect(sendCommand).not.toHaveBeenCalled();
    // AND THE DECODED FRAME IS UNTOUCHED: the queue holds this exact object, so a dismiss that
    // edited the health state in place would show up as a difference from a pristine decode.
    expect(outcome).toEqual(health());

    render(<EnvironmentsSection
      environments={[{ environment: "production", outcome }]}
      nowMs={NOW}
    />);
    const card = screen.getByTestId("cr.environments.card.production");
    expect(card.getAttribute("data-status")).toBe("DOWN");
    expect(screen.getByTestId("cr.environments.card.production.state").textContent)
      .toContain("Down");
    // The incident is still open there too: dismissing ended a CARD, not an outage.
    expect(screen.getByTestId("cr.environments.card.production.incident").textContent)
      .toContain("Incident 7");
  });

  /**
   * DIRECTION 2. The daemon closes incident 7 on recovery and opens incident 8 at the next
   * three consecutive failures. The dismissal is keyed on the INCIDENT, so it cannot match the
   * new one and the card returns. A dismissal that muted the ENVIRONMENT would stay silent here,
   * and monitoring would have quietly ended.
   */
  it("comes back at the next failure threshold, under the daemon's new incident id", async () => {
    const feed = { current: health() };
    await mount(feed);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`cr.needsyou.incident.${KEY}.dismiss`));
    });
    expect(screen.queryByTestId(CARD)).toBeNull();

    // RECOVERY, then a fresh outage - the lifecycle the probe row states.
    feed.current = health({ incident: null, state: "UP" });
    await settle();
    expect(screen.queryByTestId(CARD)).toBeNull();

    feed.current = health({ incident: { id: 8, openedAt: "2026-09-08T03:02:00.000Z" } });
    await settle();
    const returned = screen.getByTestId("cr.needsyou.item.incident.production#8");
    expect(returned.textContent).toContain("production unhealthy since 2026-09-08T03:02:00.000Z");
    // AND the one that was dismissed stays dismissed: this is a dismissal, not a reset.
    expect(screen.queryByTestId(CARD)).toBeNull();
  });

  it("says on the card itself that dismissing changes nothing about the environment", async () => {
    await mount({ current: health() });
    const note = screen.getByTestId(`cr.needsyou.incident.${KEY}.dismissnote`).textContent ?? "";
    expect(note).toContain("stays down");
    expect(note).toContain("next failure threshold");
  });
});

describe("an armed confirm survives the polls that keep arriving during an incident", () => {
  /**
   * THE POLL IS THE HAZARD. Four feeds tick while an operator is reading this card - the board
   * surface every 2s, the catalog every 2s, the deploy reads every 10s, health every 15s - and
   * each one re-renders the queue. A card whose React key moved on a poll would drop its armed
   * state and silently disarm the operator mid-incident: they would press Confirm and get
   * nothing. The key is `${item.kind}:${decisionKeyOf(item)}` and for an incident that is
   * `INCIDENT:production#7`, which is stable for as long as the incident is.
   */
  it("still names the sha after several poll cycles", async () => {
    const feed = { current: health() };
    await mount(feed);
    fireEvent.click(screen.getByTestId(`cr.needsyou.incident.${KEY}.rollback`));
    expect(screen.getByTestId(`cr.needsyou.incident.${KEY}.confirm`).textContent)
      .toContain(TARGET_SHA);
    await settle(60_000);
    // STILL ARMED, and still naming the same sha: the poll re-rendered the card, not re-keyed it.
    expect(screen.getByTestId(`cr.needsyou.incident.${KEY}.confirm`).textContent)
      .toContain(TARGET_SHA);
    expect(screen.getByTestId(`cr.needsyou.incident.${KEY}.rollback`).textContent)
      .toContain(TARGET_SHA);
  });
});

describe("the queue only asks about environments the deploy record reports DEPLOYED", () => {
  it("asks for no health at all when the only environment refused its deploy", async () => {
    const readHealth = vi.fn(async (): Promise<DeploymentsHealthOutcome> => health());
    await mount({ current: health() }, {
      environments: [{
        code: "DEPLOY_TARGET_MISSING", detail: null, environment: "production",
        outcome: "REFUSED", releaseDecision: null, sha: null, target: null, time: null, url: null,
      }],
      goalRef: "goal-a", releaseDecision: null, sha: null, status: "DEPLOYMENTS",
    }, readHealth);
    expect(readHealth).not.toHaveBeenCalled();
    expect(screen.queryByTestId(CARD)).toBeNull();
  });
});
