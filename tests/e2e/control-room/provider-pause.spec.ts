import type { ChildProcess } from "node:child_process";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { killTree, survivingPids } from "./daemon-children.js";
import { readWireProtocolVersion, withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";
import {
  LIMIT_LINE,
  clearPause,
  resolveLaneScratch,
  seatDoubleFiles,
  startWrapper,
  wrapperEnv,
} from "./wrapper-lane.js";

/**
 * A PROVIDER LIMIT PAUSES THE REAL FLEET, THE BROWSER SAYS SO, AND CLEARING IT STAFFS AGAIN.
 *
 * WHAT IS REAL HERE. The daemon is `apps/daemon/src/daemon-main.ts` on an ephemeral port. The
 * board is built by the SHIPPED demo seed, not by fixtures. The thing under test is the SHIPPED
 * `apps/daemon/src/orchestrator/agent-wrapper-main.ts` - not a stand-in, not a re-implementation
 * of its loop - staffing the seeded `node.deliver` over the same SQLite store the daemon serves.
 * The browser opens the same dev server every other daemon-backed journey opens and reads the
 * pause through `/health/read`, the same way an operator's tab does.
 *
 * WHAT IS STOOD IN: THE SEAT, AND ONLY THE SEAT. `MOE_AGENT_COMMAND` points at a script that
 * ignores every argument the spawner appends, prints ONE line to stderr and exits 1. That line is
 * `LIMIT_LINE` - the bytes of a claude session-limit fixture captured off a real seat exit, proven
 * byte-identical to its source in `wrapper-lane.test.ts`. No provider can be asked to hit its
 * limit on cue, so the seat is scripted; everything that READS that line is production.
 *
 * WHY THE RESET IS INJECTED RATHER THAN WAITED OUT. The line resolves to the next 12:10am in
 * Asia/Jerusalem, which is hours away, and there is no clock knob in the wrapper to shorten it -
 * adding one would be a production change this row is forbidden to make. So the pause is ended
 * the way an operator ends one: `clearProviderPause` writes a record whose reset is NOW, against
 * the same store, from this process. That IS the supported early-clear recipe, not a test hook.
 */

/** Bounded separately so a hang names the thing that hung, never "the journey timed out". */
const SPAWN_BUDGET_MS = 45_000;
const LIMIT_BUDGET_MS = 20_000;
const HEALTH_BUDGET_MS = 2_000;
const QUIET_WINDOW_MS = 3_000;
const RESTAFF_BUDGET_MS = 15_000;
const PAIRING_BUDGET_MS = 30_000;
/** Bounds every click, because Playwright's own default for an action is "no bound at all". */
const CLICK_BUDGET_MS = 10_000;

const SPAWNED_LINE = /\[wrapper\] (node\.deliver@\S+): SPAWNED/u;
const LIMIT_LOG_LINE = /\[wrapper\] provider limit: claude paused until (\S+)/u;

interface HealthPause {
  readonly lastLine: string;
  readonly provider: string;
  readonly resetAt: string;
  readonly since: string;
  readonly workItemId: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function pauseOf(payload: unknown): HealthPause | null {
  if (!isRecord(payload) || !isRecord(payload["agents"])) return null;
  const paused = payload["agents"]["paused"];
  if (!isRecord(paused)) return null;
  const { lastLine, provider, resetAt, since, workItemId } = paused;
  return typeof lastLine === "string" && typeof provider === "string" && typeof resetAt === "string"
    && typeof since === "string" && typeof workItemId === "string"
    ? { lastLine, provider, resetAt, since, workItemId }
    : null;
}

/**
 * Asks the DAEMON what the browser asks, through the same proxy with the same credentials.
 * Mirrors `daemon-board.spec.ts:70-90`; the protocol version is read from the generated client's
 * committed bridge, because a stale one is answered DISTRIBUTION_MISMATCH at COMPATIBILITY.
 */
async function askHealth(lane: DaemonLane): Promise<unknown> {
  const protocolVersion = await readWireProtocolVersion(lane.repoRoot);
  expect(protocolVersion, "the generated wire protocol version must load").not.toBeNull();
  const response = await fetch(`${lane.baseUrl}/health/read`, {
    body: "{}",
    headers: {
      "content-type": "application/json",
      "x-moe-csrf": lane.csrfToken,
      "x-moe-protocol-version": protocolVersion ?? "",
      "x-moe-session-credential": lane.credential,
    },
    method: "POST",
  });
  expect(response.status, "/health/read must answer 200").toBe(200);
  return await response.json();
}

const countOf = (transcript: string, needle: string): number =>
  transcript.split(needle).length - 1;

/**
 * Staffed seats, counted off the WRAPPER's own staffing line rather than off the bare substring
 * ": SPAWNED". The verifier, publisher and lander all print `<id>: <outcome> (<detail>)` on the
 * same stream, and a detail that quoted the word would inflate this count silently.
 */
const SPAWNED_LINES = /\[wrapper\] \S+: SPAWNED/gu;

const spawnedCount = (transcript: string): number =>
  transcript.match(SPAWNED_LINES)?.length ?? 0;

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => { setTimeout(done, ms); });

/** Polls the daemon until it states a pause, or gives up inside the budget. */
async function awaitHealthPause(lane: DaemonLane): Promise<HealthPause | null> {
  const deadline = Date.now() + HEALTH_BUDGET_MS;
  for (;;) {
    const found = pauseOf(await askHealth(lane));
    if (found !== null) return found;
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

/**
 * COMPLETES THE REAL ONE-TIME PAIRING, because the v2 shell shows a pause only once it is
 * ATTACHED. Measured 2026-09-05: an unpaired tab renders "PROJECT . PAIRING" and the boundary
 * card, and `cr.shell.paused` does not exist at all - so a journey that skipped this would be
 * asserting against a shell that has no daemon, and would have to weaken to nothing.
 *
 * This is the operator's own ritual, not a test hook: the browser shows a label, the person types
 * it into the terminal that launched the daemon (here, the lane's `--operator-stdin` pipe), and
 * presses the button. The click may land before the daemon has read the line, which the app
 * answers with its "Not paired yet" bounce - so the button is pressed again rather than the wait
 * being made longer, exactly as that copy instructs.
 */
async function pairBrowser(page: Page, lane: DaemonLane): Promise<void> {
  const approve = lane.approvePairing;
  expect(approve, "the lane must expose an operator channel").not.toBeNull();
  const output = page.getByLabel("Pairing confirmation label");
  await expect(output).toBeVisible({ timeout: 30_000 });
  const label = (await output.textContent())?.trim() ?? "";
  expect(label, "the browser must be shown a real label").toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u);
  approve?.(label);
  const confirm = page.getByRole("button", { name: "I entered this label" });
  // EVERY CLICK IS BOUNDED. Playwright's default `actionTimeout` is 0, which means an action
  // waits for actionability until the TEST budget is gone - measured 2026-09-05: the card can
  // unmount on its own once the daemon approves the label, and an unbounded click on the button
  // that just disappeared burned a 420 s run to nothing. A missed click here is not a failure:
  // the card is still up, so the loop presses again, which is exactly what its copy tells a
  // person to do.
  const deadline = Date.now() + PAIRING_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await output.count() === 0) return;
    await confirm.click({ timeout: 5_000 }).catch(() => undefined);
    await sleep(1_000);
  }
  await expect(output, "the pairing card must close").toHaveCount(0, { timeout: 10_000 });
}

async function assertBrowserSaysPaused(
  page: Page, lane: DaemonLane, onPhase?: (what: string) => void,
): Promise<void> {
  await page.goto(lane.baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("cr2.shell.root")).toHaveCount(1, { timeout: 30_000 });
  await pairBrowser(page, lane);
  onPhase?.("paired");
  const banner = page.getByTestId("cr.shell.paused");
  // The sentence is spelled here, never built by calling the formatter it is pinning. Only the
  // instant is left to a pattern: `pauseResetWords` renders it in the VIEWER's locale, so a
  // hard-coded rendering would red on a box whose locale differs from this one's.
  await expect(banner).toHaveText(/^Agents paused: claude limit, resumes .+$/u, { timeout: 30_000 });
  // Locale-free and byte-exact: the seat's own last line rides in the title attribute.
  await expect(banner).toHaveAttribute("title", `Last line from the claude seat: ${LIMIT_LINE}`);
  await page.getByTestId("cr.nav.health").click({ timeout: CLICK_BUDGET_MS });
  await expect(page.getByTestId("cr.health.agents"))
    .toHaveText(/^paused: claude limit, resumes .+$/u, { timeout: 30_000 });
  onPhase?.("health-screen-says-it");
}

test("a provider limit parks the real wrapper, the browser says so, and clearing it staffs again",
  async ({ page }) => {
    const tracked: ChildProcess[] = [];
    const evidence: string[] = [];
    const wrapperSurvivors: number[] = [];
    const started = Date.now();
    const mark = (what: string): void => {
      const at = `+${String(Date.now() - started)}ms ${what}`;
      evidence.push(at);
      // eslint-disable-next-line no-console -- phase timing, read from the reporter on a red run.
      console.log(`[provider-pause] ${at}`);
    };
    const outcome = await withDaemonBackedControlRoom(
      { liveCredentials: "ATTACHED", operatorChannel: true, seed: "SHIPPED" },
      async (lane) => {
        const scratch = resolveLaneScratch(lane);
        expect(scratch, "the lane's scratch store must be resolvable").not.toBeNull();
        if (scratch === null) return;
        const item = `node.deliver@${lane.nodeRef}`;
        const { command } = seatDoubleFiles(scratch.root, LIMIT_LINE);
        const wrapper = startWrapper(lane.repoRoot, wrapperEnv(scratch, command), tracked);
        try {
          // 1. THE REAL WRAPPER STAFFS THE SEEDED ITEM.
          const staffed = await wrapper.waitFor(SPAWNED_LINE, SPAWN_BUDGET_MS);
          expect(staffed, `the wrapper must staff ${item}\n${wrapper.transcript().slice(-2000)}`)
            .toBe(item);
          mark("spawned-1");

          // 2. THE SEAT'S EXIT IS READ AS A PROVIDER LIMIT AND THE PROVIDER IS PARKED.
          const resetAt = await wrapper.waitFor(LIMIT_LOG_LINE, LIMIT_BUDGET_MS);
          expect(resetAt, `the limit must park claude\n${wrapper.transcript().slice(-2000)}`)
            .not.toBeNull();
          expect(Number.isNaN(Date.parse(resetAt ?? "")), "the reset must be an instant").toBe(false);
          expect(Date.parse(resetAt ?? ""), "the reset must be ahead of now").toBeGreaterThan(Date.now());
          // The seat really failed, and the wrapper really saw the provider's own bytes.
          expect(wrapper.transcript()).toContain(`${item} agent exited 1`);
          expect(wrapper.transcript()).toContain(LIMIT_LINE);
          mark(`resetAt ${String(resetAt)}`);
          // The line VERBATIM, so the run's record quotes the wrapper rather than a reconstruction.
          mark(/^\[wrapper\] provider limit: .*$/mu.exec(wrapper.transcript())?.[0] ?? "no limit line");

          // 3. THE DAEMON STATES IT WITHIN TWO SECONDS.
          const paused = await awaitHealthPause(lane);
          expect(paused, "/health/read must state the pause").not.toBeNull();
          expect(paused?.provider).toBe("claude");
          expect(paused?.resetAt).toBe(resetAt);
          expect(paused?.lastLine).toBe(LIMIT_LINE);
          expect(paused?.workItemId).toBe(item);

          mark("health-stated");
          // 4. THE BROWSER SAYS IT, on the shell strip and on Health.
          await assertBrowserSaysPaused(page, lane, mark);
          mark("browser-said-it");

          // 5. NOTHING IS STAFFED WHILE THE PROVIDER IS PARKED.
          const before = spawnedCount(wrapper.transcript());
          expect(before, "exactly one seat has been staffed so far").toBe(1);
          await sleep(QUIET_WINDOW_MS);
          expect(spawnedCount(wrapper.transcript()),
            `six passes at 500 ms must staff nothing\n${wrapper.transcript().slice(-2000)}`).toBe(1);
          expect(wrapper.transcript()).toContain(`[wrapper] provider paused: claude until ${resetAt}`);

          // 6. CLEARING THE PAUSE STAFFS THE ITEM AGAIN.
          const cleared = clearPause(scratch.storePath, lane.projectId, "claude");
          expect(cleared.ok, `the clear must commit: ${JSON.stringify(cleared)}`).toBe(true);
          mark(`clear ok=${String(cleared.ok)}`);
          const deadline = Date.now() + RESTAFF_BUDGET_MS;
          while (spawnedCount(wrapper.transcript()) < 2 && Date.now() < deadline) {
            await sleep(250);
          }
          expect(spawnedCount(wrapper.transcript()),
            `the item must be staffed again\n${wrapper.transcript().slice(-2000)}`)
            .toBeGreaterThanOrEqual(2);
          mark("spawned-2");
          // The second seat hits the same limit, so the fleet parks again: proof the clear let a
          // real seat RUN rather than merely emptying a row. The banner is therefore NOT asserted
          // to disappear - it would be a race against the wrapper's own next pause.
          await wrapper.waitFor(/\[wrapper\] provider limit: claude paused until \S+[\s\S]*?\[wrapper\] provider limit: claude paused until (\S+)/u, RESTAFF_BUDGET_MS);
          expect(countOf(wrapper.transcript(), "[wrapper] provider limit: claude paused until"),
            "the second seat must be classified as a limit too").toBeGreaterThanOrEqual(2);
        } finally {
          // 7. THE WRAPPER TREE IS KILLED BEFORE THE LANE TEARS THE DAEMON DOWN.
          //
          // NOTHING IS ASSERTED IN HERE. An `expect` that throws inside `finally` REPLACES the
          // exception the body raised, so a teardown complaint would erase the failure a person
          // actually needs to read. The survivors are recorded and judged below, after the body's
          // own outcome has had its say.
          const pid = wrapper.child.pid;
          await killTree(wrapper.child);
          if (pid !== undefined) {
            wrapperSurvivors.push(...await survivingPids([pid]));
            mark(`wrapperPid ${String(pid)}`);
          }
          mark(`daemonPid ${String(lane.daemonPid)} seedPid ${String(lane.seedPid)}`);
        }
      },
    );
    // eslint-disable-next-line no-console -- the run's own evidence line, quoted into the record.
    console.log(`[provider-pause] ${evidence.join(" | ")}`);
    // The lane's own outcome FIRST: a run that refused before the body, or that left the daemon
    // or the dev server behind, must never be read through a teardown complaint about the wrapper.
    expect(outcome.ok ? "ok" : `${outcome.code}: ${outcome.detail}`).toBe("ok");
    expect(wrapperSurvivors, "the wrapper tree must be gone before the lane tears down").toEqual([]);
    const survivors = await survivingPids(
      tracked.flatMap((child) => (child.pid === undefined ? [] : [child.pid])),
    );
    expect(survivors, "teardown must leave no wrapper behind").toEqual([]);
  });
