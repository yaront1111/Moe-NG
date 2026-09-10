import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import * as double from "./deploy-docker-double.js";
import * as ports from "./deploy-ports.js";

import { closeStores, openStore } from "../review/review-test-fixtures.js";
import { CONTROLLED_PROFILE_VERSION } from "../repository/controlled-profile/controlled-profile-generator.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { setEnvironmentVariable } from "../environment/environment-store.js";
import { DOUBLE_IMAGE_COMMAND, createDockerDouble } from "./deploy-ports.js";
import type { ContainerState, DeployRunResult, DeployTarget, DockerRunner } from "./deploy-ports.js";
import { deployImageTag } from "./deploy-receipt-contracts.js";
import {
  CANDIDATE_ENVIRONMENT_LOADER, CANDIDATE_ENVIRONMENT_PATH, CANDIDATE_ENVIRONMENT_SHELL,
  DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN,
  candidateEnvironmentPort, copyEnvironmentArgv, createCandidateArgv, encodeCandidateEnvironment,
  imageCommandArgv, parseImageCommand, resolveCandidateCommand, runCandidateArgv, startCandidateArgv,
} from "./deploy-candidate-environment.js";
import { encodeCandidateArchive } from "./deploy-candidate-archive.js";
import { candidateContainerName, createDeployService } from "./deploy-service.js";

/**
 * THE DELIVERY THAT MAY NOT TRAVEL IN THE ARGV.
 *
 * `deploy-candidate-environment.ts`'s header carries the measurement these arms encode: a value
 * passed with `--env` is printed by `docker inspect` inside `.Config.Env`, and a value delivered as
 * a file inside the container is not. `tests/e2e/foundation/platform-secret-canary.e2e.test.ts`
 * sweeps exactly that stdout and asserts zero hits, so the regression this file exists to catch is
 * a future edit "simplifying" the delivery back into `--env`. That arm is cheap, deterministic, and
 * runs in the daemon lane rather than behind the docker-gated e2e flag — which is where the leak
 * would otherwise be found, long after the design was written.
 *
 * THE FILE NOW ARRIVES ON STDIN, NOT THROUGH A BIND MOUNT, and that is what makes a REMOTE target
 * deliverable at all: a mount's source is resolved on the docker host, which for an ssh target is
 * not this machine. `create` + `docker cp -` + `start` names no host path, so local and remote are
 * one code path — and the daemon writes no plaintext to its own disk on either.
 *
 * OFFLINE: every docker call is the state-machine double, and nothing under test writes a file.
 */

afterEach(closeStores);

const PROJECT = "project-review-1";
const ENVIRONMENT = "production";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CREDENTIAL = "b".repeat(64);
const IMAGE_ENTRYPOINT = "docker-entrypoint.sh";
const IMAGE_CMD = ["node", "/app/dist/server.js"] as const;
const LOCAL: DeployTarget = { network: "moe-net", sshTarget: null, url: "https://app.example.test" };
/** The target this row exists for: its docker host is NOT the daemon's, so no host path can reach it. */
const REMOTE: DeployTarget = {
  network: "moe-net", sshTarget: "deployer@host.example.test", url: "https://app.example.test",
};
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

  it("FREEZES runCandidateArgv's exact bytes on BOTH arms, as the successor's migration baseline", () => {
    // DoD 1. This row wires nothing and must leave `runCandidateArgv` byte-identical, so the row
    // that migrates the verb starts from a PROVEN baseline rather than from whatever this one left
    // behind. Written out as literals, not composed from the module's own constants: a baseline
    // that reads its expectation from the thing under test cannot detect the thing changing.
    expect(runCandidateArgv("c", "n", "t")).toEqual(["run", "--detach", "--name", "c", "--network", "n", "t"]);
    expect(runCandidateArgv("c", "n", "t", { command: ["e", "x"], source: "/h/env" })).toEqual([
      "run", "--detach", "--name", "c", "--network", "n",
      "--mount", "type=bind,source=/h/env,target=/run/moe/env,readonly",
      "--entrypoint", "/bin/sh", "t", "-c",
      'set -a; . /run/moe/env; set +a; exec "$0" "$@"', "e", "x",
    ]);
  });

  it("names no variable and no value in the loader, whatever is being delivered", () => {
    expect(CANDIDATE_ENVIRONMENT_LOADER).not.toMatch(/[A-Z][A-Z0-9_]*=/u);
    expect(CANDIDATE_ENVIRONMENT_LOADER).toContain(CANDIDATE_ENVIRONMENT_PATH);
    expect(CANDIDATE_ENVIRONMENT_SHELL).toBe("/bin/sh");
  });
});

/**
 * THE THREE-CALL SHAPE, BUILDERS ONLY. Nothing in this row wires them into `deploy-service.ts`;
 * these arms pin the bytes so the successor row migrates onto something already proven.
 */
describe("create, cp and start name no host path and no value", () => {
  it("creates the candidate with the image's own argv restored, and never --detach", () => {
    expect(createCandidateArgv("c", "n", "t")).toEqual(["create", "--name", "c", "--network", "n", "t"]);
    expect(createCandidateArgv("c", "n", "t", [IMAGE_ENTRYPOINT, ...IMAGE_CMD])).toEqual([
      "create", "--name", "c", "--network", "n",
      "--entrypoint", "/bin/sh", "t", "-c",
      'set -a; . /run/moe/env; set +a; exec "$0" "$@"',
      IMAGE_ENTRYPOINT, "node", "/app/dist/server.js",
    ]);
    // `--detach` is a `run` flag and `create` rejects it; `start` is what detaches here.
    expect(createCandidateArgv("c", "n", "t", ["e"])).not.toContain("--detach");
  });

  it("carries NO host path in the create argv, which is the whole reason this shape exists", () => {
    // `runCandidateArgv` must name a host path — that is exactly why it cannot deliver to a remote
    // docker host. This one must not, on either arm, so the same argv works local and remote.
    for (const argv of [createCandidateArgv("c", "n", "t"), createCandidateArgv("c", "n", "t", ["e"])]) {
      expect(argv).not.toContain("--mount");
      expect(argv.some((token) => token.includes("type=bind"))).toBe(false);
      expect(argv.some((token) => token.includes("source="))).toBe(false);
    }
    // ...and the contrast is asserted, so this is not passing on an argv that never had one.
    expect(runCandidateArgv("c", "n", "t", { command: ["e"], source: "/h/env" }))
      .toContain("type=bind,source=/h/env,target=/run/moe/env,readonly");
  });

  it("copies from STDIN to the container root, with no value and no archive flag", () => {
    expect(copyEnvironmentArgv("c")).toEqual(["cp", "-", "c:/"]);
    // The payload rides on stdin: no token here carries a variable name or a value, and `-a` is
    // absent because `docker cp -` was MEASURED to honour the USTAR header's uid/gid without it.
    expect(copyEnvironmentArgv("c")).not.toContain("--archive");
    expect(copyEnvironmentArgv("c")).not.toContain("-a");
    expect(copyEnvironmentArgv("c").some((token) => token.includes(VALUE))).toBe(false);
  });

  it("starts the container by name alone", () => {
    expect(startCandidateArgv("c")).toEqual(["start", "c"]);
  });

  it("drives a real docker double end to end: create, cp, start, then healthy", async () => {
    // The three builders against the double that models the three verbs — the closest this row
    // gets to the journey, without wiring anything. Proves they compose, and that the value
    // reaches the container's filesystem through STDIN and through no argv.
    const double = createDockerDouble({ health: { c: ["STARTING", "HEALTHY"] } });
    const archive = encodeCandidateArchive(encodeCandidateEnvironment({ SECRET_TOKEN: VALUE }));
    if (!archive.ok) throw new Error(`encoder refused: ${archive.code}`);

    await double.docker(createCandidateArgv("c", "moe-net", "tag:1", [IMAGE_ENTRYPOINT, ...IMAGE_CMD]));
    expect(double.state("c")).toBe("CREATED");
    expect((await double.docker(copyEnvironmentArgv("c"), archive.archive)).code).toBe(0);
    expect((await double.docker(startCandidateArgv("c"))).code).toBe(0);

    expect(double.state("c")).toBe("STARTING");
    expect(double.copies).toEqual([{ container: "c", destination: "/", payload: archive.archive }]);
    expect(double.copies[0]?.payload.includes(VALUE)).toBe(true);
    // NOT ONE ARGV TOKEN, ACROSS ALL THREE CALLS, CARRIES THE VALUE.
    expect(double.calls.flat().some((token) => token.includes(VALUE))).toBe(false);
    expect(double.calls.flat().filter((token) => token === "--env" || token === "--env-file" || token === "-e"))
      .toEqual([]);
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

describe("the image command resolves the same way for every target", () => {
  const run = (stdout: string) => (): Promise<DeployRunResult> => Promise.resolve(ok(stdout));

  it("refuses by code when the image reports no command to restore", async () => {
    expect(await resolveCandidateCommand(run("null\nnull"), "tag:1"))
      .toBe(DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN);
  });

  it("refuses by code when the inspect itself fails", async () => {
    expect(await resolveCandidateCommand(
      () => Promise.resolve({ code: 1, stderr: "No such image", stdout: "" }), "tag:1",
    )).toBe(DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN);
  });

  it("returns the image's own argv when the image is readable", async () => {
    expect(await resolveCandidateCommand(run(imageCommandStdout), "tag:1"))
      .toEqual([IMAGE_ENTRYPOINT, ...IMAGE_CMD]);
  });

  it("CANNOT refuse for being remote: there is no target-shaped parameter left to refuse on", () => {
    // DoD 3, asserted BY CODE rather than by outcome. The old shape took an `sshTarget` and
    // answered DEPLOY_ENVIRONMENT_REMOTE_UNSUPPORTED before asking docker anything; a delivery
    // that rides stdin resolves identically whichever docker host answers, so both are gone.
    // Read off the SOURCE, so re-introducing either reds here even if nothing calls it.
    const modules = ["./deploy-candidate-environment.ts", "./deploy-candidate-start.ts", "./deploy-service.ts"];
    for (const module of modules) {
      const source = readFileSync(new URL(module, import.meta.url), "utf8");
      // The sweep is only meaningful if it actually read a module: a missing file would read as
      // empty and every assertion below would pass while proving nothing.
      expect(source.length, module).toBeGreaterThan(500);
      expect(source, module).not.toContain("DEPLOY_ENVIRONMENT_REMOTE_UNSUPPORTED");
      expect(source, module).not.toContain("REMOTE_UNSUPPORTED");
    }
    // ...and the positive control that makes the sweep non-vacuous: a literal that IS still there.
    expect(readFileSync(new URL("./deploy-candidate-environment.ts", import.meta.url), "utf8"))
      .toContain("DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN");
    // `resolveCandidateCommand` takes a runner and a tag. Nothing else. `.length` counts the
    // parameters before the first default, and neither of these has one.
    expect(resolveCandidateCommand.length).toBe(2);
  });
});

describe("the delivery port reads the encrypted store and refuses as one", () => {
  const configFor = (store: ReturnType<typeof openStore>, credential: string | null) => ({
    credential: () => credential, now: () => "2026-09-08T00:00:00.000Z", projectId: PROJECT, store,
  });

  it("hands back the delivery TEXT and writes no file anywhere", () => {
    const store = openStore();
    const config = configFor(store, CREDENTIAL);
    expect(setEnvironmentVariable(config, { environment: ENVIRONMENT, name: "MARKER", value: VALUE }).ok).toBe(true);

    // The temp directory BEFORE and AFTER: this port used to create `moe-deploy-env-*` here so a
    // bind mount could name it. A path on the daemon's disk cannot reach a remote docker host, and
    // plaintext at rest needed a `finally` to remove it — one more exit path that could leak.
    const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith("moe-deploy-env-"));
    const delivered = candidateEnvironmentPort(config)(ENVIRONMENT);
    expect(delivered.ok).toBe(true);
    if (!delivered.ok || delivered.content === null) throw new Error("expected a delivery to copy");
    expect(delivered.content).toBe(`MARKER='${VALUE}'\n`);
    expect(readdirSync(tmpdir()).filter((entry) => entry.startsWith("moe-deploy-env-"))).toEqual(before);
    // The census is only evidence if it can SEE such a directory; prove the predicate matches the
    // name this port used to mint, or "no new entries" would pass against a blind filter.
    const witness = mkdtempSync(join(tmpdir(), "moe-deploy-env-"));
    try {
      expect(readdirSync(tmpdir()).filter((entry) => entry.startsWith("moe-deploy-env-"))).not.toEqual(before);
    } finally { rmSync(witness, { force: true, recursive: true }); }
    // NOTHING TO DISPOSE OF: the shape carries no cleanup handle, because there is no resource.
    expect(Object.keys(delivered).sort()).toEqual(["content", "ok"]);
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

  it("delivers nothing when the environment holds no variables", () => {
    const store = openStore();
    const delivered = candidateEnvironmentPort(configFor(store, CREDENTIAL))(ENVIRONMENT);
    expect(delivered).toEqual({ content: null, ok: true });
  });
});

/**
 * THE DEPLOY ENGINE, ON BOTH TARGETS, WITH THE SAME CODE PATH.
 *
 * These arms are the behavioural half of DoD 3. `sshTarget !== null` used to refuse outright with
 * DEPLOY_ENVIRONMENT_REMOTE_UNSUPPORTED because the delivery was a bind mount naming a path on the
 * daemon's disk; it now resolves and delivers, and every arm below is parameterised over LOCAL and
 * REMOTE so neither target can drift away from the other unobserved. The `run` arms in the old
 * shape of this block are gone: the candidate is created, copied into and started.
 */
describe("the deploy engine delivers on the target it was given", () => {
  const deploy = async (
    environmentPort: Parameters<typeof createDeployService>[0]["ports"]["environment"],
    options: {
      /** Containers ALREADY present when the deploy starts, e.g. an interrupted deploy's leftovers. */
      readonly running?: Readonly<Record<string, ContainerState>>;
      readonly target?: DeployTarget;
      readonly wrap?: (runner: DockerRunner) => DockerRunner;
    } = {},
  ) => {
    const candidate = candidateContainerName(ENVIRONMENT, SHA, "decision-1");
    const double = createDockerDouble({
      proxyConfig: PROXY_CONFIG, health: { [candidate]: ["HEALTHY"] },
      running: { app: "HEALTHY", ...options.running },
    });
    // The double answers BOTH image reads itself — the digest and the command — so this arm drives
    // the same docker model every other deploy arm drives, with nothing stubbed on top.
    const docker: DockerRunner = options.wrap?.(double.docker) ?? double.docker;
    const target = options.target ?? LOCAL;
    // The ssh argv EXACTLY as the engine composed it, recorded here rather than inside the double,
    // because a planted verb failure has to wrap the docker leg the ssh transport carries — the
    // double's own `ssh` would route around the wrapper and the failure would never fire.
    const sshCalls: (readonly string[])[] = [];
    const store = openStore();
    const report = await createDeployService({
      clock: () => "2026-09-08T00:00:00.000Z", pollMs: 1, healthBudgetMs: 10, sleep: () => Promise.resolve(),
      ports: {
        build: (request) => docker(["build", "--tag", request.tag, "-"]),
        docker, releaseDecision: () => null,
        ssh: (args, stdin) => {
          sshCalls.push([...args]);
          const docked = args.indexOf("docker");
          return docked === -1 ? double.ssh(args, stdin) : docker(args.slice(docked + 1), stdin);
        },
        target: () => target, transfer: double.transfer,
        ...(environmentPort === undefined ? {} : { environment: environmentPort }),
      },
      projectId: PROJECT, store,
    }).deploy({ context: "/workspace/app", decisionId: "decision-1", environment: ENVIRONMENT, sha: SHA });
    return { candidate, double, report, sshCalls, target };
  };

  /** What a refusal detail becomes once `deploy-ledger.ts` declassifies it before storing. */
  const REDACTED_DETAIL = "[REDACTED]";

  const delivering = (content: string | null) => () => ({ content, ok: true } as const);
  const PAYLOAD = encodeCandidateEnvironment({ MARKER: VALUE });
  const TARGETS: readonly (readonly [string, DeployTarget])[] = [["local", LOCAL], ["remote", REMOTE]];

  it.each(TARGETS)("brings the candidate up as create, cp and start on a %s target", async (_name, target) => {
    const context = await deploy(delivering(PAYLOAD), { target });

    expect(context.report.outcome, context.report.detail).toBe("DEPLOYED");
    const tag = deployImageTag(ENVIRONMENT, SHA);
    expect(context.double.calls.find((call) => call[0] === "create")).toEqual([
      "create", "--name", context.candidate, "--network", "moe-net",
      "--entrypoint", "/bin/sh", tag, "-c",
      CANDIDATE_ENVIRONMENT_LOADER, IMAGE_ENTRYPOINT, "node", "/app/dist/server.js",
    ]);
    expect(context.double.calls.find((call) => call[0] === "cp"))
      .toEqual(copyEnvironmentArgv(context.candidate));
    expect(context.double.calls.find((call) => call[0] === "start"))
      .toEqual(startCandidateArgv(context.candidate));
    // NO `run`, on either target: there is exactly one way to bring a candidate up now.
    expect(context.double.calls.filter((call) => call[0] === "run")).toEqual([]);
  });

  it("wraps every remote docker call as `ssh <target> docker ...`, the cp included", async () => {
    const context = await deploy(delivering(PAYLOAD), { target: REMOTE });

    expect(context.report.outcome, context.report.detail).toBe("DEPLOYED");
    // THE TRANSPORT IS ASSERTED, not assumed: each of the three carries the ssh target and the
    // `docker` word before its own verb, which is what `ports.ssh` composes for a remote target.
    for (const verb of ["create", "cp", "start"]) {
      const sent = context.sshCalls.find((call) => call[0] === REMOTE.sshTarget && call[2] === verb);
      expect(sent?.slice(0, 3), verb).toEqual([REMOTE.sshTarget, "docker", verb]);
    }
    expect(context.sshCalls.some((call) => call[2] === "run")).toBe(false);
    // The `cp` reached ssh as `... docker cp - <name>:/` — the destination and no payload token.
    expect(context.sshCalls.find((call) => call[2] === "cp"))
      .toEqual([REMOTE.sshTarget, "docker", ...copyEnvironmentArgv(context.candidate)]);
  });

  it.each(TARGETS)("puts the archive on STDIN and the value in no argv token, %s", async (_name, target) => {
    const context = await deploy(delivering(PAYLOAD), { target });

    expect(context.report.outcome).toBe("DEPLOYED");
    // THE BYTES ARRIVED, and they are the encoder's own output rather than a re-derivation here.
    const archive = encodeCandidateArchive(PAYLOAD);
    if (!archive.ok) throw new Error(`encoder refused: ${archive.code}`);
    expect(context.double.copies).toEqual([
      { container: context.candidate, destination: "/", payload: archive.archive },
    ]);
    expect(context.double.copies[0]?.payload).toContain(`MARKER='${VALUE}'`);
    // ...AND NOT ONE ARGV TOKEN CARRIES THE VALUE, over every docker call and every ssh call.
    // `--env`/`--env-file` would land it in `.Config.Env`, which the secret canary sweeps.
    const every = [
      ...context.double.calls.flat(), ...context.double.sshCalls.flat(), ...context.sshCalls.flat(),
    ];
    expect(every.length).toBeGreaterThan(0);
    expect(every.filter((token) => token === "--env" || token === "--env-file" || token === "-e")).toEqual([]);
    expect(every.some((token) => token.includes(VALUE))).toBe(false);
    expect(every.some((token) => token.includes("MARKER="))).toBe(false);
  });

  it.each(TARGETS)("issues NO cp at all when there is nothing to deliver, %s", async (_name, target) => {
    const context = await deploy(delivering(null), { target });

    expect(context.report.outcome).toBe("DEPLOYED");
    expect(context.double.calls.filter((call) => call[0] === "cp")).toEqual([]);
    expect(context.double.copies).toEqual([]);
    // The candidate still comes up, on the bare argv with no entrypoint override.
    expect(context.double.calls.find((call) => call[0] === "create")).toEqual(
      createCandidateArgv(context.candidate, "moe-net", deployImageTag(ENVIRONMENT, SHA)));
    expect(context.double.calls.find((call) => call[0] === "start"))
      .toEqual(startCandidateArgv(context.candidate));
  });

  /** Fails one docker verb, counting its interceptions so a planted failure cannot silently miss. */
  const failVerb = (verb: string, stderr: string) => {
    let matched = 0;
    const wrap = (runner: DockerRunner): DockerRunner => async (args, stdin) => {
      if (args[0] !== verb) return runner(args, stdin);
      matched += 1;
      return { code: 1, stderr, stdout: "" };
    };
    return Object.assign(wrap, { hits: () => matched });
  };

  it.each(["create", "cp", "start"])("refuses by code when the candidate's %s fails, remotely", async (verb) => {
    const wrap = failVerb(verb, `docker ${verb}: planted failure`);
    const context = await deploy(delivering(PAYLOAD), { target: REMOTE, wrap });

    // THE PLANTED FAILURE FIRED. Without this the refusal could be some other layer's, and the arm
    // would stay green while the leg it names was never exercised at all.
    expect(wrap.hits()).toBe(1);
    expect(context.report.outcome).toBe("REFUSED");
    // THE ENGINE'S OWN CODE AND LAYER, and the free-text detail declassified by deploy-ledger.ts
    // before it became durable — docker's stderr is untrusted text and may not be stored. This is
    // the SAME code and layer discipline the single-call failure used; no new code was minted.
    expect(context.report.receipt?.refusal).toEqual({
      code: "DEPLOY_BUILD_FAILED", detail: REDACTED_DETAIL, layer: "DAEMON_DEPLOY_ENGINE",
    });
    // WHICH LEG REFUSED, made observable where the redacted receipt cannot say it: the failing
    // verb was issued, and nothing after it was. Without this the three arms would be
    // indistinguishable and any one of them could be passing for another leg's failure.
    const issued = (name: string): boolean => context.double.calls.some((call) => call[0] === name);
    expect(issued("create")).toBe(verb !== "create");
    expect(issued("cp")).toBe(verb === "start");
    expect(issued("start")).toBe(false);
    expect(JSON.stringify(context.report.receipt)).not.toContain(VALUE);
  });

  it.each(["cp", "start"])("leaves NO created container behind when the %s fails", async (verb) => {
    const context = await deploy(delivering(PAYLOAD), {
      target: REMOTE, wrap: failVerb(verb, `docker ${verb}: planted failure`),
    });

    expect(context.report.outcome).toBe("REFUSED");
    // EPIC RAIL 4 ON THE FAILURE PATH. `create` succeeded, so a container of this name exists;
    // abandoning it is exactly the orphan a create/start split invents. The engine's `finally`
    // must have removed it, and the double's state machine is what says so.
    expect(context.double.state(context.candidate)).toBe("REMOVED");
    expect(context.double.calls).toContainEqual(["rm", "--force", context.candidate]);
  });

  it("refuses DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN on the remote path too, before creating", async () => {
    const context = await deploy(delivering(PAYLOAD), {
      target: REMOTE,
      // An image that reports neither an entrypoint nor a command. `--entrypoint` clears
      // `.Config.Cmd`, so there would be nothing for the loader to exec.
      wrap: (runner) => async (args, stdin) => (args[0] === "image" && !args.includes("{{.Id}}")
        ? { code: 0, stderr: "", stdout: "null\nnull\n" } : runner(args, stdin)),
    });

    expect(context.report.outcome).toBe("REFUSED");
    expect(context.report.receipt?.refusal).toEqual({
      code: "DEPLOY_BUILD_FAILED", detail: REDACTED_DETAIL, layer: "DAEMON_DEPLOY_ENGINE",
    });
    // WHICH REFUSAL THIS IS, where the redacted receipt cannot say: the command read HAPPENED and
    // answered nothing usable. That is what separates this from the store refusal below, which
    // refuses before docker is asked anything about the image's argv at all.
    // Read off the ssh argv the engine composed, not the double's `calls`: the wrapper answers the
    // image read itself, so the call never reaches the double to be recorded there.
    expect(context.sshCalls.some((call) => call[2] === "image" && !call.includes("{{.Id}}"))).toBe(true);
    expect(await resolveCandidateCommand(() => Promise.resolve(ok("null\nnull\n")), "tag:1"))
      .toBe(DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN);
    // NOTHING WAS CREATED: the image is inspected before the candidate exists.
    expect(context.double.calls.filter((call) => call[0] === "create")).toEqual([]);
    expect(context.double.state(context.candidate)).toBe("ABSENT");
  });

  it("does NOT adopt a merely CREATED container as a healthy replay", async () => {
    // THE ORPHAN A CREATE/START SPLIT INVENTS. If a deploy dies between `create` and `start`, a
    // container of the candidate's name exists but never ran. The replay branch returns early when
    // the health probe exits 0, so adopting that container would report a candidate healthy that
    // was never started. Real docker cannot: `.State.Health` does not exist until a container has
    // RUN, so `docker inspect --format '{{.State.Health.Status}}'` EXITS 1 on a created one
    // (measured, docker 29.6.2), and the double models exactly that.
    const candidate = candidateContainerName(ENVIRONMENT, SHA, "decision-1");
    const context = await deploy(delivering(PAYLOAD), { running: { [candidate]: "CREATED" } });

    expect(context.report.outcome, context.report.detail).toBe("DEPLOYED");
    // The probe DID NOT short-circuit: the candidate was brought up and delivered to for real.
    expect(context.double.calls.filter((call) => call[0] === "create")).toHaveLength(1);
    expect(context.double.calls.filter((call) => call[0] === "start")).toHaveLength(1);
    expect(context.double.copies).toHaveLength(1);
  });

  it("DOES reuse a container that already answers healthy, without recreating it", async () => {
    // The other half of the same branch, so the arm above cannot be satisfied by an engine that
    // simply never replays. A candidate already healthy is reused: no create, no cp, no start.
    const candidate = candidateContainerName(ENVIRONMENT, SHA, "decision-1");
    const context = await deploy(delivering(PAYLOAD), { running: { [candidate]: "HEALTHY" } });

    expect(context.report.outcome, context.report.detail).toBe("DEPLOYED");
    expect(context.double.calls.filter((call) => call[0] === "create")).toEqual([]);
    expect(context.double.calls.filter((call) => call[0] === "start")).toEqual([]);
    expect(context.double.copies).toEqual([]);
  });

  it.each(TARGETS)("forwards the store's own refusal and creates nothing, %s", async (_name, target) => {
    const context = await deploy(() => ({ code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY", ok: false }), { target });

    expect(context.report.outcome).toBe("REFUSED");
    expect(context.report.receipt?.refusal).toEqual({
      code: "DEPLOY_BUILD_FAILED", detail: REDACTED_DETAIL, layer: "DAEMON_DEPLOY_ENGINE",
    });
    // WHICH REFUSAL THIS IS: the store answered first, so docker was never asked for the image's
    // argv — the discriminator against DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN above, which does
    // ask. PARTIAL DELIVERY STAYS UNREPRESENTABLE: the whole read refused and nothing came up.
    expect(context.double.calls.some((call) => call[0] === "image" && !call.includes("{{.Id}}"))).toBe(false);
    expect(context.double.calls.filter((call) => call[0] === "create")).toEqual([]);
    expect(context.double.calls.filter((call) => call[0] === "cp")).toEqual([]);
    expect(context.double.copies).toEqual([]);
    expect(context.double.state(context.candidate)).toBe("ABSENT");
  });
});

/**
 * THE DOUBLE MOVED TO ITS OWN MODULE AND TWENTY FILES DID NOT. Those files import the double's
 * surface from `./deploy-ports.js`, so the re-export IS their contract, and a forgotten re-export
 * ships GREEN under typecheck whenever the twenty happen to use only a subset of what moved.
 */
describe("the docker double is re-exported from deploy-ports so no importer moved", () => {
  it("carries every RUNTIME export of the double module, at the same identity", () => {
    const advertised = ports as unknown as Readonly<Record<string, unknown>>;
    const served = double as unknown as Readonly<Record<string, unknown>>;
    // Direction 1: nothing the double serves is missing from what deploy-ports advertises.
    expect(Object.keys(served).filter((key) => !(key in advertised))).toEqual([]);
    // ...and it is the SAME binding, not a second definition that could drift.
    expect(Object.keys(served).filter((key) => advertised[key] !== served[key])).toEqual([]);
  });

  it("re-exports every TYPE the double declares, which Object.keys cannot see at all", () => {
    // THE ATTACK THIS ANSWERS: typecheck passes if the twenty importers happen to use a SUBSET of
    // what moved, and four of the double's seven exports are TYPES — invisible to a runtime key
    // check. So the export list is read off the SOURCE and split by kind. Runtime kinds must be in
    // deploy-ports's namespace; type kinds must be in the pinned list below. Adding an export to
    // the double and forgetting it here reds, instead of shipping green until a consumer reaches
    // for it.
    const source = readFileSync(new URL("./deploy-docker-double.ts", import.meta.url), "utf8");
    const declared = [...source.matchAll(/^export (interface|type|const|function) (\w+)/gmu)];
    expect(declared.length).toBeGreaterThan(0);
    const byKind = (kinds: readonly string[]): readonly string[] =>
      declared.filter((match) => kinds.includes(match[1] ?? "")).map((match) => match[2] ?? "").sort();

    expect(byKind(["const", "function"])).toEqual(["DOUBLE_IMAGE_COMMAND", "createDockerDoubleWithArgv"]);
    expect(byKind(["const", "function"]).filter((name) => !(name in ports))).toEqual([]);
    expect(byKind(["interface", "type"])).toEqual(
      ["ContainerState", "DockerCopy", "DockerDouble", "DockerDoubleOptions", "DockerDoubleTransferArgv"]);
    // Each of those five, reachable through deploy-ports.js and identical to the double's own.
    expectTypeOf<ports.ContainerState>().toEqualTypeOf<double.ContainerState>();
    expectTypeOf<ports.DockerCopy>().toEqualTypeOf<double.DockerCopy>();
    expectTypeOf<ports.DockerDouble>().toEqualTypeOf<double.DockerDouble>();
    expectTypeOf<ports.DockerDoubleOptions>().toEqualTypeOf<double.DockerDoubleOptions>();
    expectTypeOf<ports.DockerDoubleTransferArgv>().toEqualTypeOf<double.DockerDoubleTransferArgv>();
  });

  it("carries the exact NAMES the twenty importers reach for, spelled out and not iterated", () => {
    // Direction 2, and the reason it is a literal list: the arm above iterates the double's own
    // keys, so DELETING an export shrinks that iteration and it stays green. These names are the
    // twenty files' actual import contract, so a deletion reds here by name.
    expect(Object.keys(ports)).toEqual(expect.arrayContaining([
      "DOUBLE_IMAGE_COMMAND", "createDockerDouble", "createDockerDoubleWithArgv",
    ]));
    expect(DOUBLE_IMAGE_COMMAND).toBe('["docker-entrypoint.sh"]\n["node","/app/dist/server.js"]\n');
  });

  it("imports nothing from deploy-ports at RUNTIME, which is what keeps the cycle open", () => {
    // `deploy-ports.ts` `export *`s from this module, so a VALUE import back would make module
    // evaluation order load-bearing — and typecheck cannot see that. Asserted against the SOURCE
    // because the property is about the import form, which is erased before anything runs.
    const source = readFileSync(new URL("./deploy-docker-double.ts", import.meta.url), "utf8");
    const back = [...source.matchAll(/^import (type )?[^;]*?from "\.\/deploy-ports\.js";$/gmu)];
    expect(back.length).toBeGreaterThan(0);
    expect(back.filter((match) => match[1] === undefined)).toEqual([]);
  });
});

/**
 * CREATE-THEN-START, which is what remote delivery needs: a bind mount's source is resolved on the
 * DOCKER host, and for an ssh target that is not the daemon's machine. `docker create` + `docker
 * cp -` + `docker start` puts the bytes through the CLI's stdin instead, which the runner already
 * carries to a remote target. Nothing is wired to it yet — this row teaches the model only.
 */
describe("the double models create, cp and start as three separate things", () => {
  const CANDIDATE = "moe-candidate-1";
  const create = (double: ports.DockerDouble): Promise<DeployRunResult> =>
    double.docker(["create", "--name", CANDIDATE, "--network", "moe-net", "tag:1"]);

  it("does not report a CREATED container as running, healthy, or probeable", async () => {
    // The health SCRIPT says HEALTHY. The container was never started, so it must not answer from
    // it: measured on docker 29.6.2, a created container has no `.State.Health` key at all and
    // `docker inspect --format '{{.State.Health.Status}}'` EXITS 1 until `docker start`.
    const double = createDockerDouble({ health: { [CANDIDATE]: ["HEALTHY"] } });
    await create(double);

    expect(double.state(CANDIDATE)).toBe("CREATED");
    expect(double.serving()).toEqual([]);
    const probe = await double.docker(["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE]);
    expect(probe.code).toBe(1);
    expect(probe.stdout).toBe("");
  });

  it("moves the SAME container to STARTING on start, keyed on the --name value", async () => {
    const double = createDockerDouble({ health: { [CANDIDATE]: ["HEALTHY"] } });
    await create(double);
    expect(await double.docker(["start", CANDIDATE])).toEqual({ code: 0, stderr: "", stdout: CANDIDATE });

    expect(double.state(CANDIDATE)).toBe("STARTING");
    // The health script applies only once it has RUN, so the probe now answers from it — proving
    // `create` keyed the container on the same name the probe uses, not on the trailing image tag.
    const probe = await double.docker(["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE]);
    expect(probe.code).toBe(0);
    expect(probe.stdout).toBe("healthy\n");
  });

  it("refuses to START a container that was never created, naming it", async () => {
    const double = createDockerDouble();
    const started = await double.docker(["start", CANDIDATE]);

    expect(started.code).toBe(1);
    expect(started.stderr).toBe(`Error response from daemon: No such container: ${CANDIDATE}`);
    expect(double.state(CANDIDATE)).toBe("ABSENT");
  });

  it("refuses a cp to an ABSENT container rather than succeeding silently", async () => {
    // A silent success here is the failure that matters: it would let a wired deploy start a
    // candidate with NO environment and present as a 150s health timeout far from the cause.
    const double = createDockerDouble();
    const copied = await double.docker(["cp", "-", `${CANDIDATE}:/`], "PAYLOAD");

    expect(copied.code).toBe(1);
    expect(copied.stderr).toBe(`destination "${CANDIDATE}:/" must be a directory`);
    expect(double.copies).toEqual([]);
  });

  it("accepts a cp to a created container and records the payload off the ARGV", async () => {
    const double = createDockerDouble();
    await create(double);
    const copied = await double.docker(["cp", "-", `${CANDIDATE}:/`], `SECRET='${VALUE}'\n`);

    expect(copied.code).toBe(0);
    expect(double.copies).toEqual([
      { container: CANDIDATE, destination: "/", payload: `SECRET='${VALUE}'\n` },
    ]);
    // THE PROPERTY THE WHOLE SHAPE EXISTS FOR: the value rode on stdin and no argv token holds it.
    expect(double.calls.flat().some((token) => token.includes(VALUE))).toBe(false);
    // A copy does not start anything either.
    expect(double.state(CANDIDATE)).toBe("CREATED");
  });

  it("leaves the run verb exactly as it was, so no existing arm drifts", async () => {
    const double = createDockerDouble({ health: { [CANDIDATE]: ["STARTING", "HEALTHY"] } });
    expect(await double.docker(["run", "--detach", "--name", CANDIDATE, "--network", "moe-net", "tag:1"]))
      .toEqual({ code: 0, stderr: "", stdout: CANDIDATE });

    expect(double.state(CANDIDATE)).toBe("STARTING");
    const probe = await double.docker(["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE]);
    expect(probe.code).toBe(0);
    expect(probe.stdout).toBe("starting\n");
  });
});
