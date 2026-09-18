/**
 * The shared contract for the `repository.publish_resolve` command kind: its kind constant, the
 * closed refusal vocabulary, and the ONE frozen code->layer map that binds each code to the
 * surface that mints it. Structure mirrors `release/release-decide-contracts.ts` deliberately.
 *
 * WHY THE MAP IS THE ONLY AUTHORITY. `publishResolveRefusal` takes a CODE and nothing else, so
 * a call site is structurally unable to mint a (code, layer) pair the map does not authorize.
 * `PUBLISH_RESOLVE_CODES` is DERIVED from the map's keys for the same reason: a restated
 * roster is a second source of truth that can drift from the map beside it.
 *
 * THREE CODES, ALL AT ONE LAYER. An operator resolve names ONE publish decision, and exactly
 * three things make it false or pointless: the decision names no publish request; it is not
 * UNKNOWN (it already has a receipt, or it never journaled an intent); or, for NOT_TRANSMITTED,
 * the recorded publisher observation shows the remote DOES hold the approved sha. The daemon
 * finds all three in its own read of its durable facts before it acts (the publish-ledger walk,
 * the publication intent, the recorded observation) — the DAEMON_PREREQUISITE layer. No other
 * layer sees them, so a second layer here would be a claim nothing makes true.
 *
 * WHY THE LAYER VALUES ARE STRING LITERALS AND NOT IMPORTS. "DAEMON_PREREQUISITE" is the value
 * of the already-rostered `GOAL_PREREQUISITE_LAYER` (goals/goal-close-prerequisite.ts:58).
 * Importing it would make this standalone-loadable leaf load that module and its runtime
 * dependencies, so the equality is pinned BY IMPORT IN THE TEST
 * (publish-resolve-contracts.test.ts), where the dependency cost is irrelevant.
 *
 * WHY THE CONSTANT IS NAMED `..._CODE_LAYER_MAP` AND NOT `..._LAYERS`. The security lane's
 * `DECLARATION_PATTERN` (boundary-roster.security.ts) and `PRIVATE_DECLARATION_PATTERN`
 * (layer-visibility-cases.ts) treat a name ending LAYER/LAYERS/BOUNDARIES immediately before
 * the `=` as a new rostered boundary. The `_MAP` tail matches neither, so this module declares
 * no boundary; renaming it to `..._LAYERS` would silently demand a roster backfill.
 */

/** The runtime command kind this contract serves. Member of `RUNTIME_COMMAND_KINDS`. */
export const PUBLISH_RESOLVE_COMMAND_KIND = "repository.publish_resolve" as const;

/**
 * Every refusal the resolve path can mint, mapped to the layer that mints it. Exactly three
 * keys, closed; `PUBLISH_RESOLVE_CODES` is derived from them.
 */
export const PUBLISH_RESOLVE_CODE_LAYER_MAP = Object.freeze({
  /** DAEMON_PREREQUISITE: the daemon's publish-ledger walk finds no request with this decision id. */
  PUBLISH_RESOLVE_DECISION_NOT_FOUND: "DAEMON_PREREQUISITE",
  /** DAEMON_PREREQUISITE: the decision already has a receipt, or never journaled an intent. */
  PUBLISH_RESOLVE_NOT_UNKNOWN: "DAEMON_PREREQUISITE",
  /** DAEMON_PREREQUISITE: the recorded observation shows the remote holds the approved sha. */
  PUBLISH_RESOLVE_REMOTE_HOLDS_SHA: "DAEMON_PREREQUISITE",
} as const);

/** The closed code set, read off the map rather than restated beside it. */
export type PublishResolveCode = keyof typeof PUBLISH_RESOLVE_CODE_LAYER_MAP;

/** Derived, never restated: the roster IS the layer map's key set, sorted for a stable order. */
export const PUBLISH_RESOLVE_CODES: readonly PublishResolveCode[] = Object.freeze(
  (Object.keys(PUBLISH_RESOLVE_CODE_LAYER_MAP) as PublishResolveCode[]).sort(),
);

/**
 * A publish-resolve refusal, CORRELATED per code: the layer is always the one the map pairs
 * with THIS code. Written as a distributed mapped type so that a hand-built literal bypassing
 * `publishResolveRefusal` cannot pair a code with another layer either — that is a compile
 * error, not merely bad practice.
 */
export type PublishResolveRefusalFor<C extends PublishResolveCode> = {
  readonly code: C;
  readonly detail: string | null;
  readonly layer: (typeof PUBLISH_RESOLVE_CODE_LAYER_MAP)[C];
  readonly ok: false;
};

export type PublishResolveRefusal = {
  [C in PublishResolveCode]: PublishResolveRefusalFor<C>;
}[PublishResolveCode];

/** The ONLY way to mint a publish-resolve refusal. No layer argument: the map decides. */
export function publishResolveRefusal<C extends PublishResolveCode>(
  code: C,
  detail: string | null = null,
): PublishResolveRefusalFor<C> {
  return Object.freeze({
    code,
    detail,
    layer: PUBLISH_RESOLVE_CODE_LAYER_MAP[code],
    ok: false as const,
  });
}
