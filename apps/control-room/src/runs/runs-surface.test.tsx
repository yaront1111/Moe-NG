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
import { RUNS_EMPTY_COPY, SUSPECT_SENTENCE } from "./runs-contract.js";
import type { RunLeaseProjection, RunsSurfaceProps } from "./runs-contract.js";
import { RunsSurface } from "./runs-surface.js";

/**
 * Spec section 4.11 Runs/leases, section 5's lease matrix, section 8.2's SUSPECT row and
 * the section 11.3 loading/empty/degraded states.
 *
 * The load-bearing case is CR-J5-001 and it is first on purpose: an ACTIVE lease with a
 * healthy renewal and a LONG activity silence is NORMAL. A surface that renders a warning
 * or a revoke affordance there has decided the lease is suspicious — authority the daemon
 * never asserted. SUSPECT is SUSPECT because the payload says so.
 */
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const obs = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });
const ver = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });

const SESSION = "session-w-3";

function affordanceSeed(commandKind: string, commandId: string): Record<string, unknown> {
  return {
    commandEnvelopeVersion: "moe-runtime-command/1",
    commandId,
    commandKind,
    expectedVersion: 9,
    inputSchemaVersion: "moe-runtime-command-input/1",
    targetAggregateId: SESSION,
  };
}

/** `lease.extend` is a real RUNTIME_COMMAND_KIND; an invented kind is dropped by the
 * builder and would leave this fixture silently empty. */
const COMMANDS: readonly NextAllowedCommand[] = buildNextAllowedCommands(
  { aggregate: "PROJECT", state: "QUIESCED" },
  [affordanceSeed("lease.extend", "cmd-extend")],
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
 * The J5 shape: renewed seconds ago, quiet for 41 minutes. Both are supplied, both are
 * neutral, and the lease is ACTIVE. Nothing here may be read as trouble.
 */
function activeRow(overrides: Partial<RunLeaseProjection> = {}): RunLeaseProjection {
  return {
    actionTargetId: SESSION,
    activitySilence: obs("quiet 41m"),
    epoch: ver("epoch 7"),
    expiry: ver("expires in 4m"),
    gracePolicy: ver("grace 5m"),
    leaseState: ver("ACTIVE"),
    node: obs("api-endpnt"),
    owner: obs("worker"),
    renewalSilence: obs("renewed 41s ago"),
    role: obs("worker"),
    sessionId: "w-3",
    suspectSentence: null,
    ...overrides,
  };
}

function suspectRow(): RunLeaseProjection {
  return activeRow({
    activitySilence: obs("quiet 34m"),
    leaseState: ver("SUSPECT"),
    renewalSilence: obs("34m"),
    sessionId: "w-9",
    suspectSentence: ver(SUSPECT_SENTENCE),
  });
}

const BASE: RunsSurfaceProps = { degraded: false, loading: false, rows: [activeRow()] };

function mount(
  overrides: Partial<RunsSurfaceProps> = {},
  frame: FixtureAffordanceSnapshot = snapshot(),
): HTMLElement {
  const result = render(
    <ShellFrame affordance={frame}>
      <RunsSurface {...BASE} {...overrides} />
    </ShellFrame>,
  );
  return result.container;
}

const row = (sessionId: string): HTMLElement => screen.getByTestId(`cr.runs.row.${sessionId}`);

function valueOf(scope: HTMLElement, factId: string): string {
  return within(within(scope).getByTestId(`cr.fact.${factId}`)).getByTestId("cr.value")
    .textContent ?? "";
}

describe("runs surface, CR-J5-001", () => {
  it("keeps renewal silence and activity silence as two separate labeled facts", () => {
    // Merging them is the defect this scenario exists to catch: the J5 case is a healthy
    // renewal beside a long quiet build, and one combined datum cannot express that.
    mount();
    expect(valueOf(row("w-3"), "run.renewalsilence")).toBe("renewed 41s ago");
    expect(valueOf(row("w-3"), "run.activitysilence")).toBe("quiet 41m");
  });

  it("renders NO warning and NO revoke affordance while the lease is ACTIVE", () => {
    // Asserted as an ABSENCE, deliberately. A surface that inferred suspicion from a
    // 41-minute quiet value would still render both facts above and pass that test.
    mount();
    const active = row("w-3");
    expect(within(active).queryByTestId("cr.runs.suspect")).toBeNull();
    expect(within(active).queryByTestId("cr.runs.warning")).toBeNull();
    expect(active.textContent ?? "").not.toContain("revoke");
    expect(active.textContent ?? "").not.toContain("Revoke");
  });

  it("does not stamp cr.runs.suspect anywhere when no row is SUSPECT", () => {
    mount();
    expect(screen.queryAllByTestId("cr.runs.suspect")).toHaveLength(0);
  });
});

describe("runs surface, supplied suspicion", () => {
  it("stamps cr.runs.suspect only because the payload said SUSPECT", () => {
    mount({ rows: [activeRow(), suspectRow()] });
    expect(within(row("w-9")).getByTestId("cr.runs.suspect")).toBeTruthy();
    expect(within(row("w-3")).queryByTestId("cr.runs.suspect")).toBeNull();
  });

  it("renders the section 8.2 sentence from the payload, not from a client template", () => {
    mount({ rows: [suspectRow()] });
    expect(valueOf(row("w-9"), "run.suspectsentence")).toBe(SUSPECT_SENTENCE);
  });

  it("renders actions only from nextAllowedCommands", () => {
    mount({ rows: [suspectRow()] });
    expect(within(row("w-9")).getByTestId("cr.action.lease-extend")).toBeTruthy();
  });

  it("renders NO action when the daemon returned none, rather than a disabled guess", () => {
    // Spec 8.1: absent, never disabled with invented text.
    //
    // Scoped to [data-command-id] rather than role=button on purpose: every Fact renders
    // its truth chip as a button, so a role query is satisfied by chrome that has nothing
    // to do with authority and would pass against a surface full of invented controls.
    mount({ rows: [suspectRow()] }, snapshot({ nextAllowedCommands: [] }));
    expect(row("w-9").querySelectorAll("[data-command-id]")).toHaveLength(0);
  });
});

describe("runs surface, truth classes", () => {
  it("renders UNKNOWN with a chip when the payload omits a class, never defaulting upward", () => {
    mount({ rows: [activeRow({ leaseState: { value: "ACTIVE" } })] });
    const chip = within(within(row("w-3")).getByTestId("cr.fact.run.leasestate"))
      .getByTestId("cr.shortlabel").textContent ?? "";
    expect(chip).toContain("UNK");
  });

  it("renders UNKNOWN as the value when the payload supplied none", () => {
    mount({ rows: [activeRow({ expiry: null })] });
    expect(valueOf(row("w-3"), "run.expiry")).toBe("UNKNOWN");
  });
});

describe("runs surface, section 11.3 states", () => {
  it("renders the exact empty copy when the daemon reported no sessions", () => {
    mount({ rows: [] });
    expect(screen.getByTestId("cr.runs.empty").textContent).toBe(RUNS_EMPTY_COPY);
  });

  it("renders skeleton rows while loading, and no empty copy", () => {
    mount({ loading: true, rows: [] });
    expect(screen.getAllByTestId("cr.runs.skeleton").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("cr.runs.empty")).toBeNull();
  });

  it("flags rows stale and shows a lag banner when degraded", () => {
    mount({ degraded: true });
    expect(row("w-3").dataset["stale"]).toBe("true");
    expect(screen.getByTestId("cr.runs.stalelabel")).toBeTruthy();
  });

  it("does not flag rows stale when not degraded", () => {
    mount();
    expect(row("w-3").dataset["stale"]).toBeUndefined();
    expect(screen.queryByTestId("cr.runs.stalelabel")).toBeNull();
  });
});

describe("runs surface, committed a11y audits", () => {
  /**
   * The lagging frame is deliberate: `auditLiveRegions` only counts `cr.banner.*`, and
   * the Runs surface renders none of its own. Mounting a frame with no banner would give
   * checked === 0 — a pass over nothing. This audits the tree the app actually renders.
   */
  function audited(): HTMLElement {
    return mount(
      { rows: [activeRow(), suspectRow()] },
      snapshot({ statusLabel: "Lagging 4s behind" }),
    );
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
