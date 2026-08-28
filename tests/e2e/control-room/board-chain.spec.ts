import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { lanePids, survivingPids, withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";

/**
 * The OPERATOR-DRIVEN chain: an empty store, human approval, nine clicks.
 *
 * WHY `daemon-board.spec.ts` CANNOT COVER THIS. That journey runs the shipped
 * seed, which drives the whole bootstrap chain SERVER-SIDE over the daemon's own
 * HTTP surface, and then asserts over the finished board. A daemon gate change
 * that only the BOARD's payloads fail therefore leaves it green, and leaves every
 * unit suite green too: the control room's dev payloads are fixtures to a unit
 * test, and the seed's payloads are different bytes on a different code path.
 * That is exactly how ada30c1 + 132d506 landed - approval.decide began demanding
 * the run reach PLAN_REVIEW through a separate planning.finalize_submission
 * request, the board's plan.propose payload never sent one, and from an empty
 * store the operator could no longer click the chain to the end. A hand-run
 * browser session caught it and nothing else did.
 *
 * WHAT LETS THIS LANE SEE IT. `seed: "NONE"` leaves the store empty, so every
 * commit below is authored by a click on the production control, carrying the
 * production payloads, answered by the daemon's own gates. `approval: "HUMAN"`
 * removes the speed-mode escape: the approval commits because the operator
 * credential is the human seat, which is the path a real operator is on.
 *
 * THE REPORT IS RECORDED, NOT SAMPLED. A card's dispatch report lives only until
 * the next 2s surface poll re-keys the card - live-board.tsx keys reports by
 * [kind, aggregateId, version], so the commit that answers a click is also what
 * destroys the answer's rendering. A watcher sampling on its own schedule can
 * watch a dispatch succeed and see nothing, so a DOM recorder seated before the
 * first click keeps every report text and the assertions read what it kept.
 */

/**
 * HAND-TRANSCRIBED from apps/control-room/src/live (live-board.tsx test ids and
 * pending text, live-app.tsx POLL_INTERVAL_MS, live-dispatch.ts DispatchReport)
 * and from the daemon's DurableDecision (daemon-command-dispatch.ts: disposition
 * then resultCode), for the reason daemon-board.spec.ts gives: this directory's
 * tsconfig cannot reach into apps/ (TS6059), and deriving the expected strings
 * from the modules that produce them would make the assertions self-referential -
 * they would pass whatever the board put on screen.
 */
const CARD_PREFIX = "cr.liveboard.card.";
const DISPATCH_PREFIX = "cr.liveboard.dispatch.";
const REPORT_PREFIX = "cr.liveboard.report.";
const NODE_DELIVER_KIND = "node.deliver";
/** live-board.tsx writes "dispatching" + U+2026; the ASCII head tells it from an answer. */
const PENDING_REPORT_HEAD = "dispatching";
/** `${stage}: ${disposition} ${resultCode}` for a command the daemon committed. */
const ACCEPTED_REPORT = "ANSWERED: DECIDED EFFECTS_COMMITTED";
const POLL_INTERVAL_MS = 2_000;

/** A round trip plus the poll that re-keys the card, with slack for a cold module graph. */
const REPORT_BUDGET_MS = 20_000;
const CARD_BUDGET_MS = 30_000;

interface BoardReport {
  readonly ok: string;
  readonly testId: string;
  readonly text: string;
}

interface CardView {
  readonly aggregateId: string;
  readonly dispatchable: boolean;
  readonly status: string;
  readonly version: number | null;
}

/**
 * What one frame has to show before the wait returns. A null `status` or
 * `notVersion` states no requirement, and `dispatchable: false` states no
 * requirement EITHER - it never asserts the control is gone, because the card
 * that stays READY between the two plan.propose clicks must keep its control.
 * The absence of a control is asserted on the returned view where it is meant.
 */
interface CardWant {
  readonly dispatchable: boolean;
  readonly kind: string;
  readonly notAggregateId?: string;
  readonly notVersion: number | null;
  readonly status: string | null;
}

declare global {
  interface Window {
    __moeBoardReports?: BoardReport[];
  }
}

/**
 * Records every dispatch report the board renders, as it renders it.
 *
 * A MutationObserver callback runs off the same task as the mutation, so the 2s
 * poll that removes a report cannot outrun it; a sampler driven from the test
 * process can be outrun and was. Seated as an init script so it exists before
 * React mounts, and it observes `document` because `document.body` does not exist
 * yet at that point. A testid whose node has GONE is forgotten, so the next
 * appearance of the same card's report is recorded even when its text repeats.
 */
async function installReportRecorder(page: Page): Promise<void> {
  // The handle is deliberately dropped: disposing it would REMOVE the recorder,
  // and it must outlive every click in this journey.
  await page.addInitScript(() => {
    const recorded: BoardReport[] = [];
    const last = new Map<string, string>();
    window.__moeBoardReports = recorded;
    const scan = (): void => {
      const present = new Set<string>();
      for (const node of Array.from(
        document.querySelectorAll('[data-testid^="cr.liveboard.report."]'),
      )) {
        const testId = node.getAttribute("data-testid") ?? "";
        const ok = node.getAttribute("data-ok") ?? "";
        const text = node.textContent ?? "";
        present.add(testId);
        if (last.get(testId) === `${ok}|${text}`) continue;
        last.set(testId, `${ok}|${text}`);
        recorded.push({ ok, testId, text });
      }
      for (const key of Array.from(last.keys())) if (!present.has(key)) last.delete(key);
    };
    new MutationObserver(scan).observe(document, {
      attributes: true, characterData: true, childList: true, subtree: true,
    });
  });
}

/** Whatever the board is showing right now, so a timeout names the state it hung in. */
async function boardSnapshot(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid^="cr.liveboard.card."]'))
      .map((node) => `${node.getAttribute("data-testid") ?? "?"}=${
        node.getAttribute("data-status") ?? "?"}`);
    const reports = (window.__moeBoardReports ?? [])
      .map((entry) => `${entry.testId} ok=${entry.ok} ${entry.text}`);
    return `cards[${cards.join(" ")}] reports[${reports.join(" | ")}]`;
  }).catch(() => "the page could not be read");
}

/**
 * Waits for the card the daemon's next surface poll publishes, found by testid
 * PREFIX so the aggregate id is read OFF the board rather than re-derived here: a
 * test that spelled the daemon's own aggregate-id rule would go on agreeing with
 * itself after that rule moved.
 */
async function waitForCard(page: Page, want: CardWant): Promise<CardView> {
  const found = await page.waitForFunction((wanted: CardWant) => {
    const prefix = `cr.liveboard.card.${wanted.kind}@`;
    const node = document.querySelector(`[data-testid^="${prefix}"]`);
    if (node === null) return null;
    const testId = node.getAttribute("data-testid") ?? "";
    const aggregateId = testId.slice(prefix.length);
    const status = node.getAttribute("data-status") ?? "";
    const matched = /version (\d+)/u.exec(node.textContent ?? "");
    const version = matched === null ? null : Number(matched[1]);
    const dispatchable = node.querySelector(
      `[data-testid="cr.liveboard.dispatch.${wanted.kind}"]`,
    ) !== null;
    if (wanted.status !== null && status !== wanted.status) return null;
    if (wanted.dispatchable && !dispatchable) return null;
    if (wanted.notAggregateId !== undefined
      && aggregateId === wanted.notAggregateId) return null;
    if (wanted.notVersion !== null && version === wanted.notVersion) return null;
    return { aggregateId, dispatchable, status, version };
  }, want, { timeout: CARD_BUDGET_MS }).catch(() => null);
  const view = found === null ? null : await found.jsonValue();
  if (view === null) {
    throw new Error(`${want.kind}: no card reached ${JSON.stringify(want)} within `
      + `${String(CARD_BUDGET_MS)}ms. ${await boardSnapshot(page)}`);
  }
  return view;
}

/**
 * The daemon's answer to one click, taken from the recorder. `since` is the
 * recorder's length before the click: plan.propose is dispatched twice against
 * the SAME aggregate, so both clicks write the same testid and an unbounded
 * search would answer the second click with the first click's report.
 */
async function readReport(
  page: Page, kind: string, aggregateId: string, since: number,
): Promise<BoardReport | null> {
  const testId = `${REPORT_PREFIX}${kind}@${aggregateId}`;
  const found = await page.waitForFunction((wanted: {
    readonly pending: string; readonly since: number; readonly testId: string;
  }) => (window.__moeBoardReports ?? []).slice(wanted.since).find((entry) =>
    entry.testId === wanted.testId && !entry.text.startsWith(wanted.pending)) ?? null,
  { pending: PENDING_REPORT_HEAD, since, testId },
  { timeout: REPORT_BUDGET_MS }).catch(() => null);
  return found === null ? null : await found.jsonValue();
}

interface ChainClick {
  /** The card's status once the poll that follows this click re-keys it. */
  readonly becomes: "COMMITTED" | "READY";
  /** A peer whose card must STILL be BLOCKED after this click landed. */
  readonly keepsBlocked?: string;
  readonly kind: string;
  /** The repeatable route must publish a fresh READY aggregate after this one commits. */
  readonly renewsAggregate?: true;
}

/**
 * The bootstrap chain in the order the daemon's prerequisite table admits, with
 * plan.propose TWICE: the first click seals the plan, the second carries the
 * finalize terminal the daemon refuses to accept in the same request. Between the
 * two lies the regression's whole signature - the card stays READY at an advanced
 * version, and approval.decide stays BLOCKED on it rather than being offered
 * against a run the daemon would answer APPROVAL_RUN_NOT_REVIEWABLE.
 *
 * WHAT THIS GUARD ACTUALLY PRINTS is the SYMPTOM, not that code. Which step reds
 * depends on which half is broken: a board that never finalizes stalls at the
 * ninth click, while a surface that calls a half-proposed run COMMITTED reds at
 * the seventh, on the wait that demands the card stay READY. Only the first of
 * those ever clicks approval.decide, so do not expect the daemon's own code in
 * the output - expect the named step and the board snapshot.
 */
const CHAIN: readonly ChainClick[] = [
  { becomes: "COMMITTED", kind: "project.register" },
  { becomes: "COMMITTED", kind: "project.bind_repository" },
  { becomes: "COMMITTED", kind: "provider.probe" },
  { becomes: "COMMITTED", kind: "project.activate" },
  { becomes: "COMMITTED", kind: "policy.install" },
  { becomes: "READY", kind: "goal.create", renewsAggregate: true },
  { becomes: "READY", keepsBlocked: "approval.decide", kind: "plan.propose" },
  { becomes: "COMMITTED", kind: "plan.propose" },
  { becomes: "COMMITTED", kind: "approval.decide" },
];

/** One click: take the offer, dispatch it, read the answer, watch the ledger move. */
async function driveClick(page: Page, step: ChainClick): Promise<string> {
  const before = await waitForCard(page, {
    dispatchable: true, kind: step.kind, notVersion: null, status: "READY",
  });
  const since = await page.evaluate(() => (window.__moeBoardReports ?? []).length);
  await page.getByTestId(`${DISPATCH_PREFIX}${step.kind}`).click();
  const report = await readReport(page, step.kind, before.aggregateId, since);
  console.log(`[board-chain] ${step.kind}@${before.aggregateId} `
    + `v${String(before.version)} ${report === null ? "(report re-keyed)" : `ok=${report.ok} ${report.text}`}`);
  // A PAINTED answer must be the accepted one; an ABSENT one is not a failure,
  // because the report is keyed by the card's version and the very commit being
  // awaited is what advances it. When the poll re-keys the card before React
  // files the answer, the text is never painted at all and no recorder can
  // capture what never rendered - so a refusal reds here and a lost answer falls
  // through to the ledger wait below, which is the proof that actually governs.
  if (report !== null) {
    // Kind and answer in ONE assertion: a bare comparison of the text reports a
    // string with no subject, and the next regression has to be diagnosable from
    // this line alone.
    expect(`${step.kind} ok=${report.ok} ${report.text}`, "the board must report a commit")
      .toBe(`${step.kind} ok=true ${ACCEPTED_REPORT}`);
  }
  // Only the ledger moves cards, so the move is the proof the click had an effect.
  const after = await waitForCard(page, {
    dispatchable: step.renewsAggregate === true, kind: step.kind,
    ...(step.renewsAggregate === true ? { notAggregateId: before.aggregateId } : {}),
    notVersion: step.renewsAggregate === true
      ? null
      : step.becomes === "READY" ? before.version : null,
    status: step.becomes,
  });
  if (step.renewsAggregate === true) {
    expect(after.aggregateId, `${step.kind} must renew its repeatable aggregate`)
      .not.toBe(before.aggregateId);
    expect(after.version, `${step.kind} must publish a fresh version-zero offer`).toBe(0);
    expect(after.dispatchable, `${step.kind} fresh offer must remain dispatchable`).toBe(true);
  }
  if (step.keepsBlocked !== undefined) {
    const peer = await waitForCard(page, {
      dispatchable: false, kind: step.keepsBlocked, notVersion: null, status: "BLOCKED",
    });
    expect(`${step.keepsBlocked} ${peer.status} dispatchable=${String(peer.dispatchable)}`,
      `${step.keepsBlocked} must stay blocked until the run is reviewable`)
      .toBe(`${step.keepsBlocked} BLOCKED dispatchable=false`);
  }
  return `${step.kind}@${before.aggregateId} v${String(before.version)}`
    + ` -> ${after.status} v${String(after.version)}: ${report?.text ?? "(report re-keyed)"}`;
}

test("an operator can click the whole bootstrap chain from an empty store", async ({ page }, testInfo) => {
  // Nine clicks, each gated on a 2s surface poll, behind two process startups. The
  // config's 180s is sized for a journey that reads a board the seed already
  // finished; every budget inside the lane still refuses well before this.
  test.setTimeout(300_000);
  const driven = await withDaemonBackedControlRoom(
    { approval: "HUMAN", liveCredentials: "ATTACHED", seed: "NONE" },
    async (lane: DaemonLane) => {
      // The lane's OWN contract, not evidence about the store: it must report no
      // seed child rather than a fabricated pid that would name a stranger.
      expect(lane.seedPid, "an unseeded lane must claim no seed pid").toBeNull();
      await installReportRecorder(page);
      await page.goto(`${lane.baseUrl}?v1=1`);
      await expect(page.getByTestId("cr.liveboard"), "the live board must attach")
        .toBeVisible({ timeout: CARD_BUDGET_MS });
      // No fixture board underneath: every card below is the daemon's answer.
      await expect(page.getByTestId("cr.banner.fixture")).toHaveCount(0);
      // THE EMPTY STORE IS PROVEN BY THE DRIVE, not by an absence taken here. An
      // absence one frame after attach is satisfied by a board that has simply
      // not polled yet. What cannot be faked is the first click: project.register
      // is found READY at version 0 and commits, which a seeded store - where it
      // is already COMMITTED and offers no control - could never satisfy.
      const deliverTestId = `${CARD_PREFIX}${NODE_DELIVER_KIND}@${lane.nodeRef}`;

      const evidence: string[] = [];
      for (const step of CHAIN) evidence.push(await driveClick(page, step));

      // The node spec was on disk the whole time; only the approval made it a step.
      const deliver = page.getByTestId(deliverTestId);
      await expect(deliver, "node.deliver must appear once approval lands")
        .toBeVisible({ timeout: POLL_INTERVAL_MS * 5 });
      await expect(deliver).toHaveAttribute("data-status", "READY");
      await expect(page.getByTestId("cr.liveboard.column.ready").getByTestId(deliverTestId),
        "and in the column the daemon put it in").toHaveCount(1);
      const line = `${NODE_DELIVER_KIND}@${lane.nodeRef} = `
        + `${String(await deliver.getAttribute("data-status"))}`;
      evidence.push(line);
      console.log(`[board-chain] ${line}`);
      testInfo.annotations.push({ description: evidence.join("; "), type: "board-chain" });
      return { evidence, pids: lanePids(lane) };
    },
  );

  expect(driven.ok ? "ok" : `${driven.code}: ${driven.detail}`).toBe("ok");
  if (!driven.ok) return;
  expect(driven.value.evidence, "nine clicks and one node.deliver reading").toHaveLength(10);
  expect(await survivingPids(driven.value.pids), "teardown must leave no orphans").toEqual([]);
});
