import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { closeReviewResumeWorlds } from "./repository-review-resume-test-fixtures.js";
import { createReplanRecoveryWorld } from "./repository-replan-recovery-test-fixtures.js";
import { createReviewResumeWorld } from "./repository-review-resume-test-fixtures.js";
import { createRepositoryRecoveryService } from "./repository-recovery-service.js";
import { repositoryRecoveryOwnerDigest } from "./repository-landing-intent.js";
import { runWorkClaimCommand } from "../work/work-claim-services.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "../work/work-claim-contracts.js";

afterEach(closeReviewResumeWorlds);

it("releases a human-replanned reservation after native drain while preserving the exact reviewed commit", async () => {
  const w = await createReplanRecoveryWorld();
  const head = w.git("rev-parse", "HEAD"), app = readFileSync(join(w.workspace, "app.txt"));
  const index = readFileSync(join(w.workspace, ".git", "index"));
  const result = await w.service.recover(w.input);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, disposition: "COMMITTED", resultCode: "REPOSITORY_RECOVERY_RELEASED" });
  expect(w.port.readOwned(w.workspace, w.owner.storeId, PROJECT_ID)).toMatchObject({ ok: true, handle: null });
  expect(w.git("rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(w.workspace, "app.txt"))).toEqual(app);
  expect(readFileSync(join(w.workspace, ".git", "index"))).toEqual(index);
  expect(readReviewLedger(w.store, PROJECT_ID, w.owner.nodeRef)).toMatchObject({ version: 4, replanned: true, accepted: undefined });
  expect(readReviewLedger(w.store, PROJECT_ID, w.owner.nodeRef).continuation).toBeUndefined();
  expect(w.drains()).toBe(1); expect(w.closes()).toBe(1);
  const successor = { ...w.owner, nodeRef: "new-reviewed-plan-node", ownershipToken: "d".repeat(64) };
  expect(w.port.acquire(w.workspace, successor, { controllerId: "new-runtime", controllerPid: 78901 }).ok).toBe(true);
  expect(await w.service.recover(w.input)).toMatchObject({ ok: true, disposition: "REPLAYED", resultCode: "REPOSITORY_RECOVERY_RELEASED" });
  expect(w.drains()).toBe(1);
});

it.each(["ordinary", "--skip-worktree", "--assume-unchanged"])("retains dirty work even when Git hides it (%s)", async (flag) => {
  const w = await createReplanRecoveryWorld();
  if (flag !== "ordinary") w.git("update-index", flag, "app.txt");
  writeFileSync(join(w.workspace, "app.txt"), "foreign work must survive\n");
  const index = readFileSync(join(w.workspace, ".git", "index"));
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_REPLAN_WORKSPACE_DIRTY" });
  expect(w.drains()).toBe(0);
  expect(readFileSync(join(w.workspace, ".git", "index"))).toEqual(index);
  expect(readFileSync(join(w.workspace, "app.txt"), "utf8")).toBe("foreign work must survive\n");
  expect(w.port.readOwned(w.workspace, w.owner.storeId, PROJECT_ID)).toMatchObject({ ok: true, handle: w.blocked });
});

it("requires a durable REPLAN before any drain", async () => {
  const w = await createReviewResumeWorld();
  expect(await w.service.recover({ ...w.input, payload: { ...w.input.payload, action: "RELEASE_REPLANNED" } }))
    .toMatchObject({ ok: false, code: "REPOSITORY_REPLAN_EVIDENCE_INVALID" });
  expect(w.drains()).toBe(0);
});

it("does not release a different clean committed tree", async () => {
  const w = await createReplanRecoveryWorld();
  writeFileSync(join(w.workspace, "app.txt"), "later work\n"); w.git("add", "app.txt");
  w.git("-c", "user.name=Human", "-c", "user.email=human@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "later work");
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_REPLAN_WORKSPACE_CHANGED" });
  expect(w.drains()).toBe(0);
});

it("rechecks physical bytes after native drain and preserves changed work", async () => {
  let w: Awaited<ReturnType<typeof createReplanRecoveryWorld>>;
  w = await createReplanRecoveryWorld({ change: () => writeFileSync(join(w.workspace, "app.txt"), "concurrent work\n") });
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_REPLAN_WORKSPACE_DIRTY" });
  expect(w.drains()).toBe(1); expect(w.closes()).toBe(1);
  expect(w.port.readOwned(w.workspace, w.owner.storeId, PROJECT_ID)).toMatchObject({ ok: true, handle: w.blocked });
});

it("requires retired staffing for every worker before draining the project Job", async () => {
  const w = await createReplanRecoveryWorld();
  w.fence.recordLiveChild({ sessionId: "successor-session", workItemId: "design.create@successor", childPid: 99001, claimAggregateVersion: 1 });
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_REVIEW_AUTHORITY_LIVE" });
  expect(w.drains()).toBe(0);
});

it("requires positive native containment, preserving reservation on unavailable proof", async () => {
  const w = await createReplanRecoveryWorld();
  const service = createRepositoryRecoveryService({ ...w.options, reviewDrain: { drain: async () => ({ ok: false, code: "REPOSITORY_REVIEW_DRAIN_IDENTITY_MISMATCH", detail: "identity mismatch" }) } });
  expect(await service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_REVIEW_DRAIN_IDENTITY_MISMATCH" });
  expect(w.port.readOwned(w.workspace, w.owner.storeId, PROJECT_ID)).toMatchObject({ ok: true, handle: w.blocked });
});

it.each(["internal.integration.verifier_receipt", "internal.repository.landing_intent"])("preserves unresolved %s effects", async (commandKind) => {
  const w = await createReplanRecoveryWorld();
  const targetAggregateId = commandKind === "internal.integration.verifier_receipt" ? w.owner.nodeRef
    : `repository-landing:${repositoryRecoveryOwnerDigest(w.owner)}`;
  const bytes = new TextEncoder().encode("{}");
  w.store.commitExpectedVersionDecision({ commandKind, targetAggregateId, expectedVersion: w.store.getAggregateVersion(targetAggregateId),
    committedResultBytes: bytes, requestBytes: bytes, key: { projectId: PROJECT_ID, principalId: "operator", commandId: "unresolved-effect" },
    correlationId: "replan-test", decidedAt: w.options.clock(), events: [{ eventId: "unresolved-effect-event", eventType: "UnresolvedEffect", payload: bytes }] });
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_REVIEW_EFFECTS_UNRESOLVED" });
  expect(w.drains()).toBe(0);
});

it("does not drain a newly claimed successor before its staffing record exists", async () => {
  const w = await createReplanRecoveryWorld();
  expect(runWorkClaimCommand(w.store, new TextEncoder().encode(JSON.stringify({ kind: "work.claim", schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
    projectId: PROJECT_ID, principalId: "new-worker", commandId: "new-claim", correlationId: "replan-test", decidedAt: w.options.clock(),
    expectedVersion: 0, payload: { workItemId: "design.create@new-goal", expiresAt: "2026-08-30T13:00:00.000Z" } }))).ok).toBe(true);
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_REVIEW_AUTHORITY_LIVE" });
  expect(w.drains()).toBe(0);
});

it.each(["expectedReviewVersion", "expectedReviewDigest"])("refuses stale %s before approval or native effects", async (key) => {
  const w = await createReplanRecoveryWorld();
  expect(await w.service.recover({ ...w.input, payload: { ...w.input.payload, [key]: key === "expectedReviewVersion" ? 3 : "b".repeat(64) } }))
    .toMatchObject({ ok: false, code: "REPOSITORY_REVIEW_VERSION_CONFLICT" });
  expect(w.drains()).toBe(0); expect(w.store.getAggregateVersion(w.input.targetAggregateId)).toBe(0);
});

it("does not replay a release with altered REPLAN proof", async () => {
  const w = await createReplanRecoveryWorld();
  expect(await w.service.recover(w.input)).toMatchObject({ ok: true });
  const database = new DatabaseSync(join(w.workspace, ".git", "moe-repository-execution.sqlite"));
  try {
    const row = database.prepare("SELECT decision_key, request_json FROM recovery_decisions").get()!;
    const request = JSON.parse(row["request_json"] as string); request.proof.reviewVersion = 3;
    database.prepare("UPDATE recovery_decisions SET request_json=? WHERE decision_key=?").run(JSON.stringify(request), row["decision_key"] as string);
  } finally { database.close(); }
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_RECEIPT_UNKNOWN" });
  expect(w.drains()).toBe(1);
});
