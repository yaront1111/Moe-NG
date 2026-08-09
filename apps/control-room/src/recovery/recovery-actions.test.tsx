import { buildNextAllowedCommands } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import { ShellFrame } from "../shell/frame.js";
import { RecoveryActions } from "./recovery-actions.js";
import type {
  RecoveryActionPresentation,
  RecoveryActionsProps,
  RecoveryAuthorityMode,
  RecoveryCommandPresentation,
  RecoveryFeedback,
  RecoveryUnavailableReason,
} from "./recovery-actions.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const PROJECT = "project-moe-next";
const RECORD = "record-0197";

/** §12 line 711 verbatim; hand-written so the module cannot reword it. */
const STILL_WORKING = "still working — the daemon accepted the command (event pending)";

function affordanceSeed(
  commandKind: string,
  commandId: string,
  targetAggregateId: string,
): Record<string, unknown> {
  return {
    commandEnvelopeVersion: "moe-runtime-command/1",
    commandId,
    commandKind,
    expectedVersion: 12,
    inputSchemaVersion: "moe-runtime-command-input/1",
    targetAggregateId,
  };
}

/**
 * Built through the daemon's own parser, so an affordance this suite trusts is one the
 * daemon would actually have emitted. `buildNextAllowedCommands` sorts by kind, so the
 * suite never assumes insertion order.
 */
const COMMANDS: readonly NextAllowedCommand[] = buildNextAllowedCommands(
  { aggregate: "PROJECT", state: "QUIESCED" },
  [
    affordanceSeed("recovery.complete", "cmd-recovery-complete", PROJECT),
    affordanceSeed("recovery.inspect_external", "cmd-recovery-inspect", PROJECT),
    affordanceSeed("reconciliation.decide", "cmd-reconcile-accept", RECORD),
    affordanceSeed("reconciliation.decide", "cmd-reconcile-discard", RECORD),
  ],
);

function commandById(commandId: string): NextAllowedCommand {
  const found = COMMANDS.find((entry) => entry.commandId === commandId);
  if (found === undefined) throw new Error(`corpus is missing ${commandId}`);
  return found;
}

const COMPLETE: RecoveryCommandPresentation = {
  commandId: "cmd-recovery-complete",
  label: "Complete recovery",
  targetAggregateId: PROJECT,
};

const ACCEPT: RecoveryCommandPresentation = {
  commandId: "cmd-reconcile-accept",
  label: "Accept imported values",
  qualifier: "accept",
  targetAggregateId: RECORD,
};

const DISCARD: RecoveryCommandPresentation = {
  commandId: "cmd-reconcile-discard",
  label: "Discard record",
  qualifier: "discard",
  targetAggregateId: RECORD,
};

const REPAIR_REASON: RecoveryUnavailableReason = {
  layer: "daemon.policy",
  phrase: "Manual repair is held while the incarnation nonce is unverified.",
  reasonCode: "RECOVERY_INCARNATION_UNVERIFIED",
};

const REPAIR_UNAVAILABLE: RecoveryActionPresentation = {
  commandKind: "reconciliation.decide",
  label: "Mark for manual repair",
  qualifier: "repair",
  unavailable: REPAIR_REASON,
};

function snapshot(
  commands: readonly NextAllowedCommand[],
  overrides: Partial<FixtureAffordanceSnapshot> = {},
): FixtureAffordanceSnapshot {
  return {
    connection: "CONNECTED",
    mutationsEnabled: true,
    nextAllowedCommands: commands,
    requiresAffordanceRefresh: false,
    statusLabel: "",
    ...overrides,
  };
}

function renderActions(
  overrides: Partial<RecoveryActionsProps> = {},
  frame: FixtureAffordanceSnapshot = snapshot(COMMANDS),
): HTMLElement {
  const result = render(
    <ShellFrame affordance={frame}>
      <RecoveryActions
        authorityMode="LIVE"
        presentations={[COMPLETE, ACCEPT, DISCARD]}
        testId="cr.recovery.actions"
        {...overrides}
      />
    </ShellFrame>,
  );
  return result.container;
}

function actionIds(): readonly string[] {
  return [...within(screen.getByTestId("cr.recovery.actions"))
    .queryAllByRole("button", { hidden: true })]
    .map((node) => node.getAttribute("data-testid") ?? "");
}

function button(testId: string): HTMLButtonElement {
  return screen.getByTestId<HTMLButtonElement>(testId);
}

describe("the affordance corpus is real daemon output, not a hand-shaped stub", () => {
  it("parses four affordances through the production builder", () => {
    expect(COMMANDS).toHaveLength(4);
    expect(COMMANDS.map((entry) => entry.commandId).sort()).toEqual([
      "cmd-reconcile-accept", "cmd-reconcile-discard", "cmd-recovery-complete",
      "cmd-recovery-inspect",
    ]);
    expect(Object.isFrozen(commandById("cmd-recovery-complete"))).toBe(true);
  });
});

describe("recovery actions exist only because a current affordance exists", () => {
  it("renders one uniquely identified control per matched presentation", () => {
    renderActions();
    expect(actionIds()).toEqual([
      "cr.action.recovery-complete",
      "cr.action.reconciliation-decide.accept",
      "cr.action.reconciliation-decide.discard",
    ]);
    expect(new Set(actionIds()).size).toBe(3);
  });

  it("carries the exact command identity and target on each control", () => {
    renderActions();
    const control = button("cr.action.reconciliation-decide.accept");
    expect(control.dataset["commandId"]).toBe("cmd-reconcile-accept");
    expect(control.dataset["commandKind"]).toBe("reconciliation.decide");
    expect(control.dataset["commandTarget"]).toBe(RECORD);
    expect(control.textContent).toBe("Accept imported values");
    expect(control.getAttribute("aria-label")).toBe(`Accept imported values: ${RECORD}`);
    expect(control.disabled).toBe(false);
  });

  it("hands back the daemon's own command object and the original presentation", async () => {
    const seen: { command: NextAllowedCommand; presentation: RecoveryCommandPresentation }[] = [];
    renderActions({
      onRequestConfirmation: (command, presentation) => seen.push({ command, presentation }),
    });
    await userEvent.click(button("cr.action.recovery-complete"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe(commandById("cmd-recovery-complete"));
    expect(seen[0]?.presentation).toBe(COMPLETE);
  });

  it("omits a presentation whose command id is not in the current set", () => {
    renderActions({
      presentations: [{ ...COMPLETE, commandId: "cmd-recovery-complete-stale" }],
    });
    expect(actionIds()).toEqual([]);
    expect(screen.queryByTestId("cr.action.recovery-complete")).toBeNull();
  });

  it("omits a presentation whose target does not match the supplied command", () => {
    renderActions({ presentations: [{ ...COMPLETE, targetAggregateId: "project-other" }] });
    expect(actionIds()).toEqual([]);
  });

  it("omits an ambiguous match rather than picking one", () => {
    const duplicated = [...COMMANDS, commandById("cmd-recovery-complete")];
    expect(duplicated.filter((entry) => entry.commandId === "cmd-recovery-complete"))
      .toHaveLength(2);
    renderActions({ presentations: [COMPLETE] }, snapshot(duplicated));
    expect(actionIds()).toEqual([]);
  });

  it("never joins two unnamed identities, even if both sides are blank", () => {
    const unnamed = Object.freeze({
      commandEnvelopeVersion: "moe-runtime-command/1", commandId: "  ",
      commandKind: "recovery.complete", expectedVersion: 1,
      inputSchemaVersion: "moe-runtime-command-input/1", targetAggregateId: "  ",
    }) as unknown as NextAllowedCommand;
    renderActions(
      { presentations: [{ ...COMPLETE, commandId: "  ", targetAggregateId: "  " }] },
      snapshot([unnamed]),
    );
    expect(actionIds()).toEqual([]);
  });

  it("renders both of two identical presentations rather than deduplicating them", () => {
    renderActions({ presentations: [COMPLETE, COMPLETE] });
    expect(actionIds()).toEqual([
      "cr.action.recovery-complete", "cr.action.recovery-complete",
    ]);
  });

  it("falls back to the daemon's command kind when the label is blank", () => {
    renderActions({ presentations: [{ ...COMPLETE, label: "   " }] });
    const control = button("cr.action.recovery-complete");
    expect(control.textContent).toBe("recovery.complete");
    expect(control.getAttribute("aria-label")).toBe(`recovery.complete: ${PROJECT}`);
  });

  it("grants nothing at all when rendered outside a shell frame", () => {
    render(
      <RecoveryActions
        authorityMode="LIVE"
        presentations={[COMPLETE, ACCEPT]}
        testId="cr.recovery.actions"
      />,
    );
    expect(actionIds()).toEqual([]);
  });
});

describe("an unavailable presentation states the code and the refusing layer", () => {
  it("renders the daemon's phrase, stable code, and layer on a disabled control", () => {
    renderActions({ presentations: [REPAIR_UNAVAILABLE] });
    const control = button("cr.action.reconciliation-decide.repair");
    expect(control.disabled).toBe(true);
    expect(control.dataset["commandId"]).toBeUndefined();
    const reason = screen.getByTestId("cr.recovery.unavailable.reconciliation-decide.repair");
    expect(within(reason).getByTestId("cr.recovery.reason.phrase").textContent)
      .toBe(REPAIR_REASON.phrase);
    expect(within(reason).getByTestId("cr.recovery.reason.code").textContent)
      .toBe("RECOVERY_INCARNATION_UNVERIFIED");
    expect(within(reason).getByTestId("cr.recovery.reason.layer").textContent)
      .toBe("daemon.policy");
  });

  it("says UNKNOWN instead of inventing a code or a layer", () => {
    renderActions({
      presentations: [{
        ...REPAIR_UNAVAILABLE,
        unavailable: { layer: "  ", phrase: "Held.", reasonCode: "" },
      }],
    });
    const reason = screen.getByTestId("cr.recovery.unavailable.reconciliation-decide.repair");
    expect(within(reason).getByTestId("cr.recovery.reason.code").textContent).toBe("UNKNOWN");
    expect(within(reason).getByTestId("cr.recovery.reason.layer").textContent).toBe("UNKNOWN");
  });

  it("never activates an unavailable control", async () => {
    const seen: NextAllowedCommand[] = [];
    renderActions({
      onRequestConfirmation: (command) => seen.push(command),
      presentations: [REPAIR_UNAVAILABLE],
    });
    await userEvent.click(button("cr.action.reconciliation-decide.repair"));
    expect(seen).toEqual([]);
  });
});

describe("recovery actions use the supplied authority verbatim and fail closed", () => {
  it("disables every control when the snapshot says mutations are off", () => {
    renderActions(
      { disabledCopy: "Commands are unavailable while the daemon is unreachable." },
      snapshot(COMMANDS, { connection: "DISCONNECTED", mutationsEnabled: false }),
    );
    for (const testId of actionIds()) expect(button(testId).disabled).toBe(true);
    expect(screen.getByTestId("cr.recovery.disabledcopy").textContent)
      .toBe("Commands are unavailable while the daemon is unreachable.");
  });

  it("says UNKNOWN rather than inventing a disabled explanation", () => {
    renderActions({}, snapshot(COMMANDS, { mutationsEnabled: false }));
    expect(screen.getByTestId("cr.recovery.disabledcopy").textContent).toBe("UNKNOWN");
  });

  const NON_LIVE: readonly RecoveryAuthorityMode[] = [
    "OFFLINE_READ_ONLY", "HISTORICAL", "UNKNOWN",
  ];

  it("disables every control in each non-live authority mode", () => {
    expect(NON_LIVE).toHaveLength(3);
    for (const authorityMode of NON_LIVE) {
      cleanup();
      renderActions({ authorityMode });
      const ids = actionIds();
      expect(ids).toHaveLength(3);
      for (const testId of ids) {
        expect(button(testId).disabled, `${authorityMode} left ${testId} enabled`).toBe(true);
      }
      expect(screen.getByTestId("cr.recovery.actions").dataset["authorityMode"])
        .toBe(authorityMode);
    }
  });

  it("keeps a current live command enabled while the view is merely lagging", () => {
    renderActions({}, snapshot(COMMANDS, {
      connection: "LAGGING", statusLabel: "Catching up: applied #4801 of #4819",
    }));
    expect(screen.getByTestId("cr.shell.stalelabel").textContent).toBe("Showing stale data");
    expect(button("cr.action.recovery-complete").disabled).toBe(false);
  });

  it("does not treat the shell's stale flag alone as a refusal", () => {
    renderActions({}, snapshot(COMMANDS, { requiresAffordanceRefresh: true }));
    expect(screen.getByTestId("cr.shell.statusstrip").dataset["stale"]).toBe("true");
    expect(button("cr.action.recovery-complete").disabled).toBe(false);
  });
});

describe("command feedback renders the daemon's own outcome", () => {
  const pending: RecoveryFeedback = {
    commandId: "cmd-recovery-complete",
    message: "Recovery completion sent.",
    state: "PENDING",
  };

  it("announces a pending command with role status and no still-working copy yet", () => {
    renderActions({ feedback: [pending] });
    const shown = screen.getByTestId("cr.recovery.feedback.cmd-recovery-complete");
    expect(shown.getAttribute("role")).toBe("status");
    expect(shown.dataset["state"]).toBe("PENDING");
    expect(within(shown).getByTestId("cr.recovery.feedback.message").textContent)
      .toBe("Recovery completion sent.");
    expect(within(shown).queryByTestId("cr.recovery.feedback.stillworking")).toBeNull();
  });

  it("adds the verbatim still-working line once the wait passes two seconds", () => {
    renderActions({ feedback: [{ ...pending, overTwoSeconds: true }] });
    expect(screen.getByTestId("cr.recovery.feedback.stillworking").textContent)
      .toBe(STILL_WORKING);
  });

  it("announces a confirmed command with role status", () => {
    renderActions({ feedback: [{ ...pending, state: "CONFIRMED" }] });
    const shown = screen.getByTestId("cr.recovery.feedback.cmd-recovery-complete");
    expect(shown.getAttribute("role")).toBe("status");
    expect(shown.dataset["state"]).toBe("CONFIRMED");
  });

  it("announces a refusal with role alert, the stable code, and the refusing layer", () => {
    renderActions({
      feedback: [{
        ...pending,
        message: "The daemon refused recovery completion.",
        reason: {
          layer: "daemon.recovery",
          phrase: "Inventory coverage is incomplete.",
          reasonCode: "RECOVERY_INVENTORY_INCOMPLETE",
        },
        state: "REFUSED",
      }],
    });
    const shown = screen.getByTestId("cr.recovery.feedback.cmd-recovery-complete");
    expect(shown.getAttribute("role")).toBe("alert");
    expect(within(shown).getByTestId("cr.recovery.feedback.code").textContent)
      .toBe("RECOVERY_INVENTORY_INCOMPLETE");
    expect(within(shown).getByTestId("cr.recovery.feedback.layer").textContent)
      .toBe("daemon.recovery");
  });

  it("says UNKNOWN for a refusal whose code or layer the daemon did not supply", () => {
    renderActions({ feedback: [{ ...pending, message: "Refused.", state: "REFUSED" }] });
    const shown = screen.getByTestId("cr.recovery.feedback.cmd-recovery-complete");
    expect(within(shown).getByTestId("cr.recovery.feedback.code").textContent).toBe("UNKNOWN");
    expect(within(shown).getByTestId("cr.recovery.feedback.layer").textContent).toBe("UNKNOWN");
  });

  it("drops feedback for a command the daemon no longer supplies", () => {
    renderActions({
      feedback: [{ ...pending, commandId: "cmd-recovery-withdrawn" }],
      presentations: [COMPLETE],
    });
    expect(screen.queryByTestId("cr.recovery.feedback.cmd-recovery-withdrawn")).toBeNull();
    expect(screen.queryByTestId("cr.recovery.feedback.cmd-recovery-complete")).toBeNull();
  });
});
