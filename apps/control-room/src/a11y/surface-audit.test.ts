import type { NextAllowedCommand, RuntimeCommandKind } from "@moe/contracts";
import { describeTruthClass } from "@moe/control-room-model";
import type { TruthClass, TruthPresentationDescriptor } from "@moe/control-room-model";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CONTROL_ROOM_FIXTURES } from "../fixtures.js";
import { Fact } from "../kernel.js";
import { ShellFrame } from "../shell/frame.js";
import {
  auditActionLegality,
  auditActionParity,
  auditFactChips,
  auditKeyboardReachability,
  auditLiveRegions,
  auditTruthClassMonochrome,
} from "./surface-audit.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function fragment(markup: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = markup;
  return root;
}

function command(commandId: string): NextAllowedCommand {
  return Object.freeze({
    commandEnvelopeVersion: "moe-runtime-command/1",
    commandId,
    commandKind: "goal.create" as RuntimeCommandKind,
    expectedVersion: 1,
    inputSchemaVersion: "moe-runtime-command-input/1",
    targetAggregateId: "project-alpha",
  });
}

const TRUTH_CLASSES: readonly TruthClass[] = [
  "OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN",
];

function productionDescriptor(truthClass: TruthClass): TruthPresentationDescriptor {
  const described = describeTruthClass(truthClass);
  if (!described.ok) throw new Error(`missing production descriptor for ${truthClass}`);
  return described.descriptor;
}

describe("auditFactChips", () => {
  it("accepts a real rendered fact and rejects the exact wrapper missing its chip", () => {
    const affordance = CONTROL_ROOM_FIXTURES.affordances[0];
    if (affordance === undefined) throw new Error("expected a connected affordance fixture");
    const rendered = render(createElement(
      ShellFrame,
      { affordance },
      createElement(Fact, { factId: "real", label: "State", value: "READY" }),
    ));
    const real = auditFactChips(rendered.container);
    expect(real.checked).toBeGreaterThan(0);
    expect(real).toEqual({ checked: 1, violations: [] });

    const bad = auditFactChips(fragment('<div data-testid="cr.fact.orphan"></div>'));
    expect(bad.checked).toBeGreaterThan(0);
    expect(bad.violations).toEqual([
      { code: "FACT_WITHOUT_CHIP", testId: "cr.fact.orphan" },
    ]);
  });

  it("does not mistake the POL actor badge for a truth chip", () => {
    const root = fragment(`
      <div data-testid="cr.fact.policy-decision">
        <span data-testid="cr.chip.policy-approved">POL</span>
      </div>
    `);
    const result = auditFactChips(root);
    expect(result.checked).toBeGreaterThan(0);
    expect(result.violations).toEqual([
      { code: "FACT_WITHOUT_CHIP", testId: "cr.fact.policy-decision" },
    ]);
  });
});

describe("auditActionLegality", () => {
  it("checks enabled actions against supplied commands without indicting disabled actions", () => {
    const root = fragment(`
      <button data-testid="cr.action.allowed" data-command-id="cmd-allowed"></button>
      <button data-testid="cr.action.missing" data-command-id="cmd-other"></button>
      <button data-testid="cr.action.disabled" data-command-id="cmd-other" disabled></button>
    `);
    const result = auditActionLegality(root, [command("cmd-allowed")]);
    expect(result.checked).toBeGreaterThan(0);
    expect(result).toEqual({
      checked: 3,
      violations: [{ code: "ACTION_WITHOUT_COMMAND", testId: "cr.action.missing" }],
    });
  });
});

describe("auditKeyboardReachability", () => {
  it("names each hidden or negative-tab-index action as unreachable", () => {
    const root = fragment(`
      <button data-testid="cr.action.ok" style="order: 0"></button>
      <button data-testid="cr.action.negative" tabindex="-1" style="order: 1"></button>
      <button data-testid="cr.action.aria-hidden" aria-hidden="true" style="order: 2"></button>
      <button data-testid="cr.action.hidden" hidden style="order: 3"></button>
    `);
    const result = auditKeyboardReachability(root);
    expect(result.checked).toBeGreaterThan(0);
    expect(result.violations).toEqual([
      { code: "ACTION_UNREACHABLE", testId: "cr.action.negative" },
      { code: "ACTION_UNREACHABLE", testId: "cr.action.aria-hidden" },
      { code: "ACTION_UNREACHABLE", testId: "cr.action.hidden" },
    ]);
  });

  it("detects when CSS visual order disagrees with DOM keyboard order", () => {
    const root = fragment(`
      <button data-testid="cr.action.visually-second" style="order: 2"></button>
      <button data-testid="cr.action.visually-first" style="order: 1"></button>
    `);
    const result = auditKeyboardReachability(root);
    expect(result.checked).toBeGreaterThan(0);
    expect(result.violations).toEqual([
      { code: "ACTION_UNREACHABLE", testId: "cr.action.visually-second" },
      { code: "ACTION_UNREACHABLE", testId: "cr.action.visually-first" },
    ]);
  });
});

describe("auditLiveRegions", () => {
  it("requires every banner to declare live-region semantics", () => {
    const root = fragment(`
      <div data-testid="cr.banner.status" role="status"></div>
      <div data-testid="cr.banner.polite" aria-live="polite"></div>
      <div data-testid="cr.banner.silent"></div>
    `);
    const result = auditLiveRegions(root);
    expect(result.checked).toBeGreaterThan(0);
    expect(result.violations).toEqual([
      { code: "BANNER_WITHOUT_LIVE_REGION", testId: "cr.banner.silent" },
    ]);
  });
});

describe("auditActionParity", () => {
  it("reports the wide action that disappears from the narrow surface", () => {
    const wide = fragment(`
      <button data-testid="cr.action.shared"></button>
      <button data-testid="cr.action.desktop-only"></button>
    `);
    const narrow = fragment('<button data-testid="cr.action.shared"></button>');
    const result = auditActionParity(wide, narrow);
    expect(result.checked).toBeGreaterThan(0);
    expect(result).toEqual({
      checked: 2,
      violations: [
        { code: "ACTION_MISSING_AT_NARROW", testId: "cr.action.desktop-only" },
      ],
    });
  });
});

describe("auditTruthClassMonochrome", () => {
  it("checks exactly five production truth classes without using semantic tone", () => {
    const result = auditTruthClassMonochrome();
    expect(result.checked).toBe(5);
    expect(result.violations).toEqual([]);
  });

  it("fails closed when the supplied descriptor set is shorter than five", () => {
    const descriptors = TRUTH_CLASSES.slice(0, 4).map(productionDescriptor);
    const result = auditTruthClassMonochrome(descriptors);
    expect(result.checked).toBe(4);
    expect(result.violations).toEqual([
      { code: "TRUTH_CLASS_COUNT_MISMATCH", truthClasses: [] },
    ]);
  });

  it("detects a tuple collision even when semantic tones differ", () => {
    const descriptors = TRUTH_CLASSES.map(productionDescriptor);
    const observed = descriptors[0];
    const agent = descriptors[1];
    if (observed === undefined || agent === undefined) throw new Error("missing truth fixtures");
    expect(agent.semanticTone).not.toBe(observed.semanticTone);
    descriptors[1] = Object.freeze({
      ...agent,
      borderStyle: observed.borderStyle,
      glyph: observed.glyph,
      shortLabel: observed.shortLabel,
    });

    const result = auditTruthClassMonochrome(descriptors);
    expect(result.checked).toBe(5);
    expect(result.violations).toEqual([
      {
        code: "TRUTH_CLASS_MONOCHROME_COLLISION",
        truthClasses: ["OBSERVED", "AGENT_REPORTED"],
      },
    ]);
  });
});
