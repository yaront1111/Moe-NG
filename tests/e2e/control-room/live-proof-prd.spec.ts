import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { mintLaneOperatorSeat, withDaemonBackedControlRoom } from "./daemon-ports.js";
import { resolveLaneScratch } from "./wrapper-lane.js";
import {
  ask, askDaemon, committedKinds, envelope, isRecord, offerFor, offeredKinds, pairBrowser, record,
} from "./live-proof-arms.js";
import { approvePlanInBrowser, askClarification, driveGate1InBrowser, proposeContract }
  from "./live-proof-gate1.js";
import { installStandingAuthority, landLiveProofNodes } from "./live-proof-landing.js";
import { MIGRATION_FILE, prepareLiveProductWorkspace } from "./live-proof-workspace.js";
import { LIVE_ENVIRONMENT, cleanupDeployment } from "./live-proof-deploy.js";
import { DEPLOY_BUILD_CONTEXT_ENV_KEY } from "../../../apps/daemon/src/deployment/deploy-command.js";
import { deployLiveProof, previewLiveProof } from "./live-proof-operate.js";
import {
  installProductDependencies, probeHealthUrl, startPreviewEnvironment, stopPreviewEnvironment,
} from "./live-proof-environment.js";
import type { LivePreviewEnvironment } from "./live-proof-environment.js";
import { reconcileLandingInBrowser } from "./live-proof-recover.js";
import { readRecoveryEvidence } from "./live-proof-recovery.js";
import { verifyLiveProofCriteria } from "./live-proof-criteria.js";
import { LIVE_RELEASE, releaseLiveProof } from "./live-proof-release.js";
import { CRITERIA, PRD_TEXT, PRODUCT_NAME } from "./live-proof-prd.js";

/**
 * THE EPIC-FINAL LIVE PROOF, step 3: a fresh product, from the browser, on my own recorded PRD.
 *
 * WHAT THIS SPEC IS FOR. task-161b7e9d's DoD 1 asks for the whole loop "on a FRESH product from
 * the browser only, with real seats". This drive walks it as far as the shipped browser reaches
 * and RECORDS each artefact with its measurement anchor; where the browser is refused it records
 * the refusal with its code AND its layer instead of routing around it. Task rail 2 is explicit
 * that a refusal is a recordable outcome and a narrowed DoD is not.
 *
 * WHAT IT NOW COVERS, extended for step 5: past the plan gate the drive STAFFS the compiled
 * plan's two nodes CONCURRENTLY through the real wrapper and lands both in the product's own
 * repository, so the node landing shas DoD 1 asks for are read off git here.
 *
 * WHAT THE SEATS ARE. REAL PROVIDER SEATS. The wrapper spawns a real coding CLI through its own
 * `MOE_AGENT_COMMAND` seam and that CLI writes each node's module; nothing in this lane contains
 * a line of the product's source. Round 1 used a scripted seat and QA rejected it.
 *
 * WHO DOES WHAT, said plainly so a green run is never read as more than it is. The browser
 * drives bootstrap, activation, Gate 1 with its clarification, the design, the plan and the plan
 * gate, and it takes the release decision by click. PREVIEW and DEPLOY ride the CONFIGURED
 * OPERATOR wire, because both refuse every other principal in their own source and the owner
 * ruled (comment-267eccae item 3) that they may be driven that way with the actor named
 * truthfully. No fence is edited anywhere in this row.
 *
 * NOTHING IS SEEDED. `seed: "NONE"` plus the `seedPid === null` assertion is the lane's own
 * witness, and the catalog is asserted ABSENT before the page is touched. No scratchpad script
 * touches any step the product claims to do itself (task rail 3): the repository is created by
 * the browser's own form, and every fact below is read back from the daemon or from git.
 */

/**
 * Raised for the REAL seats and the REAL deploy.
 *
 * Three provider turns (minutes each, serialized by the repository coordinator), a forced crash
 * and a wrapper restart, a `docker build` of a cold `node:24.16.0-alpine`, docker's own health
 * retries, and a PostgreSQL container. This is a wall-clock bound on a long live drive, not a
 * performance target: a run that needs more than this has stalled, not slowed.
 */
const JOURNEY_MS = 5_400_000;
const CARD_MS = 120_000;
const RUN_MS = 240_000;
const CONTRACT_ID = "contract-standup-live-proof";
const PRD_SHA256 = createHash("sha256").update(PRD_TEXT, "utf8").digest("hex");

const created: string[] = [];
test.afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** The design MY PRD states: three screens, one table, one REST resource. */
const DESIGN_REVISION = {
  apiSurface: [
    { payload: "{ date }", route: "GET /api/entries" },
    { payload: "{ yesterday, today, blockers }", route: "PUT /api/entries" },
  ],
  componentList: ["AppShell", "SignInForm", "EntryComposer", "DayList", "DatePicker"],
  dataModel: [{
    entity: "standup_entry",
    fields: ["id", "author_email", "entry_date", "yesterday", "today", "blockers"],
    relations: [],
  }],
  nonFunctional: {
    accessibility: "WCAG 2.2 AA, keyboard-reachable on every screen",
    auth: "session cookie, argon2id password hash, identical error text for unknown email and wrong password",
    performance: "p95 API 200ms",
  },
  openDecisions: ["How far back may HISTORY reach?"],
  screens: [{
    journey: "Sign in, write today's standup, read a past day",
    screens: [
      { screen: "SignIn", states: ["EMPTY", "SUBMITTING", "ERROR"] },
      { screen: "Today", states: ["EMPTY", "LOADED", "SAVING"] },
      { screen: "History", states: ["EMPTY", "LOADED"] },
    ],
  }],
};

/**
 * THREE nodes: two INDEPENDENT work nodes and a completion node that depends on both.
 *
 * DoD 1 asks for at least two nodes with at least two STAFFED CONCURRENTLY, and the shape is
 * what makes the second half reachable. MEASURED 2026-09-09 with a two-node plan whose
 * completion node was `node-entries`: the graph withholds a completion node until its parents
 * are ACCEPTED, so exactly ONE node was ever staffed and the drive reported SEAT_NEVER_WROTE
 * for the other. That is the graph behaving correctly, not a defect -- so the plan now carries
 * the pair the concurrency claim is about PLUS the completion node the shape requires.
 *
 * The split is the PRD's own seam rather than an arbitrary halving: sign-in and the session
 * fence on one, the table and its UNIQUE constraint on the other, and the integration surface
 * the last two criteria are measured through on the third. Every one of the eight approved
 * criteria is carried by exactly one node, so the roster cannot silently drop one.
 */
const PLAN_NODES = [
  {
    capability: "capability-implement",
    criterionIds: ["crit-a1", "crit-a2", "crit-a3"], dependsOn: [],
    nodeKey: "node-auth-api",
    objective: "Sign-in and the session fence on /api/entries.",
    readScopes: ["services/api/src"], resources: ["resource-a"],
    verificationRecipeRefs: ["recipe-a"], writeScopes: ["services/api/src/auth"],
  },
  {
    capability: "capability-implement",
    criterionIds: ["crit-a4", "crit-a5", "crit-a7"], dependsOn: [],
    nodeKey: "node-entries",
    objective: "standup_entry, its UNIQUE constraint and the HISTORY empty state.",
    readScopes: ["services/api/src"], resources: ["resource-a"],
    verificationRecipeRefs: ["recipe-a"], writeScopes: ["services/api/src/entries"],
  },
  {
    capability: "capability-implement",
    criterionIds: ["crit-a6", "crit-a8"], dependsOn: ["node-auth-api", "node-entries"],
    nodeKey: "node-integration",
    objective: "The API surface both halves are reached through: the stable 400 and optional blockers.",
    readScopes: ["services/api/src"], resources: ["resource-a"],
    verificationRecipeRefs: ["recipe-a"], writeScopes: ["services/api/src"],
  },
];

/** The two INDEPENDENT nodes, which are the pair DoD 1's concurrency clause is about. */
const CONCURRENT_NODES = ["node-auth-api", "node-entries"];

test("a fresh product reaches a compiled two-node plan and lands both nodes, from the browser", async ({ page }) => {
  test.setTimeout(JOURNEY_MS);

  const parentDir = mkdtempSync(join(tmpdir(), "moe-liveproof-"));
  created.push(parentDir);
  const productDir = join(parentDir, PRODUCT_NAME);
  expect(existsSync(productDir), "the browser must create the submitted directory").toBe(false);

  // THE DEPLOY BUILD CONTEXT IS HOST-SCOPED DAEMON CONFIGURATION, NEVER A PAYLOAD KEY -- a
  // caller-supplied path would let any operator-authenticated request build an arbitrary
  // directory on this host (daemon-command-async-entries.ts:245-251). `daemonEnv` spreads
  // `process.env`, so naming it here is how an operator configures THIS daemon, and an
  // unconfigured one refuses DEPLOY_BUILD_CONTEXT_UNCONFIGURED rather than guessing.
  const priorBuildContext = process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY];
  process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY] = productDir;
  // Per run, so two drives on one host never contend for a container name.
  const containerPrefix = `moe-liveproof-${String(Date.now())}`;
  let deployedContainer = "";
  let deployedImageSha = "";
  let environment: LivePreviewEnvironment | null = null;

  const outcome = await withDaemonBackedControlRoom({
    approval: "HUMAN", liveCredentials: "ATTACHED", nodeWorkspace: productDir,
    operatorChannel: true, seed: "NONE",
  }, async (lane) => {
    expect(lane.seedPid, "seed child pid (null proves the lane ran unseeded)").toBeNull();
    expect(existsSync(lane.catalogPath), "no catalog exists before the browser runs").toBe(false);
    record("prd", { bytes: Buffer.byteLength(PRD_TEXT, "utf8"), sha256: PRD_SHA256 });

    await page.goto(lane.baseUrl);
    await pairBrowser(page, lane);

    // ---- BOOTSTRAP RECEIPT: the browser's own form creates the repository. ----
    await expect(page.getByTestId("cr.newproduct.form"), "the new-product card is mounted")
      .toBeVisible({ timeout: CARD_MS });
    await page.getByTestId("cr.newproduct.dir").fill(productDir);
    await page.getByTestId("cr.newproduct.name").fill(PRODUCT_NAME);
    await page.getByTestId("cr.newproduct.prd").setInputFiles({
      buffer: Buffer.from(PRD_TEXT, "utf8"), mimeType: "text/markdown", name: "standup-prd.md",
    });
    await page.getByTestId("cr.newproduct.create").click();
    const state = page.getByTestId("cr.newproduct.outcome");
    await expect(state, "the run reported an outcome").toBeVisible({ timeout: RUN_MS });
    await expect(state, "a local-only bootstrap is a FULL success")
      .toHaveAttribute("data-state", "SUCCESS", { timeout: RUN_MS });

    expect(existsSync(join(productDir, ".git")), "the browser created a git repository").toBe(true);
    // The line COUNT is the assertion, not the presence of a commit: a second line would mean
    // the scaffold ran twice, which a "has a commit" check calls fine.
    const log = execFileSync("git", ["log", "--oneline"], { cwd: productDir, encoding: "utf8" });
    const commits = log.split("\n").filter((line) => line.trim() !== "");
    expect(commits, `git log --oneline:\n${log}`).toHaveLength(1);
    const productHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: productDir, encoding: "utf8",
    }).trim();

    const receiptBody = await askDaemon(lane, "/repository/bootstrap/read", {});
    const receipt = isRecord(receiptBody.body) ? receiptBody.body["receipt"] : null;
    expect(isRecord(receipt), `bootstrap receipt: ${receiptBody.text.slice(0, 400)}`).toBe(true);
    if (!isRecord(receipt)) throw new Error("bootstrap receipt missing");
    expect(receipt["outcome"], "the daemon's own verdict").toBe("BOOTSTRAPPED");
    expect(String(receipt["sha"]), "the receipt names the commit git reports").toBe(productHead);
    record("bootstrap-receipt", {
      commits: commits.length, decidedAt: receipt["decidedAt"], dir: receipt["dir"],
      outcome: receipt["outcome"], receiptId: `${lane.projectId}-bootstrap`, sha: receipt["sha"],
    });

    // ---- ACTIVATION WITNESS: the daemon's surface, not the card's render. ----
    const afterBootstrap = await askDaemon(lane, "/affordances/read", {});
    const committed = committedKinds(afterBootstrap.body);
    for (const kind of ["repository.bootstrap", "project.bind_repository", "project.activate"]) {
      expect(committed, `committed kinds: ${committed.join(", ")}`).toContain(kind);
    }
    record("activation-witness", { committedKinds: committed, projectId: lane.projectId });

    // ---- THE GOAL the form created, bound to the PRD's own sha. ----
    const goals = await askDaemon(lane, "/goals/read", {});
    const rows: unknown = isRecord(goals.body) ? goals.body["goals"] : null;
    expect(Array.isArray(rows), `goal catalog: ${goals.text.slice(0, 400)}`).toBe(true);
    if (!Array.isArray(rows) || !isRecord(rows[0])) throw new Error("goal missing");
    const goalId = String(rows[0]["goalId"]);
    expect(isRecord(rows[0]["binding"]) && rows[0]["binding"]["contentSha256"]).toBe(PRD_SHA256);
    record("goal", { binding: rows[0]["binding"], goalId });

    // ---- GATE 1: the planner proposes and asks; the human answers and approves, by click. ----
    await proposeContract(lane, afterBootstrap.body, goalId, CONTRACT_ID, PRD_SHA256);
    const contractRef = await askClarification(lane, goalId, CONTRACT_ID);
    expect(contractRef, "the live proof requires a concrete contract before design").not.toBeNull();
    await driveGate1InBrowser(page, lane, goalId);

    const wall = await askDaemon(lane, "/affordances/read", {});
    record("offered-kinds-after-gate1", offeredKinds(wall.body));
    record("committed-kinds-after-gate1", committedKinds(wall.body));

    // ---- THE DESIGN. `design.submit` refuses DESIGN_CONTRACT_NOT_APPROVED without Gate 1, so
    // reaching it at all is the gate's own witness that Gate 1 really committed. ----
    const designOffer = offerFor(wall.body, "design.submit");
    record("design-offer", designOffer === null ? null : designOffer["targetAggregateId"]);
    expect(designOffer, "the live proof must reach design.submit").not.toBeNull();
    if (designOffer !== null && contractRef !== null) {
      const submitted = await askDaemon(lane, "/command", envelope(
        designOffer, "design.submit", "live-proof-design",
        { contractRef, goalRef: goalId, revision: DESIGN_REVISION }, "c", lane.credential,
      ));
      record("design-submitted", { status: submitted.status, tail: submitted.text.slice(0, 400) });

      const afterDesign = await askDaemon(lane, "/affordances/read", {});
      record("offered-kinds-after-design", offeredKinds(afterDesign.body));

      // ---- THE PLAN. ----
      const planOffer = offerFor(afterDesign.body, "planning.submit_decomposition");
      record("plan-offer", planOffer === null ? null : planOffer["targetAggregateId"]);
      expect(planOffer, "the live proof must reach planning.submit_decomposition").not.toBeNull();
      if (planOffer !== null) {
        const compiled = await askDaemon(lane, "/command", envelope(
          planOffer, "planning.submit_decomposition", "live-proof-plan",
          {
            gateRef: contractRef, goalRef: goalId,
            structure: { completionNodeKey: "node-integration", nodes: PLAN_NODES },
          },
          "d", lane.credential,
        ));
        record("plan-compiled", { status: compiled.status, tail: compiled.text.slice(0, 500) });

        const afterPlan = await askDaemon(lane, "/affordances/read", {});
        record("offered-kinds-after-plan", offeredKinds(afterPlan.body));
        // The widened `approval.decide_intent` offer IS the browser's plan-gate wire, and its
        // targetAggregateId is the compiled run.
        const intent = offerFor(afterPlan.body, "approval.decide_intent");
        record("plan-run", intent === null ? null : {
          expectedVersion: intent["expectedVersion"], runId: intent["targetAggregateId"],
        });
        expect(intent, "the live proof must reach the compiled plan approval").not.toBeNull();

        // ---- THE PLAN GATE, THEN TWO NODES LANDED CONCURRENTLY (DoD 1's execution half). ----
        if (intent !== null) {
          const runId = String(intent["targetAggregateId"]);
          await approvePlanInBrowser(page, lane, goalId, runId);
          record("offered-kinds-after-plan-gate",
            offeredKinds((await askDaemon(lane, "/affordances/read", {})).body));
          // The acceptance checks are committed into the product's OWN repository before any
          // seat runs, so the daemon's verifier and the criterion service both measure bytes
          // that were in the tree before the delivery they judge.
          record("acceptance-baseline", prepareLiveProductWorkspace(productDir));
          const scratch = resolveLaneScratch(lane);
          expect(scratch, "the lane scratch must resolve before the wrapper runs").not.toBeNull();
          if (scratch === null) throw new Error("unreachable: the assertion above fails first");
          // OPERATOR-WIRE STEP, DISCLOSED: the browser ships no screen that installs these two
          // standing slices, and without them the verifier never accepts a delivered node.
          record("standing-authority-operator-wire", await installStandingAuthority(lane, scratch));
          const landed = await landLiveProofNodes(
            lane, productDir, PLAN_NODES.map((node) => node.nodeKey), CONCURRENT_NODES,
            Object.fromEntries(PLAN_NODES.map((node) => [node.nodeKey, node.objective])),
            // ---- DoD 2: THE FORCED CRASH, ARMED INSIDE THIS REAL DRIVE. ----
            // `after-completion` IS MID-WRITE and the choice is a MEASUREMENT, not a taste.
            // A landing write is a sequence, and this point sits between the durable completion
            // the store journaled and the landing receipt that records the outcome -- the last
            // window in which the ledger can still end up with none or two.
            //
            // THE OTHER THREE POINTS WERE MEASURED AND REJECTED, each for a reason in the
            // product's own source rather than in this file's convenience:
            //   `before-intent`  nothing durable exists, so `readRecoveryNoEffectEvidence`
            //                    answers REPOSITORY_RECOVERY_EVIDENCE_MISSING and the shipped
            //                    recovery cannot release the reservation at all. DRIVEN LIVE
            //                    2026-09-09 20:55:00Z: the restarted wrapper produced no
            //                    landing in twenty minutes.
            //   `after-intent`   an attempt is STARTED with no commit; the journal cannot prove
            //                    what Git did.
            //   `after-commit`   Git committed and NOTHING journaled it, so
            //                    `repository-recovery-evidence.ts:74` answers
            //                    REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN by design and the
            //                    checkout stays held. Fail-closed, and recorded as such.
            // All three are pinned in the fault lane; only this one has a recovery to prove.
            { point: "after-completion" },
            // AND THE RECOVERY IS A HUMAN'S CLICK IN THE BROWSER, because the product allows
            // nothing else: `repository.recover` refuses every agent transport and demands a
            // durable human with `project.admin`.
            async (crash) => {
              // THE DAEMON'S OWN RECOVERY VIEW FIRST, so a card that offers nothing is read with
              // the code the daemon gave rather than as an unexplained absence.
              const view = await askDaemon(lane, "/repository/recovery/read", {});
              record("recovery-view", { status: view.status, tail: view.text.slice(0, 1200) });
              const reading = await reconcileLandingInBrowser(page, crash.nodeRef,
                `Daemon killed mid-write by ${crash.knob} at ${crash.at}; reconciling the landing the store already completed.`);
              record("crash-recovery-click", reading);
              return reading.confirmed ? null : reading.refusal ?? "RECOVERY_NOT_CONFIRMED";
            });
          record("node-landings", landed.ok
            ? { ok: true, crash: landed.crash, landings: landed.landings, seats: landed.seats,
              staffing: landed.staffing }
            : { detail: landed.detail.slice(0, 1500), ok: false, seats: landed.seats });
          expect(landed.ok, landed.ok ? "landed" : landed.detail).toBe(true);
          if (landed.ok) {
            const keys = PLAN_NODES.map((node) => node.nodeKey).sort();
            expect(landed.landings.map((row) => row.nodeKey).sort()).toEqual(keys);
            expect(landed.seats.map((row) => row.nodeKey).sort()).toEqual(keys);
            for (const seat of landed.seats) {
              expect(seat.realProvider, `${seat.nodeKey}: a real provider must execute`).toBe(true);
              expect(seat.providerStatus, `${seat.nodeKey}: provider exit status`).toBe(0);
              expect(seat.moduleBytes, `${seat.nodeKey}: nonempty delivered module`).toBeGreaterThan(0);
              expect(seat.startedAt).toBeGreaterThan(0);
              expect(seat.endedAt).toBeGreaterThanOrEqual(seat.startedAt);
            }
            // TWO DISTINCT COMMITS, so a single landing counted twice cannot pass.
            expect(new Set(landed.landings.map((row) => row.sha)).size).toBe(PLAN_NODES.length);
            // THE CONCURRENCY CLAIM, and it is the WRAPPER'S OWN transcript rather than an
            // inference from two landings existing: a strictly sequential wrapper lands two
            // nodes too. The witness is a BUSY refusal for the second node inside the first
            // node's delivery window, which only one checkout owner per repository can produce.
            expect(landed.staffing.concurrent,
              `no second node was staffed inside the first node's delivery window: ${JSON.stringify(landed.staffing)}`)
              .toBe(true);
            expect(landed.staffing.evidence ?? "", "the witness must carry the product's own code")
              .toContain("REPOSITORY_EXECUTION_BUSY");
            expect(CONCURRENT_NODES).toHaveLength(2);

            // ---- DoD 2: RECOVERY, PROVED FROM THE STORE ALONE. ----
            // The knob's note is the dying process's OWN last words on fd 2; nothing here is
            // read from agent memory and nothing is read from a line saying "recovered".
            expect(landed.crash, "the armed knob must have fired").not.toBeNull();
            const crash = landed.crash;
            if (crash !== null) {
              // THE LANDING LEDGER'S OWN AGGREGATE, not the node's. MEASURED 2026-09-09: a
              // node's ref carries `review.submit`, the verifier receipt and
              // `integration.accept_output` and NO landing decision at all -- landing outcomes
              // are committed under `landing:<nodeRef>` (`landingAggregateId`,
              // landing-receipt-contracts.ts:137). Counting on the node ref answers zero for
              // every node ever landed, which is a query that cannot fail for the right reason.
              const others = landed.landings
                .filter((row) => row.nodeKey !== crash.nodeKey).map((row) => `landing:${row.nodeRef}`);
              const recovery = readRecoveryEvidence({
                crashAt: crash.at, crashedNodeRef: `landing:${crash.nodeRef}`,
                landingKindSuffix: "landing_receipt", otherNodeRefs: others,
                storePath: scratch.storePath,
              });
              record("crash-and-recovery", { crash, recovery });
              // ONE OUTCOME. Counted from rows, because a DUPLICATE landing looks fine too.
              // The one that exists was written by the BROWSER'S reconcile, since the pass that
              // would have written it was killed after the completion and before the receipt.
              expect(recovery.crashedNodeLandings,
                `landing outcomes for ${crash.nodeRef}: ${JSON.stringify(recovery.crashedNode)}`)
                .toBe(1);
              // AND NOTHING IN THE LANDING JOURNAL IS DOUBLED EITHER: every intent, attempt and
              // completion aggregate carries exactly one decision. A landing that ran twice
              // shows up here as a two, whichever half of the write it repeated.
              expect(recovery.ledger.filter((row) => row.decisions !== 1),
                `doubled landing decisions: ${JSON.stringify(recovery.ledger)}`).toEqual([]);
              // AND THE GOAL RESUMES: the OTHER nodes' LANDING aggregates carry decisions
              // committed strictly after the instant the dying process stamped -- so resumption
              // is anchored to the crash, and it is resumption all the way to a LANDING rather
              // than merely to some activity.
              expect(recovery.resumedNodes.length,
                `no landing decision on ${others.join(",")} after ${crash.at}`).toBeGreaterThan(0);
              expect(others.length, "the goal must carry more than the interrupted node")
                .toBeGreaterThan(0);
            }

            // ---- DoD 3, FIRST HALF: every approved criterion VERIFIED, WITH ITS DENOMINATOR.
            const evidence = await verifyLiveProofCriteria(
              lane, scratch, productDir, goalId, CRITERIA.map((row) => row.id),
              mintLaneOperatorSeat(lane).credential);
            record("criterion-evidence", evidence);
            // THE DENOMINATOR IS THE PRD'S OWN ROSTER, not the daemon's header: a read that
            // enumerated fewer criteria than the contract approved would otherwise report
            // itself complete. CRITERIA is the transcription of comment-5657f450.
            expect(evidence.criteria).toHaveLength(CRITERIA.length);
            expect(evidence.verified, `verified ${String(evidence.verified)} of ${String(CRITERIA.length)}: ${JSON.stringify(evidence.criteria)}`)
              .toBe(CRITERIA.length);
            // AND THE DAEMON'S OWN COVERAGE READ, with its denominator: two independent reads
            // of the same fact, so a criterion the evidence view lost is caught by the other.
            expect(evidence.totals?.["criteria"]).toBe(CRITERIA.length);
            expect(evidence.totals?.["verified"]).toBe(CRITERIA.length);
            expect(evidence.integratedSha ?? "").toMatch(/^[0-9a-f]{40}$/u);

            // ---- DoD 1 / GATE 2: THE PREVIEW RECEIPT AND ITS DECISION. ----
            // ON THE CONFIGURED-OPERATOR WIRE, by the owner's ruling (comment-267eccae item 3),
            // and the record says so: `preview-start-command.ts:82-84` states in its own source
            // that preview "is never widened to a paired browser human". Nothing is fenced open.
            const releasedSha = evidence.integratedSha ?? "";
            const preview = await previewLiveProof(lane, goalId, releasedSha);
            record("preview", preview);
            expect(preview.refusal, `preview refused: ${preview.refusal ?? ""}`).toBeNull();
            expect(preview.receiptId ?? "", "a 64-hex preview receipt id").toMatch(/^[0-9a-f]{64}$/u);
            expect(preview.url ?? "", "the receipt names where the preview served")
              .toMatch(/^https?:\/\/127\.0\.0\.1:\d+/u);
            expect(preview.decision?.["outcome"], JSON.stringify(preview.decision))
              .toBe("ACCEPTED");

            // ---- DoD 3, SECOND HALF: the dossier at the released sha, on a real PR. ----
            // OPT-IN. Without MOE_LIVE_RELEASE_PR=1 nothing is pushed and the absence is
            // RECORDED rather than passed over in silence, so a green hermetic run can never
            // be read as having opened a pull request.
            if (!LIVE_RELEASE) record("release-skipped", "MOE_LIVE_RELEASE_PR is not 1");
            else {
              const released = await releaseLiveProof(page, lane, scratch, productDir, goalId);
              record("release", released);
              expect(released.publish, "the publisher must push the release branch").toBe("PUSHED");
              expect(released.prUrl ?? "", "the receipt must carry a real GitHub pull request")
                .toMatch(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/u);
              expect(released.receipt?.["outcome"]).toBe("RELEASED");
              // THE DOSSIER AT THE RELEASED SHA, READ BACK FROM GITHUB, with its DENOMINATOR:
              // every approved criterion appears and the table has exactly as many rows as the
              // approved contract has criteria. A dossier that dropped one would still call
              // itself complete, which is the failure this clause exists to catch.
              const dossier = released.dossier ?? "";
              expect(dossier, "the pull request must carry the dossier").toContain("Release dossier");
              expect(dossier).toContain(String(released.receipt?.["sha"] ?? ""));
              for (const row of CRITERIA) expect(dossier).toContain(row.id);
              const rows = dossier.split(/\r?\n/u)
                .filter((line) => line.trimStart().startsWith("| crit-"));
              expect(rows, `dossier criterion rows:\n${rows.join("\n")}`)
                .toHaveLength(CRITERIA.length);

              // ---- DoD 1 / GATE 3 -> PREVIEW ENVIRONMENT: fingerprints, deploy, health,
              // migration. AFTER the release because `deployment.deploy`'s prerequisite table
              // reads a COMMITTED `repository.publish` DECISION, which Gate 3 is what commits.
              const deployedSha = String(released.receipt?.["sha"] ?? releasedSha);
              // THE ENVIRONMENT COMES UP FIRST, AND THE OPERATOR BRINGS IT UP. A deploy is an
              // UPDATE to a running topology: the engine discovers the proxy, reads its
              // Caddyfile and flips the upstream to the candidate. MEASURED 2026-09-09 without
              // one: DEPLOY_BUILD_FAILED / DEPLOY_PROXY_MISSING_OR_AMBIGUOUS.
              environment = startPreviewEnvironment({
                databasePort: 35_000 + (Date.now() % 900), hostPort: 34_000 + (Date.now() % 900),
                prefix: containerPrefix, workspace: productDir,
              });
              record("preview-environment", environment);
              expect(environment.refusal, environment.refusal ?? "").toBeNull();
              // THE PRODUCT'S MIGRATION TOOL IS INSTALLED INTO THE PRODUCT, and this is an
              // OPERATOR STEP, disclosed as one: `node-pg-migrate` is declared in the product's
              // manifest at the deployed sha, but no Moe command installs a product's
              // dependencies, and `migration-ports.ts` resolves the tool from the workspace.
              const installed = installProductDependencies(productDir);
              record("product-install", installed);
              expect(installed.status, installed.tail).toBe(0);
              const operated = await deployLiveProof({
                database: environment.database, databaseUrl: environment.databaseUrl, goalId, lane,
                network: environment.network, sha: deployedSha,
                storePath: scratch.storePath, url: environment.url,
              });
              deployedContainer = operated.deploy.receipt?.containerName ?? "";
              deployedImageSha = deployedSha;
              record("deploy-and-migration", operated);

              // THE ENVIRONMENT FINGERPRINTS. Four keys and no `value`: the operator's only
              // confirmation a write took is the fingerprint, and it is a full sha256.
              expect(operated.environment.fingerprints.map((row) => row.name))
                .toEqual(["DATABASE_URL", "SESSION_SECRET"]);
              for (const row of operated.environment.fingerprints) {
                expect(row.isSet).toBe(true);
                expect(row.fingerprintSha256, row.name).toMatch(/^[0-9a-f]{64}$/u);
              }

              // THE DEPLOY RECEIPT AND ITS HEALTH URL, from a REAL docker build of the
              // released sha -- no `fakeDocker` anywhere in this lane.
              expect(operated.deploy.receipt, JSON.stringify(operated.deploy)).not.toBeNull();
              expect(operated.deploy.receipt?.outcome,
                `deploy detail: ${operated.deploy.receipt?.detail ?? ""}`).toBe("DEPLOYED");
              expect(operated.deploy.receipt?.sha).toBe(deployedSha);
              expect(operated.deploy.receipt?.url ?? "",
                "a DEPLOYED receipt names where the environment answers").not.toBe("");
              // HEALTH TWO WAYS: docker's own verdict, and the image's healthcheck run again
              // inside the container. A container that became healthy and then died answers
              // the first and fails the second.
              expect(operated.deploy.health?.dockerHealth,
                JSON.stringify(operated.deploy.health)).toBe("healthy");
              expect(operated.deploy.health?.probeStatus,
                operated.deploy.health?.probeOutput ?? "").toBe(0);
              // AND THE RECEIPT'S URL IS ASKED, FROM THE HOST, THROUGH THE PROXY THE DEPLOY
              // FLIPPED. This is the only probe that crosses every hop the receipt claims; the
              // two above are docker quoting itself and the container quoting itself.
              const served = await probeHealthUrl(
                String(operated.deploy.receipt?.url ?? ""), "/health");
              record("health-url", served);
              expect(served.status, served.body).toBe(200);
              expect(served.body).toContain("\"status\":\"UP\"");

              // THE MIGRATION RECEIPT, WRITTEN BY THE PRODUCT ITSELF during the deploy and read
              // back here, then cross-checked against what PostgreSQL says happened.
              expect(operated.migration?.ok, JSON.stringify(operated.migration?.log ?? []))
                .toBe(true);
              expect(operated.migration?.receipt?.outcome).toBe("APPLIED");
              expect(operated.migration?.receipt?.environment).toBe(LIVE_ENVIRONMENT);
              expect(operated.migration?.receipt?.backupRef ?? "")
                .toMatch(/^.+\.sql@sha256:[a-f0-9]{64}$/u);
              // AND IT NAMES THE FILE THE PRODUCT COMMITTED, so a receipt that applied some
              // OTHER tree's migrations cannot pass. `MIGRATION_FILE` is the path the acceptance
              // baseline committed, and the receipt lists basenames.
              expect(operated.migration?.receipt?.applied ?? [])
                .toContain(MIGRATION_FILE.slice("migrations/".length));
              // ASKED OF THE DATABASE, not of the DDL this drive sent: the only authority on
              // what a database calls its constraint is the database.
              expect(operated.migration?.constraintFromDatabase)
                .toBe("standup_entry_author_email_entry_date_key");
            }
          }
        }
      }
    }

    // ---- THE OPERATOR BOUNDARY, MEASURED WITH A DISCRIMINATING CONTROL. ----
    // `mintLaneOperatorSeat` opens a real session through the production handshake seam and
    // yields a durable HUMAN principal that is NOT the configured operator -- the same class the
    // paired browser holds, and the only borrowable stand-in for it, because the browser's own
    // plaintext credential is returned once and never stored (daemon-ports.ts:236-240).
    //
    // THE CONTROL IS WHAT MAKES THIS NON-VACUOUS. The SAME BYTES are then dispatched on the
    // configured-operator wire. If both seats refused alike the arm would be measuring my payload
    // rather than the identity fence; they must refuse at DIFFERENT LAYERS.
    const human = mintLaneOperatorSeat(lane);
    const target = offerFor(wall.body, "deployment.set_target");
    if (target !== null) {
      const payload = {
        environment: "PREVIEW", network: null, sshTarget: null, url: "http://127.0.0.1:8080",
      };
      const asHuman = await ask(lane, "/command", envelope(
        target, "deployment.set_target", "live-proof-human-wall", payload, "f", human.credential,
      ), human.credential);
      record("paired-human-wall", {
        humanPrincipal: human.principalId, kind: "deployment.set_target",
        status: asHuman.status, tail: asHuman.text.slice(0, 400),
      });
      const asOperator = await askDaemon(lane, "/command", envelope(
        target, "deployment.set_target", "live-proof-operator-control", payload, "f", lane.credential,
      ));
      record("operator-control", { status: asOperator.status, tail: asOperator.text.slice(0, 400) });

      // The HUMAN is stopped at authorization; the OPERATOR gets past it and is judged on the
      // payload instead. Two different layers is the proof that the fence is identity, not shape.
      const refusalOf = (answer: unknown): Readonly<Record<string, unknown>> | null =>
        isRecord(answer) && isRecord(answer["refusal"]) ? answer["refusal"] : null;
      expect(refusalOf(asHuman.body)?.["code"], "the paired-human class is refused on identity")
        .toBe("OPERATOR_PRINCIPAL_REQUIRED");
      expect(refusalOf(asHuman.body)?.["layer"]).toBe("DAEMON_AUTHORIZATION");
      expect(refusalOf(asOperator.body)?.["layer"],
        "the same bytes on the operator wire must get PAST authorization")
        .not.toBe("DAEMON_AUTHORIZATION");
    }
    // RE-MEASURED at HEAD, because the earlier flat roster was wrong twice and this row's whole
    // value is that its records are true. `release.decide` does NOT belong beside the other three.
    // It IS in OPERATOR_PRINCIPAL_KINDS, but it is served as an ASYNC entry, so the registry's
    // synchronous fence never runs for it; its real fence is `assertReleasePrincipal`, which admits
    // a paired ADMIN human through `releaseByPairedAdmin`. The browser therefore reaches release.
    record("operator-only-boundary", {
      operatorOnly: [
        "preview.start@preview-start-command.ts:85",
        "preview.decide@daemon-command-registry.ts:393",
        "deployment.deploy@deploy-command.ts:198",
      ],
      pairedAdminReachable: [
        "release.decide@release-decide-command.ts:65 via releaseByPairedAdmin@:77",
      ],
    });

    return { commits: commits.length, goalId, productHead, projectId: lane.projectId };
  });

  // EVERYTHING THIS DRIVE CREATED ON THE DOCKER HOST, REMOVED BY NAME AND TAG. Never by
  // wildcard: this host runs other lanes, and a pattern sweep would take their containers too.
  cleanupDeployment(deployedContainer, deployedImageSha);
  stopPreviewEnvironment(environment);
  if (priorBuildContext === undefined) delete process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY];
  else process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY] = priorBuildContext;

  record("lane-outcome", outcome.ok ? outcome.value : { code: outcome.code, detail: outcome.detail });
  expect(outcome.ok, `lane opened${outcome.ok ? "" : `: ${outcome.code} ${outcome.detail}`}`).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.value.commits, "exactly one commit in the new repository").toBe(1);
});
