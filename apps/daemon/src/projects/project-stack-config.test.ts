import { describe, expect, it } from "vitest";

import {
  PROJECT_STACK_ARGUMENTS_INVALID,
  PROJECT_STACK_CONFIG_INVALID,
  PROJECT_STACK_CONFIG_MISMATCH,
  PROJECT_STACK_HOST_LAYER,
  PROJECT_STACK_PATH_UNRESOLVED,
  resolveProjectStackConfig,
} from "./project-stack-config.js";
import type { ProjectStackConfigFs } from "./project-stack-config.js";

const CONFIG_PATH = "C:\\work\\alpha\\moe.config.json";
const ASSET_ROOT = "C:\\Moe\\control-room";
const STORE_PATH = "C:\\work\\alpha\\store.sqlite";
const CREDENTIAL = "ab".repeat(32);
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    credential: CREDENTIAL,
    projectId: "alpha",
    schemaVersion: "moe-cli-config/1",
    storePath: STORE_PATH,
    ...overrides,
  });
}

function fs(raw = config()): ProjectStackConfigFs {
  return {
    canonicalDirectory: (path) => path.replace("\\.\\", "\\"),
    canonicalFile: (path) => path.replace("\\.\\", "\\"),
    readConfig: () => raw,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    argv: [`--config=${CONFIG_PATH}`, `--asset-root=${ASSET_ROOT}`],
    env: {
      MOE_DAEMON_CREDENTIAL: CREDENTIAL,
      MOE_PROJECT_ID: "alpha",
      MOE_PROJECT_INSTANCE_ID: INSTANCE_ID,
      MOE_STORE_PATH: STORE_PATH,
    },
    fs: fs(),
    ...overrides,
  };
}

describe("resolveProjectStackConfig", () => {
  it("proves and freezes the exact config/environment binding", () => {
    const result = resolveProjectStackConfig(input());
    if (!result.ok) throw new Error(result.code);
    expect(result.bindings).toEqual({
      assetRoot: ASSET_ROOT,
      configPath: CONFIG_PATH,
      credential: CREDENTIAL,
      instanceId: INSTANCE_ID,
      projectId: "alpha",
      projectRoot: "C:\\work\\alpha",
      storePath: STORE_PATH,
    });
    expect(Object.isFrozen(result.bindings)).toBe(true);
  });

  it("canonicalizes aliases before comparing the store identity", () => {
    const aliasedConfig = "C:\\work\\alpha\\.\\moe.config.json";
    const aliasedStore = "C:\\work\\alpha\\.\\store.sqlite";
    const result = resolveProjectStackConfig(input({
      argv: [`--config=${aliasedConfig}`, `--asset-root=${ASSET_ROOT}`],
      env: {
        MOE_DAEMON_CREDENTIAL: CREDENTIAL,
        MOE_PROJECT_ID: "alpha",
        MOE_PROJECT_INSTANCE_ID: INSTANCE_ID,
        MOE_STORE_PATH: aliasedStore,
      },
      fs: fs(config({ storePath: aliasedStore })),
    }));
    if (!result.ok) throw new Error(result.code);
    expect(result.bindings.configPath).toBe(CONFIG_PATH);
    expect(result.bindings.storePath).toBe(STORE_PATH);
  });

  it.each([
    ["credential", { MOE_DAEMON_CREDENTIAL: "cd".repeat(32) }],
    ["project", { MOE_PROJECT_ID: "other" }],
    ["store", { MOE_STORE_PATH: "C:\\work\\other\\store.sqlite" }],
  ])("refuses a %s mismatch without disclosing either credential", (_name, envOverride) => {
    const current = input();
    const result = resolveProjectStackConfig({
      ...current,
      env: { ...current.env, ...envOverride },
    });
    expect(result).toEqual({
      code: PROJECT_STACK_CONFIG_MISMATCH, layer: PROJECT_STACK_HOST_LAYER, ok: false,
    });
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
  });

  it.each([
    ["extra argv", { ...input(), argv: [...input().argv, "--shell=cmd.exe"] }, PROJECT_STACK_ARGUMENTS_INVALID],
    ["relative config", { ...input(), argv: ["--config=moe.config.json", `--asset-root=${ASSET_ROOT}`] }, PROJECT_STACK_ARGUMENTS_INVALID],
    ["foreign config name", { ...input(), argv: ["--config=C:\\work\\alpha\\other.json", `--asset-root=${ASSET_ROOT}`] }, PROJECT_STACK_ARGUMENTS_INVALID],
    ["invalid instance", { ...input(), env: { ...input().env, MOE_PROJECT_INSTANCE_ID: "../alpha" } }, PROJECT_STACK_CONFIG_INVALID],
    ["extra config field", { ...input(), fs: fs(config({ token: "secret" })) }, PROJECT_STACK_CONFIG_INVALID],
    ["short credential", { ...input(), fs: fs(config({ credential: "secret" })) }, PROJECT_STACK_CONFIG_INVALID],
    ["oversized config", { ...input(), fs: fs("x".repeat(65_537)) }, PROJECT_STACK_CONFIG_INVALID],
  ])("fails closed for %s", (_name, value, code) => {
    expect(resolveProjectStackConfig(value)).toEqual({
      code, layer: PROJECT_STACK_HOST_LAYER, ok: false,
    });
  });

  it("names unresolved paths without including the hostile path", () => {
    const broken: ProjectStackConfigFs = {
      ...fs(),
      canonicalFile: () => { throw new Error("C:\\secret\\do-not-echo"); },
    };
    const result = resolveProjectStackConfig(input({ fs: broken }));
    expect(result).toEqual({
      code: PROJECT_STACK_PATH_UNRESOLVED, layer: PROJECT_STACK_HOST_LAYER, ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("do-not-echo");
  });
});
