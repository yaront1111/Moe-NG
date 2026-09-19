import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ALL_HANDLERS, GOAL_ID, PROJECT_ID, closeStores, decisionCount, driveThrough, envelope, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import { createRepositoryRemoteReadPort } from "../http/repository-remote-read.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { landingEnvironment } from "./git-landing-port.js";
import { createPublishRepository } from "./publish-services.js";
import { publicationRepositoryId } from "./publication-approval-contracts.js";
import type { PublicationCandidateReader } from "./publication-approval-contracts.js";
import { createPublicationCandidateReader } from "./publication-candidate.js";
import { readPublishLedger } from "./publish-ledger.js";
import { recordRemoteDefaultBranch } from "./remote-default-branch.js";

const REMOTE = "https://github.com/example/product.git";
const identity = { gitDirectory: "D:/product/.git", root: "D:/product" };
const approval = { branch: "delivery", remoteUrl: REMOTE, repositoryId: publicationRepositoryId(identity), sha: "a".repeat(40) };
const candidate = { approval, identity };
const encoder = new TextEncoder();
afterEach(closeStores);

function world(kind: "HUMAN" | "AGENT" = "HUMAN", integrated = true,
  read: PublicationCandidateReader = () => ({ candidate, ok: true })) {
  const store = openStore(); driveThrough(store, "repository.publish");
  const principal = createSessionAuthority(store, { clock: () => Date.parse("2026-09-06T00:00:00Z"), projectId: PROJECT_ID })
    .createPrincipal({ commandId: `principal-${kind}`, correlationId: "publication", principalId: "principal-1",
      kind, profileRevisionId: "profile-publication" });
  expect(principal.ok).toBe(true);
  let reads = 0;
  const handler = createPublishRepository({ validateGoal: () => integrated,
    readPublicationCandidate: (remoteUrl, target) => { reads += 1; return read(remoteUrl, target); } });
  const send = (approved: unknown, remoteUrl: unknown = REMOTE) => runBootstrapCommand(store,
    encoder.encode(JSON.stringify(envelope("repository.publish", 0, { approval: approved, goalId: GOAL_ID, remoteUrl }, "publish-approved"))),
    { ...ALL_HANDLERS, "repository.publish": handler });
  return { reads: () => reads, send, store };
}

describe("publication command approval", () => {
  it("records the exact daemon-observed tuple and canonical identity for a durable human", () => {
    const test = world();
    const result = test.send(approval);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(JSON.parse(new TextDecoder().decode(result.decision.resultBytes))).toEqual({
      candidate, goalId: GOAL_ID, remoteUrl: REMOTE, requestedAt: "2026-08-08T00:00:00.000Z",
    });
    expect(test.reads()).toBe(1);
    const event = test.store.readEvents(`publish:${GOAL_ID}`).find((row) => row.eventType === "RepositoryPublishRequested");
    expect(event).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(event!.payload))).toEqual({ approval, goalId: GOAL_ID,
      remoteUrl: REMOTE, requestedAt: "2026-08-08T00:00:00.000Z" });
    expect(test.send(approval)).toMatchObject({ ok: true });
    expect(test.reads()).toBe(1);
  });

  it.each([
    { ...approval, sha: "b".repeat(40) }, { ...approval, branch: "different" },
    { ...approval, repositoryId: "c".repeat(64) }, { ...approval, remoteUrl: "https://github.com/example/other.git" },
  ])("refuses a changed approval tuple before any durable mutation", (approved) => {
    const test = world(); const before = decisionCount(test.store);
    expect(test.send(approved)).toMatchObject({ ok: false, code: "PUBLISH_APPROVAL_STALE", refusedBy: "DAEMON_PREREQUISITE" });
    expect(decisionCount(test.store)).toBe(before);
  });

  it("refuses an agent principal even when its id matches the configured legacy operator", () => {
    const test = world("AGENT"); const before = decisionCount(test.store);
    expect(test.send(approval)).toMatchObject({ ok: false, code: "PUBLISH_HUMAN_REQUIRED", refusedBy: "DAEMON_AUTHORIZATION" });
    expect(test.reads()).toBe(0);
    expect(decisionCount(test.store)).toBe(before);
  });

  it("does not accept an unbound legacy approval", () => {
    const test = world(); const before = decisionCount(test.store);
    expect(test.send(undefined)).toMatchObject({ ok: false, code: "PUBLISH_APPROVAL_REQUIRED", refusedBy: "DAEMON_INGRESS" });
    expect(test.reads()).toBe(0);
    expect(decisionCount(test.store)).toBe(before);
  });
  it("refuses a candidate whose credited goal landings are absent from its ancestry", () => {
    const test = world("HUMAN", false); const before = decisionCount(test.store);
    expect(test.send(approval)).toMatchObject({ ok: false, code: "PUBLISH_GOAL_NOT_INTEGRATED", refusedBy: "DAEMON_PREREQUISITE" });
    expect(test.reads()).toBe(1); expect(decisionCount(test.store)).toBe(before);
  });
});

/**
 * THE PUSHED BRANCH IS ONE VALUE FROM PREVIEW TO PUSH. The operator approves the preview's
 * approval; the command re-reads the candidate and must equal it; node-publisher pushes the
 * command's RECORD (it reads `readPublishLedger`, and node-publisher.test.ts:123 pins that `push`
 * receives exactly the recorded candidate). Every read here is the PRODUCTION reader over a real
 * repository on `master`, so the recorded default picks the branch, not a fake.
 */
describe("the preview, the command and the recorded request agree on the pushed branch", () => {
  const base = resolve(tmpdir()); let root = "";
  const RELEASE = `moe/release/${GOAL_ID}`;
  beforeAll(() => {
    root = mkdtempSync(join(base, "moe-publication-agree-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: landingEnvironment(), windowsHide: true, shell: false, timeout: 15_000 });
    git("init", "--quiet", "--initial-branch=master"); writeFileSync(join(root, "product.txt"), "approved\n"); git("add", "product.txt");
    git("-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "approved");
  });
  afterAll(() => { if (resolve(root).startsWith(`${base}${sep}`)) rmSync(root, { recursive: true, force: true }); });

  const measure = (store: ReturnType<typeof openStore>, defaultBranch: string | null, measuredAt = "2026-09-19T00:00:00.000Z") =>
    expect(recordRemoteDefaultBranch(store, { projectId: PROJECT_ID, remoteUrl: REMOTE, defaultBranch, measuredAt })).toBe(true);
  /** The approval exactly as the operator's preview route shows it. */
  const preview = (store: ReturnType<typeof openStore>) => {
    const shown = createRepositoryRemoteReadPort({ projectId: PROJECT_ID, store, readPublicationCandidate: createPublicationCandidateReader(root) })
      .preparePublication?.(GOAL_ID, REMOTE);
    if (shown?.outcome !== "PUBLICATION_CANDIDATE") throw new Error(JSON.stringify(shown));
    return shown.approval;
  };
  const STALE = { ok: false, code: "PUBLISH_APPROVAL_STALE", refusedBy: "DAEMON_PREREQUISITE" };

  it.each([
    ["never measured", undefined, RELEASE], ["measured with no default", null, RELEASE],
    ["measured EQUAL to the workspace branch", "master", RELEASE], ["measured as a DIFFERENT branch", "main", "master"],
  ] as const)("accepts and records the previewed approval when the remote's default was %s", (_case, defaultBranch, branch) => {
    const test = world("HUMAN", true, createPublicationCandidateReader(root));
    if (defaultBranch !== undefined) measure(test.store, defaultBranch);
    const approved = preview(test.store);
    expect(approved.branch).toBe(branch);
    const result = test.send(approved);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.code);
    expect(JSON.parse(new TextDecoder().decode(result.decision.resultBytes))).toMatchObject({ candidate: { approval: approved } });
    // node-publisher's own read of what it pushes.
    expect(readPublishLedger(test.store, PROJECT_ID).get(GOAL_ID)?.requests.at(-1)?.candidate?.approval).toEqual(approved);
  }, 60_000);

  it.each([["main", "master", "master", RELEASE], ["master", "main", RELEASE, "master"]] as const)(
    "refuses PUBLISH_APPROVAL_STALE at DAEMON_PREREQUISITE when the default moves from %s to %s after the preview",
    (before, after, shownBranch, freshBranch) => {
      const test = world("HUMAN", true, createPublicationCandidateReader(root));
      measure(test.store, before);
      const approved = preview(test.store);
      expect(approved.branch).toBe(shownBranch);
      measure(test.store, after, "2026-09-19T00:01:00.000Z");
      const decisions = decisionCount(test.store);
      expect(test.send(approved)).toMatchObject(STALE);
      expect(decisionCount(test.store)).toBe(decisions);
      // The branch is the only thing that moved: a fresh preview differs there alone, and is accepted.
      const fresh = preview(test.store);
      expect(fresh).toEqual({ ...approved, branch: freshBranch });
      expect(test.send(fresh)).toMatchObject({ ok: true });
    }, 60_000);

  it("refuses PUBLISH_APPROVAL_STALE at DAEMON_PREREQUISITE when the command's read drops the target the preview passed", () => {
    const read = createPublicationCandidateReader(root);
    // A command caller that forgot the target reads the workspace branch, exactly as before targets existed.
    const test = world("HUMAN", true, (remoteUrl) => read(remoteUrl));
    const approved = preview(test.store);
    expect(approved.branch).toBe(RELEASE);
    const decisions = decisionCount(test.store);
    expect(test.send(approved)).toMatchObject(STALE);
    expect(decisionCount(test.store)).toBe(decisions);
  }, 60_000);
});

/**
 * THE PUBLISH PATH END TO END FOR A NO-EFFECT GOAL, through the REAL integration gate.
 *
 * `world()` above stubs `validateGoal`, which is the right seam for the arms that are about the
 * approval tuple. These two do not stub it, so `publicationGoalIntegrated` itself decides, and
 * the arm is the handler's own answer rather than a fixture's.
 *
 * "Nothing to push" records PUSHED BY DESIGN and this row adds no NOTHING_TO_PUBLISH outcome:
 * `git push` of a sha the remote already carries exits 0 (git-publication-port.ts:66-68) and the
 * publish receipt outcome is a closed PUSHED|REFUSED pair (publish-receipt-contracts.ts:46,
 * :159-163) that a third value would move eight sites. The command below is the REQUEST leg —
 * a committed `repository.publish` decision plus its RepositoryPublishRequested event.
 */
describe("publication over a goal whose only node landed nothing", () => {
  function liveWorld(refusalCode: string) {
    const store = openStore(); driveThrough(store, "repository.publish");
    const principal = createSessionAuthority(store, { clock: () => Date.parse("2026-09-06T00:00:00Z"), projectId: PROJECT_ID })
      .createPrincipal({ commandId: "principal-live", correlationId: "publication", principalId: "principal-1",
        kind: "HUMAN", profileRevisionId: "profile-publication" });
    expect(principal.ok).toBe(true);
    const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
    const nodeRef = compiledExecutionRef(PROJECT_ID, graph, "node-a");
    seedReviewAcceptance(store, nodeRef);
    seedLandingReceipt(store, nodeRef, { refusalCode });
    // No `validateGoal`: publish-services.ts:103 falls through to the real gate.
    const handler = createPublishRepository({ readPublicationCandidate: () => ({ candidate, ok: true }) });
    const send = () => runBootstrapCommand(store,
      encoder.encode(JSON.stringify(envelope("repository.publish", 0, { approval, goalId: GOAL_ID, remoteUrl: REMOTE }, "publish-no-effect"))),
      { ...ALL_HANDLERS, "repository.publish": handler });
    return { send, store };
  }

  it("PROCEEDS for NOTHING_TO_COMMIT — the request is decided at the candidate sha", () => {
    const test = liveWorld("NOTHING_TO_COMMIT");
    const before = decisionCount(test.store);

    const result = test.send();

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.code);
    expect(JSON.parse(new TextDecoder().decode(result.decision.resultBytes))).toEqual({
      candidate, goalId: GOAL_ID, remoteUrl: REMOTE, requestedAt: "2026-08-08T00:00:00.000Z",
    });
    expect(decisionCount(test.store)).toBe(before + 1);
    const event = test.store.readEvents(`publish:${GOAL_ID}`).find((row) => row.eventType === "RepositoryPublishRequested");
    expect(event).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(event!.payload))).toMatchObject({ approval, goalId: GOAL_ID });
  });

  it("refuses PUBLISH_GOAL_NOT_INTEGRATED at DAEMON_PREREQUISITE for GIT_COMMIT_FAILED", () => {
    // Same world, one refusal-code literal changed. The CODE and the LAYER are both asserted, so
    // an unrelated gate answering first (authorization, ingress, expected-version) reds this arm.
    const test = liveWorld("GIT_COMMIT_FAILED");
    const before = decisionCount(test.store);

    expect(test.send()).toMatchObject({
      ok: false, code: "PUBLISH_GOAL_NOT_INTEGRATED", refusedBy: "DAEMON_PREREQUISITE",
    });
    expect(decisionCount(test.store)).toBe(before);
  });
});
