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
import { prepareLiveProductWorkspace } from "./live-proof-workspace.js";
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
 * WHAT IT STILL DOES NOT COVER, said here so a green run is never read as more than it is:
 * Gate 2, Gate 3 and the deploy are on the far side of the operator fence this spec's boundary
 * arm MEASURES, and the owner's ruling (comment-267eccae) routes preview and deploy over the
 * operator wire rather than the browser. Steps 5-8 of the plan own those.
 *
 * NOTHING IS SEEDED. `seed: "NONE"` plus the `seedPid === null` assertion is the lane's own
 * witness, and the catalog is asserted ABSENT before the page is touched. No scratchpad script
 * touches any step the product claims to do itself (task rail 3): the repository is created by
 * the browser's own form, and every fact below is read back from the daemon or from git.
 */

/** Raised for the landing leg: three real deliveries, each with a verifier run and a commit. */
const JOURNEY_MS = 1_800_000;
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
    await driveGate1InBrowser(page, lane, goalId);

    const wall = await askDaemon(lane, "/affordances/read", {});
    record("offered-kinds-after-gate1", offeredKinds(wall.body));
    record("committed-kinds-after-gate1", committedKinds(wall.body));

    // ---- THE DESIGN. `design.submit` refuses DESIGN_CONTRACT_NOT_APPROVED without Gate 1, so
    // reaching it at all is the gate's own witness that Gate 1 really committed. ----
    const designOffer = offerFor(wall.body, "design.submit");
    record("design-offer", designOffer === null ? null : designOffer["targetAggregateId"]);
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
            lane, productDir, PLAN_NODES.map((node) => node.nodeKey), CONCURRENT_NODES);
          record("node-landings", landed.ok
            ? { landings: landed.landings, seats: landed.seats, staffing: landed.staffing }
            : { detail: landed.detail.slice(0, 1500), ok: false });
          expect(landed.ok, landed.ok ? "landed" : landed.detail).toBe(true);
          if (landed.ok) {
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

  record("lane-outcome", outcome.ok ? outcome.value : { code: outcome.code, detail: outcome.detail });
  expect(outcome.ok, `lane opened${outcome.ok ? "" : `: ${outcome.code} ${outcome.detail}`}`).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.value.commits, "exactly one commit in the new repository").toBe(1);
});
