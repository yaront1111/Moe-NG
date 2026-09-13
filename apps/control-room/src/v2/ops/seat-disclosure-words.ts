import type { ActivationReadOutcome, ActivationReceiptView } from "../../live/live-activation.js";
import type { SessionsAgentProvider } from "../../live/live-sessions.js";
import { SEAT_FACT_UNMEASURED } from "../../live/live-sessions.js";
import {
  CREDENTIAL_SOURCE_UNRECOGNISED, credentialSource, credentialSourceWords,
} from "../resources/resources-credential.js";

/**
 * WHAT THE SEATS SCREEN IS ALLOWED TO SAY ABOUT A PROVIDER AND ITS CREDENTIAL.
 *
 * Pure, so the one property in this row that cannot be walked back is testable without a
 * renderer: A CREDENTIAL VALUE MUST NEVER REACH AN OPERATOR'S SCREEN, because a screenshot
 * pasted into a bug report cannot be recalled.
 *
 * That property is STRUCTURAL here, not a matter of care. `credentialWords` reads the
 * credential ref the daemon carries in the provider receipt's `reason` ONLY through the
 * CLOSED grammar in resources-credential.ts and renders ONLY that grammar's OUTPUT -
 * `parsed.cli` and `credentialSourceWords(parsed.source)`. The reason itself is never
 * returned, never interpolated and never fallen back to. A reason the grammar refuses
 * yields the refusal CODE where the source would have gone, which is that
 * module's designed failure mode: rendering LESS, never more. This module writes NO second
 * grammar and NO second scrub - a second one would be the exact defect resources-credential.ts
 * was written to prevent.
 */

/** The seat facts a row states, each already reduced to words a person can read. */
export interface SeatFactWords {
  readonly cliVersion: string;
  readonly provider: string;
}

/**
 * The daemon states ONE unknown for a seat nobody measured at start. Say that it was not
 * measured rather than printing a bare word that reads like a provider named "UNKNOWN".
 */
export function seatFactWords(
  providerAtStart: string, agentVersionAtStart: string,
): SeatFactWords {
  return Object.freeze({
    cliVersion: agentVersionAtStart === SEAT_FACT_UNMEASURED
      ? "no CLI version was recorded when this seat started" : agentVersionAtStart,
    provider: providerAtStart === SEAT_FACT_UNMEASURED
      ? "no provider was recorded when this seat started" : providerAtStart,
  });
}

/**
 * DoD-4: A BROWSER CHOICE THAT IS BEING IGNORED MUST BE LEGIBLE, NOT MYSTERIOUS. So the
 * override is NAMED - the variable, and what it does to the choice - rather than a label
 * being quietly flipped. `envOverride` is the daemon's own flag; nothing is inferred here.
 */
export function providerOverrideWords(agentProvider: SessionsAgentProvider): string {
  return agentProvider.envOverride
    ? `MOE_AGENT_COMMAND is set in the daemon environment, so seats start under ${agentProvider.configured}`
      + " whatever this browser chooses. Unset it on the daemon host for the browser choice to take effect."
    : `Seats start under ${agentProvider.configured}, which is what this browser last chose.`;
}

/** Where the credential came from - or why this screen will not say. NEVER what it is. */
export interface CredentialWords {
  /** The refusal code to show where the source would have gone, or null when stated. */
  readonly code: string | null;
  /** The agent CLI leaf the grammar recognised, or null. */
  readonly cli: string | null;
  /** The operator's sentence, built from the grammar's output alone. */
  readonly said: string;
}

const receiptOf = (
  members: readonly ActivationReceiptView[],
): ActivationReceiptView | undefined => members.find((row) => row.member === "provider");

/**
 * DoD-2 AND DoD-3, and the split between them is the whole design.
 *
 * A MEASURED receipt's `reason` is the credential PRESENCE ref - the receipt's `detail` as
 * activation-receipts-measure.ts `measureProvider` builds it; its `ref` is the committed
 * probe envelope ref, `provider-profile-1`, and is not read - and is parsed by the closed
 * grammar, never echoed. This module used to parse `ref`, the identical misread that
 * resources-model.ts was MEASURED making on a real project (2026-09-13): the grammar was
 * handed `provider-profile-1` and refused RESOURCES_CREDENTIAL_SOURCE_UNRECOGNISED while
 * the Goals card showed `credential/claude/login-file` for the same receipt. An UNMEASURED
 * receipt's `reason` is repeated VERBATIM - that is the
 * daemon's own stated absence, scrubbed at the boundary that publishes it, and for a missing
 * credential it is the launcher's `MOE_UP_ENV_MISSING` line naming the variables the operator
 * must set. Paraphrasing it into "no credential" is exactly what DoD-3 forbids: an operator
 * whose seats will not start needs the NAMES, not a summary.
 */
export function credentialWords(activation: ActivationReadOutcome | null): CredentialWords {
  if (activation === null) {
    return Object.freeze({ code: null, cli: null, said: "Reading where the credential comes from..." });
  }
  if (activation.status !== "ACTIVATION") {
    return Object.freeze({
      code: activation.code, cli: null,
      said: "The credential source could not be read.",
    });
  }
  const receipt = receiptOf(activation.members);
  if (receipt === undefined) {
    return Object.freeze({
      code: CREDENTIAL_SOURCE_UNRECOGNISED, cli: null,
      said: "The daemon stated no provider receipt, so this screen cannot say where the credential comes from.",
    });
  }
  if (!receipt.measured) {
    // VERBATIM. The daemon's words, not this screen's summary of them.
    return Object.freeze({ code: receipt.code, cli: null, said: receipt.reason });
  }
  const parsed = credentialSource(receipt.reason);
  if (parsed === null) {
    // The reason is NOT echoed. A value that rode in on it renders as this code and nothing else.
    return Object.freeze({
      code: CREDENTIAL_SOURCE_UNRECOGNISED, cli: null,
      said: "The credential source was not stated in a form this screen can show.",
    });
  }
  return Object.freeze({
    code: null, cli: parsed.cli,
    said: `Signed in through ${credentialSourceWords(parsed.source)}.`,
  });
}
