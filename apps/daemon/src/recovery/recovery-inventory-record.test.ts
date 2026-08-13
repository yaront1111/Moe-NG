import { describe, expect, it } from "vitest";

import {
  RECOVERY_CLASS_POPULATION_ROWS,
  RECOVERY_INVENTORY_DISPOSITIONS,
  RECOVERY_INVENTORY_LAYER,
  RECOVERY_INVENTORY_POPULATIONS,
  RECOVERY_INVENTORY_UPSTREAM_LAYERS,
  RECOVERY_PROOF_CLASSES,
  RECOVERY_RECONCILIATION_SCHEMA_VERSION,
  recoveryPopulationClass,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryProofClass,
  RecoveryReconciliationRecord,
} from "./recovery-inventory-contract.js";
import {
  buildRecoveryReconciliationRecord,
} from "./recovery-inventory-record.js";
import type { RecoveryReconciliationBuildInput } from "./recovery-inventory-record.js";
import {
  decodeRecoveryReconciliationRecord,
  encodeRecoveryReconciliationRecord,
} from "./recovery-inventory-codec.js";

const hex = (tag: string): string =>
  (tag.replace(/[^0-9a-f]/gu, "") + "0".repeat(64)).slice(0, 64);

const SELECTED = Object.freeze({
  anchorBindingDigest: hex("abc1"),
  incarnationRef: hex("dec2"),
  keyEpochRef: hex("efa3"),
});

const PROJECT_ID = "proj-recovery-inventory";
const PROJECT_TAG = "moe-project:proj-recovery-inventory";
const BACKUP_CURSOR = "000000000000000000042";
const BACKUP_GENERATION_DIGEST = hex("badc0ffe");

const completeProofs = (): RecoveryReconciliationBuildInput["proofs"] =>
  RECOVERY_PROOF_CLASSES.map((proofClass, index) => ({
    class: proofClass,
    sourceProofDigest: hex(`c${index}`),
    truth: "COMPLETE" as const,
    upstream: null,
  }));

/** One subject per design population, so every cardinality assertion is exact. */
const absentSubjects = (): RecoveryReconciliationBuildInput["subjects"] =>
  RECOVERY_INVENTORY_POPULATIONS.map((population, index) => ({
    class: recoveryPopulationClass(population) as string,
    evidence: { kind: "NEGATIVE_COMPLETE" as const, proofDigest: hex(`ab${index}`) },
    identity: `external-${population}`,
    population: population as string,
    sourceProofDigest: hex(`c${RECOVERY_PROOF_CLASSES.indexOf(
      recoveryPopulationClass(population) as RecoveryProofClass,
    )}`),
  }));

const baseInput = (): RecoveryReconciliationBuildInput => ({
  backupCursor: BACKUP_CURSOR,
  backupGenerationDigest: BACKUP_GENERATION_DIGEST,
  configuredClasses: [...RECOVERY_PROOF_CLASSES],
  projectId: PROJECT_ID,
  projectTag: PROJECT_TAG,
  proofs: completeProofs(),
  selected: SELECTED,
  subjects: absentSubjects(),
});

const reconciled = (input: RecoveryReconciliationBuildInput): RecoveryReconciliationRecord => {
  const result = buildRecoveryReconciliationRecord(input);
  if (!result.ok) throw new Error(`expected a record, refused ${result.upstream.code}`);
  return result.record;
};

describe("frozen class/population mapping", () => {
  it("covers the seven design populations with six hand-written proof classes", () => {
    expect(RECOVERY_PROOF_CLASSES).toHaveLength(6);
    expect(RECOVERY_INVENTORY_POPULATIONS).toHaveLength(7);
    // Hand-written here, not derived from production: a table that generated its
    // own expectation could drop a row and stay green.
    expect(RECOVERY_CLASS_POPULATION_ROWS.map((row) => [row.class, [...row.populations]]))
      .toEqual([
        ["PROVIDER_PROCESS_LAUNCH_LOCK", ["EFFECT_LOCK_WRAPPER_REGISTRATION", "PROVIDER_RUN"]],
        ["RESOURCE", ["RESOURCE"]],
        ["WORKSPACE", ["PROJECT_TAGGED_WORKSPACE"]],
        ["INTEGRATION_TARGET", ["INTEGRATION_TARGET"]],
        ["GIT_INTEGRATION_ON_DISK", ["GIT_BRANCH_REF"]],
        ["ARTIFACT_OBJECT_STAGING", ["ARTIFACT_STAGING"]],
      ]);
  });

  it("maps every population exactly once and duplicates no proof to inflate cardinality", () => {
    const flattened = RECOVERY_CLASS_POPULATION_ROWS.flatMap((row) => [...row.populations]);
    expect(flattened).toHaveLength(7);
    expect(new Set(flattened).size).toBe(7);
    expect([...flattened].sort()).toEqual([...RECOVERY_INVENTORY_POPULATIONS].sort());
    const multi = RECOVERY_CLASS_POPULATION_ROWS.filter((row) => row.populations.length > 1);
    expect(multi.map((row) => row.class)).toEqual(["PROVIDER_PROCESS_LAUNCH_LOCK"]);
  });

  it("resolves each population to its one class and refuses an unmapped name", () => {
    let resolved = 0;
    for (const population of RECOVERY_INVENTORY_POPULATIONS) {
      expect(RECOVERY_PROOF_CLASSES).toContain(recoveryPopulationClass(population));
      resolved += 1;
    }
    expect(resolved).toBe(7);
    expect(recoveryPopulationClass("PROVIDER_RUN_EXTRA")).toBeNull();
  });

  it("freezes the mapping tables against in-place edits", () => {
    expect(Object.isFrozen(RECOVERY_PROOF_CLASSES)).toBe(true);
    expect(Object.isFrozen(RECOVERY_INVENTORY_POPULATIONS)).toBe(true);
    expect(Object.isFrozen(RECOVERY_CLASS_POPULATION_ROWS)).toBe(true);
    expect(RECOVERY_CLASS_POPULATION_ROWS.every((row) => Object.isFrozen(row.populations)))
      .toBe(true);
  });
});

describe("configured class-set refusals", () => {
  it("refuses an extra class with RECOVERY_INVENTORY_CLASS_EXTRA at RECOVERY_INVENTORY", () => {
    const result = buildRecoveryReconciliationRecord({
      ...baseInput(),
      configuredClasses: [...RECOVERY_PROOF_CLASSES, "GIT_INTEGRATION_ON_DISK"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.upstream).toEqual({
      code: "RECOVERY_INVENTORY_CLASS_EXTRA",
      layer: "RECOVERY_INVENTORY",
    });
    expect(result.code).toBe("UNKNOWN_TRUTH");
    expect(result.layer).toBe("RECOVERY_INVENTORY");
    expect(result.truth).toBe("UNKNOWN");
  });

  it("refuses an unrecognised class with RECOVERY_INVENTORY_CLASS_UNKNOWN", () => {
    const classes = [...RECOVERY_PROOF_CLASSES];
    classes[2] = "SCHEDULER_RESOURCE" as RecoveryProofClass;
    const result = buildRecoveryReconciliationRecord({
      ...baseInput(),
      configuredClasses: classes,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.upstream).toEqual({
      code: "RECOVERY_INVENTORY_CLASS_UNKNOWN",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("refuses a repeated class with RECOVERY_INVENTORY_CLASS_DUPLICATE", () => {
    const classes = [...RECOVERY_PROOF_CLASSES];
    classes[5] = classes[0] as RecoveryProofClass;
    const result = buildRecoveryReconciliationRecord({
      ...baseInput(),
      configuredClasses: classes,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.upstream).toEqual({
      code: "RECOVERY_INVENTORY_CLASS_DUPLICATE",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("refuses each singly omitted class with RECOVERY_INVENTORY_CLASS_OMITTED", () => {
    let swept = 0;
    for (const dropped of RECOVERY_PROOF_CLASSES) {
      const result = buildRecoveryReconciliationRecord({
        ...baseInput(),
        configuredClasses: RECOVERY_PROOF_CLASSES.filter((entry) => entry !== dropped),
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.upstream).toEqual({
        code: "RECOVERY_INVENTORY_CLASS_OMITTED",
        layer: "RECOVERY_INVENTORY",
      });
      swept += 1;
    }
    // A sweep that silently produces zero cases passes while testing nothing.
    expect(swept).toBe(6);
  });

  it("refuses a subject whose population does not belong to its declared class", () => {
    const subjects = absentSubjects().map((subject, index) =>
      index === 0 ? { ...subject, class: "WORKSPACE" } : subject,
    );
    const result = buildRecoveryReconciliationRecord({ ...baseInput(), subjects });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.upstream).toEqual({
      code: "RECOVERY_INVENTORY_POPULATION_UNMAPPED",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("refuses two subjects sharing one class-scoped identity", () => {
    const subjects = [...absentSubjects()];
    const first = subjects[0];
    if (first === undefined) throw new Error("fixture must carry subjects");
    subjects.push({ ...first });
    const result = buildRecoveryReconciliationRecord({ ...baseInput(), subjects });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.upstream).toEqual({
      code: "RECOVERY_INVENTORY_SUBJECT_DUPLICATE",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("refuses a hostile input whose field is an accessor rather than data", () => {
    const hostile = { ...baseInput() };
    Object.defineProperty(hostile, "projectId", { enumerable: true, get: () => PROJECT_ID });
    const result = buildRecoveryReconciliationRecord(hostile);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.upstream).toEqual({
      code: "RECOVERY_INVENTORY_INPUT_INVALID",
      layer: "RECOVERY_INVENTORY",
    });
  });
});

describe("dispositions", () => {
  it("declares exactly the five canonical dispositions", () => {
    expect([...RECOVERY_INVENTORY_DISPOSITIONS])
      .toEqual(["ABSENT", "CANCELLED", "ADOPTED", "QUARANTINED", "UNKNOWN"]);
    expect([...RECOVERY_INVENTORY_UPSTREAM_LAYERS])
      .toEqual(["RECOVERY_INVENTORY", "RECOVERY_INVENTORY_LEDGER", "INVENTORY_ADAPTER"]);
  });

  it("marks a complete negative proof ABSENT and keeps the whole record COMPLETE", () => {
    const record = reconciled(baseInput());
    expect(record.items).toHaveLength(7);
    expect(record.items.map((item) => item.disposition))
      .toEqual(["ABSENT", "ABSENT", "ABSENT", "ABSENT", "ABSENT", "ABSENT", "ABSENT"]);
    expect(record.truth).toBe("COMPLETE");
    expect(record.coordinator).toBeNull();
    expect(record.upstream).toBeNull();
    expect(record.schemaVersion).toBe(RECOVERY_RECONCILIATION_SCHEMA_VERSION);
  });

  it("marks terminal cancellation proof CANCELLED and grants no retry authority", () => {
    const subjects = absentSubjects().map((subject, index) =>
      index === 1
        ? { ...subject, evidence: { kind: "TERMINAL_CANCELLED" as const, proofDigest: hex("ca11") } }
        : subject,
    );
    const record = reconciled({ ...baseInput(), subjects });
    const cancelled = record.items.filter((item) => item.disposition === "CANCELLED");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.terminalProofDigest).toBe(hex("ca11"));
    expect(cancelled[0]?.restoredIntentRef).toBeNull();
    expect(record.truth).toBe("COMPLETE");
  });

  it("adopts only when identity, incarnation and key epoch all match exactly", () => {
    const subjects = absentSubjects().map((subject, index) =>
      index === 2
        ? {
            ...subject,
            evidence: {
              externalIdentity: subject.identity,
              incarnationRef: SELECTED.incarnationRef,
              intentDigest: hex("d0e5"),
              intentRef: "intent-2",
              keyEpochRef: SELECTED.keyEpochRef,
              kind: "RESTORED_INTENT" as const,
            },
          }
        : subject,
    );
    const record = reconciled({ ...baseInput(), subjects });
    const adopted = record.items.filter((item) => item.disposition === "ADOPTED");
    expect(adopted).toHaveLength(1);
    expect(adopted[0]?.restoredIntentRef).toBe("intent-2");
    expect(adopted[0]?.restoredIntentDigest).toBe(hex("d0e5"));
    expect(adopted[0]?.quarantineRef).toBeNull();
    expect(adopted[0]?.upstream).toBeNull();
  });

  it("quarantines each single adoption deviation with its own upstream code", () => {
    const deviations: readonly (readonly [string, Record<string, string>])[] = [
      ["RECOVERY_INVENTORY_ADOPTION_IDENTITY_MISMATCH", { externalIdentity: "external-other" }],
      ["RECOVERY_INVENTORY_ADOPTION_INCARNATION_STALE", { incarnationRef: hex("5ta1e") }],
      ["RECOVERY_INVENTORY_ADOPTION_KEY_EPOCH_STALE", { keyEpochRef: hex("01dkey") }],
    ];
    let swept = 0;
    for (const [code, override] of deviations) {
      const subjects = absentSubjects().map((subject, index) =>
        index === 2
          ? {
              ...subject,
              evidence: {
                externalIdentity: subject.identity,
                incarnationRef: SELECTED.incarnationRef,
                intentDigest: hex("d0e5"),
                intentRef: "intent-2",
                keyEpochRef: SELECTED.keyEpochRef,
                kind: "RESTORED_INTENT" as const,
                ...override,
              },
            }
          : subject,
      );
      const record = reconciled({ ...baseInput(), subjects });
      const quarantined = record.items.filter((item) => item.disposition === "QUARANTINED");
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]?.upstream).toEqual({ code, layer: "RECOVERY_INVENTORY" });
      expect(quarantined[0]?.restoredIntentRef).toBeNull();
      expect(record.truth).toBe("COMPLETE");
      swept += 1;
    }
    expect(swept).toBe(3);
  });

  it("quarantines an orphan and keeps its quarantine ref on the item", () => {
    const subjects = absentSubjects().map((subject, index) =>
      index === 3
        ? { ...subject, evidence: { kind: "ORPHAN" as const, quarantineRef: "quarantine-3" } }
        : subject,
    );
    const record = reconciled({ ...baseInput(), subjects });
    const quarantined = record.items.filter((item) => item.disposition === "QUARANTINED");
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.quarantineRef).toBe("quarantine-3");
  });

  it("normalises an unresolved item to UNKNOWN truth while retaining its upstream tuple", () => {
    const subjects = absentSubjects().map((subject, index) =>
      index === 4
        ? {
            ...subject,
            evidence: {
              kind: "UNRESOLVED" as const,
              upstream: {
                code: "RECOVERY_INVENTORY_COVERAGE_UNKNOWN" as const,
                layer: "INVENTORY_ADAPTER" as const,
              },
            },
          }
        : subject,
    );
    const record = reconciled({ ...baseInput(), subjects });
    const unknown = record.items.filter((item) => item.disposition === "UNKNOWN");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.upstream).toEqual({
      code: "RECOVERY_INVENTORY_COVERAGE_UNKNOWN",
      layer: "INVENTORY_ADAPTER",
    });
    expect(record.truth).toBe("UNKNOWN");
    expect(record.coordinator).toEqual({ code: "UNKNOWN_TRUTH", layer: "RECOVERY_INVENTORY" });
    expect(record.upstream).toEqual({
      code: "RECOVERY_INVENTORY_ITEM_UNRESOLVED",
      layer: "RECOVERY_INVENTORY",
    });
  });
});

describe("configured proof coverage", () => {
  it("fills a missing configured proof with an UNKNOWN slot instead of shrinking the mapping", () => {
    const record = reconciled({
      ...baseInput(),
      proofs: completeProofs().filter((proof) => proof.class !== "RESOURCE"),
      subjects: absentSubjects().filter((subject) => subject.population !== "RESOURCE"),
    });
    expect(record.proofs).toHaveLength(6);
    expect(record.proofs.map((proof) => proof.class)).toEqual([...RECOVERY_PROOF_CLASSES]);
    const resource = record.proofs.find((proof) => proof.class === "RESOURCE");
    expect(resource?.truth).toBe("UNKNOWN");
    expect(resource?.sourceProofDigest).toBe("0".repeat(64));
    expect(resource?.upstream).toEqual({
      code: "RECOVERY_INVENTORY_PROOF_MISSING",
      layer: "RECOVERY_INVENTORY",
    });
    expect(record.truth).toBe("UNKNOWN");
    expect(record.coordinator).toEqual({ code: "UNKNOWN_TRUTH", layer: "RECOVERY_INVENTORY" });
  });

  it("keeps an UNKNOWN configured proof UNKNOWN and never synthesises COMPLETE coverage", () => {
    const proofs = completeProofs().map((proof) =>
      proof.class === "INTEGRATION_TARGET"
        ? {
            ...proof,
            truth: "UNKNOWN" as const,
            upstream: {
              code: "RECOVERY_INVENTORY_COVERAGE_UNKNOWN" as const,
              layer: "INVENTORY_ADAPTER" as const,
            },
          }
        : proof,
    );
    const record = reconciled({ ...baseInput(), proofs });
    const integration = record.proofs.find((proof) => proof.class === "INTEGRATION_TARGET");
    expect(integration?.truth).toBe("UNKNOWN");
    expect(integration?.upstream).toEqual({
      code: "RECOVERY_INVENTORY_COVERAGE_UNKNOWN",
      layer: "INVENTORY_ADAPTER",
    });
    expect(record.truth).toBe("UNKNOWN");
    expect(record.upstream).toEqual({
      code: "RECOVERY_INVENTORY_PROOF_INCOMPLETE",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("counts items per class against the frozen population rows", () => {
    const record = reconciled(baseInput());
    const provider = record.proofs.find((p) => p.class === "PROVIDER_PROCESS_LAUNCH_LOCK");
    expect(provider?.itemCount).toBe(2);
    expect([...(provider?.populations ?? [])])
      .toEqual(["EFFECT_LOCK_WRAPPER_REGISTRATION", "PROVIDER_RUN"]);
    expect(record.proofs.reduce((total, proof) => total + proof.itemCount, 0)).toBe(7);
  });
});

describe("record binding and freeze", () => {
  it("binds project, backup cursor/generation and the selected recovery refs", () => {
    const record = reconciled(baseInput());
    expect(record.projectId).toBe(PROJECT_ID);
    expect(record.projectTag).toBe(PROJECT_TAG);
    expect(record.backupCursor).toBe(BACKUP_CURSOR);
    expect(record.backupGenerationDigest).toBe(BACKUP_GENERATION_DIGEST);
    expect(record.incarnationRef).toBe(SELECTED.incarnationRef);
    expect(record.keyEpochRef).toBe(SELECTED.keyEpochRef);
    expect(record.anchorBindingDigest).toBe(SELECTED.anchorBindingDigest);
    expect(record.recordDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("deep-freezes the record and never freezes or mutates the caller's input", () => {
    const input = baseInput();
    const record = reconciled(input);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.items)).toBe(true);
    expect(record.items.every((item) => Object.isFrozen(item))).toBe(true);
    expect(record.proofs.every((proof) => Object.isFrozen(proof.populations))).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.subjects)).toBe(false);
  });

  it("changes the record digest for every bound body field", () => {
    const baseline = reconciled(baseInput()).recordDigest;
    const mutations: readonly (readonly [string, RecoveryReconciliationBuildInput])[] = [
      ["projectId", { ...baseInput(), projectId: "proj-other" }],
      ["projectTag", { ...baseInput(), projectTag: "moe-project:other" }],
      ["backupCursor", { ...baseInput(), backupCursor: "000000000000000000043" }],
      ["backupGenerationDigest", { ...baseInput(), backupGenerationDigest: hex("dead") }],
      ["incarnationRef", {
        ...baseInput(),
        selected: { ...SELECTED, incarnationRef: hex("beef") },
      }],
      ["keyEpochRef", { ...baseInput(), selected: { ...SELECTED, keyEpochRef: hex("face") } }],
      ["anchorBindingDigest", {
        ...baseInput(),
        selected: { ...SELECTED, anchorBindingDigest: hex("cafe") },
      }],
      ["items", {
        ...baseInput(),
        subjects: absentSubjects().slice(0, 6),
      }],
      // A proof digest cannot be moved ALONE any more: an item must cite the
      // digest of its own class proof, so the two move together by design.
      ["proofs", {
        ...baseInput(),
        proofs: completeProofs().map((proof, index) =>
          index === 0 ? { ...proof, sourceProofDigest: hex("999") } : proof,
        ),
        subjects: absentSubjects().map((subject) =>
          subject.class === "PROVIDER_PROCESS_LAUNCH_LOCK"
            ? { ...subject, sourceProofDigest: hex("999") }
            : subject,
        ),
      }],
    ];
    let swept = 0;
    for (const [field, mutated] of mutations) {
      expect(`${field}:${reconciled(mutated).recordDigest}`).not.toBe(`${field}:${baseline}`);
      swept += 1;
    }
    expect(swept).toBe(9);
  });

  it("is deterministic for the same facts supplied in a different subject order", () => {
    const forward = reconciled(baseInput());
    const reversed = reconciled({ ...baseInput(), subjects: [...absentSubjects()].reverse() });
    expect(reversed.recordDigest).toBe(forward.recordDigest);
    expect(reversed.items.map((item) => item.identity))
      .toEqual(forward.items.map((item) => item.identity));
  });
});

describe("canonical codec", () => {
  it("round-trips a record through exact canonical bytes", () => {
    const record = reconciled(baseInput());
    const bytes = encodeRecoveryReconciliationRecord(record);
    const decoded = decodeRecoveryReconciliationRecord(bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("unreachable");
    expect(decoded.record).toEqual(record);
    expect(encodeRecoveryReconciliationRecord(decoded.record)).toEqual(bytes);
  });

  it("refuses non-canonical byte variants of an otherwise valid record", () => {
    const record = reconciled(baseInput());
    const text = new TextDecoder().decode(encodeRecoveryReconciliationRecord(record));
    const variants: readonly (readonly [string, string])[] = [
      ["whitespace", text.replace('{"', '{ "')],
      ["key-order", `{"projectId":${JSON.stringify(record.projectId)},${text.slice(1)}`],
      ["duplicate-key", `{"schemaVersion":"moe-recovery-reconciliation/1",${text.slice(1)}`],
      ["extension", `${text.slice(0, -1)},"extra":1}`],
      ["truncation", text.slice(0, text.length - 12)],
    ];
    let swept = 0;
    for (const [name, variant] of variants) {
      const decoded = decodeRecoveryReconciliationRecord(new TextEncoder().encode(variant));
      expect(`${name}:${decoded.ok}`).toBe(`${name}:false`);
      if (decoded.ok) throw new Error("unreachable");
      expect(decoded.code).toBe("UNKNOWN_TRUTH");
      expect(decoded.layer).toBe(RECOVERY_INVENTORY_LAYER);
      expect(decoded.upstream.layer).toBe("RECOVERY_INVENTORY");
      swept += 1;
    }
    expect(swept).toBe(5);
  });

  it("refuses a semantic byte mutation with RECOVERY_INVENTORY_RECORD_DIGEST_MISMATCH", () => {
    const record = reconciled(baseInput());
    const text = new TextDecoder().decode(encodeRecoveryReconciliationRecord(record));
    const tampered = text.replace(`"${PROJECT_TAG}"`, '"moe-project:tampered"');
    expect(tampered).not.toBe(text);
    const decoded = decodeRecoveryReconciliationRecord(new TextEncoder().encode(tampered));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("unreachable");
    expect(decoded.upstream).toEqual({
      code: "RECOVERY_INVENTORY_RECORD_DIGEST_MISMATCH",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("refuses invalid UTF-8 and empty bytes with RECOVERY_INVENTORY_RECORD_UNREADABLE", () => {
    let swept = 0;
    for (const bytes of [new Uint8Array([0xff, 0xfe, 0xfd]), new Uint8Array(0)]) {
      const decoded = decodeRecoveryReconciliationRecord(bytes);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) throw new Error("unreachable");
      expect(decoded.upstream).toEqual({
        code: "RECOVERY_INVENTORY_RECORD_UNREADABLE",
        layer: "RECOVERY_INVENTORY",
      });
      swept += 1;
    }
    expect(swept).toBe(2);
  });

  it("refuses a decoded record whose class mapping no longer matches the frozen rows", () => {
    const record = reconciled(baseInput());
    const text = new TextDecoder().decode(encodeRecoveryReconciliationRecord(record));
    // Targets the proofs row's populations array specifically: the same name
    // also appears as an item's `population`, and deleting THAT would only
    // produce broken JSON, which a weaker guard would answer first.
    expect(text.split(',"PROVIDER_RUN"]')).toHaveLength(2);
    const stripped = text.replace(',"PROVIDER_RUN"]', "]");
    const decoded = decodeRecoveryReconciliationRecord(new TextEncoder().encode(stripped));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("unreachable");
    expect(decoded.upstream).toEqual({
      code: "RECOVERY_INVENTORY_RECORD_NONCANONICAL",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("serialises no field outside the frozen record key set", () => {
    const record = reconciled(baseInput());
    const parsed = JSON.parse(
      new TextDecoder().decode(encodeRecoveryReconciliationRecord(record)),
    ) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion",
      "projectId",
      "projectTag",
      "backupCursor",
      "backupGenerationDigest",
      "incarnationRef",
      "keyEpochRef",
      "anchorBindingDigest",
      "configuredClasses",
      "proofs",
      "items",
      "truth",
      "coordinator",
      "upstream",
      "recordDigest",
    ]);
  });
});
