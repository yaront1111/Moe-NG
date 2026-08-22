import type { LiveSetupResult } from "./live/live-config.js";

/**
 * What the composition root mounts, decided ONCE and by value.
 *
 * The default is the daemon. Frozen fixtures are a development convenience and
 * they are never a fallback: a build with no credentials gets a notice naming
 * exactly what is missing, because fixtures rendered where live data was
 * expected are indistinguishable from a working system that has nothing to say.
 *
 * Modelled as one tri-state rather than two booleans scattered through JSX
 * precisely so that silent fallback has nowhere to hide — every arm is a value
 * this module returns, and every arm is asserted.
 */

/** Sorted, and exhaustive: a fourth arm cannot appear without reddening its pin. */
export const SHELL_MODES = Object.freeze([
  "CONFIG_NOTICE",
  "FIXTURES",
  "LIVE",
] as const);

export type ShellMode = (typeof SHELL_MODES)[number];

/**
 * The two build-time variables `live-config.ts` refuses without. Named here so
 * the notice prints the same strings the resolver's refusal is about, rather
 * than a prose paraphrase that can drift away from the code that reads them.
 */
export const LIVE_CREDENTIAL_ENV_VARS = Object.freeze([
  "VITE_MOE_LIVE_CREDENTIAL",
  "VITE_MOE_LIVE_CSRF",
] as const);

/** `?fixtures=1`, and only that exact value: a switch, not a truthiness test. */
export const FIXTURES_QUERY_PARAM = "fixtures";

/** The refusal that means "nobody configured this", as opposed to "the gate said no". */
const CREDENTIALS_ABSENT_CODE = "LIVE_CONFIG_MISSING";

/**
 * `search` is the raw `location.search`; `setup` is the build's resolved live
 * configuration, passed in rather than read here so this stays pure.
 *
 * Precedence, and why: an explicit `?fixtures=1` wins over everything, including
 * a legacy `?live=1` in the same URL. Both are explicit requests, but the
 * fixture one is the only request that can be honoured no matter what the build
 * carries — resolving it never depends on the environment — so honouring it
 * first keeps the URL's meaning independent of who built the bundle.
 *
 * A compat refusal stays on the LIVE arm deliberately: credentials WERE
 * configured, so a notice telling the operator to set them would name the wrong
 * cause. The live attachment renders that refusal's own stable code instead.
 */
export function resolveShellMode(search: string, setup: LiveSetupResult): ShellMode {
  const params = new URLSearchParams(search);
  if (params.get(FIXTURES_QUERY_PARAM) === "1") return "FIXTURES";
  if (!setup.ok && setup.code === CREDENTIALS_ABSENT_CODE) return "CONFIG_NOTICE";
  return "LIVE";
}
