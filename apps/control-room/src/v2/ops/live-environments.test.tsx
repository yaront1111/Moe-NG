import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { DeploymentsOutcome } from "../../live/live-deployments.js";
import { mapDeploymentsAnswer } from "../../live/live-deployments.js";
import type { DeploymentsHealthOutcome } from "../../live/live-deployments-health.js";
import { mapDeploymentsHealthAnswer } from "../../live/live-deployments-health.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { LiveEnvironments } from "./live-environments.js";

/**
 * THE ENVIRONMENTS SECTION ON THE WIRE. Both served frames go through their PRODUCTION decoders
 * rather than being hand-built, so a daemon-side shape change on either route reds these arms.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const catalogOf = (...goalIds: readonly string[]): GoalCatalogFrame => ({
  connection: "CONNECTED",
  detail: "",
  goals: goalIds.map((goalId) => ({
    binding: { byteLength: 1, contentSha256: "a".repeat(64), sourceAggregateId: "s", sourceRef: "r" },
    brief: null,
    goalId,
    planningRunRef: "run-1",
    truthClass: "HUMAN_APPROVED" as const,
  })),
  outcome: "GOALS" as const,
});

const environmentRow = (environment: string, outcome: "DEPLOYED" | "REFUSED"): Record<string, unknown> => ({
  code: outcome === "REFUSED" ? "DEPLOY_BUILD_FAILED" : null,
  detail: null,
  environment,
  outcome,
  releaseDecision: null,
  sha: outcome === "DEPLOYED" ? "c".repeat(40) : null,
  target: "fly",
  time: outcome === "DEPLOYED" ? "2026-09-07T09:00:00.000Z" : null,
  url: outcome === "DEPLOYED" ? "https://example.test" : null,
});

function deploymentsOf(goalRef: string, ...rows: readonly Record<string, unknown>[]): DeploymentsOutcome {
  const answer = mapDeploymentsAnswer(200, {
    environments: rows, goalRef, outcome: "DEPLOYMENTS", releaseDecision: null, sha: "c".repeat(40),
  });
  if (answer.status !== "DEPLOYMENTS") throw new Error(`deployments fixture did not decode: ${answer.code}`);
  return answer;
}

function healthOf(environment: string, state: string): DeploymentsHealthOutcome {
  const answer = mapDeploymentsHealthAnswer(200, {
    environment, incident: null, lastError: null,
    lastProbe: { at: "2026-09-07T09:55:00.000Z", latencyMs: 44, status: "SUCCESS" },
    ok: true, probeRefusal: null, rollbackSha: null, state,
  });
  if (answer.status !== "DEPLOYMENTS_HEALTH") throw new Error(`health fixture did not decode: ${answer.code}`);
  return answer;
}

describe("the Environments section assembles its list from served reads", () => {
  it("asks for health ONLY for environments the daemon reports DEPLOYED", async () => {
    const asked: string[] = [];
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(
        goalRef, environmentRow("production", "DEPLOYED"), environmentRow("preview", "REFUSED"),
      ))}
      readHealth={(environment) => {
        asked.push(environment);
        return Promise.resolve(healthOf(environment, "UP"));
      }}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy());
    expect(asked).toEqual(["production"]);
    expect(screen.queryByTestId("cr.environments.card.preview")).toBeNull();
  });

  it("dedupes one environment deployed from two goals into a single card", async () => {
    const asked: string[] = [];
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1", "goal-2"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef, environmentRow("production", "DEPLOYED")))}
      readHealth={(environment) => {
        asked.push(environment);
        return Promise.resolve(healthOf(environment, "DEGRADED"));
      }}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy());
    expect(asked).toEqual(["production"]);
    expect(screen.getByTestId("cr.environments.card.production").getAttribute("data-status"))
      .toBe("DEGRADED");
  });

  it("renders the empty state, not a roster of degraded strangers, when nothing is deployed", async () => {
    let askedHealth = false;
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef, environmentRow("production", "REFUSED")))}
      readHealth={(environment) => {
        askedHealth = true;
        return Promise.resolve(healthOf(environment, "DEGRADED"));
      }}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.empty")).toBeTruthy());
    expect(askedHealth).toBe(false);
  });

  it("keeps rendering the loading line while the catalog has not answered", () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => new Promise<GoalCatalogFrame>(() => undefined)}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef))}
      readHealth={(environment) => Promise.resolve(healthOf(environment, "UP"))}
    />);
    expect(screen.getByTestId("cr.environments.loading")).toBeTruthy();
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
  });

  /**
   * A FAILED ENUMERATION MUST NOT READ AS AN EMPTY ONE. Each arm asserts the specific stable
   * code, and asserts the empty state is ABSENT: "no environment deployed" about a project
   * nobody could read is the one sentence this surface must never say.
   */
  it.each([
    ["REFUSED", "ENVIRONMENTS_CATALOG_REFUSED"],
    ["UNDELIVERED", "ENVIRONMENTS_CATALOG_UNDELIVERED"],
    ["UNREADABLE", "ENVIRONMENTS_CATALOG_UNREADABLE"],
  ] as const)("refuses with %s rather than reporting nothing deployed", async (outcome, code) => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve({ ...catalogOf(), outcome })}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef))}
      readHealth={(environment) => Promise.resolve(healthOf(environment, "UP"))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.refusal")).toBeTruthy());
    expect(screen.getByTestId("cr.environments.refusal").textContent)
      .toContain(`${code} @ CONTROL_ROOM_ENVIRONMENTS`);
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
    expect(screen.queryByTestId("cr.environments.list")).toBeNull();
  });

  it("refuses with ENVIRONMENTS_READ_FAILED when a read throws, not with an empty list", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.reject(new Error("offline"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef))}
      readHealth={(environment) => Promise.resolve(healthOf(environment, "UP"))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.refusal")).toBeTruthy());
    expect(screen.getByTestId("cr.environments.refusal").textContent)
      .toContain("ENVIRONMENTS_READ_FAILED @ CONTROL_ROOM_ENVIRONMENTS");
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
  });

  it("carries a per-environment refusal through to the section rather than dropping the row", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef, environmentRow("production", "DEPLOYED")))}
      readHealth={() => Promise.resolve(mapDeploymentsHealthAnswer(200, {
        code: "PROBE_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false,
      }))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.refusal.production")).toBeTruthy());
    expect(screen.getByTestId("cr.environments.refusal.production").textContent)
      .toContain("PROBE_STORE_UNAVAILABLE @ DAEMON_INGRESS");
  });
});
