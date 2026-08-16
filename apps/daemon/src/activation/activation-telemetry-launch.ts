/**
 * The daemon's activation-side provider-run emission seam: the production call
 * site that makes the daemon OBSERVE a provider run rather than merely be able
 * to. It binds an admitted effect intent's run identity to the runner's own
 * telemetry launch and hands the result back untouched.
 *
 * ## Why this module adds no verdict of its own
 *
 * `launchClaudeWithTelemetry` already answers three separable questions —
 * `terminal` (how the run ended), `infrastructure` (what happened around it)
 * and `telemetryRefusal` (whether any of it could be observed at all). A daemon
 * verdict layered over those would be a SECOND authority on the same run, and
 * the two would disagree the first time the runner learned a distinction this
 * module had not. So the runner's `ClaudeTelemetryLaunchResult` is returned
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
import { launchClaudeWithTelemetry } from "@moe/runner";
import type { ClaudeLaunchOptions, ClaudeTelemetryLaunchResult } from "@moe/runner";

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
 * `request` is `unknown` for the same reason the runner types it that way: the
 * launcher snapshots and validates it inside its own containment, and a daemon
 * that pre-validated it would be checking one record and launching another.
 */
export interface ActivationTelemetryLaunchInput {
  readonly providerRun: ActivationProviderRunIdentity;
  readonly request: unknown;
  readonly options?: ClaudeLaunchOptions;
}

/**
 * Launch an admitted activation attempt through the runner's telemetry seam.
 *
 * ONE call to `launchClaudeWithTelemetry`. `parseClaudeResultTelemetry` is
 * deliberately NOT called here: the launch already composes it over the same
 * capture, and a second call would parse one run's bytes twice and could produce
 * two verdicts over a single observation.
 *
 * The result is the runner's, returned as it arrived — a refusal keeps the
 * runner's stable code and its refusing layer, and a handoff keeps every fact
 * the runner bound, including the UNKNOWNs.
 */
export async function launchActivationProviderRun(
  input: ActivationTelemetryLaunchInput,
): Promise<ClaudeTelemetryLaunchResult> {
  const { providerRun, request, options } = input;
  return await (options === undefined
    ? launchClaudeWithTelemetry({ providerRunRef: providerRun, request })
    : launchClaudeWithTelemetry({ providerRunRef: providerRun, request, options }));
}
