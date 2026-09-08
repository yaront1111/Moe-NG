import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SqliteEventStore } from "@moe/store";

import { publicationRepositoryId }
  from "../../../apps/daemon/src/repository/publication-approval-contracts.js";
import { readPublishLedger }
  from "../../../apps/daemon/src/repository/publish-ledger.js";
import { publishAggregateId }
  from "../../../apps/daemon/src/repository/publish-receipt-contracts.js";
import { resolveRepositoryExecutionIdentity }
  from "../../../apps/daemon/src/repository/repository-execution-identity.js";
import { killTree, running } from "./daemon-children.js";
import { mintLaneOperatorSeat, readWireProtocolVersion, withDaemonBackedControlRoom }
  from "./daemon-ports.js";
import { createLaneContractGoal } from "./lane-contract-goal.js";
import { CARD_MS, assertStopped, pair } from "./lane-preview-arms.js";
import { resolveLaneScratch, startWrapper, WRAPPER_INTERVAL_MS, wrapperEnv } from "./wrapper-lane.js";
import type { DaemonLane, LaneScratch } from "./daemon-ports.js";

/**
 * GATE 3 DRIVEN AGAINST GITHUB — the live counterpart of `release-approval.spec.ts`, which
 * fakes exactly one thing: the `gh pr create` subprocess. This spec fakes NOTHING. The lane
 * names `fakeDocker` for the reason `preview-approve-live.spec.ts:16` records — it is the
 * existing switch that gives a lane a git workspace, `MOE_NODE_WORKSPACE` and a landing-capable
 * node spec — and deliberately does NOT name `fakeGh`, so `daemon-command-async-entries.ts:284`
 * falls through to the production `createGhReleasePrPort`. The absence of the double's
 * `release-pr-calls.jsonl` is asserted below: that file is the discriminator, and a lane that
 * grew the double back would be proving the wrong thing on a green link.
 *
 * OPT-IN, BECAUSE IT OPENS A REAL PULL REQUEST. Guarded on `MOE_LIVE_RELEASE_PR=1` the way
 * this repository already guards its real-infrastructure arms (`MOE_MIGRATION_RESTORE`,
 * `MOE_VERIFIER_DATABASE`, `MOE_SCAFFOLD_MIGRATE`). An unguarded run would push a branch and
 * open a pull request on somebody's repository every time the browser gate runs, which is a
 * side effect wearing a test's clothes. The target is named by the OPERATOR through
 * `MOE_LIVE_RELEASE_REMOTE`, never hard-coded: a committed spec that knows one account's
 * repository is a landmine for the next checkout.
 *
 * WHY THE WORKSPACE IS REBASED ONTO THE REMOTE BASE FIRST. `createLaneWorkspace`
 * (daemon-ports.ts:193) is a fresh `git init` with one commit, so it shares NO ancestor with
 * the remote's base branch. That is invisible and harmless for every fake-remote spec, and
 * fatal here: GitHub answers "entirely different commit histories" and refuses the pull
 * request. So the lane's baseline is rebuilt ON TOP of the exact commit the remote publishes
 * for the base branch, re-measured with `git ls-remote` rather than assumed, and the goal's
 * node landings then sit on top of that. The push therefore carries only this drive's own
 * commits.
 *
 * WHAT IS PUSHED, AND WHAT IS NOT. `git-publication-port.ts:66` pushes
 * `<sha>:refs/heads/<approval.branch>`, so `approval.branch` IS the ref written on the remote.
 * It is NOT an operator's free choice: `publish-services.ts:99` re-measures the candidate itself
 * and refuses PUBLISH_APPROVAL_STALE @ DAEMON_PREREQUISITE unless the submitted approval equals
 * it, and `publication-candidate.ts:21` reads the branch from the workspace's own
 * `symbolic-ref HEAD`. So the throwaway ref is created by CHECKING THE LANE WORKSPACE OUT ON IT,
 * and the daemon then measures the name this drive intends. Reusing the `branch: "main"` literal
 * the hermetic spec is safe with — its remote does not exist — would push at the owner's base
 * branch. The pull request BASE is a separate value and travels from the card's own input
 * through the `release.decide` payload.
 */
const LIVE = process.env["MOE_LIVE_RELEASE_PR"] === "1";
const LIVE_REMOTE = process.env["MOE_LIVE_RELEASE_REMOTE"] ?? "";
const LIVE_BASE = process.env["MOE_LIVE_RELEASE_BASE"] ?? "main";

const JOURNEY_MS = 1_800_000;
const PUBLISH_BUDGET_MS = 180_000;
const SHA = /^[0-9a-f]{40}$/u;
const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/u;
/** Stated rather than inherited, exactly as `daemon-ports.ts` states it: no host identity needed. */
const DRIVE_IDENTITY = ["-c", "user.name=Moe", "-c", "user.email=moe@moe.local",
  "-c", "commit.gpgsign=false"];

const wrapperPids: number[] = [];
const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

/** GIT_* stripped for the reason `landingEnvironment()` strips it: a parent shell's GIT_DIR
 *  would silently redirect every command below into the developer's own repository. */
function git(cwd: string, argv: readonly string[]): string {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  return execFileSync("git", [...argv], { cwd, encoding: "utf8", env, windowsHide: true }).trim();
}

/** The commit the REMOTE publishes for the base branch, read from the remote and not from a
 *  local tracking ref: a stale `origin/<base>` is exactly the mistake this drive cannot make. */
function remoteBaseSha(cwd: string): string {
  const rows = git(cwd, ["ls-remote", "--exit-code", "--", LIVE_REMOTE, `refs/heads/${LIVE_BASE}`])
    .split(/\r?\n/u);
  expect(rows.length, `the remote must publish exactly one ${LIVE_BASE}`).toBe(1);
  const sha = rows[0]?.split("\t")[0] ?? "";
  expect(sha, "ls-remote must answer a full object id").toMatch(SHA);
  return sha;
}

/**
 * Rebuilds the lane baseline on top of the remote's base commit, so the branch this drive
 * pushes has a merge base with it. The objects come from the LOCAL checkout, which normally
 * already holds them; when it does not, this refuses and says to fetch rather than silently
 * opening a pull request against an older base than the operator believes.
 */
function descendFromBase(workspace: string, repoRoot: string, sha: string, branch: string): void {
  const local = git(repoRoot, ["cat-file", "-t", sha]);
  expect(local, `the local checkout must hold ${sha} — run \`git fetch origin\``).toBe("commit");
  git(workspace, ["fetch", "--no-tags", "--quiet", repoRoot.replaceAll("\\", "/"),
    `+${sha}:refs/heads/live-release-base`]);
  // CHECKED OUT ON THE THROWAWAY NAME, because that is what the daemon will measure and push.
  git(workspace, ["checkout", "--quiet", "-B", branch, "refs/heads/live-release-base"]);
  expect(git(workspace, ["symbolic-ref", "--quiet", "HEAD"]),
    "the daemon reads the pushed ref from this workspace's HEAD").toBe(`refs/heads/${branch}`);
  git(workspace, ["reset", "--hard", "--quiet", "refs/heads/live-release-base"]);
  writeFileSync(join(workspace, "product.txt"),
    "The lane's own workspace, committed for real.\n", "utf8");
  git(workspace, ["add", "--", "product.txt"]);
  git(workspace, [...DRIVE_IDENTITY, "commit", "--quiet", "--message",
    "Gate 3 live drive baseline"]);
  // `--is-ancestor` exits 1 when it is not, and `git` above throws on a nonzero exit, so this
  // reads as a refusal rather than a silent false. It is the whole point of the rebase.
  git(workspace, ["merge-base", "--is-ancestor", sha, "HEAD"]);
}

/** One pass of the REAL wrapper, because `repository-delivery-runtime.ts:128` is what ticks
 *  `publishOnce`; this lane kills its wrapper after each delivery, so nothing else would. */
async function tickPublisher(
  lane: DaemonLane, scratch: LaneScratch, workspace: string,
): Promise<void> {
  const tracked: ChildProcess[] = [];
  const watched = startWrapper(lane.repoRoot, {
    ...wrapperEnv(scratch, "node --version", WRAPPER_INTERVAL_MS, true),
    MOE_WRAPPER_ONCE: "1", MOE_NODE_SPECS_DIR: "", MOE_NODE_WORKSPACE: workspace,
  }, tracked);
  try {
    const deadline = Date.now() + PUBLISH_BUDGET_MS;
    while (running(watched.child) && Date.now() < deadline) await sleep(250);
    if (watched.child.pid !== undefined) wrapperPids.push(watched.child.pid);
  } finally {
    for (const child of [...tracked].reverse()) await killTree(child);
  }
}

/** The publisher's OWN receipt, polled — `ACCEPTED` on the command is the dispatch, not the
 *  push, and a refused push otherwise resurfaces two minutes later as "the card has no sha". */
async function awaitPushed(lane: DaemonLane, goalId: string): Promise<string> {
  const deadline = Date.now() + PUBLISH_BUDGET_MS;
  let outcome = publishOutcome(lane, goalId);
  while (outcome !== "PUSHED" && Date.now() < deadline) {
    await sleep(1_000);
    outcome = publishOutcome(lane, goalId);
  }
  return outcome;
}

function publishOutcome(lane: DaemonLane, goalId: string): string {
  const store = SqliteEventStore.openForProject(
    join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId);
  try {
    const receipts = [...readPublishLedger(store, lane.projectId).get(goalId)?.receipts.values() ?? []];
    const receipt = receipts[receipts.length - 1];
    if (receipt === undefined) return "NO PUBLISH RECEIPT";
    return receipt.outcome === "PUSHED"
      ? "PUSHED" : `${receipt.outcome}: ${JSON.stringify(receipt.refusal)}`;
  } finally { store.close(); }
}

/** `/release/read` over the REAL listener — the record's receipt id and dossier sha come from
 *  the daemon's own answer, never from the browser's rendering of it. */
async function readRelease(lane: DaemonLane, goalId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${lane.daemonOrigin}/release/read`, { method: "POST",
    headers: { "content-type": "application/json", origin: lane.daemonOrigin,
      "x-moe-csrf": lane.csrfToken, "x-moe-session-credential": lane.credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "" },
    body: JSON.stringify({ goalId }),
  });
  return await response.json() as Record<string, unknown>;
}

/**
 * The release receipt the daemon committed, POLLED off `/release/read`.
 *
 * THE RECEIPT IS NESTED UNDER `evidence`, not at the top level: `readReleaseForGoal` answers
 * `{ evidence: { ..., receipt }, kind: "PRESENT" }` (release-evidence-read.ts:225-235). Reading
 * `body.receipt` polls forever against a decision that already succeeded, and the timeout then
 * reports "no receipt" about a goal whose pull request is open — a true sentence about the
 * wrong subject.
 *
 * POLLED because a real drive is slow: `release.decide` runs `publishOnce`, then `gh pr create`,
 * then a `gh pr view` re-read, and the receipt lands only after all three.
 */
async function awaitReceipt(
  lane: DaemonLane, goalId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + PUBLISH_BUDGET_MS;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const read = await readRelease(lane, goalId);
    last = read;
    const evidence = read["evidence"];
    if (evidence !== null && typeof evidence === "object") {
      const receipt = (evidence as Record<string, unknown>)["receipt"];
      if (receipt !== null && typeof receipt === "object") {
        return receipt as Record<string, unknown>;
      }
    }
    await sleep(2_000);
  }
  return { lastRead: last };
}

/** Opens the goal and waits for the release card. `cr.goals.card.<id>.open` is the testid the
 *  product ships (goals-home.tsx GoalCard); a nav that silently does not arrive would otherwise
 *  report itself as "the card is missing", which is a true sentence about the wrong subject. */
async function openReleaseCard(page: Page, goalId: string): Promise<void> {
  await page.getByTestId("cr.nav.goals").click({ timeout: CARD_MS });
  await expect(page.getByTestId("cr.goals.home")).toBeVisible({ timeout: CARD_MS });
  await page.getByTestId(`cr.goals.card.${goalId}.open`).click({ timeout: CARD_MS });
  await expect(page.getByTestId("cr.release.root")).toBeVisible({ timeout: CARD_MS });
}

async function command(
  lane: DaemonLane, kind: string, aggregateId: string, payload: object, credential: string,
): Promise<unknown> {
  const store = SqliteEventStore.openForProject(
    join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId);
  let expectedVersion: number;
  try { expectedVersion = store.getAggregateVersion(aggregateId); } finally { store.close(); }
  const response = await fetch(`${lane.daemonOrigin}/command`, { method: "POST",
    headers: { "content-type": "application/json", origin: lane.daemonOrigin,
      "x-moe-csrf": lane.csrfToken, "x-moe-session-credential": credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "" },
    body: JSON.stringify({ commandId: `live-${kind}`, commandKind: kind,
      correlationId: "live-release", expectedVersion, payload, requestDigest: "d".repeat(64),
      schemaVersion: "moe-runtime-command/1", sessionCredential: credential,
      targetAggregateId: aggregateId }),
  });
  return response.json();
}

test("gate 3 live: the operator approves in the browser and GitHub answers with a real pull request",
  async ({ page }) => {
    test.skip(!LIVE, "opt-in: MOE_LIVE_RELEASE_PR=1 and MOE_LIVE_RELEASE_REMOTE=<https remote>");
    test.setTimeout(JOURNEY_MS);
    expect(LIVE_REMOTE, "MOE_LIVE_RELEASE_REMOTE must name the https remote to push to")
      .toMatch(/^https:\/\/[^\s@]+$/u);
    let started: DaemonLane | undefined;
    wrapperPids.length = 0;
    const branch = `moe-gate3-release-${Date.now().toString(36)}`;
    // THE ONE UNRECOVERABLE MISTAKE THIS SPEC COULD MAKE is pushing at the base branch, so it is
    // refused here rather than left to the generator's good luck. A drive that leaves the branch
    // behind on a failure is deliberate — it is the evidence — and is pruned by hand, not here.
    expect(branch, "the drive may never push at the base branch").not.toBe(LIVE_BASE);
    try {
      const result = await withDaemonBackedControlRoom({
        fakeDocker: "SUCCESS", liveCredentials: "ATTACHED", operatorChannel: true,
      }, async (lane) => {
        started = lane;
        const root = dirname(lane.catalogPath);
        // NO DOUBLE IS INSTALLED. `fake-gh-dependencies.ts` writes this file at import time, so
        // its absence is the proof that the production `gh` spawn is the one under test.
        expect(existsSync(join(root, "release-pr-calls.jsonl")), "the gh double must be absent")
          .toBe(false);

        const laneScratch = resolveLaneScratch(lane);
        expect(laneScratch, "the lane scratch must resolve before the spec is retired").not.toBeNull();
        if (laneScratch === null) throw new Error("unreachable: the assertion above fails first");
        const baseSha = remoteBaseSha(lane.repoRoot);
        descendFromBase(lane.workspace, lane.repoRoot, baseSha, branch);

        const contract = await createLaneContractGoal(lane);
        wrapperPids.push(...contract.wrapperPids);
        expect(contract.landedSha, "the lander commits a real sha git resolves").toMatch(SHA);
        const identity = resolveRepositoryExecutionIdentity(lane.workspace);
        expect(identity.ok, JSON.stringify(identity)).toBe(true);
        if (!identity.ok) throw new Error("unreachable: the assertion above fails first");
        const goalId = contract.goalRef;

        const approval = { branch, remoteUrl: LIVE_REMOTE,
          repositoryId: publicationRepositoryId(identity.identity), sha: contract.landedSha };
        const published = await command(lane, "repository.publish", publishAggregateId(goalId),
          { approval, goalId, remoteUrl: LIVE_REMOTE }, mintLaneOperatorSeat(lane).credential);
        expect(published, `PUBLISH: ${JSON.stringify(published)}`)
          .toMatchObject({ outcome: "ACCEPTED" });
        await tickPublisher(lane, laneScratch, contract.scratch.workspace);
        expect(await awaitPushed(lane, goalId), `the publisher must push ${branch} to the remote`)
          .toBe("PUSHED");

        const evidence = await readRelease(lane, goalId);
        expect(evidence, `RELEASE READ: ${JSON.stringify(evidence)}`)
          .toMatchObject({ kind: "PRESENT" });

        await page.goto(lane.baseUrl);
        await pair(page, lane);
        await openReleaseCard(page, goalId);
        await expect(page.getByTestId("cr.release.sha"))
          .toContainText(contract.landedSha.slice(0, 10));

        // ARM, THEN CONFIRM: the same two clicks an operator makes, and the ONLY thing that
        // asks GitHub for this pull request. A `gh pr create` typed at a shell would prove
        // nothing this row claims.
        await page.getByTestId("cr.release.base").fill(LIVE_BASE);
        const approve = page.getByTestId("cr.release.button");
        await approve.click();
        await expect(approve).toContainText("Confirm: release");
        await approve.click();

        // WAIT ON THE DAEMON'S OWN RECEIPT, because the browser cannot. MEASURED ON THIS LANE
        // (2026-09-08, PR #32): a real `release.decide` runs `publishOnce`, `gh pr create` and a
        // `gh pr view` re-read, and takes far longer than the browser transport's 15s abort
        // (`client-transport.ts:118`, `live-effect-read.ts:70`). The command IS delivered and the
        // pull request IS opened — the browser simply stops waiting, `LiveGoalRelease`'s
        // post-submit `refresh()` then fires into the still-busy daemon and lands on
        // `cr.release.read-refusal`, which `useEffectRead` never retries out of. Filed as
        // task-3697c02bf2ab41a896fcfacb125d9e46; this spec asserts what is TRUE rather than
        // what would be convenient.
        const decided = await awaitReceipt(lane, goalId);
        expect(decided["outcome"], `RELEASE RECEIPT: ${JSON.stringify(decided)}`).toBe("RELEASED");

        // THE OPERATOR'S NEXT LOOK. Re-opening the goal remounts `LiveGoalRelease` and re-reads,
        // which is exactly what an operator does after a decision that outran the request. The
        // link has to be there THEN — a receipt the card never surfaces is not a delivered link.
        await openReleaseCard(page, goalId);
        const link = page.getByTestId("cr.release.link");
        await expect(link).toBeVisible({ timeout: CARD_MS });
        const prUrl = await link.getAttribute("href");
        expect(prUrl ?? "", "the receipt's prUrl must be a real GitHub pull request")
          .toMatch(PR_URL);

        // THE RECORD. Printed so the drive's transcript carries the three facts DoD 6 asks
        // for; a marker line is also the only way to tell an opt-in arm that RAN from one the
        // `test.skip` above quietly declined.
        // eslint-disable-next-line no-console
        console.log(`LIVE RELEASE DRIVE: ${JSON.stringify({
          base: LIVE_BASE, branch, dossierSha256: decided["dossierSha256"], goalId,
          landedSha: contract.landedSha, prUrl, receiptId: decided["receiptId"],
          remote: LIVE_REMOTE,
        })}`);
      });
      expect(result.ok ? "ok" : `${result.code}: ${result.detail}`).toBe("ok");
    } finally { await assertStopped(started, [...wrapperPids]); }
  });
