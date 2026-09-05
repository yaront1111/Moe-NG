import { spawnSync } from "node:child_process";

/**
 * Whether this host can actually build and run an image — as a seam SEPARATE from the test that
 * needs it, so the refusal and its reason code stay assertable on a host with no docker at all.
 *
 * THE CLI EXISTING IS NOT THE DAEMON RUNNING. Measured on the host this row was built on: `docker`
 * resolves to a real executable, and `docker version --format '{{.Server.Version}}'` answers
 *
 *     failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if
 *     the path is correct and if the daemon is running
 *
 * Classifying on "the binary was found" would call that host docker-capable and the build would
 * then fail somewhere far less legible. Classifying on the exit status is no better: the status
 * varies by docker build and is trivially swallowed by a pipe. So the discriminator is the one
 * thing only a live daemon can produce — a parseable SERVER version on stdout.
 */

/** Raised when this host cannot reach a docker daemon. DoD 4: loud, never a skip. */
export const DEPLOY_DOCKER_UNAVAILABLE = "DEPLOY_DOCKER_UNAVAILABLE" as const;

/** What a `docker version` spawn produced. Kept separate so classification is testable offline. */
export interface DockerProbeOutcome {
  /** The spawn itself failed (ENOENT when docker is not installed at all). */
  readonly spawnError: string | null;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export type DockerAvailability =
  | { readonly available: true; readonly serverVersion: string }
  | { readonly available: false; readonly code: typeof DEPLOY_DOCKER_UNAVAILABLE; readonly detail: string };

/** A docker server version looks like `27.4.0` — major.minor at minimum, on its own line. */
const SERVER_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?/;

/** First non-empty line, so a warning banner ahead of the value does not defeat the match. */
function firstMeaningfulLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "";
}

/** The whole decision, as a pure function of the spawn's result. */
export function classifyDockerProbe(outcome: DockerProbeOutcome): DockerAvailability {
  if (outcome.spawnError !== null) {
    return { available: false, code: DEPLOY_DOCKER_UNAVAILABLE, detail: `docker could not be spawned: ${outcome.spawnError}` };
  }

  const candidate = firstMeaningfulLine(outcome.stdout);
  if (!SERVER_VERSION_PATTERN.test(candidate)) {
    const reported = firstMeaningfulLine(outcome.stderr) || candidate || "docker printed no server version";
    return {
      available: false,
      code: DEPLOY_DOCKER_UNAVAILABLE,
      detail: `no docker daemon answered (exit ${String(outcome.status)}): ${reported}`,
    };
  }

  return { available: true, serverVersion: candidate };
}

/**
 * Executable `docker`, argv array, `shell:false`. Never a hard-coded absolute path and never a
 * command string: the host resolves the executable, and a shell would re-parse the format braces.
 */
export function probeDocker(): DockerAvailability {
  const outcome = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    shell: false,
    timeout: 20_000,
  });

  return classifyDockerProbe({
    spawnError: outcome.error === undefined ? null : outcome.error.message,
    status: outcome.status,
    stderr: outcome.stderr ?? "",
    stdout: outcome.stdout ?? "",
  });
}

/**
 * The single line DoD 4 requires to be quoted when the build arm cannot run. One format, produced
 * in one place, so the record quotes what the code emits rather than a paraphrase of it.
 */
export function dockerUnavailableLine(detail: string): string {
  return `${DEPLOY_DOCKER_UNAVAILABLE}: ${detail}`;
}
