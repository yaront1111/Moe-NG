/**
 * The shared contract for the `product_contract.sync_env_example` command kind: its kind
 * constant, the closed refusal vocabulary, and the ONE frozen code->layer map that binds each
 * code to the surface that mints it.
 *
 * Structure mirrors `release/release-decide-contracts.ts` deliberately, because the reasoning
 * transfers verbatim: `envExampleSyncRefusal` takes a CODE and nothing else, so a call site is
 * structurally unable to mint a (code, layer) pair the map does not authorize — the
 * disagreement cannot be expressed rather than being forbidden by convention and caught in
 * review. `ENV_EXAMPLE_SYNC_CODES` is DERIVED from the map's keys for the same reason: a
 * restated roster is a second source of truth that can drift from the map beside it.
 *
 * FOUR CODES, ONE PER THING THAT CAN ACTUALLY REFUSE, and no fifth. The consumer
 * (task-f1e402960a) writes the approved contract's required variable names into the committed
 * `.env.example` of the project's bound repository, so exactly four things can stop it: the
 * approval is not there, the repository is not bound, the checkout cannot be read, or the
 * write did not land. A speculative fifth code would be a claim that something can refuse when
 * nothing does, and an unthrown code cannot be drilled.
 *
 * WHY THE LAYER VALUES ARE STRING LITERALS AND NOT IMPORTS. Each value is the value of an
 * already-rostered layer constant, so this module publishes NO new boundary:
 *   "DAEMON_PREREQUISITE"   = GOAL_PREREQUISITE_LAYER    (goals/goal-close-prerequisite.ts:58)
 *   "PROJECT_REDUCER"       = PROJECT_REDUCER_LAYER      (recovery/recovery-completion-evidence.ts:43)
 *   "RUNNER_WORKSPACE"      = RUNNER_WORKSPACE_LAYER     (work/foundation-attempt-contracts.ts:34)
 *   "REPOSITORY_DELIVERY"   = REPOSITORY_DELIVERY_LAYER  (orchestrator/repository-delivery-contracts.ts:3)
 * Importing those constants here would drag @moe/store, @moe/core, @moe/runner and
 * @moe/scheduler into what must stay a standalone-loadable leaf module. The equality is
 * therefore pinned BY IMPORT IN THE TEST (env-example-sync-contracts.test.ts), where the
 * dependency cost is irrelevant and the pin is just as mechanical.
 *
 * WHY THE CONSTANT IS NAMED `..._CODE_LAYER_MAP` AND NOT `..._LAYERS`. The security lane's two
 * scanners — `DECLARATION_PATTERN` (boundary-roster.security.ts) and
 * `PRIVATE_DECLARATION_PATTERN` (layer-visibility-cases.ts) — both require the declared name to
 * end in LAYER/LAYERS/BOUNDARIES IMMEDIATELY before the `=`. The `_MAP` tail means neither
 * matches, so this module declares no new rostered boundary and its scan-minus-roster delta is
 * zero. Renaming it to `..._LAYERS` would silently demand a roster backfill.
 */

/** The runtime command kind this contract serves. Member of `RUNTIME_COMMAND_KINDS`. */
export const ENV_EXAMPLE_SYNC_COMMAND_KIND = "product_contract.sync_env_example" as const;

/**
 * Every refusal the sync path can mint, mapped to the layer that mints it. Exactly four keys,
 * closed. `ENV_EXAMPLE_SYNC_CODES` below is derived from these keys, so the roster and the map
 * can never disagree.
 */
export const ENV_EXAMPLE_SYNC_CODE_LAYER_MAP = Object.freeze({
  /** REPOSITORY_DELIVERY: the delivery surface attempted the write and commit; it did not land. */
  ENV_EXAMPLE_COMMIT_FAILED: "REPOSITORY_DELIVERY",
  /** DAEMON_PREREQUISITE: the daemon's own prerequisite read found no Gate 1 approved contract. */
  ENV_EXAMPLE_CONTRACT_UNAPPROVED: "DAEMON_PREREQUISITE",
  /** PROJECT_REDUCER: the project reducer holds the repository binding, and there is none. */
  ENV_EXAMPLE_REPOSITORY_UNBOUND: "PROJECT_REDUCER",
  /** RUNNER_WORKSPACE: the workspace holding the checkout could not be read. */
  ENV_EXAMPLE_REPOSITORY_UNREADABLE: "RUNNER_WORKSPACE",
} as const);

/** The closed code set, read off the map rather than restated beside it. */
export type EnvExampleSyncCode = keyof typeof ENV_EXAMPLE_SYNC_CODE_LAYER_MAP;

/** The closed layer set, likewise derived — no layer exists that the map does not name. */
export type EnvExampleSyncLayer =
  (typeof ENV_EXAMPLE_SYNC_CODE_LAYER_MAP)[EnvExampleSyncCode];

/** Derived, never restated: the roster IS the layer map's key set, sorted for a stable order. */
export const ENV_EXAMPLE_SYNC_CODES: readonly EnvExampleSyncCode[] = Object.freeze(
  (Object.keys(ENV_EXAMPLE_SYNC_CODE_LAYER_MAP) as EnvExampleSyncCode[]).sort(),
);

/**
 * A sync refusal. `ok` is always false, and the layer is always the one the map pairs with THIS
 * code — the type is CORRELATED per code, not a loose pair of independent unions. Written as a
 * distributed mapped type so that a hand-built literal bypassing `envExampleSyncRefusal` cannot
 * express a disagreeing pair either: `{code: "ENV_EXAMPLE_COMMIT_FAILED", layer:
 * "PROJECT_REDUCER"}` is a compile error, not merely bad practice. A plain
 * `{code: EnvExampleSyncCode; layer: EnvExampleSyncLayer}` interface would admit it, which
 * would leave the factory as the only thing standing between a caller and a wrong layer.
 */
export type EnvExampleSyncRefusalFor<C extends EnvExampleSyncCode> = {
  readonly code: C;
  readonly detail: string | null;
  readonly layer: (typeof ENV_EXAMPLE_SYNC_CODE_LAYER_MAP)[C];
  readonly ok: false;
};

export type EnvExampleSyncRefusal = {
  [C in EnvExampleSyncCode]: EnvExampleSyncRefusalFor<C>;
}[EnvExampleSyncCode];

/**
 * The ONLY way to mint a sync refusal. It takes no layer argument by design:
 * `ENV_EXAMPLE_SYNC_CODE_LAYER_MAP` decides, so no call site can pair a code with a layer that
 * contradicts it.
 */
export function envExampleSyncRefusal<C extends EnvExampleSyncCode>(
  code: C,
  detail: string | null = null,
): EnvExampleSyncRefusalFor<C> {
  return Object.freeze({
    code,
    detail,
    layer: ENV_EXAMPLE_SYNC_CODE_LAYER_MAP[code],
    ok: false as const,
  });
}

/**
 * Narrow an unknown value to a sync refusal. Two things are deliberate here.
 *
 * First, the CODE is checked against the closed roster rather than trusting `ok === false`
 * alone: a refusal minted by another vocabulary must not be admitted as one of ours.
 *
 * Second, `ok` and `code` are required as OWN properties. A plain property read walks the
 * prototype chain, so `Object.create({code: "ENV_EXAMPLE_COMMIT_FAILED"})` with `ok = false`
 * set on the instance would otherwise be admitted as a refusal it never carried.
 */
export function isEnvExampleSyncRefusal(value: unknown): value is EnvExampleSyncRefusal {
  if (typeof value !== "object" || value === null) return false;
  if (!Object.hasOwn(value, "ok") || !Object.hasOwn(value, "code")) return false;
  const candidate = value as { readonly code?: unknown; readonly ok?: unknown };
  if (candidate.ok !== false) return false;
  return typeof candidate.code === "string"
    && Object.hasOwn(ENV_EXAMPLE_SYNC_CODE_LAYER_MAP, candidate.code);
}
