import { randomBytes } from "node:crypto";
import { basename, extname, join } from "node:path";

/**
 * The dev launcher's environment layer, kept PURE over its inputs so every
 * refusal is unit-testable without a process, a store, or a filesystem.
 *
 * This is a DEVELOPMENT composer: the three store variables the daemon and the
 * wrapper both require are defaulted or minted here rather than refused, so a
 * clean checkout plus `ANTHROPIC_API_KEY` is a running stack. The one variable
 * nothing downstream can invent — the provider credential the `claude --bare`
 * children authenticate with — is refused BY NAME instead.
 */

/** The refusal every missing-variable answer carries. */
export const MOE_UP_ENV_MISSING = "MOE_UP_ENV_MISSING" as const;

/** Where a resolved value came from, so the launcher can disclose it. */
export type LaunchValueSource = "DEFAULTED" | "MINTED" | "PRESET";

export interface LaunchVariable {
  readonly name: string;
  /** Secret values are masked by `describeLaunchVariables`, never printed. */
  readonly secret: boolean;
  readonly source: LaunchValueSource;
  readonly value: string;
}

export interface LaunchRefusal {
  readonly code: typeof MOE_UP_ENV_MISSING;
  readonly message: string;
  /** The EXACT variable that is missing — the operator's whole fix. */
  readonly variable: string;
}

export interface LaunchConfig {
  readonly agentCommand: string;
  readonly credential: string;
  /** The overlay handed to both children: only the variables this module owns. */
  readonly env: Readonly<Record<string, string>>;
  readonly ok: true;
  readonly projectId: string;
  readonly storePath: string;
  readonly variables: readonly LaunchVariable[];
}

export interface LaunchRefused {
  readonly ok: false;
  readonly refusals: readonly LaunchRefusal[];
}

export type LaunchEnvResolution = LaunchConfig | LaunchRefused;

export interface LaunchEnvInputs {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** INJECTED so two runs over identical inputs produce an identical config. */
  readonly randomHex?: (bytes: number) => string;
  readonly repoRoot: string;
}

/** The dev store lives beside the checkout, never in the user's profile. */
const DEV_STORE_SEGMENTS = [".moe-dev", "store.sqlite"] as const;
const DEV_PROJECT_ID = "moe-next-dev";
const DEFAULT_AGENT_COMMAND = "claude";
const CREDENTIAL_BYTES = 32;

/**
 * Empty is absent, the same rule `readStoreDependencyEnv` applies: an exported
 * `MOE_PROJECT_ID=` must not open a store under the empty project.
 */
function present(env: LaunchEnvInputs["env"], name: string): string | null {
  const raw = env[name];
  return raw === undefined || raw === "" ? null : raw;
}

function variable(
  name: string, preset: string | null, fallback: () => string,
  fallbackSource: LaunchValueSource, secret = false,
): LaunchVariable {
  const source: LaunchValueSource = preset === null ? fallbackSource : "PRESET";
  return Object.freeze({ name, secret, source, value: preset ?? fallback() });
}

/**
 * Does this command resolve to Claude? A bare `claude`, an absolute path, and a
 * Windows `claude.cmd` launcher are the same binary and the same auth
 * requirement; only a genuinely different command waives the key.
 */
function isClaudeCommand(command: string): boolean {
  const leaf = basename(command.replaceAll("\\", "/"));
  return leaf.slice(0, leaf.length - extname(leaf).length).toLowerCase()
    === DEFAULT_AGENT_COMMAND;
}

function refuse(variableName: string): LaunchRefusal {
  return Object.freeze({
    code: MOE_UP_ENV_MISSING,
    message: `${MOE_UP_ENV_MISSING}: ${variableName}`,
    variable: variableName,
  });
}

export function resolveLaunchEnv(inputs: LaunchEnvInputs): LaunchEnvResolution {
  const { env, repoRoot } = inputs;
  const randomHex = inputs.randomHex
    ?? ((bytes: number): string => randomBytes(bytes).toString("hex"));

  const agentCommand = variable(
    "MOE_AGENT_COMMAND", present(env, "MOE_AGENT_COMMAND"),
    () => DEFAULT_AGENT_COMMAND, "DEFAULTED",
  );

  // The only variable this launcher cannot invent: without it the wrapper's
  // `claude --bare` children have no auth at all (bare mode reads no keychain),
  // so they would spawn, fail, and look like an orchestration bug.
  const refusals = isClaudeCommand(agentCommand.value) && present(env, "ANTHROPIC_API_KEY") === null
    ? [refuse("ANTHROPIC_API_KEY")]
    : [];
  if (refusals.length > 0) return Object.freeze({ ok: false, refusals: Object.freeze(refusals) });

  const variables: readonly LaunchVariable[] = Object.freeze([
    variable("MOE_STORE_PATH", present(env, "MOE_STORE_PATH"),
      () => join(repoRoot, ...DEV_STORE_SEGMENTS), "DEFAULTED"),
    variable("MOE_PROJECT_ID", present(env, "MOE_PROJECT_ID"),
      () => DEV_PROJECT_ID, "DEFAULTED"),
    variable("MOE_DAEMON_CREDENTIAL", present(env, "MOE_DAEMON_CREDENTIAL"),
      () => randomHex(CREDENTIAL_BYTES), "MINTED", true),
    agentCommand,
  ]);

  const overlay: Record<string, string> = {};
  for (const entry of variables) overlay[entry.name] = entry.value;

  const read = (name: string): string => {
    const found = variables.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`unreachable: ${name} is always resolved`);
    return found.value;
  };

  return Object.freeze({
    agentCommand: agentCommand.value,
    credential: read("MOE_DAEMON_CREDENTIAL"),
    env: Object.freeze(overlay),
    ok: true,
    projectId: read("MOE_PROJECT_ID"),
    storePath: read("MOE_STORE_PATH"),
    variables,
  });
}

const SOURCE_WORD: Readonly<Record<LaunchValueSource, string>> = Object.freeze({
  DEFAULTED: "defaulted",
  MINTED: "minted",
  PRESET: "preset",
});

/**
 * Operator-facing disclosure. A secret is named and its provenance stated, but
 * the value never reaches the console: a dev credential printed into a scrollback
 * is a credential in every screen recording of the demo it was minted for.
 */
export function describeLaunchVariables(
  variables: readonly LaunchVariable[],
): readonly string[] {
  return variables.map((entry) => {
    const shown = entry.secret ? `<${SOURCE_WORD[entry.source]}, hidden>` : entry.value;
    return `  ${entry.name}=${shown} (${SOURCE_WORD[entry.source]})`;
  });
}
