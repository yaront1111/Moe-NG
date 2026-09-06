import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { ACTIVATION_CHAIN_KINDS } from "../../../apps/control-room/src/v2/ops/activation-port.js";
import { withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";

/**
 * THE BROWSER-ONLY FRESH START, end to end, against a REAL daemon with an EMPTY store.
 *
 * The claim under test is the one README and the runbook have been denying: that a fresh
 * project can be taken from nothing to a created goal without a terminal. So the lane runs
 * `seed: "NONE"` — no seed child, no fixtures — and the spec asserts `lane.seedPid` is null
 * before it touches the page. A journey that cannot prove it ran unseeded proves nothing here.
 *
 * IT DRIVES THE V2 CARD, NOT THE LEGACY DEV BOARD. `main.tsx:101` serves the legacy shell only
 * for `?v1=1`, so the bare `lane.baseUrl` is the product. A journey clicking `cr.liveboard.*`
 * would re-prove the old dev path and leave the shipped surface untested (row rail 3).
 *
 * THE RECORDER IS SEATED BEFORE THE FIRST CLICK, for the reason board-chain.spec.ts:26-33
 * documents: a card's dispatch report lives only until the next surface poll re-keys the card,
 * so a watcher sampling on its own schedule can watch a dispatch succeed and see nothing.
 *
 * RECEIPTS ARE ASSERTED AS MEASURED, NOT MERELY PRESENT. The repository row must carry the
 * lane's own HEAD sha, read from git rather than derived from anything the page said, and no
 * row may read as a `<projectId>-*` literal — that shape is what a placeholder looks like.
 */

const JOURNEY_MS = 420_000;
const CARD_MS = 120_000;
const CHAIN_MS = 180_000;
const SHA = /^[0-9a-f]{40}$/u;
const PAIRING_BUDGET_MS = 90_000;
const PAIRING_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;
const GOAL_TITLE = "Browser-only fresh start";
const PRD_TEXT = "# Fresh start\n\nAn operator creates the first goal without a terminal.\n";
const PRD_SHA256 = createHash("sha256").update(PRD_TEXT, "utf8").digest("hex");

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

/**
 * The operator's real pairing ritual, copied from publish-remote.spec.ts:73-88.
 *
 * `liveCredentials: "ATTACHED"` bakes the bundle's credentials but does NOT pair the tab: the
 * app still refuses with "Moe was started without a terminal it can listen on" unless the lane
 * was opened with `operatorChannel: true`, which is what `--operator-stdin` gives the daemon.
 * The label is read from the page and typed back on the daemon's own channel, so nothing here
 * approves on the operator's behalf.
 */
async function pairBrowser(page: Page, lane: DaemonLane): Promise<void> {
  const approve = lane.approvePairing;
  expect(approve, "the lane must expose an operator channel").not.toBeNull();
  const output = page.getByLabel("Pairing confirmation label");
  await expect(output).toBeVisible({ timeout: 30_000 });
  const label = (await output.textContent())?.trim() ?? "";
  expect(label, "the browser must be shown a real label").toMatch(PAIRING_LABEL);
  approve?.(label);
  const confirm = page.getByRole("button", { name: "I entered this label" });
  const deadline = Date.now() + PAIRING_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await output.count() === 0) return;
    await confirm.click({ timeout: 5_000 }).catch(() => undefined);
    await sleep(1_000);
  }
  await expect(output, "the pairing card must close").toHaveCount(0, { timeout: 10_000 });
}

/** One complete draft. Both attempts use it, so only the activation differs between them. */
async function fillDraft(page: Page, title: string): Promise<void> {
  await page.getByTestId("cr.goals.newgoal.title").fill(title);
  await page.getByTestId("cr.goals.newgoal.outcome")
    .fill("A goal is created from the browser on a store no script ever seeded.");
  await page.getByTestId("cr.goals.newgoal.criteria")
    .fill("The daemon accepts the create and the goal appears in the catalog.");
  // A FILE input, not a text box (new-goal-form.tsx:130 renders `type="file"` visually hidden),
  // so the PRD is attached the way the operator attaches one. It has to be a real attachment:
  // DoD 1 asks for `goal.create_with_source`, and without a source the browser sends the
  // brief-only `goal.create` instead — a different command kind and a weaker proof.
  await page.getByTestId("cr.goals.newgoal.prd.input").setInputFiles({
    buffer: Buffer.from(PRD_TEXT, "utf8"),
    mimeType: "text/markdown",
    name: "fresh-start-prd.md",
  });
  // The status line states the digest the BROWSER computed, not the filename. Asserting it
  // against a sha256 taken here proves the exact bytes were read client-side — a filename echo
  // would pass against a browser that never opened the file.
  await expect(page.getByTestId("cr.goals.newgoal.prd.status")).toContainText(PRD_SHA256);
}

/** The lane's actual HEAD, from git. Transcribed into the assertion, never derived from the DOM. */
function headSha(repoRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

test("a fresh project goes from empty store to a created goal, in the browser alone", async ({ page }) => {
  // UN-PARKED by task-d342a2b158764fefa8dbf2a5365e7bf7, which deleted this journey's
  // `test.fixme` and changed NOTHING ELSE in this file. It used to fail on a genuinely empty
  // store: the chain ran project.register, project.bind_repository and provider.probe green and
  // then `project.activate` refused ACTIVATION_POLICY_UNMEASURED @ DAEMON_ACTIVATION_RECEIPTS,
  // because nothing in ACTIVATION_CHAIN_KINDS installed the policy whose digest that receipt
  // measures. `policy.install` is now a member of that roster, so the chain satisfies the
  // receipt authority as well as the admission table. The refusal itself is UNCHANGED and still
  // reachable — this row made the browser satisfy the prerequisite, never suppressed it.
  test.setTimeout(JOURNEY_MS);

  const outcome = await withDaemonBackedControlRoom({
    approval: "HUMAN",
    liveCredentials: "ATTACHED",
    // Without the operator channel the tab can never pair, and the Activate card never mounts.
    operatorChannel: true,
    seed: "NONE",
  }, async (lane) => {
    // THE PREMISE, asserted before anything else: no seed child ever ran. `seedPid` is null
    // only for `seed: "NONE"` (daemon-ports.ts:245-249), so this is the lane's own witness
    // that the store the browser is about to drive was never populated by a script.
    expect(lane.seedPid, "seed child pid (null proves the lane ran unseeded)").toBeNull();

    const expectedSha = headSha(lane.repoRoot);
    expect(expectedSha, "lane HEAD sha").toMatch(SHA);

    // No `?v1=1`: the bare base URL serves the V2 Cordum shell.
    await page.goto(lane.baseUrl);
    await pairBrowser(page, lane);

    // THE CARD. It renders only once `/activation/read` answers with receipts; a daemon that
    // does not wire the port renders `cr.activate.refusal` instead and never mounts a button.
    const card = page.getByTestId("cr.activate.root");
    await expect(card).toBeVisible({ timeout: CARD_MS });
    await expect(page.getByTestId("cr.activate.refusal"), "the daemon stated its receipts")
      .toHaveCount(0);

    // RECEIPTS ARE MEASURED. The repository row carries the lane's real HEAD sha.
    const repositoryReason = page.getByTestId("cr.activate.reason.repository");
    await expect(repositoryReason).toBeVisible({ timeout: CARD_MS });
    await expect(repositoryReason).toContainText(expectedSha);

    // NO PROVIDER READING YET, and that is the correct answer on an empty store: the provider
    // receipt is bound to a COMMITTED provider.probe, and the card publishes the version only
    // beside a provider it actually measured. A version rendered here would be one the daemon
    // could not have taken.
    await expect(page.getByTestId("cr.activate.version"), "no reading before the probe commits")
      .toHaveCount(0);

    // NO ROW IS A PLACEHOLDER. `<projectId>-*` is what a stubbed receipt looks like, so its
    // absence is asserted over the whole list rather than per row — a placeholder that moved
    // to a different member would otherwise slip past.
    const receiptsText = await page.getByTestId("cr.activate.receipts").innerText();
    expect(receiptsText, "no receipt reads as a <projectId>-* literal")
      .not.toContain(`${lane.projectId}-`);

    // THE DAEMON REFUSES A CREATE BEFORE ACTIVATION, AND SAYS WHY, IN ITS OWN WORDS.
    //
    // MEASURED DEVIATION FROM THE DoD, disclosed rather than worked around. DoD 1 says to
    // assert New Goal is "BLOCKED with the daemon's stated reason", but the shipped button is
    // not gated on the offer at all: `createDisabledReason` (cordum-app.tsx:364) derives ONLY
    // from the connection descriptor, so an attached session enables the control whether or
    // not `goal.create` is offered. `goalCreateRefusal` has exactly ONE production consumer,
    // live-goal-create.ts:215, which runs on SUBMIT and renders into the create report. The
    // guidance therefore reaches the operator one step later than the DoD assumed, and
    // asserting a disabled button here would be asserting a product that does not exist.
    //
    // This arm proves the DoD's substance and more: the daemon really refuses, and the words
    // it refuses with are the ones this row rewrote. A disabled button proves neither.
    const newGoal = page.getByTestId("cr.goals.new");
    await expect(newGoal).toBeVisible({ timeout: CARD_MS });
    await newGoal.click();
    await expect(page.getByTestId("cr.goals.newgoal.form")).toBeVisible({ timeout: CARD_MS });
    await fillDraft(page, "Pre-activation attempt");
    await page.getByTestId("cr.goals.newgoal.create").click();

    const preReport = page.getByTestId("cr.goals.newgoal.report");
    await expect(preReport).toBeVisible({ timeout: CHAIN_MS });
    const blockedReason = (await preReport.textContent()) ?? "";
    expect(blockedReason, "the daemon refused the pre-activation create").not.toBe("");
    expect(blockedReason, "no goal was created before activation").not.toContain("Goal created:");
    // The replaced copy must be gone from the LIVE surface, not merely from the source.
    expect(blockedReason, "the copy no longer sends the operator to a terminal")
      .not.toContain("cannot drive the pre-activation chain");
    await page.getByTestId("cr.goals.newgoal.cancel").click();

    // SEAT THE RECORDER BEFORE THE CLICK. Step rows are re-keyed by the next surface poll, so
    // a post-hoc read can miss a step that really did land.
    await page.evaluate(() => {
      const seen: string[] = [];
      (globalThis as unknown as { __moeSteps: string[] }).__moeSteps = seen;
      new MutationObserver(() => {
        for (const node of document.querySelectorAll("[data-testid^=\"cr.activate.step.\"]")) {
          const id = node.getAttribute("data-testid") ?? "";
          const ok = node.getAttribute("data-ok") ?? "";
          const line = `${id}=${ok}`;
          if (!seen.includes(line)) seen.push(line);
        }
      }).observe(document.body, { attributes: true, childList: true, subtree: true });
    });

    // ONE CLICK. The card guards re-entry on a ref rather than the `busy` state, so a second
    // click in the same batch cannot race the same aggregate version.
    await page.getByTestId("cr.activate.button").click();

    // EVERY CHAIN STEP RECORDS, and each one is asserted OK by its own kind rather than by a
    // count — a count would pass with four refusals.
    //
    // `data-ok` ALONE IS NOT ENOUGH, and the reason is in the card: StepRow sets
    // `ok = done || step.outcome.ok`, where `done` is the ALREADY_COMMITTED state
    // (activation-screen.tsx:96-97). So a chain that committed NOTHING because every command
    // was already committed renders `data-ok="true"` on every row. On this lane the store is
    // empty and the refusal above proves nothing was committed before the click, but an arm
    // that cannot tell "accepted" from "already done" would stop proving that the moment the
    // lane's seed mode changed. The word the card renders is the discriminator, so assert it.
    for (const kind of ACTIVATION_CHAIN_KINDS) {
      const step = page.getByTestId(`cr.activate.step.${kind}`);
      await expect(step, `chain step ${kind}`).toBeVisible({ timeout: CHAIN_MS });
      await expect(step, `chain step ${kind} accepted`).toHaveAttribute("data-ok", "true");
      await expect(step, `chain step ${kind} committed on THIS click`)
        .toContainText("accepted");
    }

    // THE PROVIDER CLI VERSION IS READ, NOT DECLARED, and it appears only NOW — after the
    // chain committed `provider.probe`. The browser asserts no snapshot at all
    // (live-dispatch-payloads.ts sends `modelSnapshotKind: "UNKNOWN"`), so this line exists
    // only because the DAEMON ran `<agent command> --version` on this host and published what
    // it got back. A semver here cannot have come from a literal in the bundle, and the
    // before/after pairing with the count-0 assertion above is what proves it was measured
    // rather than rendered from something the page already held.
    const version = page.getByTestId("cr.activate.version");
    await expect(version, "the card shows the daemon's provider reading").toBeVisible({ timeout: CHAIN_MS });
    expect(await version.innerText(), "the daemon read a version off the real CLI")
      .toMatch(/^\S+ --version \S+ (?:\d+\.\d+\.\d+\S*|UNKNOWN)$/u);

    // THE POINT OF THE ROW: the SAME draft the daemon just refused now succeeds, with nothing
    // between the two attempts but the Activate click. That pairing is the proof — a create
    // that had only ever succeeded would not show activation was what changed.
    await expect(newGoal).toBeEnabled({ timeout: CHAIN_MS });
    await newGoal.click();

    await expect(page.getByTestId("cr.goals.newgoal.form")).toBeVisible({ timeout: CARD_MS });
    await fillDraft(page, GOAL_TITLE);
    await page.getByTestId("cr.goals.newgoal.create").click();

    // ACCEPTED BY THE DAEMON, asserted on the report the card renders — not on the form
    // closing, which a client-side reset would also produce. The accepted copy is
    // `Goal created: <admitted title>` (live-goal-create.ts:131), NOT the wire's enums: a
    // refusal renders `code @ layer` instead, so the two branches cannot be confused.
    const report = page.getByTestId("cr.goals.newgoal.report");
    await expect(report).toBeVisible({ timeout: CHAIN_MS });
    await expect(report).toHaveText(`Goal created: ${GOAL_TITLE}`);

    const recorded = await page.evaluate(
      () => (globalThis as unknown as { __moeSteps: string[] }).__moeSteps,
    );
    return { recorded, sha: expectedSha };
  });

  expect(outcome.ok, `lane opened${outcome.ok ? "" : `: ${outcome.code} ${outcome.detail}`}`)
    .toBe(true);
  if (!outcome.ok) return;
  // The recorder saw every step land, which is what makes the assertions above non-vacuous.
  expect(outcome.value.recorded.length, "steps observed live by the DOM recorder")
    .toBeGreaterThanOrEqual(ACTIVATION_CHAIN_KINDS.length);
});
