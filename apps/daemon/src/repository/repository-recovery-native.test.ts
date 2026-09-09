import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeStores } from "../review/review-test-fixtures.js";
import { createRepositoryExecutionPort } from "./repository-execution-port.js";
import type { RepositoryExecutionHandle, RepositoryExecutionState } from "./repository-execution-contracts.js";
import { createVerifiedWorkspacePort } from "./git-verified-workspace-port.js";
import { recoveryEvidenceFixture } from "./repository-recovery-test-fixtures.js";
import { recordRepositoryLandingCompletion, recordRepositoryLandingIntent } from "./repository-landing-intent.js";
import { createRepositoryRecoveryService } from "./repository-recovery-service.js";
import { landingReceiptId } from "./landing-receipt-contracts.js";
import { readLandingReceipt } from "./landing-ledger.js";
const roots: string[] = [];
afterEach(() => { closeStores(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, shell: false, windowsHide: true, encoding: "utf8" }).trim();
it("reconciles a positively completed Git effect after wrapper loss without repeating Git or discarding staged and working edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "moe-recovery-native-")); roots.push(root);
  git(root, "init", "--quiet", "-b", "trunk"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.test");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, "owned.txt"), "before\n"); writeFileSync(join(root, "foreign.txt"), "foreign\n");
  git(root, "add", "--", "owned.txt", "foreign.txt"); git(root, "commit", "--quiet", "-m", "initial");
  writeFileSync(join(root, "owned.txt"), "verified output\n");
  const verifiedGit = createVerifiedWorkspacePort(); const captured = await verifiedGit.capture(root);
  if (!captured.ok) throw new Error(captured.code);
  const f = recoveryEvidenceFixture({ binding: captured.binding }); const port = createRepositoryExecutionPort();
  const acquired = port.acquire(root, f.handle.owner, { controllerId: "old-wrapper", controllerPid: process.pid });
  if (!acquired.ok) throw new Error(acquired.code);
  let handle: RepositoryExecutionHandle = acquired.handle;
  const change = (patch: Partial<RepositoryExecutionState>) => {
    const result = port.transition(root, handle.owner, handle.reservation.revision, { ...handle.reservation, ...patch });
    if (!result.ok) throw new Error(result.code); handle = result.handle;
  };
  change({ baselineId: f.baseline.baselineId }); change({ phase: "EXECUTING", sessionId: "contained-child" });
  change({ phase: "VERIFYING" }); change({ phase: "AWAITING_LANDING" }); change({ phase: "LANDING" });
  const intent = recordRepositoryLandingIntent(f.store, { handle, binding: captured.binding,
    verifierReceiptId: f.verified.receipt.receiptId, paths: ["owned.txt"], message: "land\n" });
  if (!intent.ok) throw new Error(intent.code);
  const committed = await verifiedGit.commit(root, ["owned.txt"], "land\n", captured.binding);
  if (!committed.ok) throw new Error(committed.code);
  expect(recordRepositoryLandingCompletion(f.store, { intent: intent.intent, commit: committed.receipt }).ok).toBe(true);
  change({ phase: "BLOCKED" }); // wrapper lost before recording the normal landing receipt
  writeFileSync(join(root, "foreign.txt"), "operator staged edit\n"); git(root, "add", "--", "foreign.txt");
  writeFileSync(join(root, "owned.txt"), "later uncommitted edit\n");
  const originalIndex = readFileSync(join(root, ".git", "index"));
  const service = createRepositoryRecoveryService({ store: f.store, projectId: handle.owner.projectId, storeId: handle.owner.storeId,
    workspaces: () => [root], mintId: () => "recover-completed", clock: () => "2026-09-06T00:00:05.000Z" });
  const view = service.readRecovery(); const held = view.reservations[0]!;
  const action = held.actions.find((item) => item.action === "RECONCILE_LANDED")!;
  expect(action).toMatchObject({ available: true, code: null });
  const offer = action.offer!;
  const result = await service.recover({ principalId: "operator", operatorPrincipalId: "operator", commandId: offer.commandId,
    correlationId: "correlation", expectedVersion: offer.expectedVersion, targetAggregateId: offer.targetAggregateId,
    payload: { action: action.action, decision: "APPROVE", nodeRef: held.nodeRef,
      expectedReservationRevision: held.expectedReservationRevision, reason: "Reconcile the recorded exact commit" } });
  expect(result).toMatchObject({ ok: true, resultCode: "REPOSITORY_RECOVERY_RELEASED" });
  expect(port.inspect(root)).toEqual({ ok: true, reservation: null });
  expect(readLandingReceipt(f.store, handle.owner.projectId, landingReceiptId(handle.owner.projectId, held.nodeRef, f.verified.receipt.receiptId)))
    .toMatchObject({ ok: true, receipt: { outcome: "COMMITTED", commit: { sha: committed.receipt.sha } } });
  expect(git(root, "rev-parse", "HEAD")).toBe(committed.receipt.sha);
  expect(readFileSync(join(root, ".git", "index"))).toEqual(originalIndex);
  expect(readFileSync(join(root, "owned.txt"), "utf8")).toBe("later uncommitted edit\n");
  expect(git(root, "show", ":foreign.txt")).toBe("operator staged edit");
}, 300_000);
