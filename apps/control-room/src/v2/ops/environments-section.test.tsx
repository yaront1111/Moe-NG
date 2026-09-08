import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { EnvironmentHealthView } from "../../live/live-deployments-health.js";
import { mapDeploymentsHealthAnswer } from "../../live/live-deployments-health.js";
import { MIDDOT } from "../glyphs.js";
import { EnvironmentsSection } from "./environments-section.js";
import type { EnvironmentHealthRow } from "./environments-section.js";

/**
 * THE ENVIRONMENTS SECTION.
 *
 * Every fixture below is a BODY WRITTEN HERE put through the production decoder
 * `mapDeploymentsHealthAnswer` rather than a hand-built view object, so no arm can assert against
 * a view shape the decoder would never produce. `frameOf` throws rather than returning a refusal,
 * so a fixture that stops decoding cannot silently become a refusal arm.
 *
 * THE BODY IS WRITTEN HERE, WHICH IS THE LIMIT OF THIS FILE. A decoder arm cannot notice that the
 * route renamed a member, because the body was written to match what the author believed the
 * route serves. That link - the route declaration read off disk, the frame assembled from it -
 * lives in `environments-daemon-frame.test.tsx`, and is where a daemon shape change reds. The
 * arms here vary ONE member at a time to pin rendering, which that file deliberately does not.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const NOW = Date.parse("2026-09-07T10:00:00.000Z");

/** The frame the daemon route serves, with only the members an arm varies overridden. */
function frameOf(overrides: Record<string, unknown>): EnvironmentHealthView {
  const answer = mapDeploymentsHealthAnswer(200, {
    environment: "production",
    incident: null,
    lastError: null,
    lastProbe: { at: "2026-09-07T09:55:00.000Z", latencyMs: 91, status: "SUCCESS" },
    latencySeries: {
      points: [
        { at: "2026-09-07T09:53:00.000Z", latencyMs: 80 },
        { at: "2026-09-07T09:54:00.000Z", latencyMs: 85 },
        { at: "2026-09-07T09:55:00.000Z", latencyMs: 91 },
      ],
      windowMinutes: 60,
    },
    ok: true,
    probeIntervalMs: 60_000,
    probeRefusal: null,
    rollbackSha: null,
    rollbackTarget: null,
    state: "UP",
    ...overrides,
  });
  if (answer.status !== "DEPLOYMENTS_HEALTH") {
    throw new Error(`fixture did not decode: ${answer.code} @ ${answer.layer}`);
  }
  return answer;
}

const rowsOf = (...views: readonly EnvironmentHealthView[]): readonly EnvironmentHealthRow[] =>
  views.map((view) => ({ environment: view.environment, outcome: view }));

const statusOf = (environment: string): string | null =>
  screen.getByTestId(`cr.environments.card.${environment}`).getAttribute("data-status");

describe("the Environments section renders the state the daemon derived", () => {
  it("renders each of UP, DEGRADED and DOWN as the frame states it", () => {
    render(<EnvironmentsSection environments={rowsOf(
      frameOf({ environment: "production", state: "UP" }),
      frameOf({ environment: "staging", state: "DEGRADED" }),
      frameOf({ environment: "preview", state: "DOWN" }),
    )} nowMs={NOW} />);
    expect(statusOf("production")).toBe("UP");
    expect(statusOf("staging")).toBe("DEGRADED");
    expect(statusOf("preview")).toBe("DOWN");
  });

  /**
   * THE ONLY ARM THAT CATCHES A HIDDEN DERIVATION. Both frames below state a status that
   * DISAGREES with what a naive client-side rule over the probe material would compute: the
   * first is stated UP while its only probe FAILED at a long latency, the second is stated DOWN
   * while its only probe SUCCEEDED fast. A consistent fixture would pass either way.
   */
  it("follows the FRAME when the stated status disagrees with the probe material", () => {
    render(<EnvironmentsSection environments={rowsOf(
      frameOf({
        environment: "production",
        lastProbe: { at: "2026-09-07T09:55:00.000Z", latencyMs: 9000, status: "FAILURE" },
        state: "UP",
      }),
      frameOf({
        environment: "staging",
        lastProbe: { at: "2026-09-07T09:55:00.000Z", latencyMs: 4, status: "SUCCESS" },
        state: "DOWN",
      }),
    )} nowMs={NOW} />);
    expect(statusOf("production")).toBe("UP");
    expect(statusOf("staging")).toBe("DOWN");
    expect(screen.getByTestId("cr.environments.card.production.state").textContent).toContain("Up");
    expect(screen.getByTestId("cr.environments.card.staging.state").textContent).toContain("Down");
  });

  it("states when the environment last answered a probe, and that none has been recorded", () => {
    render(<EnvironmentsSection environments={rowsOf(
      frameOf({ environment: "production", lastProbe: { at: "2026-09-07T09:00:00.000Z", latencyMs: 120, status: "SUCCESS" } }),
      frameOf({ environment: "staging", lastProbe: null, state: "DEGRADED" }),
    )} nowMs={NOW} />);
    const answered = screen.getByTestId("cr.environments.card.production.state").textContent ?? "";
    expect(answered).toContain("the last probe answered 1 h ago");
    expect(answered).toContain("120 ms");
    expect(screen.getByTestId("cr.environments.card.staging.state").textContent)
      .toContain("No probe has been recorded yet.");
  });

  it("carries the open incident and the recorded error line verbatim", () => {
    render(<EnvironmentsSection environments={rowsOf(frameOf({
      incident: { id: 7, openedAt: "2026-09-07T09:30:00.000Z" },
      lastError: {
        at: "2026-09-07T09:29:00.000Z", code: "DEPLOY_BUILD_FAILED", layer: "DEPLOY_ENGINE",
        line: "Error: failed to solve: process did not complete successfully",
        source: "DEPLOY_RECEIPT",
      },
      state: "DOWN",
    }))} nowMs={NOW} />);
    expect(screen.getByTestId("cr.environments.card.production.incident").textContent)
      .toBe("Incident 7 opened 30 min ago");
    expect(screen.getByTestId("cr.environments.card.production.error").textContent)
      .toBe("Error: failed to solve: process did not complete successfully");
  });
});

describe("the Environments section keeps its four outcomes distinct", () => {
  it("renders a loading line rather than nothing while the read has not answered", () => {
    render(<EnvironmentsSection environments={null} nowMs={NOW} />);
    expect(screen.getByTestId("cr.environments.loading").textContent).toBe("Reading the environments...");
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
    expect(screen.queryByTestId("cr.environments.list")).toBeNull();
  });

  it("renders an empty state, distinct from the loading line, when nothing is deployed", () => {
    render(<EnvironmentsSection environments={[]} nowMs={NOW} />);
    expect(screen.getByTestId("cr.environments.empty").textContent)
      .toContain("No environment deployed.");
    expect(screen.queryByTestId("cr.environments.loading")).toBeNull();
  });

  it("renders the refusal with its code and layer rather than a blank card", () => {
    render(<EnvironmentsSection environments={[{
      environment: "production",
      outcome: { code: "PROBE_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", status: "REFUSED" },
    }]} nowMs={NOW} />);
    const note = screen.getByTestId("cr.environments.refusal.production");
    expect(note.textContent).toContain("The health of production could not be read right now.");
    expect(note.textContent).toContain("PROBE_STORE_UNAVAILABLE @ DAEMON_INGRESS");
    expect(screen.queryByTestId("cr.environments.card.production")).toBeNull();
  });

  /**
   * AN UNPROBEABLE ENVIRONMENT MUST NOT READ AS HEALTHY. The daemon states DEGRADED for it and
   * mints PROBE_URL_MISSING; the card says so in words and marks itself, and the arm asserts
   * the status is NOT UP so a regression that renders it green is caught by value.
   */
  it("says an environment cannot be probed, and never renders it as up", () => {
    render(<EnvironmentsSection environments={rowsOf(frameOf({
      lastProbe: null,
      probeRefusal: { code: "PROBE_URL_MISSING", layer: "DAEMON_INGRESS", ok: false },
      state: "DEGRADED",
    }))} nowMs={NOW} />);
    const card = screen.getByTestId("cr.environments.card.production");
    expect(card.getAttribute("data-status")).toBe("DEGRADED");
    expect(card.getAttribute("data-status")).not.toBe("UP");
    expect(card.getAttribute("data-unprobeable")).toBe("true");
    expect(screen.getByTestId("cr.environments.card.production.unprobeable").textContent)
      .toBe(`This environment cannot be probed ${MIDDOT} PROBE_URL_MISSING @ DAEMON_INGRESS`);
  });

  it("renders a per-environment reading line while one environment has not answered", () => {
    render(<EnvironmentsSection environments={[
      { environment: "production", outcome: frameOf({}) },
      { environment: "staging", outcome: null },
    ]} nowMs={NOW} />);
    expect(screen.getByTestId("cr.environments.card.staging.loading").textContent)
      .toBe("Reading staging...");
    expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy();
    expect(screen.queryByTestId("cr.environments.card.staging")).toBeNull();
  });
});

/**
 * THE SPARKLINE ON THE CARD. The arms below assert the PLOTTED COUNT, not that an SVG appeared:
 * an SVG that rendered is no evidence it rendered the right span, and a sparkline handed the
 * whole 1440-row ring looks perfectly healthy to a test that only checks the element exists.
 */
describe("the Environments card plots the windowed latency series the daemon sent", () => {
  /** A ring spanning more than the window, windowed the way the daemon windows it. */
  function windowed(windowMinutes: number, spanMinutes: number): {
    readonly points: readonly { readonly at: string; readonly latencyMs: number }[];
    readonly windowMinutes: number;
  } {
    const newest = Date.parse("2026-09-07T09:55:00.000Z");
    const oldestAllowed = newest - (windowMinutes * 60_000);
    const points = Array.from({ length: spanMinutes + 1 }, (_, index) => ({
      at: new Date(newest - ((spanMinutes - index) * 60_000)).toISOString(),
      latencyMs: 50 + index,
    })).filter((point) => Date.parse(point.at) >= oldestAllowed);
    return { points, windowMinutes };
  }

  it("plots exactly the points the frame carries, never the whole ring behind them", () => {
    const series = windowed(60, 240);
    // The fixture must actually EXERCISE the window, or this arm asserts nothing.
    expect(series.points).toHaveLength(61);
    render(<EnvironmentsSection environments={rowsOf(frameOf({ latencySeries: series }))} nowMs={NOW} />);
    const svg = screen.getByTestId("cr.environments.card.production.latency.svg");
    expect(svg.getAttribute("data-point-count")).toBe("61");
    expect((svg.getAttribute("points") ?? svg.querySelector("polyline")?.getAttribute("points") ?? "")
      .trim().split(/\s+/)).toHaveLength(61);
    expect(svg.getAttribute("data-window-minutes")).toBe("60");
  });

  it("follows the window the FRAME states rather than a span of its own", () => {
    const series = windowed(15, 240);
    expect(series.points).toHaveLength(16);
    render(<EnvironmentsSection environments={rowsOf(frameOf({ latencySeries: series }))} nowMs={NOW} />);
    const svg = screen.getByTestId("cr.environments.card.production.latency.svg");
    expect(svg.getAttribute("data-point-count")).toBe("16");
    expect(svg.getAttribute("data-window-minutes")).toBe("15");
  });

  /** DAY ONE: a brand-new environment has no probes, and the card must still be readable. */
  it("renders the empty state and no chart for an environment with no probes yet", () => {
    render(<EnvironmentsSection environments={rowsOf(frameOf({
      latencySeries: { points: [], windowMinutes: 60 }, lastProbe: null, state: "DEGRADED",
    }))} nowMs={NOW} />);
    expect(screen.getByTestId("cr.environments.card.production.latency.empty").textContent)
      .toContain("No latency recorded yet");
    expect(screen.queryByTestId("cr.environments.card.production.latency.svg")).toBeNull();
  });

  /**
   * DoD 6 AT THE CARD. The frame states UP while its series is uniformly terrible, and the frame
   * states DOWN while its series is uniformly fast. A card that coloured, worded or labelled
   * anything off the SERIES would disagree with `data-status` here; a consistent fixture would
   * pass either way, which is why both fixtures are deliberately contradictory.
   */
  it("keeps the stated status even when the SERIES it plots argues the other way", () => {
    render(<EnvironmentsSection environments={rowsOf(
      frameOf({
        environment: "production", state: "UP",
        latencySeries: { points: [
          { at: "2026-09-07T09:54:00.000Z", latencyMs: 30_000 },
          { at: "2026-09-07T09:55:00.000Z", latencyMs: 45_000 },
        ], windowMinutes: 60 },
      }),
      frameOf({
        environment: "staging", state: "DOWN",
        latencySeries: { points: [
          { at: "2026-09-07T09:54:00.000Z", latencyMs: 2 },
          { at: "2026-09-07T09:55:00.000Z", latencyMs: 3 },
        ], windowMinutes: 60 },
      }),
    )} nowMs={NOW} />);
    expect(statusOf("production")).toBe("UP");
    expect(statusOf("staging")).toBe("DOWN");
    expect(screen.getByTestId("cr.environments.card.production.state").textContent).toContain("Up");
    expect(screen.getByTestId("cr.environments.card.staging.state").textContent).toContain("Down");
    // The chart still plots the material verbatim - refusing to derive is not refusing to draw.
    expect(screen.getByTestId("cr.environments.card.production.latency.svg")
      .getAttribute("data-latencies")).toBe("30000,45000");
    expect(screen.getByTestId("cr.environments.card.staging.latency.svg")
      .getAttribute("data-latencies")).toBe("2,3");
  });
});

