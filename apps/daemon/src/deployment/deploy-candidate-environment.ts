import { readEnvironmentDelivery } from "../environment/environment-delivery.js";
import type { EnvironmentDeliveredVariables } from "../environment/environment-delivery.js";
import type { EnvironmentStoreConfig } from "../environment/environment-projection.js";

/**
 * HOW THE DEPLOYED CANDIDATE RECEIVES ITS ENVIRONMENT — THROUGH A FILE COPIED IN ON THE DOCKER
 * CLI'S STDIN, NEVER THROUGH ARGV AND NEVER THROUGH A PATH ON THE DOCKER HOST.
 *
 * THE MEASUREMENT THAT DECIDES THE WHOLE SHAPE, run against docker 29.6.2 on a real deployed image
 * before a line of this was written:
 *   `docker create --env NAME=<value> <image>` then `docker inspect <name> | grep -c <value>` => 1.
 *     The value is printed inside `.Config.Env`. `--env-file` and bare `--env NAME` resolve
 *     client-side into the same field, and image `ENV` is worse still: it lives in the layers and
 *     in `docker history`, outliving the container.
 *   The same value delivered as a FILE the container holds at /run/moe/env => 0. `docker inspect`
 *     can name a mount's source PATH; it can never name the CONTENTS of a file inside the rootfs.
 * `tests/e2e/foundation/platform-secret-canary.e2e.test.ts` sweeps the candidate's `docker inspect`
 * stdout for a planted value and asserts ZERO hits, so "deliver the environment" and "the canary
 * still finds nothing" are jointly satisfiable by exactly one family of designs, and this is it.
 *
 * WHY THE FILE ARRIVES ON STDIN RATHER THAN THROUGH A BIND MOUNT — THE WHOLE REASON THIS MODULE
 * CHANGED. A bind mount's `source` is resolved on the DOCKER host, and when the target names an
 * `sshTarget` that host is not the daemon's machine: the path is simply absent there, and docker
 * AUTO-CREATES a missing bind source as an empty DIRECTORY rather than failing, so the candidate
 * would start, its loader would read nothing, and the deploy would present as a 150-second health
 * timeout naming no cause. `create` + `docker cp -` + `start` names no host path anywhere: the
 * bytes travel host memory -> the docker CLI's stdin -> the container's filesystem, and `run()`
 * already carries stdin through `ssh <target> docker ...`. LOCAL AND REMOTE ARE THEREFORE THE SAME
 * CODE PATH, and nothing is ever written to the daemon's own disk.
 *
 * WHY THE COMMAND IS OVERRIDDEN RATHER THAN THE IMAGE CHANGED. Nothing in the generated image
 * loads a file, so something has to. Overriding the command to a shell that sources the mount and
 * then `exec`s the image's OWN argv keeps `process.env` semantics identical between the candidate
 * and the compose-managed incumbent — the property that matters, since the same generated
 * application code runs under both — and needs no change to the Dockerfile, the generator, or the
 * generator's exact-line assertions. `docker inspect` then shows a shell path, a loader script that
 * contains no values, and a mount source path.
 *
 * TWO MEASURED FACTS THE SHAPE DEPENDS ON, neither of them guessable from the Dockerfile:
 *   1. THE IMAGE HAS AN ENTRYPOINT even though the generated Dockerfile sets none — the node base
 *      image contributes `["docker-entrypoint.sh"]`. Dropping it would change how the image starts.
 *   2. `--entrypoint` CLEARS `.Config.Cmd`. So `exec "$@"` alone would exec nothing: the original
 *      `Entrypoint ++ Cmd` must be read back off the image and passed explicitly. That is what
 *      `imageCommandArgv` and `parseImageCommand` are for, and why an image that reports neither
 *      refuses instead of starting a container with no command.
 *
 * NO VALUE REACHES A LOG, A RECEIPT OR AN ERROR PATH. The refusals here are minted from a fixed
 * detail table keyed by code, exactly as `environment-contracts.ts` and `deploy-migration-context.ts`
 * do; the environment slice's own refusals are FORWARDED UNCHANGED, carrying the code and the layer
 * that actually answered. The plaintext exists in exactly two places: the string this module hands
 * back to the deploy engine, and the environment of the process the container starts. It is never
 * a docker argv token, and since this module stopped writing a host file it is never at rest.
 */

/** Where the delivery is mounted inside the candidate. Read-only, and read once at startup. */
export const CANDIDATE_ENVIRONMENT_PATH = "/run/moe/env";
/** Measured present in the deployed image; the override needs a shell to source the mount at all. */
export const CANDIDATE_ENVIRONMENT_SHELL = "/bin/sh";
/**
 * `$0` and `$@` are the image's own argv, passed after the script — so this string is FIXED and
 * carries no variable name and no value. `set -a` exports what the file assigns; `set +a` closes
 * the window again before the application is exec'd, so nothing the app itself assigns is exported.
 */
export const CANDIDATE_ENVIRONMENT_LOADER =
  `set -a; . ${CANDIDATE_ENVIRONMENT_PATH}; set +a; exec "$0" "$@"`;

/**
 * POSIX single quoting, which has NO expansion of any kind inside it: a value carrying `$(whoami)`,
 * a backtick, a newline or a `;` is assigned verbatim rather than executed. An embedded `'` is
 * closed, escaped and reopened — the standard complete encoding. This is the one place an operator
 * value becomes shell text, so it is the one place an injection could exist.
 *
 * Names are NOT re-checked here: `readEnvironmentDelivery` already refuses `ENV_NAME_INVALID` for
 * anything outside `/^[A-Z][A-Z0-9_]*$/`, so every name that reaches this function is already
 * shell-safe, and a second grammar would be a second place for the answer to drift. A NUL byte in a
 * value cannot be delivered to any process by any mechanism — a POSIX environment block is
 * NUL-terminated strings — so it is the store's grammar to tighten, not this encoder's.
 */
export function encodeCandidateEnvironment(variables: EnvironmentDeliveredVariables): string {
  return Object.entries(variables)
    .map(([name, value]) => `${name}='${value.replace(/'/gu, "'\\''")}'\n`)
    .join("");
}

/**
 * NO LONGER A PRODUCTION SHAPE. It is the parameter type of `runCandidateArgv`, which nothing in
 * the deploy engine calls any more; both are kept exported because they are the frozen baseline the
 * migration to `create`/`cp`/`start` is measured against, and because
 * `tests/e2e/control-room/fake-docker-health-seed.test.ts` still pins the old verb through them.
 */
export interface CandidateEnvironmentMount {
  /** The image's own `Entrypoint ++ Cmd`, which `--entrypoint` would otherwise discard. */
  readonly command: readonly string[];
  /** The host path of the written file. A path, never a value — this is what `docker inspect` shows. */
  readonly source: string;
}

/**
 * SUPERSEDED BY `createCandidateArgv` + `copyEnvironmentArgv` + `startCandidateArgv`, AND RETAINED
 * DELIBERATELY. No deploy-engine path builds this argv any more: its mount arm names a path on the
 * docker host, which is precisely what cannot reach a remote target. It stays exported, and
 * byte-identical, as the frozen baseline the migration is compared against and because a file
 * outside this row's scope still pins the old verb through it. Do not call it from production.
 */
export const runCandidateArgv = (
  name: string, network: string, tag: string, mount: CandidateEnvironmentMount | null = null,
): readonly string[] => (mount === null
  ? ["run", "--detach", "--name", name, "--network", network, tag]
  : ["run", "--detach", "--name", name, "--network", network,
    "--mount", `type=bind,source=${mount.source},target=${CANDIDATE_ENVIRONMENT_PATH},readonly`,
    "--entrypoint", CANDIDATE_ENVIRONMENT_SHELL, tag, "-c", CANDIDATE_ENVIRONMENT_LOADER,
    ...mount.command]);

/**
 * THE SAME CANDIDATE, BROUGHT UP IN THREE CALLS INSTEAD OF ONE, so the delivery can reach a REMOTE
 * docker host. `create` + `cp -` + `start` names no host path anywhere: the bytes ride the docker
 * CLI's STDIN, which `run()` already carries through `ssh <target> docker ...`. THIS IS NOW THE
 * ONLY WAY THE ENGINE STARTS A CANDIDATE, on every target and whether or not there are variables
 * to deliver — a second start path would be a fix landed in one half and silently missed in the
 * other.
 *
 * `command` is the image's own `Entrypoint ++ Cmd`, which `--entrypoint` discards. It is a bare
 * string array rather than a `CandidateEnvironmentMount` ON PURPOSE: that type carries a host
 * `source`, and a type that cannot express a host path is what stops one reappearing here.
 */
export const createCandidateArgv = (
  name: string, network: string, tag: string, command: readonly string[] | null = null,
): readonly string[] => (command === null
  ? ["create", "--name", name, "--network", network, tag]
  : ["create", "--name", name, "--network", network,
    "--entrypoint", CANDIDATE_ENVIRONMENT_SHELL, tag, "-c", CANDIDATE_ENVIRONMENT_LOADER, ...command]);

/**
 * `docker cp - <name>:/` — the archive on STDIN, so NO TOKEN HERE CARRIES A VALUE OR A PATH.
 *
 * The destination is `/` and the archive carries `run/moe/env` with its parent, because `/run/moe`
 * does not exist in the image and copying to a missing directory is the one shape that cannot
 * fail. NO `--archive`/`-a`: measured against docker 29.6.2, `docker cp -` already honours the
 * USTAR header's uid and gid, and the same archive written root-owned makes the file unreadable to
 * the `USER node` the image ends on.
 */
export const copyEnvironmentArgv = (name: string): readonly string[] => ["cp", "-", `${name}:/`];

/** The container name alone. `create` already carries the network, the entrypoint and the argv. */
export const startCandidateArgv = (name: string): readonly string[] => ["start", name];

/** Two JSON lines rather than one object: `.Config` also carries the image's `Env`, which is not ours to read. */
export const imageCommandArgv = (tag: string): readonly string[] =>
  ["image", "inspect", "--format", "{{json .Config.Entrypoint}}\n{{json .Config.Cmd}}", tag];

/** `Entrypoint ++ Cmd`, or null when the image names neither and so could not be started at all. */
export function parseImageCommand(stdout: string): readonly string[] | null {
  const command: string[] = [];
  for (const line of stdout.split(/\r?\n/u).map((text) => text.trim()).filter((text) => text !== "")) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return null; }
    if (parsed === null) continue;
    if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string")) return null;
    command.push(...(parsed as string[]));
  }
  return command.length === 0 ? null : command;
}

/**
 * The image's OWN `Entrypoint ++ Cmd`, which the candidate must be restarted on because
 * `--entrypoint` clears `.Config.Cmd` — or the DETAIL its refusal carries. `run` is the deploy
 * engine's own target-aware runner, passed in rather than imported: this module performs no effect
 * it was not handed, exactly as `deploy-ports.ts` requires of everything that touches docker.
 *
 * IT TAKES NO `sshTarget`, AND THAT ABSENCE IS THE POINT. It used to refuse outright for a remote
 * target because the delivery was a bind mount; a delivery that rides stdin resolves identically
 * whichever docker host answers, so there is nothing here for the target to change.
 */
export async function resolveCandidateCommand(
  run: (args: readonly string[]) => Promise<{ readonly code: number | null; readonly stdout: string }>,
  tag: string,
): Promise<readonly string[] | string> {
  const inspected = await run(imageCommandArgv(tag));
  const command = inspected.code === 0 ? parseImageCommand(inspected.stdout) : null;
  return command === null ? DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN : command;
}

/** An image that names neither an entrypoint nor a command cannot be started by docker either. */
export const DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN = "DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN" as const;

/**
 * A delivery ready to copy into the candidate. `content` is the ENCODED TEXT, not a path: there is
 * no host file to name, to secure, or to remove, and therefore no plaintext at rest on the daemon.
 * It is null when the environment holds NO variables — nothing is copied, no `cp` call is issued,
 * and a project that never set a variable deploys on the bare `create`/`start` pair.
 */
export interface DeployCandidateEnvironmentReady {
  readonly content: string | null;
  readonly ok: true;
}

/** The environment slice's own refusal, forwarded — or this module's file-write refusal. */
export interface DeployCandidateEnvironmentRefused {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
}

export type DeployCandidateEnvironmentResult =
  | DeployCandidateEnvironmentReady
  | DeployCandidateEnvironmentRefused;

export type DeployCandidateEnvironmentPort = (environment: string) => DeployCandidateEnvironmentResult;

/**
 * Resolves an environment to the text a candidate will be given, or refuses. PARTIAL DELIVERY IS
 * IMPOSSIBLE BY CONSTRUCTION: `readEnvironmentDelivery` refuses the WHOLE read when one seal will
 * not open, and that refusal is returned here unchanged rather than degraded to an empty map — a
 * candidate that silently receives three of its four variables fails hours later and far from the
 * fault.
 *
 * THERE IS NOTHING TO DISPOSE OF, AND THAT IS A DELIBERATE PROPERTY RATHER THAN AN OMISSION. This
 * used to write the delivery to an owner-only temp file so a bind mount could name it, which put
 * the plaintext at rest on the daemon's disk and made a `finally` responsible for removing it —
 * one more exit path that could leak. The bytes now stay in this process's memory until the docker
 * CLI reads them off stdin, so the window is the call itself and no cleanup can be forgotten.
 */
export function candidateEnvironmentPort(
  config: EnvironmentStoreConfig,
): DeployCandidateEnvironmentPort {
  return (environment) => {
    const delivered = readEnvironmentDelivery(config, environment);
    if (!delivered.ok) return { code: delivered.code, layer: delivered.layer, ok: false };
    const encoded = encodeCandidateEnvironment(delivered.variables);
    return { content: encoded === "" ? null : encoded, ok: true };
  };
}
