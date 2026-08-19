import { randomBytes } from "node:crypto";
import { basename, extname, join } from "node:path";

/**
 * The dev launcher's environment layer, kept PURE over its inputs so every
 * refusal is unit-testable without a process, a store, or a filesystem.
 *
 * This is a DEVELOPMENT composer: the three store variables the daemon and the
 * wrapper both require are defaulted or minted here rather than refused, so a
 * clean checkout plus any one accepted credential is a running stack. The one
 * thing nothing downstream can invent — the provider credential the
 * `claude --bare` children authenticate with — is refused BY NAME instead.
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
 * Every credential the claude children can authenticate with, in the order the
 * launcher looks for them: subscription first, api key last. CLOSED — a name
 * absent from this roster is not a credential as far as the gate is concerned.
 */
const CLAUDE_CREDENTIAL_VARIABLES = Object.freeze([
  "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
] as const);
/** Accepted for the operator's convenience; NOT honored by the CLI itself. */
const ALIAS_CREDENTIAL = "CLAUDE_CODE_OAUTH_TOKEN";
/** The name `claude --bare` actually reads. The alias is delivered under it. */
const DELIVERED_CREDENTIAL = "ANTHROPIC_AUTH_TOKEN";
const CREDENTIAL_HINT = "(set one; run `claude setup-token` for a subscription token)";

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

function refuseCredential(): LaunchRefusal {
  // The CODE is stable and published; only the message widens, so no consumer
  // matching on MOE_UP_ENV_MISSING breaks while the operator gains all three
  // names and the subscription path in the one line they actually read.
  const variableName = CLAUDE_CREDENTIAL_VARIABLES.join(", ");
  return Object.freeze({
    code: MOE_UP_ENV_MISSING,
    message: `${MOE_UP_ENV_MISSING}: ${variableName} ${CREDENTIAL_HINT}`,
    variable: variableName,
  });
}

function secretEntry(
  name: string, source: LaunchValueSource, value: string,
): LaunchVariable {
  return Object.freeze({ name, secret: true, source, value });
}

/**
 * The credential entries the claude children need, or null when none is set.
 *
 * Any of the three accepted names satisfies the gate, but they are NOT
 * interchangeable at the other end. Measured 2026-08-19 on claude 2.1.235,
 * three arms over one token value with a no-credential control:
 * `claude -p --bare` IGNORES CLAUDE_CODE_OAUTH_TOKEN and refuses "Not logged
 * in" byte-identically to having no credential at all, while the SAME value
 * under ANTHROPIC_AUTH_TOKEN answers exit 0. So the alias is accepted and then
 * DELIVERED under the name the binary honors; accepting it without that mapping
 * would trade an honest refusal for children that spawn and fail — the exact
 * orchestration bug the refusal above exists to prevent. An operator who set
 * ANTHROPIC_AUTH_TOKEN themselves is never overwritten. Re-probe when the CLI
 * version moves: this mapping goes stale the day the alias starts working.
 */
function claudeCredentials(
  env: LaunchEnvInputs["env"],
): readonly LaunchVariable[] | null {
  let accepted: LaunchVariable | null = null;
  for (const candidate of CLAUDE_CREDENTIAL_VARIABLES) {
    const value = present(env, candidate);
    if (value !== null) {
      accepted = secretEntry(candidate, "PRESET", value);
      break;
    }
  }
  if (accepted === null) return null;
  if (accepted.name !== ALIAS_CREDENTIAL || present(env, DELIVERED_CREDENTIAL) !== null) {
    return Object.freeze([accepted]);
  }
  return Object.freeze([
    accepted, secretEntry(DELIVERED_CREDENTIAL, "MINTED", accepted.value),
  ]);
}

export function resolveLaunchEnv(inputs: LaunchEnvInputs): LaunchEnvResolution {
  const { env, repoRoot } = inputs;
  const randomHex = inputs.randomHex
    ?? ((bytes: number): string => randomBytes(bytes).toString("hex"));

  const agentCommand = variable(
    "MOE_AGENT_COMMAND", present(env, "MOE_AGENT_COMMAND"),
    () => DEFAULT_AGENT_COMMAND, "DEFAULTED",
  );

  // The one thing this launcher cannot invent: without a credential the
  // wrapper's `claude --bare` children have no auth at all (bare mode reads no
  // keychain), so they would spawn, fail, and look like an orchestration bug.
  const credentials = isClaudeCommand(agentCommand.value) ? claudeCredentials(env) : [];
  if (credentials === null) {
    return Object.freeze({ ok: false, refusals: Object.freeze([refuseCredential()]) });
  }

  const variables: readonly LaunchVariable[] = Object.freeze([
    variable("MOE_STORE_PATH", present(env, "MOE_STORE_PATH"),
      () => join(repoRoot, ...DEV_STORE_SEGMENTS), "DEFAULTED"),
    variable("MOE_PROJECT_ID", present(env, "MOE_PROJECT_ID"),
      () => DEV_PROJECT_ID, "DEFAULTED"),
    variable("MOE_DAEMON_CREDENTIAL", present(env, "MOE_DAEMON_CREDENTIAL"),
      () => randomHex(CREDENTIAL_BYTES), "MINTED", true),
    agentCommand,
    ...credentials,
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
