import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, PROJECT_ID, SUBJECT_REF } from "../review/review-test-fixtures.js";
import { recoveryEvidenceFixture } from "./repository-recovery-test-fixtures.js";
import { createRepositoryExecutionPort } from "./repository-execution-port.js";
import { createRepositoryRecoveryService } from "./repository-recovery-service.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "moe-recovery-service-")); roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true, shell: false });
  const store = openStore(); const port = createRepositoryExecutionPort();
  const acquired = port.acquire(root, { projectId: PROJECT_ID, nodeRef: "node-a", ownershipToken: "a".repeat(64), storeId: "store-a" },
    { controllerId: "controller-a", controllerPid: process.pid });
  if (!acquired.ok) throw new Error(acquired.code);
  let id = 0;
  const service = createRepositoryRecoveryService({ store, projectId: PROJECT_ID, storeId: "store-a", workspaces: () => [root],
    clock: () => "2026-09-06T00:00:00.000Z", mintId: () => `recovery-${++id}` });
  const command = () => {
    const reservation = service.readRecovery().reservations[0]!;
    const offer = reservation.actions.find((item) => item.action === "ABORT_UNEXECUTED")!.offer!;
    return { principalId: "operator", operatorPrincipalId: "operator", commandId: offer.commandId, correlationId: "correlation",
      expectedVersion: offer.expectedVersion, targetAggregateId: offer.targetAggregateId,
      payload: { action: "ABORT_UNEXECUTED", decision: "APPROVE", nodeRef: "node-a", expectedReservationRevision: reservation.expectedReservationRevision, reason: "Cancel before execution" } };
  };
  return { root, store, port, handle: acquired.handle, service, command };
}
describe("operator repository recovery", () => {
  it("accepts a durably paired human under its own authenticated principal", async () => {
    const f = fixture(); installTestRecoveryBinding(f.store);
    const paired = createOperatorSessionHandshakePort({ store: f.store, projectId: PROJECT_ID, operatorPrincipalId: "operator",
      clock: Date.now, capabilities: ["ADMIN"], sessionTtlMs: 60_000 }).mint();
    if (!paired.ok) throw new Error(paired.code);
    expect(await f.service.recover({ ...f.command(), principalId: paired.principalId })).toMatchObject({ ok: true, disposition: "COMMITTED" });
  }, 120_000);
  it("offers bounded preexecution recovery, requires human identity, and replays after a new owner acquires", async () => {
    const f = fixture(); const view = f.service.readRecovery();
    expect(view.reservations).toHaveLength(1); expect(JSON.stringify(view)).not.toContain(f.handle.owner.ownershipToken);
    expect(JSON.stringify(view)).not.toContain(f.root); const input = f.command();
    expect(await f.service.recover({ ...input, principalId: "worker" })).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_HUMAN_REQUIRED" });
    expect(f.port.inspect(f.root)).toMatchObject({ reservation: { phase: "RESERVED" } });
    expect(await f.service.recover(input)).toMatchObject({ ok: true, disposition: "COMMITTED", resultCode: "REPOSITORY_RECOVERY_RELEASED" });
    expect(f.port.inspect(f.root)).toEqual({ ok: true, reservation: null });
    expect(f.port.acquire(f.root, { ...f.handle.owner, nodeRef: "node-b", ownershipToken: "b".repeat(64) }, { controllerId: "next", controllerPid: process.pid }).ok).toBe(true);
    expect(await f.service.recover(input)).toMatchObject({ ok: true, disposition: "REPLAYED" });
    expect(f.port.inspect(f.root)).toMatchObject({ reservation: { nodeRef: "node-b" } });
    expect(await f.service.recover({ ...input, payload: { ...input.payload, reason: "changed request" } })).toMatchObject({ ok: false });
  }, 180_000);
  // DoD 4 end to end: a checkout wedged BEFORE this fix, by a landing that refused without
  // journaling anything, is offered a release by repository.recover and the release actually lands.
  it("releases a checkout wedged by a landing that journaled nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "moe-recovery-no-effect-")); roots.push(root);
    execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true, shell: false });
    const e = recoveryEvidenceFixture({ binding: { version: "moe-verified-workspace/1", root, branchRef: "refs/heads/trunk",
      headSha: "1".repeat(40), treeSha: "2".repeat(40), dirtySha256: "3".repeat(64) } });
    expect(e.landed({ commit: null, refusal: { code: "NOTHING_TO_COMMIT",
      detail: "no path in the workspace differs from the staffing baseline" } }).ok).toBe(true);
    const port = createRepositoryExecutionPort();
    const owner = { projectId: PROJECT_ID, nodeRef: SUBJECT_REF, ownershipToken: "c".repeat(64), storeId: "store-a" };
    const acquired = port.acquire(root, owner, { controllerId: "controller-a", controllerPid: process.pid });
    if (!acquired.ok) throw new Error(acquired.code);
    // Walked through the real transition table rather than written straight into BLOCKED.
    let handle = acquired.handle;
    const step = (patch: Record<string, unknown>) => {
      const next = port.transition(root, owner, handle.reservation.revision, { ...handle.reservation, ...patch });
      if (!next.ok) throw new Error(next.code);
      handle = next.handle;
    };
    step({ phase: "EXECUTING", baselineId: e.baseline.baselineId, sessionId: "session" });
    step({ phase: "VERIFYING" }); step({ phase: "AWAITING_LANDING" }); step({ phase: "LANDING" }); step({ phase: "BLOCKED" });
    let id = 0;
    const service = createRepositoryRecoveryService({ store: e.store, projectId: PROJECT_ID, storeId: "store-a",
      workspaces: () => [root], clock: () => "2026-09-06T00:00:03.000Z", mintId: () => `recovery-no-effect-${++id}` });
    const reservation = service.readRecovery().reservations[0]!;
    expect(reservation).toMatchObject({ nodeRef: SUBJECT_REF, phase: "BLOCKED" });
    // The abort action stays refused: this reservation did execute. Only the landing side reconciles it.
    expect(reservation.actions.find((item) => item.action === "ABORT_UNEXECUTED"))
      .toMatchObject({ available: false, code: "REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN" });
    const reconcile = reservation.actions.find((item) => item.action === "RECONCILE_LANDED")!;
    expect(reconcile).toMatchObject({ available: true, code: null });
    const offer = reconcile.offer!;
    expect(await service.recover({ principalId: "operator", operatorPrincipalId: "operator", commandId: offer.commandId,
      correlationId: "correlation", expectedVersion: offer.expectedVersion, targetAggregateId: offer.targetAggregateId,
      payload: { action: "RECONCILE_LANDED", decision: "APPROVE", nodeRef: SUBJECT_REF,
        expectedReservationRevision: reservation.expectedReservationRevision, reason: "The landing committed nothing" } }))
      .toMatchObject({ ok: true, disposition: "COMMITTED", resultCode: "REPOSITORY_RECOVERY_RELEASED" });
    expect(port.inspect(root)).toEqual({ ok: true, reservation: null });
  }, 180_000);

  it("refuses a stale revision before recording approval or releasing a changed reservation", async () => {
    const f = fixture(); const input = f.command();
    expect(f.port.transition(f.root, f.handle.owner, f.handle.reservation.revision,
      { ...f.handle.reservation, baselineId: "baseline" }).ok).toBe(true);
    expect(await f.service.recover(input)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_REVISION_CONFLICT" });
    expect(f.store.getAggregateVersion(input.targetAggregateId)).toBe(0);
    expect(f.port.inspect(f.root)).toMatchObject({ reservation: { phase: "RESERVED" } });
  }, 120_000);
});
