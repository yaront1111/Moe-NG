/**
 * The daemon's activation-side provider-run emission seam: the production call
 * site that makes the daemon OBSERVE a provider run rather than merely be able
 * to. It binds an admitted effect intent's run identity to the runner's own
 * AUTHORITY-BOUND telemetry launch and hands the result back untouched.
 *
 * ## What this module consumes, and what it is forbidden to build
 *
 * The `ClaudeLauncherAuthority` arrives already authorized, as an internal
 * dependency of this seam rather than something assembled inside it. The runner
 * package owns launch composition end to end: `createTelemetryBoundClaudeLauncher`
 * binds the launcher to that authority ONCE and captures the raw
 * `ClaudeLaunchResult` and the handoff derived from THAT SAME capture in one
 * invocation. Neither half of that pair is this module's to mint, re-derive or
 * re-pair — the daemon supplies an authority and a run identity, and reads back
 * what the runner witnessed.
 *
 * ## Why this module adds no verdict of its own
 *
 * The bound launcher already answers three separable questions — `terminal` (how
 * the run ended), `infrastructure` (what happened around it) and
 * `telemetryRefusal` (whether any of it could be observed at all). A daemon
 * verdict layered over those would be a SECOND authority on the same run, and
 * the two would disagree the first time the runner learned a distinction this
 * module had not. So the runner's `ClaudeBoundLaunchResult` is returned
 * unchanged: both arms, every field, no re-wrapping.
 *
 * ## `ok: true` IS NOT SUCCESS, and this seam must not pretend otherwise
 *
 * The ONLY route to the `ok: false` arm is a run reference the runner could not
 * snapshot. A launcher that REFUSED before any provider bytes existed, and a
 * delivery that launched no process at all, both come back `ok: true` carrying
 * a BLIND handoff — facts UNKNOWN, `telemetryRefusal` populated. Callers of this
 * module must read `handoff.terminal`, `handoff.infrastructure` and
 * `handoff.telemetryRefusal`; a caller branching on `ok` alone would book a
 * refused launch as a healthy observation. Returning the arms losslessly is
 * precisely what keeps that distinction reachable.
 *
 * ## The run identity travels UNREAD
 *
 * `providerRun` is forwarded to the runner verbatim rather than rebuilt field by
 * field here. That is deliberate, not laziness: `snapshotRunRef` refuses a proxy
 * BEFORE it reads any property, and a daemon-side projection would run the
 * caller's accessors ahead of that guard — the caller's code executing inside
 * the read that decides whether to trust the caller. The runner is also the only
 * package permitted to mint a run ref at all; `snapshotRunRef` is withheld from
 * its published surface for that reason, so validating or normalising one here
 * would be a second, drifting copy of a deliberately private minter.
 *
 * The typed `ActivationProviderRunIdentity` below therefore describes the shape
 * a well-behaved caller supplies; it is NOT a runtime check, and nothing in this
 * module treats it as one.
 *
 * ## No message this module produces says anything about the run
 *
 * The runner's refusal messages are static by design, because a message quoting
 * captured bytes, a model or a digest would echo provider output back out of a
 * failure path. Nothing here interpolates a path, an argv entry, an environment
 * value or a digest into any string, and no string is produced on the refusal
 * path at all — the runner's own message travels with its code and layer.
 */
import { createTelemetryBoundClaudeLauncher } from "@moe/runner";
import type { ClaudeBoundLaunchResult, ClaudeLauncherAuthority } from "@moe/runner";

/**
 * The five run-identity facts a provider-run record is keyed by. `effectIntentId`
 * and `attemptRef` are activation vocabulary, which is why this seam lives on the
 * activation path rather than beside the orchestrator's own agent spawner.
 */
export interface ActivationProviderRunIdentity {
  readonly provider: "claude";
  readonly runRef: string;
  readonly effectIntentId: string;
  readonly attemptRef: string;
  readonly epoch: number;
}

/**
 * The two launch options an activation caller has standing to declare. The
 * runner's own `ClaudeLaunchOptions` also carries `deps` — the launcher's ten
 * internal ports — and naming that type here would publish a way to REPLACE the
 * authority-composed dependency set from the daemon's call site. Narrowing to
 * these two makes `deps` unrepresentable in the type system; the runner still
 * refuses a runtime-cast one at its own layer, which is why the options object
 * is forwarded whole rather than rebuilt from these two fields.
 */
export interface ActivationLaunchOptions {
  readonly platform?: string;
  readonly signal?: AbortSignal;
}

/**
 * `request` is `unknown` for the same reason the runner types it that way: the
 * launcher snapshots and validates it inside its own containment, and a daemon
 * that pre-validated it would be checking one record and launching another.
 */
export interface ActivationTelemetryLaunchInput {
  readonly providerRun: ActivationProviderRunIdentity;
  readonly request: unknown;
  readonly options?: ActivationLaunchOptions;
}

/**
 * Launch an admitted activation attempt through the runner's DURABLE telemetry
 * seam, under the caller's own launch authority.
 *
 * The authority is a separate, MANDATORY argument, and that is the whole point
 * of this signature. `launchClaudeWithTelemetry` runs on the runner's shipped
 * defaults, so a daemon calling it launches provider processes that no durable
 * grant admitted and no registration records. There is deliberately no
 * one-argument arm, no default authority and no fallback to the raw entry point:
 * an unauthoritative route that still compiles is an unauthoritative route that
 * will eventually be taken.
 *
 * The authority arrives ALREADY AUTHORIZED — this seam neither builds one from a
 * store nor inspects the one it is handed. Composing an authority is the
 * Foundation call site's job, because that is where the persistence configuration
 * it needs actually lives, and a daemon that assembled one here would be minting
 * launch authority on the path that consumes it.
 *
 * ONE composition and ONE invocation. `createTelemetryBoundClaudeLauncher` binds
 * `createClaudeLauncher` once, so a later mutation of the caller's authority
 * cannot redirect a launch already in flight; invoking the bound runner twice
 * would be two physical launches attributed to one admitted run.
 *
 * The result is the runner's, returned exactly as it arrived — not spread, not
 * projected, not re-paired. The runner package owns the binding of the raw
 * `ClaudeLaunchResult` to the handoff derived from THAT capture; a daemon that
 * rebuilt the pair would be asserting a launch and an observation belong together
 * without having witnessed either. A refusal keeps the runner's stable code and
 * its refusing layer, and a handoff keeps every fact the runner bound, including
 * the UNKNOWNs.
 */
export async function launchActivationProviderRun(
  authority: ClaudeLauncherAuthority,
  input: ActivationTelemetryLaunchInput,
): Promise<ClaudeBoundLaunchResult> {
  const { providerRun, request, options } = input;
  const launch = createTelemetryBoundClaudeLauncher(authority);
  return await (options === undefined
    ? launch({ providerRunRef: providerRun, request })
    : launch({ providerRunRef: providerRun, request, options }));
}
