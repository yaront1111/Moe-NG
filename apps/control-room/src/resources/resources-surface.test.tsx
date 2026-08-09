import { buildNextAllowedCommands } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  auditActionLegality, auditFactChips, auditKeyboardReachability, auditLiveRegions,
} from "../a11y/surface-audit.js";
import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import type { PresentedFact } from "../nodes/node-authority.js";
import { ShellFrame } from "../shell/frame.js";
import { RESOURCES_EMPTY_COPY } from "./resources-surface.js";
import { ResourcesSurface } from "./resources-surface.js";
import type { ResourceProjection, ResourcesSurfaceProps } from "./resources-surface.js";

/**
 * Spec section 4.12 Resources and its section 11.3 states.
 *
 * The load-bearing case here is the QUEUE ORDER. The daemon owns the waiting order; a
 * surface that sorted by priority would look tidier and be wrong, and it would be wrong
 * invisibly because a sorted list is still a plausible list. The fixture below is
 * deliberately NOT in priority order so that sorting changes the rendered result.
 */
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const obs = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });
const ver = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });

const RESOURCE = "resource-db-main";

function affordanceSeed(commandKind: string, commandId: string): Record<string, unknown> {
  return {
    commandEnvelopeVersion: "moe-runtime-command/1",
    commandId,
    commandKind,
    expectedVersion: 4,
    inputSchemaVersion: "moe-runtime-command-input/1",
    targetAggregateId: RESOURCE,
  };
}

const COMMANDS: readonly NextAllowedCommand[] = buildNextAllowedCommands(
  { aggregate: "PROJECT", state: "QUIESCED" },
  [affordanceSeed("resource.release", "cmd-release")],
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

/**
 * Waiters in the daemon's order, deliberately NOT sorted by priority: P3 precedes P1.
 * A client-side sort would reorder these two and the assertion below would catch it.
 */
function resourceRow(overrides: Partial<ResourceProjection> = {}): ResourceProjection {
  return {
    actionTargetId: RESOURCE,
    holder: obs("w-3"),
    holdingTask: obs("api-endpnt"),
    leaseExpiry: ver("expires in 12m"),
    resourceId: "db-main",
    waiters: [
      { priority: obs("P3"), waiterId: "w-7", waiting: obs("waiting 2m") },
      { priority: obs("P1"), waiterId: "w-2", waiting: obs("waiting 8m") },
    ],
    ...overrides,
  };
}

const BASE: ResourcesSurfaceProps = { degraded: false, loading: false, rows: [resourceRow()] };

function mount(
  overrides: Partial<ResourcesSurfaceProps> = {},
  frame: FixtureAffordanceSnapshot = snapshot(),
): HTMLElement {
  const result = render(
    <ShellFrame affordance={frame}>
      <ResourcesSurface {...BASE} {...overrides} />
    </ShellFrame>,
  );
  return result.container;
}

const row = (id: string): HTMLElement => screen.getByTestId(`cr.resources.row.${id}`);

function valueOf(scope: HTMLElement, factId: string): string {
  return within(within(scope).getByTestId(`cr.fact.${factId}`)).getByTestId("cr.value")
    .textContent ?? "";
}

describe("resources surface, queue order", () => {
  it("renders waiters in the SUPPLIED order, never re-sorted by priority", () => {
    // The fixture supplies P3 before P1. A surface that sorted would render P1 first and
    // still look entirely reasonable, which is why the order is asserted directly.
    mount();
    const ids = [...within(row("db-main")).getAllByTestId(/^cr\.resources\.waiter\./u)]
      .map((node) => node.dataset["testid"]);
    expect(ids).toEqual(["cr.resources.waiter.w-7", "cr.resources.waiter.w-2"]);
  });

  it("renders every supplied waiter, so none is silently dropped", () => {
    mount();
    expect(within(row("db-main")).getAllByTestId(/^cr\.resources\.waiter\./u)).toHaveLength(2);
  });

  it("renders each waiter's priority as a supplied fact", () => {
    mount();
    const waiter = within(row("db-main")).getByTestId("cr.resources.waiter.w-7");
    expect(valueOf(waiter, "resource.waiter.priority.w-7")).toBe("P3");
  });

  it("renders an empty queue as no waiters rather than as an absent section", () => {
    mount({ rows: [resourceRow({ waiters: [] })] });
    expect(within(row("db-main")).queryAllByTestId(/^cr\.resources\.waiter\./u)).toHaveLength(0);
    expect(within(row("db-main")).getByTestId("cr.resources.queue")).toBeTruthy();
  });
});

describe("resources surface, holder and actions", () => {
  it("renders the holder, the holding task and the lease expiry", () => {
    mount();
    expect(valueOf(row("db-main"), "resource.holder")).toBe("w-3");
    expect(valueOf(row("db-main"), "resource.holdingtask")).toBe("api-endpnt");
    expect(valueOf(row("db-main"), "resource.leaseexpiry")).toBe("expires in 12m");
  });

  it("renders force-release only from nextAllowedCommands", () => {
    mount();
    expect(within(row("db-main")).getByTestId("cr.action.resource-release")).toBeTruthy();
  });

  it("renders NO action when the daemon returned none", () => {
    // Scoped to [data-command-id]: every Fact renders its chip as a button, so a role
    // query would be satisfied by chrome carrying no authority.
    mount({}, snapshot({ nextAllowedCommands: [] }));
    expect(row("db-main").querySelectorAll("[data-command-id]")).toHaveLength(0);
  });

  it("renders UNKNOWN when the payload omits the expiry, never blank", () => {
    mount({ rows: [resourceRow({ leaseExpiry: null })] });
    expect(valueOf(row("db-main"), "resource.leaseexpiry")).toBe("UNKNOWN");
  });
});

describe("resources surface, section 11.3 states", () => {
  it("renders the exact empty copy when no resources are declared", () => {
    mount({ rows: [] });
    expect(screen.getByTestId("cr.resources.empty").textContent).toBe(RESOURCES_EMPTY_COPY);
  });

  it("renders skeleton rows while loading, and no empty copy", () => {
    mount({ loading: true, rows: [] });
    expect(screen.getAllByTestId("cr.resources.skeleton").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("cr.resources.empty")).toBeNull();
  });

  it("flags rows stale when degraded", () => {
    mount({ degraded: true });
    expect(row("db-main").dataset["stale"]).toBe("true");
  });

  it("does not flag rows stale when not degraded", () => {
    mount();
    expect(row("db-main").dataset["stale"]).toBeUndefined();
  });
});

describe("resources surface, committed a11y audits", () => {
  /** Lagging frame so `auditLiveRegions` has a `cr.banner.*` to count — see the Runs
   * suite for why a checked === 0 audit is a pass over nothing. */
  function audited(): HTMLElement {
    return mount({}, snapshot({ statusLabel: "Lagging 4s behind" }));
  }

  it("passes auditFactChips with facts actually checked", () => {
    const result = auditFactChips(audited());
    expect(result.checked).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it("passes auditActionLegality with actions actually checked", () => {
    const result = auditActionLegality(audited(), COMMANDS);
    expect(result.checked).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it("passes auditKeyboardReachability with actions actually checked", () => {
    const result = auditKeyboardReachability(audited());
    expect(result.checked).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it("passes auditLiveRegions with banners actually checked", () => {
    const result = auditLiveRegions(audited());
    expect(result.checked).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });
});
