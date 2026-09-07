import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { DeployTargetForm } from "./deploy-target-form.js";
import { deployTargetAggregateId } from "./deploy-port.js";
import type { DeployPort, DeployTargetFields } from "./deploy-port.js";

/**
 * THE BINDING CONTROL. The row's one safety property is that the environment is unmistakable,
 * so most of these arms read RENDERED TEXT rather than props: a control can be handed the
 * right environment and still show the operator a different one, and a target bound to the
 * wrong environment silently redirects a later deploy to another host.
 *
 * The daemon's refusal is REPRODUCED here, never reimplemented: `setDeployTarget` answers
 * `DEPLOY_TARGET_INVALID` @ `DAEMON_INGRESS` for every admission failure, and the arms below
 * assert what the BROWSER does with that answer and what it put on the wire first. Whether the
 * daemon refuses those values is the daemon's own suite's question, not this file's.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { cleanup(); });

const PROJECT = "proj-1";
const ENVIRONMENTS = ["preview", "production", "verify"] as const;

function offerFor(environment: string, expectedVersion: number): Record<string, unknown> {
  return Object.freeze({
    commandEnvelopeVersion: "moe-runtime-command/1", commandId: `cmd-set-${environment}`,
    commandKind: "deployment.set_target", expectedVersion,
    inputSchemaVersion: "moe-bootstrap-command/1",
    // The PRODUCTION key function, so a producer key change breaks these arms rather than
    // silently passing them against a frame the daemon no longer serves.
    targetAggregateId: deployTargetAggregateId(PROJECT, environment),
  });
}

/** Three offers at THREE DIFFERENT versions, which is the shape the daemon really serves. */
function frameWith(environments: readonly string[]): SurfaceFrame {
  return {
    connection: "LIVE", outcome: "SURFACE", steps: [],
    offers: environments.map((environment, index) => offerFor(environment, index * 3)),
  } as unknown as SurfaceFrame;
}

interface Call {
  readonly affordance: Readonly<Record<string, unknown>>;
  readonly environment: string;
  readonly fields: DeployTargetFields;
  readonly projectId: string;
}

function recordingPort(answer: Awaited<ReturnType<DeployPort["bindTarget"]>>
= { commandId: "cmd-set", ok: true }): {
  readonly calls: Call[]; readonly port: DeployPort;
} {
  const calls: Call[] = [];
  return {
    calls,
    port: {
      bindTarget: async (affordance, projectId, environment, fields) => {
        calls.push({ affordance, environment, fields, projectId });
        return answer;
      },
      submit: (): never => { throw new Error("submit dispatched from a bind arm"); },
    },
  };
}

function renderForm(environment: string, props: {
  readonly frame?: SurfaceFrame; readonly port?: DeployPort;
  readonly projectId?: string | null;
} = {}): { readonly calls: Call[] } {
  const recorder = recordingPort();
  render(
    <DeployTargetForm
      environment={environment}
      frame={props.frame ?? frameWith(ENVIRONMENTS)}
      port={props.port ?? recorder.port}
      projectId={props.projectId === undefined ? PROJECT : props.projectId}
    />,
  );
  return { calls: recorder.calls };
}

const testId = (environment: string, part: string): string =>
  `cr.deploy.bind.${environment}.${part}`;

/** Fill the one required field, then arm. Returns after the confirm step is on screen. */
async function armFor(environment: string, network = "moe-net"): Promise<void> {
  await userEvent.type(screen.getByTestId(testId(environment, "network")), network);
  await userEvent.click(screen.getByTestId(testId(environment, "button")));
  await waitFor(() => expect(screen.getByTestId(testId(environment, "confirm"))).toBeTruthy());
}

describe("the environment is unmistakable, on the control AND on the confirm step (F)", () => {
  it("names it in the heading, every label and the arm button, by RENDERED TEXT", () => {
    renderForm("production");

    // Read off the DOM, never off a prop: the prop being right is not the property at risk.
    expect(screen.getByTestId(testId("production", "heading")).textContent ?? "")
      .toContain("production");
    const root = screen.getByTestId(testId("production", "root")).textContent ?? "";
    expect(root).toContain("Docker network for production");
    expect(root).toContain("SSH destination for production");
    expect(root).toContain("Public url for production");
    expect(screen.getByTestId(testId("production", "button")).textContent ?? "")
      .toBe("Bind a target for production");
  });

  it("names it AGAIN on the confirm step, in a sentence and in the confirm button", async () => {
    renderForm("production");
    await armFor("production", "moe-prod");

    // THE LAST MOMENT A WRONG ENVIRONMENT CAN BE CAUGHT. Not a subtitle and not a placeholder:
    // a whole sentence the operator is reading when they decide.
    const confirm = screen.getByTestId(testId("production", "confirm")).textContent ?? "";
    expect(confirm).toContain("This binds the production environment to network moe-prod");
    expect(confirm).toContain("Only production changes.");
    expect(screen.getByTestId(testId("production", "button")).textContent ?? "")
      .toBe("Confirm: bind production to moe-prod");
    expect(screen.getByTestId(testId("production", "cancel")).textContent ?? "")
      .toContain("production");
    // AND IT NEVER NAMES ANOTHER ENVIRONMENT. Three rows sit on one screen; a confirm that
    // mentioned `preview` while binding `production` is the exact slip this arm exists for.
    const root = screen.getByTestId(testId("production", "root")).textContent ?? "";
    expect(root).not.toContain("preview");
    expect(root).not.toContain("verify");
  });

  it("dispatches the environment it displayed, for each row independently", async () => {
    for (const environment of ["preview", "production"]) {
      const { calls } = renderForm(environment);
      await armFor(environment);
      await userEvent.click(screen.getByTestId(testId(environment, "button")));
      await waitFor(() => expect(calls).toHaveLength(1));

      expect(calls[0]?.environment).toBe(environment);
      // The payload's environment and the FENCED aggregate are the same fact, asserted equal
      // rather than each separately correct.
      expect(calls[0]?.affordance["targetAggregateId"])
        .toBe(deployTargetAggregateId(PROJECT, calls[0]?.environment ?? ""));
      cleanup();
    }
  });
});

describe("it spends THIS row's offer, by value (L), and none at all without one (N)", () => {
  it("picks production's offer out of three, with production's OWN expectedVersion", async () => {
    // preview=0, production=3, verify=6. An arm that matched only on `commandKind`, or took
    // "the first offer", would pass while fencing preview's version on a production write.
    const { calls } = renderForm("production", { frame: frameWith(ENVIRONMENTS) });
    await armFor("production");
    await userEvent.click(screen.getByTestId(testId("production", "button")));
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]?.affordance["targetAggregateId"])
      .toBe(`deploy-target:${PROJECT}:production`);
    expect(calls[0]?.affordance["expectedVersion"]).toBe(3);
    expect(calls[0]?.affordance["commandKind"]).toBe("deployment.set_target");
  });

  it("renders NOTHING for a row the surface served no offer for -- absent, not disabled", () => {
    // Offers for two environments only; `verify` gets none.
    renderForm("verify", { frame: frameWith(["preview", "production"]) });

    expect(screen.queryByTestId(testId("verify", "root"))).toBeNull();
    expect(screen.queryByTestId(testId("verify", "button"))).toBeNull();
    // POSITIVE CONTROL on the SAME frame: an environment that IS offered renders. Without this
    // the arm above would pass if the testid scheme were simply wrong.
    cleanup();
    renderForm("preview", { frame: frameWith(["preview", "production"]) });
    expect(screen.getByTestId(testId("preview", "root"))).toBeTruthy();
  });

  it("renders nothing with no projectId, rather than an id built against a null", () => {
    renderForm("preview", { projectId: null });
    expect(screen.queryByTestId(testId("preview", "root"))).toBeNull();
  });
});

describe("every admission refusal renders as words WITH its code (G)", () => {
  /**
   * FOUR OPERATOR INPUTS THE DAEMON REFUSES, one per DoD 3 clause. They collapse to ONE daemon
   * code -- `admitDeployTargetPayload` returns null for all of them and `setDeployTarget`
   * answers `DEPLOY_TARGET_INVALID` @ `DAEMON_INGRESS` -- so the arm asserts the WORDS name
   * every cause and the code travels verbatim, rather than inventing four browser-side codes
   * the daemon never sends.
   */
  const CASES = [
    { field: "url", label: "a url carrying userinfo", value: "https://deployer:hunter2@host.test" },
    { field: "network", label: "whitespace in the network", value: "moe preview" },
    { field: "network", label: "a shell metacharacter in the network", value: "moe$(id)" },
    // MEASURED, not assumed: an <input type="text"> DROPS a newline when its value is set,
    // before any code in this repo sees it. So this case cannot assert byte-for-byte survival
    // -- it asserts the browser sent WHAT THE FIELD HELD and that the rest of the hostile
    // string is intact, which is the property this control actually owns.
    { field: "ssh", label: "a newline in the ssh destination", platformStrips: true,
      value: "host.test\nrm -rf /" },
    { field: "ssh", label: "a NUL in the ssh destination", value: "host.test\u0000evil" },
  ] as const;

  it("was built with a case for each of the four clauses, plus the NUL", () => {
    // ANTI-VACUITY: a swept table that silently produced zero cases passes every loop below.
    expect(CASES).toHaveLength(5);
    expect(new Set(CASES.map((entry) => entry.field))).toEqual(new Set(["url", "network", "ssh"]));
    // AND THE HOSTILE CHARACTERS ARE REALLY IN THE TABLE. `userEvent.type` cannot enter a raw
    // newline or NUL into an <input> -- it reads the first as Enter and drops the second -- so
    // these two cases are entered with `fireEvent.change` below. Without this check the table
    // could quietly degrade to five printable strings and still pass every arm.
    expect(CASES.some((entry) => entry.value.includes("\n"))).toBe(true);
    expect(CASES.some((entry) => entry.value.includes("\u0000"))).toBe(true);
  });

  for (const entry of CASES) {
    const { field, label, value } = entry;
    const platformStrips = "platformStrips" in entry;
    it(`shows the refusal for ${label}, and SENT the value unrepaired`, async () => {
      const refusal = { code: "DEPLOY_TARGET_INVALID", layer: "DAEMON_INGRESS", ok: false as const };
      const recorder = recordingPort(refusal);
      renderForm("preview", { port: recorder.port });
      await userEvent.type(screen.getByTestId(testId("preview", "network")), "moe-net");
      // `fireEvent.change` rather than `userEvent.type`, so a raw newline or NUL really lands in
      // the field. Typing them is impossible -- Enter is a keypress and NUL is dropped -- and an
      // arm that typed them would be testing two printable strings while claiming otherwise.
      fireEvent.change(screen.getByTestId(testId("preview", field)), { target: { value } });
      await userEvent.click(screen.getByTestId(testId("preview", "button")));
      await waitFor(() => expect(screen.getByTestId(testId("preview", "confirm"))).toBeTruthy());
      await userEvent.click(screen.getByTestId(testId("preview", "button")));
      await waitFor(() => expect(recorder.calls).toHaveLength(1));

      // THE REFUSAL IS SHOWN, AS WORDS AND AS ITS CODE.
      const answer = await screen.findByTestId(testId("preview", "answer"));
      const shown = answer.textContent ?? "";
      expect(shown).toContain("The daemon refused this target and bound nothing");
      expect(shown).toContain("It refuses rather than cleaning the value up");
      expect(shown).toContain("DEPLOY_TARGET_INVALID @ DAEMON_INGRESS");
      // AND THE ENVIRONMENT, since one screen carries a row per environment.
      expect(shown).toContain("preview");

      // NOT SANITISED ON THE WAY OUT. userEvent.type cannot enter a raw newline or NUL into an
      // <input>, so the browser is asserted to have sent WHAT THE FIELD HELD -- never a
      // stripped, trimmed or repaired variant of it.
      const sent = field === "url" ? recorder.calls[0]?.fields.url
        : field === "ssh" ? recorder.calls[0]?.fields.sshTarget
          : recorder.calls[0]?.fields.network;
      const held = (screen.getByTestId(testId("preview", field)) as HTMLInputElement).value;
      // THE BROWSER SENT WHAT THE FIELD HELD. That is the property this control owns, and it
      // holds for every case including the one the platform mangles.
      expect(sent).toBe(held);
      expect(held).not.toBe("");
      if (platformStrips) {
        // The loss is the DOM's, NOT this control's: a single-line input drops the newline as
        // the value is assigned. Assert that is what happened AND that everything else came
        // through, so a client-side scrub could never hide behind this branch.
        expect(held).not.toContain("\n");
        expect(sent).toContain("rm -rf /");
        expect(sent).toContain("host.test");
      } else {
        // THE HOSTILE VALUE SURVIVED BYTE FOR BYTE -- not trimmed, lowercased, userinfo-
        // stripped or control-character-scrubbed. The NUL case runs through here.
        expect(sent).toBe(value);
      }
    });
  }
});

describe("the ssh destination is visibly optional and means LOCAL when blank (H)", () => {
  it("says so in the LABEL, not in a tooltip", () => {
    renderForm("preview");

    const label = screen.getByTestId(testId("preview", "root")).textContent ?? "";
    expect(label).toContain("SSH destination for preview (optional)");
    expect(label).toContain("Leave this empty to deploy with the docker daemon on this host");
  });

  it("reaches the local path with the field left empty, sending null", async () => {
    const { calls } = renderForm("preview");
    await armFor("preview", "moe-local");

    // The confirm step states the local meaning at the moment of decision, too.
    expect(screen.getByTestId(testId("preview", "confirm")).textContent ?? "")
      .toContain("on the docker daemon of this host");
    await userEvent.click(screen.getByTestId(testId("preview", "button")));
    await waitFor(() => expect(calls).toHaveLength(1));

    // null, NOT "" -- an empty string is a destination the daemon would try to use.
    expect(calls[0]?.fields.sshTarget).toBeNull();
    expect(calls[0]?.fields.sshTarget).not.toBe("");
    expect(calls[0]?.fields.network).toBe("moe-local");
  });
});

describe("a bind in flight cannot be dispatched twice (adversarial pass)", () => {
  it("disables the button while busy, so a second click cannot double-bind", async () => {
    // A second bind of the same environment would refuse EXPECTED_VERSION_CONFLICT rather than
    // bind twice -- the first write bumps the aggregate the second is fenced on -- so this is
    // not a silent double-write. It is still a confusing refusal an operator did not cause, and
    // the landed deploy card guards its own dispatch the same way.
    const calls: string[] = [];
    const inFlight: (() => void)[] = [];
    const port: DeployPort = {
      bindTarget: async (_affordance, _projectId, environment) => {
        calls.push(environment);
        await new Promise<void>((resolve) => { inFlight.push(resolve); });
        return { commandId: "cmd-set", ok: true };
      },
      submit: (): never => { throw new Error("submit dispatched from a bind arm"); },
    };
    render(
      <DeployTargetForm
        environment="preview" frame={frameWith(ENVIRONMENTS)} port={port} projectId={PROJECT}
      />,
    );
    await armFor("preview");
    const button = screen.getByTestId(testId("preview", "button"));
    await userEvent.click(button);
    await waitFor(() => expect(calls).toHaveLength(1));

    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent ?? "").toBe("Binding...");
    await userEvent.click(button);
    expect(calls).toHaveLength(1);

    // Released once the answer lands, so a real retry is still possible.
    inFlight[0]?.();
    await waitFor(() => expect(screen.getByTestId(testId("preview", "answer"))).toBeTruthy());
  });
});

describe("no credential is accepted, stored or rendered (I, epic rail 3)", () => {
  const SECRET_SHAPES = [/password/iu, /passphrase/iu, /secret/iu, /\btoken\b/iu, /private key/iu];

  it("renders exactly three inputs and none of them is an authenticator", async () => {
    renderForm("preview");
    await armFor("preview");

    const root = screen.getByTestId(testId("preview", "root"));
    const inputs = [...root.querySelectorAll("input")];
    expect(inputs).toHaveLength(3);
    // No password-typed input, and no input whose id or testid names a credential.
    for (const input of inputs) {
      expect(input.getAttribute("type")).not.toBe("password");
      for (const shape of SECRET_SHAPES) expect(input.id).not.toMatch(shape);
    }
    // Nothing the control RENDERS names one either, including the armed confirm sentence.
    const shown = root.textContent ?? "";
    for (const shape of SECRET_SHAPES) expect(shown).not.toMatch(shape);

    // POSITIVE CONTROL, so the sweep cannot be passing because the shapes match nothing.
    const planted = "Password, passphrase, secret, token, private key";
    for (const shape of SECRET_SHAPES) expect(planted).toMatch(shape);
  });
});
