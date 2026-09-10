/**
 * GATE 3 ON THE FRESH PRODUCT: publish the landed sha, then release it FROM THE BROWSER.
 *
 * OPT-IN, BECAUSE IT PUSHES AND OPENS A REAL PULL REQUEST. Gated on `MOE_LIVE_RELEASE_PR=1` and
 * `MOE_LIVE_RELEASE_REMOTE`, exactly as `release-approval-live.spec.ts` gates its own drive and
 * for the same reason: an unguarded run would push a branch to somebody's repository every time
 * the browser gate runs. The remote is the one comment-d3a282da names; it is never hard-coded.
 *
 * THE BASE BRANCH IS SEEDED FROM THE PRODUCT'S OWN BOOTSTRAP COMMIT. The designated repository is
 * empty, so `gh pr create` has nothing to open a pull request against. The product's FIRST commit
 * -- the one its own bootstrap receipt names -- is pushed as the base, and the release branch is
 * the landed head, which descends from it. That push is OPERATOR SETUP and the transcript says
 * so: it creates the base a pull request needs, and carries none of the work being reviewed.
 *
 * WHAT IS AND IS NOT THE BROWSER'S. `repository.publish` is an operator command and is dispatched
 * on the operator wire, as the existing live gate-3 drive does. `release.decide` is taken BY
 * CLICK on the release card, because `assertReleasePrincipal` admits a paired ADMIN through
 * `releaseByPairedAdmin` -- the owner's ruling (comment-267eccae item 1) asked that this be
 * measured rather than assumed, and a refusal here is recorded with its code, not routed around.
 */
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SqliteEventStore } from "@moe/store";

import { publicationRepositoryId }
  from "../../../apps/daemon/src/repository/publication-approval-contracts.js";
import { readPublishLedger } from "../../../apps/daemon/src/repository/publish-ledger.js";
import { publishAggregateId }
  from "../../../apps/daemon/src/repository/publish-receipt-contracts.js";
import { resolveRepositoryExecutionIdentity }
  from "../../../apps/daemon/src/repository/repository-execution-identity.js";
import { killTree } from "./daemon-children.js";
import { mintLaneOperatorSeat, readWireProtocolVersion } from "./daemon-ports.js";
import type { DaemonLane, LaneScratch } from "./daemon-ports.js";
import { isRecord, record } from "./live-proof-arms.js";
import { startWrapper, WRAPPER_INTERVAL_MS, wrapperEnv } from "./wrapper-lane.js";

export const LIVE_RELEASE = process.env["MOE_LIVE_RELEASE_PR"] === "1";
const LIVE_REMOTE = process.env["MOE_LIVE_RELEASE_REMOTE"] ?? "";
/**
 * THE BASE BRANCH IS PER RUN, and that is forced by what a fresh product IS.
 *
 * Every drive bootstraps a NEW repository, so its root commit is unrelated to the last run's.
 * Pushing each one at a shared `main` is refused non-fast-forward the second time -- measured
 * 2026-09-09, "failed to push some refs". Naming the base after the product's own root commit
 * makes each run self-contained on one designated remote, and an operator may still pin a base
 * explicitly. FORCE IS NEVER USED: a name derived from the root commit cannot collide with a
 * different history.
 */
const baseBranchFor = (rootSha: string): string =>
  process.env["MOE_LIVE_RELEASE_BASE"] ?? `live-proof-base-${rootSha.slice(0, 12)}`;
const PUSH_BUDGET_MS = 240_000;
const CARD_MS = 120_000;

/** GIT_* stripped so a parent shell's GIT_DIR cannot redirect a push into another repository. */
function git(cwd: string, argv: readonly string[]): string {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  return execFileSync("git", [...argv], {
    cwd, encoding: "utf8", env, timeout: 180_000, windowsHide: true,
  }).trim();
}

async function post(
  lane: DaemonLane, path: string, body: unknown, credential: string,
): Promise<unknown> {
  const response = await fetch(`${lane.daemonOrigin}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json", origin: lane.daemonOrigin,
      "x-moe-csrf": lane.csrfToken, "x-moe-session-credential": credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "",
    },
    method: "POST",
  });
  return response.json();
}

/** One wrapper, run for a bounded time so `publishOnce` ticks; the publisher lives in it. */
async function tickPublisher(
  lane: DaemonLane, scratch: LaneScratch, workspace: string, untilPushed: () => string,
): Promise<string> {
  const tracked: ChildProcess[] = [];
  startWrapper(lane.repoRoot, {
    ...wrapperEnv(scratch, "node --eval \"process.exit(0)\"", WRAPPER_INTERVAL_MS, true),
    MOE_NODE_TEST_COMMAND: "node verify.mjs", MOE_NODE_WORKSPACE: workspace,
  }, tracked);
  try {
    const deadline = Date.now() + PUSH_BUDGET_MS;
    let outcome = untilPushed();
    while (outcome !== "PUSHED" && Date.now() < deadline) {
      await delay(1_000);
      outcome = untilPushed();
    }
    return outcome;
  } finally {
    for (const child of [...tracked].reverse()) await killTree(child);
  }
}

/** The publisher's own receipt, read off the durable ledger rather than off a log line. */
function publishOutcome(scratch: LaneScratch, projectId: string, goalId: string): string {
  const store = SqliteEventStore.openForProject(scratch.storePath, projectId);
  try {
    const receipts = [...readPublishLedger(store, projectId).get(goalId)?.receipts.values() ?? []];
    const receipt = receipts[receipts.length - 1];
    if (receipt === undefined) return "NO PUBLISH RECEIPT";
    return receipt.outcome === "PUSHED"
      ? "PUSHED" : `${receipt.outcome}: ${JSON.stringify(receipt.refusal)}`;
  } finally { store.close(); }
}

/**
 * Pushes the product's FIRST commit as the remote's base branch, so a pull request has a base.
 *
 * Idempotent against a remote that already carries it: the push is not forced, and a remote that
 * already publishes the ref answers "up to date" rather than failing.
 */
export function seedRemoteBase(workspace: string): { base: string; sha: string } {
  const first = git(workspace, ["rev-list", "--max-parents=0", "HEAD"]).split(/\r?\n/u)[0] ?? "";
  const base = baseBranchFor(first);
  git(workspace, ["push", "--quiet", LIVE_REMOTE, `${first}:refs/heads/${base}`]);
  return { base, sha: first };
}

/**
 * The dossier AS GITHUB SERVES IT, not as the daemon reported having sent it.
 *
 * DoD 3 asks that the dossier "is attached to the opened PR". A receipt naming a `dossierSha256`
 * proves the daemon composed one; only reading the pull request back proves it ARRIVED. `gh` is
 * the same tool `release.decide` used to open it, so no second credential path is introduced.
 */
function readDossier(prUrl: string | null): string | null {
  if (prUrl === null || prUrl === "") return null;
  try {
    const answer = execFileSync("gh", ["pr", "view", prUrl, "--json", "body"], {
      encoding: "utf8", timeout: 60_000, windowsHide: true,
    });
    const parsed: unknown = JSON.parse(answer);
    return isRecord(parsed) ? String(parsed["body"] ?? "") : null;
  } catch { return null; }
}

export interface LiveReleaseOutcome {
  readonly base: string;
  /** The pull request BODY as GitHub serves it: the dossier, read back from the remote. */
  readonly dossier: string | null;
  readonly baseSha: string;
  readonly branch: string;
  readonly prUrl: string | null;
  readonly publish: string;
  readonly receipt: Readonly<Record<string, unknown>> | null;
}

/** Publishes the landed sha, then takes Gate 3 by click and reads the receipt back. */
export async function releaseLiveProof(
  page: Page, lane: DaemonLane, scratch: LaneScratch, workspace: string, goalId: string,
): Promise<LiveReleaseOutcome> {
  const branch = `moe-live-proof-${Date.now().toString(36)}`;
  const { base, sha: baseSha } = seedRemoteBase(workspace);
  expect(branch, "the drive may never push at the base branch").not.toBe(base);
  // THE DAEMON READS THE PUSHED REF FROM THE WORKSPACE'S OWN HEAD (`publication-candidate.ts`),
  // so the throwaway name is created by checking the product out on it -- naming it in the
  // payload alone would be re-measured and refused PUBLISH_APPROVAL_STALE.
  git(workspace, ["checkout", "--quiet", "-B", branch]);
  const sha = git(workspace, ["rev-parse", "--verify", "HEAD"]);
  const identity = resolveRepositoryExecutionIdentity(workspace);
  expect(identity.ok, JSON.stringify(identity)).toBe(true);
  if (!identity.ok) throw new Error("unreachable: the assertion above fails first");

  const operator = mintLaneOperatorSeat(lane).credential;
  const aggregate = publishAggregateId(goalId);
  const store = SqliteEventStore.openForProject(scratch.storePath, lane.projectId);
  let expectedVersion: number;
  try { expectedVersion = store.getAggregateVersion(aggregate); } finally { store.close(); }
  const published = await post(lane, "/command", {
    commandId: "live-proof-publish", commandKind: "repository.publish",
    correlationId: "live-proof-release", expectedVersion,
    payload: {
      approval: {
        branch, remoteUrl: LIVE_REMOTE,
        repositoryId: publicationRepositoryId(identity.identity), sha,
      },
      goalId, remoteUrl: LIVE_REMOTE,
    },
    requestDigest: "d".repeat(64), schemaVersion: "moe-runtime-command/1",
    sessionCredential: operator, targetAggregateId: aggregate,
  }, operator);
  record("publish-dispatch", isRecord(published) ? (published["refusal"] ?? published["outcome"]) : published);
  const publish = await tickPublisher(lane, scratch, workspace,
    () => publishOutcome(scratch, lane.projectId, goalId));
  record("publish-receipt", { branch, outcome: publish, sha });
  if (publish !== "PUSHED") {
    return { base, baseSha, branch, dossier: null, prUrl: null, publish, receipt: null };
  }

  // ---- GATE 3, BY CLICK, on the release card. ----
  await page.getByTestId("cr.nav.goals").click({ timeout: CARD_MS });
  await page.getByTestId(`cr.goals.card.${goalId}.open`).click({ timeout: CARD_MS });
  await expect(page.getByTestId("cr.release.root")).toBeVisible({ timeout: CARD_MS });
  await page.getByTestId("cr.release.base").fill(base);
  const approve = page.getByTestId("cr.release.button");
  await approve.click();
  await expect(approve).toContainText("Confirm: release");
  await approve.click();

  // THE DAEMON'S OWN RECEIPT, POLLED: `release.decide` runs publishOnce, `gh pr create` and a
  // `gh pr view` re-read, and outlasts the browser transport's abort (task-3697c02b).
  const deadline = Date.now() + PUSH_BUDGET_MS;
  let receipt: Readonly<Record<string, unknown>> | null = null;
  while (receipt === null && Date.now() < deadline) {
    const read = await post(lane, "/release/read", { goalId }, lane.credential);
    const evidence = isRecord(read) ? read["evidence"] : null;
    const found = isRecord(evidence) ? evidence["receipt"] : null;
    if (isRecord(found)) receipt = found;
    else await delay(2_000);
  }
  const prUrl = receipt === null ? null : String(receipt["prUrl"] ?? "");
  return { base, baseSha, branch, dossier: readDossier(prUrl), prUrl, publish, receipt };
}
