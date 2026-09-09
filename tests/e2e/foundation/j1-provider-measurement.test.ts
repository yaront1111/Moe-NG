import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { readProviderVersion } from "../../../apps/daemon/src/bootstrap/activation-provider-version.js";
import {
  createJ1Scratch, killTree, runSeed, startDaemon, writeAgentShim,
} from "./j1-loop-harness.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const value = createJ1Scratch();
  roots.push(value.root);
  return value;
}

it("measures the scripted provider's own version without starting a seat", async () => {
  const project = scratch();
  const result = await readProviderVersion(writeAgentShim(project, "complete"));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("moe-e2e-scripted-agent 1.0.0");
  expect(existsSync(project.agentPidFile)).toBe(false);
}, 30_000);

it("activates the scripted journey independently of an unavailable inherited provider", async () => {
  const project = scratch();
  vi.stubEnv("MOE_AGENT_COMMAND", join(project.root, "no-provider-here"));
  const daemon = await startDaemon(project);
  try {
    const seed = await runSeed(project, daemon.origin);
    expect(seed.code, seed.output).toBe(0);
  } finally {
    await killTree(daemon.child);
  }
}, 120_000);

it("preserves the production unmeasured-provider refusal for an explicit missing command", async () => {
  const project = scratch();
  const daemon = await startDaemon(project, {
    MOE_AGENT_COMMAND: join(project.root, "explicit-missing-provider"),
  });
  try {
    const seed = await runSeed(project, daemon.origin);
    expect(seed.code).toBe(1);
    expect(seed.output).toContain(
      "code=ACTIVATION_PROVIDER_UNMEASURED layer=DAEMON_ACTIVATION_RECEIPTS stage=DISPATCH",
    );
  } finally {
    await killTree(daemon.child);
  }
}, 120_000);
