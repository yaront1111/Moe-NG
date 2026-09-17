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
import { decisionsOf } from "../decision-ledger-memo.js";

afterEach(closeReviewResumeWorlds);
type ReplanWorld = Awaited<ReturnType<typeof createReplanRecoveryWorld>>;

/** Stages a committed row on the node straight through the store seam, as no handler would write it. */
function stageOnNode(w: Pick<ReplanWorld, "store" | "owner" | "options">, commandKind: string, result: unknown, commandId: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(result));
  const staged = w.store.commitExpectedVersionDecision({ commandKind, targetAggregateId: w.owner.nodeRef,
    expectedVersion: w.store.getAggregateVersion(w.owner.nodeRef), committedResultBytes: bytes, requestBytes: bytes,
    key: { projectId: PROJECT_ID, principalId: "staged-agent", commandId }, correlationId: "replan-test",
    decidedAt: w.options.clock(), events: [{ eventId: `${commandId}-event`, eventType: "StagedDecision", payload: bytes }] });
  expect(staged.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

/** The release, its offer, its exact replay and every preserved byte, whatever came before the REPLAN. */
async function expectReleased(w: ReplanWorld) {
  const head = w.git("rev-parse", "HEAD"), app = readFileSync(join(w.workspace, "app.txt"));
  const index = readFileSync(join(w.workspace, ".git", "index"));
  const offered = w.service.readRecovery().reservations[0]?.actions.find((entry) => entry.action === "RELEASE_REPLANNED");
  expect(offered, JSON.stringify(offered)).toMatchObject({ available: true, code: null,
    expectedReviewVersion: w.input.payload.expectedReviewVersion, expectedReviewDigest: w.input.payload.expectedReviewDigest });
  const result = await w.service.recover(w.input);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, disposition: "COMMITTED", resultCode: "REPOSITORY_RECOVERY_RELEASED" });
  expect(w.drains()).toBe(1);
  expect(w.port.readOwned(w.workspace, w.owner.storeId, PROJECT_ID)).toMatchObject({ ok: true, handle: null });
  expect(w.git("rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(w.workspace, "app.txt"))).toEqual(app);
  expect(readFileSync(join(w.workspace, ".git", "index"))).toEqual(index);
  expect(await w.service.recover(w.input)).toMatchObject({ ok: true, disposition: "REPLAYED", resultCode: "REPOSITORY_RECOVERY_RELEASED" });
  expect(w.drains()).toBe(1);
  expect(readReviewLedger(w.store, PROJECT_ID, w.owner.nodeRef)).toMatchObject({ replanned: true, accepted: undefined });
}

async function expectRefusedAndHeld(w: ReplanWorld, input = w.input) {
  expect(await w.service.recover(input)).toMatchObject({ ok: false, code: "REPOSITORY_REPLAN_EVIDENCE_INVALID" });
  expect(w.drains()).toBe(0);
  expect(w.port.readOwned(w.workspace, w.owner.storeId, PROJECT_ID)).toMatchObject({ ok: true, handle: w.blocked });
}

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

/**
 * An agent's `qualification.replan` grants no authority (every node INVALIDATED), writes no Git
 * effect and leaves the latest round untouched, so it is no evidence against releasing a node a
 * human later retired. Measured by a drill: the review fold keeps `delta` for ever, and this gate
 * refused REPOSITORY_REPLAN_EVIDENCE_INVALID on every read of such a node.
 */
it("releases a human REPLAN on a node an agent re-planned before its later rounds", async () => {
  const w = await createReplanRecoveryWorld({ deltaAfterRound: 1 });
  const ledger = readReviewLedger(w.store, PROJECT_ID, w.owner.nodeRef);
  expect(ledger).toMatchObject({ version: 5, replanned: true, unreadable: false });
  expect(ledger.rounds.at(-1)?.aggregateVersion).toBe(4);
  expect(ledger.delta).toBeDefined();
  await expectReleased(w);
});

it("releases a human REPLAN recorded after an agent re-planned the exhausted review", async () => {
  const w = await createReplanRecoveryWorld({ deltaAfterRound: 3 });
  const ledger = readReviewLedger(w.store, PROJECT_ID, w.owner.nodeRef);
  expect(ledger).toMatchObject({ version: 5, replanned: true, unreadable: false });
  expect(ledger.rounds.at(-1)?.aggregateVersion).toBe(3);
  const replan = decisionsOf(w.store, 200).filter((row) => row.targetAggregateId === w.owner.nodeRef
    && row.effectDisposition === "EFFECTS_COMMITTED").at(-1)!;
  expect(replan).toMatchObject({ commandKind: "escalation.decide", previousVersion: 4, currentVersion: 5 });
  expect(JSON.parse(new TextDecoder().decode(replan.resultBytes))).toMatchObject({
    decision: "REPLAN", escalationRef: `ui-escalation-${w.owner.nodeRef}-v4` });
  await expectReleased(w);
});

// REVIEW_NODE_REPLANNED refuses a new re-plan after the REPLAN; a store written before that guard
// can still hold one, and then the human's decision no longer answers the node's latest state.
it("refuses a REPLAN a later agent re-plan followed, as a store written before REVIEW_NODE_REPLANNED holds", async () => {
  const w = await createReplanRecoveryWorld();
  stageOnNode(w, "qualification.replan", { classifications: [{ classification: "INVALIDATED", nodeRef: w.owner.nodeRef,
    reasonCodes: [], sourceHash: "", targetHash: "" }], successorPlanRef: "legacy-successor-plan" }, "legacy-replan-after-decision");
  const ledger = readReviewLedger(w.store, PROJECT_ID, w.owner.nodeRef);
  expect(ledger).toMatchObject({ version: 5, replanned: true, unreadable: false });
  // The version the reader answers at, so the refusal is the REPLAN evidence's and not a stale input's.
  await expectRefusedAndHeld(w, { ...w.input, payload: { ...w.input.payload, expectedReviewVersion: ledger.version } });
});

// Only a re-plan or an unspent human grant can reach a node between a failed round and its REPLAN.
// A neutral unknown kind, not a verifier receipt, which the common evidence refuses first.
it("refuses a REPLAN whose gap from the reviewed round holds a decision no review handler writes", async () => {
  const w = await createReplanRecoveryWorld({ beforeReplan: (world) => stageOnNode(world, "internal.test.unrelated", {}, "unrelated-in-gap") });
  expect(readReviewLedger(w.store, PROJECT_ID, w.owner.nodeRef)).toMatchObject({ version: 5, replanned: true, unreadable: false });
  await expectRefusedAndHeld(w);
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

/**
 * THE TRAP THIS PINS, measured on UnAI 2026-09-16. Governance retired two nodes by committing
 * `escalation.decide` REPLAN as `daemon:governor`. The retirement took effect — the nodes can
 * never pass review again — but this gate demands `isDurableHumanPrincipal`, so it refuses to
 * offer RELEASE_REPLANNED, and BOTH checkouts became unfreeable by any command. A second human
 * REPLAN cannot repair it either: `review-acceptance.ts` refuses an escalation on an already
 * replanned node.
 *
 * Governance no longer replans at all (it stops and asks), so this cannot recur — but the
 * combination is silent and permanent, so anyone re-enabling a non-human replan should meet
 * this assertion rather than discover it from two locked checkouts.
 */
it("refuses to release a REPLAN that no human authored, leaving the reservation held", async () => {
  const w = await createReplanRecoveryWorld({}, "governance");

  expect(readReviewLedger(w.store, PROJECT_ID, w.owner.nodeRef)).toMatchObject({ replanned: true });
  expect(await w.service.recover(w.input))
    .toMatchObject({ ok: false, code: "REPOSITORY_REPLAN_EVIDENCE_INVALID" });
  // Retired AND still holding: the node cannot progress and cannot let go.
  expect(w.port.readOwned(w.workspace, w.owner.storeId, PROJECT_ID)).toMatchObject({ ok: true, handle: w.blocked });
  expect(w.drains()).toBe(0);
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
