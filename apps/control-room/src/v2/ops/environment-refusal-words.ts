import type { EnvironmentWriteOutcome } from "./environment-variables-port.js";

/**
 * WHAT TO DO ABOUT A REFUSED ENVIRONMENT WRITE.
 *
 * The daemon supplies fixed prose saying what HAPPENED; this says what to DO. An operator
 * staring at ENV_STORE_KEY_UNAVAILABLE needs to know it is a condition they can fix rather than
 * a bug to file, and one staring at OPERATOR_PRINCIPAL_REQUIRED on a screen whose read half
 * plainly works will otherwise guess - wrongly - that their variable name is at fault.
 *
 * NOT ONE OF THESE STRINGS IS BUILT FROM INPUT. That is the whole reason they live in a frozen
 * constant rather than in a template at the call site: ENV_VALUE_TOO_LARGE names the LIMIT, which
 * is a constant, and never the size or the content of what was typed. The daemon's own details
 * are asserted DIGIT-FREE upstream for the same reason - interpolating "value X is too large" is
 * how a secret escapes through the one field a refusal is allowed to carry - which is exactly why
 * the daemon cannot state the limit and this side must.
 *
 * NO SECOND CODE-TO-LAYER MAP LIVES HERE. The layer always travels on the refusal from whichever
 * authority answered; this module keys on the code alone.
 */

/**
 * `MAX_ENVIRONMENT_VALUE_BYTES` from apps/daemon/src/environment/environment-contracts.ts,
 * restated because apps/control-room has no import edge to apps/daemon.
 */
export const VALUE_LIMIT_BYTES = 4_096;

export const ENVIRONMENT_REFUSAL_ADVICE: Readonly<Record<string, string>> = Object.freeze({
  // The store's own CLOSED four-code roster (`ENVIRONMENT_CODE_LAYERS`). No fifth is minted here.
  ENV_ENVIRONMENT_UNKNOWN: "Pick one of the environments this project has.",
  ENV_NAME_INVALID: "Use an uppercase letter first, then uppercase letters, digits or underscores.",
  ENV_STORE_KEY_UNAVAILABLE:
    "The daemon could not derive the store key from its credential. Check the daemon credential is"
    + " set and restart it, then try again. Nothing was stored.",
  ENV_VALUE_TOO_LARGE: `Shorten the value to under ${String(VALUE_LIMIT_BYTES)} bytes.`,
  /**
   * NOT an ENV_ code and not the store's: the daemon's AUTHORIZATION fence, MEASURED rather than
   * anticipated - tests/e2e/control-room/environment-variables.spec.ts raises it against a real
   * daemon and pins both directions. Both environment kinds sit in `OPERATOR_PRINCIPAL_KINDS`
   * (daemon-command-vocabulary.ts) and are absent from the widening that lets a paired browser
   * spend `repository.publish`, so a paired session READS this table and cannot WRITE it.
   */
  OPERATOR_PRINCIPAL_REQUIRED:
    "Setting a variable is reserved for the operator principal the daemon was configured with, so"
    + " a paired browser session cannot do it. Set it from the daemon host instead. Reading this"
    + " table is unaffected.",
});

/** The daemon prose, then what to do about it. Never the submitted value, on either half. */
export function refusalWords(outcome: EnvironmentWriteOutcome): string {
  if (outcome.ok) return "";
  const advice = ENVIRONMENT_REFUSAL_ADVICE[outcome.code];
  const stated = outcome.detail ?? "The daemon refused this change.";
  return advice === undefined ? stated : `${stated} ${advice}`;
}
