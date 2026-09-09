/**
 * THE CRASH RECOVERY, DRIVEN FROM THE BROWSER BY THE HUMAN (task-161b7e9d, DoD 2).
 *
 * WHY THIS FILE EXISTS AND WHY IT IS A BROWSER CLICK. `repository.recover` is a human-only
 * command: `repository-recovery-command.ts:23` demands a DURABLE HUMAN principal, `:20` demands
 * `project.admin`, and `:25` refuses the MCP, wrapper and verifier transports outright. So the
 * recovery a crashed landing needs cannot be dispatched by any agent seat -- the paired browser
 * human is the ONLY principal that can take it, which is exactly the shape DoD 1 asks the whole
 * loop to be driven in. The card is the shipped `RepositoryRecoveryCard`; nothing here reaches
 * past it into the daemon.
 *
 * WHAT THE PRODUCT DOES WITH THE CLICK, measured rather than assumed. `RECONCILE_LANDED` joins
 * durable evidence (`repository-recovery-evidence.ts`): the landing intent, its journaled
 * completion, the verifier receipt and the Git commit the completion names. When a landing
 * receipt is missing it writes exactly ONE -- `needsLandingReceipt` -- and then releases the
 * reservation. It refuses `REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN` when the journal cannot
 * prove what Git did, which is why the crash point this drive arms is `after-completion`.
 *
 * THE READ IS PER MOUNT, NOT POLLED (`use-effect-read.ts`), so the caller must arrive at the
 * health screen AFTER the crash. `openRecovery` navigates away and back for exactly that reason.
 */
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/** The card renders one action row per shipped action, available or refused with its code. */
export interface LiveRecoveryAction {
  readonly available: boolean;
  /** The refusal code the card printed when the action is not offered. */
  readonly code: string | null;
  readonly label: string;
}

export interface LiveRecoveryReading {
  readonly actions: readonly LiveRecoveryAction[];
  /**
   * WHAT THE CARD ACTUALLY SAID, kept whether the drive succeeded or not.
   *
   * A reservation that never appears has a REASON and the card prints it -- a scan code, a read
   * refusal, or "No repository reservation needs recovery." Reporting only "not offered" would
   * throw that reason away, and this row's value is that its records carry codes.
   */
  readonly cardText: string;
  /** The button this drive clicked, verbatim from the card. */
  readonly clicked: string | null;
  readonly confirmed: boolean;
  readonly nodeRef: string;
  /** The reservation line the card rendered: revision and phase. */
  readonly reservation: string;
  /** The card's own refusal note, when the daemon declined the decision. */
  readonly refusal: string | null;
}

const NAV_MS = 30_000;
/** How long one mounted card is given to answer its first read before it is remounted. */
const READ_MS = 60_000;
const CARD_MS = 120_000;
const DECISION_MS = 120_000;
const RECONCILE_LABEL = "Reconcile completed landing";
const ABORT_LABEL = "Release unused reservation";

/**
 * Mounts the health screen fresh AND WAITS FOR THE READ TO LAND.
 *
 * The wait is the point. `useEffectRead` renders "Reading recovery options…" until the first
 * `/repository/recovery/read` answers, so a caller that remounted on a fixed cadence would
 * navigate away mid-read every time and see that placeholder forever. MEASURED 2026-09-09: a
 * two-second remount loop reported RESERVATION_NEVER_OFFERED for a reservation the daemon was
 * offering RECONCILE_LANDED on, at the same instant, over its own wire.
 */
async function openRecovery(page: Page): Promise<Locator> {
  await page.getByTestId("cr.nav.goals").click({ timeout: NAV_MS });
  await page.getByTestId("cr.nav.health").click({ timeout: NAV_MS });
  const card = page.getByTestId("cr.health.recovery");
  await expect(card, "the repository recovery card must mount").toBeVisible({ timeout: NAV_MS });
  await expect(card, "the recovery read must answer before the card is read")
    .not.toContainText("Reading recovery options", { timeout: READ_MS });
  return card;
}

/** Reads the two action rows the card renders: the button, or the code that replaced it. */
async function readActions(row: Locator): Promise<readonly LiveRecoveryAction[]> {
  const actions: LiveRecoveryAction[] = [];
  for (const label of [ABORT_LABEL, RECONCILE_LABEL]) {
    const button = row.getByRole("button", { name: label });
    actions.push({ available: await button.count() > 0, code: null, label });
  }
  // The card prints the refusal code IN PLACE OF the button, so an unavailable action is read
  // from the codes it left behind rather than from the button's absence alone.
  const codes = await row.locator(".cr2-approve-mono").allTextContents();
  return actions.map((action, index) => ({
    ...action, code: action.available ? null : codes[index] ?? codes[0] ?? null,
  }));
}

/**
 * Waits for the crashed node's reservation to appear, then clicks RECONCILE_LANDED.
 *
 * REMOUNTS UNTIL IT APPEARS, because the wrapper's next pass is what moves the reservation into
 * a phase the recovery view offers, and the card reads once per mount. Every remount is a fresh
 * `/repository/recovery/read`, so a reservation that never appears fails on the budget instead
 * of on a stale render.
 */
export async function reconcileLandingInBrowser(
  page: Page, nodeRef: string, reason: string,
): Promise<LiveRecoveryReading> {
  const deadline = Date.now() + CARD_MS;
  let card = await openRecovery(page);
  let row = card.getByTestId(`cr.health.recovery.${nodeRef}`);
  while (await row.count() === 0 && Date.now() < deadline) {
    // The read has already ANSWERED at this point (`openRecovery` waits for it), so a missing
    // row means the daemon did not offer the reservation yet -- the wrapper's next pass is what
    // changes that. Remount slowly rather than hammering a card that is answering fine.
    await page.waitForTimeout(5_000);
    card = await openRecovery(page);
    row = card.getByTestId(`cr.health.recovery.${nodeRef}`);
  }
  const cardText = (await card.textContent())?.replace(/\s+/gu, " ").trim() ?? "";
  if (await row.count() === 0) {
    return { actions: [], cardText, clicked: null, confirmed: false, nodeRef,
      refusal: "RESERVATION_NEVER_OFFERED", reservation: "" };
  }
  const reservation = (await row.locator(".cr2-needs-note").first().textContent())?.trim() ?? "";
  const actions = await readActions(row);
  const reconcile = row.getByRole("button", { name: RECONCILE_LABEL });
  if (await reconcile.count() === 0) {
    return { actions, cardText, clicked: null, confirmed: false, nodeRef,
      refusal: actions.find((action) => action.label === RECONCILE_LABEL)?.code
        ?? "RECONCILE_NOT_OFFERED", reservation };
  }
  // The reason is REQUIRED by the shipped port (`repository-recovery-port.ts:13`) and the button
  // stays disabled while it is empty, so typing it is part of the product's own gate.
  await row.getByLabel(`Recovery reason for ${nodeRef}`).fill(reason);
  await reconcile.click({ timeout: NAV_MS });
  // WHAT SUCCESS LOOKS LIKE, and why it is not the confirmation sentence alone. On an accepted
  // decision the card calls `onRecorded`, which REFRESHES the read; the released reservation
  // then leaves the view and takes the whole control -- confirmation sentence included -- with
  // it. MEASURED 2026-09-09: a 500 ms poll for that sentence saw neither it nor a refusal, on a
  // decision the daemon had accepted. So the durable browser-visible outcome is the reservation
  // NO LONGER BEING OFFERED, re-read on a fresh mount below.
  const refusalNote = card.getByTestId(`cr.health.recovery.refusal.${nodeRef}`);
  const confirmation = card.getByText("Recovery decision recorded.");
  let sentence = false;
  const settled = Date.now() + DECISION_MS;
  while (Date.now() < settled && await refusalNote.count() === 0) {
    if (await confirmation.count() > 0) { sentence = true; break; }
    if (await row.count() === 0) break;
    await page.waitForTimeout(250);
  }
  const refusal = await refusalNote.count() > 0
    ? (await refusalNote.textContent())?.replace(/\s+/gu, " ").trim() ?? "REFUSED" : null;
  if (refusal !== null) {
    return { actions, cardText, clicked: RECONCILE_LABEL, confirmed: false, nodeRef, refusal,
      reservation };
  }
  // THE RE-READ IS THE ASSERTION. A reservation the daemon still offers was never released,
  // whatever the card said in the moment.
  const after = await openRecovery(page);
  const stillHeld = await after.getByTestId(`cr.health.recovery.${nodeRef}`).count() > 0;
  return { actions, cardText: (await after.textContent())?.replace(/\s+/gu, " ").trim() ?? cardText,
    clicked: RECONCILE_LABEL, confirmed: !stillHeld,
    nodeRef, refusal: stillHeld ? `RESERVATION_STILL_HELD${sentence ? "_AFTER_CONFIRMATION" : ""}` : null,
    reservation };
}
