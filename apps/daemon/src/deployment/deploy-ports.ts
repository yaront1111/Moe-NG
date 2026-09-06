import { spawn } from "node:child_process";

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

export interface DeployPorts {
  readonly docker: DockerRunner;
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
export const nodeSshRunner: SshRunner = (args, stdin) =>
  runProcess("ssh", args, DEPLOY_COMMAND_TIMEOUT_MS, stdin);

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

export type ContainerState = "ABSENT" | "STARTING" | "HEALTHY" | "STOPPED" | "REMOVED";

export interface DockerDoubleOptions {
  readonly proxyConfig?: string;
  readonly proxyNames?: readonly string[];
  readonly appContainer?: string;
  readonly lockHeld?: boolean;
  readonly reloadCodes?: readonly (number | null)[];
  readonly rewriteCodes?: readonly (number | null)[];
  readonly reloadAppliesOnFailure?: boolean;
  /** docker's own last stderr line when `build` must refuse. */
  readonly buildStderr?: string;
  /** Every docker call refuses to spawn, as it would with no docker on PATH. */
  readonly dockerUnavailable?: boolean;
  /** Health answers per container, in order; the LAST entry repeats forever. */
  readonly health?: Readonly<Record<string, readonly ContainerState[]>>;
  readonly imageDigest?: string;
  /** Containers already running before this deploy, with their health. */
  readonly running?: Readonly<Record<string, ContainerState>>;
  readonly saveStderr?: string;
  readonly sshStderr?: string;
}

const ok = (stdout = ""): DeployRunResult => ({ code: 0, stderr: "", stdout });
const failed = (stderr: string, code: number | null = 1): DeployRunResult =>
  ({ code, stderr, stdout: "" });

export interface DockerDouble {
  readonly transitions: readonly { readonly argv: readonly string[]; readonly serving: readonly string[] }[];
  readonly writes: readonly string[];
  upstream(): string;
  config(): string;
  locked(): boolean;
  /** Every docker argv, in call order. */
  readonly calls: readonly (readonly string[])[];
  readonly docker: DockerRunner;
  readonly ssh: SshRunner;
  readonly sshCalls: readonly (readonly string[])[];
  readonly transfer: ImageTransferPort;
  /** What the container IS, not what was invoked on it. */
  state(name: string): ContainerState;
  /** Every container currently answering, in insertion order. */
  serving(): readonly string[];
}

/**
 * A STATE MACHINE, not an argv recorder. A recorder answers "what was invoked,
 * in what order"; only a state machine answers "what was RUNNING at that point",
 * which is the property a health refusal must leave defined. Production-tier on
 * purpose: the flip and rollback rows drive this same model, and two models of
 * what docker did is two things to reason about during an incident.
 */
export function createDockerDouble(options: DockerDoubleOptions = {}): DockerDouble {
  const calls: (readonly string[])[] = [];
  const sshCalls: (readonly string[])[] = [];
  const states = new Map<string, ContainerState>(Object.entries(options.running ?? {}));
  const probes = new Map<string, number>();
  const digest = options.imageDigest ?? `sha256:${"a".repeat(64)}`;
  let config = options.proxyConfig ?? "";
  const readUpstream = () => /^\s*reverse_proxy ([\w.-]+):3000\s*$/mu.exec(config)?.[1] ?? "";
  let upstream = readUpstream(); let locked = options.lockHeld ?? false;
  let reloads = 0; let rewrites = 0;
  const writes: string[] = [];
  const serving = (): string[] => {
    const name = upstream === "app" ? options.appContainer ?? "app" : upstream;
    return states.get(name) === "HEALTHY" ? [name] : [];
  };
  const transitions = [{ argv: ["initial"], serving: serving() }];
  const proxyCall = (args: readonly string[], stdin?: string): DeployRunResult => {
    if (args[0] === "ps") return ok((args.includes("label=com.docker.compose.service=proxy")
      ? options.proxyNames ?? (config === "" ? [] : ["proxy"]) : [options.appContainer ?? "app"]).join("\n"));
    if (args.includes("mkdir")) {
      if (locked) return failed("lock exists");
      locked = true; return ok();
    }
    if (args.includes("rmdir")) { locked = false; return ok(); }
    if (args.includes("cat")) return ok(config);
    if (args.includes("tee")) {
      writes.push(stdin ?? "");
      const code = options.rewriteCodes?.[rewrites++];
      if (code !== undefined && code !== 0) return failed("write refused", code);
      config = stdin ?? ""; return ok();
    }
    if (args.includes("reload")) {
      const code = options.reloadCodes?.[reloads++];
      if (code === undefined || code === 0 || options.reloadAppliesOnFailure === true) upstream = readUpstream();
      return code === undefined || code === 0 ? ok() : failed("reload refused", code);
    }
    return failed("unsupported proxy argv");
  };
  // A container that was never created cannot report health, whatever the script
  // says: real `docker inspect` exits nonzero for a name that does not exist.
  const healthOf = (name: string): ContainerState => {
    const current = states.get(name);
    if (current === undefined || current === "REMOVED") return "ABSENT";
    const scripted = options.health?.[name];
    if (scripted === undefined || scripted.length === 0) return current;
    const seen = probes.get(name) ?? 0;
    probes.set(name, seen + 1);
    return scripted[Math.min(seen, scripted.length - 1)] as ContainerState;
  };
  const dispatch = (args: readonly string[], stdin?: string): DeployRunResult => {
    if (options.dockerUnavailable === true) return failed("docker: not found", null);
    const [verb, ...rest] = args;
    if (verb === "exec" || verb === "ps") return proxyCall(args, stdin);
    const named = rest[rest.length - 1] ?? "";
    if (verb === "build") {
      return options.buildStderr === undefined ? ok() : failed(options.buildStderr);
    }
    if (verb === "run") {
      // The container name is the `--name` VALUE, never the trailing argv —
      // that last token is the image tag, and keying on it would track a
      // container that does not exist under a name nothing ever probes.
      const flag = args.indexOf("--name");
      const name = flag === -1 ? named : args[flag + 1] ?? named;
      states.set(name, "STARTING");
      return ok(name);
    }
    if (verb === "inspect") {
      const state = healthOf(named);
      // An absent container is NOT inserted: recording the probe would create
      // the very key that makes the next probe answer from the script.
      if (state !== "ABSENT") states.set(named, state);
      return state === "ABSENT" ? failed("No such object") : ok(`${state.toLowerCase()}\n`);
    }
    if (verb === "image") return ok(`${digest}\n`);
    if (verb === "stop") { states.set(named, "STOPPED"); return ok(); }
    if (verb === "rm") { states.set(named, "REMOVED"); return ok(); }
    if (verb === "save") {
      return options.saveStderr === undefined ? ok() : failed(options.saveStderr);
    }
    return ok();
  };
  const docker: DockerRunner = (args, stdin) => {
    calls.push([...args]);
    const result = dispatch(args, stdin);
    transitions.push({ argv: [...args], serving: serving() });
    return Promise.resolve(result);
  };
  const transfer: ImageTransferPort = (tag, sshTarget) => {
    calls.push([...dockerSaveArgv(tag)]);
    sshCalls.push([...sshDockerLoadArgv(sshTarget)]);
    if (options.saveStderr !== undefined) return Promise.resolve(failed(`docker save: ${options.saveStderr}`));
    if (options.sshStderr !== undefined) return Promise.resolve(failed(`ssh docker load: ${options.sshStderr}`));
    return Promise.resolve(ok());
  };
  // A remote call is the SAME docker argv wrapped in `ssh <target> docker ...`.
  // Unwrapping it here rather than giving the double a second model keeps "what
  // docker did" a single answer whether the target was local or remote.
  const ssh: SshRunner = (args, stdin) => {
    sshCalls.push([...args]);
    const docked = args.indexOf("docker");
    return docked === -1 ? Promise.resolve(ok()) : docker(args.slice(docked + 1), stdin);
  };
  return {
    calls, docker, serving, transitions, writes,
    upstream: () => upstream, config: () => config, locked: () => locked,
    ssh, sshCalls, state: (name) => states.get(name) ?? "ABSENT", transfer,
  };
}
