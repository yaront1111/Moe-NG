import {
  MAX_RECOVERY_RECONCILIATION_ITEMS,
  MAX_RECOVERY_RECONCILIATION_TEXT_CHARS,
  RECOVERY_INVENTORY_UPSTREAM_CODES,
  RECOVERY_INVENTORY_UPSTREAM_LAYERS,
  exactDataRecord,
  isPlainArray,
  isReflectableObject,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryInventoryPopulation,
  RecoveryInventoryTruth,
  RecoveryInventoryUpstream,
  RecoveryProofClass,
  RecoveryReconciliationItem,
} from "./recovery-inventory-contract.js";

/**
 * Hostile-input readers for one reconciliation subject, plus the single
 * adjudication rule that turns its evidence into a disposition. Split from
 * `recovery-inventory-record.ts` to hold the per-file target: that module owns
 * assembly and ordering, this one owns "is this even a subject, and what does
 * its evidence prove". The record module re-publishes every type here.
 */
export interface RecoveryReconciliationSelectedRefs {
  readonly anchorBindingDigest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
}

export type RecoverySubjectEvidence =
  | { readonly kind: "NEGATIVE_COMPLETE"; readonly proofDigest: string }
  | { readonly kind: "TERMINAL_CANCELLED"; readonly proofDigest: string }
  | {
      readonly kind: "RESTORED_INTENT"; readonly externalIdentity: string;
      readonly incarnationRef: string; readonly intentDigest: string;
      readonly intentRef: string; readonly keyEpochRef: string;
    }
  | { readonly kind: "ORPHAN"; readonly quarantineRef: string }
  | { readonly kind: "UNRESOLVED"; readonly upstream: RecoveryInventoryUpstream };

export interface RecoveryReconciliationSubject {
  readonly class: string;
  readonly evidence: RecoverySubjectEvidence;
  readonly identity: string;
  readonly population: string;
  readonly sourceProofDigest: string;
}

export interface RecoveryConfiguredProof {
  readonly class: string;
  readonly sourceProofDigest: string;
  readonly truth: RecoveryInventoryTruth;
  readonly upstream: RecoveryInventoryUpstream | null;
}

export interface RecoveryReconciliationBuildInput {
  readonly backupCursor: string;
  readonly backupGenerationDigest: string;
  readonly configuredClasses: readonly string[];
  readonly projectId: string;
  readonly projectTag: string;
  readonly proofs: readonly RecoveryConfiguredProof[];
  readonly selected: RecoveryReconciliationSelectedRefs;
  readonly subjects: readonly RecoveryReconciliationSubject[];
}

const HEX64 = /^[0-9a-f]{64}$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;

const isHex64 = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);

const isText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_RECOVERY_RECONCILIATION_TEXT_CHARS &&
  !UNSAFE_TEXT.test(value) &&
  value.normalize("NFC") === value;

const EVIDENCE_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  NEGATIVE_COMPLETE: ["kind", "proofDigest"],
  ORPHAN: ["kind", "quarantineRef"],
  RESTORED_INTENT: ["externalIdentity", "incarnationRef", "intentDigest", "intentRef",
    "keyEpochRef", "kind"],
  TERMINAL_CANCELLED: ["kind", "proofDigest"],
  UNRESOLVED: ["kind", "upstream"],
});

function readUpstream(value: unknown): RecoveryInventoryUpstream | null {
  const raw = exactDataRecord(value, ["code", "layer"]);
  if (raw === null) return null;
  const code = raw["code"];
  const layer = raw["layer"];
  if (typeof code !== "string" || !(RECOVERY_INVENTORY_UPSTREAM_CODES as readonly string[]).includes(code)) {
    return null;
  }
  if (typeof layer !== "string" || !(RECOVERY_INVENTORY_UPSTREAM_LAYERS as readonly string[]).includes(layer)) {
    return null;
  }
  return Object.freeze({
    code: code as RecoveryInventoryUpstream["code"],
    layer: layer as RecoveryInventoryUpstream["layer"],
  });
}

function readEvidence(value: unknown): RecoverySubjectEvidence | null {
  // Proxy-ness first: the `kind` peek below is itself a reflective read, so a
  // trap here would run before `exactDataRecord` ever got the chance to refuse.
  if (!isReflectableObject(value)) return null;
  const kind: unknown = Object.getOwnPropertyDescriptor(value, "kind")?.value;
  if (typeof kind !== "string") return null;
  const keys = EVIDENCE_KEYS[kind];
  if (keys === undefined) return null;
  const raw = exactDataRecord(value, keys);
  if (raw === null) return null;
  if (kind === "NEGATIVE_COMPLETE" || kind === "TERMINAL_CANCELLED") {
    if (!isHex64(raw["proofDigest"])) return null;
    return Object.freeze({ kind, proofDigest: raw["proofDigest"] });
  }
  if (kind === "ORPHAN") {
    if (!isText(raw["quarantineRef"])) return null;
    return Object.freeze({ kind, quarantineRef: raw["quarantineRef"] });
  }
  if (kind === "UNRESOLVED") {
    const upstream = readUpstream(raw["upstream"]);
    return upstream === null ? null : Object.freeze({ kind, upstream });
  }
  if (!isText(raw["externalIdentity"]) || !isText(raw["intentRef"])) return null;
  if (!isHex64(raw["incarnationRef"]) || !isHex64(raw["keyEpochRef"])) return null;
  if (!isHex64(raw["intentDigest"])) return null;
  return Object.freeze({
    externalIdentity: raw["externalIdentity"],
    incarnationRef: raw["incarnationRef"],
    intentDigest: raw["intentDigest"],
    intentRef: raw["intentRef"],
    keyEpochRef: raw["keyEpochRef"],
    kind: "RESTORED_INTENT" as const,
  });
}

const SUBJECT_KEYS = Object.freeze(["class", "evidence", "identity", "population",
  "sourceProofDigest"]);

function readSubject(value: unknown): RecoveryReconciliationSubject | null {
  const raw = exactDataRecord(value, SUBJECT_KEYS);
  if (raw === null) return null;
  if (!isText(raw["class"]) || !isText(raw["identity"]) || !isText(raw["population"])) return null;
  if (!isHex64(raw["sourceProofDigest"])) return null;
  const evidence = readEvidence(raw["evidence"]);
  if (evidence === null) return null;
  return Object.freeze({
    class: raw["class"],
    evidence,
    identity: raw["identity"],
    population: raw["population"],
    sourceProofDigest: raw["sourceProofDigest"],
  });
}

const PROOF_KEYS = Object.freeze(["class", "sourceProofDigest", "truth", "upstream"]);

function readProof(value: unknown): RecoveryConfiguredProof | null {
  const raw = exactDataRecord(value, PROOF_KEYS);
  if (raw === null) return null;
  const truth = raw["truth"];
  if (truth !== "COMPLETE" && truth !== "UNKNOWN") return null;
  if (!isText(raw["class"]) || !isHex64(raw["sourceProofDigest"])) return null;
  const upstream = raw["upstream"] === null ? null : readUpstream(raw["upstream"]);
  if (raw["upstream"] !== null && upstream === null) return null;
  return Object.freeze({
    class: raw["class"],
    sourceProofDigest: raw["sourceProofDigest"],
    truth,
    upstream,
  });
}

const readArray = <Item>(
  value: unknown,
  read: (entry: unknown) => Item | null,
): readonly Item[] | null => {
  if (!isPlainArray(value) || value.length > MAX_RECOVERY_RECONCILIATION_ITEMS) return null;
  const out: Item[] = [];
  for (const entry of value) {
    const item = read(entry);
    if (item === null) return null;
    out.push(item);
  }
  return Object.freeze(out);
};

/** Reads the already key-checked outer record into fully validated values. */
export function snapshotBuildInput(
  raw: Readonly<Record<string, unknown>>,
): RecoveryReconciliationBuildInput | null {
  const selected = exactDataRecord(raw["selected"], [
    "anchorBindingDigest",
    "incarnationRef",
    "keyEpochRef",
  ]);
  if (selected === null) return null;
  if (!isHex64(selected["anchorBindingDigest"])) return null;
  if (!isHex64(selected["incarnationRef"]) || !isHex64(selected["keyEpochRef"])) return null;
  if (!isText(raw["projectId"]) || !isText(raw["projectTag"])) return null;
  if (!isText(raw["backupCursor"]) || !isHex64(raw["backupGenerationDigest"])) return null;
  const configuredClasses = readArray(raw["configuredClasses"], (entry) =>
    isText(entry) ? entry : null,
  );
  const proofs = readArray(raw["proofs"], readProof);
  const subjects = readArray(raw["subjects"], readSubject);
  if (configuredClasses === null || proofs === null || subjects === null) return null;
  return Object.freeze({
    backupCursor: raw["backupCursor"],
    backupGenerationDigest: raw["backupGenerationDigest"],
    configuredClasses,
    projectId: raw["projectId"],
    projectTag: raw["projectTag"],
    proofs,
    selected: Object.freeze({
      anchorBindingDigest: selected["anchorBindingDigest"],
      incarnationRef: selected["incarnationRef"],
      keyEpochRef: selected["keyEpochRef"],
    }),
    subjects,
  });
}

const item = (
  subject: RecoveryReconciliationSubject,
  mapped: RecoveryProofClass,
  fields: Partial<RecoveryReconciliationItem>,
): RecoveryReconciliationItem =>
  Object.freeze({
    class: mapped,
    disposition: "UNKNOWN" as const,
    identity: subject.identity,
    population: subject.population as RecoveryInventoryPopulation,
    quarantineRef: null,
    restoredIntentDigest: null,
    restoredIntentRef: null,
    sourceProofDigest: subject.sourceProofDigest,
    terminalProofDigest: null,
    upstream: null,
    ...fields,
  });

/**
 * The whole adoption rule, in one place. ADOPTED requires the restored intent
 * to name this exact external identity AND to have been restored under BOTH
 * currently selected recovery refs; anything else can only quarantine. No arm
 * invents history, and none returns a retry.
 */
export function adjudicateSubject(
  subject: RecoveryReconciliationSubject,
  mapped: RecoveryProofClass,
  selected: RecoveryReconciliationSelectedRefs,
): RecoveryReconciliationItem {
  const evidence = subject.evidence;
  if (evidence.kind === "NEGATIVE_COMPLETE") {
    return item(subject, mapped, {
      disposition: "ABSENT",
      terminalProofDigest: evidence.proofDigest,
    });
  }
  if (evidence.kind === "TERMINAL_CANCELLED") {
    return item(subject, mapped, {
      disposition: "CANCELLED",
      terminalProofDigest: evidence.proofDigest,
    });
  }
  if (evidence.kind === "ORPHAN") {
    return item(subject, mapped, {
      disposition: "QUARANTINED",
      quarantineRef: evidence.quarantineRef,
    });
  }
  if (evidence.kind === "UNRESOLVED") {
    return item(subject, mapped, { disposition: "UNKNOWN", upstream: evidence.upstream });
  }
  const code =
    evidence.externalIdentity !== subject.identity
      ? "RECOVERY_INVENTORY_ADOPTION_IDENTITY_MISMATCH"
      : evidence.incarnationRef !== selected.incarnationRef
        ? "RECOVERY_INVENTORY_ADOPTION_INCARNATION_STALE"
        : evidence.keyEpochRef !== selected.keyEpochRef
          ? "RECOVERY_INVENTORY_ADOPTION_KEY_EPOCH_STALE"
          : null;
  if (code !== null) {
    return item(subject, mapped, {
      disposition: "QUARANTINED",
      upstream: Object.freeze({ code, layer: "RECOVERY_INVENTORY" as const }),
    });
  }
  return item(subject, mapped, {
    disposition: "ADOPTED",
    restoredIntentDigest: evidence.intentDigest,
    restoredIntentRef: evidence.intentRef,
  });
}
