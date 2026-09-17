import { describe, expect, it } from "vitest";

import type { ProjectCatalogEntry } from "./project-catalog.js";
import {
  PROJECT_MANAGER_LAUNCH_LAYER,
  prepareProjectManagerLaunch,
} from "./project-manager-launch.js";
import type { ProjectManagerLaunchFs } from "./project-manager-launch.js";

const CREDENTIAL = "a".repeat(64);
const CONFIG_PATH = "C:\\work\\alpha\\moe.config.json";
const ROOT = "C:\\work\\alpha";
const STORE_PATH = "C:\\work\\alpha\\store.sqlite";
const ENTRY: ProjectCatalogEntry = Object.freeze({
  configPath: CONFIG_PATH,
  instanceId: "11111111-1111-4111-8111-111111111111",
  projectId: "alpha",
  root: ROOT,
  storePath: STORE_PATH,
  title: "Alpha",
});

function config(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    credential: CREDENTIAL,
    projectId: "alpha",
    schemaVersion: "moe-cli-config/1",
    storePath: STORE_PATH,
    ...overrides,
  });
}

function fs(raw = config()): ProjectManagerLaunchFs {
  return Object.freeze({
    canonicalDirectory: (path: string) => path.replaceAll("/", "\\"),
    canonicalFile: (path: string) => path.replaceAll("/", "\\"),
    readConfig: () => raw,
  });
}

describe("prepareProjectManagerLaunch", () => {
  it("loads the credential server-side and emits only the reviewed environment", () => {
    const result = prepareProjectManagerLaunch(ENTRY, {
      ANTHROPIC_API_KEY: "provider-secret",
      MOE_DAEMON_CREDENTIAL: "caller-secret",
      // Server-owned like the four above: the opener measures whether an operator
      // channel exists; a caller's value must not assert one.
      MOE_OPERATOR_CHANNEL: "true",
      // Server-owned too: the opener binds the manager's own catalog, never a caller's.
      MOE_PROJECT_CATALOG: "C:\\foreign\\projects.json",
      MOE_PROJECT_ID: "foreign",
      MOE_PROJECT_INSTANCE_ID: "foreign-instance",
      MOE_STORE_PATH: "C:\\foreign.sqlite",
      NODE_OPTIONS: "--require=attacker.js",
      PATH: "C:\\Windows\\System32",
    }, fs());
    expect(result).toEqual({
      environment: {
        ANTHROPIC_API_KEY: "provider-secret",
        MOE_DAEMON_CREDENTIAL: CREDENTIAL,
        MOE_NODE_WORKSPACE: ROOT,
        MOE_PROJECT_ID: "alpha",
        PATH: "C:\\Windows\\System32",
      },
      ok: true,
    });
    expect(JSON.stringify(result)).not.toContain("caller-secret");
    expect(JSON.stringify(result)).not.toContain("attacker.js");
  });

  it("binds compiled work to the canonical registered root without an environment override", () => {
    const canonicalRoot = "C:\\Work\\Alpha";
    const result = prepareProjectManagerLaunch(ENTRY, {}, {
      canonicalDirectory: () => canonicalRoot,
      canonicalFile: () => `${canonicalRoot}\\moe.config.json`,
      readConfig: () => config(),
    });
    expect(result).toEqual({
      environment: {
        MOE_DAEMON_CREDENTIAL: CREDENTIAL,
        MOE_NODE_WORKSPACE: canonicalRoot,
        MOE_PROJECT_ID: "alpha",
      },
      ok: true,
    });
    if (!result.ok) throw new Error("expected the registered project launch");
    // An omitted test command remains omitted so the wrapper keeps its existing default.
    expect(Object.hasOwn(result.environment, "MOE_NODE_TEST_COMMAND")).toBe(false);
  });

  it.each(["MOE_NODE_WORKSPACE", "moe_node_workspace", "Moe_Node_Workspace"])(
    "replaces inherited %s with this project's canonical workspace",
    (name) => {
      expect(prepareProjectManagerLaunch(ENTRY, { [name]: "D:\\foreign-project" }, fs())).toEqual({
        environment: {
          MOE_DAEMON_CREDENTIAL: CREDENTIAL,
          MOE_NODE_WORKSPACE: ROOT,
          MOE_PROJECT_ID: "alpha",
        },
        ok: true,
      });
    },
  );

  it("refuses duplicate case-varied workspace variables", () => {
    expect(prepareProjectManagerLaunch(ENTRY, {
      MOE_NODE_WORKSPACE: "D:\\foreign-project",
      moe_node_workspace: "D:\\another-project",
    }, fs())).toEqual({
      code: "PROJECT_MANAGER_LAUNCH_ENVIRONMENT_INVALID",
      layer: PROJECT_MANAGER_LAUNCH_LAYER,
      ok: false,
    });
  });

  it("preserves the operator's compiled-node test command", () => {
    const testCommand = "pnpm exec vitest run --config vitest.integration.ts";
    expect(prepareProjectManagerLaunch(ENTRY, { MOE_NODE_TEST_COMMAND: testCommand }, fs())).toEqual({
      environment: {
        MOE_DAEMON_CREDENTIAL: CREDENTIAL,
        MOE_NODE_TEST_COMMAND: testCommand,
        MOE_NODE_WORKSPACE: ROOT,
        MOE_PROJECT_ID: "alpha",
      },
      ok: true,
    });
  });

  it.each([
    ["project id", config({ projectId: "beta" })],
    ["store", config({ storePath: "C:\\work\\beta\\store.sqlite" })],
    ["extra config key", config({ unexpected: true })],
    ["credential shape", config({ credential: "not-a-credential" })],
  ])("refuses a config whose %s does not match the catalog", (_name, raw) => {
    const result = prepareProjectManagerLaunch(ENTRY, {}, fs(raw));
    expect(result).toEqual({
      code: "PROJECT_MANAGER_LAUNCH_CONFIG_MISMATCH",
      layer: PROJECT_MANAGER_LAUNCH_LAYER,
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
  });

  it("refuses an unreadable config without disclosing the filesystem error", () => {
    const result = prepareProjectManagerLaunch(ENTRY, {}, {
      canonicalDirectory: () => { throw new Error(`leak-${CREDENTIAL}`); },
      canonicalFile: () => CONFIG_PATH,
      readConfig: () => config(),
    });
    expect(result).toEqual({
      code: "PROJECT_MANAGER_LAUNCH_CONFIG_UNREADABLE",
      layer: PROJECT_MANAGER_LAUNCH_LAYER,
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
  });

  it("rejects case-insensitive duplicate environment names", () => {
    expect(prepareProjectManagerLaunch(ENTRY, {
      PATH: "C:\\Windows",
      Path: "C:\\other",
    }, fs())).toEqual({
      code: "PROJECT_MANAGER_LAUNCH_ENVIRONMENT_INVALID",
      layer: PROJECT_MANAGER_LAUNCH_LAYER,
      ok: false,
    });
  });

  it("refuses a config path outside the registered project root", () => {
    const result = prepareProjectManagerLaunch({
      ...ENTRY,
      configPath: "C:\\work\\foreign\\moe.config.json",
    }, {}, fs());
    expect(result).toMatchObject({
      code: "PROJECT_MANAGER_LAUNCH_CONFIG_MISMATCH",
      layer: PROJECT_MANAGER_LAUNCH_LAYER,
      ok: false,
    });
  });
});
