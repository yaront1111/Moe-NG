import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import * as profile from "../repository/controlled-profile/controlled-profile-generator.js";
import { nodeGitRunner } from "../repository/git-landing-port.js";
import { bootstrapRequestBytes } from "../repository/repository-bootstrap-command.js";

import { launchDelivery } from "./environment-launch-resolver.js";
import type { EnvironmentStoreConfig } from "./environment-projection.js";
import { setEnvironmentVariable } from "./environment-store.js";
import { agentEnvironment } from "../orchestrator/agent-spawn-environment.js";
import { createVerifierDatabaseRunner } from "../orchestrator/verifier-database.js";
import { cleanUp, configFor, NOW, openMemoryStore, PROJECT_ID } from "./environment-test-fixtures.js";

/**
 * THE PRODUCTION COMPOSITION PATH, END TO END, WITH A REAL CHILD PROCESS.
 *
 * WHY A UNIT TEST CANNOT DISCHARGE THIS. Every arm in `environment-launch-resolver.test.ts` stops
 * at the resolver's return value, and every arm in `environment-delivery.test.ts` INJECTS
 * `delivered` straight into a runner. Neither one proves that a value an operator actually stored
 * reaches an actual child, because neither crosses the seam this row exists to build: the store,
 * the resolver, the composition, the spawn. So this file starts where an operator starts - a
 * sealed write through `setEnvironmentVariable` - and finishes where the risk is, in a process
 * that either did or did not receive the plaintext.
 *
 * THE TWO HALVES ARE ONE PROPERTY AND ARE USELESS APART. "The child received it" alone is
 * satisfied by a delivery that also prints the secret into every log; "it appears in no captured
 * byte" alone is satisfied by a delivery that never happened. Asserted together, in the same
 * test, over the same run.
 *
 * THE CHILD REPORTS A DIGEST, NEVER THE VALUE. Only a process holding the exact bytes can write
 * `sha256(value)`, so receipt is still read from the CHILD'S OWN evidence - but the raw value is
 * then absent from every captured byte, which lets the sweep assert the strictly stronger claim
 * (nowhere at all) instead of having to carve out the child's own echo. Printing the secret to
 * prove it arrived would also put it in a CI transcript, which is exactly what this epic's third
 * rail forbids. It is written to a FILE rather than stdout for the same reason: stdout is the
 * thing being swept.
 *
 * THE CANARY IS DELIBERATELY NOT CREDENTIAL-SHAPED. A plausible-looking key in a committed test
 * trips secret scanners and becomes its own incident, so the value is an obviously-synthetic
 * marker with a random tail: unique enough that a substring hit cannot be a coincidence, and
 * unmistakably not a secret to anything that scans this file.
 */

const CANARY_NAME = "LAUNCH_CANARY_MARKER";
const HOST_ONLY = "HOST_ONLY_SECRET";

const temporaryDirectories: string[] = [];

/** DoD 4 is post-bootstrap, NOT automatic: task-f1e40296's registered
 * product_contract.sync_env_example reads approved contract names and commits them later.
 * Pin the actual bootstrap SUPPLY so adding even an empty names list reopens this limitation.
 * This observes the real generator without replacing it; git and the registered edge are real. */
it("bootstrap supplies no contract names until product_contract.sync_env_example runs", async () => {
  const workspace = temporaryWorkspace();
  const generate = vi.spyOn(profile, "generateControlledProfile");
  try {
    const store = openMemoryStore();
    const principal = { capabilities: ["project.admin"], principalId: "operator-env", projectId: PROJECT_ID };
    const payload = { dir: join(workspace, "product"), productName: "supply-check",
      profileVersion: profile.CONTROLLED_PROFILE_VERSION };
    const envelope = { commandId: "bootstrap-supply", commandKind: "repository.bootstrap",
      correlationId: "bootstrap-supply", expectedVersion: 0, payload,
      requestDigest: "b".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: "unused-at-handler", targetAggregateId: "bootstrap-supply" } as const;
    expect(runBootstrapCommand(store, bootstrapRequestBytes("project.register", PROJECT_ID, NOW,
      { owner: "operator-env" }, { ...envelope, commandId: "register-supply" }, principal.principalId)))
      .toMatchObject({ ok: true });
    const ports = createDaemonCommandPorts({ clock: () => NOW, operatorPrincipalId: principal.principalId,
      projectId: PROJECT_ID, store, repositoryBootstrap: { catalog: async () => {} } });
    const entry = ports.registry.get("repository.bootstrap");
    expect(entry?.asyncHandler).toBeTypeOf("function");
    if (entry?.asyncHandler === undefined) throw new Error("bootstrap registration missing");
    expect(await entry.asyncHandler({ envelope, principal })).toMatchObject({ disposition: "DECIDED" });
    expect(generate).toHaveBeenCalledTimes(1);
    const supplied = generate.mock.calls[0]?.[0];
    expect(supplied).not.toHaveProperty("requiredVariableNames");
    expect(supplied).toEqual({ ...payload, projectId: PROJECT_ID });
    const committed = await nodeGitRunner(payload.dir, ["show", "HEAD:.env.example"]);
    expect(committed.code).toBe(0);
    const baseline = profile.generateControlledProfile(payload);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) throw new Error("controlled profile unexpectedly refused");
    expect(committed.stdout).toBe(baseline.files.get(".env.example"));
    // Positive control: the emitter DOES support names; it is the command's supply that is absent.
    const withNames = profile.generateControlledProfile({ ...payload,
      requiredVariableNames: ["CONTRACT_INPUT_NAME"] });
    expect(withNames.ok).toBe(true);
    if (!withNames.ok) throw new Error("controlled profile names unexpectedly refused");
    expect(withNames.files.get(".env.example")).toContain("CONTRACT_INPUT_NAME=\n");
    expect(committed.stdout).not.toContain("CONTRACT_INPUT_NAME=");
  } finally {
    generate.mockRestore();
    rmSync(workspace, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  }
}, 360_000); // Four bootstrap git calls plus git-show, each bounded at 60s, then cleanup.

afterEach(() => {
  cleanUp();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory === undefined) continue;
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch { /* a held handle on Windows must not mask a test failure */ }
  }
});

function temporaryWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "moe-launch-canary-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Random per test. A shared constant could be matched by an unrelated fixture, which would make
 * the leak sweep pass or fail for a reason that has nothing to do with this delivery.
 */
function canaryValue(): string {
  return `not-a-secret-canary-${randomBytes(16).toString("hex")}`;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** The operator's own write path: sealed, through the shipped command surface. */
function seed(config: EnvironmentStoreConfig, environment: "preview" | "verify", value: string): void {
  const written = setEnvironmentVariable(config, { environment, name: CANARY_NAME, value });
  // A silently refused seed would make the whole file vacuous - it would sweep for a value that
  // was never stored and find nothing, twice.
  expect(written).toMatchObject({ ok: true });
}

/**
 * A child that reports what it received WITHOUT echoing it: the digest of the canary when it
 * arrived, the literal `ABSENT` when it did not. Both are safe to put in a log.
 */
function writeProbe(workspace: string, reportPath: string): string {
  const probe = join(workspace, "probe.mjs");
  writeFileSync(probe,
    'import { createHash } from "node:crypto";\n'
    + 'import { writeFileSync } from "node:fs";\n'
    + `const received = process.env[${JSON.stringify(CANARY_NAME)}];\n`
    + 'const report = received === undefined ? "ABSENT"\n'
    + '  : `DIGEST:${createHash("sha256").update(received, "utf8").digest("hex")}`;\n'
    + `writeFileSync(${JSON.stringify(reportPath)}, report, "utf8");\n`,
    "utf8");
  return probe;
}

/**
 * The host half of a spawn: a non-allowlisted ambient name that must never reach a child, plus
 * the minimum a child needs to start on this platform.
 */
function hostEnvironment(): NodeJS.ProcessEnv {
  return {
    [HOST_ONLY]: "ambient-and-unwanted",
    COMSPEC: process.env["COMSPEC"] ?? "",
    PATH: process.env["PATH"] ?? "",
    PATHEXT: process.env["PATHEXT"] ?? "",
    SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
  };
}

describe("the verifier composition delivers to a real child", () => {
  it("hands the selected environment's value to the child while leaking it into no captured byte", async () => {
    const config = configFor(openMemoryStore());
    const canary = canaryValue();
    seed(config, "verify", canary);

    const workspace = temporaryWorkspace();
    const reportPath = join(workspace, "report.txt");
    writeProbe(workspace, reportPath);

    // THE PRODUCTION COMPOSITION, verbatim: the same resolver call and the same runner factory
    // that `agent-wrapper-main.ts` makes at its verifier boundary. Nothing is injected.
    const delivered = launchDelivery(config, "VERIFIER");
    expect(delivered).toBeDefined();
    const logLines: string[] = [];
    const runner = createVerifierDatabaseRunner({
      ...(delivered === undefined ? {} : { delivered }),
      environment: hostEnvironment(),
      onFatalContainment: (error) => { logLines.push(String(error?.message ?? error)); },
      timeoutMs: 60_000,
    });

    try {
      const run = await runner({
        instructions: "report what arrived", test: "node probe.mjs",
        title: "launch canary", workspace,
      });
      expect(run.exitCode).toBe(0);

      // HALF ONE - RECEIPT. Only a process holding the exact bytes can produce this digest, so
      // this is proof of delivery and not merely proof that a variable of that name existed.
      expect(readFileSync(reportPath, "utf8")).toBe(`DIGEST:${sha256(canary)}`);

      // HALF TWO - NO LEAK. Over the run capture, the collected log lines and the report file:
      // the value itself appears in NONE of them.
      expect(run.output).not.toContain(canary);
      expect(JSON.stringify(run)).not.toContain(canary);
      expect(logLines.join("\n")).not.toContain(canary);
      expect(readFileSync(reportPath, "utf8")).not.toContain(canary);

      // And the closed allowlist still governed the host half of the same spawn.
      expect(run.output).not.toContain("ambient-and-unwanted");
    } finally {
      // Epic rail 4: the runner is closed on the throwing path too, so a failing assertion
      // cannot leave a child process or a drain timer behind for the next file.
      await runner.close();
    }
  }, 90_000);

  it("spawns byte-identically when the selected environment has no variables at all", async () => {
    // No seed: `verify` exists as a name but holds nothing, so the resolver answers `undefined`
    // and `deliverEnvironment` returns the allowlisted object BY REFERENCE.
    const config = configFor(openMemoryStore());
    expect(launchDelivery(config, "VERIFIER")).toBeUndefined();

    const workspace = temporaryWorkspace();
    const reportPath = join(workspace, "report.txt");
    writeProbe(workspace, reportPath);
    const runner = createVerifierDatabaseRunner({
      environment: hostEnvironment(), timeoutMs: 60_000,
    });
    try {
      const run = await runner({
        instructions: "report what arrived", test: "node probe.mjs",
        title: "empty delivery", workspace,
      });
      expect(run.exitCode).toBe(0);
      expect(readFileSync(reportPath, "utf8")).toBe("ABSENT");
    } finally {
      await runner.close();
    }
  }, 90_000);
});

describe("a coding seat receives nothing at the process boundary", () => {
  /**
   * DoD 3's negative half, proven where it matters rather than by reading the call site.
   *
   * BOTH SHAPES ARE ASSERTED. The FIRST is what production actually does - agent-spawner.ts:156
   * and :159 call `agentEnvironment(source)` with ONE argument - and it is the arm that fails if
   * someone ever adds a second. The SECOND is the clause's literal words: even when the optional
   * parameter IS supplied from the coding-seat resolution, the child still gets nothing, because
   * that resolution is empty by type rather than by anyone remembering.
   */
  it.each([
    ["the one-argument production call", false],
    ["the optional parameter supplied from the coding-seat resolution", true],
  ])("withholds the canary from a real child spawned through %s", (_label, supplyDelivered) => {
    const config = configFor(openMemoryStore());
    const canary = canaryValue();
    // Seeded in EVERY delivering environment, so a resolver that leaked from any of them fails.
    seed(config, "verify", canary);
    seed(config, "preview", canary);

    const workspace = temporaryWorkspace();
    const reportPath = join(workspace, "report.txt");
    const probe = writeProbe(workspace, reportPath);

    const host = { ...hostEnvironment(), [CANARY_NAME]: canary };
    // The canary is ALSO ambient on the host, which is the harder case: it must be dropped by the
    // closed roster, not merely absent from the delivery.
    const environment = supplyDelivered
      ? agentEnvironment(host, launchDelivery(config, "CODING_SEAT"))
      : agentEnvironment(host);

    const spawned = spawnSync(process.execPath, [probe], {
      cwd: workspace, encoding: "utf8", env: environment, timeout: 60_000,
    });
    expect(spawned.error).toBeUndefined();
    expect(spawned.status).toBe(0);

    // The child's own report: it never saw the variable.
    expect(readFileSync(reportPath, "utf8")).toBe("ABSENT");
    expect(readFileSync(reportPath, "utf8")).not.toContain(sha256(canary));
    // Neither the value nor the ambient host secret survived the roster.
    expect(environment[CANARY_NAME]).toBeUndefined();
    expect(environment[HOST_ONLY]).toBeUndefined();
    expect(`${spawned.stdout}${spawned.stderr}`).not.toContain(canary);
  }, 90_000);
});
