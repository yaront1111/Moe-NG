import { RUNTIME_COMMAND_ENVELOPE_VERSION, buildNextAllowedCommands } from "@moe/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { SessionsAgentProvider } from "../../live/live-sessions.js";
import { AgentProviderToggle } from "./agent-provider-toggle.js";
import type { AgentProviderOutcome, AgentProviderPort, KnownProvider } from "./agent-provider-port.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const CONFIGURED: SessionsAgentProvider = { configured: "claude", envOverride: false };

/**
 * THE FIXTURE IS BUILT BY THE PRODUCTION PARSER, not typed as a literal (QA reject on
 * task-96957529, issue 3). The earlier two-key literal exercised a branch production could
 * not reach: the daemon minted NO `project.set_agent_provider` offer at all, so the only arm
 * production ever took was `offer={null}` and this suite proved the dead branch worked.
 *
 * The daemon now mints it (`affordance-agent-provider-offers.ts`). `buildNextAllowedCommands`
 * is the contracts admission the browser's own affordance roster runs — exact key set, known
 * command kind, non-empty identity strings, safe-count version — and it collapses the whole
 * list to the empty set on any drift. So the assertion below is not decoration: an offer this
 * suite could build but the daemon could not mint would fail it, and the control room cannot
 * import apps/daemon to compare literals (no workspace edge; a deep relative import is TS6059).
 *
 * `agent-provider/<projectId>` is the aggregate `setAgentProvider` fences, spelled here the
 * way live-sessions.test.ts pins the sessions frame: pinned by round trip, not by faith.
 */
const [BUILT_OFFER] = buildNextAllowedCommands({ aggregate: "PROJECT", state: "READY" }, [{
  commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  commandId: "afford-project.set_agent_provider-7",
  commandKind: "project.set_agent_provider",
  expectedVersion: 7,
  inputSchemaVersion: "moe-agent-provider/1",
  targetAggregateId: "agent-provider/project-1",
}]);
/** Spread rather than cast: `NextAllowedCommand` is an interface and has no index signature,
 *  so `as Readonly<Record<string, unknown>>` is TS2352 under `pnpm typecheck` while passing
 *  vitest, which does not typecheck. The toggle's prop is the loose record the surface frame
 *  hands it, so spreading is also what production does. */
const OFFER: Readonly<Record<string, unknown>> = { ...BUILT_OFFER };

it("is a fixture the contracts parser admits, so it cannot drift from the daemon's offer", () => {
  expect(OFFER).toMatchObject({
    commandKind: "project.set_agent_provider",
    expectedVersion: 7,
    targetAggregateId: "agent-provider/project-1",
  });
});

interface Sent {
  readonly affordance: Readonly<Record<string, unknown>>;
  readonly provider: KnownProvider;
}

function portRecording(sent: Sent[], answer: AgentProviderOutcome): AgentProviderPort {
  return {
    submit: (affordance, provider) => {
      sent.push({ affordance, provider });
      return Promise.resolve(answer);
    },
  };
}

describe("the toggle writes the durable setting through the daemon's offer", () => {
  it("dispatches the OFFER and the chosen provider, not a click", async () => {
    const sent: Sent[] = [];
    render(
      <AgentProviderToggle
        agentProvider={CONFIGURED}
        offer={OFFER}
        port={portRecording(sent, { commandId: "cmd-9", ok: true })}
      />,
    );
    await userEvent.setup().click(screen.getByTestId("cr.sessions.provider.choose.codex"));
    // WHAT WAS DISPATCHED is the assertion. A handler that fired and sent the wrong target
    // version writes at the wrong version, and the daemon - not this test - would catch it.
    await waitFor(() => { expect(sent).toHaveLength(1); });
    expect(sent[0]?.provider).toBe("codex");
    expect(sent[0]?.affordance).toBe(OFFER);
    await screen.findByTestId("cr.sessions.provider.recorded");
  });

  it("does NOT move its own label on a successful write", async () => {
    const sent: Sent[] = [];
    render(
      <AgentProviderToggle
        agentProvider={CONFIGURED}
        offer={OFFER}
        port={portRecording(sent, { commandId: "cmd-9", ok: true })}
      />,
    );
    await userEvent.setup().click(screen.getByTestId("cr.sessions.provider.choose.codex"));
    await screen.findByTestId("cr.sessions.provider.recorded");
    // Only the ledger moves a card. The label still reads what the daemon last STATED, so an
    // accepted write and an override that quietly ignored it stay distinguishable.
    expect(screen.getByTestId("cr.sessions.provider.configured").textContent).toContain("claude");
    expect(screen.getByTestId("cr.sessions.provider.choose.claude").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("cr.sessions.provider.choose.codex").getAttribute("aria-pressed")).toBe("false");
  });

  it("reports the daemon's own code, layer and detail when the write is refused", async () => {
    render(
      <AgentProviderToggle
        agentProvider={CONFIGURED}
        offer={OFFER}
        port={portRecording([], {
          code: "AGENT_PROVIDER_UNKNOWN", detail: "provider must be claude or codex",
          layer: "DURABLE_STORE", ok: false,
        })}
      />,
    );
    await userEvent.setup().click(screen.getByTestId("cr.sessions.provider.choose.codex"));
    const refusal = await screen.findByTestId("cr.sessions.provider.refusal");
    expect(refusal.textContent).toContain("AGENT_PROVIDER_UNKNOWN @ DURABLE_STORE");
    // The DETAIL says what to fix; the code alone only says a write was refused.
    expect(screen.getByTestId("cr.sessions.provider.refusal.detail").textContent)
      .toBe("provider must be claude or codex");
  });

  it("says the session cannot change the setting when the daemon offered none", async () => {
    const sent: Sent[] = [];
    render(
      <AgentProviderToggle
        agentProvider={CONFIGURED}
        offer={null}
        port={portRecording(sent, { commandId: "cmd-9", ok: true })}
      />,
    );
    expect(screen.getByTestId("cr.sessions.provider.unoffered").textContent)
      .toContain("only to a paired operator");
    await userEvent.setup().click(screen.getByTestId("cr.sessions.provider.choose.codex"));
    // Nothing is invented when there is no offer: no version to write at, so no write.
    expect(sent).toHaveLength(0);
  });

  it("sends ONE command for a double click", async () => {
    const sent: Sent[] = [];
    const releases: (() => void)[] = [];
    const port: AgentProviderPort = {
      submit: (affordance, provider) => {
        sent.push({ affordance, provider });
        return new Promise<AgentProviderOutcome>((done) => {
          releases.push(() => { done({ commandId: "cmd-9", ok: true }); });
        });
      },
    };
    render(<AgentProviderToggle agentProvider={CONFIGURED} offer={OFFER} port={port} />);
    const codex = screen.getByTestId("cr.sessions.provider.choose.codex");
    await userEvent.setup().click(codex);
    // An impatient second click while the first is in flight must not write twice: the
    // daemon would take the second at a version the first already moved.
    await userEvent.setup().click(screen.getByTestId("cr.sessions.provider.choose.claude"));
    expect(sent).toHaveLength(1);
    releases[0]?.();
    await screen.findByTestId("cr.sessions.provider.recorded");
  });
});
