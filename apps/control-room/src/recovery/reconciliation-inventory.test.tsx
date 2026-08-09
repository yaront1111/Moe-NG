import { buildNextAllowedCommands } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import type { PresentedFact } from "../nodes/node-authority.js";
import { ShellFrame } from "../shell/frame.js";
import { ReconciliationInventory } from "./reconciliation-inventory.js";
import type {
  ReconciliationInventoryProps,
  ReconciliationRowPresentation,
} from "./reconciliation-inventory.js";
import type { RecoveryActionPresentation } from "./recovery-actions.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const obs = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });
const ver = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });
const unk = (value: string): PresentedFact => ({ truthClass: "UNKNOWN", value });

const RECORD_A = "task-0197";
const RECORD_B = "effect-8812";

function affordanceSeed(commandId: string, targetAggregateId: string): Record<string, unknown> {
  return {
    commandEnvelopeVersion: "moe-runtime-command/1",
    commandId,
    commandKind: "reconciliation.decide",
    expectedVersion: 3,
    inputSchemaVersion: "moe-runtime-command-input/1",
    targetAggregateId,
  };
}

const COMMANDS: readonly NextAllowedCommand[] = buildNextAllowedCommands(
  { aggregate: "PROJECT", state: "DEGRADED" },
  [
    affordanceSeed("cmd-a-accept", RECORD_A),
    affordanceSeed("cmd-a-discard", RECORD_A),
    affordanceSeed("cmd-b-accept", RECORD_B),
  ],
);

function commandById(commandId: string): NextAllowedCommand {
  const found = COMMANDS.find((entry) => entry.commandId === commandId);
  if (found === undefined) throw new Error(`corpus is missing ${commandId}`);
  return found;
}

const ACCEPT_A: RecoveryActionPresentation = {
  commandId: "cmd-a-accept",
  label: "Accept imported values",
  qualifier: "accept",
  targetAggregateId: RECORD_A,
};

const DISCARD_A: RecoveryActionPresentation = {
  commandId: "cmd-a-discard",
  label: "Discard record",
  qualifier: "discard",
  targetAggregateId: RECORD_A,
};

/** An expectation the daemon did not return and did not explain: absent, not disabled. */
const REPAIR_A: RecoveryActionPresentation = {
  commandId: "cmd-a-repair",
  label: "Mark for manual repair",
  qualifier: "repair",
  targetAggregateId: RECORD_A,
};

const HELD_B: RecoveryActionPresentation = {
  commandKind: "reconciliation.decide",
  label: "Discard record",
  qualifier: "discard",
  unavailable: {
    layer: "daemon.quarantine",
    phrase: "Discard is held while the forensic export is unread.",
    reasonCode: "QUARANTINE_FORENSIC_UNREAD",
  },
};

const ROW_A: ReconciliationRowPresentation = {
  actions: [ACCEPT_A, DISCARD_A, REPAIR_A],
  affected: [ver("node-0197-plan"), unk("effect-0197-launch")],
  caseType: ver("IMPORT_OWNER_AMBIGUOUS"),
  derived: unk("derived state unavailable while quarantined"),
  disposition: unk("NEEDS_RECONCILIATION"),
  evidence: obs("import-report-0197"),
  finding: ver("owner ambiguous (two claimants in legacy files)"),
  quarantined: ver("quarantined"),
  recordId: RECORD_A,
  schedulability: ver("unschedulable"),
};

const ROW_B: ReconciliationRowPresentation = {
  actions: [{ ...ACCEPT_A, commandId: "cmd-b-accept", targetAggregateId: RECORD_B }, HELD_B],
  affected: [],
  caseType: unk("case type unreadable"),
  derived: unk("derived state unavailable while quarantined"),
  disposition: unk("NEEDS_RECONCILIATION"),
  evidence: null,
  finding: unk("receipt digest does not match the staged bytes"),
  quarantined: ver("quarantined"),
  recordId: RECORD_B,
  schedulability: ver("unschedulable"),
};

const ROWS: readonly ReconciliationRowPresentation[] = [ROW_A, ROW_B];

/** §8.7 canonical copy, hand-written; only record and finding are substituted. */
const NARRATIVE_A = `${RECORD_A} failed integrity checks during import: `
  + "owner ambiguous (two claimants in legacy files). It is quarantined — it cannot be "
  + "scheduled and everything derived from it shows UNKNOWN.";

const EMPTY_COPY = "No reconciliation cases were supplied. An empty list is not proof "
  + "that none exist.";

function snapshot(
  commands: readonly NextAllowedCommand[] = COMMANDS,
): FixtureAffordanceSnapshot {
  return {
    connection: "LIVE",
    mutationsEnabled: true,
    nextAllowedCommands: commands,
    requiresAffordanceRefresh: false,
    statusLabel: "",
  };
}

function renderInventory(
  overrides: Partial<ReconciliationInventoryProps> = {},
  frame: FixtureAffordanceSnapshot = snapshot(),
): HTMLElement {
  const result = render(
    <ShellFrame affordance={frame}>
      <ReconciliationInventory
        authorityMode="LIVE"
        coverageLimitation={obs("scanned the 2026-08-09 import batch only")}
        rows={ROWS}
        {...overrides}
      />
    </ShellFrame>,
  );
  return result.container;
}

function row(recordId: string): HTMLElement {
  return screen.getByTestId(`cr.health.reconciliation.row.${recordId}`);
}

function valueOf(factId: string): string {
  return within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId("cr.value")
    .textContent ?? "";
}

function chipOf(factId: string): string {
  return within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId("cr.shortlabel")
    .textContent ?? "";
}

function actionIdsIn(recordId: string): readonly string[] {
  return [...within(row(recordId)).queryAllByRole("button", { hidden: true })]
    .map((node) => node.getAttribute("data-testid") ?? "")
    .filter((testId) => testId.startsWith("cr.action."));
}

describe("the reconciliation corpus is non-empty and really quarantined", () => {
  it("hand-writes two rows and three parsed affordances", () => {
    expect(ROWS).toHaveLength(2);
    expect(COMMANDS).toHaveLength(3);
    expect(ROWS.every((entry) => entry.disposition?.value === "NEEDS_RECONCILIATION")).toBe(true);
  });
});

describe("reconciliation rows keep the record's quarantine visible", () => {
  it("renders every supplied row in the supplied order under the spec-pinned id", () => {
    const container = renderInventory();
    const ids = [...container.querySelectorAll<HTMLElement>("[data-reconciliation-row]")]
      .map((node) => node.dataset["reconciliationRow"]);
    expect(ids).toEqual([RECORD_A, RECORD_B]);
    expect(row(RECORD_A)).toBeTruthy();
  });

  it("composes the canonical sentence from the supplied record and finding", () => {
    renderInventory();
    expect(within(row(RECORD_A)).getByTestId(`cr.health.reconciliation.narrative.${RECORD_A}`)
      .textContent).toBe(NARRATIVE_A);
  });

  it("says UNKNOWN in the sentence rather than inventing a finding", () => {
    renderInventory({ rows: [{ ...ROW_A, finding: null }] });
    expect(screen.getByTestId(`cr.health.reconciliation.narrative.${RECORD_A}`).textContent)
      .toBe(`${RECORD_A} failed integrity checks during import: UNKNOWN. It is quarantined `
        + "— it cannot be scheduled and everything derived from it shows UNKNOWN.");
  });

  it("renders quarantine, schedulability, disposition, and derived state as separate facts", () => {
    renderInventory();
    expect(valueOf(`reconciliation.${RECORD_A}.quarantined`)).toBe("quarantined");
    expect(valueOf(`reconciliation.${RECORD_A}.schedulability`)).toBe("unschedulable");
    expect(valueOf(`reconciliation.${RECORD_A}.disposition`)).toBe("NEEDS_RECONCILIATION");
    expect(chipOf(`reconciliation.${RECORD_A}.disposition`)).toBe("UNK");
    expect(chipOf(`reconciliation.${RECORD_A}.derived`)).toBe("UNK");
  });

  it("renders evidence and every affected id under entity-qualified fact ids", () => {
    renderInventory();
    expect(valueOf(`reconciliation.${RECORD_A}.evidence`)).toBe("import-report-0197");
    expect(valueOf(`reconciliation.${RECORD_A}.affected.0`)).toBe("node-0197-plan");
    expect(valueOf(`reconciliation.${RECORD_A}.affected.1`)).toBe("effect-0197-launch");
    expect(chipOf(`reconciliation.${RECORD_A}.affected.1`)).toBe("UNK");
  });

  it("renders an unsupplied evidence bundle and an empty affected list as UNKNOWN", () => {
    renderInventory();
    expect(valueOf(`reconciliation.${RECORD_B}.evidence`)).toBe("UNKNOWN");
    expect(valueOf(`reconciliation.${RECORD_B}.affected`)).toBe("UNKNOWN");
  });

  it("gives every fact wrapper exactly one truth chip", () => {
    const container = renderInventory();
    const facts = container.querySelectorAll("[data-testid^='cr.fact.']");
    const chips = container.querySelectorAll("[data-testid^='cr.chip.']");
    expect(facts.length).toBeGreaterThan(10);
    expect(chips.length).toBe(facts.length);
  });

  it("reports a unique record-qualified fact id for every provenance request", async () => {
    const seen: string[] = [];
    const container = renderInventory({ onProvenance: (factId) => seen.push(factId) });
    const chips = [...container.querySelectorAll<HTMLButtonElement>("[data-testid^='cr.chip.']")];
    for (const chip of chips) await userEvent.click(chip);
    expect(seen.length).toBe(chips.length);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(`reconciliation.${RECORD_A}.finding`);
  });
});

describe("reconciliation choices come only from current affordances", () => {
  it("renders Choose: followed by exactly the backed presentations", () => {
    renderInventory();
    expect(within(row(RECORD_A)).getByTestId(`cr.health.reconciliation.choose.${RECORD_A}`)
      .textContent).toBe("Choose:");
    expect(actionIdsIn(RECORD_A)).toEqual([
      "cr.action.reconciliation-decide.accept",
      "cr.action.reconciliation-decide.discard",
    ]);
  });

  it("omits the unreturned repair choice instead of hard-coding three mutations", () => {
    renderInventory();
    expect(actionIdsIn(RECORD_A)).not.toContain("cr.action.reconciliation-decide.repair");
    expect(actionIdsIn(RECORD_A)).toHaveLength(2);
  });

  it("keeps a daemon-explained choice visible, disabled, with its code and layer", () => {
    renderInventory();
    const held = within(row(RECORD_B))
      .getByTestId("cr.recovery.unavailable.reconciliation-decide.discard");
    expect(within(held).getByTestId("cr.recovery.reason.code").textContent)
      .toBe("QUARANTINE_FORENSIC_UNREAD");
    expect(within(held).getByTestId("cr.recovery.reason.layer").textContent)
      .toBe("daemon.quarantine");
  });

  it("hands the original daemon command back on activation", async () => {
    const seen: NextAllowedCommand[] = [];
    renderInventory({ onRequestConfirmation: (command) => seen.push(command) });
    await userEvent.click(
      within(row(RECORD_A)).getByTestId("cr.action.reconciliation-decide.accept"),
    );
    expect(seen).toEqual([commandById("cmd-a-accept")]);
    expect(seen[0]).toBe(commandById("cmd-a-accept"));
  });

  it("renders no control outside a truth chip or a recovery action group", () => {
    const container = renderInventory();
    for (const control of container.querySelectorAll<HTMLButtonElement>("button")) {
      const testId = control.getAttribute("data-testid") ?? "";
      const inGroup = control.closest("[data-recovery-actions]") !== null;
      expect(testId.startsWith("cr.chip.") || inGroup, `${testId} is a loose control`)
        .toBe(true);
    }
  });
});

describe("an empty or partial inventory states its own limits", () => {
  it("says an empty list is not proof and still renders the coverage limitation", () => {
    renderInventory({ rows: [] });
    expect(screen.getByTestId("cr.health.reconciliation.empty").textContent).toBe(EMPTY_COPY);
    expect(valueOf("reconciliation.coverage")).toBe("scanned the 2026-08-09 import batch only");
    expect(screen.queryByTestId(`cr.health.reconciliation.row.${RECORD_A}`)).toBeNull();
  });

  it("says UNKNOWN when no coverage limitation was supplied", () => {
    renderInventory({ coverageLimitation: null, rows: [] });
    expect(valueOf("reconciliation.coverage")).toBe("UNKNOWN");
  });

  it("keeps the coverage limitation visible when rows are present", () => {
    renderInventory();
    expect(valueOf("reconciliation.coverage")).toBe("scanned the 2026-08-09 import batch only");
    expect(screen.queryByTestId("cr.health.reconciliation.empty")).toBeNull();
  });
});

describe("reconciliation inventory keyboard walks the supplied rows", () => {
  it("moves focus with j/k, clamps at the ends, and opens the focused row", async () => {
    const focused: string[] = [];
    const opened: string[] = [];
    renderInventory({
      onFocusRow: (recordId) => focused.push(recordId),
      onOpenRow: (recordId) => opened.push(recordId),
    });
    screen.getByTestId("cr.health.reconciliation.list").focus();
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(row(RECORD_A));
    await userEvent.keyboard("jj");
    expect(document.activeElement).toBe(row(RECORD_B));
    await userEvent.keyboard("k");
    expect(document.activeElement).toBe(row(RECORD_A));
    await userEvent.keyboard("{Enter}");
    expect(focused).toEqual([RECORD_A, RECORD_B, RECORD_B, RECORD_A]);
    expect(opened).toEqual([RECORD_A]);
  });
});
