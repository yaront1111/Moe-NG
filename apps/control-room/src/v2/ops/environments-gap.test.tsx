import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { EnvironmentHealthView } from "../../live/live-deployments-health.js";
import { mapDeploymentsHealthAnswer } from "../../live/live-deployments-health.js";
import { MIDDOT } from "../glyphs.js";
import { EnvironmentsSection } from "./environments-section.js";
import type { EnvironmentsGap } from "./environments-gap.js";

/**
 * A PARTIAL ENUMERATION, AT THE SECTION SEAM. `live-environments-enumeration.test.tsx` asserts
 * the same property at the WIRE seam, where the gap is produced. It is asserted here as well
 * because the two seams fail independently: a section that ignored the prop it is handed would
 * leave those arms green while an operator saw a list that claimed to be whole.
 *
 * The false state is asserted ABSENT in every arm. "No environment deployed" said on the strength
 * of goal reads that never answered is the failure this note exists to prevent, and it is a
 * CONFIDENT wrong answer rather than an error, so nothing else catches it.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const NOW = Date.parse("2026-09-07T10:00:00.000Z");
const GAP: EnvironmentsGap = Object.freeze({
  code: "DEPLOY_LEDGER_UNAVAILABLE",
  goalsFailed: 2,
  goalsTotal: 5,
  layer: "DAEMON_INGRESS",
});

/** The frame the route serves, through the production decoder, so no arm asserts a shape it would refuse. */
function frameOf(environment: string): EnvironmentHealthView {
  const answer = mapDeploymentsHealthAnswer(200, {
    environment, incident: null, lastError: null,
    lastProbe: { at: "2026-09-07T09:55:00.000Z", latencyMs: 91, status: "SUCCESS" },
    latencySeries: { points: [{ at: "2026-09-07T09:55:00.000Z", latencyMs: 91 }], windowMinutes: 60 },
    ok: true, probeIntervalMs: 60_000, probeRefusal: null, rollbackSha: null,
    rollbackTarget: null, state: "UP",
  });
  if (answer.status !== "DEPLOYMENTS_HEALTH") throw new Error(`fixture did not decode: ${answer.code}`);
  return answer;
}

const rows = (...names: readonly string[]): readonly { environment: string; outcome: EnvironmentHealthView }[] =>
  names.map((environment) => ({ environment, outcome: frameOf(environment) }));

describe("a list assembled from goals that could not all be read says so", () => {
  it("states the counts and the ORIGIN code and layer, above the rows it did read", () => {
    render(<EnvironmentsSection environments={rows("production")} incomplete={GAP} nowMs={NOW} />);
    const note = screen.getByTestId("cr.environments.incomplete");
    expect(note.textContent).toContain("2 of 5 goals could not be read");
    // The DAEMON refused; relabelling it with this client layer would name the wrong authority.
    expect(note.textContent).toContain("DEPLOY_LEDGER_UNAVAILABLE @ DAEMON_INGRESS");
    expect(note.getAttribute("role")).toBe("alert");
    // The rows it DID read still render - hiding them would be a second false report.
    expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy();
    expect(screen.getByTestId("cr.environments.kicker").textContent)
      .toBe(`Environments ${MIDDOT} 1 deployed, list incomplete`);
  });

  it("does NOT render the empty state when the list is empty AND incomplete", () => {
    render(<EnvironmentsSection environments={[]} incomplete={GAP} nowMs={NOW} />);
    // The exact collapse: nothing was found, and two goals never answered. Saying "No environment
    // deployed" here is a claim about goals nobody could read.
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
    expect(screen.getByTestId("cr.environments.incomplete").textContent)
      .toContain("DEPLOY_LEDGER_UNAVAILABLE @ DAEMON_INGRESS");
  });

  it("renders the empty state when the list is empty and COMPLETE", () => {
    // The negative control for the arm above. Without it, a section that had simply deleted its
    // empty state would satisfy every assertion here.
    render(<EnvironmentsSection environments={[]} incomplete={null} nowMs={NOW} />);
    expect(screen.getByTestId("cr.environments.empty").textContent).toContain("No environment deployed.");
    expect(screen.queryByTestId("cr.environments.incomplete")).toBeNull();
  });

  it("renders no note at all when every goal answered", () => {
    render(<EnvironmentsSection environments={rows("production")} incomplete={null} nowMs={NOW} />);
    expect(screen.queryByTestId("cr.environments.incomplete")).toBeNull();
    expect(screen.getByTestId("cr.environments.kicker").textContent)
      .toBe(`Environments ${MIDDOT} 1 deployed`);
  });

  it("lets a whole-enumeration refusal outrank a partial one", () => {
    render(<EnvironmentsSection
      environments={rows("production")}
      incomplete={GAP}
      nowMs={NOW}
      refusal={{ code: "ENVIRONMENTS_CATALOG_REFUSED", layer: "CONTROL_ROOM_ENVIRONMENTS" }}
    />);
    // Nothing at all could be enumerated, so a partial-list note beside a refusal would imply
    // the rows below it are a real subset of the deployed set. There are no rows.
    expect(screen.getByTestId("cr.environments.refusal").textContent)
      .toContain("ENVIRONMENTS_CATALOG_REFUSED @ CONTROL_ROOM_ENVIRONMENTS");
    expect(screen.queryByTestId("cr.environments.incomplete")).toBeNull();
    expect(screen.queryByTestId("cr.environments.list")).toBeNull();
  });
});
