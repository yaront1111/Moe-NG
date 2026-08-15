/**
 * How the wrapper hands `claude` to `child_process.spawn`.
 *
 * On Windows the CLI is a `.cmd` shim, which only a shell can resolve. Node
 * deprecated argv-plus-`shell: true` (DEP0190) because it concatenates the
 * pieces unescaped, so the wrapper builds the ONE command line itself: every
 * argument is space-free by construction except the MCP config path, which is
 * quoted when it must be. Anything cmd.exe could reinterpret is refused
 * outright — the wrapper never produces such an argument, so hitting it means
 * a corrupt or hostile path, and executing something else is the wrong answer.
 */
export interface AgentSpawnInvocation {
  readonly args: readonly string[];
  readonly file: string;
  readonly shell: boolean;
}

/** Characters cmd.exe treats specially even inside a quoted argument. */
const UNQUOTABLE = /["%&|<>^\r\n]/u;

function quoteForCmd(argument: string): string {
  if (UNQUOTABLE.test(argument)) {
    throw new Error(`SPAWN_ARGUMENT_UNQUOTABLE: ${argument}`);
  }
  return /\s/u.test(argument) ? `"${argument}"` : argument;
}

export function agentSpawnInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): AgentSpawnInvocation {
  if (platform !== "win32") return Object.freeze({ args, file: command, shell: false });
  const line = [command, ...args].map(quoteForCmd).join(" ");
  return Object.freeze({ args: [], file: line, shell: true });
}
