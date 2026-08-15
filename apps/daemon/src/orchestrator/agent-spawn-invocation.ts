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

/** The one refusal this layer can raise; closed so a caller can switch on it. */
export type SpawnInvocationRefusalCode = "SPAWN_ARGUMENT_UNQUOTABLE";

/** The layer that answered, named because more than one layer can refuse a spawn. */
export const SPAWN_INVOCATION_LAYER = "agent-spawn-invocation";

/**
 * A refusal carrying its stable code and its refusing layer as real properties.
 * The message is the bare code: the refused argument is deliberately NOT echoed
 * back, because the argument here is the per-agent MCP config path.
 */
export class SpawnInvocationRefusal extends Error {
  public readonly code: SpawnInvocationRefusalCode;
  public readonly layer: string;

  public constructor(code: SpawnInvocationRefusalCode) {
    super(code);
    this.name = "SpawnInvocationRefusal";
    this.code = code;
    this.layer = SPAWN_INVOCATION_LAYER;
  }
}

/** Characters cmd.exe treats specially even inside a quoted argument. */
const UNQUOTABLE = /["%&|<>^\r\n]/u;

function quoteForCmd(argument: string): string {
  if (UNQUOTABLE.test(argument)) {
    throw new SpawnInvocationRefusal("SPAWN_ARGUMENT_UNQUOTABLE");
  }
  if (argument === "") return '""';
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
