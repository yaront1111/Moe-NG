import { basename, extname } from "node:path";

/**
 * Which provider credential an agent command requires, and how a missing one is
 * refused by name.
 *
 * Split out of `moe-up-env.ts` so the launcher's environment composition and
 * the per-provider auth rosters stay separately readable, and so each roster
 * can carry the measurement that justifies it without pushing either file over
 * the per-file line rail. Nothing here spawns, reads a file, or logs: every
 * function is pure over its arguments, so every refusal is unit-testable.
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
/** The name `claude --bare` actually reads. The alias is delivered under it. */
const DELIVERED_CREDENTIAL = "ANTHROPIC_AUTH_TOKEN";
const CREDENTIAL_HINT = "(set one; run `claude setup-token` for a subscription token)";

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
const CODEX_HINT =
  "(set one; run `codex login` once, then export CODEX_HOME so the seat travels)";

/**
 * Which roster an agent command has to satisfy. A command in neither row stays
 * ungated: this launcher refuses only the credential it can name.
 */
const CREDENTIAL_PROVIDERS = Object.freeze([
  Object.freeze({
    hint: CREDENTIAL_HINT,
    leaf: DEFAULT_AGENT_COMMAND,
    variables: CLAUDE_CREDENTIAL_VARIABLES as readonly string[],
  }),
  Object.freeze({
    hint: CODEX_HINT,
    leaf: "codex",
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

export function refuseCredential(provider: CredentialProvider): LaunchRefusal {
  // The CODE is stable and published; only the message widens, so no consumer
  // matching on MOE_UP_ENV_MISSING breaks while the operator gains every
  // accepted name and the subscription path in the one line they actually read.
  const variableName = provider.variables.join(", ");
  return Object.freeze({
    code: MOE_UP_ENV_MISSING,
    message: `${MOE_UP_ENV_MISSING}: ${variableName} ${provider.hint}`,
    variable: variableName,
  });
}

/**
 * The credential entries a provider's children need, or null when none is set.
 * Every accepted name is a SECRET entry, so `describeLaunchVariables` names it
 * and hides its value — including CODEX_HOME, which is a path rather than a
 * token but still points at the directory the seat lives in.
 *
 * Any accepted name satisfies the gate, but the claude names are NOT
 * interchangeable at the other end. Measured 2026-08-19 on claude 2.1.235,
 * three arms over one token value with a no-credential control:
 * `claude -p --bare` IGNORES CLAUDE_CODE_OAUTH_TOKEN and refuses "Not logged
 * in" byte-identically to having no credential at all, while the SAME value
 * under ANTHROPIC_AUTH_TOKEN answers exit 0. So the alias is accepted and then
 * DELIVERED under the name the binary honors; accepting it without that mapping
 * would trade an honest refusal for children that spawn and fail — the exact
 * orchestration bug the refusal above exists to prevent. An operator who set
 * ANTHROPIC_AUTH_TOKEN themselves is never overwritten. The mapping is keyed on
 * the alias NAME, which only the claude roster carries, so no codex name can
 * reach it. Re-probe when either CLI version moves.
 */
export function providerCredentials(
  provider: CredentialProvider,
  env: Readonly<Record<string, string | undefined>>,
): readonly LaunchVariable[] | null {
  let accepted: LaunchVariable | null = null;
  for (const candidate of provider.variables) {
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
