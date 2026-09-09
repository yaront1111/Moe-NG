/**
 * THE ONE PLACE THE PROVIDER'S CREDENTIAL IS TURNED INTO SOMETHING RENDERABLE.
 *
 * A credential VALUE must never reach an operator's screen: a screenshot pasted into a
 * bug report cannot be recalled. The daemon already scrubs values at the boundary that
 * publishes (apps/daemon/src/http/activation-read.ts, `secretValues`/`scrub`, documented
 * there as "rendered onto an operator's screen and into e2e screenshots"). This module is
 * the SECOND fence and deliberately not a second scrub: it does not try to recognise a
 * secret and remove it. It recognises the SOURCE and renders nothing else.
 *
 * The grammar below is CLOSED. Its failure mode is rendering LESS, never more: an input
 * it does not recognise yields `null`, and the caller states
 * `RESOURCES_CREDENTIAL_SOURCE_UNRECOGNISED` where the source would have gone. A value
 * that rides in on the ref therefore renders as a refusal code, not as itself.
 */

/** This module's boundary, for the refusals it states rather than relays. */
export const RESOURCES_LAYER = "CONTROL_ROOM_RESOURCES";

/** The provider ref did not match the credential-source grammar. Fails CLOSED. */
export const CREDENTIAL_SOURCE_UNRECOGNISED = "RESOURCES_CREDENTIAL_SOURCE_UNRECOGNISED";

/**
 * The ref as the daemon writes it
 * (apps/daemon/src/bootstrap/activation-receipts-measure.ts, `credentialRef`):
 * `credential/<provider leaf>/env:<VAR NAME>`, `.../login-file`, or `.../ungated`.
 *
 * An environment variable NAME is upper snake case; an API credential is not. The
 * grammar therefore cannot match a value even if one is substituted for the name.
 */
const CREDENTIAL_REF = /^credential\/([a-z0-9][a-z0-9-]{0,31})\/(env:[A-Z][A-Z0-9_]{0,63}|login-file|ungated)$/u;

export interface CredentialSource {
  /** The agent CLI's leaf, e.g. `claude`. */
  readonly cli: string;
  /** WHERE the credential comes from. Never WHAT it is. */
  readonly source: string;
}

export function credentialSource(ref: string | null): CredentialSource | null {
  if (ref === null) return null;
  const match = CREDENTIAL_REF.exec(ref);
  const cli = match?.[1];
  const source = match?.[2];
  return cli === undefined || source === undefined ? null : Object.freeze({ cli, source });
}

/** The source in the operator's words, built from the grammar's output, never from the ref. */
export function credentialSourceWords(source: string): string {
  if (source === "login-file") return "a signed-in credential file on this host";
  if (source === "ungated") return "no credential gate for this command";
  return `the ${source.slice("env:".length)} environment variable`;
}
