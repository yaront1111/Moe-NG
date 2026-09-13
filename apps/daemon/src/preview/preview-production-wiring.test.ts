import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GOAL_ID, PROJECT_ID, closeStores, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { activateV2Directly } from "../cutover/v2-activation-test-fixtures.js";
import { createStoreDependencies } from "../daemon-store-foundation-composition.js";
import { createDaemonV2CommandPorts } from "../daemon-v2-command-registry.js";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { previewRefusal } from "./preview-contracts.js";
import type { PreviewRunnerConfig } from "./preview-runner.js";
import { cleanupFixtureWorkspaces, fixtureWorkspace } from "./preview-test-fixtures.js";

const captured = vi.hoisted(() => ({ configs: [] as PreviewRunnerConfig[], starts: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("./preview-daemon-edge.js", async original => {
  const actual = await original<typeof import("./preview-daemon-edge.js")>();
  return { ...actual, createPreviewDaemonPort: (config: PreviewRunnerConfig) => {
    captured.configs.push(config);
    const runtime = actual.createPreviewDaemonPort(config);
    const start = vi.fn(runtime.supervisor.start); captured.starts.push(start);
    return { ...runtime, supervisor: { ...runtime.supervisor, start } };
  } };
});
const providers: ReturnType<typeof createStoreDependencies>[] = [];
afterEach(() => {
  for (const provider of providers.splice(0)) provider.close();
  captured.configs.length = 0; captured.starts.length = 0; closeStores(); cleanupFixtureWorkspaces();
});

function world() {
  const workspace = fixtureWorkspace({ scripts: {} });
  providers.push(createStoreDependencies({ clock: () => "2026-09-13T00:00:00.000Z", credential: "test-preview",
    principalId: "operator", projectId: PROJECT_ID, repositoryWorkspace: workspace,
    storePath: join(workspace, "store.db") }));
  const config = captured.configs.at(-1)!;
  return { store: config.store,
    provider: providers.at(-1)!, workspace };
}

it("composes the same configured supervisor into the shipped V2 command provider", async () => {
    const { store, provider, workspace } = world(); activateV2Directly(store, PROJECT_ID);
    const handler = provider.provideV2!().registry.get("preview.start")!.asyncHandler!;
    await expect(handler(startInput())).rejects.toMatchObject({ code: "PREVIEW_GOAL_NOT_LANDED", layer: "GOAL_AUTHORITY" });
    expect(captured.starts.at(-1)).toHaveBeenCalledExactlyOnceWith({ goalId: GOAL_ID, sha: "a".repeat(40), workspace });
    expect(captured.configs).toHaveLength(1);
});

function startInput() {
  return { envelope: { commandId: "preview-v2-start", commandKind: "preview.start" as const,
    correlationId: "preview-v2", expectedVersion: 0, payload: { goalId: GOAL_ID, sha: "a".repeat(40) },
    requestDigest: "b".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: "test-only", targetAggregateId: `preview:${GOAL_ID}` },
    principal: { capabilities: ["review.write"], principalId: "operator", projectId: PROJECT_ID } };
}

it("V2 preview.start reaches the configured supervisor and preserves the operator fence", async () => {
  const store = openStore(); const start = vi.fn(async () => ({ ok: false as const, receipt: null,
    refusal: previewRefusal("PREVIEW_GOAL_NOT_LANDED") }));
  activateV2Directly(store, PROJECT_ID);
  const ports = createDaemonV2CommandPorts({ clock: () => "2026-09-13T00:00:00.000Z", operatorPrincipalId: "operator",
    projectId: PROJECT_ID, store, previewWorkspace: "D:/configured-product", previewSupervisor: {
      start, active: () => [], close: async () => {}, decide: async () => true,
    } });
  const handler = ports.registry.get("preview.start")!.asyncHandler!;
  const input = startInput();
  await expect(handler({ ...input, principal: { ...input.principal, principalId: "other" } }))
    .rejects.toMatchObject({ code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" });
  expect(start).not.toHaveBeenCalled();
  await expect(handler(input)).rejects.toMatchObject({ code: "PREVIEW_GOAL_NOT_LANDED", layer: "GOAL_AUTHORITY" });
  expect(start).toHaveBeenCalledExactlyOnceWith({ goalId: GOAL_ID, sha: "a".repeat(40), workspace: "D:/configured-product" });
});
