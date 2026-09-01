import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Request } from "@playwright/test";

import { killTree, spawnNode, survivingPids } from "./daemon-children.js";
import {
  LANE_CREDENTIAL, LANE_CSRF_TOKEN, createLaneScratch, daemonEnv, repoRoot, seedEnv,
} from "./daemon-scratch.js";
import {
  eventsCommittedAfter, readGoalCatalogOverHttp, readSourceThroughProduction,
} from "./prd-boundary-readers.js";
import {
  SNAPSHOT_LIMIT, expectNoDurableWrite, ledgerSnapshot, newestGoalInstructions,
} from "./prd-persistence-ledger.js";

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

/**
 * A SECOND, distinct PRD for the atomic-bind arms. Distinct on purpose: the
 * document-source aggregate is content-addressed, so re-sending ARM 6's PRD
 * takes `goalDocumentBindingLegs`' read-only FENCE branch and appends no source
 * row at all. The APPEND branch is the one whose atomicity is in question, and
 * only a content address the store has never seen reaches it.
 */
const BIND_PRD_NAME = "atomically-bound-prd.md";
const BIND_PRD_TEXT = "# Bound PRD\n\nThis document and its goal commit together.\n";
const BIND_PRD_SHA256 = createHash("sha256").update(BIND_PRD_TEXT, "utf8").digest("hex");
const BIND_TITLE = "Atomically bound goal";

/**
 * Text the BROWSER admits and the DAEMON refuses, which is what makes the
 * daemon's fence the only mechanism that can produce ARM 9's red.
 * `admitGoalSource` requires a non-empty well-formed string and nothing more, so
 * a decomposed "e" + U+0301 passes both client admissions; the daemon's
 * `isCanonicalText` additionally demands NFC, so it refuses at its own layer
 * with its own code. Loosening either fence changes WHICH code appears, not
 * merely whether something refused.
 */
const NON_NFC_PRD_TEXT = "# Decomposed\n\ncafe\u0301 is not NFC.\n";
const NON_NFC_PRD_SHA256 = createHash("sha256").update(NON_NFC_PRD_TEXT, "utf8").digest("hex");
/** The empty PRD the BROWSER's own source contract refuses, at a different layer. */
const EMPTY_PRD_SHA256 = createHash("sha256").update("", "utf8").digest("hex");

/**
 * Transport framing the replay must NOT copy. `host`, `connection` and
 * `content-length` describe the browser's own socket, not the command's
 * identity, and Node's fetch derives them itself; HTTP/2 pseudo-headers are not
 * settable at all. Everything that carries authority - the credential, the CSRF
 * token, the protocol version, the content type - is replayed verbatim.
 */
const FRAMING_HEADERS = Object.freeze([
  "accept-encoding", "connection", "content-length", "host",
]);

/** Resolves the child's exit code, or null once `ms` is spent. */
const awaitExit = (child: ChildProcess, ms: number): Promise<number | null> =>
  new Promise((done) => {
    const timer = setTimeout(() => { done(null); }, ms);
    child.once("exit", (code) => { clearTimeout(timer); done(code); });
  });


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

    // ARM 7 - ATOMIC BIND (DoD-3). A Create carrying a PRD commits the
    // GoalCreated AND the document-source leg inside ONE durable decision, so no
    // half-applied pair - a source with no goal, or a goal citing a source that
    // was never recorded - exists for a compensating delete to have to undo.
    // A SECOND, distinct PRD is used: see BIND_PRD_TEXT.
    const beforeBind = ledgerSnapshot(scratch);
    const bindHorizon = BigInt(beforeBind.horizon);
    const commandPosts: Request[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/command") {
        commandPosts.push(request);
      }
    });

    await page.getByTestId("cr.goals.new").click();
    await expect(page.getByTestId("cr.goals.newgoal.form")).toBeVisible();
    await page.getByTestId("cr.goals.newgoal.title").fill(BIND_TITLE);
    await page.getByTestId("cr.goals.newgoal.outcome").fill(GOOD_OUTCOME);
    await page.getByTestId("cr.goals.newgoal.prd.input").setInputFiles({
      buffer: Buffer.from(BIND_PRD_TEXT, "utf8"),
      mimeType: "text/markdown",
      name: BIND_PRD_NAME,
    });
    await expect(page.getByTestId("cr.goals.newgoal.prd.status"))
      .toHaveText(`Read in this browser - sha256 ${BIND_PRD_SHA256}`);
    await page.getByTestId("cr.goals.newgoal.create").click();
    await expect(page.getByTestId("cr.goals.newgoal.report"))
      .not.toHaveText("", { timeout: 20_000 });

    // ARM 11 - THE OPERATOR'S BANNER IS COPY, NOT THE WIRE'S ENUMS. The accepted
    // report used to render the daemon's `${disposition} ${resultCode}` pair -
    // "DECIDED EFFECTS_COMMITTED" - straight into a status region a human reads.
    // Both halves are asserted: the shape a raw enum pair would have, and the
    // exact sentence the operator must actually get. The literal is written out
    // here rather than imported from the module under test, because importing it
    // would be a fixed point that a hardcoded-return mutant satisfies.
    const createdReport = (await page.getByTestId("cr.goals.newgoal.report").textContent()) ?? "";
    expect(
      createdReport,
      "ARM 11: the accepted banner must not be a raw wire enum pair",
    ).not.toMatch(/^[A-Z_]+ [A-Z_]+$/u);
    await expect(
      page.getByTestId("cr.goals.newgoal.report"),
      "ARM 11: it names, in plain words, WHICH goal now exists",
    ).toHaveText(`Goal created: ${BIND_TITLE}`);
    await page.waitForTimeout(WRITE_SETTLE_MS);

    const bound = ledgerSnapshot(scratch);
    expect(
      bound.decisionRows,
      `ARM 7: the bind commits EXACTLY one decision on top of ${String(beforeBind.decisionRows)}`,
    ).toBe(beforeBind.decisionRows + 1);
    expect(
      bound.goalRows,
      `ARM 7: exactly one new goal on top of ${String(beforeBind.goalRows)}`,
    ).toBe(beforeBind.goalRows + 1);
    expect(
      bound.documentSourceRows,
      `ARM 7: exactly one new source on top of ${String(beforeBind.documentSourceRows)}`,
    ).toBe(beforeBind.documentSourceRows + 1);

    const appended = eventsCommittedAfter(
      scratch.storePath, scratch.projectId, bindHorizon, SNAPSHOT_LIMIT,
    );
    expect(
      [...appended.map((event) => event.eventType)].sort(),
      "ARM 7: the decision appended the goal AND its source leg, and nothing else",
    ).toEqual(["DocumentSourceTextRecorded", "GoalCreated"]);
    // The store stamps a NON-PRIMARY leg receipt as `<canonical>:leg:<index>`
    // (packages/store/src/store-internals.ts:23 names the separator), so the two
    // rows are the SAME decision exactly when the source row reduces to the
    // goal's own receipt. Asserting a set of size one would have been WRONG here
    // and would have hidden the leg structure rather than proving it.
    const goalRow = appended.find((event) => event.eventType === "GoalCreated");
    const sourceRow = appended.find(
      (event) => event.eventType === "DocumentSourceTextRecorded",
    );
    expect(
      goalRow?.commandId.includes(":leg:"),
      "ARM 7: the goal is the PRIMARY leg, carrying the decision's own receipt",
    ).toBe(false);
    expect(
      sourceRow?.commandId.split(":leg:").at(0),
      "ARM 7: the source leg belongs to the SAME decision - one atomic authority boundary",
    ).toBe(goalRow?.commandId);
    expect(
      sourceRow?.commandId,
      "ARM 7: and it is a non-primary leg of that decision, not a decision of its own",
    ).not.toBe(goalRow?.commandId);
    expect(
      goalRow?.commandKind,
      "ARM 7: the REAL UI sent the source-carrying kind, not a brief-only create",
    ).toBe("goal.create_with_source");

    // ARM 7b - VISIBLE THROUGH THE PRODUCTION CATALOG, bound to the PRD this
    // browser read, with every sibling still returned: the source-bound writer
    // shape must neither take the catalog dark nor hide any other row.
    const catalog = await readGoalCatalogOverHttp(
      origin as string, root, LANE_CREDENTIAL, LANE_CSRF_TOKEN,
    );
    expect(
      catalog.outcome,
      `ARM 7b: the production catalog must answer GOALS, not ${JSON.stringify(catalog)}`,
    ).toBe("GOALS");
    if (catalog.outcome !== "GOALS") return;
    expect(
      catalog.goals.length,
      `ARM 7b: every durable goal is returned (${String(bound.goalRows)} GoalCreated rows)`,
    ).toBe(bound.goalRows);
    // The catalog admits BOTH creation kinds: the seeded ordinary goal is still
    // returned and still unbound, and the two source-created goals of this
    // journey each carry a binding. One kind displacing the other would show up
    // here as a shifted split, not merely as a missing row.
    expect(
      catalog.goals.filter((goal) => goal.binding === null).length,
      `ARM 7b: the seeded goal.create row is still returned, unbound (of ${String(catalog.goals.length)})`,
    ).toBe(1);
    expect(
      catalog.goals.filter((goal) => goal.binding !== null).length,
      `ARM 7b: and both source-created goals carry a binding (of ${String(catalog.goals.length)})`,
    ).toBe(2);
    const entry = catalog.goals.find((goal) => goal.goalId === goalRow?.aggregateId);
    expect(entry, "ARM 7b: the source-created goal must be in the catalog").toBeDefined();
    expect(entry?.brief?.title, "ARM 7b: carrying the brief the operator typed").toBe(BIND_TITLE);
    expect(
      entry?.binding?.contentSha256,
      "ARM 7b: and BOUND to the exact PRD this browser digested",
    ).toBe(BIND_PRD_SHA256);
    expect(entry?.binding?.byteLength, "ARM 7b: at the byte length the daemon derived")
      .toBe(Buffer.byteLength(BIND_PRD_TEXT, "utf8"));

    // ARM 7b-UI - THE SAME DAEMON ANSWER IS VISIBLE AS EXPANDED FACTS. The card
    // must carry the brief instructions and every member of the exact binding;
    // none may be recomputed from the browser's earlier file selection. Each row
    // is also pinned to the exact projected GoalCreated witness class so local
    // PRD knowledge cannot masquerade as the durable catalog's provenance.
    if (entry === undefined || entry.brief === null || entry.binding === null) return;
    const boundCard = page.getByTestId(`cr.goals.card.${entry.goalId}`);
    await expect(boundCard, "ARM 7b-UI: the durable source-bound card reaches the live page")
      .toBeVisible({ timeout: 20_000 });
    await boundCard.getByTestId(`cr.goals.card.${entry.goalId}.expand`).click();
    const shownFacts = [
      ["brief.instructions", "Brief instructions", entry.brief.instructions],
      ["binding.byteLength", "PRD byte length", String(entry.binding.byteLength)],
      ["binding.contentSha256", "PRD content SHA-256", entry.binding.contentSha256],
      ["binding.sourceAggregateId", "PRD source aggregate", entry.binding.sourceAggregateId],
      ["binding.sourceRef", "PRD source ref", entry.binding.sourceRef],
    ] as const;
    for (const [suffix, label, value] of shownFacts) {
      const fact = boundCard.getByTestId(
        `cr.fact.${entry.goalId}.catalog.${entry.goalId}.${suffix}`,
      );
      await expect(
        fact.getByTestId("cr.label"),
        `ARM 7b-UI: ${suffix} is shown from the catalog`,
      ).toHaveText(label);
      await expect(
        fact.getByTestId("cr.value"),
        `ARM 7b-UI: ${suffix} preserves its exact value`,
      ).toHaveText(value);
      await expect(
        fact.getByTestId(`cr.chip.${entry.truthClass.toLowerCase()}`),
        `ARM 7b-UI: ${suffix} preserves the durable GoalCreated witness class`,
      ).toHaveAttribute("data-truth-class", entry.truthClass);
    }

    // An ordinary goal has no binding in the daemon answer. Its expanded card
    // therefore has no binding facts at all: absence stays absent instead of
    // being filled from the selected file, the brief, or an identifier pattern.
    const unbound = catalog.goals.find((goal) => goal.binding === null);
    expect(unbound, "ARM 7b-UI: the ordinary seeded goal is the null-binding control")
      .toBeDefined();
    if (unbound === undefined) return;
    const unboundCard = page.getByTestId(`cr.goals.card.${unbound.goalId}`);
    await expect(unboundCard).toBeVisible({ timeout: 20_000 });
    await unboundCard.getByTestId(`cr.goals.card.${unbound.goalId}.expand`).click();
    await expect(unboundCard.getByTestId(`cr.goals.card.${unbound.goalId}.facts`)).toBeVisible();
    await expect(unboundCard.getByTestId(
      `cr.fact.${unbound.goalId}.catalog.${unbound.goalId}.identity`,
    )).toBeVisible();
    await expect(unboundCard.getByTestId(
      `cr.fact.${unbound.goalId}.catalog.${unbound.goalId}.planning-run`,
    )).toBeVisible();
    await expect(
      unboundCard.locator('[data-testid*=".binding."]'),
      "ARM 7b-UI: null binding produces zero source-binding facts",
    ).toHaveCount(0);

    // ARM 7c - THE BOUND SOURCE RESOLVES THROUGH THE DAEMON'S OWN READER, fed
    // only what the catalog returned. Nothing is recomputed here, so a producer
    // and a reader that had drifted apart together are still caught.
    const readBack = await readSourceThroughProduction(
      root, scratch.storePath, scratch.projectId,
      entry?.binding?.contentSha256 ?? "", entry?.binding?.sourceRef ?? "",
    );
    expect(
      readBack.kind,
      `ARM 7c: the daemon's own source reader must resolve it (${JSON.stringify(readBack)})`,
    ).toBe("VIEW");
    if (readBack.kind !== "VIEW") return;
    expect(readBack.view["contentSha256"], "ARM 7c: at the digest the goal cites")
      .toBe(BIND_PRD_SHA256);
    expect(readBack.view["displayPath"], "ARM 7c: under the name the operator dropped")
      .toBe(BIND_PRD_NAME);
    expect(readBack.view["excerpt"], "ARM 7c: carrying the bytes this browser read")
      .toBe(BIND_PRD_TEXT);

    // ARM 8 - AN IDENTICAL REPLAY IS NOT A SECOND WRITE. The browser's own POST
    // is replayed byte for byte; only socket framing is re-derived.
    expect(commandPosts, "ARM 8: the Create made exactly one /command POST").toHaveLength(1);
    const original = commandPosts.at(0);
    const originalBody = original?.postData() ?? null;
    expect(originalBody, "ARM 8: the captured command must carry its body").not.toBeNull();
    if (original === undefined || originalBody === null) return;
    const replayHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(await original.allHeaders())) {
      if (name.startsWith(":") || FRAMING_HEADERS.includes(name.toLowerCase())) continue;
      replayHeaders[name] = value;
    }
    const replayed = await fetch(original.url(), {
      body: originalBody, headers: replayHeaders, method: "POST",
    });
    expect(replayed.status, "ARM 8: the replay must be answered, not dropped").toBe(200);
    await page.waitForTimeout(WRITE_SETTLE_MS);
    const afterReplay = ledgerSnapshot(scratch);
    expect(
      afterReplay.eventRows,
      `ARM 8: an identical replay adds ZERO events on top of ${String(bound.eventRows)}`,
    ).toBe(bound.eventRows);
    expect(
      afterReplay.decisionRows,
      `ARM 8: and ZERO decisions on top of ${String(bound.decisionRows)}`,
    ).toBe(bound.decisionRows);

    // ARM 9 - A DAEMON-LAYER LIFECYCLE REFUSAL LEAVES NEITHER ROW. The text is
    // one the browser's OWN source contract admits (non-empty, well-formed), so
    // the daemon's canonical-text fence is the only mechanism that can produce
    // this red. Loosening either fence changes WHICH code appears, not merely
    // whether something refused - which is what ARM 10 pins.
    const beforeDaemonRefusal = ledgerSnapshot(scratch);
    await page.getByTestId("cr.goals.new").click();
    await expect(page.getByTestId("cr.goals.newgoal.form")).toBeVisible();
    await page.getByTestId("cr.goals.newgoal.title").fill(GOOD_TITLE);
    await page.getByTestId("cr.goals.newgoal.outcome").fill(GOOD_OUTCOME);
    await page.getByTestId("cr.goals.newgoal.prd.input").setInputFiles({
      buffer: Buffer.from(NON_NFC_PRD_TEXT, "utf8"),
      mimeType: "text/markdown",
      name: "decomposed-prd.md",
    });
    await expect(page.getByTestId("cr.goals.newgoal.prd.status"))
      .toHaveText(`Read in this browser - sha256 ${NON_NFC_PRD_SHA256}`);
    await page.getByTestId("cr.goals.newgoal.create").click();
    await expect(
      page.getByTestId("cr.goals.newgoal.report"),
      "ARM 9: the exact stable code AND the refusing layer, as the daemon issued them",
    ).toHaveText("DOCUMENT_WORK_INGEST_PAYLOAD_INVALID @ DAEMON_INGRESS");
    // The component promises a refusal "at any layer" leaves every field exactly
    // as typed. ARM 5 held it at the brief-contract layer; this holds it at the
    // DAEMON's, where a round trip has been made and could plausibly have reset
    // the form. The selection survives too - the operator need not re-drop it.
    await expect(page.getByTestId("cr.goals.newgoal.title")).toHaveValue(GOOD_TITLE);
    await expect(page.getByTestId("cr.goals.newgoal.outcome")).toHaveValue(GOOD_OUTCOME);
    await expect(page.getByTestId("cr.goals.newgoal.prd.file")).toContainText("decomposed-prd.md");
    await page.waitForTimeout(WRITE_SETTLE_MS);
    const afterDaemonRefusal = ledgerSnapshot(scratch);
    expect(
      afterDaemonRefusal.documentSourceRows,
      `ARM 9: no orphan source - still ${String(beforeDaemonRefusal.documentSourceRows)}`,
    ).toBe(beforeDaemonRefusal.documentSourceRows);
    expect(
      afterDaemonRefusal.goalRows,
      `ARM 9: no orphan goal - still ${String(beforeDaemonRefusal.goalRows)}`,
    ).toBe(beforeDaemonRefusal.goalRows);
    expect(
      afterDaemonRefusal.eventRows,
      `ARM 9: no durable event at all - still ${String(beforeDaemonRefusal.eventRows)}`,
    ).toBe(beforeDaemonRefusal.eventRows);

    // ARM 10 - THE BROWSER'S OWN SOURCE CONTRACT REFUSES AT A DIFFERENT LAYER,
    // which is what proves ARM 9 was the DAEMON answering rather than "the
    // system" refusing. Replacing the live selection also covers the
    // select-then-replace path.
    await page.getByTestId("cr.goals.newgoal.prd.input").setInputFiles({
      buffer: Buffer.from("", "utf8"), mimeType: "text/markdown", name: "empty-prd.md",
    });
    await expect(page.getByTestId("cr.goals.newgoal.prd.status"))
      .toHaveText(`Read in this browser - sha256 ${EMPTY_PRD_SHA256}`);
    await page.getByTestId("cr.goals.newgoal.create").click();
    await expect(
      page.getByTestId("cr.goals.newgoal.report"),
      "ARM 10: the BROWSER's source contract, named at its own layer",
    ).toHaveText("GOAL_SOURCE_INPUT_INVALID @ GOAL_SOURCE_CONTRACT");
    await expect(page.getByTestId("cr.goals.newgoal.form")).toHaveCount(1);
    await expect(page.getByTestId("cr.goals.newgoal.title")).toHaveValue(GOOD_TITLE);
    await expect(page.getByTestId("cr.goals.newgoal.outcome")).toHaveValue(GOOD_OUTCOME);
    await page.waitForTimeout(WRITE_SETTLE_MS);
    expectNoDurableWrite(afterDaemonRefusal, ledgerSnapshot(scratch), "ARM 10 empty PRD");
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
