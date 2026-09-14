import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { SqliteEventStore } from "@moe/store";
import { recordSeatStart } from "../orchestrator/seat-start-ledger.js";
import { GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, closeStores, driveThrough, envelope, send } from "../bootstrap/bootstrap-test-fixtures.js";
import { approveGate1, approvePlan, committedRevision, PRD, submit } from "../planning/plan-reject-test-fixtures.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { readGraphBody } from "../planning/graph-body-record.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { readReviewSubmissionSource } from "../review/review-submission-source.js";
import { prepareReviewSubmissionPackage } from "../review/review-submission-package.js";
import { runReviewCommand } from "../review/review-services.js";
import { REVIEW_SCHEMA_VERSION } from "../review/review-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { createVerifiedWorkspacePort } from "./git-verified-workspace-port.js";
import { recordLandingBaseline } from "./landing-ledger.js";
import { createRepositoryExecutionPort } from "./repository-execution-port.js";
import { createRepositoryRecoveryService } from "./repository-recovery-service.js";
import { repositoryRecoveryOwnerDigest } from "./repository-landing-intent.js";
import type { RepositoryReviewDrainPort } from "./repository-review-drain-contracts.js";

const folders: string[] = [];
const stores: SqliteEventStore[] = [];
const NOW = "2026-08-30T12:05:00.000Z";
const EARLIER = "2026-08-30T12:00:00.000Z";
const STARTED = "2026-08-30T12:01:00.000Z";
export function closeReviewResumeWorlds(): void { closeStores(); for (const store of stores.splice(0)) store.close();
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); }

export interface ReviewResumeWorldOptions {
  readonly workspace?: string; readonly controllerPid?: number; readonly workerPid?: number; readonly sessionId?: string;
  readonly baselineAt?: string; readonly startedAt?: string; readonly reviewAt?: string; readonly clock?: () => string;
  readonly change?: () => void; readonly seat?: "bound" | "missing" | "foreign";
}
export async function createReviewResumeWorld(fixture: ReviewResumeWorldOptions = {}) {
  const { change } = fixture; const seat = fixture.seat ?? "bound";
  const directory = fixture.workspace ?? mkdtempSync(join(tmpdir(), "moe-review-resume-"));
  if (fixture.workspace === undefined) folders.push(directory);
  const storePath = join(directory, "store.sqlite");
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID); stores.push(store);
  installTestRecoveryBinding(store); driveThrough(store, "goal.create");
  expect(send(store, envelope("goal.create_with_source", 0, { instructions: "Bind a PRD for the dispatcher journey.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD }, title: "Dispatcher journey goal" }, GOAL_CREATE_COMMAND_ID)).ok).toBe(true);
  const revision = committedRevision(store);
  approveGate1(store, revision); const sealed = submit(store, revision);
  if (!sealed.ok) throw new Error(sealed.code);
  approvePlan(store, sealed.runId);
  const graph = readGraphBody(store, PROJECT_ID, sealed.graphContentHash);
  if (!graph.ok) throw new Error(graph.code);
  const nodeRef = compiledExecutionRef(PROJECT_ID, { content: graph.content, goalRef: GOAL_ID, planningRunRef: sealed.runId }, "node-slice");
  const workspace = realpathSync(directory);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args],
    { cwd: workspace, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(workspace, ".git", "info", "exclude"), "/store.sqlite*\n");
  writeFileSync(join(workspace, "app.txt"), "base\n"); git("add", "--", "app.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "base");
  const baseline = recordLandingBaseline(store, { projectId: PROJECT_ID, subjectRef: nodeRef, workspace, observedAt: fixture.baselineAt ?? EARLIER, entries: [] });
  if (!baseline.ok) throw new Error(baseline.code);
  const sessionId = fixture.sessionId ?? "resume-worker-session";
  if (seat !== "missing") expect(recordSeatStart(store, { projectId: PROJECT_ID, agentVersion: "UNKNOWN", provider: "private-test",
    sessionId: seat === "bound" ? sessionId : "foreign-worker-session", startedAt: fixture.startedAt ?? STARTED }).ok).toBe(true);
  writeFileSync(join(workspace, "app.txt"), "unfinished implementation\n");
  const captured = await createVerifiedWorkspacePort().capture(workspace);
  if (!captured.ok) throw new Error(captured.code);
  const source = readReviewSubmissionSource(store, PROJECT_ID, nodeRef);
  if (source === null) throw new Error("compiled scope missing");
  const prepared = prepareReviewSubmissionPackage({ source, binding: captured.binding, projectId: PROJECT_ID, subjectRef: nodeRef });
  const request = { kind: "review.submit", projectId: PROJECT_ID, principalId: sessionId, commandId: "initial-review",
    correlationId: "resume-test", decidedAt: fixture.reviewAt ?? NOW, expectedVersion: 0, schemaVersion: REVIEW_SCHEMA_VERSION,
    payload: { subjectRef: nodeRef, round: 1, packageItems: [], findings: [{ ruleId: "incomplete", severity: "MAJOR",
      subject: { kind: "NODE", locator: nodeRef }, detail: "Incomplete implementation" }] } };
  expect(runReviewCommand(store, new TextEncoder().encode(JSON.stringify(request)), undefined, prepared).ok).toBe(true);
  const port = createRepositoryExecutionPort();
  const owner = { projectId: PROJECT_ID, storeId: realpathSync.native(storePath), nodeRef, ownershipToken: "a".repeat(64) };
  const acquired = port.acquire(workspace, owner, { controllerId: "old-controller", controllerPid: fixture.controllerPid ?? 12345 });
  if (!acquired.ok) throw new Error(acquired.code);
  const executing = port.transition(workspace, owner, acquired.handle.reservation.revision, {
    ...acquired.handle.reservation, phase: "EXECUTING", baselineId: baseline.baselineId, sessionId, pid: fixture.workerPid ?? 23456 });
  if (!executing.ok) throw new Error(executing.code);
  const blocked = port.transition(workspace, owner, executing.handle.reservation.revision, { ...executing.handle.reservation, phase: "BLOCKED" });
  if (!blocked.ok) throw new Error(blocked.code);
  let drains = 0; let closes = 0;
  const reviewDrain: RepositoryReviewDrainPort = { drain: async () => {
    drains += 1; change?.();
    return { ok: true, evidence: { controllerPid: fixture.controllerPid ?? 12345, controllerStartedAt: EARLIER,
      brokerPid: 34567, brokerStartedAt: EARLIER, cliPid: 45678, daemonPid: 56789,
      observedAt: "2026-08-30T12:06:00.000Z", jobEmpty: true }, close: async () => { closes += 1; } };
  } };
  const options = { store, projectId: PROJECT_ID, storeId: owner.storeId, workspaces: () => [workspace],
    clock: fixture.clock ?? (() => "2026-08-30T12:06:01.000Z"), mintId: randomUUID, reviewDrain };
  const service = createRepositoryRecoveryService(options);
  const latest = readReviewLedger(store, PROJECT_ID, nodeRef).rounds.at(-1)!;
  const input = { principalId: "operator", operatorPrincipalId: "operator", commandId: "resume-one", correlationId: "resume-test",
    expectedVersion: 0, targetAggregateId: `repository-recovery:${repositoryRecoveryOwnerDigest(owner)}`,
    payload: { action: "RESUME_REVIEW", decision: "APPROVE", nodeRef, expectedReservationRevision: blocked.handle.reservation.revision,
      expectedReviewVersion: latest.aggregateVersion, expectedReviewDigest: latest.resultSha256, reason: "Resume the same unfinished work" } };
  return { store, workspace, git, port, owner, baseline, blocked: blocked.handle, service, input, options, request, prepared,
    drains: () => drains, closes: () => closes };
}
