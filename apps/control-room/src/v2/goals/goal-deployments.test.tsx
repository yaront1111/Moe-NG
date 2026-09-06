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
import { createDeployPort } from "./deploy-port.js";
import type { DeployPort } from "./deploy-port.js";
import type { OfferWire } from "../approvals/offer-wire.js";

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
    submit: async (_affordance, environmentName, sha) => {
      calls.push({ environment: environmentName, sha });
      return answer;
    },
  };
  return { calls, port };
}

/**
 * A FAKE OFFER WIRE, so an arm can render the REAL `createDeployPort` rather than a literal.
 * Copied from goal-publish.test.tsx:61-72, which is the precedent this row was told to mirror.
 *
 * WHY THIS EXISTS AT ALL: every other arm in this file hands the card a hand-built DeployPort,
 * which proves what the CARD does with a port but never that the port itself builds the right
 * command. deploy-port.ts passes `affordance` and `payload` -- both
 * Readonly<Record<string, unknown>> -- and `correlationPrefix` and `layer`, both string, as four
 * positional arguments to `spendOffer`. Either pair can be transposed and still typecheck, so
 * without this wire the only thing standing between a swapped argument and a shipped deploy is
 * a human reading the line.
 */
function wireWith(response: unknown): {
  readonly built: Record<string, unknown>[]; readonly wire: OfferWire;
} {
  const built: Record<string, unknown>[] = [];
  const wire = {
    client: { commands: { "deployment.deploy": (
      affordance: unknown, input: Record<string, unknown>,
    ) => {
      built.push({ affordance, ...input });
      return { envelope: { commandId: "cmd-deploy", payload: input["payload"] }, ok: true };
    } } },
    sessionCredential: "cred-1",
    transport: { sendCommand: vi.fn(async () => ({
      delivered: true as const, response, status: 200,
    })) },
  } as unknown as OfferWire;
  return { built, wire };
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

  it("DEPLOY_TARGET_MISSING names the prerequisite, the command that binds it, and that this "
    + "screen cannot; the others say nothing", () => {
    renderCard({ environments: [
      environment({ code: "DEPLOY_TARGET_MISSING", environment: "preview", outcome: "REFUSED" }),
      environment({ code: "DEPLOY_HEALTH_TIMEOUT", environment: "production", outcome: "REFUSED" }),
    ] });

    const note = screen.getByTestId("cr.deploy.preview.settarget").textContent ?? "";
    expect(note).toContain("Bind a target");
    // THE ENVIRONMENT, since one wording serves every row and a target is bound per environment.
    expect(note).toContain("preview");
    // THE COMMAND THAT ACTUALLY BINDS ONE. Naming the prerequisite without naming the means is
    // what QA rejected here; the operator has to be able to carry this somewhere.
    expect(note).toContain("deployment.set_target");
    // AND THE HONEST LIMIT. The daemon offers no set_target affordance on any frame, so this
    // screen cannot bind one. The note must not imply a retry here will start working -- it
    // must NOT read as "then deploy again", which sends the operator round the same loop.
    expect(note).toContain("cannot bind one yet");
    expect(note).not.toContain("then deploy again");
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

describe("the adversarial pass, on this diff only", () => {
  it("NAMES THE ENVIRONMENT in the refusal note, since one note serves both rows", async () => {
    const calls: { readonly environment: string; readonly sha: string }[] = [];
    const port: DeployPort = {
      submit: async (_affordance, environmentName, sha) => {
        calls.push({ environment: environmentName, sha });
        return { code: "DEPLOY_TARGET_MISSING", layer: "DAEMON_DEPLOY_ENGINE", ok: false };
      },
    };
    render(
      <GoalDeployments
        environments={[PREVIEW, PRODUCTION]} frame={FRAME} goalId={GOAL} port={port}
        releaseDecision={null} sha={SHA}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByTestId("cr.deploy.production.button"));
    await user.click(screen.getByTestId("cr.deploy.production.button"));

    await waitFor(() => {
      expect(screen.getByTestId("cr.deploy.answer").textContent ?? "").toContain("production");
    });
    // The code and layer stay the daemon's own, in the details line.
    expect(screen.getByTestId("cr.deploy.answer").textContent ?? "")
      .toContain("DEPLOY_TARGET_MISSING");
    expect(calls).toEqual([{ environment: "production", sha: SHA }]);
  });

  it("cannot be double-clicked into a second dispatch of the same environment", async () => {
    const calls: { readonly environment: string; readonly sha: string }[] = [];
    const inFlight: (() => void)[] = [];
    const port: DeployPort = {
      submit: async (_affordance, environmentName, sha) => {
        calls.push({ environment: environmentName, sha });
        await new Promise<void>((resolve) => { inFlight.push(resolve); });
        return { commandId: "cmd-deploy", ok: true };
      },
    };
    render(
      <GoalDeployments
        environments={[PREVIEW]} frame={FRAME} goalId={GOAL} port={port}
        releaseDecision={null} sha={SHA}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByTestId("cr.deploy.preview.button"));
    await user.click(screen.getByTestId("cr.deploy.preview.button"));
    // IN FLIGHT: the button must be inert, or a second click re-arms the row under the operator
    // and the click after it dispatches the same environment twice.
    expect(screen.getByTestId("cr.deploy.preview.button").hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByTestId("cr.deploy.preview.button"));

    expect(calls).toEqual([{ environment: "preview", sha: SHA }]);
    inFlight.forEach((resolve) => { resolve(); });
  });

  it("A DEPLOY IN FLIGHT BLOCKS ARMING THE OTHER ENVIRONMENT, not just re-clicking its own",
    async () => {
      const calls: { readonly environment: string; readonly sha: string }[] = [];
      const inFlight: (() => void)[] = [];
      const port: DeployPort = {
        submit: async (_affordance, environmentName, sha) => {
          calls.push({ environment: environmentName, sha });
          await new Promise<void>((resolve) => { inFlight.push(resolve); });
          return { commandId: "cmd-deploy", ok: true };
        },
      };
      render(
        <GoalDeployments
          environments={[PREVIEW, PRODUCTION]} frame={FRAME} goalId={GOAL} port={port}
          releaseDecision={null} sha={SHA}
        />,
      );
      const user = userEvent.setup();

      await user.click(screen.getByTestId("cr.deploy.preview.button"));
      await user.click(screen.getByTestId("cr.deploy.preview.button"));

      // PREVIEW IS NOW IN FLIGHT. The dangerous shape is a card that disables only the busy row:
      // production would still arm, and the operator would be one click from a production deploy
      // while a preview deploy they cannot see the result of is still running.
      expect(screen.getByTestId("cr.deploy.production.button").hasAttribute("disabled")).toBe(true);
      await user.click(screen.getByTestId("cr.deploy.production.button"));
      expect(screen.getByTestId("cr.deploy.production.button").textContent ?? "")
        .not.toContain("Confirm");
      expect(calls).toEqual([{ environment: "preview", sha: SHA }]);
      inFlight.forEach((resolve) => { resolve(); });
    });

  it("renders an environment the daemon names that is neither preview nor production", () => {
    renderCard({ environments: [environment({ environment: "canary", outcome: null })] });

    expect(screen.getByTestId("cr.deploy.canary.button").textContent ?? "")
      .toContain("Deploy to canary");
    // No release line for a non-production environment, armed or not.
    expect(screen.queryByTestId("cr.deploy.canary.release")).toBeNull();
  });

  it("arming production, then preview, then clicking production dispatches NOTHING", async () => {
    const { calls } = renderCard();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("cr.deploy.production.button"));
    await user.click(screen.getByTestId("cr.deploy.preview.button"));
    await user.click(screen.getByTestId("cr.deploy.production.button"));

    // The third click RE-ARMS production, because preview held the arm. The dangerous ordering
    // is the one where an operator believes production is still armed from two clicks ago.
    expect(calls).toEqual([]);
  });
});

describe("the card dispatches through the REAL deploy port (DoD 1)", () => {
  it("spends the goal's own offer as deployment.deploy with payload EXACTLY {environment, sha}",
    async () => {
      const { built, wire } = wireWith({ ok: true });
      render(
        <GoalDeployments
          environments={[PREVIEW, PRODUCTION]} frame={FRAME} goalId={GOAL}
          port={createDeployPort(wire)} releaseDecision={null} sha={SHA}
        />,
      );
      const user = userEvent.setup();

      await user.click(screen.getByTestId("cr.deploy.production.button"));
      // ARMED ONLY. Nothing may reach the wire from the first click.
      expect(built).toHaveLength(0);
      await user.click(screen.getByTestId("cr.deploy.production.button"));
      await waitFor(() => { expect(built).toHaveLength(1); });

      // BYTE-EXACT, and toEqual rather than toMatchObject on purpose: the daemon's decoder is
      // exact-arity (daemon-command-payload-keys.ts:173 is ["environment", "sha"]), so an EXTRA
      // key is malformed just as a missing one is, and toMatchObject would pass an extra.
      expect(built[0]?.["payload"]).toEqual({ environment: "production", sha: SHA });
      // THE AFFORDANCE IS THE DAEMON'S OWN OFFER OBJECT, by identity. This is the assertion that
      // catches transposing `affordance` and `payload` at deploy-port.ts: both are
      // Readonly<Record<string, unknown>>, so the swap compiles and the payload check alone
      // would still fail in a confusing way rather than naming the cause.
      expect(built[0]?.["affordance"]).toBe(OFFER);
      // AND THE CORRELATION PREFIX, which catches the OTHER transposable pair. If
      // `correlationPrefix` and `layer` were swapped, this would read
      // "CONTROL_ROOM_DEPLOY-<digest>" and still typecheck, because both are string.
      expect(String(built[0]?.["correlationId"] ?? "")).toMatch(/^ui-deploy-[0-9a-f]{16}$/u);
    });

  it("carries CONTROL_ROOM_DEPLOY as the layer when the daemon answer cannot be read",
    async () => {
      // An unreadable answer is the one path where spendOffer surfaces the LAYER argument it was
      // given (offer-wire.ts: OFFER_ANSWER_UNREADABLE is returned with that layer), so this is
      // what pins the fourth positional argument from the other side.
      const { wire } = wireWith(null);
      render(
        <GoalDeployments
          environments={[PREVIEW]} frame={FRAME} goalId={GOAL}
          port={createDeployPort(wire)} releaseDecision={null} sha={SHA}
        />,
      );
      const user = userEvent.setup();

      await user.click(screen.getByTestId("cr.deploy.preview.button"));
      await user.click(screen.getByTestId("cr.deploy.preview.button"));

      await waitFor(() => {
        expect(screen.getByTestId("cr.deploy.answer").textContent ?? "")
          .toContain("OFFER_ANSWER_UNREADABLE");
      });
      expect(screen.getByTestId("cr.deploy.answer").textContent ?? "")
        .toContain("CONTROL_ROOM_DEPLOY");
    });

  it("refuses a kind the wire cannot build rather than sending anything", async () => {
    // The offer names deployment.deploy; a wire whose command roster lacks it must refuse at the
    // build step. Proves the port asks the roster for the kind it declares, not for some other.
    const { built, wire } = wireWith({ ok: true });
    const narrowed = { ...wire, client: { commands: {} } } as unknown as OfferWire;
    render(
      <GoalDeployments
        environments={[PREVIEW]} frame={FRAME} goalId={GOAL}
        port={createDeployPort(narrowed)} releaseDecision={null} sha={SHA}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByTestId("cr.deploy.preview.button"));
    await user.click(screen.getByTestId("cr.deploy.preview.button"));

    await waitFor(() => {
      expect(screen.getByTestId("cr.deploy.answer").textContent ?? "")
        .toContain("OFFER_KIND_UNBUILDABLE");
    });
    expect(built).toHaveLength(0);
  });
});
