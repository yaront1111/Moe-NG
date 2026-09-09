import { environmentRefusal, isEnvironmentName } from "./environment-contracts.js";
import type { EnvironmentName, EnvironmentRefusal } from "./environment-contracts.js";
import { readEnvironmentDelivery } from "./environment-delivery.js";
import type { EnvironmentDeliveredVariables } from "./environment-delivery.js";
import type { EnvironmentStoreConfig } from "./environment-projection.js";

/**
 * THE ANSWER TO "WHICH PROJECT, WHICH ENVIRONMENT, AND FOR WHAT" AT A REAL LAUNCH BOUNDARY.
 *
 * `readEnvironmentDelivery` has been landed and callable since its own row, with ZERO production
 * callers: everything needed to hand an operator's variables to a child process existed except
 * the one decision only a launch site can make. This module is that decision and NOTHING else.
 * It opens no store, decodes no record, keeps no second allowlist and mints no refusal detail of
 * its own - `environment-delivery.ts` owns the read, `environment-projection.ts` owns admission,
 * `agent-spawn-environment.ts` / `verifier-process-runner.ts` / `preview-process.ts` own the
 * merge, and `environment-contracts.ts` owns every code and layer. A resolver, not an authority.
 *
 * WHY PURPOSE IS A PARAMETER AND NOT A COMMENT. The hazard this row exists to avoid is a
 * one-line change: `agentEnvironment` (agent-spawn-environment.ts:58) takes an OPTIONAL second
 * argument, and its two real call sites (agent-spawner.ts:156 and :159) are the CODING SEAT
 * spawner. Passing delivery there would hand every coding agent the project's production
 * secrets. The optional parameter is an opt-in for a specific boundary, not an invitation.
 * Making purpose a required input means a call site cannot ask this module for variables without
 * first saying who is about to receive them, and the answer for a coding seat is fixed here
 * rather than at each launch site where it would have to be remembered.
 *
 * WHY THE CODING-SEAT ANSWER IS A TYPE AND NOT A CONVENTION. `EnvironmentLaunchWithheld.delivered`
 * is `Readonly<Record<string, never>>`: a map whose value type is uninhabited, so it can never
 * hold a variable and no later edit can quietly start putting one there without the compiler
 * objecting. Its `environment` is `null` while the delivering branch's is an `EnvironmentName`,
 * so a caller that wants a value has to narrow, and narrowing is where the coding-seat case
 * becomes visible instead of being defaulted through. A boolean flag or an empty object literal
 * would have relied on everyone downstream remembering; this does not.
 *
 * PURPOSE FIXES THE ENVIRONMENT; THE CALLER DOES NOT GET TO NAME ONE. A launch site that could
 * pass both a purpose and an arbitrary environment string would let a preview ask for
 * `production`, which is the scope confusion the whole slice exists to prevent - and it would be
 * a request field rather than a fact of the composition root, exactly the distinction
 * `daemon-store-foundation-composition.ts:410` draws for the environment read. So the map below
 * is total, closed and one-way.
 *
 * NO RAW ERROR DATA ON ANY PATH. Two different things can go wrong and both are mapped, never
 * relayed. A REFUSAL from `readEnvironmentDelivery` already carries a rostered code, a rostered
 * layer and fixed prose keyed by that code, so it is forwarded UNCHANGED and unrestamped - a
 * second opinion here would report KEY trouble as SCOPE trouble. A THROW is different: nothing
 * below `readEnvironmentDelivery` promises not to throw, a store failure's `message` can quote a
 * key, a path or a value, and an exception escaping this function would carry those bytes into
 * whatever logs the launch failure. So the call is wrapped and any throw becomes
 * ENV_STORE_KEY_UNAVAILABLE with the roster's own detail: the delivery is unavailable, which is
 * true, and the reason it was unavailable stays inside the frame where it was raised.
 */

/** Every kind of child this daemon launches, and the only inputs this module accepts. */
export const LAUNCH_PURPOSES = Object.freeze([
  "CODING_SEAT", "PREVIEW", "VERIFIER",
] as const);

export type LaunchPurpose = (typeof LAUNCH_PURPOSES)[number];

/**
 * The purposes that receive variables, and the environment each one receives.
 *
 * DEPLOY IS DELIBERATELY ABSENT. `deploy-service.ts` has no process-environment seam at all - its
 * `environment` field is the environment NAME it uses for container naming and target lookup, and
 * there is no env block or `docker run -e` handoff to deliver into. Adding a `DEPLOY` member here
 * would advertise a resolution no launch site can consume, which is worse than the gap: it reads
 * as wired. The container handoff is task-04b3ce7e's, and this map grows when that lands.
 */
const PURPOSE_ENVIRONMENTS = Object.freeze({
  PREVIEW: "preview", VERIFIER: "verify",
} as const satisfies Readonly<Record<string, EnvironmentName>>);

/** A purpose whose child is intended to receive the project's variables. */
export type DeliveringPurpose = keyof typeof PURPOSE_ENVIRONMENTS;

/**
 * A delivery that CANNOT carry a variable, by type. `never` as the value type is what makes the
 * coding-seat answer structural: `delivered["ANYTHING"] = x` does not compile for any `x`.
 */
export type WithheldDelivery = Readonly<Record<string, never>>;

export interface EnvironmentLaunchDelivered {
  readonly delivered: EnvironmentDeliveredVariables;
  readonly environment: EnvironmentName;
  readonly ok: true;
  readonly purpose: DeliveringPurpose;
}

export interface EnvironmentLaunchWithheld {
  readonly delivered: WithheldDelivery;
  readonly environment: null;
  readonly ok: true;
  readonly purpose: "CODING_SEAT";
}

export type EnvironmentLaunchResolution =
  | EnvironmentLaunchDelivered
  | EnvironmentLaunchWithheld
  | EnvironmentRefusal;

/**
 * The one withheld answer, shared and frozen. A fresh object per call would be indistinguishable
 * in behaviour but would let a caller mutate its own copy; frozen and shared, the coding-seat
 * answer is the same object every time and cannot be grown into a delivering one.
 */
const WITHHELD: EnvironmentLaunchWithheld = Object.freeze({
  delivered: Object.freeze({}) as WithheldDelivery,
  environment: null,
  ok: true as const,
  purpose: "CODING_SEAT" as const,
});

export function isLaunchRefusal(
  value: EnvironmentLaunchResolution,
): value is EnvironmentRefusal {
  return value.ok === false;
}

/** True when this resolution has variables for the child - the narrowing a caller must perform. */
export function isLaunchDelivered(
  value: EnvironmentLaunchResolution,
): value is EnvironmentLaunchDelivered {
  return value.ok === true && value.environment !== null;
}

/**
 * Resolves what `purpose`'s next child may receive from `config`'s project.
 *
 * A CODING SEAT RETURNS BEFORE THE STORE IS TOUCHED. Not an optimisation: it means there is no
 * path from a coding-seat launch to a plaintext value at all, so the property holds even if this
 * module's later half is wrong. It is also why the credential is never resolved for that case.
 */
export function resolveEnvironmentLaunch(
  config: EnvironmentStoreConfig,
  purpose: LaunchPurpose,
): EnvironmentLaunchResolution {
  if (purpose === "CODING_SEAT") return WITHHELD;
  const environment = PURPOSE_ENVIRONMENTS[purpose];
  // Belt and braces against a future member being added to the map with a name the contracts
  // roster does not carry: `admitEnvironment` would refuse it anyway, but refusing HERE keeps the
  // code SCOPE-layer rather than depending on a downstream check to say the same thing.
  if (!isEnvironmentName(environment)) return environmentRefusal("ENV_ENVIRONMENT_UNKNOWN");
  let read;
  try {
    read = readEnvironmentDelivery(config, environment);
  } catch {
    // Swallowed on purpose, and the ONLY place this module discards information. See the header:
    // a store throw's message can quote a key, a path or a value, and relaying it would publish
    // exactly what this slice exists to keep unpublished. The operator-visible fact - that the
    // delivery could not be produced - is preserved in full by the rostered code.
    return environmentRefusal("ENV_STORE_KEY_UNAVAILABLE");
  }
  // Forwarded UNCHANGED. The read's refusal already names the code AND the layer that answered
  // (SCOPE for an unknown environment, KEY for an underivable seal), and restamping it here
  // would report the wrong layer for every one of them.
  if (read.ok === false) return read;
  return Object.freeze({
    delivered: read.variables, environment, ok: true as const, purpose,
  });
}

/**
 * The launch-site convenience: the variables to overlay, or `undefined` when there are none.
 *
 * `undefined` RATHER THAN `{}` IS LOAD-BEARING. `deliverEnvironment` (environment-delivery.ts:161)
 * returns the very object it was handed, by reference, when there is nothing to deliver - so a
 * project with no variables spawns byte-identically to how it spawned before this feature
 * existed. An empty object takes the same branch, but passing `undefined` says at the call site
 * that nothing was resolved rather than that an empty delivery was.
 *
 * A REFUSAL BECOMES `undefined` HERE, so a call site that wants to distinguish "withheld" from
 * "could not read" must use `resolveEnvironmentLaunch` and inspect the refusal. That is the right
 * default for a launch: a boundary that cannot read the store starts the child WITHOUT operator
 * variables rather than not starting it at all, which is the same fail-closed-but-still-running
 * choice `deliverEnvironment`'s header makes for a colliding name.
 */
export function launchDelivery(
  config: EnvironmentStoreConfig,
  purpose: LaunchPurpose,
): EnvironmentDeliveredVariables | undefined {
  const resolved = resolveEnvironmentLaunch(config, purpose);
  if (!isLaunchDelivered(resolved)) return undefined;
  return Object.keys(resolved.delivered).length === 0 ? undefined : resolved.delivered;
}
