import { spawn } from "node:child_process";
import type { DeployCandidateEnvironmentPort } from "./deploy-candidate-environment.js";
import { createDockerDoubleWithArgv } from "./deploy-docker-double.js";
import type { DockerDouble, DockerDoubleOptions } from "./deploy-docker-double.js";
import type { DeployBuildPort } from "./deploy-image-build.js";

/**
 * The deploy engine's only effect boundary, plus the double that stands in for
 * it offline. Nothing here chooses an environment, a sha or a moment; these
 * ports only carry the bytes the caller named.
 *
 * Everything is `docker` / `ssh` as a BARE executable with an argv array and
 * `shell: false`. `shell: false` is stated rather than left to the default for
 * the same reason `orchestrator/moe-up-spawn.ts` states it: a shell would
 * re-parse an environment name, an image tag or an ssh target and silently run
 * a different argv — and a deploy target is operator-supplied text, so that is
 * a live path, not a hypothetical.
 */

export interface DeployRunResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export type DockerRunner = (args: readonly string[], stdin?: string) => Promise<DeployRunResult>;
export type SshRunner = (args: readonly string[], stdin?: string) => Promise<DeployRunResult>;

/**
 * `docker save | ssh <target> docker load` as ONE port. A pipe is a SHELL
 * construct and there is no shell here, so the children are joined in Node and
 * BOTH exit codes surfaced: a shell pipe reports only the LAST process's status.
 */
export type ImageTransferPort = (tag: string, sshTarget: string) => Promise<DeployRunResult>;

/** Where an environment deploys to. WRITTEN by `deployment.set_target`; only read here. */
export interface DeployTarget {
  /** The docker network the candidate joins. It publishes no host port. */
  readonly network: string;
  /** `null` for a local docker daemon; an ssh destination for a remote one. */
  readonly sshTarget: string | null;
  readonly url: string | null;
}

export type DeployTargetPort = (environment: string) => DeployTarget | null;

/**
 * The goal's release decision, or null when it carries none. Gate 3 is a
 * sibling row; reading a decision here is a read, and deciding one would be
 * inventing authority this row does not hold.
 */
export type ReleaseDecisionPort = (environment: string, sha: string) => string | null;

/** A migration that ran. `applied` is the engine's own batch list, so an arm can assert WHAT ran
 *  rather than that something did. */
export interface DeployMigrationApplied {
  readonly applied: readonly string[];
  readonly ok: true;
}

/**
 * A migration that did not run, or ran and failed. The code and layer are the MIGRATION's own —
 * `MIGRATION_FAILED@DAEMON_INGRESS`, `ENV_STORE_KEY_UNAVAILABLE@KEY` — carried verbatim rather
 * than restamped, because the deploy engine is not what refused. `detail` names the failing
 * migration file where the engine knew it, and NEVER a connection value: this shape reaches the
 * deploy receipt's detail, which is durable.
 */
export interface DeployMigrationRefused {
  readonly code: string;
  readonly detail: string;
  readonly layer: string;
  readonly ok: false;
}

export type DeployMigrationResult = DeployMigrationApplied | DeployMigrationRefused;

/**
 * The schema migration for an admitted deploy, as an injectable bounded host effect — so an arm
 * can drive the ordering without a database, exactly as `docker` and `ssh` are driven without one.
 * `decisionId` is passed because it is the migration's REPLAY IDENTITY: a replayed deploy must
 * replay its migration receipt rather than start a second batch, and `migrateWithBackup` owns that
 * replay by `requestId`.
 */
export type DeployMigrationPort = (
  environment: string, sha: string, decisionId: string,
) => Promise<DeployMigrationResult>;

export interface DeployPorts {
  readonly build: DeployBuildPort;
  readonly docker: DockerRunner;
  /** ABSENT means no variable delivery; `deploy-candidate-environment.ts` holds the whole design. */
  readonly environment?: DeployCandidateEnvironmentPort;
  /**
   * ABSENT means this composition did not ask for a migration — the rollback path and the arms
   * that are about docker rather than schema. It is NOT a licence for the production composition
   * to omit it: `deploy-command.ts` always supplies the real one, and the default-composition arm
   * in `deploy-service.test.ts` proves that by OBSERVATION rather than by this type.
   */
  readonly migrate?: DeployMigrationPort;
  readonly releaseDecision: ReleaseDecisionPort;
  /** Carries the same docker argv to a REMOTE target: `ssh <target> docker <args>`. */
  readonly ssh: SshRunner;
  readonly target: DeployTargetPort;
  readonly transfer: ImageTransferPort;
}

/** The same argv port locally and over SSH; never a shell command or HTTP authority in tests. */
export function createProxyPort(run: DockerRunner, network: string) {
  const config = "/etc/caddy/Caddyfile";
  const lock = "/tmp/moe-deploy-lock";
  return {
    discover: (service: string) => run(["ps", "--filter", `label=com.docker.compose.service=${service}`,
      "--filter", `network=${network}`, "--format", "{{.Names}}"]),
    lock: (proxy: string) => run(["exec", proxy, "mkdir", lock]),
    unlock: (proxy: string) => run(["exec", proxy, "rmdir", lock]),
    read: (proxy: string) => run(["exec", proxy, "cat", config]),
    write: (proxy: string, bytes: string) => run(["exec", "-i", proxy, "tee", config], bytes),
    reload: (proxy: string) => run(["exec", proxy, "caddy", "reload", "--config", config, "--adapter", "caddyfile"]),
  };
}

/**
 * 150s. DERIVED, not copied: the generated healthcheck is `--start-period=5s
 * --interval=5s --retries=20`, so docker needs 5 + 20 x 5 = 105s before it will
 * even say `unhealthy`. A shorter budget refuses before docker has decided
 * anything, which is exactly what `git-landing-port`'s 60_000 would do.
 */
export const DEPLOY_HEALTH_BUDGET_MS = 150_000;
/** Finer than docker's own 5s interval, so the transition is not missed; cheap. */
export const DEPLOY_HEALTH_POLL_MS = 2_000;
/** A build pulls a base image and installs dependencies; 60s would be a false refusal. */
export const DEPLOY_BUILD_TIMEOUT_MS = 900_000;
/** Everything else is a single fast docker call. */
export const DEPLOY_COMMAND_TIMEOUT_MS = 120_000;
/** An image can be large and the link slow, but a transfer must still end. */
export const DEPLOY_TRANSFER_TIMEOUT_MS = 1_800_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Enough of the tool's own words to diagnose from, bounded so a receipt stays small. */
export const DETAIL_TAIL = 600;

export const lastStderrLine = (stderr: string): string => {
  const lines = stderr.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  return (lines[lines.length - 1] ?? "").slice(-DETAIL_TAIL).toWellFormed();
};

/**
 * The argv builders are PRODUCTION functions used by both the real runners and
 * the double, so an argv assertion is an assertion about shipped bytes rather
 * than about a helper that restates them.
 */
export const dockerSaveArgv = (tag: string): readonly string[] => ["save", tag];
export const sshDockerLoadArgv = (sshTarget: string): readonly string[] => [sshTarget, "docker", "load"];

function runProcess(
  file: string, args: readonly string[], timeout: number, stdin?: string,
): Promise<DeployRunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], { shell: false, windowsHide: true });
    let stdout = ""; let stderr = ""; let settled = false; let uncertain = false;
    const finish = (code: number | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stderr: `${stderr}${extra}`, stdout });
    };
    const abort = (reason: string): void => { uncertain = true; stderr += `\n${reason}`; child.kill(); };
    const timer = setTimeout(() => abort("DEPLOY_COMMAND_TIMED_OUT"), timeout);
    timer.unref?.();
    const cap = (chunk: Buffer, sink: string): string =>
      sink.length < MAX_OUTPUT_BYTES ? sink + chunk.toString("utf8") : sink;
    child.stdout?.on("data", (chunk: Buffer) => { stdout = cap(chunk, stdout); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = cap(chunk, stderr); });
    // A spawn that never starts (no docker on PATH) must read as a refusal, not a throw.
    child.on("error", () => { uncertain = true; stderr += "\nDEPLOY_SPAWN_UNAVAILABLE"; });
    child.on("close", (code) => { clearTimeout(timer); finish(uncertain ? null : code); });
    if (child.stdin !== null) {
      child.stdin.on("error", () => abort("DEPLOY_STDIN_UNAVAILABLE"));
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

export const nodeDockerRunner: DockerRunner = (args, stdin) => runProcess(
  "docker", args, args[0] === "build" ? DEPLOY_BUILD_TIMEOUT_MS : DEPLOY_COMMAND_TIMEOUT_MS, stdin,
);
/**
 * SSH'S FAR END IS A SHELL, AND THAT IS NOT A DETAIL THE CALLER SHOULD HAVE TO KNOW.
 *
 * `ssh <target> a b c` does NOT deliver three argv elements: it JOINS them with spaces and the
 * remote login shell RE-SPLITS the result. So any element carrying a space, a newline, a quote or
 * a `$` arrives as several words — or, past a newline, as a whole second command.
 *
 * MEASURED against a real sshd on docker 29.6.2 while wiring the candidate's remote delivery:
 * `imageCommandArgv` asks for `--format "{{json .Config.Entrypoint}}\n{{json .Config.Cmd}}"`, and
 * unquoted that came back EXIT 127 with `sh: {{json: not found`. Worse and silent: the delivering
 * candidate's `create` carries `-c 'set -a; . /run/moe/env; set +a; exec "$0" "$@"'`, which the
 * remote shell would re-split on its spaces and semicolons and partly EXECUTE.
 *
 * Quoting belongs HERE, in the adapter that knows the transport, and not in the engine: the port's
 * contract is an argv, the local `docker` runner spawns with `shell: false` and needs no quoting,
 * and the docker double models the transport by stripping it. `args[0]` is the ssh TARGET, which
 * ssh itself consumes and the remote shell never sees, so it is passed through untouched. Words
 * made only of characters no POSIX shell treats specially are left alone, which keeps the common
 * argv readable in a process listing and in an assertion.
 */
const REMOTE_SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/u;
export const remoteShellWord = (word: string): string =>
  REMOTE_SHELL_SAFE.test(word) && word !== "" ? word : `'${word.replaceAll("'", "'\\''")}'`;

export const nodeSshRunner: SshRunner = (args, stdin) => runProcess(
  "ssh",
  args.map((word, at) => (at === 0 ? word : remoteShellWord(word))),
  DEPLOY_COMMAND_TIMEOUT_MS, stdin,
);

/**
 * `save`'s stdout is piped into `ssh`'s stdin in Node. BOTH children are awaited
 * and BOTH failures surfaced: `save` dying after `ssh` started would otherwise
 * leave `ssh` on a stdin that never closes, so it is ended on either exit path.
 */
export const nodeImageTransfer: ImageTransferPort = (tag, sshTarget) => new Promise((resolve) => {
  const save = spawn("docker", [...dockerSaveArgv(tag)], { shell: false, windowsHide: true });
  const load = spawn("ssh", [...sshDockerLoadArgv(sshTarget)], { shell: false, windowsHide: true });
  let stderr = ""; let saveCode: number | null | undefined; let loadCode: number | null | undefined;
  let settled = false;
  const collect = (label: string) => (chunk: Buffer) => {
    if (stderr.length < MAX_OUTPUT_BYTES) stderr += `${label}: ${chunk.toString("utf8")}`;
  };
  save.stderr?.on("data", collect("docker save"));
  load.stderr?.on("data", collect("ssh docker load"));
  if (save.stdout !== null && load.stdin !== null) save.stdout.pipe(load.stdin);
  else {
    // Unpipeable (either child failed to spawn): `save` would otherwise block
    // forever once its unread stdout buffer filled. Neither child is left alive.
    stderr += "deploy: could not join docker save to ssh docker load\n";
    save.kill(); load.kill();
  }
  // A transfer has no inner timeout of its own, and `ssh` can sit on a
  // host-key or password prompt indefinitely. A deploy that hangs is worse
  // than one that refuses, so both children are bounded here.
  const guard = setTimeout(() => {
    stderr += "deploy: image transfer timed out\n";
    save.kill(); load.kill();
  }, DEPLOY_TRANSFER_TIMEOUT_MS);
  guard.unref?.();
  const settle = (): void => {
    if (settled || saveCode === undefined || loadCode === undefined) return;
    settled = true;
    clearTimeout(guard);
    // The FIRST child's failure is the one a shell pipe would have swallowed.
    resolve({ code: saveCode !== 0 ? saveCode : loadCode, stderr, stdout: "" });
  };
  const fail = (label: string) => (error: Error): void => { stderr += `${label}: ${error.message}\n`; };
  save.on("error", fail("docker save")); load.on("error", fail("ssh docker load"));
  save.on("close", (code) => {
    saveCode = code;
    if (code !== 0) load.stdin?.end();
    settle();
  });
  load.on("close", (code) => { loadCode = code; settle(); });
});

/**
 * THE DOUBLE LIVES IN `deploy-docker-double.ts` and is re-exported here UNCHANGED, so the twenty
 * files importing `createDockerDouble`, `DockerDouble`, `DockerDoubleOptions`, `ContainerState` or
 * `DOUBLE_IMAGE_COMMAND` from `./deploy-ports.js` keep working with no edit. The seam is exact:
 * above is the PRODUCTION effect boundary, below is what the double models.
 */
export * from "./deploy-docker-double.js";

/**
 * The double with the two PRODUCTION argv builders above bound in. Bound HERE rather than imported
 * THERE because the reverse edge would be a runtime cycle: this file `export *`s from that one, so
 * a VALUE import back would make module evaluation order load-bearing, which typecheck misses.
 */
export const createDockerDouble = (options: DockerDoubleOptions = {}): DockerDouble =>
  createDockerDoubleWithArgv({ dockerSaveArgv, sshDockerLoadArgv }, options);
