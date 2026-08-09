import { canonicalDigest } from "../canonical.js";
import type { ObservationClock } from "../providers/claude/claude-observation.js";
import {
  capabilityStatus as claudeCapabilityStatus,
  probeClaudeRuntime,
  type ProbeClaudeRuntimeInput,
  type ProbeClaudeRuntimeOk,
} from "../providers/claude/claude-probe.js";
import {
  capabilityStatus as codexCapabilityStatus,
  probeCodexRuntime,
  type ProbeCodexRuntimeInput,
  type ProbeCodexRuntimeOk,
} from "../providers/codex/codex-probe.js";
import type { EffectClaim } from "../supervisor/effect-kernel.js";
import { parseEffectClaim } from "../supervisor/effect-parse.js";
import { isRef } from "../supervisor/effect-shape.js";
import {
  bindsClaim,
  parseLaunchLockRegistration,
  type LaunchLockRegistration,
} from "../supervisor/launch-lock.js";
import { intakeProcessObservation } from "../supervisor/process-observation.js";
import type {
  RecoveryInventoryEnumerationContext,
  RecoveryInventoryItem,
  RecoveryInventoryPortReading,
  RecoveryInventoryRegistration,
} from "./recovery-inventory-contract.js";

/**
 * Recovery-window enumerator for the PROVIDER_PROCESS_LAUNCH_LOCK class.
 *
 * It composes three shipped authorities and adds none of its own: the capability
 * probes decide whether this population can be enumerated at all,
 * `parseLaunchLockRegistration` decides what a lock record is, and
 * `intakeProcessObservation` decides what a process record proves.
 *
 * A PROVIDER IS NOT ITSELF A RECOVERABLE ROW. Emitting a row per provider would
 * make this class permanently non-empty and quietly retire the negative-proof
 * requirement the empty case exists to enforce.
 *
 * The enumerator mints no coverage code: `collectRecoveryInventory` turns an
 * honest reading into a proof. That is why "I could not prove I saw everything"
 * is `complete: false` while "I saw nothing and cannot prove nothing exists" is
 * `complete: true` with a null negative proof - two different facts about
 * silence, never collapsed into one.
 */
export const PROVIDER_LOCK_INVENTORY_VERSION = "moe-provider-lock-inventory/1" as const;

const CLASS = "PROVIDER_PROCESS_LAUNCH_LOCK" as const;

const UNAVAILABLE: RecoveryInventoryPortReading = Object.freeze({ status: "UNAVAILABLE" as const });
const UNSUPPORTED: RecoveryInventoryPortReading = Object.freeze({ status: "UNSUPPORTED" as const });

/** Raw as handed over: every field is parsed by a shipped reader, never trusted. */
export interface ProviderProcessRecord {
  readonly processIdentity: string;
  readonly exit: unknown;
  readonly reconciliation: unknown;
}

export interface ProviderLockInventoryPort {
  /** The wrapper claim each lock is checked against with the shipped `bindsClaim`. */
  readonly governingClaim: () => unknown;
  readonly launchLockRecords: () => readonly unknown[];
  readonly processRecords: () => readonly ProviderProcessRecord[];
}

export interface ProviderLockInventoryInput {
  readonly port: ProviderLockInventoryPort;
  readonly claude: ProbeClaudeRuntimeInput;
  readonly codex: ProbeCodexRuntimeInput;
  readonly clock: ObservationClock;
}

interface ProviderSources {
  readonly claim: EffectClaim;
  readonly locks: readonly unknown[];
  readonly processes: readonly ProviderProcessRecord[];
}

/** A throwing port or an unparsable claim is unavailable, never empty. */
function readSources(port: ProviderLockInventoryPort): ProviderSources | null {
  try {
    const claim = parseEffectClaim(port.governingClaim());
    if (claim === null) {
      return null;
    }
    return { claim, locks: port.launchLockRecords(), processes: port.processRecords() };
  } catch {
    return null;
  }
}

/**
 * Only a runtime that can observe a process tree can enumerate this population.
 * Both providers are asked through the shipped `capabilityStatus`, so an unproven
 * probe report reads as UNSUPPORTED rather than as an empty runtime.
 */
function processTreeObservable(claude: ProbeClaudeRuntimeOk, codex: ProbeCodexRuntimeOk): boolean {
  return (
    claudeCapabilityStatus(claude.profile, "PROCESS_TREE_TERMINATION") === "SUPPORTED" &&
    codexCapabilityStatus(codex.profile, "PROCESS_TREE_TERMINATION") === "SUPPORTED"
  );
}

/**
 * Only a runtime that proved it can enumerate runs and name one provably absent
 * can back an empty answer; otherwise the digest is null and empty stays UNKNOWN.
 */
function negativeProof(claude: ProbeClaudeRuntimeOk, codex: ProbeCodexRuntimeOk): string | null {
  const proven =
    claudeCapabilityStatus(claude.profile, "RUN_ENUMERATION_NEGATIVE_PROOF") === "SUPPORTED" &&
    codexCapabilityStatus(codex.profile, "RUN_ENUMERATION_NEGATIVE_PROOF") === "SUPPORTED";
  if (!proven) {
    return null;
  }
  return canonicalDigest({
    version: PROVIDER_LOCK_INVENTORY_VERSION,
    claude: claude.observation.observationDigest,
    codex: codex.observation.observationDigest,
  });
}

function lockItem(
  registration: LaunchLockRegistration,
  claim: EffectClaim,
  context: RecoveryInventoryEnumerationContext,
  observedAt: string,
): RecoveryInventoryItem {
  return {
    class: CLASS,
    projectTag: context.projectTag,
    identity: { kind: "OPAQUE", id: `launch-lock:${registration.lockIdentity}` },
    observedAt,
    // The one-time bootstrap credential digest is deliberately not a fact: the
    // launch-lock protocol keeps it out of every outcome, and a row is one.
    facts: {
      source: "LAUNCH_LOCK",
      wrapperIdentity: registration.wrapperIdentity,
      processIdentity: registration.processIdentity,
      registeredAt: registration.registeredAt,
      bindsGoverningClaim: bindsClaim(registration, claim),
    },
    sourceProofDigest: canonicalDigest({
      version: PROVIDER_LOCK_INVENTORY_VERSION,
      registration: { ...registration },
    }),
  };
}

interface ProcessReading {
  readonly item: RecoveryInventoryItem;
  readonly proven: boolean;
}

function processReading(
  record: ProviderProcessRecord,
  context: RecoveryInventoryEnumerationContext,
  observedAt: string,
): ProcessReading | null {
  if (!isRef(record.processIdentity)) return null;
  const outcome = intakeProcessObservation(record.exit, record.reconciliation);
  if (outcome.kind === "REFUSED") return null;
  const { processExit, proven, reconciliation } = outcome.observation;
  return {
    proven,
    item: {
      class: CLASS,
      projectTag: context.projectTag,
      identity: { kind: "OPAQUE", id: `process:${record.processIdentity}` },
      observedAt,
      facts: {
        source: "PROCESS_OBSERVATION",
        exitKind: processExit.kind,
        dispositionProven: proven,
        // UNOBSERVED is not death: only an observed exit or signal proves an end.
        ended: processExit.kind !== "UNOBSERVED",
        reconciled: reconciliation !== null,
      },
      sourceProofDigest: canonicalDigest({
        version: PROVIDER_LOCK_INVENTORY_VERSION,
        processIdentity: record.processIdentity,
        exit: { ...processExit },
        reconciliation,
      }),
    },
  };
}

export function enumerateProviderLockInventory(
  input: ProviderLockInventoryInput,
  context: RecoveryInventoryEnumerationContext,
): RecoveryInventoryPortReading {
  const claude = probeClaudeRuntime(input.claude);
  const codex = probeCodexRuntime(input.codex);
  if (!claude.ok || !codex.ok) return UNAVAILABLE;
  if (!processTreeObservable(claude, codex)) return UNSUPPORTED;
  const sources = readSources(input.port);
  if (sources === null) return UNAVAILABLE;

  const observedAt = input.clock.observedAt();
  const items: RecoveryInventoryItem[] = [];
  // A record this seam cannot read is not a record that is not there, so it
  // truncates the enumeration instead of shrinking the population silently.
  let complete = true;
  for (const record of sources.locks) {
    const registration = parseLaunchLockRegistration(record);
    if (registration === null) {
      complete = false;
      continue;
    }
    items.push(lockItem(registration, sources.claim, context, observedAt));
  }
  for (const record of sources.processes) {
    const reading = processReading(record, context, observedAt);
    if (reading === null) {
      complete = false;
      continue;
    }
    if (!reading.proven) {
      complete = false;
    }
    items.push(reading.item);
  }
  return {
    status: "ENUMERATED",
    items,
    complete,
    negativeProofDigest: negativeProof(claude, codex),
  };
}

/**
 * A factory, not a module constant: the enumerator needs its ports, and a global
 * registration is the order-dependent coupling `createRecoveryInventoryRegistry`
 * refused. The composing daemon holds the tuple; this slice never edits it.
 */
export function providerLockInventoryRegistration(
  input: ProviderLockInventoryInput,
): RecoveryInventoryRegistration {
  return Object.freeze({
    class: CLASS,
    enumerate: (context: RecoveryInventoryEnumerationContext) =>
      enumerateProviderLockInventory(input, context),
  });
}
