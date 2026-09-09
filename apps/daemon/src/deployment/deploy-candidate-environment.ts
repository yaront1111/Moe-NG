import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readEnvironmentDelivery } from "../environment/environment-delivery.js";
import type { EnvironmentDeliveredVariables } from "../environment/environment-delivery.js";
import type { EnvironmentStoreConfig } from "../environment/environment-projection.js";
import { DEPLOY_ENGINE_STAMP } from "./deploy-receipt-contracts.js";

/**
 * HOW THE DEPLOYED CANDIDATE RECEIVES ITS ENVIRONMENT — THROUGH A MOUNTED FILE, NEVER THROUGH ARGV.
 *
 * THE MEASUREMENT THAT DECIDES THE WHOLE SHAPE, run against docker 29.6.2 on a real deployed image
 * before a line of this was written:
 *   `docker create --env NAME=<value> <image>` then `docker inspect <name> | grep -c <value>` => 1.
 *     The value is printed inside `.Config.Env`. `--env-file` and bare `--env NAME` resolve
 *     client-side into the same field, and image `ENV` is worse still: it lives in the layers and
 *     in `docker history`, outliving the container.
 *   The same value delivered by `--mount type=bind,source=<host file>,target=/run/moe/env,readonly`
 *     => 0. `.Mounts` carries the source PATH and never the contents.
 * `tests/e2e/foundation/platform-secret-canary.e2e.test.ts` sweeps the candidate's `docker inspect`
 * stdout for a planted value and asserts ZERO hits, so "deliver the environment" and "the canary
 * still finds nothing" are jointly satisfiable by exactly one family of designs, and this is it.
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
 * that actually answered. The plaintext exists in exactly two places: the file this module writes,
 * and the environment of the process the container starts.
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

/** What `startCandidate` needs to mount a delivery: the host file, and the argv it must restore. */
export interface CandidateEnvironmentMount {
  /** The image's own `Entrypoint ++ Cmd`, which `--entrypoint` would otherwise discard. */
  readonly command: readonly string[];
  /** The host path of the written file. A path, never a value — this is what `docker inspect` shows. */
  readonly source: string;
}

/**
 * Internal candidate: no public port conflict with the incumbent or proxy.
 *
 * WITH NO MOUNT THIS IS BYTE-IDENTICAL TO WHAT IT ALWAYS WAS, deliberately: a composition that
 * asks for no delivery — every arm that is about docker rather than about variables — starts the
 * candidate exactly as before, so no existing assertion becomes vacuous by drifting past it.
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
 * docker host. A bind mount's `source` is resolved on the DOCKER host, and for `sshTarget !== null`
 * that is not the daemon's machine — which is why `resolveCandidateMount` refuses remotely at all.
 * `create` + `cp -` + `start` names no host path anywhere: the bytes ride the docker CLI's STDIN,
 * which `run()` already carries through `ssh <target> docker ...`. NOTHING HERE IS WIRED YET —
 * `runCandidateArgv` is untouched and stays the only builder `startCandidate` calls.
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
 * The mount a candidate starts with, or the DETAIL its refusal carries. `run` is the deploy
 * engine's own target-aware runner, passed in rather than imported: this module performs no effect
 * it was not handed, exactly as `deploy-ports.ts` requires of everything that touches docker.
 */
export async function resolveCandidateMount(
  run: (args: readonly string[]) => Promise<{ readonly code: number | null; readonly stdout: string }>,
  sshTarget: string | null, tag: string, source: string,
): Promise<CandidateEnvironmentMount | string> {
  if (sshTarget !== null) return DEPLOY_ENVIRONMENT_REMOTE_UNSUPPORTED;
  const inspected = await run(imageCommandArgv(tag));
  const command = inspected.code === 0 ? parseImageCommand(inspected.stdout) : null;
  return command === null ? DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN : { command, source };
}

export const DEPLOY_ENVIRONMENT_FILE_UNWRITABLE = "DEPLOY_ENVIRONMENT_FILE_UNWRITABLE" as const;
/**
 * A bind mount names a path on the DOCKER HOST, and a remote target's docker host is not the
 * daemon's. Refusing is the fail-closed answer and the only honest one: docker AUTO-CREATES a
 * missing bind source as an empty DIRECTORY, so mounting anyway would start a candidate whose
 * loader cannot read its delivery, and the deploy would present as a 150s health timeout with no
 * hint of the cause. Delivering to a remote target needs a channel this engine does not have —
 * `run()` wraps every remote call as `ssh <target> docker ...`, so there is no `tee` to write with.
 */
export const DEPLOY_ENVIRONMENT_REMOTE_UNSUPPORTED = "DEPLOY_ENVIRONMENT_REMOTE_UNSUPPORTED" as const;
/** An image that names neither an entrypoint nor a command cannot be started by docker either. */
export const DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN = "DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN" as const;

/**
 * A delivery that is ready to mount. `source` is null when the environment holds NO variables:
 * there is nothing to mount, the candidate starts on the unchanged argv, and a project that never
 * set a variable deploys byte-identically to how it deployed before this existed.
 */
export interface DeployCandidateEnvironmentReady {
  /** MUST NOT THROW: it is called from the deploy's `finally`, where a throw would replace the
   *  report the deploy had already produced. Idempotent — calling it twice is not an error. */
  readonly dispose: () => void;
  readonly ok: true;
  readonly source: string | null;
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
 * REMOVAL NEVER THROWS. `dispose` is called from the deploy's `finally`, and a throw there would
 * REPLACE the report the deploy had already produced — turning a DEPLOYED deploy into a crash over
 * a temp file. `force: true` already tolerates an absent path; this additionally tolerates the
 * EPERM/EBUSY a Windows host can answer while something still holds the handle. A file that
 * survives is bounded, visible and mode-0600; a lost deploy report is not.
 */
function remove(directory: string): void {
  try { rmSync(directory, { force: true, recursive: true }); } catch { /* see above */ }
}

/**
 * Resolves an environment to a mountable file, or refuses. PARTIAL DELIVERY IS IMPOSSIBLE BY
 * CONSTRUCTION: `readEnvironmentDelivery` refuses the WHOLE read when one seal will not open, and
 * that refusal is returned here unchanged rather than degraded to an empty map — a candidate that
 * silently receives three of its four variables fails hours later and far from the fault.
 *
 * WHAT REMOVES THE FILE: the caller, unconditionally, in the `finally` of the deploy it belongs to
 * — success, refusal and throw alike. The window is the deploy itself, not the container's
 * lifetime: the loader reads the mount once at startup, and the candidate carries no restart
 * policy, so nothing needs it again. The directory is created by `mkdtempSync`, so two concurrent
 * deploys cannot collide on the path, and the file is written owner-only.
 */
export function candidateEnvironmentPort(
  config: EnvironmentStoreConfig,
): DeployCandidateEnvironmentPort {
  return (environment) => {
    const delivered = readEnvironmentDelivery(config, environment);
    if (!delivered.ok) return { code: delivered.code, layer: delivered.layer, ok: false };
    const encoded = encodeCandidateEnvironment(delivered.variables);
    if (encoded === "") return { dispose: () => {}, ok: true, source: null };
    let directory: string | null = null;
    try {
      directory = mkdtempSync(join(tmpdir(), "moe-deploy-env-"));
      const source = join(directory, "env");
      writeFileSync(source, encoded, { encoding: "utf8", mode: 0o600 });
      const owned = directory;
      return { dispose: () => { remove(owned); }, ok: true, source };
    } catch {
      // The thrown error names the path and can carry the bytes; neither reaches a refusal.
      if (directory !== null) remove(directory);
      return { code: DEPLOY_ENVIRONMENT_FILE_UNWRITABLE, layer: DEPLOY_ENGINE_STAMP, ok: false };
    }
  };
}
