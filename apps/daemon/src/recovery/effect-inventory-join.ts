import { createHash } from "node:crypto";

import type {
  RecoveryInventoryItem,
  RecoveryInventoryReport,
} from "@moe/runner";

import type {
  DurableInventoryObservation,
} from "./durable-recovery-inventory-contract.js";
import {
  recoveryInventoryRefusal,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryInventoryPopulation,
  RecoveryInventoryRefusal,
  RecoveryInventoryUpstream,
  RecoveryProofClass,
  RecoveryReconciliationItem,
} from "./recovery-inventory-contract.js";
import {
  compareRecoveryReconciliationItems,
  recoveryClassScopedIdentity,
} from "./recovery-inventory-invariants.js";
import {
  adjudicateSubject,
} from "./recovery-inventory-subject.js";
import type {
  RecoveryReconciliationSelectedRefs,
  RecoveryReconciliationSubject,
  RecoverySubjectEvidence,
} from "./recovery-inventory-subject.js";

export type RestoredIntentProof =
  | {
      readonly status: "VERIFIED";
      readonly incarnationRef: string;
      readonly intentDigest: string;
      readonly intentRef: string;
      readonly keyEpochRef: string;
    }
  | { readonly status: "UNKNOWN"; readonly upstream: RecoveryInventoryUpstream };

export interface RestoredEffectIntent {
  readonly class: RecoveryProofClass;
  readonly externalIdentity: string;
  readonly population: RecoveryInventoryPopulation;
  readonly proof: RestoredIntentProof;
}

export interface EffectInventoryJoinRequest {
  readonly durableItems: readonly DurableInventoryObservation[];
  readonly nodeItems: readonly RecoveryInventoryItem[];
  readonly proofDigests: ReadonlyMap<RecoveryProofClass, string>;
  readonly restoredIntents: readonly RestoredEffectIntent[];
  readonly selected: RecoveryReconciliationSelectedRefs;
}

export interface EffectInventoryJoined {
  readonly historyInsertions: readonly never[];
  readonly items: readonly RecoveryReconciliationItem[];
  readonly ok: true;
  readonly repeatRequests: readonly never[];
  readonly subjects: readonly RecoveryReconciliationSubject[];
}

export type EffectInventoryJoinResult = EffectInventoryJoined | RecoveryInventoryRefusal;

interface ObservedSubject {
  readonly class: RecoveryProofClass;
  readonly evidence?: RecoverySubjectEvidence;
  readonly identity: string;
  readonly population: RecoveryInventoryPopulation;
  readonly sourceProofDigest: string;
}

const adapterUpstream = (code: RecoveryInventoryUpstream["code"]): RecoveryInventoryUpstream =>
  Object.freeze({ code, layer: "INVENTORY_ADAPTER" as const });

const localUpstream = (code: RecoveryInventoryUpstream["code"]): RecoveryInventoryUpstream =>
  Object.freeze({ code, layer: "RECOVERY_INVENTORY" as const });

const duplicateRefusal = recoveryInventoryRefusal(
  localUpstream("RECOVERY_INVENTORY_SUBJECT_DUPLICATE"),
  "Two inventory observations or restored intents claimed one class-scoped identity.",
);

const digestFor = (
  proofDigests: ReadonlyMap<RecoveryProofClass, string>,
  proofClass: RecoveryProofClass,
): string => proofDigests.get(proofClass) ?? "0".repeat(64);

const nodeIdentity = (item: RecoveryInventoryItem): string =>
  item.identity.kind === "PATH" ? item.identity.path : item.identity.id;

function nodePopulation(item: RecoveryInventoryItem): RecoveryInventoryPopulation | null {
  if (item.class === "WORKSPACE") return "PROJECT_TAGGED_WORKSPACE";
  if (item.class === "GIT_INTEGRATION_ON_DISK") return "GIT_BRANCH_REF";
  if (item.class === "ARTIFACT_OBJECT_STAGING") return "ARTIFACT_STAGING";
  if (item.facts["source"] === "LAUNCH_LOCK") return "EFFECT_LOCK_WRAPPER_REGISTRATION";
  if (item.facts["source"] === "PROCESS_OBSERVATION") return "PROVIDER_RUN";
  return null;
}

function nodeObserved(
  item: RecoveryInventoryItem,
  proofDigests: ReadonlyMap<RecoveryProofClass, string>,
): ObservedSubject {
  const population = nodePopulation(item);
  const unresolved = population === null;
  const ended = item.facts["source"] === "PROCESS_OBSERVATION" &&
    item.facts["ended"] === true && item.facts["dispositionProven"] === true;
  const evidence = unresolved
    ? Object.freeze({ kind: "UNRESOLVED" as const, upstream: adapterUpstream("RECOVERY_INVENTORY_ITEM_UNRESOLVED") })
    : ended
      ? Object.freeze({ kind: "NEGATIVE_COMPLETE" as const, proofDigest: item.sourceProofDigest })
      : null;
  return Object.freeze({
    class: item.class,
    ...(evidence === null ? {} : { evidence }),
    identity: nodeIdentity(item),
    population: population ?? "PROVIDER_RUN",
    sourceProofDigest: digestFor(proofDigests, item.class),
  });
}

function durableObserved(
  item: DurableInventoryObservation,
  proofDigests: ReadonlyMap<RecoveryProofClass, string>,
): ObservedSubject {
  if (item.class === "INTEGRATION_TARGET") {
    return Object.freeze({
      class: item.class,
      identity: item.targetRef,
      population: "INTEGRATION_TARGET" as const,
      sourceProofDigest: digestFor(proofDigests, item.class),
    });
  }
  const unresolved = item.fenceability === "NON_FENCEABLE" && item.state !== "RELEASED";
  const evidence = unresolved
    ? Object.freeze({ kind: "UNRESOLVED" as const, upstream: adapterUpstream("RECOVERY_INVENTORY_ITEM_UNRESOLVED") })
    : item.state === "RELEASED"
      ? Object.freeze({ kind: "NEGATIVE_COMPLETE" as const, proofDigest: item.sourceProofDigest })
      : null;
  return Object.freeze({
    class: item.class,
    ...(evidence === null ? {} : { evidence }),
    identity: item.resourceId,
    population: "RESOURCE" as const,
    sourceProofDigest: digestFor(proofDigests, item.class),
  });
}

const quarantineEvidence = (observed: ObservedSubject): RecoverySubjectEvidence => {
  const body = JSON.stringify([observed.class, observed.population, observed.identity]);
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  return Object.freeze({ kind: "ORPHAN" as const, quarantineRef: `recovery-quarantine:${digest}` });
};

function matchingIntents(
  observed: ObservedSubject,
  restoredIntents: readonly RestoredEffectIntent[],
): readonly RestoredEffectIntent[] {
  return restoredIntents.filter((intent) =>
    intent.class === observed.class && intent.population === observed.population &&
    intent.externalIdentity === observed.identity,
  );
}

function evidenceFor(
  observed: ObservedSubject,
  restoredIntents: readonly RestoredEffectIntent[],
): RecoverySubjectEvidence | RecoveryInventoryRefusal {
  if (observed.evidence !== undefined) return observed.evidence;
  const matches = matchingIntents(observed, restoredIntents);
  if (matches.length > 1) return duplicateRefusal;
  const match = matches[0];
  if (match === undefined) return quarantineEvidence(observed);
  if (match.proof.status === "UNKNOWN") {
    return Object.freeze({ kind: "UNRESOLVED" as const, upstream: match.proof.upstream });
  }
  return Object.freeze({
    externalIdentity: match.externalIdentity,
    incarnationRef: match.proof.incarnationRef,
    intentDigest: match.proof.intentDigest,
    intentRef: match.proof.intentRef,
    keyEpochRef: match.proof.keyEpochRef,
    kind: "RESTORED_INTENT" as const,
  });
}

function buildSubject(
  observed: ObservedSubject,
  restoredIntents: readonly RestoredEffectIntent[],
): RecoveryReconciliationSubject | RecoveryInventoryRefusal {
  const evidence = evidenceFor(observed, restoredIntents);
  if ("ok" in evidence) return evidence;
  return Object.freeze({
    class: observed.class,
    evidence,
    identity: observed.identity,
    population: observed.population,
    sourceProofDigest: observed.sourceProofDigest,
  });
}

function hasDuplicateSubject(subjects: readonly RecoveryReconciliationSubject[]): boolean {
  const keys = subjects.map((subject) => recoveryClassScopedIdentity(subject.class, subject.identity));
  return new Set(keys).size !== keys.length;
}

/** Pure join: it cannot insert restored history or schedule a repeat. */
export function joinEffectInventoryItems(request: EffectInventoryJoinRequest): EffectInventoryJoinResult {
  const observed = [
    ...request.nodeItems.map((item) => nodeObserved(item, request.proofDigests)),
    ...request.durableItems.map((item) => durableObserved(item, request.proofDigests)),
  ];
  const subjects: RecoveryReconciliationSubject[] = [];
  for (const item of observed) {
    const subject = buildSubject(item, request.restoredIntents);
    if ("ok" in subject) return subject;
    subjects.push(subject);
  }
  if (hasDuplicateSubject(subjects)) return duplicateRefusal;
  const paired = subjects.map((subject) => ({
    item: adjudicateSubject(subject, subject.class as RecoveryProofClass, request.selected),
    subject,
  }));
  paired.sort((left, right) => compareRecoveryReconciliationItems(left.item, right.item));
  return Object.freeze({
    historyInsertions: Object.freeze([]),
    items: Object.freeze(paired.map((entry) => entry.item)),
    ok: true as const,
    repeatRequests: Object.freeze([]),
    subjects: Object.freeze(paired.map((entry) => entry.subject)),
  });
}

/** Converts the runner proof without re-declaring its closed class vocabulary. */
export function nodeProofDigestMap(
  report: RecoveryInventoryReport,
): ReadonlyMap<RecoveryProofClass, string> {
  return new Map(report.proofs.map((proof) => [proof.class as RecoveryProofClass, report.inventoryDigest]));
}
