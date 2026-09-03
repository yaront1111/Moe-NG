import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

/**
 * Which provider credential an agent command requires, and how a missing one is
 * refused by name.
 *
 * Split out of `moe-up-env.ts` so the launcher's environment composition and
 * the per-provider auth rosters stay separately readable, and so each roster
 * can carry the measurement that justifies it without pushing either file over
 * the per-file line rail. Nothing here spawns or logs; the one filesystem read
 * (does the operator's sign-in exist?) is injectable, so every refusal is
 * unit-testable without a real home directory.
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

/** Answers "does this path exist?"; `existsSync` in production, a stub in tests. */
export type FileExists = (path: string) => boolean;

export const DEFAULT_AGENT_COMMAND = "claude";

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
/** The environment name the claude CLI actually reads. The alias is delivered under it. */
const DELIVERED_CREDENTIAL = "ANTHROPIC_AUTH_TOKEN";
const CREDENTIAL_HINT =
  "(set one, or sign in once: run `claude` and `/login`; `claude setup-token` also works)";

/**
 * The same roster for codex children. Measured 2026-08-20 against codex-cli
 * 0.147.0: `codex exec --help` states "auth still uses `CODEX_HOME`", and a
 * CODEX_HOME pointed at an empty directory answers "Not logged in" while the
 * default one answers "Logged in using ChatGPT" — so a ChatGPT SUBSCRIPTION
 * seat minted by one interactive `codex login` travels as a PATH, not a token.
 * That is the one structural difference from the claude roster above. The other
 * three are the token and api-key arms the cli reads from the environment.
 * CLOSED, and stale the day the cli version moves: re-probe the binary rather
 * than extending this from documentation.
 */
const CODEX_CREDENTIAL_VARIABLES = Object.freeze([
  "CODEX_HOME", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY",
] as const);
const CODEX_HINT = "(set one, or run `codex login` once)";

/**
 * The sign-in a provider's CLI keeps on disk after one interactive login, and
 * the variable that names the directory holding it. When no environment
 * credential is set, a present sign-in file satisfies the gate and the launcher
 * delivers the DIRECTORY name explicitly, so the disclosure lines show which
 * sign-in the seats will use. Measured 2026-09-03 (claude 2.1.x, codex-cli
 * 0.152.0): a `claude -p` child spawned without `--bare` and with no
 * `ANTHROPIC_*` variable answers from `~/.claude/.credentials.json`; a
 * `codex exec --ignore-user-config` child reaches the API from `~/.codex/auth.json`.
 */
interface LoginCredential {
  /** Directory under the home directory that holds the sign-in file. */
  readonly defaultDirectory: string;
  /** The sign-in file's name inside that directory. */
  readonly file: string;
  /** The variable that relocates the directory, delivered so the seat agrees. */
  readonly variable: string;
}

const CLAUDE_LOGIN: LoginCredential = Object.freeze({
  defaultDirectory: ".claude", file: ".credentials.json", variable: "CLAUDE_CONFIG_DIR",
});
const CODEX_LOGIN: LoginCredential = Object.freeze({
  defaultDirectory: ".codex", file: "auth.json", variable: "CODEX_HOME",
});

/**
 * Which roster an agent command has to satisfy. A command in neither row stays
 * ungated: this launcher refuses only the credential it can name.
 */
const CREDENTIAL_PROVIDERS = Object.freeze([
  Object.freeze({
    hint: CREDENTIAL_HINT,
    leaf: DEFAULT_AGENT_COMMAND,
    login: CLAUDE_LOGIN,
    variables: CLAUDE_CREDENTIAL_VARIABLES as readonly string[],
  }),
  Object.freeze({
    hint: CODEX_HINT,
    leaf: "codex",
    login: CODEX_LOGIN,
    variables: CODEX_CREDENTIAL_VARIABLES as readonly string[],
  }),
] as const);

export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

/**
 * Empty is absent, the same rule `readStoreDependencyEnv` applies: an exported
 * `MOE_PROJECT_ID=` must not open a store under the empty project.
 */
export function present(
  env: Readonly<Record<string, string | undefined>>, name: string,
): string | null {
  const raw = env[name];
  return raw === undefined || raw === "" ? null : raw;
}

export function secretEntry(
  name: string, source: LaunchValueSource, value: string,
): LaunchVariable {
  return Object.freeze({ name, secret: true, source, value });
}

/**
 * Which provider, if any, does this command resolve to? A bare `claude`, an
 * absolute path, and a Windows `claude.cmd` launcher are the same binary and
 * the same auth requirement; only a genuinely different command waives the key.
 */
export function providerFor(command: string): CredentialProvider | undefined {
  const leaf = basename(command.replaceAll("\\", "/"));
  const name = leaf.slice(0, leaf.length - extname(leaf).length).toLowerCase();
  return CREDENTIAL_PROVIDERS.find((provider) => provider.leaf === name);
}

/** The home directory as the CHILD will see it: the forwarded variables first. */
function homeOf(env: Readonly<Record<string, string | undefined>>): string {
  return present(env, "USERPROFILE") ?? present(env, "HOME") ?? homedir();
}

/** The directory a provider's sign-in lives in, honoring its relocation variable. */
function loginDirectory(
  provider: CredentialProvider, env: Readonly<Record<string, string | undefined>>,
): { readonly directory: string; readonly source: LaunchValueSource } {
  const preset = present(env, provider.login.variable);
  if (preset !== null) return { directory: preset, source: "PRESET" };
  return {
    directory: join(homeOf(env), provider.login.defaultDirectory), source: "DEFAULTED",
  };
}

/** The sign-in file the gate looked for; named in the refusal so the fix is concrete. */
export function loginCredentialPath(
  provider: CredentialProvider, env: Readonly<Record<string, string | undefined>>,
): string {
  return join(loginDirectory(provider, env).directory, provider.login.file);
}

export function refuseCredential(
  provider: CredentialProvider, loginPath: string,
): LaunchRefusal {
  // The CODE is stable and published; only the message widens, so no consumer
  // matching on MOE_UP_ENV_MISSING breaks while the operator gains every
  // accepted name, the sign-in path that was looked for, and the fix in the one
  // line they actually read.
  const variableName = provider.variables.join(", ");
  return Object.freeze({
    code: MOE_UP_ENV_MISSING,
    message: `${MOE_UP_ENV_MISSING}: ${variableName} ${provider.hint}; no sign-in at ${loginPath}`,
    variable: variableName,
  });
}

/**
 * The credential entries a provider's children need, or null when none is set
 * AND no sign-in file exists. Every accepted environment name is a SECRET
 * entry, so `describeLaunchVariables` names it and hides its value — including
 * CODEX_HOME, which is a path rather than a token but still points at the
 * directory the seat lives in. A sign-in found on disk is delivered as the
 * NON-secret directory variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) so the
 * operator can read which login the seats use; nothing secret leaves the file.
 *
 * An environment credential always wins over the sign-in file, matching the
 * CLI's own precedence ("ANTHROPIC_API_KEY or another auth source is set and
 * takes precedence over your claude.ai login", claude 2.1.x). Any accepted name
 * satisfies the gate, but the claude names are NOT interchangeable at the other
 * end. Measured 2026-08-19 on claude 2.1.235, three arms over one token value
 * with a no-credential control: `claude -p` IGNORES CLAUDE_CODE_OAUTH_TOKEN and
 * refuses "Not logged in" byte-identically to having no credential at all,
 * while the SAME value under ANTHROPIC_AUTH_TOKEN answers exit 0. So the alias
 * is accepted and then DELIVERED under the name the binary honors; accepting it
 * without that mapping would trade an honest refusal for children that spawn
 * and fail — the exact orchestration bug the refusal above exists to prevent.
 * An operator who set ANTHROPIC_AUTH_TOKEN themselves is never overwritten. The
 * mapping is keyed on the alias NAME, which only the claude roster carries, so
 * no codex name can reach it. Re-probe when either CLI version moves.
 */
export function providerCredentials(
  provider: CredentialProvider,
  env: Readonly<Record<string, string | undefined>>,
  fileExists: FileExists = existsSync,
): readonly LaunchVariable[] | null {
  let accepted: LaunchVariable | null = null;
  for (const candidate of provider.variables) {
    const value = present(env, candidate);
    if (value !== null) {
      accepted = secretEntry(candidate, "PRESET", value);
      break;
    }
  }
  if (accepted === null) {
    const login = loginDirectory(provider, env);
    if (!fileExists(join(login.directory, provider.login.file))) return null;
    return Object.freeze([Object.freeze({
      name: provider.login.variable, secret: false, source: login.source, value: login.directory,
    })]);
  }
  if (accepted.name !== ALIAS_CREDENTIAL || present(env, DELIVERED_CREDENTIAL) !== null) {
    return Object.freeze([accepted]);
  }
  return Object.freeze([
    accepted, secretEntry(DELIVERED_CREDENTIAL, "MINTED", accepted.value),
  ]);
}
