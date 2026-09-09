/**
 * `<agent command> --version`, run for real.
 *
 * The ONLY module on the activation-receipt path that starts a process. It is separate from
 * `activation-receipts-ports.ts` so that the measurement surface can be pinned as spawn-free by
 * source text, and so the two hard parts of reading a version on Windows — whether the image
 * exists, and what its output means — sit next to each other rather than inside a port bag.
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { agentSpawnInvocation } from "../orchestrator/agent-spawn-invocation.js";

/**
 * What the agent CLI answered, RAW. Deliberately the same three fields as `GitRunResult`:
 * `code === null` means the image NEVER RAN — absent, unspawnable, timed out — which the
 * measurer treats as an unmeasurable provider and refuses the whole activation on. A run that
 * produced an exit code DID happen, and is a taken reading even when its text carries no
 * version.
 */
export interface ProviderVersionRun {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const execFileAsync = promisify(execFile);

/**
 * Bounded on every axis an external CLI controls. `windowsHide` keeps a console from flashing on
 * an operator's desktop when the daemon runs as a service, and `maxBuffer` caps a CLI that
 * decides to print its whole help text.
 */
const SPAWN_LIMITS = Object.freeze({ maxBuffer: 64 * 1024, timeout: 10_000, windowsHide: true });

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The extensions cmd.exe would try, when the host does not say. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function candidatesFor(
  command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform,
): readonly string[] {
  if (platform !== "win32") return [command];
  const extensions = (env["PATHEXT"] ?? DEFAULT_PATHEXT).split(";").filter((ext) => ext !== "");
  // A command that already names its own extension resolves as written FIRST: `claude.cmd`
  // must not be probed as `claude.cmd.EXE` and reported absent.
  return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

/**
 * WHETHER THE IMAGE EXISTS, decided WITHOUT starting a shell.
 *
 * On win32 `agentSpawnInvocation` hands one quoted LINE to cmd.exe, and cmd.exe reports an
 * unknown command as EXIT 1 with a localized sentence on stderr — measured on this host:
 *
 *   'moe-no-such-cli-xyz' is not recognized as an internal or external command,   -> code 1
 *
 * By exit code that is indistinguishable from a CLI that ran and failed, so trusting it would
 * MEASURE a provider on a machine with no agent installed and let a witness be minted on top of
 * it: the fail-open this member exists to close. Matching the sentence instead would bind the
 * daemon to an English Windows. So resolution happens here, on PATH and PATHEXT, before any
 * process starts — and a command that cannot be resolved is `code: null`, the same answer a
 * POSIX ENOENT already produces.
 */
export function resolveAgentImage(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (command === "") return null;
  const named = command.includes("/") || command.includes("\\");
  const directories = named
    ? [""]
    : (env["PATH"] ?? env["Path"] ?? "").split(delimiter).filter((entry) => entry !== "");
  for (const directory of directories) {
    for (const candidate of candidatesFor(command, env, platform)) {
      const path = directory === ""
        ? candidate
        : join(directory, candidate);
      // A FILE, not merely a name that exists. A DIRECTORY called `claude` on PATH would
      // satisfy `existsSync`, and cmd.exe would then fail it with exit 1 -- back to the
      // fail-open this whole function exists to close. `statSync` throws on absence, which is
      // the ordinary case here, so it is caught rather than pre-checked.
      // A relative `./bin/agent` resolves against the daemon's cwd, the same cwd the spawn
      // would inherit.
      if (isFile(path)) return isAbsolute(path) ? path : candidate;
    }
  }
  return null;
}

/**
 * Total by construction: a throw is an ANSWER, never a rejected promise, because a measurement
 * that threw would take the whole activation read down with a stack instead of refusing one
 * member with its code.
 *
 * The spawn goes through `agentSpawnInvocation` — the repo's existing answer to Node 24 being
 * unable to spawn a `.cmd` shim with `shell: false` (measured at `doctor-version.node.ts:93-96`)
 * — so this reads the SAME image the seat will later launch rather than a second,
 * differently-resolved one.
 */
export async function readProviderVersion(command: string): Promise<ProviderVersionRun> {
  const resolved = resolveAgentImage(command);
  if (resolved === null) {
    return { code: null, stderr: `${command} was not found on PATH`, stdout: "" };
  }
  let invocation;
  try {
    invocation = agentSpawnInvocation(command, ["--version"]);
  } catch (error) {
    return { code: null, stderr: String(error), stdout: "" };
  }
  try {
    const { stderr, stdout } = await execFileAsync(invocation.file, [...invocation.args], {
      ...SPAWN_LIMITS, shell: invocation.shell,
    });
    return { code: 0, stderr, stdout };
  } catch (error) {
    // `execFile` rejects on a non-zero exit AND on a failure to spawn or a timeout. Only the
    // first is a run, so the exit code survives only when the child actually produced one.
    const failure = error as {
      readonly code?: unknown; readonly killed?: unknown;
      readonly stderr?: unknown; readonly stdout?: unknown;
    };
    const ran = typeof failure.code === "number" && failure.killed !== true;
    return {
      code: ran ? (failure.code as number) : null,
      stderr: String(failure.stderr ?? error),
      // A CLI that overran `maxBuffer` or exited non-zero still WROTE something, and the
      // version lives on its first line. Dropping it would turn a readable answer into
      // UNKNOWN for no reason.
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
    };
  }
}
