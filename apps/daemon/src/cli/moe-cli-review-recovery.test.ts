import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it, vi } from "vitest";
import { executeReviewRecovery, runProjectReviewRecovery } from "./moe-cli-review-recovery.js";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const offer = { commandEnvelopeVersion: "moe-runtime-command/1" as const,
  commandKind: "repository.recover", commandId: "recovery-command", expectedVersion: 3,
  inputSchemaVersion: "moe-repository-recovery/1", targetAggregateId: "recovery-owner" } as const;
function service(count = 1, available = true) {
  return { readRecovery: () => ({ version: "moe-repository-recovery/1" as const, projectId: "project", code: null,
    reservations: Array.from({ length: count }, (_, i) => ({ nodeRef: `node-${i}`, phase: "BLOCKED" as const,
      expectedReservationRevision: 146, actions: [{ action: "RESUME_REVIEW" as const, available,
        code: available ? null : "REPOSITORY_RECOVERY_REVIEW_UNREADABLE", offer: available ? offer : null,
        expectedReviewVersion: 7, expectedReviewDigest: "a".repeat(64) }] })) }),
    recover: vi.fn(async () => ({ ok: true as const, commandId: offer.commandId,
      disposition: "COMMITTED" as const, resultCode: "REPOSITORY_RECOVERY_RESUMED" as const })) };
}
it("submits exactly the offered review and reservation bindings with the local operator", async () => {
  const port = service();
  expect(await executeReviewRecovery(port, "operator-local", () => {})).toEqual({ ok: true });
  expect(port.recover).toHaveBeenCalledExactlyOnceWith({ principalId: "operator-local", operatorPrincipalId: "operator-local",
    commandId: offer.commandId, correlationId: offer.commandId, expectedVersion: 3, targetAggregateId: "recovery-owner",
    payload: { action: "RESUME_REVIEW", decision: "APPROVE", nodeRef: "node-0", expectedReservationRevision: 146,
      expectedReviewVersion: 7, expectedReviewDigest: "a".repeat(64), reason: "Operator requested blocked review recovery and restart." } });
});
it.each([0, 2])("refuses %i recovery candidates before any shutdown", async (count) => {
  const port = service(count);
  expect(await executeReviewRecovery(port, "operator-local", () => {}))
    .toEqual({ ok: false, code: "MOE_CLI_REVIEW_RECOVERY_SCOPE_AMBIGUOUS" });
  expect(port.recover).not.toHaveBeenCalled();
});
it("preserves the exact refusal and never dispatches an unavailable action", async () => {
  const port = service(1, false);
  expect(await executeReviewRecovery(port, "operator-local", () => {}))
    .toEqual({ ok: false, code: "REPOSITORY_RECOVERY_REVIEW_UNREADABLE" });
  expect(port.recover).not.toHaveBeenCalled();
});
it("does not create an absent project store", async () => {
  const root = mkdtempSync(join(tmpdir(), "moe-review-store-")); scratch.push(root);
  const storePath = join(root, "store.sqlite");
  expect(await runProjectReviewRecovery({ artifactRoot: root, projectRoot: root, env: {}, log: () => {},
    config: { credential: "private", projectId: "project", schemaVersion: "moe-config/1", storePath } }))
    .toEqual({ ok: false, code: "MOE_CLI_REVIEW_RECOVERY_STORE_UNAVAILABLE" });
  expect(existsSync(storePath)).toBe(false);
});
it("refuses a foreign project store before configuring any drain port", async () => {
  const root = mkdtempSync(join(tmpdir(), "moe-review-store-")); scratch.push(root);
  const storePath = join(root, "store.sqlite");
  const store = SqliteEventStore.openForProject(storePath, "foreign-project"); store.close();
  expect(await runProjectReviewRecovery({ artifactRoot: root, projectRoot: root, env: {}, log: () => {},
    config: { credential: "private", projectId: "project", schemaVersion: "moe-config/1", storePath } }))
    .toEqual({ ok: false, code: "MOE_CLI_REVIEW_RECOVERY_STORE_UNAVAILABLE" });
  const unchanged = SqliteEventStore.openForProject(storePath, "foreign-project");
  expect(unchanged.getHealth().projectId).toBe("foreign-project"); unchanged.close();
});
