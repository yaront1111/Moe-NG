import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { expect, test } from "@playwright/test";

import { killTree, spawnNode, survivingPids } from "./daemon-children.js";
import { LANE_CSRF_TOKEN, createLaneScratch, daemonEnv, repoRoot, seedEnv } from "./daemon-scratch.js";
import type { LaneScratch } from "./daemon-scratch.js";

/**
 * task-965cb2d6 (P1.7): PRD selection is BROWSER-LOCAL, never durable authority.
 *
 * WHAT THIS PROVES that no unit test can: dropping a PRD into the real new-goal
 * form, against a REAL daemon over a REAL SQLite store, appends NOTHING durable
 * - no DocumentSourceTextRecorded, no work proposal, no brief, no goal - and
 * Cancel leaves the ledger byte-identical too. The bytes reach the daemon only
 * inside `goal.create`, when the operator clicks Create.
 *
 * WHY THE BUILT BUNDLE, NOT THE VITE DEV LANE of `daemon-ports.ts`. The dev
 * server externalizes `node:crypto`, which `@moe/control-room-client`'s root
 * barrel pulls in through `contract-digest.ts`; the v2 goals screen value-imports
 * that barrel, so the module graph throws before React mounts and NO assertion
 * here could run. Rollup tree-shakes the unused digest module, so the shipped
 * artifact loads. That is a real production-boundary defect, owned by
 * task-8aae7ea8 - this spec drives the SHIPPED bundle, which is strictly more
 * production-faithful than the dev graph, rather than waiting on it.
 *
 * THE ZERO-WRITE ASSERTION IS ONLY AS GOOD AS ITS COUNTER, so the lane seeds a
 * real chain first: every arm asserts zero NEW rows on top of a NONZERO
 * baseline, and an explicit reachability control pins that the snapshot observes
 * the very store this journey writes to.
 */

const DAEMON_READY_MS = 60_000;
const SEED_MS = 90_000;
const BUILD_MS = 180_000;
const ORIGIN_LINE = /listening on (http:\/\/127\.0\.0\.1:\d+)/u;
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;

const PRD_NAME = "local-only-prd.md";
const PRD_TEXT = "# Local-only PRD\n\nNo durable authority before Create.\n";
const PRD_SHA256 = createHash("sha256").update(PRD_TEXT, "utf8").digest("hex");
const SNAPSHOT_LIMIT = 1_000;

/**
 * A durable write dispatched from a click is ASYNCHRONOUS, so snapshotting the
 * instant the click returns can miss one still in flight and read as a false
 * "zero". Drill D2 proved this is not theoretical: with Cancel mutated to write,
 * the row counts had not yet materialised and only the event horizon had moved.
 * The arms must be able to SEE a premature write, not merely outrun it, so every
 * zero-write snapshot settles first.
 */
const WRITE_SETTLE_MS = 2_000;

/**
 * Copy quoted VERBATIM from the production component, not paraphrased, and NOT
 * imported from the module under test - importing it would be a fixed point that
 * a hardcoded-return mutant satisfies. Asserted positively: a `not.toContain` on
 * some forbidden word would test one spelling and would not be the fence it looks
 * like. This sentence is the transmission-timing PROMISE the arms below hold the
 * store to.
 */
const PRD_HINT = "Drop a PRD to attach it to this goal. It is read in this browser only; "
  + "nothing is sent until you click Create goal.";

/** Over PRD_FILE_PREFLIGHT_MAX_BYTES (128 KiB), so the browser refuses it locally. */
const OVERSIZE_PRD_TEXT = "x".repeat(130 * 1_024);
/** Over GOAL_BRIEF_LIMITS.maxTitleUtf8Bytes (1024) but under the input's 2048 cap. */
const OVERLONG_TITLE = "T".repeat(1_100);
const GOOD_TITLE = "Persistence boundary goal";
const GOOD_OUTCOME = "Selecting a PRD writes nothing until Create.";

/** Resolves the child's exit code, or null once `ms` is spent. */
const awaitExit = (child: ChildProcess, ms: number): Promise<number | null> =>
  new Promise((done) => {
    const timer = setTimeout(() => { done(null); }, ms);
    child.once("exit", (code) => { clearTimeout(timer); done(code); });
  });

interface LedgerSnapshot {
  readonly aggregateIds: readonly string[];
  readonly briefRows: number;
  readonly decisionRows: number;
  readonly documentSourceRows: number;
  readonly eventRows: number;
  readonly goalRows: number;
  readonly horizon: string;
  readonly proposalRows: number;
}

/** True when a GoalCreated payload carries a `brief` member. */
function carriesBrief(payload: Uint8Array): boolean {
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(payload));
    return Array.isArray(decoded)
      && decoded.some((fact) => fact !== null && typeof fact === "object"
        && !Array.isArray(fact) && Object.hasOwn(fact, "brief"));
  } catch {
    return false;
  }
}

/** The `instructions` prose of the newest GoalCreated fact, or null if none. */
function newestGoalInstructions(scratch: LaneScratch): string | null {
  const store = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
  try {
    const events = store.readEventsAfter(0n, SNAPSHOT_LIMIT);
    const goals = events.items.filter((event) => event.eventType === "GoalCreated");
    const newest = goals.at(-1);
    if (newest === undefined) return null;
    const decoded: unknown = JSON.parse(new TextDecoder().decode(newest.payload));
    if (!Array.isArray(decoded)) return null;
    for (const fact of decoded) {
      if (fact === null || typeof fact !== "object" || Array.isArray(fact)) continue;
      const brief: unknown = (fact as Record<string, unknown>)["brief"];
      if (brief === null || typeof brief !== "object" || Array.isArray(brief)) continue;
      const instructions: unknown = (brief as Record<string, unknown>)["instructions"];
      if (typeof instructions === "string") return instructions;
    }
    return null;
  } finally {
    store.close();
  }
}

/**
 * Reads the lane's REAL store. Counts come from the ledger itself, never from a
 * UI status string, and a truncated page throws rather than under-reporting a
 * write - a snapshot that silently caps would make every arm vacuous.
 */
function ledgerSnapshot(scratch: LaneScratch): LedgerSnapshot {
  const store = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
  try {
    const events = store.readEventsAfter(0n, SNAPSHOT_LIMIT);
    const decisions = store.readCommandDecisionsAfter(0n, SNAPSHOT_LIMIT);
    if (events.hasMore || decisions.hasMore) {
      throw new Error(`E2E_LEDGER_SNAPSHOT_TRUNCATED: limit=${String(SNAPSHOT_LIMIT)}`);
    }
    const goals = events.items.filter((event) => event.eventType === "GoalCreated");
    return Object.freeze({
      aggregateIds: Object.freeze(
        [...new Set(events.items.map((event) => event.aggregateId))].sort(),
      ),
      briefRows: goals.filter((event) => carriesBrief(event.payload)).length,
      decisionRows: decisions.items.length,
      documentSourceRows: events.items.filter(
        (event) => event.eventType === "DocumentSourceTextRecorded",
      ).length,
      eventRows: events.items.length,
      goalRows: goals.length,
      horizon: String(store.readEventHorizon()),
      proposalRows: events.items.filter(
        (event) => event.eventType === "DocumentWorkProposalRecorded",
      ).length,
    });
  } finally {
    store.close();
  }
}

/** Every counted dimension must be byte-identical, with the denominator named. */
function expectNoDurableWrite(
  before: LedgerSnapshot,
  after: LedgerSnapshot,
  arm: string,
): void {
  expect(
    after,
    `${arm}: expected 0 NEW rows on top of ${String(before.eventRows)} events / `
      + `${String(before.decisionRows)} decisions / ${String(before.goalRows)} goals`,
  ).toEqual(before);
}

test("task-965cb2d6: a PRD is browser-local until Create, and refusals write nothing", async ({ page }) => {
  const root = repoRoot();
  expect(root, "repo root (package.json + pnpm-workspace.yaml)").not.toBeNull();
  if (root === null) return;

  const dist = join(root, "apps", "control-room", "dist");
  const scratch = createLaneScratch();
  const children: ChildProcess[] = [];
  const pids: number[] = [];
  try {
    // 1. Build the bundle the daemon hosts, with no baked live credential.
    const build = spawnNode(
      [join(root, "apps", "control-room", "node_modules", "vite", "bin", "vite.js"), "build"],
      join(root, "apps", "control-room"),
      { ...process.env, VITE_MOE_LIVE_CREDENTIAL: undefined, VITE_MOE_LIVE_CSRF: undefined },
    );
    children.push(build.child);
    expect(await awaitExit(build.child, BUILD_MS), `vite build:\n${build.transcript().slice(-800)}`)
      .toBe(0);
    expect(existsSync(join(dist, "index.html")), "the build must emit index.html").toBe(true);

    // 2. Daemon on an ephemeral port, hosting the bundle, operator pipe on stdin.
    const daemon = spawnNode([
      "--experimental-transform-types",
      join(root, "apps", "daemon", "src", "daemon-main.ts"),
      `--dependencies=${join(root, "apps", "daemon", "src", "daemon-store-dependencies.ts")}`,
      "--port=0",
      `--csrf-token=${LANE_CSRF_TOKEN}`,
      `--asset-root=${dist}`,
      "--operator-stdin",
    ], root, daemonEnv(scratch, "SPEED"));
    children.push(daemon.child);
    if (daemon.child.pid !== undefined) pids.push(daemon.child.pid);
    const origin = await daemon.waitFor(ORIGIN_LINE, DAEMON_READY_MS);
    expect(origin, `daemon origin:\n${daemon.transcript().slice(-800)}`)
      .toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

    // 3. Seed a real chain. This is what makes the zero-write arms non-vacuous:
    //    the baseline is NONZERO, so an always-empty counter cannot pass them.
    const seed = spawnNode([
      "--experimental-transform-types",
      join(root, "apps", "daemon", "src", "orchestrator", "demo-seed-main.ts"),
    ], root, seedEnv(scratch, origin as string, "SPEED"));
    children.push(seed.child);
    expect(await awaitExit(seed.child, SEED_MS), `demo seed:\n${seed.transcript().slice(-1000)}`)
      .toBe(0);

    // 4. Pair through the real runtime handshake: the browser renders only its
    //    bounded label, the foreground operator echoes it over the private pipe.
    const runtimeFailure = new Promise<never>((_resolve, reject) => {
      page.on("pageerror", (error: Error) => {
        reject(new Error(`E2E_CONTROL_ROOM_RUNTIME_ERROR: ${error.message}`));
      });
    });
    const labelOutput = page.getByLabel("Pairing confirmation label");
    await Promise.race([
      page.goto(`${origin as string}/`, { waitUntil: "domcontentloaded" })
        .then(async () => { await expect(labelOutput).toBeVisible({ timeout: 20_000 }); }),
      runtimeFailure,
    ]);
    const confirmationLabel = (await labelOutput.textContent())?.trim() ?? "";
    expect(confirmationLabel).toMatch(CONFIRMATION_LABEL);
    expect(daemon.child.stdin, "the explicit operator pipe must exist").not.toBeNull();
    daemon.child.stdin?.write(`${confirmationLabel}\n`);
    await page.getByRole("button", { name: "I entered this label" }).click();
    await expect(page.getByTestId("cr.goals.home")).toBeVisible({ timeout: 60_000 });

    // ARM 0 - COUNTER REACHABILITY. The snapshot must observe the store this
    // lane actually wrote: the seeded aggregate has to be in it, and the ledger
    // has to be non-empty. Without this, "no new rows" could be read off a store
    // nothing ever writes to and would hold forever.
    const baseline = ledgerSnapshot(scratch);
    expect(baseline.eventRows, "ARM 0: the seeded baseline must be non-empty")
      .toBeGreaterThan(0);
    expect(baseline.decisionRows, "ARM 0: the seed must have committed decisions")
      .toBeGreaterThan(0);
    // The project id is derived from this run's random scratch tag, so finding it
    // proves the snapshot is reading THIS lane's store rather than a shared or
    // stale one. `goal-live-1` is a fixed seed name and could not tell those apart.
    expect(
      baseline.aggregateIds,
      "ARM 0: the snapshot must observe this lane's own uniquely-tagged aggregate",
    ).toContain(scratch.projectId);
    expect(
      baseline.goalRows,
      "ARM 0: the GoalCreated counter the arms rely on must itself be reachable",
    ).toBeGreaterThan(0);

    // ARM 1 - SELECT. Reading a PRD is local: the digest appears in the page and
    // the ledger does not move.
    await page.getByTestId("cr.goals.new").click();
    await expect(page.getByTestId("cr.goals.newgoal.form")).toBeVisible();

    // ARM 3 - COPY STATES THE TRANSMISSION TIMING, before anything is selected.
    // The arms below hold the store to exactly this promise.
    await expect(
      page.getByTestId("cr.goals.newgoal.prd"),
      "ARM 3: the pre-Create copy must promise that nothing is sent until Create",
    ).toContainText(PRD_HINT);

    await page.getByTestId("cr.goals.newgoal.prd.input").setInputFiles({
      buffer: Buffer.from(PRD_TEXT, "utf8"),
      mimeType: "text/markdown",
      name: PRD_NAME,
    });
    await expect(
      page.getByTestId("cr.goals.newgoal.prd.status"),
      "ARM 1: the selection must stay usable locally, digested in this browser",
    ).toHaveText(`Read in this browser - sha256 ${PRD_SHA256}`);
    await expect(page.getByTestId("cr.goals.newgoal.prd.file")).toContainText(PRD_NAME);
    await page.waitForTimeout(WRITE_SETTLE_MS);
    expectNoDurableWrite(baseline, ledgerSnapshot(scratch), "ARM 1 select");

    // The ledger proves nothing was PERSISTED. This proves nothing was even
    // TRANSMITTED: neither the PRD's bytes nor its digest nor its filename has
    // reached the daemon at all, so "nothing is sent until you click Create goal"
    // is checked at the wire, not only at the store.
    expect(daemon.transcript(), "ARM 1: no PRD content may reach the daemon on select")
      .not.toContain(PRD_SHA256);
    expect(daemon.transcript(), "ARM 1: no PRD filename may reach the daemon on select")
      .not.toContain(PRD_NAME);

    // ARM 2 - CANCEL. No compensating deletion is needed because nothing was
    // ever written; the ledger is still byte-identical to the baseline.
    await page.getByTestId("cr.goals.newgoal.cancel").click();
    await expect(page.getByTestId("cr.goals.newgoal.form")).toHaveCount(0);
    await page.waitForTimeout(WRITE_SETTLE_MS);
    expectNoDurableWrite(baseline, ledgerSnapshot(scratch), "ARM 2 Cancel");

    // ARM 4 - A LOCAL REFUSAL IS REPORTED AT ITS OWN LAYER and still writes
    // nothing. The status region reports only what THIS PAGE did, so the code and
    // the refusing layer are both pinned, never merely "it refused".
    await page.getByTestId("cr.goals.new").click();
    await expect(page.getByTestId("cr.goals.newgoal.form")).toBeVisible();
    await page.getByTestId("cr.goals.newgoal.prd.input").setInputFiles({
      buffer: Buffer.from(OVERSIZE_PRD_TEXT, "utf8"),
      mimeType: "text/markdown",
      name: "too-big-prd.md",
    });
    await expect(
      page.getByTestId("cr.goals.newgoal.prd.status"),
      "ARM 4: an oversized PRD is refused in the browser, at the browser's layer",
    ).toHaveText("Error - PRD_FILE_TOO_LARGE @ CONTROL_ROOM_NEWGOAL");
    await page.waitForTimeout(WRITE_SETTLE_MS);
    expectNoDurableWrite(baseline, ledgerSnapshot(scratch), "ARM 4 oversized PRD");

    // ARM 5 - A CONTRACT REFUSAL LEAVES THE DRAFT EXACTLY AS TYPED and sends
    // nothing. The title is over the brief contract's 1024-byte bound but under
    // the input's own 2048 cap, so the form does NOT truncate it - the refusal is
    // surfaced instead of hidden.
    await page.getByTestId("cr.goals.newgoal.title").fill(OVERLONG_TITLE);
    await page.getByTestId("cr.goals.newgoal.outcome").fill(GOOD_OUTCOME);
    await page.getByTestId("cr.goals.newgoal.create").click();
    await expect(
      page.getByTestId("cr.goals.newgoal.report"),
      "ARM 5: the exact stable code AND the refusing layer",
    ).toHaveText("GOAL_BRIEF_INPUT_INVALID @ GOAL_BRIEF_CONTRACT");
    await expect(page.getByTestId("cr.goals.newgoal.title")).toHaveValue(OVERLONG_TITLE);
    await expect(page.getByTestId("cr.goals.newgoal.outcome")).toHaveValue(GOOD_OUTCOME);
    await page.waitForTimeout(WRITE_SETTLE_MS);
    expectNoDurableWrite(baseline, ledgerSnapshot(scratch), "ARM 5 contract refusal");

    // ARM 6 - CREATE IS THE MOMENT OF TRANSMISSION. Everything above held the
    // ledger at the baseline through selection, cancel and two refusals; the
    // click is what finally writes. That transition is what makes ARM 3's copy
    // TRUE rather than merely present, and it is asserted against the store.
    await page.getByTestId("cr.goals.newgoal.title").fill(GOOD_TITLE);
    await page.getByTestId("cr.goals.newgoal.prd.input").setInputFiles({
      buffer: Buffer.from(PRD_TEXT, "utf8"),
      mimeType: "text/markdown",
      name: PRD_NAME,
    });
    await expect(page.getByTestId("cr.goals.newgoal.prd.status"))
      .toHaveText(`Read in this browser - sha256 ${PRD_SHA256}`);
    await page.waitForTimeout(WRITE_SETTLE_MS);
    expectNoDurableWrite(baseline, ledgerSnapshot(scratch), "ARM 6 pre-Create");

    await page.getByTestId("cr.goals.newgoal.create").click();
    await expect(page.getByTestId("cr.goals.newgoal.report")).not.toHaveText("", { timeout: 20_000 });
    await page.waitForTimeout(WRITE_SETTLE_MS);
    const created = ledgerSnapshot(scratch);
    expect(
      created.goalRows,
      `ARM 6: Create must add EXACTLY one goal to the baseline's ${String(baseline.goalRows)}`,
    ).toBe(baseline.goalRows + 1);

    // The PRD contributes ONE advisory line to the composed brief - it is not an
    // ingest receipt, and it is not repeated.
    const instructions = newestGoalInstructions(scratch);
    expect(instructions, "ARM 6: the new goal must carry a brief").not.toBeNull();
    const advisory = `PRD: ${PRD_NAME} (${String(Buffer.byteLength(PRD_TEXT, "utf8"))} bytes) `
      + `sha256 ${PRD_SHA256}`;
    expect(
      (instructions ?? "").split(advisory).length - 1,
      "ARM 6: the advisory PRD line appears exactly once in the composed brief",
    ).toBe(1);
  } finally {
    for (const child of [...children].reverse()) await killTree(child);
    try {
      rmSync(scratch.root, { force: true, recursive: true });
    } catch {
      // A scratch dir that outlives its run is a few hundred KB in TEMP, never a fail.
    }
  }
  expect(await survivingPids(pids), "the lane must leave no orphan daemon").toEqual([]);
});
