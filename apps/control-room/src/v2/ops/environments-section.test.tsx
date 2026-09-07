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
 * Every fixture below is a REAL SERVED FRAME put through the production decoder
 * `mapDeploymentsHealthAnswer` rather than a hand-built view object, so a daemon-side shape
 * change reds these arms instead of reaching production. `frameOf` throws rather than returning
 * a refusal, so a fixture that stops decoding cannot silently become a refusal arm.
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
    ok: true,
    probeRefusal: null,
    rollbackSha: null,
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
