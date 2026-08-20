/**
 * Ingress half of the daemon finalize seam: the chain-terminal roster and the caller-bodies
 * detector. The durable half — reading the bodies record, composing b42db644's envelope and
 * committing it with the fold — lives in `planning-authority-finalize.ts`; the two are split
 * only for the per-file line cap and share one test file, exactly as the envelope codec's own
 * two halves are.
 *
 * Both judgements here are SHAPE judgements on what the caller presented, made before any fold
 * and before any durable write, so they refuse under the existing `DAEMON_INGRESS` layer. No
 * layer constant is minted: `tests/security/boundary-roster.security.ts` scans production
 * sources for column-zero `export const *_LAYER(S)` and an exported one owes the roster a
 * hostile BEFORE/AFTER/RACE trio it would not earn here.
 */
import type { JsonObject, JsonValue } from "@moe/contracts";

export const FINALIZE_COMMAND_KIND = "planning.finalize_submission";
export const PROPOSE_COMMAND_KIND = "plan.propose";

/**
 * Closed, and small on purpose. Everything else a finalize can refuse with belongs to the core
 * reducer or to the envelope codec; two ingress judgements are all this seam owns.
 */
export const PLANNING_AUTHORITY_FINALIZE_CODES = Object.freeze([
  "PLANNING_FINALIZE_BODIES_SUPPLIED",
  "PLANNING_FINALIZE_CHAIN_MIXED",
] as const);
export type PlanningAuthorityFinalizeCode = (typeof PLANNING_AUTHORITY_FINALIZE_CODES)[number];

/**
 * A caller may never present authority content at finalize. `authority` and `envelope` are here
 * because the core reducer IGNORES unknown command members, so a smuggled one would otherwise
 * ride into the decision's request bytes unexamined; `sealedHashes` is here because the run's
 * hashes are the reducer's OUTPUT, never the caller's input.
 */
const FORBIDDEN_BODY_KEYS: readonly string[] = Object.freeze([
  "acceptanceContract", "authority", "envelope", "planRevision", "sealedHashes",
]);

export type PlanningChainTerminal =
  | { readonly kind: "FINALIZE" }
  | { readonly kind: "PROPOSE" }
  | { readonly code: PlanningAuthorityFinalizeCode; readonly kind: "REFUSED" }
  | { readonly kind: "UNSUPPORTED" };

/** A plain data read: no getter is invoked and a hostile prototype contributes nothing. */
export const ownValue = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

const kindOf = (entry: unknown): unknown => ownValue(entry, "kind");

const holdsForbiddenKey = (value: unknown): boolean =>
  FORBIDDEN_BODY_KEYS.some((key) => ownValue(value, key) !== undefined);

/**
 * The two terminal classes are MUTUALLY EXCLUSIVE. Each business effect owes its own durable
 * decision, so a request that proposes AND finalizes is refused rather than silently collapsed
 * into one commit whose result could only describe half of it. UNSUPPORTED keeps the seam's
 * pre-existing behaviour for a chain ending in neither, so the widening is strictly additive.
 */
export function classifyPlanningChain(commands: readonly JsonValue[]): PlanningChainTerminal {
  const lastKind = kindOf(commands[commands.length - 1]);
  if (lastKind !== PROPOSE_COMMAND_KIND && lastKind !== FINALIZE_COMMAND_KIND) {
    return Object.freeze({ kind: "UNSUPPORTED" as const });
  }
  const foreign = lastKind === PROPOSE_COMMAND_KIND ? FINALIZE_COMMAND_KIND : PROPOSE_COMMAND_KIND;
  if (commands.some((entry) => kindOf(entry) === foreign)) {
    return Object.freeze({ code: "PLANNING_FINALIZE_CHAIN_MIXED" as const, kind: "REFUSED" });
  }
  return lastKind === PROPOSE_COMMAND_KIND
    ? Object.freeze({ kind: "PROPOSE" as const })
    : Object.freeze({ kind: "FINALIZE" as const });
}

/** Scans BOTH surfaces a caller controls: the request payload and every chain element. */
export function callerSuppliedAuthorityBodies(
  payload: JsonObject, commands: readonly JsonValue[],
): boolean {
  return holdsForbiddenKey(payload) || commands.some(holdsForbiddenKey);
}
