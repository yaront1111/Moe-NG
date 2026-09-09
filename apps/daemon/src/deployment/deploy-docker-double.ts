import type { DeployBuildPort } from "./deploy-image-build.js";
import type {
  DeployRunResult, DockerRunner, ImageTransferPort, SshRunner,
} from "./deploy-ports.js";

/**
 * THE OFFLINE DOCKER DOUBLE, split out of `deploy-ports.ts` so neither file grows past the point
 * where it stops being readable. `deploy-ports.ts` RE-EXPORTS everything here, so the twenty files
 * importing this surface from `./deploy-ports.js` are untouched by the split.
 *
 * THE ARGV BUILDERS ARE PASSED IN, NOT IMPORTED BACK. `transfer` records `dockerSaveArgv` and
 * `sshDockerLoadArgv`, PRODUCTION functions that stay in `deploy-ports.ts`. Importing them back at
 * runtime would close a cycle — this module imported first would pull in `deploy-ports.ts`, which
 * would `export *` from a namespace still mid evaluation, and typecheck cannot see that. So the
 * factory RECEIVES them and the only edge back is `import type`, erased by `verbatimModuleSyntax`.
 */

/** The two production argv builders the double's `transfer` records, handed in to avoid a cycle. */
export interface DockerDoubleTransferArgv {
  readonly dockerSaveArgv: (tag: string) => readonly string[];
  readonly sshDockerLoadArgv: (sshTarget: string) => readonly string[];
}

/**
 * `CREATED` is what `docker create` made and nothing started. NOT `STARTING`: measured on docker
 * 29.6.2, a created container carries no `.State.Health` key at all, so `docker inspect --format
 * '{{.State.Health.Status}}'` EXITS 1 with a template parsing error, and only after `docker start`
 * does it exit 0 and answer `starting`.
 */
export type ContainerState =
  | "ABSENT" | "CREATED" | "STARTING" | "HEALTHY" | "STOPPED" | "REMOVED";

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

/** The double's answer to `imageCommandArgv`: `Entrypoint ++ Cmd`, as real docker prints them. */
export const DOUBLE_IMAGE_COMMAND = '["docker-entrypoint.sh"]\n["node","/app/dist/server.js"]\n';
const ok = (stdout = ""): DeployRunResult => ({ code: 0, stderr: "", stdout });
const failed = (stderr: string, code: number | null = 1): DeployRunResult =>
  ({ code, stderr, stdout: "" });

/** The container name is the `--name` VALUE, never the trailing argv — that last token is the
 *  image tag. Shared by `run` and `create` so the two cannot drift onto different keys. */
const namedByFlag = (args: readonly string[], fallback: string): string => {
  const flag = args.indexOf("--name");
  return flag === -1 ? fallback : args[flag + 1] ?? fallback;
};

/** `<container>:<path>` as `docker cp` writes it, split on the FIRST colon. */
const splitCopyTarget = (token: string): { container: string; destination: string } | null => {
  const colon = token.indexOf(":");
  return colon <= 0 ? null : { container: token.slice(0, colon), destination: token.slice(colon + 1) };
};

/** One `docker cp -` call. The payload rode on STDIN, so an arm can prove no value reached argv. */
export interface DockerCopy {
  readonly container: string;
  readonly destination: string;
  readonly payload: string;
}

export interface DockerDouble {
  readonly build: DeployBuildPort;
  /** Every `docker cp -` accepted, in call order. A refused copy records nothing. */
  readonly copies: readonly DockerCopy[];
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
export function createDockerDoubleWithArgv(
  argv: DockerDoubleTransferArgv, options: DockerDoubleOptions = {},
): DockerDouble {
  const calls: (readonly string[])[] = [];
  const copies: DockerCopy[] = [];
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
    // A CREATED container has never RUN, so no healthcheck has executed and the script does not
    // apply: consulting it would let a created-never-started candidate answer HEALTHY.
    if (current === "CREATED") return "CREATED";
    const scripted = options.health?.[name];
    if (scripted === undefined || scripted.length === 0) return current;
    const seen = probes.get(name) ?? 0;
    probes.set(name, seen + 1);
    return scripted[Math.min(seen, scripted.length - 1)] as ContainerState;
  };
  /**
   * `docker cp - <container>:<dest>`. THE PAYLOAD RIDES ON STDIN and is recorded apart from
   * `calls`, so an arm can assert the bytes arrived AND that no argv token carried them. A copy to
   * an absent container REFUSES — measured on docker 29.6.2, `docker cp - absent:/ < archive.tar`
   * exits 1 with `destination "absent:/" must be a directory`. Answering `ok` is the failure that
   * matters: it lets a wired deploy start a candidate with NO environment, presenting as a health
   * timeout far from the cause.
   */
  const copyIn = (args: readonly string[], stdin?: string): DeployRunResult => {
    const token = args.find((arg) => arg.includes(":")) ?? "";
    const target = splitCopyTarget(token);
    if (target === null) return failed("docker cp: destination must be container:path");
    const current = states.get(target.container);
    if (current === undefined || current === "REMOVED") return failed(`destination "${token}" must be a directory`);
    copies.push({ container: target.container, destination: target.destination, payload: stdin ?? "" });
    return ok();
  };
  const dispatch = (args: readonly string[], stdin?: string): DeployRunResult => {
    if (options.dockerUnavailable === true) return failed("docker: not found", null);
    const [verb, ...rest] = args;
    if (verb === "exec" || verb === "ps") return proxyCall(args, stdin);
    const named = rest[rest.length - 1] ?? "";
    if (verb === "build") {
      return options.buildStderr === undefined ? ok() : failed(options.buildStderr);
    }
    if (verb === "run" || verb === "create") {
      // `create` makes the container and starts NOTHING; `run` does both. Keyed the same way, on
      // the `--name` VALUE, so a candidate is the same container however it was brought to be.
      const name = namedByFlag(args, named);
      states.set(name, verb === "run" ? "STARTING" : "CREATED");
      return ok(name);
    }
    // `docker start <name>`. Real docker refuses a name it does not have; so must this, or a
    // wired deploy could "start" nothing and then blame the health probe for the timeout.
    if (verb === "start") {
      const current = states.get(named);
      if (current === undefined || current === "REMOVED") {
        return failed(`Error response from daemon: No such container: ${named}`);
      }
      states.set(named, "STARTING");
      return ok(named);
    }
    if (verb === "cp") return copyIn(args, stdin);
    if (verb === "inspect") {
      const state = healthOf(named);
      // An absent container is NOT inserted: recording the probe would create
      // the very key that makes the next probe answer from the script.
      if (state !== "ABSENT") states.set(named, state);
      // A CREATED container has no `.State.Health` key at all, so real docker answers a template
      // parsing error and EXITS 1 rather than naming a state. Measured on docker 29.6.2 against a
      // container carrying a healthcheck: EXIT 1 before `start`, EXIT 0 and `starting` after it.
      if (state === "CREATED") return failed('template parsing error: map has no entry for key "Health"');
      return state === "ABSENT" ? failed("No such object") : ok(`${state.toLowerCase()}\n`);
    }
    // TWO image reads, not one: `--entrypoint` clears the image CMD, so a delivering deploy reads
    // the argv back first. Answering only the digest models a docker no candidate could start on.
    if (verb === "image") return ok(args.includes("{{.Id}}") ? `${digest}\n` : DOUBLE_IMAGE_COMMAND);
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
    calls.push([...argv.dockerSaveArgv(tag)]);
    sshCalls.push([...argv.sshDockerLoadArgv(sshTarget)]);
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
    build: request => docker(["build", "--tag", request.tag, "-"]),
    calls, copies, docker, serving, transitions, writes,
    upstream: () => upstream, config: () => config, locked: () => locked,
    ssh, sshCalls, state: (name) => states.get(name) ?? "ABSENT", transfer,
  };
}