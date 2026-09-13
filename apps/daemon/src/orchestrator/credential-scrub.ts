import { CREDENTIAL_PROVIDERS, present } from "./moe-up-credentials.js";

/**
 * EVERY CREDENTIAL VALUE THIS PROCESS HOLDS, and the one scrub a published text passes through.
 *
 * `providerCredentials` answers the LAUNCHER's question — which ONE entry the children are
 * handed — and stops at the first present roster name. A scrub list built from that answer
 * covered only the selected variable. Measured on 2d7d5b30 through the composed /activation/read
 * listener: a git stderr of `fatal: env CLAUDE_CODE_OAUTH_TOKEN=<a> ANTHROPIC_API_KEY=<b>`
 * published <b> verbatim, a codex command published every ANTHROPIC_* value, and an agent
 * command no roster recognises scrubbed nothing. A scrub asks a different question — which
 * values are in this environment at all — and its answer is every present name of every roster,
 * independent of the configured command.
 *
 * Pure over its arguments. The rosters stay CLOSED in `moe-up-credentials.ts`; this module only
 * reads them.
 */

export const REDACTED = "[redacted]";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Longest first, deduplicated, empties dropped. A value contained in a longer one must be
 * replaced AFTER it, or the longer value's remnant stays on the wire; an empty value would
 * match everywhere.
 */
function ordered(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter((value) => value !== ""))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right)));
}

/**
 * Every credential VALUE `env` holds under ANY provider's roster. Only the rosters' own
 * `variables` count: the sign-in directory the launcher discloses under `CLAUDE_CONFIG_DIR` is
 * a NON-secret entry there (`secret: false`) and is not a value to hide; `CODEX_HOME` is listed
 * because the codex roster lists it.
 */
export function credentialValues(env: Environment): readonly string[] {
  const values: string[] = [];
  for (const provider of CREDENTIAL_PROVIDERS) {
    for (const name of provider.variables) {
      const value = present(env, name);
      if (value !== null) values.push(value);
    }
  }
  return ordered(values);
}

/** `text` with every occurrence of every secret replaced by the marker, in a safe order. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  return ordered(secrets).reduce((carry, secret) => carry.replaceAll(secret, REDACTED), text);
}
