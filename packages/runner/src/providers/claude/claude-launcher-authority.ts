import { deepFreeze } from "../../canonical.js";
import { consumeActivationGrant, grantRefusal } from "../../supervisor/effect-grant.js";
import { type ActivationGrant } from "../../supervisor/effect-kernel.js";
import { registerLaunchLock, launchLockFailure,
  type LaunchLockRegistration } from "../../supervisor/launch-lock.js";
import { CLAUDE_LAUNCHER_DEFAULTS, launchClaude } from "./claude-launcher.js";
import { decodeGrant, decodeRegistration, readCapability, snapshotLaunchEntry,
  snapshotLauncherPorts, type Capability } from "./claude-launcher-port-results.js";
import { CLAUDE_STARTED_IDENTITY_PREFIX, pendingProcessIdentity,
  type ClaudeLaunchErrorCode, type ClaudeLaunchFailure, type ClaudeLaunchLayer,
  type ClaudeLaunchOptions, type ClaudeLaunchRegistrationPhase, type ClaudeLaunchResult,
  type ClaudeLauncherDependencies } from "./claude-launcher-contract.js";

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
 * eight. `CLAUDE_LAUNCHER_DEFAULTS` stays off the published surface, and the
 * published factory refuses a caller's `deps` outright rather than merging under
 * it: a consumer that could supply the other eight would replace the Windows
 * physical boundary alone and keep every other guarantee's appearance.
 *
 * THREE COMPOSITION RULES, all load-bearing.
 *
 * 1. The grant port delegates STRAIGHT to the durable CAS. Pre-running the pure
 *    `consumeActivationGrant` here would answer a replay from the PURE layer —
 *    the durable refusal would never be reached, and a test pinning the
 *    delegated code would pass with the delegation deleted.
 * 2. The registration port runs the PURE `registerLaunchLock` FIRST and hands
 *    the durable port only its REGISTERED outcome. Claim binding, one-time
 *    credential reuse and prior-conflict authority stay here; a daemon that had
 *    to reimplement them would be reimplementing the lock protocol.
 * 3. A durable SUCCESS is checked against the request that produced it. Decoding
 *    proves a record is well formed; it does not prove the store answered about
 *    the same grant, or the same lock. An unchecked echo lets a buggy or hostile
 *    store redirect the OS-exclusive lock and the physical open onto an identity
 *    nobody asked for — so each success is compared field by field against the
 *    pure-validated proposal, and only an exact match may drive anything.
 *
 * Neither wrapper is async and neither adds a `try`. `launchClaude`'s
 * `contained()` and the lifecycle's own `try` own containment AND layer
 * attribution; a `catch` here would swallow the throw and mislabel which layer
 * refused. Rule 3's checks run only on the SUCCESS arm, so a delegated refusal
 * still reaches the caller with the durable store's own code and layer.
 */
const COMMAND = "launchLock.register";
const refusal = (
  code: ClaudeLaunchErrorCode, layer: ClaudeLaunchLayer, message: string,
): ClaudeLaunchFailure =>
  deepFreeze({ kind: "REFUSED" as const, ok: false as const, truthClass: "UNKNOWN" as const,
    code, layer, message });
const AUTHORITY_UNUSABLE = refusal("CLAUDE_LAUNCH_AUTHORITY_UNUSABLE", "LAUNCHER",
  "the durable launch authority capabilities are unusable");
const DEPENDENCIES_REFUSED = refusal("CLAUDE_LAUNCH_REQUEST_MALFORMED", "LAUNCHER",
  "the durable launcher composes its own shipped dependencies");
const lockRefusal = (code: "LAUNCH_LOCK_MALFORMED" | "LAUNCH_LOCK_IDENTITY_CONFLICT",
  message: string): unknown =>
  Object.freeze({ kind: "REFUSED" as const,
    failure: launchLockFailure(code, "LAUNCH_LOCK", message, COMMAND) });

/**
 * Field-by-field equality, with the field set spelled as an exhaustive map so a
 * field ADDED to the record later fails to compile until it is compared too. A
 * hand-listed array would silently stop covering the record it polices.
 */
function echoes<T>(answer: T, expected: T, fields: Readonly<Record<keyof T, true>>): boolean {
  return (Object.keys(fields) as (keyof T)[]).every((key) => answer[key] === expected[key]);
}
const GRANT_FIELDS: Readonly<Record<keyof ActivationGrant, true>> = Object.freeze({
  grantId: true, intentId: true, wrapperIdentity: true, state: true, version: true,
});
const REGISTRATION_FIELDS: Readonly<Record<keyof LaunchLockRegistration, true>> = Object.freeze({
  lockIdentity: true, wrapperIdentity: true, processIdentity: true,
  bootstrapCredentialDigest: true, registeredAt: true,
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
 * The composed registration port: pure lock protocol, durable commit, then the
 * echo check. Exported so its refusal arms can be pinned directly — the
 * unclassifiable-phase arm has no path through `launchClaude` today, and an
 * untestable guard is a guard nobody notices going wrong.
 */
export function durableRegistrationPort(
  commitProcessRegistration: Capability,
): (registration: unknown, claim: unknown, prior: unknown) => unknown {
  return (registration: unknown, claim: unknown, prior: unknown): unknown => {
    const outcome = registerLaunchLock(registration, claim, prior);
    if (outcome.kind !== "REGISTERED") return outcome;
    const proposed = outcome.registration;
    const phase = classifyRegistrationPhase(proposed);
    if (phase === null) {
      return lockRefusal("LAUNCH_LOCK_MALFORMED",
        "the launch registration names no declared registration phase");
    }
    const answer = commitProcessRegistration(Object.freeze({ phase, registration: proposed, claim, prior }));
    const decided = decodeRegistration(answer);
    // A delegated refusal — and anything the decoder cannot read — travels on
    // untouched, so the durable store keeps its own code and layer.
    if (decided.kind !== "OK") return answer;
    return echoes(decided.value, proposed, REGISTRATION_FIELDS) ? answer : lockRefusal(
      "LAUNCH_LOCK_IDENTITY_CONFLICT",
      "the durable registration is not the registration presented");
  };
}

/**
 * The composed grant port: durable CAS first, then the transition check.
 *
 * The pure function runs only AFTER a durable success, and then as an ORACLE
 * rather than a gate: it says what the one admissible consumption of these exact
 * bytes would be. A store claiming success where no consumption is admissible —
 * a spent record, another wrapper's grant — is refused with the pure layer's own
 * code, and a store answering about a different grant is refused as incoherent.
 */
function durableGrantPort(
  consumeGrantDurably: Capability,
): (grant: unknown, wrapperIdentity: unknown) => unknown {
  return (grant: unknown, wrapperIdentity: unknown): unknown => {
    const answer = consumeGrantDurably(grant, wrapperIdentity);
    const decided = decodeGrant(answer);
    if (decided.kind !== "OK") return answer;
    const admissible = consumeActivationGrant(grant, wrapperIdentity);
    if (admissible.kind !== "CONSUMED") return admissible;
    return echoes(decided.value, admissible.grant, GRANT_FIELDS) ? answer : grantRefusal(
      "ACTIVATION_COMMIT_INCOHERENT", "ACTIVATION",
      "the durable answer is not the consumption of the presented grant");
  };
}

/**
 * Binds the two authority capabilities ONCE over a given dependency base.
 * Internal: `base` is the package's own port set, never a caller's. Binding at
 * construction is what makes a later mutation of the caller's authority object
 * unable to redirect a launch that is already in flight.
 *
 * A malformed authority yields a launcher that refuses with a stable code rather
 * than a constructor that throws: the caller of a launcher expects a result, and
 * a throw here would be the one failure path with no reason code.
 */
export function composeDurableLauncher(
  base: ClaudeLauncherDependencies, authority: unknown,
): (value: unknown, options?: ClaudeLaunchOptions) => Promise<ClaudeLaunchResult> {
  const consumeGrantDurably = readCapability(authority, "consumeGrantDurably");
  const commitProcessRegistration = readCapability(authority, "commitProcessRegistration");
  if (consumeGrantDurably === null || commitProcessRegistration === null) {
    return async (): Promise<ClaudeLaunchResult> => AUTHORITY_UNUSABLE;
  }
  const consumeGrant = durableGrantPort(consumeGrantDurably);
  const registerLock = durableRegistrationPort(commitProcessRegistration);
  return async (value: unknown, options?: ClaudeLaunchOptions): Promise<ClaudeLaunchResult> => {
    // The caller's options are caller data: read them with the launcher's own
    // strict reader, and on anything it refuses, forward the original so the
    // launcher produces its own refusal instead of a rejected promise here.
    const entry = snapshotLaunchEntry(options, process.platform);
    if (entry === null) return await launchClaude(value, options);
    if (entry.deps !== undefined) return DEPENDENCIES_REFUSED;
    const ports = snapshotLauncherPorts(base);
    // An unusable base is forwarded rather than answered here, so the LAUNCHER's
    // dependency reader stays the layer that refuses it.
    const deps: ClaudeLauncherDependencies = ports === null
      ? base : Object.freeze({ ...ports, consumeGrant, registerLock });
    // `exactOptionalPropertyTypes` forbids handing `signal: undefined` to an
    // optional slot, and an absent signal is not the same claim as a present one.
    return await launchClaude(value, entry.signal === undefined
      ? { platform: entry.platform, deps }
      : { platform: entry.platform, signal: entry.signal, deps });
  };
}

/**
 * The published seam: the shipped runtime pin, duplicate resolver, Windows
 * boundary, OS lock, observation, clock and delay, with only grant consumption
 * and launch registration delegated to the caller's durable authority.
 */
export function createClaudeLauncher(
  authority: unknown,
): (value: unknown, options?: ClaudeLaunchOptions) => Promise<ClaudeLaunchResult> {
  return composeDurableLauncher(CLAUDE_LAUNCHER_DEFAULTS, authority);
}
