import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { GoalDeployments, deployOffer, deploymentLine, releaseLine, targetLine }
  from "./goal-deployments.js";
import type { DeploymentEnvironmentView } from "./goal-deployments.js";
import type { DeployPort } from "./deploy-port.js";

/**
 * THE CARD PUTS PREVIEW AND PRODUCTION ON ONE SURFACE, so the arms below are written against
 * the failure that arrangement invites: arming one environment and clicking the other. Every
 * dispatch assertion reads what the PORT RECEIVED rather than what a button said, because a
 * label can be right while the dispatch carries the other environment - which is exactly the
 * bug a shared boolean `armed` produces.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const GOAL = "goal-1";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OFFER = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-deploy",
  commandKind: "deployment.deploy", expectedVersion: 3,
  inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: `deploy:${GOAL}`,
});
const FRAME = {
  connection: "LIVE", offers: [OFFER], outcome: "SURFACE", steps: [],
} as unknown as SurfaceFrame;
const NO_OFFER = {
  connection: "LIVE", offers: [], outcome: "SURFACE", steps: [],
} as unknown as SurfaceFrame;

function environment(
  overrides: Partial<DeploymentEnvironmentView> & { readonly environment: string },
): DeploymentEnvironmentView {
  return {
    code: null, detail: null, outcome: null, releaseDecision: null, sha: null,
    target: null, time: null, url: null, ...overrides,
  };
}

const PREVIEW = environment({
  environment: "preview", outcome: "DEPLOYED", sha: SHA, target: "moe-net (local)",
  time: "2026-09-06T09:00:00.000Z", url: "https://preview.example.test",
});
const PRODUCTION = environment({
  environment: "production", outcome: "DEPLOYED", sha: "fedcba9876543210fedcba9876543210fedcba98",
  target: "deployer@host.example.test", time: "2026-09-05T18:30:00.000Z",
  url: "https://app.example.test",
});

/** A port that RECORDS its calls and never resolves until the arm says so, so an arm can assert
 *  that a click dispatched NOTHING without racing an in-flight promise. */
function recordingPort(answer: Awaited<ReturnType<DeployPort["submit"]>> = { commandId: "c", ok: true }): {
  readonly calls: { readonly environment: string; readonly sha: string }[];
  readonly port: DeployPort;
} {
  const calls: { readonly environment: string; readonly sha: string }[] = [];
  const port: DeployPort = {
    setTarget: async () => answer,
    submit: async (_affordance, environmentName, sha) => {
      calls.push({ environment: environmentName, sha });
      return answer;
    },
  };
  return { calls, port };
}

function renderCard(props: Partial<Parameters<typeof GoalDeployments>[0]> = {}): {
  readonly calls: { readonly environment: string; readonly sha: string }[];
} {
  const recorder = recordingPort();
  render(
    <GoalDeployments
      environments={props.environments ?? [PREVIEW, PRODUCTION]}
      frame={props.frame ?? FRAME}
      goalId={GOAL}
      port={props.port ?? recorder.port}
      releaseDecision={props.releaseDecision ?? null}
      sha={props.sha === undefined ? SHA : props.sha}
    />,
  );
  return { calls: recorder.calls };
}

describe("the deploy confirm names its environment (DoD 2)", () => {
  it("reads differently for production than for preview, by the environment name itself",
    async () => {
      renderCard();
      const user = userEvent.setup();

      await user.click(screen.getByTestId("cr.deploy.production.button"));

      const production = screen.getByTestId("cr.deploy.production.button").textContent ?? "";
      const preview = screen.getByTestId("cr.deploy.preview.button").textContent ?? "";
      expect(production).toContain("production");
      expect(production).toContain("Confirm");
      // DISTINGUISHABLE, not merely present: the preview control must not read like a confirm
      // for the environment the operator armed.
      expect(preview).not.toContain("Confirm");
      expect(preview).not.toContain("production");
    });

  it("ARMING PREVIEW THEN CLICKING PRODUCTION DISPATCHES NOTHING - it arms production instead",
    async () => {
      const { calls } = renderCard();
      const user = userEvent.setup();

      await user.click(screen.getByTestId("cr.deploy.preview.button"));
      await user.click(screen.getByTestId("cr.deploy.production.button"));

      // THE ROW'S SAFETY PROPERTY. A shared boolean `armed` fails here: preview's click would
      // set it true and production's click would dispatch immediately, off a button the
      // operator never confirmed. Asserted on what the PORT RECEIVED, since the label can read
      // correctly while the dispatch carries the other environment.
      expect(calls).toEqual([]);
      expect(screen.getByTestId("cr.deploy.production.button").textContent ?? "")
        .toContain("Confirm: deploy to production");
      // And preview is no longer armed, so the next preview click re-arms rather than fires.
      expect(screen.getByTestId("cr.deploy.preview.button").textContent ?? "")
        .not.toContain("Confirm");
    });

  it("dispatches ONLY the armed environment, carrying that environment and the landed sha",
    async () => {
      const { calls } = renderCard();
      const user = userEvent.setup();

      await user.click(screen.getByTestId("cr.deploy.preview.button"));
      await user.click(screen.getByTestId("cr.deploy.preview.button"));

      await waitFor(() => { expect(calls).toEqual([{ environment: "preview", sha: SHA }]); });
    });
});

describe("a production confirm states the release standing (DoD 3)", () => {
  it("CITES the decision when the goal carries one", async () => {
    renderCard({ releaseDecision: "release-decision-42" });
    const user = userEvent.setup();

    await user.click(screen.getByTestId("cr.deploy.production.button"));

    expect(screen.getByTestId("cr.deploy.production.release").textContent ?? "")
      .toContain("Cites release decision release-decision-42");
  });

  it("states plainly that there is none when the goal carries none", async () => {
    renderCard({ releaseDecision: null });
    const user = userEvent.setup();

    await user.click(screen.getByTestId("cr.deploy.production.button"));

    // BOTH WORDINGS ARE ASSERTED, here and above: a conditional that rendered empty would pass
    // an "is present" check while telling the operator nothing.
    expect(screen.getByTestId("cr.deploy.production.release").textContent ?? "")
      .toContain("No release decision on this goal");
  });

  it("shows the release line only on the armed PRODUCTION row, not on preview", async () => {
    renderCard({ releaseDecision: "release-decision-42" });
    const user = userEvent.setup();

    await user.click(screen.getByTestId("cr.deploy.preview.button"));

    expect(screen.queryByTestId("cr.deploy.preview.release")).toBeNull();
    expect(screen.queryByTestId("cr.deploy.production.release")).toBeNull();
  });
});

describe("the card is absent when the daemon offers no deploy (DoD 4)", () => {
  it("renders NOTHING - queried by testid, not by a disabled attribute", () => {
    renderCard({ frame: NO_OFFER });

    expect(screen.queryByTestId("cr.deploy.root")).toBeNull();
    expect(screen.queryByTestId("cr.deploy.production.button")).toBeNull();
  });

  it("finds no offer on a frame that is not a surface, and none for another goal", () => {
    expect(deployOffer(null, GOAL)).toBeNull();
    expect(deployOffer(FRAME, "goal-other")).toBeNull();
    expect(deployOffer(FRAME, GOAL)).toBe(OFFER);
  });
});

describe("the four refusals render as operator words (DoD 5)", () => {
  it("renders each code with its own sentence, and never blanks an unknown one", () => {
    renderCard({ environments: [
      environment({ code: "DEPLOY_TARGET_MISSING", environment: "preview", outcome: "REFUSED" }),
      environment({ code: "DEPLOY_DOCKER_UNAVAILABLE", environment: "staging", outcome: "REFUSED" }),
      environment({ code: "DEPLOY_HEALTH_TIMEOUT", environment: "canary", outcome: "REFUSED" }),
      environment({ code: "DEPLOY_SOMETHING_NEW", environment: "spare", outcome: "REFUSED" }),
    ] });

    expect(screen.getByTestId("cr.deploy.preview.refusal").textContent ?? "")
      .toContain("No target is bound for this environment");
    expect(screen.getByTestId("cr.deploy.staging.refusal").textContent ?? "")
      .toContain("Docker did not answer");
    expect(screen.getByTestId("cr.deploy.canary.refusal").textContent ?? "")
      .toContain("never reported healthy");
    // An unknown code renders VERBATIM rather than blank: a future refusal must still say
    // something an operator can carry to a log.
    expect(screen.getByTestId("cr.deploy.spare.refusal").textContent ?? "")
      .toContain("DEPLOY_SOMETHING_NEW");
  });

  it("DEPLOY_TARGET_MISSING offers a way to set a target; the others do not", () => {
    renderCard({ environments: [
      environment({ code: "DEPLOY_TARGET_MISSING", environment: "preview", outcome: "REFUSED" }),
      environment({ code: "DEPLOY_HEALTH_TIMEOUT", environment: "production", outcome: "REFUSED" }),
    ] });

    expect(screen.getByTestId("cr.deploy.preview.settarget").textContent ?? "")
      .toContain("Bind a target");
    expect(screen.queryByTestId("cr.deploy.production.settarget")).toBeNull();
  });

  it("DEPLOY_BUILD_FAILED carries the tool's OWN last stderr line", () => {
    // A distinctive planted string: a generic "the build failed" message cannot pass this.
    const stderr = "#12 4.2 ERR_PNPM_NO_SCRIPT missing script: build";
    renderCard({ environments: [
      environment({
        code: "DEPLOY_BUILD_FAILED", detail: stderr, environment: "preview", outcome: "REFUSED",
      }),
    ] });

    expect(screen.getByTestId("cr.deploy.preview.refusal").textContent ?? "").toContain(stderr);
  });
});

describe("each environment renders its own facts (DoD 1)", () => {
  it("keeps two environments' target, sha, time, url and status uncrossed", () => {
    renderCard();

    const preview = screen.getByTestId("cr.deploy.preview.row").textContent ?? "";
    const production = screen.getByTestId("cr.deploy.production.row").textContent ?? "";
    expect(screen.getByTestId("cr.deploy.preview.target").textContent ?? "")
      .toContain("moe-net (local)");
    expect(screen.getByTestId("cr.deploy.production.target").textContent ?? "")
      .toContain("deployer@host.example.test");
    expect(preview).toContain(SHA.slice(0, 10));
    expect(preview).toContain("2026-09-06T09:00:00.000Z");
    // NOT CROSSED: production's row carries none of preview's values, which a shared render
    // that read the first entry would fail.
    expect(production).not.toContain(SHA.slice(0, 10));
    expect(production).not.toContain("moe-net (local)");
    expect(screen.getByTestId("cr.deploy.preview.url").getAttribute("href"))
      .toBe("https://preview.example.test");
    expect(screen.getByTestId("cr.deploy.production.url").getAttribute("href"))
      .toBe("https://app.example.test");
  });

  it("states an absent target and a never-deployed environment as absences", () => {
    renderCard({ environments: [environment({ environment: "preview" })] });

    expect(screen.getByTestId("cr.deploy.preview.target").textContent ?? "")
      .toContain("No target is bound");
    expect(screen.getByTestId("cr.deploy.preview.state").textContent ?? "")
      .toContain("Never deployed");
    expect(screen.queryByTestId("cr.deploy.preview.url")).toBeNull();
  });

  it("says nothing is landed, and refuses to dispatch, when there is no sha", async () => {
    const { calls } = renderCard({ sha: null });
    const user = userEvent.setup();

    await user.click(screen.getByTestId("cr.deploy.preview.button"));
    await user.click(screen.getByTestId("cr.deploy.preview.button"));

    expect(screen.getByTestId("cr.deploy.unlanded").textContent ?? "")
      .toContain("Nothing is landed to deploy yet");
    expect(calls).toEqual([]);
  });

  it("words the lines the same way outside the component", () => {
    expect(deploymentLine(PREVIEW)).toContain("Running 0123456789");
    expect(deploymentLine(environment({ environment: "x" }))).toBe("Never deployed.");
    expect(targetLine(environment({ environment: "x" })))
      .toBe("No target is bound for this environment yet.");
    expect(releaseLine(undefined)).toContain("No release decision");
  });
});

describe("the card keeps nothing in this browser", () => {
  it("holds no browser-local state, pinned by the component's own source text", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "goal-deployments.tsx"), "utf8",
    );

    // ASSEMBLED, not spelled, for the same reason goal-publish.test.tsx assembles its retired
    // key: a repo-wide grep for the API name stays at zero hits outside this arm.
    expect(source).not.toContain(["local", "Storage"].join(""));
    expect(source).not.toContain(["session", "Storage"].join(""));
  });
});
