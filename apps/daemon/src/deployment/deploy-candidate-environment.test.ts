import { existsSync, readFileSync, statSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { closeStores, openStore } from "../review/review-test-fixtures.js";
import { CONTROLLED_PROFILE_VERSION } from "../repository/controlled-profile/controlled-profile-generator.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { setEnvironmentVariable } from "../environment/environment-store.js";
import { DOUBLE_IMAGE_COMMAND, createDockerDouble } from "./deploy-ports.js";
import type { DeployRunResult, DeployTarget, DockerRunner } from "./deploy-ports.js";
import { deployImageTag } from "./deploy-receipt-contracts.js";
import {
  CANDIDATE_ENVIRONMENT_LOADER, CANDIDATE_ENVIRONMENT_PATH, CANDIDATE_ENVIRONMENT_SHELL,
  DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN, DEPLOY_ENVIRONMENT_REMOTE_UNSUPPORTED,
  candidateEnvironmentPort, encodeCandidateEnvironment, imageCommandArgv, parseImageCommand,
  resolveCandidateMount, runCandidateArgv,
} from "./deploy-candidate-environment.js";
import { candidateContainerName, createDeployService } from "./deploy-service.js";

/**
 * THE DELIVERY THAT MAY NOT TRAVEL IN THE ARGV.
 *
 * `deploy-candidate-environment.ts`'s header carries the measurement these arms encode: a value
 * passed with `--env` is printed by `docker inspect` inside `.Config.Env`, and a value delivered
 * through a bind-mounted file is not. `tests/e2e/foundation/platform-secret-canary.e2e.test.ts`
 * sweeps exactly that stdout and asserts zero hits, so the regression this file exists to catch is
 * a future edit "simplifying" the mount back into `--env`. That arm is cheap, deterministic, and
 * runs in the daemon lane rather than behind the docker-gated e2e flag — which is where the leak
 * would otherwise be found, long after the design was written.
 *
 * OFFLINE: every docker call is the state-machine double, and the only file written is the
 * delivery file the port under test creates in the OS temp directory and removes itself.
 */

afterEach(closeStores);

const PROJECT = "project-review-1";
const ENVIRONMENT = "production";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CREDENTIAL = "b".repeat(64);
const IMAGE_ENTRYPOINT = "docker-entrypoint.sh";
const IMAGE_CMD = ["node", "/app/dist/server.js"] as const;
const LOCAL: DeployTarget = { network: "moe-net", sshTarget: null, url: "https://app.example.test" };
const PROXY_CONFIG = deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile") ?? "";
/** Not credential-shaped, and distinct from the e2e canary's own shape so the two cannot be confused. */
const VALUE = "delivered-not-a-secret-abc123";

const ok = (stdout: string): DeployRunResult => ({ code: 0, stderr: "", stdout });

/** What a real `docker image inspect` answers for `imageCommandArgv`: two JSON lines. Pinned
 *  against the double's own answer, so the two cannot drift apart. */
const imageCommandStdout = `${JSON.stringify([IMAGE_ENTRYPOINT])}\n${JSON.stringify(IMAGE_CMD)}\n`;

describe("the delivery file is shell text that cannot execute", () => {
  it("writes one single-quoted assignment per variable, in insertion order", () => {
    expect(encodeCandidateEnvironment({ DATABASE_URL: "postgres://app@db:5432/app", PORT: "3000" }))
      .toBe("DATABASE_URL='postgres://app@db:5432/app'\nPORT='3000'\n");
  });

  it("renders a hostile value inert rather than refusing it", () => {
    // Single quotes have NO expansion of any kind: this is assignment, not evaluation.
    const encoded = encodeCandidateEnvironment({ HOSTILE: "$(whoami)`id`; echo x & $PATH" });
    expect(encoded).toBe("HOSTILE='$(whoami)`id`; echo x & $PATH'\n");
  });

  it("closes, escapes and reopens an embedded single quote", () => {
    // `it's` becomes `'it'\''s'` — the only sequence that can end a single-quoted string.
    expect(encodeCandidateEnvironment({ QUOTED: "it's" })).toBe("QUOTED='it'\\''s'\n");
    expect(encodeCandidateEnvironment({ QUOTED: "'" })).toBe("QUOTED=''\\'''\n");
  });

  it("keeps a newline inside the quoting rather than starting a second assignment", () => {
    const encoded = encodeCandidateEnvironment({ MULTILINE: "one\nMALICIOUS='two" });
    expect(encoded).toBe("MULTILINE='one\nMALICIOUS='\\''two'\n");
    // THE INVARIANT THAT MAKES THE ENCODING TOTAL: between the opening and closing quote there is
    // no unescaped `'`, so nothing in the value can close the string early and start a second
    // assignment. `MALICIOUS=` above LOOKS like one at the start of a line and is not.
    const body = encoded.slice("MULTILINE='".length, -"'\n".length);
    expect(body.replaceAll("'\\''", "")).not.toContain("'");
  });

  it("is empty for an environment holding nothing, which is what suppresses the mount", () => {
    expect(encodeCandidateEnvironment({})).toBe("");
  });
});

describe("the candidate argv carries paths, never values", () => {
  it("is byte-identical to the undelivered shape when there is nothing to mount", () => {
    expect(runCandidateArgv("moe-candidate", "moe-net", "tag:1")).toEqual([
      "run", "--detach", "--name", "moe-candidate", "--network", "moe-net", "tag:1",
    ]);
    expect(runCandidateArgv("moe-candidate", "moe-net", "tag:1", null))
      .toEqual(runCandidateArgv("moe-candidate", "moe-net", "tag:1"));
  });

  it("mounts the delivery read-only and restores the image's own command", () => {
    // EXACT, and deliberately not `toContain`: this is what stops a later edit dropping
    // `--network`, dropping `readonly`, or reordering the command back off the end.
    expect(runCandidateArgv("moe-candidate", "moe-net", "tag:1", {
      command: [IMAGE_ENTRYPOINT, ...IMAGE_CMD], source: "/host/tmp/moe-deploy-env-x/env",
    })).toEqual([
      "run", "--detach", "--name", "moe-candidate", "--network", "moe-net",
      "--mount", "type=bind,source=/host/tmp/moe-deploy-env-x/env,target=/run/moe/env,readonly",
      "--entrypoint", "/bin/sh", "tag:1", "-c",
      'set -a; . /run/moe/env; set +a; exec "$0" "$@"',
      IMAGE_ENTRYPOINT, "node", "/app/dist/server.js",
    ]);
  });

  it("names no variable and no value in the loader, whatever is being delivered", () => {
    expect(CANDIDATE_ENVIRONMENT_LOADER).not.toMatch(/[A-Z][A-Z0-9_]*=/u);
    expect(CANDIDATE_ENVIRONMENT_LOADER).toContain(CANDIDATE_ENVIRONMENT_PATH);
    expect(CANDIDATE_ENVIRONMENT_SHELL).toBe("/bin/sh");
  });
});

describe("the image command is read back because --entrypoint discards it", () => {
  it("asks for the entrypoint and the command as two JSON lines, never the whole config", () => {
    expect(imageCommandArgv("tag:1")).toEqual([
      "image", "inspect", "--format", "{{json .Config.Entrypoint}}\n{{json .Config.Cmd}}", "tag:1",
    ]);
    // `.Config` would also hand us the image's own Env, which is not this engine's to read.
    expect(imageCommandArgv("tag:1").join(" ")).not.toContain("{{json .Config}}");
  });

  it("concatenates entrypoint and command, and tolerates either being absent", () => {
    // The double's answer and this file's expectation are the SAME bytes: if `createDockerDouble`
    // ever answered a different shape, the engine arms below would drift silently past it.
    expect(DOUBLE_IMAGE_COMMAND).toBe(imageCommandStdout);
    expect(parseImageCommand(imageCommandStdout)).toEqual([IMAGE_ENTRYPOINT, ...IMAGE_CMD]);
    expect(parseImageCommand('null\n["node","/app/dist/server.js"]')).toEqual([...IMAGE_CMD]);
    expect(parseImageCommand('["/entry.sh"]\nnull')).toEqual(["/entry.sh"]);
  });

  it("refuses an image that names neither, and anything that is not a string array", () => {
    expect(parseImageCommand("null\nnull")).toBeNull();
    expect(parseImageCommand("")).toBeNull();
    expect(parseImageCommand("sha256:deadbeef")).toBeNull();
    expect(parseImageCommand("[1,2]\nnull")).toBeNull();
  });
});

describe("the mount refuses where a bind mount cannot mean anything", () => {
  const run = (stdout: string) => (): Promise<DeployRunResult> => Promise.resolve(ok(stdout));

  it("refuses a REMOTE target by code, without asking docker anything", async () => {
    let asked = 0;
    const answer = await resolveCandidateMount(async () => {
      asked += 1;
      return ok(imageCommandStdout);
    }, "deployer@host.example.test", "tag:1", "/host/env");
    // The source path is the DAEMON's, and a remote target's docker host is not the daemon's.
    expect(answer).toBe(DEPLOY_ENVIRONMENT_REMOTE_UNSUPPORTED);
    expect(asked).toBe(0);
  });

  it("refuses by code when the image reports no command to restore", async () => {
    expect(await resolveCandidateMount(run("null\nnull"), null, "tag:1", "/host/env"))
      .toBe(DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN);
  });

  it("refuses by code when the inspect itself fails", async () => {
    expect(await resolveCandidateMount(
      () => Promise.resolve({ code: 1, stderr: "No such image", stdout: "" }),
      null, "tag:1", "/host/env",
    )).toBe(DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN);
  });

  it("returns the mount for a local target with a readable image", async () => {
    expect(await resolveCandidateMount(run(imageCommandStdout), null, "tag:1", "/host/env"))
      .toEqual({ command: [IMAGE_ENTRYPOINT, ...IMAGE_CMD], source: "/host/env" });
  });
});

describe("the delivery port reads the encrypted store and refuses as one", () => {
  const configFor = (store: ReturnType<typeof openStore>, credential: string | null) => ({
    credential: () => credential, now: () => "2026-09-08T00:00:00.000Z", projectId: PROJECT, store,
  });

  it("writes an owner-only file outside the workspace, and disposes of it", () => {
    const store = openStore();
    const config = configFor(store, CREDENTIAL);
    expect(setEnvironmentVariable(config, { environment: ENVIRONMENT, name: "MARKER", value: VALUE }).ok).toBe(true);

    const delivered = candidateEnvironmentPort(config)(ENVIRONMENT);
    expect(delivered.ok).toBe(true);
    if (!delivered.ok || delivered.source === null) throw new Error("expected a delivery to mount");
    expect(readFileSync(delivered.source, "utf8")).toBe(`MARKER='${VALUE}'\n`);
    // Outside the repository, so it can never be committed or swept as a fixture.
    expect(delivered.source.replace(/\\/gu, "/")).not.toContain("/moe-next/");
    if (process.platform !== "win32") {
      expect(statSync(delivered.source).mode & 0o777).toBe(0o600);
    }
    delivered.dispose();
    expect(existsSync(delivered.source)).toBe(false);
    // IDEMPOTENT AND THROW-FREE: `dispose` is called from the deploy's `finally`, where a throw
    // would REPLACE the report the deploy had already produced — a DEPLOYED deploy turned into a
    // crash over a temp file. The second call has nothing left to remove and must still be silent.
    expect(() => { delivered.dispose(); }).not.toThrow();
  });

  it("forwards the environment slice's own code AND layer, and writes nothing", () => {
    const store = openStore();
    // No credential: the store's seals cannot be opened, so the WHOLE read refuses.
    const refused = candidateEnvironmentPort(configFor(store, null))(ENVIRONMENT);
    expect(refused).toEqual({ code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY", ok: false });
  });

  it("refuses the WHOLE delivery rather than mounting the part it could open", () => {
    const store = openStore();
    expect(setEnvironmentVariable(configFor(store, CREDENTIAL),
      { environment: ENVIRONMENT, name: "MARKER", value: VALUE }).ok).toBe(true);
    // A DIFFERENT credential opens nothing. The refusal is the whole read's, and there is no
    // partial map and no source to mount — the property environment-delivery.ts guarantees and
    // this port must not degrade.
    const refused = candidateEnvironmentPort(configFor(store, "c".repeat(64)))(ENVIRONMENT);
    expect(refused).toEqual({ code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY", ok: false });
    expect(JSON.stringify(refused)).not.toContain(VALUE);
  });

  it("mounts nothing when the environment holds no variables", () => {
    const store = openStore();
    const delivered = candidateEnvironmentPort(configFor(store, CREDENTIAL))(ENVIRONMENT);
    expect(delivered).toMatchObject({ ok: true, source: null });
  });
});

describe("the deploy engine mounts the delivery it was given", () => {
  const deploy = async (environmentPort: Parameters<typeof createDeployService>[0]["ports"]["environment"]) => {
    const candidate = candidateContainerName(ENVIRONMENT, SHA, "decision-1");
    const double = createDockerDouble({
      proxyConfig: PROXY_CONFIG, health: { [candidate]: ["HEALTHY"] }, running: { app: "HEALTHY" },
    });
    // The double answers BOTH image reads itself — the digest and the command — so this arm drives
    // the same docker model every other deploy arm drives, with nothing stubbed on top.
    const docker: DockerRunner = double.docker;
    const store = openStore();
    const report = await createDeployService({
      clock: () => "2026-09-08T00:00:00.000Z", pollMs: 1, healthBudgetMs: 10, sleep: () => Promise.resolve(),
      ports: {
        build: (request) => docker(["build", "--tag", request.tag, "-"]),
        docker, releaseDecision: () => null, ssh: double.ssh, target: () => LOCAL,
        transfer: double.transfer,
        ...(environmentPort === undefined ? {} : { environment: environmentPort }),
      },
      projectId: PROJECT, store,
    }).deploy({ context: "/workspace/app", decisionId: "decision-1", environment: ENVIRONMENT, sha: SHA });
    return { candidate, double, report };
  };

  it("starts the candidate on the exact mounted argv, and removes the file afterwards", async () => {
    let source: string | null = null;
    const context = await deploy((environment) => {
      expect(environment).toBe(ENVIRONMENT);
      source = "/host/tmp/moe-deploy-env-x/env";
      return { dispose: () => { source = null; }, ok: true, source };
    });

    expect(context.report.outcome, context.report.detail).toBe("DEPLOYED");
    const started = context.double.calls.find((call) => call[0] === "run");
    expect(started).toEqual([
      "run", "--detach", "--name", context.candidate, "--network", "moe-net",
      "--mount", "type=bind,source=/host/tmp/moe-deploy-env-x/env,target=/run/moe/env,readonly",
      "--entrypoint", "/bin/sh", deployImageTag(ENVIRONMENT, SHA), "-c",
      CANDIDATE_ENVIRONMENT_LOADER, IMAGE_ENTRYPOINT, "node", "/app/dist/server.js",
    ]);
    // The `finally` disposes on the SUCCESS path too, not only on the refusal ones.
    expect(source).toBeNull();
  });

  it("puts no value and no --env anywhere in ANY argv the deploy issued", async () => {
    const context = await deploy(() => ({
      dispose: () => {}, ok: true, source: "/host/tmp/moe-deploy-env-x/env",
    }));

    expect(context.report.outcome).toBe("DEPLOYED");
    // THE REGRESSION THIS ROW EXISTS TO PREVENT, asserted over every docker call rather than only
    // the one that starts the candidate: `--env` and `--env-file` both land the value in
    // `docker inspect .Config.Env`, which the secret canary sweeps and asserts empty.
    const every = context.double.calls.flat();
    expect(every.filter((token) => token === "--env" || token === "--env-file" || token === "-e")).toEqual([]);
    expect(every.some((token) => token.includes(VALUE))).toBe(false);
  });

  it("refuses BEFORE starting anything when the delivery refuses, and disposes nothing", async () => {
    const context = await deploy(() => ({ code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY", ok: false }));

    expect(context.report.outcome).toBe("REFUSED");
    expect(context.report.receipt?.refusal?.layer).toBe("DAEMON_DEPLOY_ENGINE");
    // No container was created at all: an unreadable store must not produce a running candidate
    // with a partial environment, which is the whole point of the forwarded refusal.
    expect(context.double.calls.filter((call) => call[0] === "run")).toEqual([]);
    expect(context.double.state(context.candidate)).toBe("ABSENT");
  });

  it("leaves the argv untouched when the environment holds nothing to deliver", async () => {
    const context = await deploy(() => ({ dispose: () => {}, ok: true, source: null }));

    expect(context.report.outcome).toBe("DEPLOYED");
    expect(context.double.calls.find((call) => call[0] === "run")).toEqual(
      runCandidateArgv(context.candidate, "moe-net", deployImageTag(ENVIRONMENT, SHA)),
    );
  });
});
