import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it, vi } from "vitest";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { readRunGoalPublication } from "../http/run-goal-publication.js";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { createNodePublisher } from "../orchestrator/node-publisher.js";
import { createRepositoryDeliveryRuntime } from "../orchestrator/repository-delivery-runtime.js";
import { landingEnvironment, nodeGitRunner, type GitRunResult } from "./git-landing-port.js";
import { createGitPublicationPort, publicationGitRunner } from "./git-publication-port.js";
import { createPublicationCandidateReader } from "./publication-candidate.js";
import { readPublicationTransmission } from "./publication-effect-ledger.js";
import { readPublishLedger } from "./publish-ledger.js";
import { REPOSITORY_PUBLISH_COMMAND_KIND, publishAggregateId } from "./publish-receipt-contracts.js";
import { PUBLISH_RESOLVE_COMMAND_KIND } from "./publish-resolve-contracts.js";
import { createRepositoryExecutionPort } from "./repository-execution-port.js";
import type { RepositoryExecutionPort } from "./repository-execution-contracts.js";

/**
 * task-21be6e90, the whole operator exit for a publish stuck UNKNOWN, end to end on real git: a bare remote whose
 * pre-receive hook refuses, the production delivery runtime (its delivery pass, then the publisher's), and the
 * production command registry behind `createStoreDependencies`, so the operator fence is on the resolve's path.
 *
 * THE COMMAND RECORDS A FACT; THE HOLD'S OWNER GIVES IT BACK. `repository.publish_resolve` writes one REFUSED receipt
 * and cannot release the PUBLISHING hold, which belongs to the publisher's controller (CONTROLLER_MISMATCH for anyone
 * else). So between the command and the publisher's next pass the card already says REFUSED while a node delivery is
 * still turned away; the release, and the admission, come with that pass. Both halves are asserted in that order.
 */
const PROJECT = "publish-resolve-journey";
const OPERATOR = "operator-local";
const OPERATOR_CREDENTIAL = "publish-resolve-journey-operator";
const GOAL = "goal-publish-resolve-journey";
const REMOTE_URL = "https://github.com/fixture/resolve-journey.git";
const NOW = "2026-09-19T12:00:00.000Z";
const encoder = new TextEncoder();
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("LIVE: a push whose answer was lost stays UNKNOWN and holds every delivery; the operator resolves it; a fresh decision pushes once", async () => {
  const base = resolve(tmpdir()); const root = mkdtempSync(join(base, "moe-publish-resolve-journey-"));
  cleanup.push(() => { if (resolve(root).startsWith(`${base}${sep}`)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: landingEnvironment(),
    windowsHide: true, shell: false, encoding: "utf8", timeout: 30_000 }).replace(/\r?\n$/u, "");
  const workspace = join(root, "repo"); mkdirSync(workspace);
  git(workspace, "init", "--quiet", "--initial-branch=approved");
  writeFileSync(join(workspace, "product.txt"), "approved\n"); git(workspace, "add", "product.txt");
  git(workspace, "-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "approved");
  const captured = createPublicationCandidateReader(workspace)(REMOTE_URL);
  if (!captured.ok) throw new Error(captured.code);
  const candidate = captured.candidate; const sha = candidate.approval.sha;
  const remote = join(root, "remote.git"); git(root, "init", "--bare", "--quiet", remote);
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho refused by the fixture >&2\nexit 1\n", { mode: 0o755 });

  // The shipped provider and a second handle on the same store file, as the delivery runtime's own test composes them.
  const storePath = join(root, "store.db");
  const provider = createStoreDependencies({ credential: OPERATOR_CREDENTIAL, principalId: OPERATOR, projectId: PROJECT, storePath, repositoryWorkspace: null });
  cleanup.push(() => provider.close());
  const store = SqliteEventStore.openForProject(storePath, PROJECT); cleanup.push(() => store.close());
  installTestRecoveryBinding(store);
  const deps = provider.provide();

  // THE CASE THE AUTOMATIC RULE LEAVES UNKNOWN (task-78dea88b). The remote really refuses the first push (its hook exits 1),
  // but git's answer never reaches the publisher, as when a push outlives its 60 s timeout and is killed: no numeric exit, so
  // no REJECTED, so nothing proves "not transmitted". The push is recorded INDETERMINATE and only the operator, reading the
  // remote's tip on the card, may say the commit never landed. Only the push/ls-remote runner swaps the admitted https url
  // for the local bare remote, as the publisher's own LIVE arm does: nothing reaches a network.
  let pushes = 0; const lostAnswers: GitRunResult[] = [];
  const gitPort = createGitPublicationPort({ readConfig: nodeGitRunner, run: async (cwd, args) => {
    const answer = await publicationGitRunner(cwd, args.map((arg) => arg === REMOTE_URL ? remote : arg));
    if (!args.includes("push")) return answer;
    pushes += 1;
    if (pushes > 1) return answer;
    lostAnswers.push(answer);
    return { code: null, stderr: "", stdout: "" };
  } });
  const real = createRepositoryExecutionPort(); const releases: string[] = [];
  const repository: RepositoryExecutionPort = { ...real, release: (...args) => { releases.push(args[3]); return real.release(...args); } };
  const publisher = createNodePublisher({ git: gitPort, projectId: PROJECT, store, workspace, repository, storeId: realpathSync.native(storePath),
    controller: { controllerId: "journey-publisher", controllerPid: process.pid }, clock: () => NOW });
  const logs: string[] = [];
  const runtime = createRepositoryDeliveryRuntime({ compiledWorkspace: workspace, landingOn: true, nodes: () => [], log: (line) => logs.push(line),
    storePath, publisher,
    fence: { admit: () => ({ ok: false, code: "AGENT_STAFFING_CHILD_LIVE", layer: "WRAPPER_STAFFING" }), recordLiveChild: () => [], retireLiveChild: () => [] },
    verifier: { deps, mintId: randomUUID, nodeMission: () => null, operatorCredential: OPERATOR_CREDENTIAL, projectId: PROJECT, store,
      verificationAuthority: () => null, runTest: async () => { throw new Error("no node is verified on this journey"); } } });
  cleanup.push(() => runtime.close());

  /** The operator's approval, committed as `repository.publish` commits it (node-publisher.test.ts `decide`). */
  const decide = (commandId: string): string => store.commitExpectedVersionDecision({ commandKind: REPOSITORY_PUBLISH_COMMAND_KIND,
    committedResultBytes: encoder.encode(JSON.stringify({ candidate, goalId: GOAL, remoteUrl: REMOTE_URL })), correlationId: "publish-resolve-journey",
    decidedAt: NOW, events: [{ eventId: `${commandId}-requested`, eventType: "RepositoryPublishRequested", payload: encoder.encode("{}") }],
    expectedVersion: store.getAggregateVersion(publishAggregateId(GOAL)), key: { commandId, principalId: OPERATOR, projectId: PROJECT },
    requestBytes: encoder.encode("{}"), targetAggregateId: publishAggregateId(GOAL) }).decision.decisionId;
  /** One wrapper pass, and the publisher's lines it logged. */
  const pass = async (): Promise<string[]> => {
    const from = logs.length; await runtime.advance();
    return logs.slice(from).filter((line) => line.startsWith("[publisher]"));
  };
  const card = () => readRunGoalPublication(store, PROJECT, readPublishLedger(store, PROJECT).get(GOAL));
  /** The read-only admission the wrapper asks before it opens a session or claims a node for `node.deliver`. */
  const admission = () => runtime.admission("node-a", workspace);
  const resolveAs = (credential: string, commandId: string, decisionId: string) => handleAsyncCommandRequest(deps, {
    body: encoder.encode(JSON.stringify({ commandId, commandKind: PUBLISH_RESOLVE_COMMAND_KIND, correlationId: "publish-resolve-journey",
      expectedVersion: 0, payload: { decisionId, resolution: "NOT_TRANSMITTED" }, requestDigest: "a".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: credential, targetAggregateId: `publish-resolve:${decisionId}` })),
    credential, protocolVersion: WIRE_PROTOCOL_VERSION }, "HTTP_LISTENER");
  const stuck = (pass: string) => [`[publisher] ${GOAL}: UNKNOWN (PUBLISH_EFFECT_RECONCILIATION_REQUIRED: `
    + `remote approved is at absent, expected ${sha.slice(0, 10)}; ${pass})`];

  // (1) Approved, pushed once, refused by the remote, and the answer lost: UNKNOWN, on this pass and every later one.
  const first = decide("publish-1");
  expect(await pass()).toEqual(stuck("push refused PUBLISH_PUSH_UNKNOWN: git exited without a code"));
  expect(lostAnswers).toHaveLength(1); expect(lostAnswers[0]?.code).toBe(1);
  expect(lostAnswers[0]?.stderr).toContain("refused by the fixture");
  expect(git(root, `--git-dir=${remote}`, "for-each-ref")).toBe("");
  expect(readPublicationTransmission(store, PROJECT, GOAL, first)).toMatchObject({ outcome: "INDETERMINATE", tipBefore: null });
  expect(await pass()).toEqual(stuck("no push this pass (an intent was already journaled)"));
  expect(pushes).toBe(1);
  // (2) The hold stays PUBLISHING for this decision.
  expect(real.inspect(workspace)).toMatchObject({ ok: true, reservation: { nodeRef: `publish:${first}`, phase: "PUBLISHING" } });
  // (3) So every node delivery is turned away BUSY, the holder named; the delivery's own start refuses before any spawn.
  const heldByPublish = { ok: false, code: "REPOSITORY_EXECUTION_BUSY", layer: "REPOSITORY_DELIVERY",
    detail: `held by node publish:${first}: a release is publishing` };
  expect(admission()).toStrictEqual(heldByPublish);
  const spawn = vi.fn(async () => { throw new Error("a delivery refused BUSY never spawns"); });
  expect(await runtime.start(spawn)({ credential: "seat", expiresAt: "2027-01-01T00:00:00.000Z", kind: "node.deliver", mission: "implement",
    sessionId: randomUUID(), workItemId: "node.deliver@node-a", workspace })).toStrictEqual({ ok: false, code: "REPOSITORY_EXECUTION_BUSY", layer: "REPOSITORY_DELIVERY" });
  expect(spawn).not.toHaveBeenCalled();
  // (4) The Publish state read carries the last observation the operator decides on.
  expect(card()).toStrictEqual({ branch: "approved", code: "PUBLISH_EFFECT_RECONCILIATION_REQUIRED", decisionId: first,
    observation: { observedSha: null, expectedSha: sha, reason: "INDETERMINATE", observedAt: NOW }, outcome: "UNKNOWN",
    remoteUrl: REMOTE_URL, requestedAt: NOW, sha, url: null });

  // A NON-operator is refused by the resolve's own entry fence. This one is the owner's browser: a session minted by the
  // production pairing seam, a durable HUMAN holding ADMIN. The kind is not among the registry's paired-human widenings
  // (task-4f16c331 asks the owner to rule on one), so its entry answers, not the registry's sync fence, whose detail would
  // name a paired session. Nothing is written.
  const paired = createOperatorSessionHandshakePort({ capabilities: [CAPABILITIES.ADMIN], clock: Date.now, operatorPrincipalId: OPERATOR,
    projectId: PROJECT, reservedPrincipalIds: [OPERATOR], sessionTtlMs: 3_600_000, store }).mint();
  if (!paired.ok) throw new Error(paired.code);
  expect(isDurableHumanPrincipal(store, paired.principalId)).toBe(true);
  expect(await resolveAs(paired.credential, "resolve-by-paired-browser", first)).toMatchObject({ outcome: "PORT_REFUSED", stage: "DISPATCH",
    httpStatus: 403, refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION",
      detail: "this command requires the configured operator principal" } });
  expect(readPublishLedger(store, PROJECT).get(GOAL)?.receipts.size).toBe(0);

  // (5) The OPERATOR resolves it NOT_TRANSMITTED through the production registry.
  expect(await resolveAs(OPERATOR_CREDENTIAL, "resolve-by-operator", first)).toMatchObject({ outcome: "ACCEPTED", httpStatus: 200,
    decision: { commandId: "resolve-by-operator", disposition: "DECIDED", resultCode: "PUBLISH_RESOLVED_NOT_TRANSMITTED" } });
  // (6) One REFUSED receipt for that decision, carrying the observation; the card says REFUSED at once. The hold is not the
  // command's to give back, so until the publisher's next pass the delivery is still turned away by the same holder.
  const detail = `the operator resolved this publish as NOT_TRANSMITTED; last observation ${NOW}: remote tip absent, expected ${sha}, push INDETERMINATE`;
  expect(readPublishLedger(store, PROJECT).get(GOAL)?.receipts.get(first)).toMatchObject({ outcome: "REFUSED", decisionId: first,
    branch: "approved", sha, url: null, refusal: { code: "PUBLISH_RESOLVED_NOT_TRANSMITTED", detail } });
  expect(card()).toMatchObject({ outcome: "REFUSED", code: "PUBLISH_RESOLVED_NOT_TRANSMITTED", decisionId: first, observation: null });
  expect(real.inspect(workspace)).toMatchObject({ reservation: { nodeRef: `publish:${first}`, phase: "PUBLISHING" } });
  expect(releases).toEqual([]); expect(admission()).toStrictEqual(heldByPublish);
  expect(await pass()).toEqual([`[publisher] ${GOAL}: REFUSED (PUBLISH_RESOLVED_NOT_TRANSMITTED: ${detail})`]);
  expect(releases).toEqual(["PUBLISH_RESOLVED"]); expect(real.inspect(workspace)).toEqual({ ok: true, reservation: null });
  expect(pushes).toBe(1);
  // (7) The node delivery is admitted.
  expect(admission()).toBeNull();

  // (8) The remote accepts again, and a FRESH decision pushes exactly once. Until it holds the repository, deliveries yield to it.
  rmSync(hook);
  const second = decide("publish-2");
  expect(admission()).toStrictEqual({ ok: false, code: "REPOSITORY_EXECUTION_BUSY", layer: "REPOSITORY_DELIVERY",
    detail: `an approved publish of ${GOAL} is waiting for the repository` });
  expect(await pass()).toEqual([`[publisher] ${GOAL}: PUSHED (${sha.slice(0, 10)} approved -> ${REMOTE_URL})`]);
  expect(pushes).toBe(2); expect(releases).toEqual(["PUBLISH_RESOLVED", "PUBLISHED"]);
  expect(git(root, `--git-dir=${remote}`, "rev-parse", "refs/heads/approved")).toBe(sha);
  expect(card()).toMatchObject({ outcome: "PUSHED", decisionId: second, observation: null });
  // ONE transmission per decision, each journaled beside its own intent; later passes push nothing.
  expect(readPublicationTransmission(store, PROJECT, GOAL, first)).toMatchObject({ outcome: "INDETERMINATE" });
  expect(readPublicationTransmission(store, PROJECT, GOAL, second)).toMatchObject({ outcome: "ACCEPTED", tipBefore: null });
  expect(await pass()).toEqual([]); expect(pushes).toBe(2); expect(admission()).toBeNull();
  // Against a remote that HOLDS the sha, the publisher has already receipted PUSHED, so the resolve is refused as no
  // longer UNKNOWN (the service's REMOTE_HOLDS_SHA guard never gets to answer) and writes nothing.
  expect(await resolveAs(OPERATOR_CREDENTIAL, "resolve-after-push", second)).toMatchObject({ outcome: "PORT_REFUSED", stage: "DISPATCH",
    httpStatus: 422, refusal: { code: "PUBLISH_RESOLVE_NOT_UNKNOWN", layer: "DAEMON_PREREQUISITE", detail: "the publish already has a PUSHED receipt" } });
  expect(readPublishLedger(store, PROJECT).get(GOAL)?.receipts.size).toBe(2);
  // About 60 real git processes: seconds on an idle host, minutes when process spawns crawl under a loaded one.
}, 600_000);
