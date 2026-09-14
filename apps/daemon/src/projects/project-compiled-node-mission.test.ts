import { PassThrough } from "node:stream";

import { openWindowsProjectStackBoundary } from "@moe/runner";
import { afterEach, describe, expect, it } from "vitest";

import { GOAL_ID, PROJECT_ID, closeStores } from "../bootstrap/bootstrap-test-fixtures.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { createCompiledNodeSource } from "../orchestrator/compiled-node-source.js";
import { readGraphBody } from "../planning/graph-body-record.js";
import {
  approveGate1, approvePlan, boundWorld, committedRevision, submit,
} from "../planning/plan-reject-test-fixtures.js";
import type { ProjectCatalogEntry } from "./project-catalog.js";
import { prepareProjectManagerLaunch } from "./project-manager-launch.js";

const ROOT = "C:\\Work\\Compiler Project";
const STORE_PATH = `${ROOT}\\store.sqlite`;
const ENTRY: ProjectCatalogEntry = {
  configPath: `${ROOT}\\moe.config.json`,
  instanceId: "11111111-1111-4111-8111-111111111111",
  projectId: PROJECT_ID,
  root: ROOT,
  storePath: STORE_PATH,
  title: "Compiled project",
};

afterEach(closeStores);

/** Decode the native broker's length-prefixed launch record, including every environment pair. */
function environmentFromControl(control: Uint8Array): Readonly<Record<string, string>> {
  const view = new DataView(control.buffer, control.byteOffset, control.byteLength);
  expect([...control.subarray(0, 2)]).toEqual([1, 3]);
  expect(view.getUint32(2, true)).toBe(control.length - 6);
  let offset = 6;
  const count = (): number => { const value = view.getUint16(offset, true); offset += 2; return value; };
  const text = (): string => {
    const length = count();
    const value = new TextDecoder("utf-8", { fatal: true }).decode(control.subarray(offset, offset + length));
    offset += length;
    return value;
  };
  expect(text()).toBe(STORE_PATH);
  expect(text()).toBe("C:\\Program Files\\nodejs\\node.exe");
  const argv = Array.from({ length: count() }, text);
  expect(argv).toEqual([
    "--experimental-transform-types",
    "C:\\Moe\\apps\\daemon\\src\\projects\\project-stack-host-main.ts",
    `--config=${ENTRY.configPath}`, "--asset-root=C:\\Moe\\control-room",
  ]);
  expect(text()).toBe("C:\\Moe");
  const environment: Record<string, string> = {};
  for (let remaining = count(); remaining > 0; remaining -= 1) {
    const name = text();
    expect(Object.hasOwn(environment, name)).toBe(false);
    environment[name] = text();
  }
  expect(offset).toBe(control.length);
  expect(environment["MOE_STORE_PATH"]).toBe(STORE_PATH);
  expect(environment["MOE_PROJECT_ID"]).toBe(PROJECT_ID);
  return environment;
}

async function launchedEnvironment(
  source: Readonly<Record<string, string | undefined>> = {},
): Promise<Readonly<Record<string, string>>> {
  const prepared = prepareProjectManagerLaunch(ENTRY, source, {
    canonicalDirectory: (path) => path,
    canonicalFile: (path) => path,
    readConfig: () => JSON.stringify({ credential: "a".repeat(64), projectId: PROJECT_ID,
      schemaVersion: "moe-cli-config/1", storePath: STORE_PATH }),
  });
  if (!prepared.ok) throw new Error(`project launch refused: ${prepared.code}`);
  let control: Uint8Array = new Uint8Array(0);
  let exited: (code: number | null, signal: string | null) => void = () => {};
  const streams = [new PassThrough(), new PassThrough(), new PassThrough()] as const;
  // Only the OS process is replaced. The public boundary admits and encodes the real launch.
  const boundary = openWindowsProjectStackBoundary({
    assetRoot: "C:\\Moe\\control-room", configPath: ENTRY.configPath, cwd: "C:\\Moe",
    entryPath: "C:\\Moe\\apps\\daemon\\src\\projects\\project-stack-host-main.ts",
    environment: prepared.environment, instanceId: ENTRY.instanceId,
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe", storePath: STORE_PATH,
  }, { deps: {
    platform: "win32", resolveBroker: () => "C:\\Moe\\broker.exe",
    spawn: () => ({
      pid: 42, providerStdin: streams[0], providerStdout: streams[1], providerStderr: streams[2],
      writeControl: (bytes) => { control = bytes; }, endControl: () => {},
      closeProviderChannels: () => {}, kill: () => {},
      dispose: () => { for (const stream of streams) stream.destroy(); },
      onStatus: () => {}, onError: () => {}, onExit: (listener) => { exited = listener; },
    }),
  } });
  if ("truthClass" in boundary) {
    for (const stream of streams) stream.destroy();
    throw new Error(`native launch refused: ${boundary.code}`);
  }
  // Finish the fake broker; no provider process or runtime is started by this test.
  exited(20, null);
  await boundary.completed;
  return environmentFromControl(control);
}

function sealedWorld() {
  const store = boundWorld();
  const revision = committedRevision(store);
  approveGate1(store, revision);
  const sealed = submit(store, revision);
  if (!sealed.ok) throw new Error(`compile refused: ${sealed.code}`);
  const graph = readGraphBody(store, PROJECT_ID, sealed.graphContentHash);
  if (!graph.ok) throw new Error(`sealed graph refused: ${graph.code}`);
  const nodeRef = compiledExecutionRef(PROJECT_ID, {
    content: graph.content, goalRef: GOAL_ID, planningRunRef: sealed.runId,
  }, "node-slice");
  return { nodeRef, runId: sealed.runId, store };
}

describe("compiled node missions through the project stack launch", () => {
  it.each([
    ["the default verification command", {}, "pnpm test"],
    ["the operator's verification command", {
      MOE_NODE_WORKSPACE: "D:\\Foreign project",
      MOE_NODE_TEST_COMMAND: "pnpm exec vitest run --config vitest.integration.ts",
    }, "pnpm exec vitest run --config vitest.integration.ts"],
  ] as const)("briefs an approved compiled node using %s", async (_label, input, expectedTest) => {
    const world = sealedWorld();
    approvePlan(world.store, world.runId);
    const environment = await launchedEnvironment(input);
    const source = createCompiledNodeSource({
      projectId: PROJECT_ID, store: world.store,
      workspace: environment["MOE_NODE_WORKSPACE"] ?? null,
      testCommand: environment["MOE_NODE_TEST_COMMAND"] ?? "pnpm test",
    });
    const before = world.store.readEventHorizon();
    expect(source.nodes()).toEqual([{
      dependsOn: [], nodeRef: world.nodeRef, title: "Land the record read and its page.",
    }]);
    expect(source.mission(world.nodeRef)).toEqual({
      instructions: [
        `Compiled goalRef: ${GOAL_ID}`,
        "Land the record read and its page.", "",
        "Acceptance criteria from the approved Product Contract (every one must hold and stay verifiable):",
        "- [crit-api] The API answers a signed request with the record.",
        "- [crit-ui] The page renders the record the API answered.",
      ].join("\n"),
      test: expectedTest, title: "Land the record read and its page.", workspace: ROOT,
    });
    expect(world.store.readEventHorizon()).toBe(before);
  });

  it("grants no mission or durable effects to a sealed plan awaiting human approval", async () => {
    const world = sealedWorld();
    const environment = await launchedEnvironment();
    const source = createCompiledNodeSource({
      projectId: PROJECT_ID, store: world.store,
      workspace: environment["MOE_NODE_WORKSPACE"] ?? null,
      testCommand: environment["MOE_NODE_TEST_COMMAND"] ?? "pnpm test",
    });
    const before = world.store.readEventHorizon();
    expect(source.nodes()).toEqual([]);
    expect(source.mission(world.nodeRef)).toBeNull();
    expect(world.store.readEventHorizon()).toBe(before);
    expect(world.store.getAggregateVersion(GOAL_ID)).toBe(1);
  });
});
