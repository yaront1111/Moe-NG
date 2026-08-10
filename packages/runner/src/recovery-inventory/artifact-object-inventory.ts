import type {
  ArtifactEnumerationFailure,
  ArtifactEnumerationOk,
  ArtifactEnumerationResult,
  ArtifactObjectObservation,
  ArtifactStagingObservation,
  ArtifactStore,
} from "../artifacts/artifact-contract.js";
import { canonicalDigest } from "../canonical.js";
import type { ObservationClock } from "../providers/claude/claude-observation.js";
import type {
  RecoveryInventoryEnumerationContext,
  RecoveryInventoryItem,
  RecoveryInventoryPortReading,
  RecoveryInventoryRegistration,
} from "./recovery-inventory-contract.js";
import { compareCodePoints, identityKey } from "./recovery-inventory-shape.js";

/**
 * Recovery-window enumerator for the ARTIFACT_OBJECT_STAGING class.
 *
 * It composes the shipped store and adds no layout rule of its own: the scan, the
 * address grammar, the digest re-check and the entry ceiling all belong to
 * `ArtifactStore.enumerateArtifacts()` over `<root>/objects/<sha256>`. This module
 * only binds what came back to inventory rows.
 *
 * THREE FACTS, THREE ANSWERS: an observed but empty objects directory is COMPLETE
 * against the store's own observation digest, an absent store root is UNAVAILABLE,
 * and an entry that could not be read TRUNCATES. A port that cannot list at all is
 * a fourth and different thing — UNSUPPORTED — because a missing capability is not
 * a missing directory.
 *
 * NOTHING IS EVER SKIPPED. The store refuses the whole scan when an entry is not a
 * valid content address, is not a regular file, or does not hash to its own name;
 * that refusal is carried out on `refusal` with its exact code and boundary, so a
 * layout fault (ARTIFACT_STORE) never reads as an I/O fault (ARTIFACT_FS_PORT).
 * Dropping the bad entry and reporting the rest would launder corruption into an
 * inventory that later authorises a recovery.
 */
export const ARTIFACT_OBJECT_INVENTORY_VERSION = "moe-artifact-object-inventory/1" as const;

const CLASS = "ARTIFACT_OBJECT_STAGING" as const;
/** Identities are namespaced by the store subdirectory they were observed in. */
const OBJECTS_PREFIX = "objects/";

const UNAVAILABLE: RecoveryInventoryPortReading = Object.freeze({ status: "UNAVAILABLE" as const });
const UNSUPPORTED: RecoveryInventoryPortReading = Object.freeze({ status: "UNSUPPORTED" as const });

export interface ArtifactObjectInventoryReading {
  readonly reading: RecoveryInventoryPortReading;
  /** The store's verbatim refusal, code and boundary intact; null on success. */
  readonly refusal: ArtifactEnumerationFailure | null;
}

export interface ArtifactObjectInventoryInput {
  readonly store: ArtifactStore;
  readonly clock: ObservationClock;
}

/** `a\b` and `a/b` name one entry, so identity, order and digest must agree. */
function identityPath(name: string): string {
  return `${OBJECTS_PREFIX}${name}`.replace(/\\/gu, "/");
}

/**
 * A missing listing capability and a missing directory are different questions:
 * one was never askable, the other was asked and answered. Every remaining code —
 * an unreadable entry, a corrupt address, an over-full directory — means the scan
 * did not finish, so it truncates rather than shrinking the population silently.
 */
function readingForFailure(failure: ArtifactEnumerationFailure): RecoveryInventoryPortReading {
  if (failure.code === "RUNNER_ARTIFACT_ENUMERATION_UNAVAILABLE") {
    return UNSUPPORTED;
  }
  if (failure.code === "RUNNER_ARTIFACT_MISSING") {
    return UNAVAILABLE;
  }
  return { status: "ENUMERATED", items: [], complete: false, negativeProofDigest: null };
}

function objectItem(
  object: ArtifactObjectObservation,
  observation: ArtifactEnumerationOk,
  context: RecoveryInventoryEnumerationContext,
  observedAt: string,
): RecoveryInventoryItem {
  return {
    class: CLASS,
    projectTag: context.projectTag,
    identity: { kind: "PATH", path: identityPath(object.sha256) },
    observedAt,
    facts: { entry: "OBJECT", sha256: object.sha256, byteLength: object.byteLength },
    sourceProofDigest: canonicalDigest({
      version: ARTIFACT_OBJECT_INVENTORY_VERSION,
      entry: "OBJECT",
      sha256: object.sha256,
      byteLength: object.byteLength,
      observationDigest: observation.observationDigest,
    }),
  };
}

/**
 * A staging temp is reported by NAME and never by address: it is not addressable
 * content yet, and promoting its digest to an address would invent an artifact
 * the store never persisted.
 */
function stagingItem(
  temp: ArtifactStagingObservation,
  observation: ArtifactEnumerationOk,
  context: RecoveryInventoryEnumerationContext,
  observedAt: string,
): RecoveryInventoryItem {
  return {
    class: CLASS,
    projectTag: context.projectTag,
    identity: { kind: "PATH", path: identityPath(temp.name) },
    observedAt,
    facts: {
      entry: "STAGING",
      name: temp.name,
      sha256: temp.sha256,
      byteLength: temp.byteLength,
    },
    sourceProofDigest: canonicalDigest({
      version: ARTIFACT_OBJECT_INVENTORY_VERSION,
      entry: "STAGING",
      name: temp.name,
      sha256: temp.sha256,
      byteLength: temp.byteLength,
      observationDigest: observation.observationDigest,
    }),
  };
}

/**
 * What makes an empty answer verifiable: the store emits an observation digest
 * even for a directory holding nothing, so this says "these entries were read"
 * rather than "trust me, there are none".
 */
function observationProof(observation: ArtifactEnumerationOk): string {
  return canonicalDigest({
    version: ARTIFACT_OBJECT_INVENTORY_VERSION,
    entryCount: observation.entryCount,
    observationDigest: observation.observationDigest,
  });
}

export function enumerateArtifactObjectInventory(
  input: ArtifactObjectInventoryInput,
  context: RecoveryInventoryEnumerationContext,
): ArtifactObjectInventoryReading {
  let result: ArtifactEnumerationResult;
  try {
    result = input.store.enumerateArtifacts();
  } catch {
    // A store that threw past its own coded result answered nothing at all.
    return { reading: UNAVAILABLE, refusal: null };
  }
  if (!result.ok) {
    return { reading: readingForFailure(result), refusal: result };
  }
  const observedAt = input.clock.observedAt();
  const items: RecoveryInventoryItem[] = [
    ...result.objects.map((object) => objectItem(object, result, context, observedAt)),
    ...result.staging.map((temp) => stagingItem(temp, result, context, observedAt)),
  ];
  // Code points, never localeCompare: an order that depends on the host's
  // collation makes the observation depend on the machine that produced it.
  items.sort((left, right) => compareCodePoints(identityKey(left.identity), identityKey(right.identity)));
  return {
    reading: {
      status: "ENUMERATED",
      items,
      complete: true,
      negativeProofDigest: observationProof(result),
    },
    refusal: null,
  };
}

/**
 * A factory for the same reason as the sibling slices: a module-global
 * registration is the order-dependent coupling the aggregate refused.
 */
export function artifactObjectInventoryRegistration(
  input: ArtifactObjectInventoryInput,
): RecoveryInventoryRegistration {
  return Object.freeze({
    class: CLASS,
    enumerate: (context: RecoveryInventoryEnumerationContext) =>
      enumerateArtifactObjectInventory(input, context).reading,
  });
}
