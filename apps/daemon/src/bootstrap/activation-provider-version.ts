/**
 * `<agent command> --version`, run for real.
 *
 * The ONLY module on the activation-receipt path that starts a process. It is separate from
 * `activation-receipts-ports.ts` so that the measurement surface can be pinned as spawn-free by
 * source text, and so the two hard parts of reading a version on Windows — whether the image
 * exists, and what its output means — sit next to each other rather than inside a port bag.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";

import { agentSpawnInvocation } from "../orchestrator/agent-spawn-invocation.js";
import type { AgentSpawnInvocation } from "../orchestrator/agent-spawn-invocation.js";

/**
 * What the agent CLI answered, RAW. Deliberately the same three fields as `GitRunResult`:
 * `code === null` means the image NEVER RAN — absent, unspawnable, timed out — which the
 * measurer treats as an unmeasurable provider and refuses the whole activation on. A run that
 * produced an exit code DID happen, and is a taken reading even when its text carries no
 * version, or more text than the reader keeps.
 */
export interface ProviderVersionRun {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Bounded on every axis an external CLI controls: `MAX_OUTPUT_CHARS` caps a CLI that decides to
 * print its whole help text, by dropping the surplus rather than killing the child, and
 * `TIMEOUT_MS` cuts off one that never finishes (see `runBounded` for both).
 */
const MAX_OUTPUT_CHARS = 64 * 1024;
const TIMEOUT_MS = 10_000;

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
  let invocation: AgentSpawnInvocation;
  try {
    invocation = agentSpawnInvocation(command, ["--version"]);
  } catch (error) {
    return { code: null, stderr: String(error), stdout: "" };
  }
  return await runBounded(invocation);
}

/**
 * NOT `execFile`. That answers an output overrun by KILLING the child and rejecting with a
 * string `code` and no exit code — measured on this host, Node 24.16:
 *
 *   execFile(node, [spill-80KB.js], { maxBuffer: 65536 })
 *     -> code "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", no `killed`, stdout = the first 65536 bytes
 *
 * A CLI that said its version on line one and then kept talking would come back as `code:
 * null`, the measurer's "never ran", and refuse the whole activation against a CLI that is
 * installed and answered. So the reader keeps the first `MAX_OUTPUT_CHARS` of each stream,
 * drops the rest, and lets the child reach its own exit under the timeout: the exit code is
 * the child's, never one invented for a child the reader cut off.
 */
function runBounded(invocation: AgentSpawnInvocation): Promise<ProviderVersionRun> {
  return new Promise((resolve) => {
    const output = { stderr: "", stdout: "" };
    const keep = (stream: Readable | null, key: keyof typeof output): void => {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        if (output[key].length < MAX_OUTPUT_CHARS) {
          output[key] = `${output[key]}${chunk}`.slice(0, MAX_OUTPUT_CHARS);
        }
      });
    };
    let child: ChildProcess;
    try {
      // `windowsHide` keeps a console from flashing on an operator's desktop when the daemon
      // runs as a service.
      child = spawn(invocation.file, [...invocation.args], {
        shell: invocation.shell, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, stderr: String(error), stdout: "" });
      return;
    }
    keep(child.stdout, "stdout");
    keep(child.stderr, "stderr");
    // The reader's OWN clock, and it runs until `close`: `spawn`'s `timeout` option stops at
    // `exit`, while `close` waits for the pipes — which a grandchild can hold open (on win32 the
    // child is cmd.exe and the CLI is its grandchild, always). Destroying the streams is what
    // lets `close` follow the kill, exactly as `execFile`'s own kill does.
    let cutOff = false;
    const clock = setTimeout(() => {
      cutOff = true;
      child.kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, TIMEOUT_MS);
    // A failure to spawn (a POSIX ENOENT) lands here before any close, with the runtime's own
    // words when the child left none. The first answer wins; a close after it changes nothing.
    child.on("error", (error: unknown) => {
      clearTimeout(clock);
      resolve({ ...output, code: null, stderr: output.stderr === "" ? String(error) : output.stderr });
    });
    // `close`, not `exit`: the streams have drained, so a version written right before the exit
    // is in `output`. A child that was cut off, or killed by anyone, has no exit code of its
    // own — `null`, the same answer as a child that never started, with the reason in words
    // when the child left none.
    child.on("close", (code, signal) => {
      clearTimeout(clock);
      const ran = !cutOff && signal === null;
      resolve({
        code: ran ? code : null,
        stderr: !ran && output.stderr === ""
          ? `${invocation.file} did not finish within ${TIMEOUT_MS} ms`
          : output.stderr,
        stdout: output.stdout,
      });
    });
  });
}
