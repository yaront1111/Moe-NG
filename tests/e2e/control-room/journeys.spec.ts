import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { withStaticControlRoom } from "./harness.js";
import { coveredScenarios } from "./journey-coverage.js";
import { createStaticControlRoomPorts } from "./static-ports.js";

/**
 * The COVERED half of the control-room journey gate: a real Chromium drives the
 * real built bundle, served by the existing harness.
 *
 * SCOPE IS THE LEDGER'S, NOT THIS FILE'S. `journey-coverage.ts` records all twenty
 * spec section-12 scenarios; three are COVERED and seventeen are typed UNKNOWN with
 * a named missing input and owner. The last test in this file binds the two
 * artifacts together, so a scenario cannot be marked COVERED without a journey here
 * driving it, and a journey here cannot quietly cover something the ledger omits.
 *
 * WHAT THIS LANE IS. The served application renders COMMITTED FIXTURES; no daemon is
 * attached. Every assertion below is written to be true of THAT, and nothing here is
 * named or reported as a connected system. The bundle boots DISCONNECTED by design
 * (`preview-data.ts` selects the disconnected snapshot), which is why the
 * banner/enabled-action invariant is checkable at all.
 *
 * THE FIXTURE ARM IS NOW REQUESTED EXPLICITLY. The board's default view is the live
 * daemon; this lane's bundle is built with no `VITE_MOE_LIVE_*` values, so its bare
 * URL is the configuration notice, not fixtures. Every journey below therefore opens
 * `?fixtures=1`. That is not a workaround — it is this lane naming what it drives,
 * which the old bare URL could no longer do. The two arms a daemonless bundle CAN
 * honestly assert about the gate itself are pinned in their own test at the bottom.
 *
 * Bundle serving, port selection and readiness belong to `harness.ts` /
 * `static-ports.ts` and are composed, never reimplemented here.
 */

/**
 * HAND-TRANSCRIBED from apps/control-room/src/shell-mode.ts (`FIXTURES_QUERY_PARAM`),
 * for the same reason `SUPPLIED_COMMANDS` below is: the e2e tsconfig cannot reach into
 * apps/control-room (TS6059), and deriving the URL from the module that reads it would
 * make the assertion self-referential.
 */
const FIXTURES_QUERY = "?fixtures=1";

/** Every workspace the nav rail offers, by its committed test id. */
const WORKSPACES = ["goals", "approvals", "runs", "resources", "health", "policy"] as const;

/**
 * HAND-TRANSCRIBED from apps/control-room/src/fixtures.ts:146-148 (`J1_COMMAND_SEEDS`).
 *
 * Transcribed rather than imported for two reasons. The e2e tsconfig is
 * `include: ["./*.ts"]` and reaching into apps/control-room is TS6059 here; and more
 * importantly, deriving the expected command set from the same module the page
 * renders from would make the assertion self-referential — it would pass no matter
 * what the page put on screen. An independent list is the whole point.
 */
const SUPPLIED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["cmd-j1-approve-plan", "approval.decide"],
  ["cmd-j1-close-goal", "goal.close"],
  ["cmd-j1-accept-output", "integration.accept_output"],
]);

/** Scenario ids this file actually drives. Compared against the ledger below. */
const EXERCISED_SCENARIOS = ["CR-J1-002", "CR-A11Y-001", "CR-CMD-001"] as const;

interface ActionRecord {
  readonly commandId: string | null;
  readonly disabled: boolean;
  readonly testId: string;
}

interface ChipRecord {
  readonly border: string | null;
  readonly glyph: string;
  readonly shortLabel: string;
  readonly truthClass: string;
}

/**
 * Runs `body` against a freshly built and served bundle, and pins the harness
 * outcome too: a run that never reached the body, or that refused with a reason
 * code, must not read as a pass. A failed assertion inside `body` re-throws past the
 * harness by design, so it surfaces as itself rather than as a harness code.
 */
async function journey(body: (page: Page) => Promise<void>, page: Page): Promise<void> {
  const outcome = await withStaticControlRoom(createStaticControlRoomPorts(), async (baseUrl) => {
    await page.goto(`${baseUrl}${FIXTURES_QUERY}`);
    await expect(page.getByTestId("cr.shell.root")).toHaveCount(1);
    await body(page);
    return "journey-complete";
  });
  expect(outcome).toEqual({ ok: true, value: "journey-complete" });
}

/** Switches workspace and waits for the shell to settle on the new one. */
async function openWorkspace(page: Page, workspace: string): Promise<void> {
  await page.getByTestId(`cr.nav.${workspace}`).click();
  await expect(page.getByTestId("cr.shell.main")).toHaveCount(1);
}

const readActions = async (page: Page): Promise<readonly ActionRecord[]> =>
  await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid^='cr.action.']")].map((element) => ({
      commandId: element.getAttribute("data-command-id"),
      disabled: element instanceof HTMLButtonElement && element.disabled,
      testId: element.getAttribute("data-testid") ?? "",
    })));

const readChips = async (page: Page): Promise<readonly ChipRecord[]> =>
  await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid^='cr.chip.'][data-truth-class]")].map((element) => ({
      border: element.getAttribute("data-border"),
      glyph: element.querySelector("[data-testid='cr.glyph']")?.textContent ?? "",
      shortLabel: element.querySelector("[data-testid='cr.shortlabel']")?.textContent ?? "",
      truthClass: element.getAttribute("data-truth-class") ?? "",
    })));

/**
 * CR-J1-002. The spec's bar is exactly "`cr.graph.canvas` never mounted".
 *
 * The graph TAB is asserted present FIRST. Without that, this test would also pass
 * against a shell that failed to render anything at all, which is the difference
 * between proving the bar and proving nothing.
 */
test("CR-J1-002: the graph canvas is never mounted on any workspace", async ({ page }) => {
  await journey(async (driven) => {
    await expect(driven.getByTestId("cr.shell.tab.graph")).toHaveCount(1);
    for (const workspace of WORKSPACES) {
      await openWorkspace(driven, workspace);
      await expect(driven.getByTestId("cr.graph.canvas")).toHaveCount(0);
      await expect(driven.locator("[data-testid^='cr.graph.']")).toHaveCount(0);
    }
    // Selecting the graph tab must not mount one either. Back to Goals first: the
    // shell renders its tab strip only while the projection is enabled, which
    // `ControlRoomPreview` ties to the Goals workspace, so the tab is genuinely
    // absent elsewhere rather than merely slow to appear.
    await openWorkspace(driven, "goals");
    await driven.getByTestId("cr.shell.tab.graph").click();
    await expect(driven.getByTestId("cr.graph.canvas")).toHaveCount(0);
    await expect(driven.locator("[data-testid^='cr.graph.']")).toHaveCount(0);
  }, page);
});

/**
 * CR-A11Y-001. Five classes distinguishable by glyph + label + border ALONE.
 *
 * Asserting five classes are present is the weak half; the load-bearing half is that
 * their (glyph, shortLabel, border) triples are pairwise DISTINCT once colour is
 * discarded. Two classes sharing a triple would render identically in monochrome and
 * a presence-only check would never notice.
 */
test("CR-A11Y-001: five truth classes stay distinct without colour", async ({ page }) => {
  await journey(async (driven) => {
    await openWorkspace(driven, "goals");
    const chips = await readChips(driven);
    expect(chips.length).toBeGreaterThan(0);

    const byClass = new Map(chips.map((chip) => [chip.truthClass, chip]));
    expect([...byClass.keys()].sort()).toEqual([
      "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "OBSERVED", "UNKNOWN",
    ]);

    const signature = (chip: ChipRecord): string =>
      `${chip.glyph}|${chip.shortLabel}|${chip.border ?? ""}`;
    expect(new Set([...byClass.values()].map(signature)).size).toBe(byClass.size);
    // `byClass` keeps one chip per class, so the distinctness check above would not
    // notice two chips of the SAME class rendering differently. Check every chip
    // against its class signature, not just the representative.
    for (const chip of chips) {
      expect(signature(chip), `${chip.truthClass} renders inconsistently`)
        .toBe(signature(byClass.get(chip.truthClass) as ChipRecord));
    }
    for (const chip of byClass.values()) {
      expect(chip.glyph).not.toBe("");
      expect(chip.shortLabel).not.toBe("");
    }
    // The one class the spec singles out: UNKNOWN is dashed, everything else is not.
    expect(byClass.get("UNKNOWN")?.border).toBe("dashed");
  }, page);
});

/**
 * CR-CMD-001 and DoD 3: no action exists without an allowed command.
 *
 * Swept across EVERY workspace, and the non-zero precondition is asserted before the
 * membership check — a sweep that enumerated nothing would otherwise pass trivially
 * while proving the opposite of what it claims.
 */
test("CR-CMD-001: every rendered action is one the supplied command set allows", async ({ page }) => {
  await journey(async (driven) => {
    const seen: ActionRecord[] = [];
    for (const workspace of WORKSPACES) {
      await openWorkspace(driven, workspace);
      const actions = await readActions(driven);
      // 1:1 WITHIN a workspace: two buttons carrying one command id would mean a
      // single authorisation was rendered as two affordances. Across workspaces a
      // repeat is legitimate, so the uniqueness check belongs here, not on the total.
      const ids = actions.map((action) => action.commandId);
      expect(new Set(ids).size).toBe(actions.length);
      seen.push(...actions);
    }
    expect(seen.length).toBeGreaterThan(0);

    for (const action of seen) {
      expect(action.commandId).not.toBeNull();
      // The strong direction: rendered is a SUBSET of supplied. Equality would be
      // wrong — the fixture supplies three commands and only two surfaces render.
      expect(SUPPLIED_COMMANDS.has(action.commandId ?? "")).toBe(true);
      expect(action.testId.startsWith("cr.action.")).toBe(true);
    }
  }, page);
});

/**
 * Spec section 12 global bar 3, the testable form of "every displayed fact has a
 * truth class". Counted per workspace so a workspace that renders facts without
 * chips cannot be averaged away by one that renders neither.
 */
test("every displayed fact carries a truth chip, on every workspace", async ({ page }) => {
  await journey(async (driven) => {
    let total = 0;
    for (const workspace of WORKSPACES) {
      await openWorkspace(driven, workspace);
      const counted = await driven.evaluate(() => {
        const facts = [...document.querySelectorAll("[data-testid^='cr.fact.']")];
        return {
          facts: facts.length,
          withChip: facts.filter((fact) =>
            fact.querySelector("[data-testid^='cr.chip.']") !== null).length,
        };
      });
      expect(counted.withChip).toBe(counted.facts);
      total += counted.facts;
    }
    // The sweep must have seen real facts somewhere, or it proved nothing at all.
    expect(total).toBeGreaterThan(0);
  }, page);
});

/**
 * DoD 3 and CR-J3-001's bar. The disconnected banner must never coexist with an
 * ENABLED action — spec section 6.3 requires actions to disable, not hide.
 *
 * Non-vacuous because actions DO render here: the assertion is "actions present, none
 * enabled", not "no actions found". CR-J3-001 itself stays UNKNOWN in the ledger —
 * this proves the invariant, not the crash/reconnect journey.
 */
test("the disconnected banner never coexists with an enabled action", async ({ page }) => {
  await journey(async (driven) => {
    let rendered = 0;
    for (const workspace of WORKSPACES) {
      await openWorkspace(driven, workspace);
      await expect(driven.getByTestId("cr.banner.disconnected")).toHaveCount(1);
      const actions = await readActions(driven);
      rendered += actions.length;
      expect(actions.filter((action) => !action.disabled)).toEqual([]);
    }
    expect(rendered).toBeGreaterThan(0);
  }, page);
});

/**
 * DoD 2 keyboard and provenance, asserted as OBSERVABLE OUTCOMES rather than as the
 * presence of a handler: the panel opens with populated rows, and dismissing it
 * returns focus to the chip that opened it rather than to the top of the document.
 * A test that only checked the panel appeared would pass against a keyboard trap.
 */
test("a focused truth chip drills to provenance by keyboard and gets focus back", async ({ page }) => {
  await journey(async (driven) => {
    await openWorkspace(driven, "goals");
    const chip = driven.locator("[data-testid^='cr.chip.'][data-truth-class]").first();
    await chip.focus();

    const focusedBefore = await driven.evaluate(() =>
      document.activeElement?.getAttribute("data-testid") ?? null);
    expect(focusedBefore).not.toBeNull();
    expect(focusedBefore?.startsWith("cr.chip.")).toBe(true);

    await driven.keyboard.press("p");
    const panel = driven.getByTestId("cr.chip.provenance");
    await expect(panel).toHaveCount(1);
    // The drill-down must carry the claim's provenance, not an empty shell.
    await expect(driven.getByTestId("cr.provenance.row.actor")).toHaveCount(1);
    await expect(driven.getByTestId("cr.provenance.row.event")).toHaveCount(1);
    expect((await panel.innerText()).trim()).not.toBe("");

    await driven.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    const focusedAfter = await driven.evaluate(() =>
      document.activeElement?.getAttribute("data-testid") ?? null);
    expect(focusedAfter).toBe(focusedBefore);
  }, page);
});

/**
 * DoD 2 narrow window. The bar is action PARITY, not mere presence: the narrow
 * layout must not drop an affordance the wide one offered. 900px is inside the
 * spec's `@media (max-width: 959px)` breakpoint.
 */
test("the narrow layout keeps action parity with the wide one", async ({ page }) => {
  await journey(async (driven) => {
    await driven.setViewportSize({ height: 900, width: 1280 });
    await openWorkspace(driven, "approvals");
    const wide = (await readActions(driven)).map((action) => action.testId).sort();
    expect(wide.length).toBeGreaterThan(0);

    await driven.setViewportSize({ height: 900, width: 900 });
    await openWorkspace(driven, "approvals");
    const narrow = (await readActions(driven)).map((action) => action.testId).sort();
    expect(narrow).toEqual(wide);
  }, page);
});

/**
 * DoD 2 degraded honesty. An absent fact must render AS UNKNOWN — dashed chip, named
 * short label, and a value cell that actually says something. A blank cell reads as a
 * confident empty answer, which is the failure this asserts against.
 */
test("an UNKNOWN fact renders as UNKNOWN and never as a blank or confident cell", async ({ page }) => {
  await journey(async (driven) => {
    await openWorkspace(driven, "goals");
    const unknown = await driven.evaluate(() => {
      const chip = document.querySelector("[data-truth-class='UNKNOWN']");
      const wrapper = chip?.closest("[data-testid^='cr.fact.']") ?? null;
      return {
        border: chip?.getAttribute("data-border") ?? null,
        // `foundWrapper` is load-bearing. Without it a missing wrapper yields null
        // text, `null?.trim()` is undefined, and `not.toBe("")` PASSES — the exact
        // vacuous shape this test exists to catch, hiding in the test itself.
        foundWrapper: wrapper !== null,
        label: wrapper?.querySelector("[data-testid='cr.label']")?.textContent ?? null,
        shortLabel: chip?.querySelector("[data-testid='cr.shortlabel']")?.textContent ?? null,
        value: wrapper?.querySelector("[data-testid='cr.value']")?.textContent ?? null,
      };
    });
    expect(unknown.foundWrapper).toBe(true);
    expect(unknown.border).toBe("dashed");
    expect(unknown.shortLabel).toBe("UNK");
    // Asserted as strings first, so a null can never reach a `.trim()` that would
    // make the emptiness check vacuous.
    expect(typeof unknown.label).toBe("string");
    expect(typeof unknown.value).toBe("string");
    expect(unknown.label?.trim()).not.toBe("");
    expect(unknown.value?.trim()).not.toBe("");
  }, page);
});

/**
 * THE GATE ITSELF, in a real browser, over the real bundle.
 *
 * A daemonless bundle can honestly assert exactly two of the three arms: the bare URL
 * is the configuration notice (this build carries no `VITE_MOE_LIVE_*` values), and
 * `?fixtures=1` is the labelled fixture board. The LIVE arm needs a daemon and belongs
 * to the daemon-backed journey task; nothing here fakes one.
 *
 * The notice arm's real claim is the NEGATIVE one: an unconfigured build must not
 * quietly serve frozen fixtures where live data belongs. So it asserts the shell root
 * and the fixture marker are ABSENT, not merely that a notice appeared.
 */
test("the bare URL is a configuration notice, and fixtures are behind an explicit flag", async ({ page }) => {
  const outcome = await withStaticControlRoom(createStaticControlRoomPorts(), async (baseUrl) => {
    await page.goto(baseUrl);
    const notice = page.getByTestId("cr.config.notice");
    await expect(notice).toHaveCount(1);
    // Both variable names, so the notice tells an operator what to actually set.
    await expect(notice).toContainText("VITE_MOE_LIVE_CREDENTIAL");
    await expect(notice).toContainText("VITE_MOE_LIVE_CSRF");
    // Fail closed: no fixture board underneath, and no fixture data anywhere.
    await expect(page.getByTestId("cr.shell.root")).toHaveCount(0);
    await expect(page.getByTestId("cr.banner.fixture")).toHaveCount(0);
    expect(await page.content()).not.toContain("DEVELOPMENT_ONLY/NOT_CONFIRMATORY");

    await page.goto(`${baseUrl}${FIXTURES_QUERY}`);
    await expect(page.getByTestId("cr.shell.root")).toHaveCount(1);
    // Labelled as a fixture, from the fixture module's own marker.
    await expect(page.getByTestId("cr.banner.fixture"))
      .toContainText("DEVELOPMENT_ONLY/NOT_CONFIRMATORY");
    await expect(page.getByTestId("cr.config.notice")).toHaveCount(0);
    return "gate-complete";
  });
  expect(outcome).toEqual({ ok: true, value: "gate-complete" });
});

/**
 * Binds this file to the ledger. Without it the two could drift: a scenario could be
 * marked COVERED with no journey driving it, or a journey could imply coverage the
 * ledger never recorded. Both lists are hand-written, so neither can be derived from
 * the other and pass vacuously.
 */
test("the ledger's COVERED set is exactly what this file drives", () => {
  const ledger = coveredScenarios().map((scenario) => scenario.id).sort();
  expect(ledger).toEqual([...EXERCISED_SCENARIOS].sort());
  expect(ledger.length).toBeGreaterThan(0);
});
