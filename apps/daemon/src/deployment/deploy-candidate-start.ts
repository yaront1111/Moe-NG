import { encodeCandidateArchive } from "./deploy-candidate-archive.js";
import {
  copyEnvironmentArgv, createCandidateArgv, resolveCandidateCommand, startCandidateArgv,
} from "./deploy-candidate-environment.js";
import type { DeployRunResult } from "./deploy-ports.js";

/**
 * BRINGING ONE CANDIDATE UP, IN THE THREE CALLS THAT REACH A REMOTE DOCKER HOST.
 *
 * The engine used to start a candidate with a single `docker run` carrying a bind mount, and a bind
 * mount's `source` is resolved on the DOCKER host. For a target with an `sshTarget` that host is not
 * the daemon's machine, the path is absent there, and docker AUTO-CREATES a missing bind source as
 * an empty DIRECTORY instead of failing — so the candidate would start, read nothing, and the
 * deploy would surface 150 seconds later as a health timeout naming no cause.
 *
 * `create` + `docker cp -` + `start` names no host path at all: the delivery rides the docker CLI's
 * STDIN, which the engine's `run()` seam already carries through `ssh <target> docker ...`. LOCAL
 * AND REMOTE ARE THE SAME CODE PATH, and there is deliberately no second `run`-shaped path for the
 * no-delivery case — two ways to start a candidate is a fix landed in one and missed in the other.
 *
 * This lives outside `deploy-service.ts` because that file is at its size ceiling, and because
 * "how a candidate is brought up" is a seam worth naming: everything here is a pure function of the
 * runner it is handed, so it performs no effect it was not given.
 */

/** The runner the deploy engine already owns: target-aware, and stdin-carrying on both targets. */
export type CandidateRunner = (args: readonly string[], stdin?: string) => Promise<DeployRunResult>;

/** Probe the candidate by name: the public URL would prove only the incumbent's health. */
export const healthArgv = (name: string): readonly string[] =>
  ["inspect", "--format", "{{.State.Health.Status}}", name];

/**
 * What one candidate needs to come up WITH a delivery: the archive that goes on `docker cp -`'s
 * stdin, and the image's own `Entrypoint ++ Cmd`, which `--entrypoint` would otherwise discard.
 * NEITHER FIELD IS A PATH. A type that cannot express a location on the docker host is what stops
 * a bind mount reappearing here and silently breaking remote targets a second time.
 */
export interface CandidateDelivery {
  readonly archive: string;
  readonly command: readonly string[];
}

/**
 * Turns the delivery text into what `bringUpCandidate` needs, or into the DETAIL of a refusal.
 *
 * BOTH LEGS REFUSE BEFORE ANY CONTAINER EXISTS, which is the point of doing this here rather than
 * inline: `--entrypoint` clears `.Config.Cmd`, so the image's own argv must be read back off the
 * image, and an image naming neither refuses `DEPLOY_ENVIRONMENT_IMAGE_COMMAND_UNKNOWN`; an
 * unencodable delivery refuses with the archive encoder's own code. Discovering either after
 * `create` would leave a container to clean up for a fault that was knowable in advance.
 */
export async function prepareCandidateDelivery(
  run: CandidateRunner, tag: string, content: string,
): Promise<CandidateDelivery | string> {
  const command = await resolveCandidateCommand((args) => run(args), tag);
  if (typeof command === "string") return command;
  const encoded = encodeCandidateArchive(content);
  return encoded.ok ? { archive: encoded.archive, command } : encoded.code;
}

/**
 * `create`, then `cp` when there is something to deliver, then `start`.
 *
 * REPLAY IS PRESERVED EXACTLY: the health probe still runs FIRST, and a container of this name that
 * already answers healthy is reused rather than recreated — a replay, not a race. A merely CREATED
 * container cannot answer it: docker's `.State.Health` key does not exist until the container has
 * RUN, so `docker inspect --format '{{.State.Health.Status}}'` EXITS NONZERO on one, measured
 * against docker 29.6.2. An interrupted deploy therefore cannot have its half-built container
 * adopted as healthy by the next one.
 *
 * FAIL CLOSED ON EVERY LEG: each result is returned VERBATIM, so the caller refuses on the code and
 * the stderr docker actually produced rather than on a code minted here. The container abandoned by
 * a failed `cp` or `start` is removed by the caller's `finally`, which is the single teardown path
 * the candidate already had — epic rail 4 wants one, not two that can disagree.
 */
export async function bringUpCandidate(
  run: CandidateRunner,
  name: string, network: string, tag: string, delivery: CandidateDelivery | null,
): Promise<DeployRunResult> {
  const existing = await run(healthArgv(name));
  if (existing.code === 0) return existing;
  const created = await run(createCandidateArgv(name, network, tag, delivery?.command ?? null));
  if (created.code !== 0) return created;
  if (delivery !== null) {
    // THE ARCHIVE IS THE STDIN ARGUMENT, NEVER AN ARGV TOKEN. `copyEnvironmentArgv` is
    // `["cp", "-", "<name>:/"]` and carries no value, so no plaintext becomes a docker CLI word,
    // reaches a process listing, or lands in anything that records the call.
    const copied = await run(copyEnvironmentArgv(name), delivery.archive);
    if (copied.code !== 0) return copied;
  }
  return run(startCandidateArgv(name));
}
