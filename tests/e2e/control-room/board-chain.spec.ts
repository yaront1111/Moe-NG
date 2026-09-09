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
const GOAL_CREATE_KIND = "goal.create";
const GOAL_CLOSE_KIND = "goal.close";
const PLAN_KIND = "plan.propose";
const APPROVAL_KIND = "approval.decide";
/** live-board.tsx writes "dispatching" + U+2026; the ASCII head tells it from an answer. */
const PENDING_REPORT_HEAD = "dispatching";
/** `${stage}: ${disposition} ${resultCode}` for a command the daemon committed. */
const ACCEPTED_REPORT = "ANSWERED: DECIDED EFFECTS_COMMITTED";
const POLL_INTERVAL_MS = 2_000;

/**
 * The one path a board dispatch posts to (client-transport.ts `COMMAND_PATH`, the
 * V1 authority plane). The approval's budget commitment is read over a DIFFERENT
 * path, `/budget/commitment/read`, so filtering on this one leaves exactly one
 * witness per click and no background traffic to subtract.
 */
const COMMAND_PATH = "/command";
/**
 * The first command of a plan.propose sealing chain (live-planning-authorities.ts
 * `proposeChain`), and the member that names the goal the draft is opened against.
 */
const CREATE_DRAFT_KIND = "planning.create_draft";
/**
 * The RETIRED fixed subjects, `DEFAULT_RUN_SUBJECT`/`DEFAULT_GOAL_SUBJECT` from
 * apps/daemon/src/http/affordance-read.ts.
 *
 * They are written down only to be REFUSED. This lane deliberately omits the
 * `fixedDemoGoal` provider, so the daemon runs its production composition and
 * mints the goal - and therefore its run - per journey. Naming the old constants
 * here is what stops a re-pinned fixture from passing as the repair: the browser's
 * authority used to be cryptographically pinned to this one pair, and the whole
 * point of the daemon's per-run planning material is that it no longer is.
 */
const DEFAULT_RUN_SUBJECT = "run-live-1";
const DEFAULT_GOAL_SUBJECT = "goal-live-1";

/** A round trip plus the poll that re-keys the card, with slack for a cold module graph. */
const REPORT_BUDGET_MS = 20_000;
const CARD_BUDGET_MS = 30_000;

interface BoardReport {
  readonly ok: string;
  readonly testId: string;
  readonly text: string;
}

/**
 * One `/command` POST as the BROWSER sent it, read back off the wire.
 *
 * Every member is nullable and nothing is defaulted: a body that carried no
 * `runId` must read as absent rather than as some canonical value this test
 * supplied, because "the board sent the wrong run" and "the board sent no run"
 * are different defects and only the wire can tell them apart.
 */
interface CommandWitness {
  readonly commandKind: string | null;
  readonly draftGoalRef: string | null;
  readonly draftKind: string | null;
  readonly expectedVersion: number | null;
  readonly runId: string | null;
  readonly targetAggregateId: string | null;
}

function ownString(value: Readonly<Record<string, unknown>>, key: string): string | null {
  const found = value[key];
  return typeof found === "string" && found !== "" ? found : null;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

/**
 * Parses one POST body. An absent, unparseable or non-object body answers NULL
 * for the whole witness, which the count assertions then catch - a witness that
 * silently degraded to all-null members would satisfy every join below by
 * comparing nothing to nothing.
 */
function witnessOf(body: string | null): CommandWitness | null {
  if (body === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  const envelope = plainRecord(parsed);
  if (envelope === null) return null;
  const payload = plainRecord(envelope["payload"]);
  const commands = payload === null ? null : payload["commands"];
  const draft = Array.isArray(commands) ? plainRecord(commands[0]) : null;
  const version = envelope["expectedVersion"];
  return {
    commandKind: ownString(envelope, "commandKind"),
    draftGoalRef: draft === null ? null : ownString(draft, "goalRef"),
    draftKind: draft === null ? null : ownString(draft, "kind"),
    expectedVersion: typeof version === "number" ? version : null,
    runId: payload === null ? null : ownString(payload, "runId"),
    targetAggregateId: ownString(envelope, "targetAggregateId"),
  };
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
 *
 * POLICY BEFORE ACTIVATE (task-4b9c394d), and the prerequisite TABLE cannot tell
 * you so: bootstrap-sequence.ts gives policy.install `Object.freeze([])` and lists
 * only register + bind_repository + provider.probe under project.activate, so the
 * daemon's sequence gate admits the reverse order and refuses one layer further
 * in. The daemon now MINTS its activation witness from receipts it measures, and
 * the policy receipt is the digest of the INSTALLED SLICE SET - with no slice
 * installed there is nothing to measure and the whole activation fails closed
 * with ACTIVATION_POLICY_UNMEASURED @ DAEMON_ACTIVATION_RECEIPTS. One install
 * suffices, and it is version-safe: the install rides the `-policy` aggregate at
 * 0 while the activate rides the project aggregate at 2, so no expectedVersion
 * moves. The same reorder was forced on the seed's chain in demo-seed-plan.ts.
 */
const CHAIN: readonly ChainClick[] = [
  { becomes: "COMMITTED", kind: "project.register" },
  { becomes: "COMMITTED", kind: "project.bind_repository" },
  { becomes: "COMMITTED", kind: "provider.probe" },
  { becomes: "COMMITTED", kind: "policy.install" },
  { becomes: "COMMITTED", kind: "project.activate" },
  { becomes: "READY", kind: "goal.create", renewsAggregate: true },
  { becomes: "READY", keepsBlocked: "approval.decide", kind: "plan.propose" },
  { becomes: "COMMITTED", kind: "plan.propose" },
  { becomes: "COMMITTED", kind: "approval.decide" },
];

/**
 * What one driven click leaves behind for the joins after the journey.
 *
 * `aggregateId` and `version` are the card's identity AT THE MOMENT IT WAS
 * CLICKED - the identity the dispatch was authored from - so a POST that named
 * anything else has a concrete expected value to be compared against. `after`
 * retains the TRANSITIONED card, which is how the goal that the ledger actually
 * committed is carried out of the loop: `goal.create` renews its aggregate on
 * commit, so only the clicked one names the durable goal and only the retained
 * pair can tell them apart.
 */
interface DrivenStep {
  readonly afterAggregateId: string;
  readonly aggregateId: string;
  readonly kind: string;
  readonly line: string;
  readonly version: number | null;
}

/** One click: take the offer, dispatch it, read the answer, watch the ledger move. */
async function driveClick(page: Page, step: ChainClick): Promise<DrivenStep> {
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
  return {
    afterAggregateId: after.aggregateId,
    aggregateId: before.aggregateId,
    kind: step.kind,
    line: `${step.kind}@${before.aggregateId} v${String(before.version)}`
      + ` -> ${after.status} v${String(after.version)}: ${report?.text ?? "(report re-keyed)"}`,
    version: before.version,
  };
}

test("an operator can click the whole bootstrap chain from an empty store", async ({ page }, testInfo) => {
  // Nine clicks, each gated on a 2s surface poll, behind two process startups. The
  // config's 180s is sized for a journey that reads a board the seed already
  // finished; every budget inside the lane still refuses well before this.
  test.setTimeout(300_000);
  // THE WIRE RECORD, seated before the lane exists so nothing the page sends can
  // predate it. It OBSERVES: there is no route handler, nothing is intercepted,
  // aborted or fulfilled, and the daemon answers every one of these posts itself.
  // An unparseable body is kept as a null entry rather than dropped, so a lost
  // witness reds on the count instead of shrinking the sweep into a pass.
  const posts: (CommandWitness | null)[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    let path: string;
    try { path = new URL(request.url()).pathname; } catch { return; }
    if (path !== COMMAND_PATH) return;
    posts.push(witnessOf(request.postData()));
  });
  // `fixedDemoGoal` is DELIBERATELY ABSENT. It routes the daemon onto
  // tests/e2e/control-room/fixed-demo-goal-dependencies.ts, which pins the first
  // goal.create to the retired `goal-live-1`/`run-live-1` pair; this journey has
  // to drive the daemon's PRODUCTION composition and a goal it minted itself,
  // which is what the per-run planning authority exists to make possible.
  const driven = await withDaemonBackedControlRoom(
    {
      approval: "HUMAN", liveCredentials: "ATTACHED", seed: "NONE",
    },
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

      const steps: DrivenStep[] = [];
      for (const step of CHAIN) steps.push(await driveClick(page, step));
      const evidence: string[] = steps.map((entry) => entry.line);

      // THE GOAL THIS OPERATOR CREATED, taken from the click rather than from the
      // board's current frame: goal.create renews its aggregate the moment the
      // commit lands, so the id on screen afterwards names the NEXT goal nobody
      // has created. `find` may legitimately miss, and a missing one must stop
      // the journey rather than let the joins below compare against `undefined`.
      const created = steps.find((entry) => entry.kind === GOAL_CREATE_KIND);
      if (created === undefined) {
        throw new Error(`no ${GOAL_CREATE_KIND} was driven; CHAIN is not this journey`);
      }

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

      // THE CLOSE IS OFFERED FOR THE GOAL THIS OPERATOR CREATED. goal.close is
      // minted only once the goal reaches EXECUTION_ENABLED, so its presence is
      // the approval's own effect - and asserting it by the EXACT testid is what
      // stops an unrelated sibling goal from satisfying the journey, which a
      // prefix wait would have accepted. The count then denies the reverse
      // escape: two goals, one of them this operator's, is not this journey.
      await expect(page.getByTestId(`${CARD_PREFIX}${GOAL_CLOSE_KIND}@${created.aggregateId}`),
        "the approved goal must card its own close")
        .toBeVisible({ timeout: POLL_INTERVAL_MS * 5 });
      await expect(page.locator(`[data-testid^="${CARD_PREFIX}${GOAL_CLOSE_KIND}@"]`),
        "and exactly one goal.close card, so no sibling goal can stand in for it")
        .toHaveCount(1);

      testInfo.annotations.push({ description: evidence.join("; "), type: "board-chain" });
      return { created, evidence, pids: lanePids(lane), steps };
    },
  );

  expect(driven.ok ? "ok" : `${driven.code}: ${driven.detail}`).toBe("ok");
  if (!driven.ok) return;
  const { created, evidence, steps } = driven.value;
  expect(evidence, "nine clicks and one node.deliver reading").toHaveLength(10);
  // KEPT AHEAD OF THE JOINS BELOW, where it already was. The joins read a record
  // the journey finished writing, so they cannot become false later - but an
  // orphan can only be observed now, and a failing join further down would
  // otherwise silently retire the one check with a deadline on it.
  expect(await survivingPids(driven.value.pids), "teardown must leave no orphans").toEqual([]);

  // THE CAPTURE IS NONVACUOUS AND ONE-FOR-ONE. Every join below is an `toEqual`
  // over derived lists, and empty lists agree with each other - so the three
  // counts are pinned first, in one assertion that prints all three, and only
  // then is witness[i] allowed to stand for the i-th click.
  expect(`chain=${String(CHAIN.length)} clicks=${String(steps.length)} `
    + `posts=${String(posts.length)}`, "nine chain entries, nine driven clicks, nine posts")
    .toBe("chain=9 clicks=9 posts=9");
  const witnesses = posts.flatMap((entry) => entry === null ? [] : [entry]);
  expect(witnesses, "every /command body must have parsed as an envelope").toHaveLength(9);

  // EACH POST AGAINST THE CARD IT WAS DISPATCHED FROM, in click order. The
  // expected side is the board's own rendered identity, so a dispatch that sent
  // the card the operator merely happened to be looking at, a sibling's run, or a
  // stale version reds here naming the click index that did it.
  expect(
    witnesses.map((witness, index) => `${String(index)} ${String(witness.commandKind)}`
      + ` ${String(witness.targetAggregateId)} v${String(witness.expectedVersion)}`),
    "every click must post its own card's kind, target and version",
  ).toEqual(
    steps.map((step, index) => `${String(index)} ${step.kind}`
      + ` ${step.aggregateId} v${String(step.version)}`),
  );

  // THE THREE AUTHORITY-BEARING POSTS. Two plan.propose and one approval.decide,
  // in that order and no others: a fourth planning post, or an approval that rode
  // ahead of the finalize, is a different journey than the one this lane certifies.
  const planning = witnesses.flatMap((witness, index) =>
    witness.commandKind === PLAN_KIND || witness.commandKind === APPROVAL_KIND
      ? [{ index, witness }]
      : []);
  expect(planning.map((entry) => entry.witness.commandKind),
    "exactly two plan clicks and one approval, in click order")
    .toEqual([PLAN_KIND, PLAN_KIND, APPROVAL_KIND]);
  // The BODY's run against the OFFER's target, which the join above already
  // pinned to the card. A payload naming another run - or naming none, which
  // reads as "null" here - reds against a concrete aggregate id.
  expect(planning.map((entry) => `${String(entry.witness.commandKind)}`
    + ` run=${String(entry.witness.runId)}`),
  "each planning body must name the run its own offer targeted")
    .toEqual(planning.map((entry) => `${steps[entry.index]?.kind ?? "(no click)"}`
      + ` run=${steps[entry.index]?.aggregateId ?? "(no click)"}`));
  const runIds = planning.map((entry) => String(entry.witness.runId));
  expect(new Set(runIds).size, `both plan clicks and the approval must ride ONE `
    + `daemon-authored run, got ${runIds.join(", ")}`).toBe(1);

  // MINTED, NOT THE RETIRED FIXED PAIR. Stated as two booleans rather than one
  // compound comparison, because a pair inequality is satisfied by either half
  // differing and this has to fail if EITHER subject is the old fixed one.
  const [dynamicRun = "(no planning post)"] = runIds;
  expect([dynamicRun === DEFAULT_RUN_SUBJECT, created.aggregateId === DEFAULT_GOAL_SUBJECT],
    `run ${dynamicRun} and goal ${created.aggregateId} must both be daemon-minted, `
    + `never the retired ${DEFAULT_RUN_SUBJECT}/${DEFAULT_GOAL_SUBJECT} pair`)
    .toEqual([false, false]);
  // And the commit really renewed the repeatable route, so the id above is the
  // one the ledger took rather than whatever the board happened to be offering.
  expect(created.afterAggregateId, "the created goal must not be the offer that replaced it")
    .not.toBe(created.aggregateId);

  // THE DRAFT IS OPENED AGAINST THAT SAME GOAL. Read off the first command of the
  // first plan body, so a chain opened against a sibling goal - or a body that
  // opened no draft at all - reds here rather than travelling on to be refused by
  // the daemon under a code that names something else.
  const [firstPlan] = planning;
  expect(`${String(firstPlan?.witness.draftKind)} ${String(firstPlan?.witness.draftGoalRef)}`,
    "the first plan.propose must open its draft against the created goal")
    .toBe(`${CREATE_DRAFT_KIND} ${created.aggregateId}`);
});
