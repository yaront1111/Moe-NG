import { describe, expect, it } from "vitest";

import {
  RECOVERY_INVENTORY_DISPOSITIONS,
  RECOVERY_INVENTORY_LAYER,
  RECOVERY_INVENTORY_POPULATIONS,
  RECOVERY_PROOF_CLASSES,
  RECOVERY_UNKNOWN_PROOF_DIGEST,
  recoveryPopulationClass,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryInventoryDisposition,
  RecoveryProofClass,
  RecoveryReconciliationItem,
  RecoveryReconciliationRecord,
} from "./recovery-inventory-contract.js";
import {
  decodeRecoveryReconciliationRecord,
  encodeRecoveryReconciliationRecord,
  recoveryReconciliationDigest,
} from "./recovery-inventory-codec.js";
import { buildRecoveryReconciliationRecord } from "./recovery-inventory-record.js";
import type {
  RecoverySubjectEvidence,
  RecoveryReconciliationBuildInput,
} from "./recovery-inventory-record.js";

/**
 * Reopen #2 regressions: SELF-CONSISTENT hostile bytes.
 *
 * Every case below mutates one semantic invariant, recomputes `recordDigest`
 * with the PRODUCTION digest surface, and re-encodes with the PRODUCTION
 * encoder. The bytes are therefore canonical and correctly digested, so neither
 * `RECORD_DIGEST_MISMATCH` nor the byte re-encode guard can answer: the only
 * thing that can refuse is the decoder independently re-deriving what the
 * builder enforced. A byte-tamper test that leaves the stale digest behind is
 * exactly the test that let these six forgeries ship green twice.
 */
const hex = (tag: string): string =>
  (tag.replace(/[^0-9a-f]/gu, "") + "0".repeat(64)).slice(0, 64);

const SELECTED = Object.freeze({
  anchorBindingDigest: hex("abc1"),
  incarnationRef: hex("dec2"),
  keyEpochRef: hex("efa3"),
});

const ADAPTER_UNKNOWN = Object.freeze({
  code: "RECOVERY_INVENTORY_COVERAGE_UNKNOWN" as const,
  layer: "INVENTORY_ADAPTER" as const,
});

const INCOHERENT = Object.freeze({
  code: "RECOVERY_INVENTORY_RECORD_INCOHERENT",
  layer: "RECOVERY_INVENTORY",
});

const classOf = (population: string): RecoveryProofClass =>
  recoveryPopulationClass(population) as RecoveryProofClass;

const classDigest = (population: string): string =>
  hex(`c${RECOVERY_PROOF_CLASSES.indexOf(classOf(population))}`);

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
    class: classOf(population) as string,
    evidence: { kind: "NEGATIVE_COMPLETE" as const, proofDigest: hex(`ab${index}`) },
    identity: `external-${population}`,
    population: population as string,
    sourceProofDigest: classDigest(population),
  }));

const baseInput = (): RecoveryReconciliationBuildInput => ({
  backupCursor: "000000000000000000042",
  backupGenerationDigest: hex("badc0ffe"),
  configuredClasses: [...RECOVERY_PROOF_CLASSES],
  projectId: "proj-recovery-inventory",
  projectTag: "moe-project:proj-recovery-inventory",
  proofs: completeProofs(),
  selected: SELECTED,
  subjects: absentSubjects(),
});

/** Swaps the evidence of the single-item WORKSPACE subject (population index 3). */
const withEvidence = (evidence: RecoverySubjectEvidence): RecoveryReconciliationBuildInput => ({
  ...baseInput(),
  subjects: absentSubjects().map((subject, index) =>
    index === 3 ? { ...subject, evidence } : subject,
  ),
});

const reconciled = (input: RecoveryReconciliationBuildInput): RecoveryReconciliationRecord => {
  const result = buildRecoveryReconciliationRecord(input);
  if (!result.ok) throw new Error(`expected a record, refused ${result.upstream.code}`);
  return result.record;
};

/** Production digest over the forged body, then the production encoder. */
const seal = (record: RecoveryReconciliationRecord): Uint8Array =>
  encodeRecoveryReconciliationRecord({
    ...record,
    recordDigest: recoveryReconciliationDigest(record),
  });

const refusedBytes = (
  record: RecoveryReconciliationRecord,
): { readonly code: string; readonly layer: string } => {
  const decoded = decodeRecoveryReconciliationRecord(seal(record));
  if (decoded.ok) throw new Error("expected the decoder to refuse the forged record");
  expect(decoded.code).toBe("UNKNOWN_TRUTH");
  expect(decoded.layer).toBe(RECOVERY_INVENTORY_LAYER);
  // The whole point of re-sealing: if this fires, the digest guard shadowed the
  // semantic guard and the case proves nothing about the invariant under test.
  expect(decoded.upstream.code).not.toBe("RECOVERY_INVENTORY_RECORD_DIGEST_MISMATCH");
  return { code: decoded.upstream.code, layer: decoded.upstream.layer };
};

const patchItem = (
  record: RecoveryReconciliationRecord,
  at: number,
  patch: Partial<RecoveryReconciliationItem>,
): RecoveryReconciliationRecord => ({
  ...record,
  items: record.items.map((item, index) => (index === at ? { ...item, ...patch } : item)),
});

const indexOfDisposition = (
  record: RecoveryReconciliationRecord,
  disposition: RecoveryInventoryDisposition,
): number => {
  const at = record.items.findIndex((item) => item.disposition === disposition);
  if (at < 0) throw new Error(`fixture must carry a ${disposition} item`);
  return at;
};

describe("the re-seal machine itself produces acceptable bytes", () => {
  it("decodes an untouched re-sealed record, so every refusal below is the forgery", () => {
    const record = reconciled(baseInput());
    const decoded = decodeRecoveryReconciliationRecord(seal(record));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("unreachable");
    expect(decoded.record.recordDigest).toBe(record.recordDigest);
    expect(decoded.record.truth).toBe("COMPLETE");
    expect(decoded.record.items).toHaveLength(7);
    expect(decoded.record.proofs).toHaveLength(6);
  });
});

describe("record truth is re-derived from its own children", () => {
  it("refuses a child proof UNKNOWN under record truth COMPLETE", () => {
    const record = reconciled(baseInput());
    expect(record.truth).toBe("COMPLETE");
    const proofs = record.proofs.map((proof, index) =>
      index === 1 ? { ...proof, truth: "UNKNOWN" as const, upstream: ADAPTER_UNKNOWN } : proof,
    );
    expect(refusedBytes({ ...record, proofs })).toEqual(INCOHERENT);
  });

  it("refuses truth COMPLETE while the retained code already admits an incomplete proof", () => {
    // Isolates the truth comparison. The forged record keeps the upstream code
    // the derivation would produce, so the upstream guard agrees and stays
    // silent; only recomputing TRUTH itself can refuse. Without this case a
    // mutation drill that deletes the truth check stays green, because the
    // neighbouring upstream check answers for it.
    const record = reconciled(baseInput());
    const forged = {
      ...record,
      coordinator: null,
      proofs: record.proofs.map((proof, index) =>
        index === 1 ? { ...proof, truth: "UNKNOWN" as const, upstream: ADAPTER_UNKNOWN } : proof,
      ),
      truth: "COMPLETE" as const,
      upstream: {
        code: "RECOVERY_INVENTORY_PROOF_INCOMPLETE" as const,
        layer: "RECOVERY_INVENTORY" as const,
      },
    };
    expect(refusedBytes(forged)).toEqual(INCOHERENT);
  });

  it("refuses an item UNKNOWN under record truth COMPLETE", () => {
    const record = reconciled(baseInput());
    const forged = patchItem(record, 0, {
      disposition: "UNKNOWN",
      terminalProofDigest: null,
      upstream: ADAPTER_UNKNOWN,
    });
    expect(refusedBytes(forged)).toEqual(INCOHERENT);
  });

  it("refuses a record whose retained upstream code contradicts its own children", () => {
    // Truth UNKNOWN is honest here; the CODE is the forgery. An unresolved item
    // must answer ITEM_UNRESOLVED, never the proof-side code.
    const record = reconciled(withEvidence({ kind: "UNRESOLVED", upstream: ADAPTER_UNKNOWN }));
    expect(record.truth).toBe("UNKNOWN");
    expect(record.upstream).toEqual({
      code: "RECOVERY_INVENTORY_ITEM_UNRESOLVED",
      layer: "RECOVERY_INVENTORY",
    });
    const forged = {
      ...record,
      upstream: {
        code: "RECOVERY_INVENTORY_PROOF_INCOMPLETE" as const,
        layer: "RECOVERY_INVENTORY" as const,
      },
    };
    expect(refusedBytes(forged)).toEqual(INCOHERENT);
  });
});

describe("the reserved no-proof slot can never claim evidence", () => {
  const unbacked = (): RecoveryReconciliationRecord =>
    reconciled({
      ...baseInput(),
      proofs: completeProofs().filter((proof) => proof.class !== "RESOURCE"),
      subjects: absentSubjects().filter((subject) => subject.population !== "RESOURCE"),
    });

  it("refuses the sentinel digest presented as a COMPLETE proof", () => {
    const record = unbacked();
    const sentinel = record.proofs.find((proof) => proof.class === "RESOURCE");
    expect(sentinel?.sourceProofDigest).toBe(RECOVERY_UNKNOWN_PROOF_DIGEST);
    expect(sentinel?.itemCount).toBe(0);
    // Every other proof is COMPLETE and no item is UNKNOWN, so the re-derived
    // truth agrees with the forged COMPLETE: only the sentinel rule can refuse.
    const forged = {
      ...record,
      coordinator: null,
      proofs: record.proofs.map((proof) =>
        proof.class === "RESOURCE" ? { ...proof, truth: "COMPLETE" as const, upstream: null } : proof,
      ),
      truth: "COMPLETE" as const,
      upstream: null,
    };
    expect(refusedBytes(forged)).toEqual(INCOHERENT);
  });

  it("refuses a sentinel slot whose upstream is not the missing-proof code", () => {
    const record = unbacked();
    const forged = {
      ...record,
      proofs: record.proofs.map((proof) =>
        proof.class === "RESOURCE" ? { ...proof, upstream: ADAPTER_UNKNOWN } : proof,
      ),
    };
    expect(refusedBytes(forged)).toEqual(INCOHERENT);
  });
});

describe("every disposition must carry exactly its builder-emitted fields", () => {
  const ABSENT = (): RecoveryReconciliationRecord => reconciled(baseInput());
  const CANCELLED = (): RecoveryReconciliationRecord =>
    reconciled(withEvidence({ kind: "TERMINAL_CANCELLED", proofDigest: hex("ca11") }));
  const QUARANTINED = (): RecoveryReconciliationRecord =>
    reconciled(withEvidence({ kind: "ORPHAN", quarantineRef: "quarantine-workspace-1" }));
  const ADOPTED = (): RecoveryReconciliationRecord =>
    reconciled(
      withEvidence({
        externalIdentity: "external-PROJECT_TAGGED_WORKSPACE",
        incarnationRef: SELECTED.incarnationRef,
        intentDigest: hex("1e7d"),
        intentRef: "intent-restored-1",
        keyEpochRef: SELECTED.keyEpochRef,
        kind: "RESTORED_INTENT",
      }),
    );
  const UNKNOWN = (): RecoveryReconciliationRecord =>
    reconciled(withEvidence({ kind: "UNRESOLVED", upstream: ADAPTER_UNKNOWN }));

  it("drops a required field on every one of the five dispositions", () => {
    const drops: readonly (readonly [
      RecoveryInventoryDisposition,
      () => RecoveryReconciliationRecord,
      Partial<RecoveryReconciliationItem>,
    ])[] = [
      ["ABSENT", ABSENT, { terminalProofDigest: null }],
      ["CANCELLED", CANCELLED, { terminalProofDigest: null }],
      ["ADOPTED", ADOPTED, { restoredIntentDigest: null }],
      ["QUARANTINED", QUARANTINED, { quarantineRef: null }],
      ["UNKNOWN", UNKNOWN, { upstream: null }],
    ];
    let swept = 0;
    for (const [disposition, build, patch] of drops) {
      const record = build();
      const at = indexOfDisposition(record, disposition);
      expect({ disposition, ...refusedBytes(patchItem(record, at, patch)) }).toEqual({
        ...INCOHERENT,
        disposition,
      });
      swept += 1;
    }
    expect(swept).toBe(5);
    expect(swept).toBe(RECOVERY_INVENTORY_DISPOSITIONS.length);
  });

  it("adds a forbidden field on every terminal and positive disposition", () => {
    const adds: readonly (readonly [
      RecoveryInventoryDisposition,
      () => RecoveryReconciliationRecord,
      Partial<RecoveryReconciliationItem>,
    ])[] = [
      ["ABSENT", ABSENT, { quarantineRef: "quarantine-smuggled" }],
      ["CANCELLED", CANCELLED, { restoredIntentRef: "intent-smuggled" }],
      ["ADOPTED", ADOPTED, { terminalProofDigest: hex("dead") }],
      ["QUARANTINED", QUARANTINED, { upstream: ADAPTER_UNKNOWN }],
    ];
    let swept = 0;
    for (const [disposition, build, patch] of adds) {
      const record = build();
      const at = indexOfDisposition(record, disposition);
      expect({ disposition, ...refusedBytes(patchItem(record, at, patch)) }).toEqual({
        ...INCOHERENT,
        disposition,
      });
      swept += 1;
    }
    expect(swept).toBe(4);
  });

  it("refuses an ADOPTED item stripped of its restored intent reference", () => {
    const record = ADOPTED();
    const at = indexOfDisposition(record, "ADOPTED");
    expect(record.items[at]?.restoredIntentDigest).toBe(hex("1e7d"));
    expect(refusedBytes(patchItem(record, at, { restoredIntentRef: null }))).toEqual(INCOHERENT);
  });

  it("accepts each untouched disposition, so the drops above are the only change", () => {
    let swept = 0;
    for (const build of [ABSENT, CANCELLED, ADOPTED, QUARANTINED, UNKNOWN]) {
      const decoded = decodeRecoveryReconciliationRecord(seal(build()));
      expect(decoded.ok).toBe(true);
      swept += 1;
    }
    expect(swept).toBe(5);
  });
});

describe("item order and class-scoped identity are re-derived, not trusted", () => {
  /** Two WORKSPACE subjects, so identity-level ordering has something to order. */
  const paired = (): RecoveryReconciliationRecord =>
    reconciled({
      ...baseInput(),
      subjects: [
        ...absentSubjects(),
        {
          class: "WORKSPACE",
          evidence: { kind: "NEGATIVE_COMPLETE" as const, proofDigest: hex("ab9") },
          identity: "aaa-first-workspace",
          population: "PROJECT_TAGGED_WORKSPACE",
          sourceProofDigest: classDigest("PROJECT_TAGGED_WORKSPACE"),
        },
      ],
    });

  const swap = (
    record: RecoveryReconciliationRecord,
    left: number,
    right: number,
  ): RecoveryReconciliationRecord => {
    const items = [...record.items];
    const a = items[left];
    const b = items[right];
    if (a === undefined || b === undefined) throw new Error("swap indexes must exist");
    items[left] = b;
    items[right] = a;
    return { ...record, items };
  };

  it("refuses fully reversed items", () => {
    const record = reconciled(baseInput());
    expect(refusedBytes({ ...record, items: [...record.items].reverse() })).toEqual(INCOHERENT);
  });

  it("ranks declared population above identity inside one class", () => {
    // Identities are chosen to CONTRADICT the declared population order, so an
    // implementation that ordered by identity alone would emit the other
    // sequence. Without this the two orders coincide and the rule is untested.
    const record = reconciled({
      ...baseInput(),
      subjects: absentSubjects().map((subject) =>
        subject.population === "EFFECT_LOCK_WRAPPER_REGISTRATION"
          ? { ...subject, identity: "zzz-lock-registration" }
          : subject.population === "PROVIDER_RUN"
            ? { ...subject, identity: "aaa-provider-run" }
            : subject,
      ),
    });
    expect(record.items[0]?.identity).toBe("zzz-lock-registration");
    expect(record.items[1]?.identity).toBe("aaa-provider-run");
    expect(record.items[0]?.population).toBe("EFFECT_LOCK_WRAPPER_REGISTRATION");
    // And the identity-sorted sequence is refused, not merely unproduced.
    expect(refusedBytes(swap(record, 0, 1))).toEqual(INCOHERENT);
  });

  it("refuses two populations of one class presented out of declared order", () => {
    // A class-grouping-only check would pass this: both items stay adjacent and
    // inside PROVIDER_PROCESS_LAUNCH_LOCK, only the population order inverts.
    const record = reconciled(baseInput());
    expect(record.items[0]?.population).toBe("EFFECT_LOCK_WRAPPER_REGISTRATION");
    expect(record.items[1]?.population).toBe("PROVIDER_RUN");
    expect(record.items[0]?.class).toBe(record.items[1]?.class);
    expect(refusedBytes(swap(record, 0, 1))).toEqual(INCOHERENT);
  });

  it("refuses two identities of one population presented out of order", () => {
    const record = paired();
    const at = record.items.findIndex((item) => item.identity === "aaa-first-workspace");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(record.items[at + 1]?.population).toBe("PROJECT_TAGGED_WORKSPACE");
    expect(refusedBytes(swap(record, at, at + 1))).toEqual(INCOHERENT);
  });

  it("refuses one class-scoped identity claimed by two populations", () => {
    // Order stays canonical — the two populations differ — so ONLY the
    // uniqueness rule can answer.
    const record = reconciled(baseInput());
    const first = record.items[0];
    if (first === undefined) throw new Error("fixture must carry items");
    const forged = patchItem(record, 1, { identity: first.identity });
    expect(forged.items[1]?.class).toBe(first.class);
    expect(forged.items[1]?.population).not.toBe(first.population);
    expect(refusedBytes(forged)).toEqual(INCOHERENT);
  });

  it("refuses an appended duplicate item even with its proof item count adjusted", () => {
    const record = reconciled(baseInput());
    const last = record.items[record.items.length - 1];
    if (last === undefined) throw new Error("fixture must carry items");
    const forged = {
      ...record,
      items: [...record.items, { ...last }],
      proofs: record.proofs.map((proof) =>
        proof.class === last.class ? { ...proof, itemCount: proof.itemCount + 1 } : proof,
      ),
    };
    expect(refusedBytes(forged)).toEqual(INCOHERENT);
  });
});

describe("the builder refuses a proof that contradicts itself", () => {
  const built = (
    proofs: RecoveryReconciliationBuildInput["proofs"],
  ): ReturnType<typeof buildRecoveryReconciliationRecord> =>
    buildRecoveryReconciliationRecord({ ...baseInput(), proofs });

  it("refuses COMPLETE carried alongside an upstream refusal", () => {
    const result = built(
      completeProofs().map((proof, index) =>
        index === 0 ? { ...proof, upstream: ADAPTER_UNKNOWN } : proof,
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("UNKNOWN_TRUTH");
    expect(result.layer).toBe(RECOVERY_INVENTORY_LAYER);
    expect(result.upstream).toEqual({
      code: "RECOVERY_INVENTORY_PROOF_TRUTH_CONTRADICTS",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("keeps the same adapter provenance verbatim when the proof admits UNKNOWN", () => {
    // Positive control AND the retention rule: the identical upstream tuple is
    // legitimate under UNKNOWN, and must survive normalization unrestamped.
    const result = built(
      completeProofs().map((proof, index) =>
        index === 0 ? { ...proof, truth: "UNKNOWN" as const, upstream: ADAPTER_UNKNOWN } : proof,
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.record.truth).toBe("UNKNOWN");
    expect(result.record.proofs[0]?.upstream).toEqual({
      code: "RECOVERY_INVENTORY_COVERAGE_UNKNOWN",
      layer: "INVENTORY_ADAPTER",
    });
    expect(result.record.coordinator).toEqual({
      code: "UNKNOWN_TRUTH",
      layer: "RECOVERY_INVENTORY",
    });
    expect(result.record.upstream).toEqual({
      code: "RECOVERY_INVENTORY_PROOF_INCOMPLETE",
      layer: "RECOVERY_INVENTORY",
    });
  });
});
