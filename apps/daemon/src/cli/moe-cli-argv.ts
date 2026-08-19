/**
 * `moe`'s argv layer, PURE so every refusal is testable without a process.
 *
 * The roster below is the advertised surface and the accepted surface at once:
 * an unknown subcommand is answered by listing exactly what this binary wires,
 * never by guessing what the operator meant.
 */

export const MOE_CLI_UNKNOWN_COMMAND = "MOE_CLI_UNKNOWN_COMMAND" as const;
export const MOE_CLI_UNKNOWN_OPTION = "MOE_CLI_UNKNOWN_OPTION" as const;
export const MOE_CLI_TOO_MANY_ARGUMENTS = "MOE_CLI_TOO_MANY_ARGUMENTS" as const;

export const KNOWN_COMMANDS = Object.freeze(["init", "start", "version", "help"] as const);

export type CliCommand = (typeof KNOWN_COMMANDS)[number];

export type CliArgvRefusalCode =
  | typeof MOE_CLI_TOO_MANY_ARGUMENTS
  | typeof MOE_CLI_UNKNOWN_COMMAND
  | typeof MOE_CLI_UNKNOWN_OPTION;

export interface CliInit {
  readonly command: "init";
  readonly force: boolean;
  readonly ok: true;
  readonly targetDir: string;
}

export interface CliStart {
  readonly command: "start";
  readonly ok: true;
  readonly targetDir: string;
}

export interface CliHelp {
  readonly command: "help";
  readonly ok: true;
}

export interface CliVersion {
  readonly command: "version";
  readonly ok: true;
}

/** The two commands that only print; kept apart so `command` stays a discriminant. */
export type CliInform = CliHelp | CliVersion;

export interface CliArgvRefused {
  readonly code: CliArgvRefusalCode;
  /** The EXACT token that was refused. */
  readonly detail: string;
  readonly message: string;
  readonly ok: false;
}

export type CliInvocation = CliArgvRefused | CliHelp | CliInit | CliStart | CliVersion;

const DEFAULT_TARGET_DIR = ".";
const VERSION_WORDS = Object.freeze(["--version", "-v", "version"]);
const HELP_WORDS = Object.freeze(["--help", "-h", "help"]);

function refuse(code: CliArgvRefusalCode, detail: string, message: string): CliArgvRefused {
  return Object.freeze({ code, detail, message, ok: false });
}

interface Split {
  readonly options: readonly string[];
  readonly positionals: readonly string[];
}

/** Options are anything that starts with `-`; everything else is positional. */
function split(rest: readonly string[]): Split {
  const options: string[] = [];
  const positionals: string[] = [];
  for (const token of rest) (token.startsWith("-") ? options : positionals).push(token);
  return { options: Object.freeze(options), positionals: Object.freeze(positionals) };
}

/**
 * A second positional is refused rather than dropped: `moe init my demo` is an
 * unquoted path far more often than it is a typo, and silently initializing
 * `my` is the worst possible answer to it.
 */
function targetOf(parts: Split): CliArgvRefused | string {
  if (parts.positionals.length > 1) {
    const extra = parts.positionals[1] as string;
    return refuse(
      MOE_CLI_TOO_MANY_ARGUMENTS, extra,
      `${MOE_CLI_TOO_MANY_ARGUMENTS}: ${extra} — quote a target that contains spaces`,
    );
  }
  return parts.positionals[0] ?? DEFAULT_TARGET_DIR;
}

function unknownOption(parts: Split, allowed: readonly string[]): CliArgvRefused | null {
  const found = parts.options.find((option) => !allowed.includes(option));
  if (found === undefined) return null;
  const known = allowed.length === 0 ? "none" : allowed.join(", ");
  return refuse(
    MOE_CLI_UNKNOWN_OPTION, found,
    `${MOE_CLI_UNKNOWN_OPTION}: ${found} — options for this command: ${known}`,
  );
}

export function parseCliArgv(argv: readonly string[]): CliInvocation {
  const head = argv[0];
  if (head === undefined || HELP_WORDS.includes(head)) {
    return Object.freeze({ command: "help", ok: true });
  }
  if (VERSION_WORDS.includes(head)) return Object.freeze({ command: "version", ok: true });

  const parts = split(argv.slice(1));
  if (head === "init") {
    const bad = unknownOption(parts, ["--force"]);
    if (bad !== null) return bad;
    const target = targetOf(parts);
    if (typeof target !== "string") return target;
    return Object.freeze({
      command: "init", force: parts.options.includes("--force"), ok: true, targetDir: target,
    });
  }
  if (head === "start") {
    const bad = unknownOption(parts, []);
    if (bad !== null) return bad;
    const target = targetOf(parts);
    if (typeof target !== "string") return target;
    return Object.freeze({ command: "start", ok: true, targetDir: target });
  }
  return refuse(
    MOE_CLI_UNKNOWN_COMMAND, head,
    `${MOE_CLI_UNKNOWN_COMMAND}: ${head} — known commands: ${KNOWN_COMMANDS.join(", ")}`,
  );
}
