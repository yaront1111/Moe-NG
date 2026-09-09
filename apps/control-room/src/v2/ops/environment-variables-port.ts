import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";

/**
 * SETTING AND UNSETTING AN ENVIRONMENT VARIABLE from the browser.
 *
 * THE AFFORDANCE IS MINTED HERE, AND THAT IS MEASURED RATHER THAN CONVENIENT. Every other card
 * in this app spends a daemon-minted offer read off `/affordances/read`, but the two environment
 * kinds are NOT in `BOOTSTRAP_COMMAND_KINDS` (apps/daemon/src/bootstrap/bootstrap-contracts.ts),
 * so that surface mints no offer for them and there is none to find. They are nonetheless
 * SERVED: `daemon-command-registry.ts` routes both to `runEnvironmentEdge` before the shared
 * request assembler is ever reached, and `daemon-command-environment.test.ts` drives them
 * through the real `handleCommandRequest` with a self-built envelope. The generated builder's
 * only guard is that the record names the kind, so a minted record is the whole of what this
 * needs.
 *
 * NOTHING HERE IS AN AUTHORITY. `expectedVersion: 0` is not a version claim - the environment
 * edge reads neither it nor `targetAggregateId`, and derives the real aggregate from the
 * AUTHENTICATED principal's project. A browser-supplied project id would be exactly the kind of
 * authority-from-payload the edge exists to refuse.
 *
 * A FRESH COMMAND ID PER SUBMIT. The store keys its receipt by command id and compares request
 * digests, and an environment write's digest can never repeat (fresh nonce, fresh event id), so
 * a REUSED id raises COMMAND_ID_CONFLICT instead of writing - a second attempt at the same
 * variable would simply fail. The id is minted from a UUID rather than from the payload.
 *
 * ON THE REQUEST DIGEST, stated rather than glossed: `spendOffer` derives `requestDigest` and the
 * correlation id from a sha256 over the payload, so both are functions of the submitted value.
 * That is the SHARED wire every card uses and the same digest path the daemon's own canary
 * covers (`daemon-command-environment.test.ts`, "leaves ZERO plaintext in the DECISION RECORD,
 * the digest path and the store file"). A digest is not the plaintext; this module does not add a
 * second one.
 *
 * WHY `spendOffer` AND NOT `dispatchPreparedPayload`. The latter flattens a refusal to
 * `CODE @ stage` and drops the daemon's `detail`, which for this slice is the fixed operator
 * prose keyed by code - ENV_STORE_KEY_UNAVAILABLE without it is a bare code nobody can act on.
 * `spendOffer` carries `{code, detail, layer}` through at the refusing authority's own layer.
 *
 * THE VALUE PASSES THROUGH AND IS NOT KEPT. It is read from the caller's argument straight into
 * the payload object handed to `spendOffer`. No field of this module holds it, nothing logs it,
 * and the refusal that comes back is the store's fixed prose keyed by code, never built from
 * input.
 */

export const ENVIRONMENT_SET_KIND = "environment.set_variable" as const;
export const ENVIRONMENT_UNSET_KIND = "environment.unset_variable" as const;
export const ENVIRONMENT_WRITE_LAYER = "CONTROL_ROOM_ENVIRONMENT_WRITE" as const;

/** The aggregate the edge actually writes is derived daemon-side; this names the axis only. */
const targetFor = (environment: string): string => `environment/${environment}`;

export type EnvironmentWriteOutcome = OfferOutcome;

export interface EnvironmentVariablesPort {
  set(environment: string, name: string, value: string): Promise<EnvironmentWriteOutcome>;
  unset(environment: string, name: string): Promise<EnvironmentWriteOutcome>;
}

/**
 * A command identity the daemon has never offered. `crypto.randomUUID` is present in every
 * browser this app supports and in the jsdom used by its tests; the counter fallback exists so a
 * host without it degrades to a distinct id rather than to a repeated one, which would turn every
 * second submit into COMMAND_ID_CONFLICT.
 */
let minted = 0;
function commandIdFor(kind: string): string {
  minted += 1;
  const unique = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${String(Date.now())}-${String(minted)}`;
  return `ui-${kind.replace(".", "-")}-${unique}`;
}

function affordanceFor(kind: string, environment: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    commandId: commandIdFor(kind),
    commandKind: kind,
    expectedVersion: 0,
    targetAggregateId: targetFor(environment),
  });
}

export function createEnvironmentVariablesPort(wire: OfferWire): EnvironmentVariablesPort {
  return Object.freeze({
    set: (environment: string, name: string, value: string): Promise<EnvironmentWriteOutcome> =>
      spendOffer(
        wire, ENVIRONMENT_SET_KIND, affordanceFor(ENVIRONMENT_SET_KIND, environment),
        { environment, name, value }, "ui-env-set", ENVIRONMENT_WRITE_LAYER,
      ),
    unset: (environment: string, name: string): Promise<EnvironmentWriteOutcome> =>
      spendOffer(
        wire, ENVIRONMENT_UNSET_KIND, affordanceFor(ENVIRONMENT_UNSET_KIND, environment),
        { environment, name }, "ui-env-unset", ENVIRONMENT_WRITE_LAYER,
      ),
  });
}
