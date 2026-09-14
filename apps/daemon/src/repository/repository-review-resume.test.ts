import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { runSessionCommand } from "../identity/session-services.js";
import { SESSION_SCHEMA_VERSION } from "../identity/session-contracts.js";
import { PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { runReviewCommand } from "../review/review-services.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { createRepositoryRecoveryService } from "./repository-recovery-service.js";
import { repositoryRecoveryOwnerDigest } from "./repository-landing-intent.js";
import { withReviewResumeStoreLock } from "./repository-review-resume-lock.js";
import { createReviewResumeWorld, closeReviewResumeWorlds } from "./repository-review-resume-test-fixtures.js";

const NOW = "2026-08-30T12:05:00.000Z";
afterEach(closeReviewResumeWorlds);
const world = (change?: () => void, seat: "bound" | "missing" | "foreign" = "bound") =>
  createReviewResumeWorld({ ...(change === undefined ? {} : { change }), seat });

it("resumes the original reservation after trusted drain without changing application or review authority", async () => {
  const w = await world(); const head = w.git("rev-parse", "HEAD");
  const index = readFileSync(join(w.workspace, ".git", "index")); const app = readFileSync(join(w.workspace, "app.txt"));
  expect(await w.service.recover(w.input)).toMatchObject({ ok: true, disposition: "COMMITTED", resultCode: "REPOSITORY_RECOVERY_RESUMED" });
  const held = w.port.readOwned(w.workspace, w.owner.storeId, PROJECT_ID);
  expect(held).toMatchObject({ ok: true, handle: { owner: w.owner, reservation: {
    phase: "RESERVED", baselineId: w.baseline.baselineId, sessionId: null, pid: null, revision: w.blocked.reservation.revision + 1 } } });
  expect(w.git("rev-parse", "HEAD")).toBe(head); expect(readFileSync(join(w.workspace, ".git", "index"))).toEqual(index);
  expect(readFileSync(join(w.workspace, "app.txt"))).toEqual(app);
  expect(readReviewLedger(w.store, PROJECT_ID, w.owner.nodeRef)).toMatchObject({ version: 1, accepted: undefined });
  expect(w.drains()).toBe(1); expect(w.closes()).toBe(1);
  expect(await w.service.recover(w.input)).toMatchObject({ ok: true, disposition: "REPLAYED", resultCode: "REPOSITORY_RECOVERY_RESUMED" });
  expect(w.drains()).toBe(1);
});

it("keeps hosted recovery unavailable without the trusted maintenance drain adapter", async () => {
  const w = await world(); const { reviewDrain: _drain, ...options } = w.options;
  expect(await createRepositoryRecoveryService(options).recover(w.input))
    .toMatchObject({ ok: false, code: "REPOSITORY_REVIEW_DRAIN_UNAVAILABLE" });
  expect(w.port.inspect(w.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
  expect(w.store.getAggregateVersion(w.input.targetAggregateId)).toBe(0);
});

it("offers the exact current review version and digest without disclosing private ownership", async () => {
  const w = await world();
  const action = w.service.readRecovery().reservations[0]!.actions.find((item) => item.action === "RESUME_REVIEW");
  expect(action).toMatchObject({ available: true, expectedReviewVersion: 1, expectedReviewDigest: w.input.payload.expectedReviewDigest });
  expect(JSON.stringify(action)).not.toContain(w.owner.ownershipToken);
  expect(JSON.stringify(action)).not.toContain(w.workspace);
});

it.each(["expectedReviewVersion", "expectedReviewDigest"] as const)("refuses stale %s before native effects or approval", async (key) => {
  const w = await world();
  expect(await w.service.recover({ ...w.input, payload: { ...w.input.payload, [key]: key === "expectedReviewVersion" ? 2 : "b".repeat(64) } }))
    .toMatchObject({ ok: false, code: "REPOSITORY_REVIEW_VERSION_CONFLICT" });
  expect(w.drains()).toBe(0); expect(w.store.getAggregateVersion(w.input.targetAggregateId)).toBe(0);
});

it.each(["workspace", "review", "controller"] as const)("refuses %s changes during trusted drain and closes the retained handle", async (kind) => {
  let change = (): void => undefined;
  const w = await world(() => change());
  change = () => {
    if (kind === "workspace") writeFileSync(join(w.workspace, "app.txt"), "concurrent application edit\n");
    else if (kind === "controller") expect(w.port.claimController(w.workspace, w.owner, w.blocked.reservation.revision,
      { controllerId: "concurrent-controller", controllerPid: 67890 }).ok).toBe(true);
    else expect(runReviewCommand(w.store, new TextEncoder().encode(JSON.stringify({ ...w.request,
      commandId: "concurrent-review", expectedVersion: 1, payload: { ...w.request.payload, round: 2,
        findings: [{ ...w.request.payload.findings[0], ruleId: "different-incomplete" }] } })), undefined, w.prepared).ok).toBe(true);
  };
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: kind === "workspace" ? "REPOSITORY_REVIEW_WORKSPACE_CHANGED"
    : kind === "controller" ? "REPOSITORY_RECOVERY_REVISION_CONFLICT" : "REPOSITORY_REVIEW_EVIDENCE_CHANGED" });
  expect(w.port.inspect(w.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
  expect(w.closes()).toBe(1);
}, 30_000);

it("retries an approved command after native drain refuses without minting another approval", async () => {
  const w = await world(); let attempts = 0;
  const service = createRepositoryRecoveryService({ ...w.options, reviewDrain: { drain: async (input) => {
    if (++attempts === 1) return { ok: false, code: "RUNTIME_REVIEW_DRAIN_ACCESS_DENIED", detail: "RUNTIME_REVIEW_DRAIN_ACCESS_DENIED" };
    return w.options.reviewDrain.drain(input);
  } } });
  expect(await service.recover(w.input)).toMatchObject({ ok: false, code: "RUNTIME_REVIEW_DRAIN_ACCESS_DENIED" });
  expect(w.store.getAggregateVersion(w.input.targetAggregateId)).toBe(1);
  expect(await service.recover(w.input)).toMatchObject({ ok: true, resultCode: "REPOSITORY_RECOVERY_RESUMED" });
  expect(w.store.getAggregateVersion(w.input.targetAggregateId)).toBe(1);
});

it("refuses a still-live worker bearer before offering or draining recovery", async () => {
  const w = await world();
  expect(runSessionCommand(w.store, new TextEncoder().encode(JSON.stringify({ kind: "session.open", projectId: PROJECT_ID,
    principalId: "operator", commandId: "live-worker-bearer", correlationId: "resume-test", decidedAt: NOW,
    expectedVersion: 0, schemaVersion: SESSION_SCHEMA_VERSION, payload: { sessionId: w.blocked.reservation.sessionId,
      capabilities: ["review.write", "work.write"], credentialSha256: "c".repeat(64), expiresAt: "2026-08-30T13:00:00.000Z" } }))).ok).toBe(true);
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_REVIEW_AUTHORITY_LIVE" });
  expect(w.port.inspect(w.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } }); expect(w.closes()).toBe(0);
  expect(w.drains()).toBe(0); expect(w.store.getAggregateVersion(w.input.targetAggregateId)).toBe(0);
  expect(w.service.readRecovery().reservations[0]!.actions.find((action) => action.action === "RESUME_REVIEW"))
    .toMatchObject({ available: false, code: "REPOSITORY_REVIEW_AUTHORITY_LIVE", offer: null });
});

it("holds the actual project writer lock for the reservation CAS callback", async () => {
  const w = await world(); let invoked = false;
  const contender = new DatabaseSync(w.owner.storeId);
  try {
    expect(withReviewResumeStoreLock({ store: w.store, storeId: w.owner.storeId,
      dataVersion: w.store.readCommandDecisionCacheVersion(), horizon: w.store.readEventHorizon() }, () => {
      invoked = true; expect(() => contender.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      return { ok: true, fenced: true };
    })).toEqual({ ok: true, fenced: true });
    expect(invoked).toBe(true);
    contender.exec("BEGIN IMMEDIATE"); contender.exec("ROLLBACK");
  } finally { contender.close(); }
});

it.each(["missing", "different review", "nonempty job"])("refuses a resumed replay whose native proof is %s without draining twice", async (kind) => {
  const w = await world();
  expect(await w.service.recover(w.input)).toMatchObject({ ok: true, resultCode: "REPOSITORY_RECOVERY_RESUMED" });
  const database = new DatabaseSync(join(w.workspace, ".git", "moe-repository-execution.sqlite"));
  try {
    const row = database.prepare("SELECT decision_key,request_json FROM recovery_decisions").get()!;
    const request = JSON.parse(row["request_json"] as string) as Record<string, unknown>;
    if (kind === "missing") delete request["proof"];
    else {
      const proof = request["proof"] as { reviewDigest: string; drain: { jobEmpty: boolean } };
      if (kind === "different review") proof.reviewDigest = "d".repeat(64);
      else proof.drain.jobEmpty = false;
    }
    database.prepare("UPDATE recovery_decisions SET request_json=? WHERE decision_key=?")
      .run(JSON.stringify(request), row["decision_key"] as string);
  } finally { database.close(); }
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_RECEIPT_UNKNOWN" });
  expect(w.drains()).toBe(1);
});

it.each(["controller", "future identity", "stale observation"])("refuses invalid native %s evidence and retains ownership", async (kind) => {
  const w = await world();
  const service = createRepositoryRecoveryService({ ...w.options, reviewDrain: { drain: async (input) => {
    const result = await w.options.reviewDrain.drain(input);
    if (!result.ok) return result;
    const evidence = { ...result.evidence, ...(kind === "controller" ? { controllerPid: 11111 }
      : kind === "future identity" ? { controllerStartedAt: "2026-08-30T12:01:01.000Z" }
      : { observedAt: "2026-08-30T12:05:00.000Z" }) };
    return { ...result, evidence };
  } } });
  expect(await service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_REVIEW_DRAIN_INVALID" });
  expect(w.closes()).toBe(1); expect(w.port.inspect(w.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
});

it.each(["missing", "foreign"] as const)("refuses a %s durable seat start before native effects", async (seat) => {
  const w = await world(undefined, seat);
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_REVIEW_SEAT_START_INVALID" });
  expect(w.drains()).toBe(0); expect(w.store.getAggregateVersion(w.input.targetAggregateId)).toBe(0);
});

it("refuses worker authority that reopens during drain before changing the reservation", async () => {
  let reopen = (): void => undefined;
  const w = await world(() => reopen());
  reopen = () => {
    expect(runSessionCommand(w.store, new TextEncoder().encode(JSON.stringify({ kind: "session.open", projectId: PROJECT_ID,
      principalId: "operator", commandId: "concurrent-worker-bearer", correlationId: "resume-test", decidedAt: NOW,
      expectedVersion: 0, schemaVersion: SESSION_SCHEMA_VERSION, payload: { sessionId: w.blocked.reservation.sessionId,
        capabilities: ["review.write", "work.write"], credentialSha256: "c".repeat(64), expiresAt: "2026-08-30T13:00:00.000Z" } }))).ok).toBe(true);
  };
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_REVIEW_AUTHORITY_LIVE" });
  expect(w.closes()).toBe(1); expect(w.port.inspect(w.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
});

it.each(["internal.integration.verifier_receipt", "internal.repository.landing_intent"])("refuses unresolved %s before native effects", async (commandKind) => {
  const w = await world();
  const targetAggregateId = commandKind === "internal.integration.verifier_receipt" ? w.owner.nodeRef
    : `repository-landing:${repositoryRecoveryOwnerDigest(w.owner)}`;
  const bytes = new TextEncoder().encode("{}");
  w.store.commitExpectedVersionDecision({ commandKind, targetAggregateId, expectedVersion: w.store.getAggregateVersion(targetAggregateId),
    committedResultBytes: bytes, requestBytes: bytes, key: { projectId: PROJECT_ID, principalId: "operator", commandId: "unresolved-effect" },
    correlationId: "resume-test", decidedAt: NOW, events: [{ eventId: "unresolved-effect-event", eventType: "UnresolvedEffect", payload: bytes }] });
  expect(await w.service.recover(w.input)).toMatchObject({ ok: false, code: "REPOSITORY_REVIEW_EFFECTS_UNRESOLVED" });
  expect(w.drains()).toBe(0); expect(w.store.getAggregateVersion(w.input.targetAggregateId)).toBe(0);
});
