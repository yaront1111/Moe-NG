import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { WIRE_PROTOCOL_VERSION } from "../../../apps/daemon/src/http/http-contract.js";
import { killTree, spawnNode, survivingPids } from "./daemon-children.js";
import {
  LANE_CREDENTIAL, LANE_CSRF_TOKEN, createLaneScratch, daemonEnv, repoRoot, seedEnv,
} from "./daemon-ports.js";
import { readGoalCatalogOverHttp } from "./prd-boundary-readers.js";

/**
 * THE OPERATOR READS THE DESIGN AND KNOWS WHICH VERSION THE PLAN WAS BUILT ON.
 *
 * Journey, on a REAL daemon: the operator creates a goal from a PRD, a planner proposes the
 * Gate 1 revision, the human approves it in the browser, a SCRIPTED SEAT submits a design
 * revision against that approved contract, and the operator reads it back on the goal.
 *
 * Gate 1 is not decoration here. `design.submit` refuses DESIGN_CONTRACT_NOT_APPROVED unless
 * the goal already carries an APPROVED product-contract revision, so the journey has to pass
 * through the approval to reach the thing this row is about. The contract ref is READ off
 * `/product-contract/pending/read` rather than spelled, because its `revisionDigest` is the
 * daemon's own and a hand-written one would refuse.
 *
 * Every offer is read off the affordance surface and dispatched on `/command` -- the same
 * pattern gate1-v1-approval.spec.ts uses -- so the spec never invents an aggregate id.
 */

const DAEMON_READY_MS = 60_000;
const SEED_MS = 90_000;
const BUILD_MS = 180_000;
const ORIGIN_LINE = /listening on (http:\/\/127\.0\.0\.1:\d+)/u;
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;

const PRD_TEXT = "# Item shelf\n\nAn operator signs in and reads a shelf of items.\n";
const PRD_SHA256 = createHash("sha256").update(PRD_TEXT, "utf8").digest("hex");
const BARE_PRD_TEXT = "# Bare goal\n\nThis goal is planned without a design.\n";
const BARE_PRD_SHA256 = createHash("sha256").update(BARE_PRD_TEXT, "utf8").digest("hex");

const REQUIREMENT = "The operator signs in and reads the item shelf.";
const CRITERION = "Given a signed-in operator, the shelf lists every item they own.";

/** Distinct per version, so "the tab shows the newer one" is a claim about CONTENT. */
const ENTITY_V1 = "ShelfItemV1Marker";
const ENTITY_V2 = "ShelfItemV2Marker";

/** The scopes every compiled node carries; copied from plan-reject-replan.spec.ts. */
const NODE_SCOPES = Object.freeze({
  capability: "capability-implement",
  readScopes: ["services/api/src"],
  resources: ["resource-a"],
  verificationRecipeRefs: ["recipe-a"],
  writeScopes: ["services/api/src/node"],
});

interface DaemonAnswer {
  readonly body: unknown;
  readonly status: number;
  readonly text: string;
}

async function askDaemon(origin: string, path: string, body: unknown): Promise<DaemonAnswer> {
  const response = await fetch(`${origin}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin,
      "x-moe-csrf": LANE_CSRF_TOKEN,
      "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
      "x-moe-session-credential": LANE_CREDENTIAL,
    },
    method: "POST",
  });
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* raw text stays in `text` */ }
  return { body: parsed, status: response.status, text };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const awaitExit = (child: ChildProcess, ms: number): Promise<number | null> =>
  new Promise((done) => {
    const timer = setTimeout(() => { done(null); }, ms);
    child.once("exit", (code) => { clearTimeout(timer); done(code); });
  });

/** The daemon's own offer for a kind on a subject, never an id this spec spelled. */
async function offerFor(
  origin: string, commandKind: string, matches: (target: string) => boolean,
): Promise<Readonly<Record<string, unknown>> | null> {
  const surface = await askDaemon(origin, "/affordances/read", {});
  expect(surface.status, `affordance surface:\n${surface.text.slice(0, 600)}`).toBe(200);
  const offers = isRecord(surface.body) && Array.isArray(surface.body["nextAllowedCommands"])
    ? surface.body["nextAllowedCommands"] as readonly unknown[] : [];
  const found = offers.find((row) => isRecord(row)
    && row["commandKind"] === commandKind
    && typeof row["targetAggregateId"] === "string"
    && matches(row["targetAggregateId"]));
  if (found === undefined) {
    const seen = offers.map((row) => isRecord(row)
      ? `${String(row["commandKind"])}@${String(row["targetAggregateId"])}` : "?").join(", ");
    expect(found, `no ${commandKind} offer among ${seen}`).toBeDefined();
    return null;
  }
  return isRecord(found) ? found : null;
}

function revisionWith(entity: string, extraComponent: string) {
  return {
    apiSurface: [{ payload: "{ email, password }", route: "POST /api/sessions" }],
    componentList: ["AppShell", extraComponent],
    dataModel: [{ entity, fields: ["id", "ownerId", "title"], relations: ["User.id"] }],
    nonFunctional: {
      accessibility: "WCAG 2.2 AA, keyboard-reachable on every screen",
      auth: "session cookie, argon2id password hash",
      performance: "p95 API 200ms",
    },
    openDecisions: ["Does the operator want SSO in v1?"],
    screens: [{
      journey: "Sign in and reach the shelf",
      screens: [{ screen: "SignIn", states: ["EMPTY", "SUBMITTING"] }],
    }],
  };
}

/**
 * A SCRIPTED SEAT COMPILES THE PLAN, exactly as `plan-reject-replan.spec.ts` does.
 *
 * The plan fold names the design version THE PLAN WAS COMPILED AGAINST, and the daemon
 * takes that from the compiled run's own binding (`compile-dispatcher.ts` records
 * `designVersion: design.ok ? design.record.version : null`). So there is no version to
 * name until a plan exists: this compile is what makes the provenance claim testable,
 * and it is why the fold keeps saying version 1 after version 2 is submitted.
 */
async function compilePlan(
  origin: string, goalRef: string, gateRef: Readonly<Record<string, unknown>>, correlationId: string,
): Promise<DaemonAnswer | null> {
  const offer = await offerFor(origin, "planning.submit_decomposition", (target) => target === goalRef);
  if (offer === null) return null;
  return askDaemon(origin, "/command", {
    commandId: offer["commandId"],
    commandKind: "planning.submit_decomposition",
    correlationId,
    expectedVersion: offer["expectedVersion"],
    payload: {
      gateRef,
      goalRef,
      structure: {
        completionNodeKey: "node-shelf",
        nodes: [{
          ...NODE_SCOPES, criterionIds: ["crit-1"], dependsOn: [], nodeKey: "node-shelf",
          objective: "Land the item shelf slice.",
        }],
      },
    },
    requestDigest: "c".repeat(64),
    schemaVersion: "moe-runtime-command/1",
    sessionCredential: LANE_CREDENTIAL,
    targetAggregateId: offer["targetAggregateId"],
  });
}

async function createGoalFromPrd(
  page: import("@playwright/test").Page, origin: string, root: string,
  title: string, outcome: string, prdText: string, prdSha: string,
): Promise<string | null> {
  await page.getByTestId("cr.nav.goals").click();
  await expect(page.getByTestId("cr.goals.home")).toBeVisible();
  await page.getByTestId("cr.goals.new").click();
  await expect(page.getByTestId("cr.goals.newgoal.form")).toBeVisible();
  await page.getByTestId("cr.goals.newgoal.title").fill(title);
  await page.getByTestId("cr.goals.newgoal.outcome").fill(outcome);
  await page.getByTestId("cr.goals.newgoal.prd.input").setInputFiles({
    buffer: Buffer.from(prdText, "utf8"), mimeType: "text/markdown", name: "design-lane-prd.md",
  });
  await page.getByTestId("cr.goals.newgoal.create").click();
  let goalId: string | null = null;
  await expect.poll(async () => {
    const catalog = await readGoalCatalogOverHttp(origin, root, LANE_CREDENTIAL, LANE_CSRF_TOKEN);
    if (!("goals" in catalog)) return null;
    goalId = catalog.goals.find((row) => row.binding?.contentSha256 === prdSha)?.goalId ?? null;
    return goalId;
  }, { message: `the goal bound to ${prdSha.slice(0, 12)} must appear`, timeout: 30_000 })
    .not.toBeNull();
  return goalId;
}

test("the operator reads the design and the plan fold names its version", async ({ page }) => {
  test.setTimeout(480_000);
  const root = repoRoot();
  expect(root, "repo root (package.json + pnpm-workspace.yaml)").not.toBeNull();
  if (root === null) return;

  const dist = join(root, "apps", "control-room", "dist");
  const scratch = createLaneScratch();
  const children: ChildProcess[] = [];
  const pids: number[] = [];
  try {
    const build = spawnNode(
      [join(root, "apps", "control-room", "node_modules", "vite", "bin", "vite.js"), "build"],
      join(root, "apps", "control-room"),
      { ...process.env, VITE_MOE_LIVE_CREDENTIAL: undefined, VITE_MOE_LIVE_CSRF: undefined },
    );
    children.push(build.child);
    expect(await awaitExit(build.child, BUILD_MS), `vite build:\n${build.transcript().slice(-800)}`)
      .toBe(0);
    expect(existsSync(join(dist, "index.html")), "the build must emit index.html").toBe(true);

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
    if (typeof origin !== "string") return;

    const seed = spawnNode([
      "--experimental-transform-types",
      join(root, "apps", "daemon", "src", "orchestrator", "demo-seed-main.ts"),
    ], root, seedEnv(scratch, origin, "SPEED"));
    children.push(seed.child);
    expect(await awaitExit(seed.child, SEED_MS), `demo seed:\n${seed.transcript().slice(-1000)}`)
      .toBe(0);

    // 1. The operator pairs.
    const labelOutput = page.getByLabel("Pairing confirmation label");
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(labelOutput).toBeVisible({ timeout: 20_000 });
    const confirmationLabel = (await labelOutput.textContent())?.trim() ?? "";
    expect(confirmationLabel).toMatch(CONFIRMATION_LABEL);
    expect(daemon.child.stdin, "the explicit operator pipe must exist").not.toBeNull();
    daemon.child.stdin?.write(`${confirmationLabel}\n`);
    await page.getByRole("button", { name: "I entered this label" }).click();
    await expect(page.getByTestId("cr.goals.home")).toBeVisible({ timeout: 60_000 });

    /** Leave the goal and open it again: a remount re-reads, and the session survives. */
    const reopenGoal = async (goalId: string): Promise<void> => {
      await page.getByTestId("cr.nav.goals").click();
      await expect(page.getByTestId("cr.goals.home")).toBeVisible({ timeout: 20_000 });
      await page.getByTestId(`cr.goals.card.${goalId}.open`).click();
    };

    // 2. A goal bound to a PRD, and a second goal that will never get a design (DoD 4).
    const designedGoal = await createGoalFromPrd(
      page, origin, root, "Design lane goal", "The operator reads the design.",
      PRD_TEXT, PRD_SHA256,
    );
    if (designedGoal === null) return;
    const bareGoal = await createGoalFromPrd(
      page, origin, root, "Bare lane goal", "This goal is planned with no design.",
      BARE_PRD_TEXT, BARE_PRD_SHA256,
    );
    if (bareGoal === null) return;

    // 3. A planner proposes the Gate 1 revision through the daemon's OWN offer.
    const proposeOffer = await offerFor(
      origin, "product_contract.propose_revision", (target) => target === designedGoal);
    if (proposeOffer === null) return;
    const proposed = await askDaemon(origin, "/command", {
      commandId: proposeOffer["commandId"],
      commandKind: "product_contract.propose_revision",
      correlationId: "e2e-design-propose",
      expectedVersion: proposeOffer["expectedVersion"],
      payload: {
        draft: {
          authorRef: "planner-design-e2e",
          contractId: "contract-design-lane",
          criteria: [{
            criterionId: "crit-1", requirementId: "req-1", statement: CRITERION,
            supersedesCriterionId: null,
          }],
          lineage: null,
          requirements: [{
            requirementId: "req-1", statement: REQUIREMENT, supersedesRequirementId: null,
          }],
          retiredCriterionIds: [],
          retiredRequirementIds: [],
          revisionId: "rev-1",
          sourceDocumentDigests: [PRD_SHA256],
        },
        goalRef: designedGoal,
      },
      requestDigest: "a".repeat(64),
      schemaVersion: "moe-runtime-command/1",
      sessionCredential: LANE_CREDENTIAL,
      targetAggregateId: proposeOffer["targetAggregateId"],
    });
    expect(proposed.status, `propose_revision:\n${proposed.text.slice(0, 800)}`).toBe(200);
    // 200 IS NOT ACCEPTANCE. A refusal answers 200 with `ok:false`, and dropping this check
    // is what made the first failure land four steps later as "no design.submit offer" -- a
    // confusing symptom of an unproposed revision rather than a located cause.
    expect(isRecord(proposed.body) && proposed.body["ok"] !== false,
      "propose_revision refused: " + proposed.text.slice(0, 900)).toBe(true);

    // 4. READ the contract ref rather than spelling it: `revisionDigest` is the daemon's.
    const pending = await askDaemon(
      origin, "/product-contract/pending/read", { goalRef: designedGoal });
    expect(pending.status, pending.text.slice(0, 400)).toBe(200);
    // The ref is its OWN key on the pending view, NOT a field of `revision`: the stored
    // revision record carries contractId and revisionId, but `revisionDigest` is DERIVED
    // and appears only on `ref` (ProductContractPendingView.ref). Reading it off `revision`
    // yields undefined and refuses at submit time, minutes into the lane.
    const ref = isRecord(pending.body) && isRecord(pending.body["ref"])
      ? pending.body["ref"] : null;
    expect(ref, "pending read must carry a ref: " + pending.text.slice(0, 800)).not.toBeNull();
    if (ref === null) return;
    const contractRef = {
      contractId: ref["contractId"],
      revisionDigest: ref["revisionDigest"],
      revisionId: ref["revisionId"],
    };
    for (const [key, value] of Object.entries(contractRef)) {
      expect(typeof value, `the daemon must state ${key}: ${pending.text.slice(0, 800)}`)
        .toBe("string");
    }

    // 5. The human approves Gate 1 from the card. design.submit refuses without this.
    await page.getByTestId(`cr.goals.card.${designedGoal}.open`).click();
    const approve = page.getByTestId("cr.gate1.approve");
    await expect(approve, "the daemon minted an approval, so Approve is offered")
      .toBeEnabled({ timeout: 30_000 });
    await approve.click();
    await expect(page.getByTestId("cr.gate1.approved")).toBeVisible({ timeout: 30_000 });
    // The card saying APPROVED is the browser word; the daemon word is the pending read
    // answering NONE. Assert the daemon, because `design.submit` is offered off the APPROVED
    // GATE REF, and a card that rendered without a durable approval would send the next step
    // hunting an offer that was never going to exist.
    const pendingAfter = await askDaemon(
      origin, "/product-contract/pending/read", { goalRef: designedGoal });
    expect(isRecord(pendingAfter.body) ? pendingAfter.body["outcome"] : null,
      "pending read after approval: " + pendingAfter.text.slice(0, 700)).toBe("NONE");

    // 6. THE SCRIPTED SEAT submits a design against that approved contract.
    const submitDesign = async (entity: string, component: string, label: string): Promise<void> => {
      const offer = await offerFor(
        origin, "design.submit", (target) => target.endsWith(designedGoal));
      if (offer === null) return;
      const answer = await askDaemon(origin, "/command", {
        commandId: offer["commandId"],
        commandKind: "design.submit",
        correlationId: `e2e-design-${label}`,
        expectedVersion: offer["expectedVersion"],
        payload: { contractRef, goalRef: designedGoal, revision: revisionWith(entity, component) },
        requestDigest: "b".repeat(64),
        schemaVersion: "moe-runtime-command/1",
        sessionCredential: LANE_CREDENTIAL,
        targetAggregateId: offer["targetAggregateId"],
      });
      expect(answer.status, `design.submit ${label}:\n${answer.text.slice(0, 900)}`).toBe(200);
      expect(isRecord(answer.body) && answer.body["ok"] !== false,
        `design.submit ${label} refused:\n${answer.text.slice(0, 900)}`).toBe(true);
    };
    await submitDesign(ENTITY_V1, "ShelfTable", "v1");

    // 7. DoD 1: the tab renders the version AND a named entity from the data model.
    // NAVIGATE, NEVER RELOAD. A reload drops the paired session and the daemon mints a
    // FRESH pairing label -- pairing-operator-channel.spec.ts:378 proves it by reloading
    // and asserting the label is visible again. Everything after a reload here would wait
    // on a screen that is back at "Not paired yet" until the test budget dies, which is
    // exactly how this spec first failed. The Design card re-reads on mount and on
    // subject change, so leaving the goal and re-opening it refetches without a reload.
    await reopenGoal(designedGoal);
    const card = page.getByTestId("cr.design.card");
    await expect(card, "the Design card must render for a goal that has a design")
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("cr.design.version")).toHaveText("Version 1");
    await expect(page.getByTestId("cr.design.body")).toContainText(ENTITY_V1);

    // 8. A resubmit bumps the version and the tab shows the NEWER one (DoD 3).
    //    THE RESUBMIT COMES BEFORE THE COMPILE, and that order is forced, not stylistic:
    //    once a decomposition is compiled the goal has left the design rung and the surface
    //    offers approval.decide/decide_intent for the run instead of design.submit, so a
    //    resubmit attempted afterwards fails with "no design.submit offer among ...".
    await submitDesign(ENTITY_V2, "ConfirmDialog", "v2");
    await reopenGoal(designedGoal);
    await expect(page.getByTestId("cr.design.version")).toHaveText("Version 2", { timeout: 30_000 });
    await expect(page.getByTestId("cr.design.body")).toContainText(ENTITY_V2);

    // 9. A SCRIPTED SEAT COMPILES THE PLAN against the approved gate. Until a plan exists
    //    there is no compiled binding to read a design version out of, so this is the step
    //    that makes DoD 2's provenance claim a claim about something.
    const compiled = await compilePlan(origin, designedGoal, contractRef, "e2e-design-compile");
    expect(compiled, "the daemon must offer planning.submit_decomposition").not.toBeNull();
    if (compiled === null) return;
    expect(compiled.status, `submit_decomposition:\n${compiled.text.slice(0, 900)}`).toBe(200);
    expect(isRecord(compiled.body) && compiled.body["ok"] !== false,
      `submit_decomposition refused:\n${compiled.text.slice(0, 900)}`).toBe(true);

    // DoD 2: the fold names the version THIS RUN WAS COMPILED AGAINST -- read off the run's
    // own binding (compile-dispatcher.ts records designVersion at compile time), not off the
    // goal's latest revision. Version 2 is what the compile selected because both revisions
    // existed by then; asserting the ABSENCE of version 1 is what proves the fold is reading
    // the binding rather than the first design it can find.
    await reopenGoal(designedGoal);
    const fold = page.getByTestId("cr.approve.design-version");
    await expect(fold).toContainText("Design version 2", { timeout: 30_000 });
    await expect(fold).not.toContainText("Design version 1");

    // 9. DoD 3's other half: the OLDER version is still readable, which is the
    //    operator's real question -- what CHANGED. Asked of the daemon, since the
    //    surface deliberately ships no version picker.
    const older = await askDaemon(origin, "/design/read", { goalRef: designedGoal, version: 1 });
    expect(older.status, `design read v1:\n${older.text.slice(0, 600)}`).toBe(200);
    const olderRecord = isRecord(older.body) && isRecord(older.body["record"])
      ? older.body["record"] : null;
    expect(olderRecord, `design read v1 record:\n${older.text.slice(0, 800)}`).not.toBeNull();
    expect(olderRecord?.["version"], "version 1 must still answer as version 1").toBe(1);
    expect(older.text, "version 1 must still carry ITS entity, not version 2's")
      .toContain(ENTITY_V1);
    expect(older.text).not.toContain(ENTITY_V2);

    // The two frames read here were captured verbatim from a run of THIS spec into
    // `apps/control-room/src/v2/goals/design-read-frame.captured.json`, which
    // design-version-note.test.tsx decodes with the production decoder. That is what
    // keeps the control-room fixture a real daemon frame rather than a hand-written shape.

    // 10. DoD 4: a goal with NO design says so in words, on both surfaces.
    await page.getByTestId("cr.nav.goals").click();
    await expect(page.getByTestId("cr.goals.home")).toBeVisible();
    await page.getByTestId(`cr.goals.card.${bareGoal}.open`).click();
    await expect(page.getByTestId("cr.design.card")).toBeVisible({ timeout: 30_000 });
    const none = page.getByTestId("cr.design.none");
    await expect(none, "a goal with no design must SAY so, never render blank")
      .toBeVisible({ timeout: 20_000 });
    expect((await none.textContent())?.trim().length ?? 0).toBeGreaterThan(0);

    expect(await page.getByTestId("cr.banner.fixture").count()).toBe(0);
  } finally {
    for (const child of [...children].reverse()) await killTree(child);
    try { rmSync(scratch.root, { force: true, recursive: true }); } catch { /* scratch leftover */ }
  }
  expect(await survivingPids(pids), "the lane must leave no orphan daemon").toEqual([]);
});
