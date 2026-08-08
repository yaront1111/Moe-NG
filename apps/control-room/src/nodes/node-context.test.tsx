import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TRUTH_ABSENT_PROVENANCE, TRUTH_INVALID_PROVENANCE } from "../kernel.js";
import { UNKNOWN_FACT_VALUE } from "./node-authority.js";
import type { PresentedFact } from "./node-authority.js";
import { NodeContext } from "./node-context.js";
import type { NodeContextProps } from "./node-context.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const verified = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });
const observed = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });

const CONTEXT_FACT_IDS = [
  "node.binding.startedrevision", "node.binding.graphepoch", "node.binding.version",
  "node.binding.inputbindinghash",
  "node.input.manifestdigest", "node.input.tree",
  "node.result.manifestdigest", "node.result.tree",
  "node.context.digest", "node.context.providerinputdigest",
  "node.coverage.tokens", "node.coverage.bytes",
  "node.recovery.state", "node.recovery.reason",
] as const;

function contextProps(): NodeContextProps {
  return {
    binding: {
      bindingVersion: observed("binding v4"),
      graphEpoch: observed("graph epoch 12"),
      inputBindingHash: verified("sha256:inputbinding-1a"),
      startedRevision: observed("rev 9 (started)"),
    },
    coverage: { bytes: verified("18,204 bytes measured"), tokens: verified("6,113 tokens measured") },
    input: {
      manifestDigest: verified("sha256:inputmanifest-2b"),
      tree: verified("sha256:inputtree-3c"),
    },
    recovery: {
      commandKinds: ["reconciliation.decide"],
      reason: observed("consumer state unknown after relay restart"),
      state: observed("NEEDS_RECONCILIATION"),
    },
    result: {
      manifestDigest: verified("sha256:resultmanifest-4d"),
      tree: verified("sha256:resulttree-5e"),
    },
    workerContext: {
      contextDigest: verified("sha256:contextdigest-6f"),
      providerInputDigest: verified("sha256:providerinput-7a"),
    },
  };
}

const factIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll("[data-testid^='cr.fact.']")]
    .map((node) => node.getAttribute("data-testid") ?? "");

const valueOf = (factId: string): string =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId("cr.value").textContent ?? "";

const chipOf = (factId: string): HTMLElement =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId(/^cr\.chip\./u);

describe("node context keeps every binding and digest separately labelled", () => {
  it("renders each declared section with a heading and the pinned fact order", () => {
    const { container } = render(<NodeContext {...contextProps()} />);
    for (const section of ["binding", "input", "result", "context", "recovery"]) {
      const element = screen.getByTestId(`cr.inspector.section.${section}`);
      expect(element.tagName).toBe("SECTION");
      expect(within(element).getByRole("heading").textContent).not.toBe("");
    }
    expect(factIds(container)).toEqual(CONTEXT_FACT_IDS.map((id) => `cr.fact.${id}`));
  });

  it("distinguishes the started revision, graph epoch, binding version, and binding hash", () => {
    render(<NodeContext {...contextProps()} />);
    expect(valueOf("node.binding.startedrevision")).toBe("rev 9 (started)");
    expect(valueOf("node.binding.graphepoch")).toBe("graph epoch 12");
    expect(valueOf("node.binding.version")).toBe("binding v4");
    expect(valueOf("node.binding.inputbindinghash")).toBe("sha256:inputbinding-1a");
  });

  it("never collapses input identity into result identity", () => {
    render(<NodeContext {...contextProps()} />);
    const shown = [
      valueOf("node.input.manifestdigest"), valueOf("node.input.tree"),
      valueOf("node.result.manifestdigest"), valueOf("node.result.tree"),
    ];
    expect(shown).toEqual([
      "sha256:inputmanifest-2b", "sha256:inputtree-3c",
      "sha256:resultmanifest-4d", "sha256:resulttree-5e",
    ]);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it("keeps the rendered context digest apart from the adapter-observed input digest", () => {
    render(<NodeContext {...contextProps()} />);
    // Two different measurements of two different byte streams; one label for both
    // would let a drifting adapter submission read as the delivered context.
    expect(valueOf("node.context.digest")).toBe("sha256:contextdigest-6f");
    expect(valueOf("node.context.providerinputdigest")).toBe("sha256:providerinput-7a");
    expect(valueOf("node.coverage.tokens")).toBe("6,113 tokens measured");
    expect(valueOf("node.coverage.bytes")).toBe("18,204 bytes measured");
  });
});

describe("recovery state is displayed as supplied, never inferred", () => {
  it("shows the daemon's reconciliation state, reason, and only its commands", () => {
    const { container } = render(<NodeContext {...contextProps()} />);
    expect(valueOf("node.recovery.state")).toBe("NEEDS_RECONCILIATION");
    expect(valueOf("node.recovery.reason")).toBe("consumer state unknown after relay restart");
    const actions = [...container.querySelectorAll("[data-testid^='cr.action.']")]
      .map((node) => node.getAttribute("data-testid"));
    expect(actions).toEqual(["cr.action.reconciliation-decide"]);
  });

  it("offers no recovery command when the daemon supplied none for that state", () => {
    const base = contextProps();
    const { container } = render(
      <NodeContext {...base} recovery={{ ...base.recovery, commandKinds: [] }} />,
    );
    expect(valueOf("node.recovery.state")).toBe("NEEDS_RECONCILIATION");
    expect(container.querySelectorAll("[data-testid^='cr.action.']").length).toBe(0);
    expect(screen.getByTestId("cr.inspector.recoverycommands").textContent)
      .toBe("No commands supplied by the daemon.");
  });

  it("does not mutate the supplied command array while rendering it", () => {
    const base = contextProps();
    const commandKinds = Object.freeze(["resource.reconcile", "reconciliation.decide"]);
    const { container } = render(
      <NodeContext {...base} recovery={{ ...base.recovery, commandKinds }} />,
    );
    expect([...container.querySelectorAll("[data-testid^='cr.action.']")]
      .map((node) => node.textContent))
      .toEqual(["resource.reconcile", "reconciliation.decide"]);
    expect([...commandKinds]).toEqual(["resource.reconcile", "reconciliation.decide"]);
  });
});

describe("missing measurements stay UNKNOWN instead of becoming zero or verified", () => {
  it("renders UNKNOWN with the missing-class note for absent digests and coverage", () => {
    const base = contextProps();
    render(
      <NodeContext
        {...base}
        coverage={{ bytes: { value: "" }, tokens: null }}
        workerContext={{ ...base.workerContext, providerInputDigest: null }}
      />,
    );
    for (const factId of [
      "node.coverage.tokens", "node.coverage.bytes", "node.context.providerinputdigest",
    ]) {
      expect(valueOf(factId)).toBe(UNKNOWN_FACT_VALUE);
      const chip = chipOf(factId);
      expect(chip.getAttribute("data-truth-class")).toBe("UNKNOWN");
      expect(chip.getAttribute("data-origin")).toBe("ABSENT");
      expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_ABSENT_PROVENANCE);
    }
  });

  it("never lets an absent measurement read as zero, verified, current, or successful", () => {
    const base = contextProps();
    const { container } = render(
      <NodeContext
        {...base}
        coverage={{ bytes: null, tokens: null }}
        result={{ manifestDigest: null, tree: null }}
      />,
    );
    const degraded = ["node.coverage.tokens", "node.coverage.bytes",
      "node.result.manifestdigest", "node.result.tree"];
    for (const factId of degraded) {
      const wrapper = screen.getByTestId(`cr.fact.${factId}`);
      expect(within(wrapper).getByTestId("cr.value").textContent).toBe(UNKNOWN_FACT_VALUE);
      expect(wrapper.textContent).not.toMatch(/\b0\b|verified|current|success/iu);
    }
    // Nine digests were verified; withdrawing four must leave five, not nine — a
    // fallback that reuses the previous class would keep the green chip count.
    expect(container.querySelectorAll("[data-testid='cr.chip.daemon_verified']").length).toBe(5);
    expect(container.querySelectorAll("[data-testid='cr.chip.unknown']").length)
      .toBe(degraded.length);
  });

  it("reports TRUTH_CLASS_INVALID when a supplied class is not a daemon value", () => {
    const base = contextProps();
    render(
      <NodeContext
        {...base}
        input={{ ...base.input, tree: { truthClass: "DAEMON_VERIFIED ", value: "sha256:x" } }}
      />,
    );
    const chip = chipOf("node.input.tree");
    expect(chip.getAttribute("data-origin")).toBe("INVALID");
    expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_INVALID_PROVENANCE);
    expect(TRUTH_INVALID_PROVENANCE).toContain("TRUTH_CLASS_INVALID");
  });
});
