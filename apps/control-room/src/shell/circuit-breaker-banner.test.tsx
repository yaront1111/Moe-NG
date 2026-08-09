import { buildNextAllowedCommands } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import type { PresentedFact } from "../nodes/node-authority.js";
import { CircuitBreakerBanner } from "./circuit-breaker-banner.js";
import type { CircuitBreakerFact } from "./circuit-breaker-banner.js";
import { ShellFrame } from "./frame.js";

/**
 * Spec section 7.5 and CR-S10-001.
 *
 * The scenario's bar is that the banner NAMES THE CORRELATED CHECK. Most of the cases
 * below are therefore about what the banner refuses to render: a sentence with a hole in
 * it, or an empty shell, would both satisfy "cr.banner.circuitbreaker exists" while
 * telling the operator nothing they can act on.
 */
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const obs = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });

const TARGET = "goal-fanout-7";

const COMMANDS: readonly NextAllowedCommand[] = buildNextAllowedCommands(
  { aggregate: "PROJECT", state: "QUIESCED" },
  [{
    commandEnvelopeVersion: "moe-runtime-command/1",
    commandId: "cmd-release-hold",
    commandKind: "graph.release_preparation",
    expectedVersion: 3,
    inputSchemaVersion: "moe-runtime-command-input/1",
    targetAggregateId: TARGET,
  }],
);

function snapshot(overrides: Partial<FixtureAffordanceSnapshot> = {}): FixtureAffordanceSnapshot {
  return {
    connection: "CONNECTED",
    mutationsEnabled: true,
    nextAllowedCommands: COMMANDS,
    requiresAffordanceRefresh: false,
    statusLabel: "",
    ...overrides,
  };
}

function breakerFact(overrides: Partial<CircuitBreakerFact> = {}): CircuitBreakerFact {
  return {
    command: obs("pnpm test"),
    correlatedChildren: obs("4"),
    locus: obs("integration"),
    targetAggregateId: TARGET,
    ...overrides,
  };
}

function mount(
  breaker: CircuitBreakerFact | undefined,
  frame: FixtureAffordanceSnapshot = snapshot(),
): HTMLElement {
  const result = render(
    <ShellFrame affordance={frame}>
      <CircuitBreakerBanner breaker={breaker} />
    </ShellFrame>,
  );
  return result.container;
}

describe("circuit-breaker banner", () => {
  it("names the correlated check in the exact section 7.5 sentence", () => {
    mount(breakerFact());
    expect(screen.getByTestId("cr.banner.circuitbreaker.text").textContent).toBe(
      "Correlated failures across 4 children — same failing check: `pnpm test` "
      + "(integration). Fan-out held.",
    );
  });

  it("announces politely, never assertively", () => {
    // Spec 11.1. An assertive region interrupts a screen-reader user mid-sentence, and
    // this is a status rather than an alert.
    mount(breakerFact());
    const banner = screen.getByTestId("cr.banner.circuitbreaker");
    expect(banner.getAttribute("aria-live")).toBe("polite");
    expect(banner.getAttribute("role")).toBe("status");
  });

  it("renders nothing at all when the daemon supplies no circuit breaker", () => {
    // An empty banner shell would be a fabricated surface: it would satisfy a sweep
    // looking for the id while reporting a condition the daemon never asserted.
    mount(undefined);
    expect(screen.queryByTestId("cr.banner.circuitbreaker")).toBeNull();
  });

  it("renders nothing when the check cannot be NAMED, rather than a sentence with a hole", () => {
    // CR-S10-001's whole point is the named check. "same failing check: `UNKNOWN`" would
    // pass a naive id assertion and tell the operator nothing.
    mount(breakerFact({ command: null }));
    expect(screen.queryByTestId("cr.banner.circuitbreaker")).toBeNull();
  });

  it("renders nothing when the locus is absent", () => {
    mount(breakerFact({ locus: null }));
    expect(screen.queryByTestId("cr.banner.circuitbreaker")).toBeNull();
  });

  it("renders nothing when a supplied value is blank rather than missing", () => {
    // Whitespace counts as absent; a blank-looking value beside a confident banner is
    // exactly the "never blank" case the spec forbids.
    mount(breakerFact({ command: obs("   ") }));
    expect(screen.queryByTestId("cr.banner.circuitbreaker")).toBeNull();
  });

  it("renders options only from nextAllowedCommands", () => {
    mount(breakerFact());
    const banner = screen.getByTestId("cr.banner.circuitbreaker");
    expect(within(banner).getByTestId("cr.action.graph-release-preparation")).toBeTruthy();
  });

  it("renders no option at all when the daemon returned none", () => {
    // Spec 8.1: absent, never disabled with invented text.
    mount(breakerFact(), snapshot({ nextAllowedCommands: [] }));
    const banner = screen.getByTestId("cr.banner.circuitbreaker");
    expect(banner.querySelectorAll("[data-command-id]")).toHaveLength(0);
  });
});

describe("circuit-breaker banner composed in the shell", () => {
  /** Mounts through the frame's own prop rather than as a child, which is how the app
   * will render it. */
  function mountInShell(frame: FixtureAffordanceSnapshot): void {
    render(<ShellFrame affordance={frame} breaker={breakerFact()} />);
  }

  it("COEXISTS with the lag banner rather than replacing it", () => {
    // The frame's `Banners` early-returns exactly ONE banner. Composing the circuit
    // breaker into that chain instead of beside it would silently drop whichever lost,
    // and a circuit-broken lagging view is precisely the state an operator needs both in.
    mountInShell(snapshot({ statusLabel: "Lagging 4s behind" }));
    expect(screen.getByTestId("cr.banner.lag")).toBeTruthy();
    expect(screen.getByTestId("cr.banner.circuitbreaker")).toBeTruthy();
  });

  it("COEXISTS with the disconnected banner rather than replacing it", () => {
    mountInShell(snapshot({ connection: "DISCONNECTED", statusLabel: "Disconnected" }));
    expect(screen.getByTestId("cr.banner.disconnected")).toBeTruthy();
    expect(screen.getByTestId("cr.banner.circuitbreaker")).toBeTruthy();
  });

  it("renders no circuit-breaker banner when the frame was given none", () => {
    render(<ShellFrame affordance={snapshot()} />);
    expect(screen.queryByTestId("cr.banner.circuitbreaker")).toBeNull();
  });
});
