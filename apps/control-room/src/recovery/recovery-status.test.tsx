import { buildNextAllowedCommands } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import type { PresentedFact } from "../nodes/node-authority.js";
import { ShellFrame } from "../shell/frame.js";
import { RECOVERY_INVENTORY_CLASSES } from "./recovery-external.js";
import type { RecoveryInventoryClassPresentation } from "./recovery-external.js";
import type { RecoveryActionPresentation } from "./recovery-actions.js";
import { RecoveryStatus } from "./recovery-status.js";
import type { RecoveryStatusProps } from "./recovery-status.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const obs = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });
const ver = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });
const unk = (value: string): PresentedFact => ({ truthClass: "UNKNOWN", value });

const PROJECT = "project-moe-next";

/** Design 16.5, hand-written. The surface may never drop or soften this sentence. */
const RPO_LIMIT = "Acknowledged events after this backup cursor are outside this backup's "
  + "RPO. A disaster restore does not claim they survived.";

const EXPORT_NOTE = "An export is not a restorable backup: it names one committed sequence "
  + "and carries no RPO, no artifact key chain, and no restore authority.";

const INVENTORY_EMPTY = "No items were listed for this class. An empty list is not a "
  + "completeness proof.";

/** Design 978, verbatim, in design order. */
const CLASS_LABELS = [
  "Workspaces", "Effect locks and wrapper registrations", "Provider runs", "Resources",
  "Branches and refs", "Integration targets", "Artifact staging",
] as const;

function inventoryClass(
  index: number,
  overrides: Partial<RecoveryInventoryClassPresentation> = {},
): RecoveryInventoryClassPresentation {
  const classId = RECOVERY_INVENTORY_CLASSES[index];
  if (classId === undefined) throw new Error(`no inventory class at ${index}`);
  return {
    blindSpots: [obs(`${classId} blind spot`)],
    classId,
    completeness: ver(`${classId} enumeration proven complete`),
    coverageWindow: ver("cursor #4819 to 2026-08-09T06:00:00.000Z"),
    items: [
      { disposition: ver("proven absent"), identity: ver(`${classId}-item-1`), itemId: "i1" },
    ],
    ...overrides,
  };
}

const CLASSES: readonly RecoveryInventoryClassPresentation[] =
  RECOVERY_INVENTORY_CLASSES.map((_, index) => inventoryClass(index));

function affordanceSeed(commandKind: string, commandId: string): Record<string, unknown> {
  return {
    commandEnvelopeVersion: "moe-runtime-command/1",
    commandId,
    commandKind,
    expectedVersion: 9,
    inputSchemaVersion: "moe-runtime-command-input/1",
    targetAggregateId: PROJECT,
  };
}

const COMMANDS: readonly NextAllowedCommand[] = buildNextAllowedCommands(
  { aggregate: "PROJECT", state: "QUIESCED" },
  [
    affordanceSeed("recovery.inspect_external", "cmd-inspect"),
    affordanceSeed("recovery.reconcile_external", "cmd-reconcile"),
    affordanceSeed("export.run", "cmd-export"),
  ],
);

const INSPECT: RecoveryActionPresentation = {
  commandId: "cmd-inspect",
  label: "Inspect external state",
  targetAggregateId: PROJECT,
};

const COMPLETE: RecoveryActionPresentation = {
  commandId: "cmd-complete",
  label: "Complete recovery",
  targetAggregateId: PROJECT,
};

function snapshot(
  commands: readonly NextAllowedCommand[] = COMMANDS,
): FixtureAffordanceSnapshot {
  return {
    connection: "CONNECTED",
    mutationsEnabled: true,
    nextAllowedCommands: commands,
    requiresAffordanceRefresh: false,
    statusLabel: "",
  };
}

const BASE: RecoveryStatusProps = {
  authorityMode: "LIVE",
  backup: {
    byteVerification: ver("all 1841 objects verified"),
    committedCursor: ver("#4700"),
    generation: ver("backup-gen-7"),
    keyChain: ver("signing key epoch 4, rotation chain intact"),
    manifestDigest: ver("sha256:9f21…"),
    objectCoverage: ver("1841 objects, 4.2 GiB"),
    rpo: ver("07:00 daily"),
  },
  export: {
    committedSequence: ver("#4819"),
    generation: ver("export-gen-3"),
  },
  inventory: CLASSES,
  outbox: {
    aggregate: ver("goal, node_run, effect"),
    appliedCursor: ver("#4819"),
    emittedCursor: ver("#4819"),
    lagState: ver("live"),
    poison: ver("none recorded"),
  },
  projectActions: [INSPECT, COMPLETE],
  versions: {
    compatibility: ver("compatible: daemon evaluated 3.53.4 against 3.51.3"),
    engineVersion: ver("SQLite 3.53.4"),
    requiredMinimum: ver("3.51.3"),
    schemaVersion: ver("v3"),
  },
};

function renderStatus(
  overrides: Partial<RecoveryStatusProps> = {},
  frame: FixtureAffordanceSnapshot = snapshot(),
): HTMLElement {
  const result = render(
    <ShellFrame affordance={frame}>
      <RecoveryStatus {...BASE} {...overrides} />
    </ShellFrame>,
  );
  return result.container;
}

function valueOf(factId: string): string {
  return within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId("cr.value")
    .textContent ?? "";
}

function chipOf(factId: string): string {
  return within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId("cr.shortlabel")
    .textContent ?? "";
}

describe("the inventory corpus covers every declared external class", () => {
  it("declares exactly the seven design-named classes in design order", () => {
    expect(RECOVERY_INVENTORY_CLASSES).toHaveLength(7);
    expect([...RECOVERY_INVENTORY_CLASSES]).toEqual([
      "workspaces", "effect-locks", "provider-runs", "resources", "branches-refs",
      "integration-targets", "artifact-staging",
    ]);
    expect(CLASSES).toHaveLength(7);
  });
});

describe("outbox state renders as independent supplied facts", () => {
  it("renders applied and emitted cursors separately and computes no lag", () => {
    renderStatus();
    expect(screen.getByTestId("cr.health.outbox")).toBeTruthy();
    expect(valueOf("recovery.outbox.applied")).toBe("#4819");
    expect(valueOf("recovery.outbox.emitted")).toBe("#4819");
    expect(valueOf("recovery.outbox.lag")).toBe("live");
    expect(valueOf("recovery.outbox.poison")).toBe("none recorded");
    expect(valueOf("recovery.outbox.aggregate")).toBe("goal, node_run, effect");
  });

  it("keeps the supplied lag state even when the two cursors already agree", () => {
    renderStatus({
      outbox: { ...BASE.outbox, lagState: unk("lag state not reported") },
    });
    expect(valueOf("recovery.outbox.lag")).toBe("lag state not reported");
    expect(chipOf("recovery.outbox.lag")).toBe("UNK");
  });

  it("says UNKNOWN for a cursor the daemon did not supply", () => {
    renderStatus({ outbox: { ...BASE.outbox, appliedCursor: null } });
    expect(valueOf("recovery.outbox.applied")).toBe("UNKNOWN");
  });
});

describe("engine and schema versions render without a client-side compatibility verdict", () => {
  it("renders engine, schema, minimum, and the daemon's own verdict separately", () => {
    renderStatus();
    expect(screen.getByTestId("cr.health.versions")).toBeTruthy();
    expect(valueOf("recovery.versions.engine")).toBe("SQLite 3.53.4");
    expect(valueOf("recovery.versions.schema")).toBe("v3");
    expect(valueOf("recovery.versions.minimum")).toBe("3.51.3");
    expect(valueOf("recovery.versions.compatibility"))
      .toBe("compatible: daemon evaluated 3.53.4 against 3.51.3");
  });

  it("stays UNKNOWN on compatibility even when both versions are present", () => {
    renderStatus({
      versions: { ...BASE.versions, compatibility: null },
    });
    expect(valueOf("recovery.versions.compatibility")).toBe("UNKNOWN");
    expect(chipOf("recovery.versions.compatibility")).toBe("UNK");
  });
});

describe("backup generation states its cursor, its proofs, and its RPO limit", () => {
  it("renders one generation's cursor, manifest, coverage, bytes, and key chain", () => {
    renderStatus();
    expect(valueOf("recovery.backup.generation")).toBe("backup-gen-7");
    expect(valueOf("recovery.backup.cursor")).toBe("#4700");
    expect(valueOf("recovery.backup.rpo")).toBe("07:00 daily");
    expect(valueOf("recovery.backup.manifestdigest")).toBe("sha256:9f21…");
    expect(valueOf("recovery.backup.objectcoverage")).toBe("1841 objects, 4.2 GiB");
    expect(valueOf("recovery.backup.byteverification")).toBe("all 1841 objects verified");
    expect(valueOf("recovery.backup.keychain"))
      .toBe("signing key epoch 4, rotation chain intact");
  });

  it("always states that post-cursor acknowledgements are outside the RPO", () => {
    renderStatus();
    expect(screen.getByTestId("cr.health.backup.rpolimit").textContent).toBe(RPO_LIMIT);
  });

  it("states the RPO limit even when every backup proof is missing", () => {
    renderStatus({
      backup: {
        byteVerification: null, committedCursor: null, generation: null, keyChain: null,
        manifestDigest: null, objectCoverage: null, rpo: null,
      },
    });
    expect(screen.getByTestId("cr.health.backup.rpolimit").textContent).toBe(RPO_LIMIT);
    expect(valueOf("recovery.backup.byteverification")).toBe("UNKNOWN");
    expect(chipOf("recovery.backup.byteverification")).toBe("UNK");
  });

  it("distinguishes an export at a committed sequence from a restorable backup", () => {
    renderStatus();
    expect(valueOf("recovery.export.sequence")).toBe("#4819");
    expect(valueOf("recovery.export.generation")).toBe("export-gen-3");
    expect(screen.getByTestId("cr.health.export.note").textContent).toBe(EXPORT_NOTE);
  });
});

describe("external inventory renders every class, its coverage, and its blind spots", () => {
  it("renders the seven classes with the design's own labels", () => {
    const container = renderStatus();
    const shown = [...container.querySelectorAll<HTMLElement>("[data-inventory-class]")];
    expect(shown.map((node) => node.dataset["inventoryClass"]))
      .toEqual([...RECOVERY_INVENTORY_CLASSES]);
    expect(shown.map((node) => within(node).getByTestId("cr.health.inventory.label")
      .textContent)).toEqual([...CLASS_LABELS]);
  });

  it("renders coverage window, completeness proof, items, and blind spots per class", () => {
    renderStatus();
    expect(valueOf("recovery.inventory.workspaces.coverage"))
      .toBe("cursor #4819 to 2026-08-09T06:00:00.000Z");
    expect(valueOf("recovery.inventory.workspaces.completeness"))
      .toBe("workspaces enumeration proven complete");
    expect(valueOf("recovery.inventory.workspaces.blindspot.0")).toBe("workspaces blind spot");
    expect(valueOf("recovery.inventory.workspaces.item.i1.identity"))
      .toBe("workspaces-item-1");
    expect(valueOf("recovery.inventory.workspaces.item.i1.disposition")).toBe("proven absent");
  });

  it("refuses to read an empty item list with UNKNOWN completeness as clean", () => {
    renderStatus({
      inventory: [inventoryClass(0, { completeness: null, items: [] }), ...CLASSES.slice(1)],
    });
    const panel = screen.getByTestId("cr.health.inventory.workspaces");
    expect(within(panel).getByTestId("cr.health.inventory.workspaces.empty").textContent)
      .toBe(INVENTORY_EMPTY);
    expect(valueOf("recovery.inventory.workspaces.completeness")).toBe("UNKNOWN");
    expect(chipOf("recovery.inventory.workspaces.completeness")).toBe("UNK");
  });

  it("says UNKNOWN when a class declares no blind spot at all", () => {
    renderStatus({
      inventory: [inventoryClass(0, { blindSpots: [] }), ...CLASSES.slice(1)],
    });
    expect(valueOf("recovery.inventory.workspaces.blindspot")).toBe("UNKNOWN");
  });

  it("gives every fact wrapper exactly one truth chip", () => {
    const container = renderStatus();
    const facts = container.querySelectorAll("[data-testid^='cr.fact.']");
    const chips = container.querySelectorAll("[data-testid^='cr.chip.']");
    expect(facts.length).toBeGreaterThan(40);
    expect(chips.length).toBe(facts.length);
  });
});

describe("project recovery actions come only from current affordances", () => {
  it("renders the supplied inspect command and omits the unreturned completion", () => {
    renderStatus();
    const group = screen.getByTestId("cr.recovery.project");
    expect([...within(group).queryAllByRole("button", { hidden: true })]
      .map((node) => node.getAttribute("data-testid")))
      .toEqual(["cr.action.recovery-inspect-external"]);
    expect(screen.queryByTestId("cr.action.recovery-complete")).toBeNull();
  });

  it("never derives recovery completion from an inventory that lists no items", () => {
    renderStatus({
      inventory: RECOVERY_INVENTORY_CLASSES.map((_, index) =>
        inventoryClass(index, { blindSpots: [], items: [] })),
      projectActions: [COMPLETE],
    });
    expect(screen.queryByTestId("cr.action.recovery-complete")).toBeNull();
  });

  it("hands the daemon's own command back on activation", async () => {
    const seen: NextAllowedCommand[] = [];
    renderStatus({ onRequestConfirmation: (command) => seen.push(command) });
    await userEvent.click(screen.getByTestId("cr.action.recovery-inspect-external"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.commandId).toBe("cmd-inspect");
    expect(seen[0]).toBe(COMMANDS.find((entry) => entry.commandId === "cmd-inspect"));
  });

  it("offers no browser-side restore, upload, or file control", () => {
    renderStatus();
    const surface = screen.getByTestId("cr.surface.recovery");
    expect(surface.querySelectorAll("input")).toHaveLength(0);
    expect(surface.querySelectorAll("form")).toHaveLength(0);
    expect(surface.querySelectorAll("a")).toHaveLength(0);
    const controls = [...surface.querySelectorAll<HTMLButtonElement>("button")];
    expect(controls.length).toBeGreaterThan(20);
    for (const control of controls) {
      const testId = control.getAttribute("data-testid") ?? "";
      const inGroup = control.closest("[data-recovery-actions]") !== null;
      expect(testId.startsWith("cr.chip.") || inGroup, `${testId} is a loose control`)
        .toBe(true);
    }
  });
});
