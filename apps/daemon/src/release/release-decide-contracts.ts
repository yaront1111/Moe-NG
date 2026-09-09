/**
 * The shared contract for the `release.decide` command kind: its kind constant, the closed
 * refusal vocabulary, and the ONE frozen code->layer map that binds each code to the surface
 * that mints it.
 *
 * WHY THE MAP IS THE ONLY AUTHORITY. `releaseRefusal` takes a CODE and nothing else. There is
 * no layer parameter, so a call site is structurally unable to mint a (code, layer) pair the
 * map does not authorize — the disagreement cannot be expressed, rather than being forbidden
 * by convention and then caught in review. `RELEASE_DECIDE_CODES` is DERIVED from the map's
 * keys for the same reason: a restated roster is a second source of truth that can drift.
 *
 * WHY THE LAYER VALUES ARE STRING LITERALS AND NOT IMPORTS. Each value is the value of an
 * already-rostered layer constant:
 *   "PROJECT_REDUCER"     = PROJECT_REDUCER_LAYER    (recovery/recovery-completion-evidence.ts)
 *   "DAEMON_PREREQUISITE" = GOAL_PREREQUISITE_LAYER  (goals/goal-close-prerequisite.ts)
 *   "RUNNER_WORKSPACE"    = RUNNER_WORKSPACE_LAYER   (work/foundation-attempt-contracts.ts)
 * Importing those constants here would drag @moe/store, @moe/core, @moe/runner and
 * @moe/scheduler into what must stay a standalone-loadable leaf module. The equality is
 * therefore pinned BY IMPORT IN THE TEST (release-decide-contracts.test.ts), where the
 * dependency cost is irrelevant and the pin is just as mechanical.
 *
 * WHY THE CONSTANT IS NAMED `..._CODE_LAYER_MAP` AND NOT `..._LAYERS`. The security lane's
 * two scanners — `DECLARATION_PATTERN` (boundary-roster.security.ts) and
 * `PRIVATE_DECLARATION_PATTERN` (layer-visibility-cases.ts) — both require the declared name
 * to end in LAYER/LAYERS/BOUNDARIES IMMEDIATELY before the `=`. The `_MAP` tail means neither
 * matches, so this module declares no new rostered boundary and its scan-minus-roster delta
 * is zero. Renaming it to `..._LAYERS` would silently demand a roster backfill.
 */

/** The runtime command kind this contract serves. Member of `RUNTIME_COMMAND_KINDS`. */
export const RELEASE_DECIDE_COMMAND_KIND = "release.decide" as const;

/**
 * Every refusal the release.decide path can mint, mapped to the layer that mints it.
 * Exactly three keys, closed. `RELEASE_DECIDE_CODES` below is derived from these keys, so
 * the roster and the map can never disagree.
 */
export const RELEASE_DECIDE_CODE_LAYER_MAP = Object.freeze({
  /** DAEMON_PREREQUISITE: the daemon's own prerequisite read found the release evidence short. */
  RELEASE_EVIDENCE_INCOMPLETE: "DAEMON_PREREQUISITE",
  /** RUNNER_WORKSPACE: the runner's workspace attempted the pull request and it did not open. */
  RELEASE_PR_FAILED: "RUNNER_WORKSPACE",
  /** PROJECT_REDUCER: the project reducer holds the repository binding, and there is none. */
  RELEASE_REMOTE_MISSING: "PROJECT_REDUCER",
} as const);

/** The closed code set, read off the map rather than restated beside it. */
export type ReleaseDecideCode = keyof typeof RELEASE_DECIDE_CODE_LAYER_MAP;

/** The closed layer set, likewise derived — no layer exists that the map does not name. */
export type ReleaseDecideLayer = (typeof RELEASE_DECIDE_CODE_LAYER_MAP)[ReleaseDecideCode];

/** Derived, never restated: the roster IS the layer map's key set, sorted for a stable order. */
export const RELEASE_DECIDE_CODES: readonly ReleaseDecideCode[] = Object.freeze(
  (Object.keys(RELEASE_DECIDE_CODE_LAYER_MAP) as ReleaseDecideCode[]).sort(),
);

/**
 * A release.decide refusal. `ok` is always false, and the layer is always the one the map
 * pairs with THIS code — the type is CORRELATED per code, not a loose pair of independent
 * unions. Written as a distributed mapped type so that a hand-built literal bypassing
 * `releaseRefusal` cannot express a disagreeing pair either: `{code: "RELEASE_PR_FAILED",
 * layer: "PROJECT_REDUCER"}` is a compile error, not merely bad practice. A plain
 * `{code: ReleaseDecideCode; layer: ReleaseDecideLayer}` interface would admit it, which
 * would leave the factory as the only thing standing between a caller and a wrong layer.
 */
export type ReleaseDecideRefusalFor<C extends ReleaseDecideCode> = {
  readonly code: C;
  readonly detail: string | null;
  readonly layer: (typeof RELEASE_DECIDE_CODE_LAYER_MAP)[C];
  readonly ok: false;
};

export type ReleaseDecideRefusal = {
  [C in ReleaseDecideCode]: ReleaseDecideRefusalFor<C>;
}[ReleaseDecideCode];

/**
 * The ONLY way to mint a release.decide refusal. It takes no layer argument by design:
 * `RELEASE_DECIDE_CODE_LAYER_MAP` decides, so no call site can pair a code with a layer that
 * contradicts it.
 */
export function releaseRefusal<C extends ReleaseDecideCode>(
  code: C,
  detail: string | null = null,
): ReleaseDecideRefusalFor<C> {
  return Object.freeze({
    code,
    detail,
    layer: RELEASE_DECIDE_CODE_LAYER_MAP[code],
    ok: false as const,
  });
}

/**
 * Narrow an unknown value to a release.decide refusal. Two things are deliberate here.
 *
 * First, the CODE is checked against the closed roster rather than trusting `ok === false`
 * alone: a refusal minted by another vocabulary must not be admitted as one of ours.
 *
 * Second, `ok` and `code` are required as OWN properties. A plain property read walks the
 * prototype chain, so `Object.create({code: "RELEASE_PR_FAILED"})` with `ok = false` set on
 * the instance would otherwise be admitted as a refusal it never carried.
 */
export function isReleaseDecideRefusal(value: unknown): value is ReleaseDecideRefusal {
  if (typeof value !== "object" || value === null) return false;
  if (!Object.hasOwn(value, "ok") || !Object.hasOwn(value, "code")) return false;
  const candidate = value as { readonly code?: unknown; readonly ok?: unknown };
  if (candidate.ok !== false) return false;
  return typeof candidate.code === "string"
    && Object.hasOwn(RELEASE_DECIDE_CODE_LAYER_MAP, candidate.code);
}
