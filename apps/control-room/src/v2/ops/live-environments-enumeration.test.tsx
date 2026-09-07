import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { DeploymentsOutcome } from "../../live/live-deployments.js";
import { mapDeploymentsAnswer } from "../../live/live-deployments.js";
import type { DeploymentsHealthOutcome } from "../../live/live-deployments-health.js";
import { mapDeploymentsHealthAnswer } from "../../live/live-deployments-health.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { DEPLOYMENTS_READ_FAILED as THREW, LiveEnvironments } from "./live-environments.js";

/**
 * THE ENUMERATION ITSELF, which is the half that can lie. `readGoalCatalog` drains every page,
 * and each goal read RESOLVES its refusals instead of throwing, so two silent failures are
 * available to this module and to nothing else:
 *
 *   TRUNCATION - reading only the first N goals and reporting the rest as absent. A project whose
 *   sole deployment sits on a later goal then reads "No environment deployed".
 *   DROPPED REFUSALS - skipping the goals that did not answer and rendering the ones that did as
 *   though they were all of them. The outer catch never sees these; only this file does.
 *
 * Both produce a CONFIDENT WRONG ANSWER rather than an error, so every arm below asserts the
 * false state is ABSENT as well as asserting the true one is present, and every refusal arm
 * asserts the ORIGIN code and the ORIGIN layer - the daemon refused, the browser did not.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/** The batch width `live-environments.tsx` paces goal reads at; pinned by the peak-inflight arm. */
const BATCH = 12;
const REFUSAL = Object.freeze({ code: "DEPLOY_LEDGER_UNAVAILABLE", layer: "DAEMON_INGRESS" });

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

const deployedRow = (environment: string): Record<string, unknown> => ({
  code: null,
  detail: null,
  environment,
  migration: {
    backupSha256: null, backupState: null, environment, migrations: null, outcome: null,
    receiptId: null, refusalCode: null, refusalFile: null, refusalLayer: null,
    state: "UNKNOWN", subject: "PROJECT_ENVIRONMENT",
    unknownCode: "MIGRATION_RECEIPT_ABSENT", unknownLayer: "DAEMON_INGRESS",
  },
  outcome: "DEPLOYED",
  releaseDecision: null,
  sha: "c".repeat(40),
  target: "fly",
  time: "2026-09-07T09:00:00.000Z",
  url: "https://example.test",
});

/** A goal that answered, through the production decoder. `rows` empty means nothing deployed. */
function answered(goalRef: string, ...rows: readonly Record<string, unknown>[]): DeploymentsOutcome {
  const answer = mapDeploymentsAnswer(200, {
    environments: rows, goalRef, outcome: "DEPLOYMENTS", releaseDecision: null, sha: "c".repeat(40),
  });
  if (answer.status !== "DEPLOYMENTS") throw new Error(`fixture did not decode: ${answer.code}`);
  return answer;
}

/** A goal that REFUSED, through the same decoder, carrying the daemon own code and layer. */
function refused(): DeploymentsOutcome {
  const answer = mapDeploymentsAnswer(200, { code: REFUSAL.code, layer: REFUSAL.layer });
  if (answer.status !== "REFUSED") throw new Error(`refusal fixture decoded as ${answer.status}`);
  return answer;
}

function healthOf(environment: string): DeploymentsHealthOutcome {
  const answer = mapDeploymentsHealthAnswer(200, {
    environment, incident: null, lastError: null,
    lastProbe: { at: "2026-09-07T09:55:00.000Z", latencyMs: 44, status: "SUCCESS" },
    latencySeries: { points: [{ at: "2026-09-07T09:55:00.000Z", latencyMs: 44 }], windowMinutes: 60 },
    ok: true, probeIntervalMs: 60_000, probeRefusal: null, rollbackSha: null, state: "UP",
  });
  if (answer.status !== "DEPLOYMENTS_HEALTH") throw new Error(`health fixture did not decode: ${answer.code}`);
  return answer;
}

const goalNames = (count: number): readonly string[] =>
  Array.from({ length: count }, (_value, index) => `goal-${String(index)}`);

describe("the deployed set is enumerated from the WHOLE catalog, never a prefix of it", () => {
  it("finds a deployment on a goal past the first batch, and does not call it nothing deployed", async () => {
    const goals = goalNames(BATCH + 1);
    // CONTROL: the sweep really does reach past one batch, so this is not a one-batch case
    // wearing a long catalog. The sole deployment sits on the LAST goal.
    expect(goals.length).toBeGreaterThan(BATCH);
    const last = goals[goals.length - 1] as string;
    const asked: string[] = [];
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf(...goals))}
      readDeploys={(goalRef) => {
        asked.push(goalRef);
        return Promise.resolve(
          goalRef === last ? answered(goalRef, deployedRow("production")) : answered(goalRef),
        );
      }}
      readHealth={(environment) => Promise.resolve(healthOf(environment))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy());
    expect([...asked].sort()).toEqual([...goals].sort());
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
    expect(screen.queryByTestId("cr.environments.incomplete")).toBeNull();
  });

  it("paces the fan-out in batches rather than opening one read per goal at once", async () => {
    const goals = goalNames(BATCH + 1);
    let inFlight = 0;
    let peak = 0;
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf(...goals))}
      readDeploys={async (goalRef) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return answered(goalRef, deployedRow("production"));
      }}
      readHealth={(environment) => Promise.resolve(healthOf(environment))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy());
    // Exactly the batch width: 1 would mean serial, goals.length would mean an unbounded fan-out,
    // and either would make this arm green while the pacing had been removed.
    expect(peak).toBe(BATCH);
  });
});

describe("a goal read that refuses is never dropped from the enumeration", () => {
  it("refuses in the DAEMON own code and layer when every goal read refuses", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1", "goal-2"))}
      readDeploys={() => Promise.resolve(refused())}
      readHealth={(environment) => Promise.resolve(healthOf(environment))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.refusal")).toBeTruthy());
    const said = screen.getByTestId("cr.environments.refusal").textContent ?? "";
    expect(said).toContain(`${REFUSAL.code} @ ${REFUSAL.layer}`);
    // WHICH LAYER REFUSED is the point: relabelling it with this client layer would tell an
    // operator the browser refused a read the daemon refused.
    expect(said).not.toContain("CONTROL_ROOM_ENVIRONMENTS");
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
    expect(screen.queryByTestId("cr.environments.list")).toBeNull();
  });

  it("renders the goals it COULD read, stated as incomplete, when only some refuse", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1", "goal-2"))}
      readDeploys={(goalRef) => Promise.resolve(
        goalRef === "goal-1" ? answered(goalRef, deployedRow("production")) : refused(),
      )}
      readHealth={(environment) => Promise.resolve(healthOf(environment))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy());
    const note = screen.getByTestId("cr.environments.incomplete");
    expect(note.textContent).toContain("1 of 2 goals could not be read");
    expect(note.textContent).toContain(`${REFUSAL.code} @ ${REFUSAL.layer}`);
    expect(note.getAttribute("role")).toBe("alert");
    // The list must not present itself as the whole deployed set.
    expect(screen.getByTestId("cr.environments.kicker").textContent).toContain("list incomplete");
  });

  it("does NOT say nothing is deployed when the goals that refused might hold one", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1", "goal-2"))}
      readDeploys={(goalRef) => Promise.resolve(goalRef === "goal-1" ? answered(goalRef) : refused())}
      readHealth={(environment) => Promise.resolve(healthOf(environment))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.incomplete")).toBeTruthy());
    expect(screen.getByTestId("cr.environments.incomplete").textContent)
      .toContain(`${REFUSAL.code} @ ${REFUSAL.layer}`);
    // The false empty is the whole failure: nothing was found AND one goal never answered.
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
  });

  it("counts a goal read that THREW as a failed goal, not as a blanked surface", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1", "goal-2"))}
      readDeploys={(goalRef) => goalRef === "goal-1"
        ? Promise.resolve(answered(goalRef, deployedRow("production")))
        : Promise.reject(new Error("socket closed"))}
      readHealth={(environment) => Promise.resolve(healthOf(environment))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy());
    // A rejected read used to take the whole sweep down with it, hiding the goal that DID answer.
    const note = screen.getByTestId("cr.environments.incomplete");
    expect(note.textContent).toContain("1 of 2 goals could not be read");
    // The throw carries none of the daemon vocabulary, so the code and layer are this client own.
    expect(note.textContent).toContain(`${THREW} @ CONTROL_ROOM_ENVIRONMENTS`);
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
  });

  it("refuses, rather than reporting an empty list, when every goal read throws", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1", "goal-2"))}
      readDeploys={() => Promise.reject(new Error("socket closed"))}
      readHealth={(environment) => Promise.resolve(healthOf(environment))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.refusal")).toBeTruthy());
    expect(screen.getByTestId("cr.environments.refusal").textContent)
      .toContain(`${THREW} @ CONTROL_ROOM_ENVIRONMENTS`);
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
    expect(screen.queryByTestId("cr.environments.list")).toBeNull();
  });

  it("states NO incompleteness when every goal answered", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1", "goal-2"))}
      readDeploys={(goalRef) => Promise.resolve(answered(goalRef, deployedRow("production")))}
      readHealth={(environment) => Promise.resolve(healthOf(environment))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy());
    // The negative control: a note that rendered unconditionally would make every arm above vacuous.
    expect(screen.queryByTestId("cr.environments.incomplete")).toBeNull();
    expect(screen.getByTestId("cr.environments.kicker").textContent).not.toContain("incomplete");
  });
});
