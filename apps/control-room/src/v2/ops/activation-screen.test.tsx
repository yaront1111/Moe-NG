import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ACTIVATION_MEMBERS } from "../../live/live-activation.js";
import type {
  ActivationMember, ActivationReadOutcome, ActivationReceiptView,
} from "../../live/live-activation.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { ActivateScreen, LiveActivate } from "./activation-screen.js";
import type { ActivationChainState } from "./activation-screen.js";
import type { ActivationPort, ActivationStep } from "./activation-port.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The Activate card. Every string it shows about a receipt or a refusal is the DAEMON'S, and
 * these arms assert the exact bytes rather than a substring: a paraphrase that happened to
 * contain the same words would otherwise pass while the operator lost the reason.
 */

/**
 * The signing reason, as a FIXTURE. Deliberately not the daemon's own literal: that string
 * names the current release version, and tests/integration/release/release-version-surfaces
 * treats every new tracked occurrence of it as an unclassified release surface. What these
 * arms prove is that whatever the daemon states is rendered verbatim, which any string shows.
 */
const SIGNING_REASON = "signing is out of scope for this release";

/** A recognisable value that must never reach the DOM. Not a real credential. */
const FAKE_TOKEN = "sk-live-NEVER-RENDER-ME-9f3c1a";

const measuredRow = (member: ActivationMember, reason: string): ActivationReceiptView =>
  Object.freeze({ code: null, hash: null, layer: null, measured: true, member, reason, ref: `${member}/ref` });

const missingRow = (
  member: ActivationMember, reason: string, code: string, layer: string,
): ActivationReceiptView =>
  Object.freeze({ code, hash: null, layer, measured: false, member, reason, ref: null });

function activationView(
  members: readonly ActivationReceiptView[],
  signingReason = SIGNING_REASON,
): ActivationReadOutcome {
  return Object.freeze({
    blocking: members.filter((row) => !row.measured).map((row) => row.member),
    distribution: { kind: "SOURCE_CHECKOUT", root: "D:/projexts/moe-next" },
    measuredAt: "2026-09-05T05:00:00.000Z",
    members,
    repository: { headSha: "a".repeat(40), toplevel: "D:/projexts/moe-next" },
    schemaVersion: "moe-activation-receipts/1",
    signing: {
      measured: false as const, member: "signing" as const, reason: signingReason,
      ref: "signing/unsigned-source-checkout", trustBoundary: false as const,
    },
    status: "ACTIVATION" as const,
    store: { storePath: "D:/projexts/moe-next/.moe-next/store.sqlite" },
  });
}

const allMeasured = (): ActivationReadOutcome =>
  activationView(ACTIVATION_MEMBERS.map((member) => measuredRow(member, `${member} measured`)));

const chainState = (steps: readonly ActivationStep[] = [], busy = false): ActivationChainState =>
  ({ busy, onActivate: vi.fn(), steps });

describe("ActivateScreen renders the daemon's six receipts", () => {
  it("shows every measured receipt with its own testid, and counts only the six", () => {
    render(<ActivateScreen outcome={allMeasured()} />);

    expect(ACTIVATION_MEMBERS).toHaveLength(6);
    for (const member of ACTIVATION_MEMBERS) {
      const row = screen.getByTestId(`cr.activate.receipt.${member}`);
      expect(row.getAttribute("data-measured")).toBe("true");
      expect(row.textContent).toContain("measured");
    }
    expect(screen.getByTestId("cr.activate.count").textContent).toContain("6 of 6 receipts measured");
    // Signing is NOT one of the counted rows.
    expect(screen.getByTestId("cr.activate.receipts").querySelectorAll("li")).toHaveLength(6);
  });

  it("shows a missing member with the daemon's reason VERBATIM and its own code @ layer", () => {
    const reason = "no repository is bound: `git rev-parse HEAD` was never run for this project";
    render(<ActivateScreen outcome={activationView([
      measuredRow("store", "store measured"),
      missingRow("repository", reason, "ACTIVATION_REPOSITORY_UNMEASURED", "ACTIVATION_RECEIPTS"),
    ])} />);

    const row = screen.getByTestId("cr.activate.receipt.repository");
    expect(row.getAttribute("data-measured")).toBe("false");
    expect(row.textContent).toContain("missing");
    // EXACT bytes, not a substring of a paraphrase.
    expect(screen.getByTestId("cr.activate.reason.repository").textContent).toBe(reason);
    expect(screen.getByTestId("cr.activate.code.repository").textContent)
      .toBe("ACTIVATION_REPOSITORY_UNMEASURED @ ACTIVATION_RECEIPTS");
  });

  it("presents signing as NOT a trust boundary and never as a measured receipt", () => {
    const reason = SIGNING_REASON;
    render(<ActivateScreen outcome={activationView(
      ACTIVATION_MEMBERS.map((member) => measuredRow(member, `${member} measured`)), reason,
    )} />);

    const signing = screen.getByTestId("cr.activate.signing");
    expect(signing.getAttribute("data-measured")).toBe("false");
    expect(signing.getAttribute("data-trust-boundary")).toBe("false");
    expect(signing.textContent).toContain(reason);
    expect(signing.textContent).toContain("not a trust boundary");
    // It carries no receipt testid, so nothing that enumerates receipts can pick it up.
    expect(screen.queryByTestId("cr.activate.receipt.signing")).toBeNull();
    expect(screen.getByTestId("cr.activate.count").textContent).toContain("6 of 6");
  });

  it("renders a long reason carrying markup as TEXT, never as HTML", () => {
    const nasty = `<img src=x onerror="alert(1)"> ${"a really long stated reason ".repeat(12)}`;
    const { container } = render(<ActivateScreen outcome={activationView([
      missingRow("policy", nasty, "ACTIVATION_POLICY_UNMEASURED", "ACTIVATION_RECEIPTS"),
    ])} />);

    expect(screen.getByTestId("cr.activate.reason.policy").textContent).toBe(nasty);
    expect(container.querySelector("img")).toBeNull();
  });

  it("states the daemon's refusal instead of a blank card when the read itself is refused", () => {
    render(<ActivateScreen outcome={{
      code: "LISTENER_ACTIVATION_UNAVAILABLE", layer: "ACTIVATION_READ", status: "REFUSED",
    }} />);

    expect(screen.getByTestId("cr.activate.root")).not.toBeNull();
    expect(screen.getByTestId("cr.activate.refusal").textContent)
      .toContain("LISTENER_ACTIVATION_UNAVAILABLE @ ACTIVATION_READ");
    expect(screen.queryByTestId("cr.activate.button")).toBeNull();
  });
});

describe("ActivateScreen renders the chain's own answers", () => {
  it("shows a refusal as exactly `code @ layer`, unparaphrased", () => {
    const steps: readonly ActivationStep[] = [
      { kind: "project.register", outcome: { commandId: "cmd-1", ok: true }, state: "ANSWERED" },
      {
        kind: "project.bind_repository",
        outcome: { code: "REPOSITORY_OBSERVATION_INVALID", layer: "DAEMON_INGRESS", ok: false },
        state: "ANSWERED",
      },
    ];
    render(<ActivateScreen chain={chainState(steps)} outcome={allMeasured()} />);

    expect(screen.getByTestId("cr.activate.refusal.project.bind_repository").textContent)
      .toBe("REPOSITORY_OBSERVATION_INVALID @ DAEMON_INGRESS");
    expect(screen.getByTestId("cr.activate.step.project.register").getAttribute("data-ok")).toBe("true");
    expect(screen.getByTestId("cr.activate.step.project.bind_repository").getAttribute("data-ok")).toBe("false");
  });

  it("reports an already-committed command as done, never as a refusal", () => {
    render(<ActivateScreen
      chain={chainState([{ kind: "project.register", state: "ALREADY_COMMITTED" }])}
      outcome={allMeasured()}
    />);

    const row = screen.getByTestId("cr.activate.step.project.register");
    expect(row.getAttribute("data-ok")).toBe("true");
    expect(row.textContent).toContain("already done");
    expect(row.textContent).not.toContain("refused");
    expect(screen.queryByTestId("cr.activate.refusal.project.register")).toBeNull();
  });

  it("offers no button and says why when no wire is attached", () => {
    render(<ActivateScreen chain={{ busy: false, onActivate: null, steps: [] }} outcome={allMeasured()} />);

    expect(screen.queryByTestId("cr.activate.button")).toBeNull();
    expect(screen.getByTestId("cr.activate.nowire").textContent).toContain("project.admin");
  });
});

describe("LiveActivate drives at most one chain", () => {
  const frame = (offers: readonly Record<string, unknown>[] = []): SurfaceFrame =>
    ({ offers, steps: [] } as unknown as SurfaceFrame);

  const inertPort: ActivationPort = { submit: () => Promise.resolve({ commandId: "cmd", ok: true }) };

  it("starts exactly one chain when two clicks land in the SAME batch, and disables the button", async () => {
    let release!: (steps: readonly ActivationStep[]) => void;
    const running = new Promise<readonly ActivationStep[]>((resolve) => { release = resolve; });
    const drive = vi.fn(() => running);

    render(<LiveActivate
      drive={drive}
      headers={{}}
      port={inertPort}
      read={() => Promise.resolve(allMeasured())}
      readSurface={() => Promise.resolve(frame())}
    />);

    const button = await screen.findByTestId("cr.activate.button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    // BOTH clicks inside ONE act, while the button is still ENABLED: this is the real
    // double-click, where the second event lands before React has re-rendered `disabled`.
    // Clicking a button that is ALREADY disabled is a jsdom no-op and would prove nothing,
    // so only the handler's own synchronous guard can keep this at one chain.
    await act(async () => {
      button.click();
      button.click();
    });
    expect(drive).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("cr.activate.button") as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      release([{ kind: "project.register", outcome: { commandId: "c", ok: true }, state: "ANSWERED" }]);
      await running;
    });
    expect((screen.getByTestId("cr.activate.button") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("cr.activate.step.project.register")).not.toBeNull();
  });

  it("re-enables the button after a chain that rejected, so the operator is not stranded", async () => {
    const user = userEvent.setup();
    const drive = vi.fn(() => Promise.reject(new Error("wire died")));

    render(<LiveActivate
      drive={drive}
      headers={{}}
      port={inertPort}
      read={() => Promise.resolve(allMeasured())}
      readSurface={() => Promise.resolve(frame())}
    />);

    const button = await screen.findByTestId("cr.activate.button") as HTMLButtonElement;
    await user.click(button);
    await act(async () => { await Promise.resolve(); });
    expect((screen.getByTestId("cr.activate.button") as HTMLButtonElement).disabled).toBe(false);
    expect(drive).toHaveBeenCalledTimes(1);
  });

  it("puts NO credential, csrf token or header value into the DOM", async () => {
    const user = userEvent.setup();
    const surfaceWithSecret = (): Promise<SurfaceFrame> => Promise.resolve(frame([{
      commandId: `cmd-${FAKE_TOKEN}`, commandKind: "project.register", expectedVersion: 0,
      sessionCredential: FAKE_TOKEN, targetAggregateId: "unai-project",
    }]));
    const drive = vi.fn(() => Promise.resolve<readonly ActivationStep[]>([{
      kind: "project.register",
      outcome: { code: "PROJECT_ALREADY_REGISTERED", layer: "DAEMON_INGRESS", ok: false },
      state: "ANSWERED",
    }]));

    const { container } = render(<LiveActivate
      drive={drive}
      headers={{ authorization: `Bearer ${FAKE_TOKEN}`, "x-moe-csrf": FAKE_TOKEN }}
      port={inertPort}
      read={() => Promise.resolve(allMeasured())}
      readSurface={surfaceWithSecret}
    />);

    await user.click(await screen.findByTestId("cr.activate.button"));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId("cr.activate.refusal.project.register").textContent)
      .toBe("PROJECT_ALREADY_REGISTERED @ DAEMON_INGRESS");
    // innerHTML covers text nodes AND every attribute, including title=.
    expect(container.innerHTML).not.toContain(FAKE_TOKEN);
    expect(container.innerHTML).not.toContain("Bearer");
    for (const node of container.querySelectorAll("[title]")) {
      expect(node.getAttribute("title") ?? "").not.toContain(FAKE_TOKEN);
    }
  });
});
