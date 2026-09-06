import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import type { CommandHandlerInput } from "../http/http-contract.js";

it("routes production rollback to receipt resolution before any Docker effect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-rollback-production-"));
  const provider = createStoreDependencies({
    credential: randomUUID(), principalId: "operator-1", projectId: "project-1",
    repositoryWorkspace: directory, storePath: join(directory, "store.sqlite"),
  });
  try {
    const handler = provider.provide().registry.get("deployment.rollback")?.asyncHandler;
    expect(handler).toBeTypeOf("function");
    const input = { envelope: { commandId: "rollback-1", commandKind: "deployment.rollback",
      targetAggregateId: "project-1", expectedVersion: 0, correlationId: "rollback-1",
      payload: { environment: "staging", toReceiptRef: "a".repeat(64), restoreDatabase: false },
    }, principal: { principalId: "operator-1", projectId: "project-1", capabilities: [] } } as unknown as CommandHandlerInput;
    await expect(handler!(input)).rejects.toMatchObject({ code: "DEPLOY_ROLLBACK_RECEIPT_INVALID" });
  } finally {
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
