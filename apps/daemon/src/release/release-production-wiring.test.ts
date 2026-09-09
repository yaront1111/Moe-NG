import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import type { CommandHandlerInput } from "../http/http-contract.js";

it.each(["V1", "V2"] as const)("composes release while retaining the %s authority gate", async (plane) => {
  const directory = mkdtempSync(join(tmpdir(), "moe-release-production-"));
  const provider = createStoreDependencies({
    credential: randomUUID(), principalId: "operator-1", projectId: "project-1",
    repositoryWorkspace: directory, storePath: join(directory, "store.sqlite"),
  });
  try {
    const ports = plane === "V1" ? provider.provide() : provider.provideV2!();
    const handler = ports.registry.get("release.decide")?.asyncHandler;
    expect(handler).toBeTypeOf("function");
    const input = { envelope: { commandId: "release-1", commandKind: "release.decide",
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: randomUUID(), requestDigest: "b".repeat(64),
      targetAggregateId: "release:goal-1", expectedVersion: 0, correlationId: "release-1", payload: {
      base: "main", decision: "APPROVE", goalId: "goal-1", sha: "a".repeat(40),
    } }, principal: { principalId: "operator-1", projectId: "project-1", capabilities: [] } } as unknown as CommandHandlerInput;
    await expect(handler!(input)).rejects.toMatchObject({
      code: plane === "V1" ? "RELEASE_REMOTE_MISSING" : "CUTOVER_V2_NOT_ACTIVE",
    });
  } finally {
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
