import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  buildNextAllowedCommands,
} from "@moe/contracts";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CONTROL_ROOM_FIXTURES, CONTROL_ROOM_FIXTURE_KIND, MUTATION_BLOCK_ISOLATION,
  buildControlRoomFixtures, type FixtureConnectionState,
} from "./fixtures.js";
import {
  ControlRoomScaffold, Fact, TRUTH_ABSENT_PROVENANCE, TRUTH_INVALID_PROVENANCE, TruthChip,
  presentTruthClass,
} from "./kernel.js";
// ./main.js is imported dynamically only: it mounts on evaluation and refuses when
// the document has no mount point, so a static import would run at collection time.

const ALL_TRUTH_CLASSES = [
  "OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN",
] as const;
const SURFACE_IDS = ["goals", "board", "node", "approval", "evidence", "doctor"] as const;
const FILESYSTEM_IMPORT_TIMEOUT_MS = 20_000;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const readOwnSource = (fileName: string): string =>
  readFileSync(fileURLToPath(new URL(fileName, import.meta.url)), "utf8");

/**
 * The entry point mounts on evaluation and reads `location.search` while it does,
 * so each arm needs its own URL in place BEFORE the import and put back after.
 */
async function mountEntryPointAt(search: string): Promise<HTMLElement> {
  const original = globalThis.location.href;
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  globalThis.history.replaceState({}, "", search);
  try {
    vi.resetModules();
    await act(async () => void (await import("./main.js")));
  } finally {
    globalThis.history.replaceState({}, "", original);
  }
  return container;
}

describe("control-room scaffold mounts", () => {
  it("mounts through the production entry point, not just its exported helper", async () => {
    // The v1 shell is behind ?v1=1 now (v2 Cordum is the default entry); ?fixtures=1
    // selects v1's frozen fixture board under it.
    const container = await mountEntryPointAt("/?v1=1&fixtures=1");
    try {
      expect(within(container).getByTestId("cr.banner.fixture")).toBeTruthy();
      expect(within(container).getByTestId("cr.shell.root")).toBeTruthy();
      expect(within(container).getByTestId("cr.shell.context.title").textContent)
        .toBe("Ship the J1 vertical slice");
      expect(within(container).getByTestId("cr.workspace.goal")).toBeTruthy();
      const main = await import("./main.js");
      expect(main.CONTROL_ROOM_ROOT_ELEMENT_ID).toBe("root");
    } finally {
      container.remove();
    }
  }, FILESYSTEM_IMPORT_TIMEOUT_MS);

  it("mounts the v2 Cordum shell by default at the bare URL", async () => {
    // The swap: no flag now selects the v2 rebuild, which acquires its credential
    // at runtime through the handshake rather than a baked secret.
    const container = await mountEntryPointAt("/");
    try {
      expect(within(container).getByTestId("cr2.shell.root")).toBeTruthy();
      // The legacy v1 shell is no longer the default entry.
      expect(within(container).queryByTestId("cr.shell.root")).toBeNull();
    } finally {
      container.remove();
    }
  }, FILESYSTEM_IMPORT_TIMEOUT_MS);

  it("creates and claims one pairing request under the production StrictMode mount", async () => {
    const wire = [
      RUNTIME_COMMAND_ENVELOPE_VERSION,
      RUNTIME_QUERY_ENVELOPE_VERSION,
      RUNTIME_ERROR_REGISTRY_VERSION,
    ].join("+");
    const requestId = "d".repeat(64);
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === "/bootstrap") {
        return Promise.resolve(new Response(JSON.stringify({
          csrfToken: "csrf-strict",
          projectId: "project-strict",
          protocolVersion: wire,
        }), { headers: { "content-type": "application/json" }, status: 200 }));
      }
      if (input === "/session/pair/request") {
        return Promise.resolve(new Response(JSON.stringify({
          confirmationLabel: "dead-beef-1234",
          ok: true,
          requestId,
        }), { headers: { "content-type": "application/json" }, status: 200 }));
      }
      if (input === "/session/pair/claim") {
        expect(init?.body).toBe(JSON.stringify({ requestId }));
        return Promise.resolve(new Response(JSON.stringify({
          capabilities: ["project.admin"],
          expiresAt: "2026-08-26T00:00:00.000Z",
          ok: true,
          projectId: "project-strict",
          protocolVersion: wire,
          sessionCredential: "credential-strict",
        }), { headers: { "content-type": "application/json" }, status: 200 }));
      }
      if (input === "/affordances/read") {
        return Promise.resolve(new Response(JSON.stringify({
          nextAllowedCommands: [],
          outcome: "SURFACE",
          steps: [],
        }), { headers: { "content-type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch to ${input}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const replaceState = vi.spyOn(window.history, "replaceState");

    const container = await mountEntryPointAt("/#pair=STRICT-ONE-TIME-TOKEN");
    const main = await import("./main.js");
    let unmounted = false;
    try {
      expect(replaceState).toHaveBeenCalledWith(null, "", "/");
      expect(await within(container).findByText("dead-beef-1234")).toBeTruthy();
      expect(container.textContent).not.toContain(requestId);
      expect(container.textContent).not.toContain("STRICT-ONE-TIME-TOKEN");
      await userEvent.setup().click(within(container).getByRole("button", {
        name: "I entered this label",
      }));
      await waitFor(() => {
        expect(fetchMock.mock.calls.filter(([input]) => input === "/session/pair/request"))
          .toHaveLength(1);
        expect(fetchMock.mock.calls.filter(([input]) => input === "/session/pair/claim"))
          .toHaveLength(1);
        expect(within(container).queryByText("dead-beef-1234")).toBeNull();
      });
      await act(async () => { main.MOUNTED_CONTROL_ROOM_ROOT.unmount(); });
      unmounted = true;
    } finally {
      if (!unmounted) await act(async () => { main.MOUNTED_CONTROL_ROOM_ROOT.unmount(); });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      container.remove();
    }
  }, FILESYSTEM_IMPORT_TIMEOUT_MS);

  it("refuses closed at the real entry point when the build carries no credentials", async () => {
    // DoD 1's fail-closed clause for the v1 entry (now behind ?v1=1), asserted at
    // the composition root rather than the component: this build has no
    // VITE_MOE_LIVE_* values, so v1 must produce a NOTICE, not the frozen fixtures.
    const container = await mountEntryPointAt("/?v1=1");
    try {
      const notice = within(container).getByTestId("cr.config.notice");
      expect(notice.textContent).toContain("VITE_MOE_LIVE_CREDENTIAL");
      expect(notice.textContent).toContain("VITE_MOE_LIVE_CSRF");
      expect(within(container).queryByTestId("cr.shell.root")).toBeNull();
      expect(container.textContent).not.toContain(CONTROL_ROOM_FIXTURE_KIND);
    } finally {
      container.remove();
    }
  }, FILESYSTEM_IMPORT_TIMEOUT_MS);

  it("refuses with a stable code when the document supplies no mount point", async () => {
    expect(document.getElementById("root")).toBeNull();
    vi.resetModules();
    await expect(import("./main.js")).rejects.toThrow("CONTROL_ROOM_ROOT_MISSING");
  });

  it("exposes every fixture-backed surface through the workspace and rail", async () => {
    const user = userEvent.setup();
    render(<ControlRoomScaffold />);
    for (const surfaceId of ["goals", "board", "node", "evidence"] as const)
      expect(screen.getByTestId(`cr.surface.${surfaceId}`)).toBeTruthy();
    await user.click(screen.getByTestId("cr.nav.approvals"));
    expect(screen.getByTestId("cr.surface.approval")).toBeTruthy();
    await user.click(screen.getByTestId("cr.nav.health"));
    expect(screen.getByTestId("cr.surface.doctor")).toBeTruthy();
    expect(CONTROL_ROOM_FIXTURES.surfaces.map((surface) => surface.surfaceId))
      .toEqual([...SURFACE_IDS]);
  });
});

describe("production control-room composition", () => {
  it("mounts the operational ledger shell instead of the fixture placeholder", () => {
    render(<ControlRoomScaffold />);

    const root = screen.getByTestId("cr.shell.root");
    expect(root.getAttribute("data-theme")).toBe("ledger");
    expect(screen.getByTestId("cr.shell.brand").textContent).toContain("Moe");
    expect(screen.getByTestId("cr.shell.navrail")).toBeTruthy();
    expect(screen.getByTestId("cr.shell.contextbar")).toBeTruthy();
    expect(screen.getByTestId("cr.shell.context.title").textContent)
      .toBe("Ship the J1 vertical slice");
    expect(screen.getByTestId("cr.shell.main")).toBeTruthy();
    expect(screen.getByTestId("cr.shell.inspector")).toBeTruthy();
    expect(screen.getByTestId("cr.shell.statusstrip")).toBeTruthy();
    expect(screen.getByTestId("cr.shell.statusstrip").getAttribute("data-connection"))
      .toBe("DISCONNECTED");
    expect(screen.getByTestId("cr.banner.disconnected")).toBeTruthy();
    expect(screen.getByTestId("cr.shell.eventspine")).toBeTruthy();
  });

  it("opens on the board-first goal workspace and reaches every rail destination", async () => {
    const user = userEvent.setup();
    render(<ControlRoomScaffold />);

    expect(screen.getByTestId("cr.nav.goals").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("cr.surface.board")).toBeTruthy();

    const destinations = [
      ["approvals", "cr.surface.approval"],
      ["runs", "cr.surface.runs"],
      ["resources", "cr.surface.resources"],
      ["health", "cr.surface.doctor"],
      ["policy", "cr.surface.policy"],
    ] as const;
    for (const [nav, surface] of destinations) {
      await user.click(screen.getByTestId(`cr.nav.${nav}`));
      expect(screen.getByTestId(surface)).toBeTruthy();
      expect(screen.getByTestId(`cr.nav.${nav}`).getAttribute("aria-current")).toBe("page");
    }

    expect(screen.getByTestId("cr.preview.inspector.empty").textContent)
      .toContain("No claim focused");
    expect(screen.queryByTestId("cr.surface.node")).toBeNull();

    await user.click(screen.getByTestId("cr.nav.goals"));
    expect(screen.getByTestId("cr.surface.board")).toBeTruthy();
  });

  it("keeps goal creation behind an explicit progressive-disclosure control", () => {
    render(<ControlRoomScaffold />);
    const composer = screen.getByTestId("cr.workspace.goalcomposer");
    expect(composer.tagName).toBe("DETAILS");
    expect((composer as HTMLDetailsElement).open).toBe(false);
    expect(within(composer).getByText("Describe work without docs")).toBeTruthy();
    expect(within(composer).getByText(/attach the daemon/iu)).toBeTruthy();
    expect(within(composer).queryByTestId("cr.goals.create")).toBeNull();
  });

  it("treats project documents as the default source of proposed work", () => {
    render(<ControlRoomScaffold />);
    const dossier = screen.getByTestId("cr.preview.dossier");
    expect(dossier.getAttribute("data-authority")).toBe("none");
    expect(within(dossier).getByText("Document work proposal")).toBeTruthy();
    expect(within(dossier).getByText("3 document-derived candidates · not submitted"))
      .toBeTruthy();
    expect(within(dossier).getByText(
      "No daemon attached; no task records were created.",
    )).toBeTruthy();

    const sourceLinks = within(dossier).getAllByTestId(/^cr\.preview\.decomposition\.source\./u);
    expect(sourceLinks.map((link) => link.querySelector("code")?.textContent)).toEqual([
      "incident-note", "startup-contract", "incident-note",
      "recovery-acceptance", "recovery-acceptance", "startup-contract",
    ]);
    for (const link of sourceLinks) {
      const href = link.getAttribute("href") ?? "";
      expect(href).toMatch(/^#cr-dossier-[a-zA-Z0-9_-]+-source-[0-9]+$/u);
      expect(link.getAttribute("aria-controls")).toBe(href.slice(1));
      expect(document.querySelector(href)).not.toBeNull();
    }
    for (const source of within(dossier)
      .getAllByTestId(/^cr\.preview\.dossier\.source\./u)) {
      const disclosure = source.querySelector("details") as HTMLDetailsElement | null;
      expect(disclosure).not.toBeNull();
      expect(disclosure?.open).toBe(false);
    }

    const candidates = within(dossier)
      .getAllByTestId(/^cr\.preview\.decomposition\.task\./u);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((card) => within(card).getByRole("heading").textContent)).toEqual([
      "Write the recovery contract",
      "Prove stale-record recovery",
      "Guard startup ownership",
    ]);
    for (const card of candidates) {
      expect(card.textContent).toContain("Candidate · not submitted");
      expect(card.textContent).not.toContain("Unassigned");
      expect(card.textContent).not.toContain("Not started");
      expect(within(card).getByTestId("cr.chip.agent_reported")).toBeTruthy();
    }
    expect(within(dossier).getByTestId("cr.preview.decomposition.quality")
      .querySelector("[data-testid='cr.chip.agent_reported']")).not.toBeNull();
    expect(dossier.querySelectorAll("[data-testid^='cr.action.']")).toHaveLength(0);
  });

  it("opens contextual evidence for document-derived truth chips", async () => {
    const user = userEvent.setup();
    render(<ControlRoomScaffold />);
    const dossier = screen.getByTestId("cr.preview.dossier");
    const candidate = within(dossier)
      .getByTestId("cr.preview.decomposition.task.0");
    const chip = within(candidate).getByRole("button", {
      name: /provenance for write the recovery contract/iu,
    });

    await user.click(chip);

    const provenance = within(dossier).getByTestId("cr.preview.dossier.provenance");
    expect(provenance.textContent).toContain("Write the recovery contract");
    expect(provenance.textContent).toContain("Asserted by an agent; not independently verified.");
    expect(provenance.textContent).toContain("incident-note · docs/incidents/stale-port.md");
    expect(provenance.textContent).toContain("startup-contract · docs/contracts/startup-ownership.md");
    expect(provenance.textContent)
      .toContain("Fixture proposal · NOT_SUBMITTED · advisory only · authority NONE.");
  });

  it("keeps decomposition first in visual, DOM, and focus order and opens linked sources", async () => {
    const user = userEvent.setup();
    render(<ControlRoomScaffold />);
    const dossier = screen.getByTestId("cr.preview.dossier");
    const decomposition = within(dossier).getByTestId("cr.preview.decomposition");
    const source = within(dossier).getByTestId("cr.preview.dossier.source.0");
    expect(decomposition.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await user.click(within(decomposition)
      .getByTestId("cr.preview.decomposition.source.0.0"));

    expect((source.querySelector("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("keeps document candidates outside the daemon-confirmed board", () => {
    render(<ControlRoomScaffold />);
    const dossier = screen.getByTestId("cr.preview.dossier");
    const board = screen.getByTestId("cr.surface.board");
    expect(dossier.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(board).getAllByTestId(/^cr\.board\.card\./u)
      .filter((node) => node.tagName === "ARTICLE").map((node) => node.getAttribute("data-testid")))
      .toEqual(["cr.board.card.node-j1"]);
    expect(board.querySelector("[data-testid^='cr.preview.decomposition.task.']")).toBeNull();
  });

  it("keeps preview affordances visible but disabled without live authority", async () => {
    const user = userEvent.setup();
    render(<ControlRoomScaffold />);
    await user.click(screen.getByTestId("cr.nav.approvals"));
    const action = screen.getByTestId("cr.action.approval-decide.approve") as HTMLButtonElement;
    expect(action.disabled).toBe(true);
  });

  it("exposes projections as a pressed-button group without claiming full tab semantics", () => {
    render(<ControlRoomScaffold />);
    expect(screen.getByRole("group", { name: "Goal projection" })).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toEqual([]);
    expect(screen.getByTestId("cr.shell.tab.board").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("truth facts are triple encoded", () => {
  it.each(ALL_TRUTH_CLASSES)("encodes %s as text, icon, and colour", (truthClass) => {
    render(<TruthChip truthClass={truthClass} />);
    const chip = screen.getByTestId(`cr.chip.${truthClass.toLowerCase()}`);
    const presentation = presentTruthClass(truthClass);
    expect(presentation.origin).toBe("PRESENT");
    expect(chip.getAttribute("data-truth-class")).toBe(truthClass);
    expect(within(chip).getByTestId("cr.shortlabel").textContent)
      .toBe(presentation.descriptor.shortLabel);
    expect(within(chip).getByTestId("cr.glyph").textContent).toBe(presentation.descriptor.glyph);
    expect(chip.getAttribute("data-tone")).toBe(presentation.descriptor.semanticTone);
    expect(chip.getAttribute("aria-label")).toContain(presentation.descriptor.meaning);
  });

  it("survives forced monochrome: glyph and label alone separate all five", () => {
    const shown = ALL_TRUTH_CLASSES.map((c) => presentTruthClass(c).descriptor);
    expect(new Set(shown.map((d) => d.glyph)).size).toBe(ALL_TRUTH_CLASSES.length);
    expect(new Set(shown.map((d) => d.shortLabel)).size).toBe(ALL_TRUTH_CLASSES.length);
    // UNKNOWN is the one dashed border, the last channel left in monochrome.
    expect(shown.map((d) => d.borderStyle))
      .toEqual(["solid", "solid", "solid", "solid", "dashed"]);
  });

  it("gives every chip a keyboard-reachable 24px provenance affordance", async () => {
    const seen: string[] = [];
    const user = userEvent.setup();
    render(<TruthChip truthClass="OBSERVED" onProvenance={(p) => seen.push(p.origin)} />);
    const chip = screen.getByTestId("cr.chip.observed");
    expect([chip.tagName, chip.style.minWidth, chip.style.minHeight])
      .toEqual(["BUTTON", "24px", "24px"]);
    expect(chip.getAttribute("aria-label")).toContain("press Enter for provenance.");
    // The aria-label promises Enter, so press Enter — a synthetic click would pass
    // even if the chip were reachable by pointer only.
    await user.tab();
    expect(document.activeElement).toBe(chip);
    await user.keyboard("{Enter}");
    expect(seen).toEqual(["PRESENT"]);
  });
});

describe("absent and malformed truth classes stay honest", () => {
  it("maps an absent class to UNKNOWN with the missing-class provenance note", () => {
    for (const absent of [undefined, null]) {
      const { descriptor, origin, provenanceNote } = presentTruthClass(absent);
      expect([origin, descriptor.truthClass, provenanceNote])
        .toEqual(["ABSENT", "UNKNOWN", TRUTH_ABSENT_PROVENANCE]);
    }
    render(<TruthChip />);
    const chip = screen.getByTestId("cr.chip.unknown");
    expect(chip.getAttribute("data-origin")).toBe("ABSENT");
    expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_ABSENT_PROVENANCE);
    expect(chip.getAttribute("aria-label")).toContain(TRUTH_ABSENT_PROVENANCE);
  });

  it("reserves TRUTH_CLASS_INVALID for a present but unsupported class", () => {
    const hostile: readonly unknown[] = [
      { truthClass: "DAEMON_VERIFIED" }, "daemon_verified", "DAEMON_VERIFIED ", "", 0, false,
      ["HUMAN_APPROVED"],
    ];
    for (const value of hostile) {
      const { descriptor, origin, provenanceNote } = presentTruthClass(value);
      expect([origin, descriptor.truthClass, provenanceNote])
        .toEqual(["INVALID", "UNKNOWN", TRUTH_INVALID_PROVENANCE]);
    }
    expect(TRUTH_INVALID_PROVENANCE).toContain("TRUTH_CLASS_INVALID");
    expect(TRUTH_ABSENT_PROVENANCE).not.toBe(TRUTH_INVALID_PROVENANCE);
  });

  it("never defaults an unreadable class upward", () => {
    for (const value of [undefined, {}, "OBSERVED_"]) {
      expect(presentTruthClass(value).descriptor.semanticTone).toBe("high-contrast magenta");
    }
  });
});

describe("every fact wrapper carries a chip descendant", () => {
  it("nests a chip inside the wrapper it renders", () => {
    const { container } = render(
      <Fact factId="goal.title" label="Goal" value="Ship J1" truthClass="OBSERVED" />,
    );
    const wrapper = screen.getByTestId("cr.fact.goal.title");
    expect(within(wrapper).getByTestId("cr.chip.observed")).toBeTruthy();
    // The prefix must name wrappers only, or the audit below counts label and
    // value spans as facts and passes without ever inspecting a real claim.
    expect(container.querySelectorAll("[data-testid^='cr.fact.']").length).toBe(1);
  });

  it("holds the invariant across every routed fixture surface", async () => {
    const user = userEvent.setup();
    render(<ControlRoomScaffold />);
    const assertSurfaceFacts = (surfaceId: string, expectedFactIds: readonly string[]): void => {
      const surface = screen.getByTestId(surfaceId);
      const wrappers = surface.querySelectorAll("[data-testid^='cr.fact.']");
      expect(wrappers.length).toBeGreaterThanOrEqual(expectedFactIds.length);
      for (const factId of expectedFactIds)
        expect(within(surface).getByTestId(`cr.fact.${factId}`)).toBeTruthy();
      for (const wrapper of wrappers)
        expect(wrapper.querySelectorAll("[data-testid^='cr.chip.']").length).toBe(1);
      for (const chip of surface.querySelectorAll("[data-testid^='cr.chip.']"))
        expect(chip.getAttribute("data-truth-class")).not.toBeNull();
    };

    assertSurfaceFacts("cr.workspace.goal", [
      "goal.title", "goal.progress", "board.frontier", "board.readiness",
    ]);
    const destinations = [
      ["approvals", "cr.surface.approval", ["approval.request", "approval.validity"]],
      ["runs", "cr.surface.runs", ["run.node.state", "run.node.attempt"]],
      ["health", "cr.surface.doctor", ["doctor.store", "doctor.relay"]],
    ] as const;
    for (const [destination, surfaceId, factIds] of destinations) {
      await user.click(screen.getByTestId(`cr.nav.${destination}`));
      assertSurfaceFacts(surfaceId, factIds);
    }
  });
});

describe("fixtures are deterministic and carry no authority", () => {
  it("builds byte-identical fixtures twice", () => {
    expect(JSON.stringify(buildControlRoomFixtures()))
      .toBe(JSON.stringify(buildControlRoomFixtures()));
    expect(buildControlRoomFixtures()).toEqual(CONTROL_ROOM_FIXTURES);
    expect(Object.isFrozen(CONTROL_ROOM_FIXTURES)).toBe(true);
    expect(CONTROL_ROOM_FIXTURE_KIND).toBe("DEVELOPMENT_ONLY/NOT_CONFIRMATORY");
  });

  it("derives mutation enablement from daemon-supplied affordances only", () => {
    const byState = new Map(CONTROL_ROOM_FIXTURES.affordances.map((s) => [s.connection, s]));
    expect([...byState.keys()]).toEqual(["CONNECTED", "LAGGING", "DISCONNECTED", "HISTORICAL"]);
    // Fixed expectations, never re-derived from production's own formula: a changed
    // formula must fail here rather than be tracked by the assertion.
    const expected: Record<FixtureConnectionState, boolean> = {
      CONNECTED: true, DISCONNECTED: false, HISTORICAL: false, LAGGING: true,
    };
    for (const snap of CONTROL_ROOM_FIXTURES.affordances) {
      expect(snap.mutationsEnabled).toBe(expected[snap.connection]);
    }
    expect(byState.get("LAGGING")?.statusLabel).not.toBe("");
    expect(byState.get("DISCONNECTED")?.nextAllowedCommands).toEqual([]);
    expect(byState.get("HISTORICAL")?.requiresAffordanceRefresh).toBe(true);
  });

  it("blocks mutation on each gate leg independently of the others", () => {
    // Each fixture leaves every OTHER condition permitting, so exactly one leg can
    // be holding the gate closed. Delete any single leg and one of these goes true.
    const [dropped, refreshRequired, noAffordances] = MUTATION_BLOCK_ISOLATION;
    expect(MUTATION_BLOCK_ISOLATION.length).toBe(3);
    expect(Object.isFrozen(MUTATION_BLOCK_ISOLATION)).toBe(true);
    for (const snap of MUTATION_BLOCK_ISOLATION) {
      expect(Object.isFrozen(snap)).toBe(true);
      expect(snap.mutationsEnabled).toBe(false);
    }
    expect(dropped?.connection).toBe("DISCONNECTED");
    expect(dropped?.requiresAffordanceRefresh).toBe(false);
    expect(dropped?.nextAllowedCommands.length).toBeGreaterThan(0);
    expect(refreshRequired?.connection).toBe("CONNECTED");
    expect(refreshRequired?.requiresAffordanceRefresh).toBe(true);
    expect(refreshRequired?.nextAllowedCommands.length).toBeGreaterThan(0);
    expect(noAffordances?.connection).toBe("CONNECTED");
    expect(noAffordances?.requiresAffordanceRefresh).toBe(false);
    expect(noAffordances?.nextAllowedCommands).toEqual([]);
  });

  it("rejects any affordance the daemon parser would not have produced", () => {
    const connected = CONTROL_ROOM_FIXTURES.affordances.find((s) => s.connection === "CONNECTED");
    const source = { aggregate: "NODE_RUN", state: "WORK_REVIEW" };
    const parsed = buildNextAllowedCommands(source, connected?.nextAllowedCommands);
    // A malformed or duplicated entry collapses the parser's whole result to the
    // frozen empty set, so a length floor keeps empty-equals-empty from passing.
    expect(parsed.length).toBe(3);
    expect(parsed).toEqual(connected?.nextAllowedCommands);
  });

  it("keeps a full provenance record on every fact", () => {
    for (const surface of CONTROL_ROOM_FIXTURES.surfaces) {
      for (const { provenance } of surface.facts) {
        expect(provenance.eventId).not.toBe("");
        expect(provenance.eventSequence).toBeGreaterThan(0);
        expect(provenance.actor).not.toBe("");
        expect(provenance.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T[0-2]\d:[0-5]\d:[0-5]\d\.\d{3}Z$/u);
        expect(Number.isFinite(Date.parse(provenance.timestamp))).toBe(true);
        expect(["receipt", "decision", "report", "finding"]).toContain(provenance.linkKind);
      }
    }
  });
});

describe("shell source tripwires", () => {
  const modules = ["./fixtures.ts", "./kernel.tsx", "./main.tsx"] as const;
  const schedulerPackage = `sched${"uler"}`;
  const schedulerInternal =
    new RegExp(`(?:@moe/${schedulerPackage}/|${schedulerPackage}[\\\\/]src[\\\\/])`, "u");
  const heldOutImport = /(?:from|import|require)\s*\(?\s*["'][^"']*foundation[\\/][^"']*["']/u;
  const nondeterminism = /Date\.now|Math\.random|new Date\(\)/u;

  it.each(modules)("keeps %s clear of forbidden literals", (fileName) => {
    const source = readOwnSource(fileName);
    expect(source).not.toBe("");
    expect(schedulerInternal.test(source)).toBe(false);
    expect(heldOutImport.test(source)).toBe(false);
    expect(nondeterminism.test(source)).toBe(false);
  });

  it("loads the whole shell module graph without any Node-only API", async () => {
    // A bundler stubs node:util out for the browser, so anything this app touches at
    // module load must survive `types` being absent. Masking the module catches that;
    // a build cannot, because a bundle that throws on load still exits `vite build` 0.
    vi.doMock("node:util", () => ({ default: {}, types: undefined }));
    vi.resetModules();
    try {
      const fixtures = await import("./fixtures.js");
      const kernel = await import("./kernel.js");
      expect(fixtures.CONTROL_ROOM_FIXTURES.surfaces.length).toBe(SURFACE_IDS.length);
      expect(kernel.presentTruthClass("OBSERVED").origin).toBe("PRESENT");
    } finally {
      vi.doUnmock("node:util");
      vi.resetModules();
    }
  });

  it("proves the tripwire patterns actually bite", () => {
    expect(schedulerInternal.test(`import x from "@moe/${schedulerPackage}/internal";`)).toBe(true);
    expect(schedulerInternal.test(`see packages/${schedulerPackage}/src/thing.ts`)).toBe(true);
    expect(heldOutImport.test('import { J1 } from "@moe/testkit/foundation/model.js";')).toBe(true);
    expect(nondeterminism.test("const t = Date.now();")).toBe(true);
  });
});
