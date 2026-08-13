import { deepFreeze } from "../../canonical.js";
import { registerLaunchLock, launchLockFailure,
  type LaunchLockRegistration } from "../../supervisor/launch-lock.js";
import { CLAUDE_LAUNCHER_DEFAULTS, launchClaude } from "./claude-launcher.js";
import { readCapability, snapshotLaunchEntry, snapshotLauncherPorts,
  type Capability } from "./claude-launcher-port-results.js";
import { CLAUDE_STARTED_IDENTITY_PREFIX, pendingProcessIdentity,
  type ClaudeLaunchFailure, type ClaudeLaunchOptions, type ClaudeLaunchRegistrationPhase,
  type ClaudeLaunchResult, type ClaudeLauncherDependencies } from "./claude-launcher-contract.js";

/**
 * The durable-authority overlay for the shipped Claude launcher.
 *
 * Production consumer: task-6cbff01023b14b26a78fc5e3eb1dd8a9, the daemon attempt
 * dispatcher. It needs the launcher's grant consumption and launch registration
 * to be DURABLE compare-and-sets rather than pure functions, because a pure
 * consume cannot close the window between the physical open and the observation:
 * a crash there leaves the grant UNUSED forever and no record that a process was
 * ever started. It equally must not hand in a whole dependency set — that would
 * mean reimplementing the runtime pin, the Job Object boundary, the OS-exclusive
 * lock and the duplicate resolver in the daemon, which is the opposite of a seam.
 *
 * So this module replaces exactly two of the ten ports and inherits the other
 * eight. `CLAUDE_LAUNCHER_DEFAULTS` stays off the published surface: a consumer
 * that could take the defaults one at a time could swap the Windows physical
 * boundary alone and keep every other guarantee's appearance.
 *
 * TWO COMPOSITION RULES, both load-bearing.
 *
 * 1. The grant port delegates STRAIGHT to the durable CAS. Pre-running the pure
 *    `consumeActivationGrant` here would answer a replay from the PURE layer —
 *    the durable refusal would never be reached, and a test pinning the
 *    delegated code would pass with the delegation deleted.
 * 2. The registration port runs the PURE `registerLaunchLock` FIRST and hands
 *    the durable port only its REGISTERED outcome. Claim binding, one-time
 *    credential reuse and prior-conflict authority stay here; a daemon that had
 *    to reimplement them would be reimplementing the lock protocol.
 *
 * Neither wrapper is async and neither adds a `try`. `launchClaude`'s
 * `contained()` and the lifecycle's own `try` own containment AND layer
 * attribution; a `catch` here would swallow the throw and mislabel which layer
 * refused.
 */
const COMMAND = "launchLock.register";
const AUTHORITY_UNUSABLE: ClaudeLaunchFailure = deepFreeze({
  kind: "REFUSED" as const,
  ok: false as const,
  truthClass: "UNKNOWN" as const,
  code: "CLAUDE_LAUNCH_AUTHORITY_UNUSABLE" as const,
  layer: "LAUNCHER" as const,
  message: "the durable launch authority capabilities are unusable",
});

/**
 * Which of the launcher's two registration moments a validated registration
 * names, decided from the identity FORMAT rather than an invocation ordinal: a
 * counter silently mislabels the day the call order changes, while a format
 * built from one shared constant cannot drift without this classifier noticing.
 *
 * `null` is the fail-closed third answer. It is unreachable from today's two
 * call sites — both build their identity with the shared builders — and exists
 * so that a third registration point added later refuses rather than being
 * quietly filed under STARTED and persisted as process authority.
 */
export function classifyRegistrationPhase(
  registration: LaunchLockRegistration,
): ClaudeLaunchRegistrationPhase | null {
  if (registration.processIdentity === pendingProcessIdentity(registration.wrapperIdentity)) {
    return "PREFLIGHT";
  }
  return registration.processIdentity.startsWith(CLAUDE_STARTED_IDENTITY_PREFIX) ? "STARTED" : null;
}

/**
 * The composed registration port: pure lock protocol, then the durable commit.
 * Exported so its refusal arms can be pinned directly — the unclassifiable-phase
 * arm has no path through `launchClaude` today, and an untestable guard is a
 * guard nobody notices going wrong.
 */
export function durableRegistrationPort(
  commitProcessRegistration: Capability,
): (registration: unknown, claim: unknown, prior: unknown) => unknown {
  return (registration: unknown, claim: unknown, prior: unknown): unknown => {
    const outcome = registerLaunchLock(registration, claim, prior);
    if (outcome.kind !== "REGISTERED") return outcome;
    const phase = classifyRegistrationPhase(outcome.registration);
    if (phase === null) {
      return Object.freeze({ kind: "REFUSED" as const, failure: launchLockFailure(
        "LAUNCH_LOCK_MALFORMED", "LAUNCH_LOCK",
        "the launch registration names no declared registration phase", COMMAND) });
    }
    return commitProcessRegistration(
      Object.freeze({ phase, registration: outcome.registration, claim, prior }));
  };
}

/**
 * Binds the two authority capabilities ONCE and returns a launcher that runs the
 * shipped defaults everywhere else. Binding at construction is what makes a
 * later mutation of the caller's authority object unable to redirect a launch
 * that is already in flight.
 *
 * A malformed authority yields a launcher that refuses with a stable code rather
 * than a constructor that throws: the caller of a launcher expects a result, and
 * a throw here would be the one failure path with no reason code.
 */
export function createClaudeLauncher(
  authority: unknown,
): (value: unknown, options?: ClaudeLaunchOptions) => Promise<ClaudeLaunchResult> {
  const consumeGrantDurably = readCapability(authority, "consumeGrantDurably");
  const commitProcessRegistration = readCapability(authority, "commitProcessRegistration");
  if (consumeGrantDurably === null || commitProcessRegistration === null) {
    return async (): Promise<ClaudeLaunchResult> => AUTHORITY_UNUSABLE;
  }
  const consumeGrant = (grant: unknown, wrapperIdentity: unknown): unknown =>
    consumeGrantDurably(grant, wrapperIdentity);
  const registerLock = durableRegistrationPort(commitProcessRegistration);
  return async (value: unknown, options?: ClaudeLaunchOptions): Promise<ClaudeLaunchResult> => {
    // The caller's options are caller data: read them with the launcher's own
    // strict reader, and on anything it refuses, forward the original so the
    // launcher produces its own refusal instead of a rejected promise here.
    const entry = snapshotLaunchEntry(options, process.platform);
    if (entry === null) return await launchClaude(value, options);
    const base = snapshotLauncherPorts(entry.deps ?? CLAUDE_LAUNCHER_DEFAULTS);
    if (base === null) return await launchClaude(value, options);
    const deps: ClaudeLauncherDependencies =
      Object.freeze({ ...base, consumeGrant, registerLock });
    // `exactOptionalPropertyTypes` forbids handing `signal: undefined` to an
    // optional slot, and an absent signal is not the same claim as a present one.
    return await launchClaude(value, entry.signal === undefined
      ? { platform: entry.platform, deps }
      : { platform: entry.platform, signal: entry.signal, deps });
  };
}
