import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CONTROL_ROOM_FIXTURE_KIND } from "./fixtures.js";
import { resolveLiveSetup } from "./live/live-config.js";
import type { LiveSetup, LiveSetupResult } from "./live/live-config.js";
import { BOARD_DISPATCH_COMMAND_KIND } from "./live/live-board.js";
import { ClockProvider } from "./performance/command-latency.js";
import { LIVE_CREDENTIAL_ENV_VARS } from "./shell-mode.js";
import { ShellModeRoot } from "./shell-mode-view.js";

/**
 * The three arms as they PAINT. `shell-mode.test.ts` proves the decision; this
 * proves the decision reaches a surface an operator can tell apart — which is
 * the half that matters, because the failure this task exists to remove is
 * frozen fixtures rendered where live data was expected.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NO_CREDENTIALS: LiveSetupResult = resolveLiveSetup({}, null);
const COMPAT_REFUSED: LiveSetupResult = resolveLiveSetup(
  { VITE_MOE_LIVE_CREDENTIAL: "cred", VITE_MOE_LIVE_CSRF: "csrf" },
  null,
);
const ADMITTED: LiveSetupResult = Object.freeze({ ok: true }) as unknown as LiveSetup;

describe("the FIXTURES arm", () => {
  it("mounts the fixture scaffold under a banner that names it a fixture", () => {
    render(<ShellModeRoot mode="FIXTURES" setup={ADMITTED} />);

    expect(screen.getByTestId("cr.shell.root")).toBeTruthy();
    const banner = screen.getByTestId("cr.banner.fixture");
    // Sourced from the fixture module's own marker, so the label cannot drift
    // away from the thing it labels.
    expect(banner.textContent).toContain(CONTROL_ROOM_FIXTURE_KIND);
    expect(CONTROL_ROOM_FIXTURE_KIND).toBe("DEVELOPMENT_ONLY/NOT_CONFIRMATORY");
  });

  it("announces the banner politely, as every other banner in this shell does", () => {
    render(<ShellModeRoot mode="FIXTURES" setup={ADMITTED} />);

    const banner = screen.getByTestId("cr.banner.fixture");
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.getAttribute("aria-live")).toBe("polite");
  });

  it("shows the fixture banner even when the build could have gone live", () => {
    // The banner is a property of what is being SHOWN, never of what the build
    // could have shown: an operator who followed a ?fixtures=1 link on a fully
    // credentialed build still needs to be told these numbers are frozen.
    render(<ShellModeRoot mode="FIXTURES" setup={NO_CREDENTIALS} />);
    expect(screen.getByTestId("cr.banner.fixture")).toBeTruthy();
  });
});

describe("the CONFIG_NOTICE arm", () => {
  it("names BOTH missing environment variables", () => {
    render(<ShellModeRoot mode="CONFIG_NOTICE" setup={NO_CREDENTIALS} />);

    const notice = screen.getByTestId("cr.config.notice");
    for (const variable of LIVE_CREDENTIAL_ENV_VARS) {
      expect(notice.textContent, variable).toContain(variable);
    }
  });

  it("carries the stable refusal code and points at the runbook", () => {
    render(<ShellModeRoot mode="CONFIG_NOTICE" setup={NO_CREDENTIALS} />);

    const notice = screen.getByTestId("cr.config.notice");
    expect(notice.textContent).toContain("LIVE_CONFIG_MISSING");
    expect(notice.textContent).toContain("docs/agent-stack-runbook.md");
  });

  it("renders NO fixture data and NO fixture banner — the fail-closed clause", () => {
    // The whole point of this arm: an unconfigured build must not quietly serve
    // frozen fixtures where live data belongs.
    render(<ShellModeRoot mode="CONFIG_NOTICE" setup={NO_CREDENTIALS} />);

    expect(screen.queryByTestId("cr.shell.root")).toBeNull();
    expect(screen.queryByTestId("cr.banner.fixture")).toBeNull();
    expect(document.body.textContent).not.toContain(CONTROL_ROOM_FIXTURE_KIND);
  });

  it("is a named landmark region, reachable the way the shell's own regions are", () => {
    render(<ShellModeRoot mode="CONFIG_NOTICE" setup={NO_CREDENTIALS} />);

    const notice = screen.getByTestId("cr.config.notice");
    expect(notice.getAttribute("role")).toBe("region");
    const labelledBy = notice.getAttribute("aria-labelledby");
    expect(labelledBy).not.toBeNull();
    expect(document.getElementById(labelledBy ?? "")?.textContent ?? "").not.toBe("");
  });
});

describe("the LIVE arm", () => {
  it("mounts the live attachment, never the scaffold", () => {
    // A compat refusal still takes the LIVE arm, and the live attachment prints
    // its OWN code — asserting that code is what proves LiveControlRoom mounted
    // rather than some notice this module could have rendered instead.
    render(<ShellModeRoot mode="LIVE" setup={COMPAT_REFUSED} />);

    expect(screen.getByTestId("cr.live.refused").textContent).toContain("LIVE_COMPAT_REFUSED");
    // NOTE for anyone extending this: `cr.shell.root` is absent here only because
    // the refusal panel does not mount ShellFrame. It is NOT a fixture marker — an
    // ADMITTED live mount renders it too (measured in a browser against a real
    // daemon). `cr.banner.fixture` is the marker that actually discriminates.
    expect(screen.queryByTestId("cr.shell.root")).toBeNull();
    expect(screen.queryByTestId("cr.banner.fixture")).toBeNull();
  });

  it("does not print the credential notice for a build that HAS credentials", () => {
    render(<ShellModeRoot mode="LIVE" setup={COMPAT_REFUSED} />);

    expect(screen.queryByTestId("cr.config.notice")).toBeNull();
    for (const variable of LIVE_CREDENTIAL_ENV_VARS) {
      expect(document.body.textContent, variable).not.toContain(variable);
    }
  });
});

/**
 * The default arm, mounted the way `main.tsx` mounts it, over the SAME three
 * polling feeds `live-app.tsx` has always wired. This task changed the gate, not
 * the feeds — so the assertion that matters is that a default mount still reads
 * the daemon through them and paints what it read.
 */
describe("the LIVE arm reads the daemon through the unchanged polling feeds", () => {
  const SURFACE_BODY = {
    nextAllowedCommands: [{
      commandId: "afford-live-1", commandKind: BOARD_DISPATCH_COMMAND_KIND,
      expectedVersion: 3, targetAggregateId: "approval-live",
    }],
    outcome: "SURFACE",
    steps: [
      {
        aggregateId: "approval-live", kind: BOARD_DISPATCH_COMMAND_KIND, missing: [],
        status: "READY", version: 3,
      },
      {
        aggregateId: "goal-live", kind: "goal.create", missing: ["project.activate"],
        status: "BLOCKED", version: null,
      },
    ],
  };

  /** Records what the board feed asked for, so "it polled" is asserted, not assumed. */
  function stubbedFeeds(): { readonly posted: string[]; readonly setup: LiveSetupResult } {
    const posted: string[] = [];
    vi.stubGlobal("fetch", (input: unknown) => {
      posted.push(String(input));
      return Promise.resolve(new Response(JSON.stringify(SURFACE_BODY), { status: 200 }));
    });
    const setup = {
      client: { commands: {} },
      headers: Object.freeze({}),
      ok: true,
      projection: "moe.board",
      sessionCredential: "live-session",
      subscriberId: "control-room-1",
      transport: {
        // Left pending: the board feed is what this test reads, and a resolved
        // event page would race the assertions with a re-render that says nothing
        // about the arm under test.
        readDocumentDossier: () => new Promise(() => undefined),
        readEventPage: () => new Promise(() => undefined),
        sendCommand: () => Promise.reject(new Error("unused")),
      },
    } as unknown as LiveSetup;
    return { posted, setup };
  }

  it("paints the daemon's own chain, and offers the approval decision only", async () => {
    const { posted, setup } = stubbedFeeds();
    render(
      <ClockProvider clock={{ now: () => 1_000 }}>
        <ShellModeRoot mode="LIVE" setup={setup} />
      </ClockProvider>,
    );

    // Both daemon rows land on the board, in the columns the daemon put them in.
    const ready = await screen.findByTestId(
      `cr.liveboard.card.${BOARD_DISPATCH_COMMAND_KIND}@approval-live`);
    expect(ready.getAttribute("data-status")).toBe("READY");
    const blocked = screen.getByTestId("cr.liveboard.card.goal.create@goal-live");
    expect(blocked.getAttribute("data-status")).toBe("BLOCKED");
    expect(screen.getByTestId("cr.liveboard.missing.goal.create").textContent)
      .toContain("project.activate");

    // …and the only control on that board is the approval decision.
    expect(screen.getAllByRole("button", { name: /^Dispatch /u })).toHaveLength(1);
    expect(screen.getByTestId(`cr.liveboard.dispatch.${BOARD_DISPATCH_COMMAND_KIND}`))
      .toBeTruthy();

    // The rows came off the wire, not out of a fixture: the board feed really
    // asked the daemon's affordance route for them.
    expect(posted.some((url) => url.includes("/affordances/read"))).toBe(true);
    expect(screen.getByTestId("cr.live.workspace")).toBeTruthy();
    expect(screen.queryByTestId("cr.banner.fixture")).toBeNull();
  });
});
