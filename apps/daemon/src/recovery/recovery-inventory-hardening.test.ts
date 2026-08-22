import { describe, expect, it } from "vitest";

import {
  MAX_RECOVERY_RECONCILIATION_BYTES,
  MAX_RECOVERY_RECONCILIATION_ITEMS,
  MAX_RECOVERY_RECONCILIATION_TEXT_CHARS,
  RECOVERY_INVENTORY_LAYER,
  RECOVERY_INVENTORY_POPULATIONS,
  RECOVERY_PROOF_CLASSES,
  recoveryPopulationClass,
} from "./recovery-inventory-contract.js";
import type { RecoveryProofClass } from "./recovery-inventory-contract.js";
import {
  decodeRecoveryReconciliationRecord,
  encodeRecoveryReconciliationRecord,
} from "./recovery-inventory-codec.js";
import { buildRecoveryReconciliationRecord } from "./recovery-inventory-record.js";
import type {
  RecoveryReconciliationBuildInput,
} from "./recovery-inventory-record.js";
import type { RecoveryReconciliationRecord } from "./recovery-inventory-contract.js";

/**
 * Reopen #1 regressions. Every case here drives the PRODUCTION builder or the
 * PRODUCTION codec — never a local reimplementation — and pins WHICH guard
 * answered, because all three rejected defects shipped green under tests that
 * asserted only that a record came back.
 */
const hex = (tag: string): string =>
  (tag.replace(/[^0-9a-f]/gu, "") + "0".repeat(64)).slice(0, 64);

const SELECTED = Object.freeze({
  anchorBindingDigest: hex("abc1"),
  incarnationRef: hex("dec2"),
  keyEpochRef: hex("efa3"),
});

const classDigest = (population: string): string =>
  hex(`c${RECOVERY_PROOF_CLASSES.indexOf(recoveryPopulationClass(population) as RecoveryProofClass)}`);

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

const reconciled = (input: RecoveryReconciliationBuildInput): RecoveryReconciliationRecord => {
  const result = buildRecoveryReconciliationRecord(input);
  if (!result.ok) throw new Error(`expected a record, refused ${result.upstream.code}`);
  return result.record;
};

const refused = (value: unknown): { readonly code: string; readonly layer: string } => {
  const result = buildRecoveryReconciliationRecord(value);
  if (result.ok) throw new Error("expected a refusal, built a record");
  expect(result.code).toBe("UNKNOWN_TRUTH");
  expect(result.layer).toBe(RECOVERY_INVENTORY_LAYER);
  expect(result.truth).toBe("UNKNOWN");
  return { code: result.upstream.code, layer: result.upstream.layer };
};

describe("supplied proof rows are a closed unique set", () => {
  it("refuses an unknown supplied proof class at the proof-row guard", () => {
    const proofs = completeProofs().map((proof, index) =>
      index === 1 ? { ...proof, class: "ALIEN" } : proof,
    );
    expect(refused({ ...baseInput(), proofs })).toEqual({
      code: "RECOVERY_INVENTORY_PROOF_CLASS_UNKNOWN",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("refuses a duplicated supplied proof class at the proof-row guard", () => {
    // Length stays at six so the EXTRA guard cannot answer first: the WORKSPACE
    // row is replaced by a second RESOURCE row.
    const proofs = completeProofs().map((proof, index) =>
      index === 2 ? { ...proof, class: "RESOURCE" } : proof,
    );
    expect(proofs).toHaveLength(6);
    expect(refused({ ...baseInput(), proofs })).toEqual({
      code: "RECOVERY_INVENTORY_PROOF_CLASS_DUPLICATE",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("refuses more supplied proof rows than the frozen mapping declares", () => {
    const first = completeProofs()[0];
    if (first === undefined) throw new Error("fixture must carry proofs");
    const proofs = [...completeProofs(), { ...first }];
    expect(proofs).toHaveLength(7);
    expect(refused({ ...baseInput(), proofs })).toEqual({
      code: "RECOVERY_INVENTORY_PROOF_CLASS_EXTRA",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("refuses a supplied proof carrying the reserved unknown-slot digest", () => {
    const proofs = completeProofs().map((proof, index) =>
      index === 0 ? { ...proof, sourceProofDigest: "0".repeat(64) } : proof,
    );
    expect(refused({ ...baseInput(), proofs })).toEqual({
      code: "RECOVERY_INVENTORY_PROOF_DIGEST_RESERVED",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("answers proof-row faults distinctly from identical configured-class faults", () => {
    // The SAME structural fault on the two different inputs must be answerable
    // apart, or a green test cannot tell which guard refused.
    const first = completeProofs()[0];
    if (first === undefined) throw new Error("fixture must carry proofs");
    const viaClasses = refused({
      ...baseInput(),
      configuredClasses: [...RECOVERY_PROOF_CLASSES, "RESOURCE"],
    });
    const viaProofs = refused({ ...baseInput(), proofs: [...completeProofs(), { ...first }] });
    expect(viaClasses.code).toBe("RECOVERY_INVENTORY_CLASS_EXTRA");
    expect(viaProofs.code).toBe("RECOVERY_INVENTORY_PROOF_CLASS_EXTRA");
    expect(viaClasses.code).not.toBe(viaProofs.code);
  });

  it("still accepts an omitted proof row as the canonical UNKNOWN slot", () => {
    const record = reconciled({
      ...baseInput(),
      proofs: completeProofs().filter((proof) => proof.class !== "RESOURCE"),
      subjects: absentSubjects().filter((subject) => subject.population !== "RESOURCE"),
    });
    expect(record.proofs).toHaveLength(6);
    expect(record.proofs.map((proof) => proof.class)).toEqual([...RECOVERY_PROOF_CLASSES]);
    expect(record.truth).toBe("UNKNOWN");
  });
});

describe("item provenance is cross-linked to its configured proof", () => {
  it("refuses a contradicting subject digest for every mapped class", () => {
    let swept = 0;
    for (const [index, population] of RECOVERY_INVENTORY_POPULATIONS.entries()) {
      const subjects = absentSubjects().map((subject, at) =>
        at === index ? { ...subject, sourceProofDigest: hex("deadbeef") } : subject,
      );
      expect({ population, ...refused({ ...baseInput(), subjects }) }).toEqual({
        code: "RECOVERY_INVENTORY_ITEM_PROOF_MISMATCH",
        layer: "RECOVERY_INVENTORY",
        population,
      });
      swept += 1;
    }
    expect(swept).toBe(7);
  });

  it("builds COMPLETE only while every subject digest matches its class proof", () => {
    // Positive control for the sweep above: the untouched fixture differs from
    // each mutated one in exactly the digest under test.
    const record = reconciled(baseInput());
    expect(record.truth).toBe("COMPLETE");
    let checked = 0;
    for (const item of record.items) {
      const proof = record.proofs.find((entry) => entry.class === item.class);
      expect(`${item.identity}:${item.sourceProofDigest}`)
        .toBe(`${item.identity}:${proof?.sourceProofDigest ?? "none"}`);
      checked += 1;
    }
    expect(checked).toBe(7);
  });

  it("keeps an item whose class proof is absent UNKNOWN with retained provenance", () => {
    const record = reconciled({
      ...baseInput(),
      proofs: completeProofs().filter((proof) => proof.class !== "RESOURCE"),
    });
    const resource = record.items.filter((item) => item.class === "RESOURCE");
    expect(resource).toHaveLength(1);
    expect(resource[0]?.disposition).toBe("UNKNOWN");
    expect(resource[0]?.upstream).toEqual({
      code: "RECOVERY_INVENTORY_PROOF_MISSING",
      layer: "RECOVERY_INVENTORY",
    });
    // Provenance is RETAINED, not restamped: the item still carries the digest
    // its adapter reported, even though no configured proof backs it.
    expect(resource[0]?.sourceProofDigest).toBe(hex("c1"));
    expect(record.truth).toBe("UNKNOWN");
    expect(record.coordinator).toEqual({ code: "UNKNOWN_TRUTH", layer: "RECOVERY_INVENTORY" });
  });
});

describe("hostile proxies are contained before any reflective trap", () => {
  it("refuses a transparent proxy over an input that builds when unwrapped", () => {
    const target = baseInput();
    expect(buildRecoveryReconciliationRecord(target).ok).toBe(true);
    const result = buildRecoveryReconciliationRecord(new Proxy(target, {}));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.upstream).toEqual({
      code: "RECOVERY_INVENTORY_INPUT_INVALID",
      layer: "RECOVERY_INVENTORY",
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("refuses trap-bearing proxies over the real record without running a trap", () => {
    let hits = 0;
    const boom = (): never => {
      hits += 1;
      throw new Error("trap-executed");
    };
    const traps: readonly (readonly [string, ProxyHandler<object>])[] = [
      ["ownKeys", { ownKeys: boom }],
      ["getOwnPropertyDescriptor", { getOwnPropertyDescriptor: boom }],
      ["get", { get: boom }],
      ["getPrototypeOf", { getPrototypeOf: boom }],
    ];
    let swept = 0;
    for (const [name, handler] of traps) {
      expect({ name, ...refused(new Proxy(baseInput(), handler)) }).toEqual({
        code: "RECOVERY_INVENTORY_INPUT_INVALID",
        layer: "RECOVERY_INVENTORY",
        name,
      });
      swept += 1;
    }
    expect(swept).toBe(4);
    // The target is the record the reader EXPECTS, so refusal cannot be blamed
    // on a wrong shape; zero hits proves containment happened first.
    expect(hits).toBe(0);
  });

  it("refuses a revoked proxy instead of raising IsArray", () => {
    const revocable = Proxy.revocable(baseInput(), {});
    revocable.revoke();
    expect(refused(revocable.proxy)).toEqual({
      code: "RECOVERY_INVENTORY_INPUT_INVALID",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("refuses a proxy at every nested input position", () => {
    const wrap = <Value extends object>(value: Value): Value => new Proxy(value, {});
    const nested: readonly (readonly [string, RecoveryReconciliationBuildInput])[] = [
      ["selected", { ...baseInput(), selected: wrap({ ...SELECTED }) }],
      ["subjects", { ...baseInput(), subjects: wrap([...absentSubjects()]) }],
      ["subject", {
        ...baseInput(),
        subjects: absentSubjects().map((subject, index) =>
          index === 0 ? wrap({ ...subject }) : subject,
        ),
      }],
      ["evidence", {
        ...baseInput(),
        subjects: absentSubjects().map((subject, index) =>
          index === 0 ? { ...subject, evidence: wrap({ ...subject.evidence }) } : subject,
        ),
      }],
      ["proofs", { ...baseInput(), proofs: wrap([...completeProofs()]) }],
      ["proof", {
        ...baseInput(),
        proofs: completeProofs().map((proof, index) => (index === 0 ? wrap({ ...proof }) : proof)),
      }],
      ["configuredClasses", {
        ...baseInput(),
        configuredClasses: wrap([...RECOVERY_PROOF_CLASSES]),
      }],
    ];
    let swept = 0;
    for (const [name, input] of nested) {
      expect({ name, ...refused(input) }).toEqual({
        code: "RECOVERY_INVENTORY_INPUT_INVALID",
        layer: "RECOVERY_INVENTORY",
        name,
      });
      swept += 1;
    }
    expect(swept).toBe(7);
  });
});

describe("decoder re-derives the item-to-proof provenance link", () => {
  it("refuses bytes whose item digest contradicts its class proof", () => {
    const record = reconciled(baseInput());
    const text = new TextDecoder().decode(encodeRecoveryReconciliationRecord(record));
    // A single-item class, so the marker below is unambiguous: the two
    // PROVIDER_PROCESS_LAUNCH_LOCK items share one digest by design.
    const item = record.items.find((entry) => entry.class === "WORKSPACE");
    if (item === undefined) throw new Error("fixture must carry a WORKSPACE item");
    const marker = `"sourceProofDigest":"${item.sourceProofDigest}","terminalProofDigest"`;
    expect(text.split(marker)).toHaveLength(2);
    const tampered = text.replace(
      marker,
      `"sourceProofDigest":"${hex("deadbeef")}","terminalProofDigest"`,
    );
    const decoded = decodeRecoveryReconciliationRecord(new TextEncoder().encode(tampered));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("unreachable");
    // The SEMANTIC guard must answer before the digest guard, or a forged
    // record whose digest was recomputed would decode as authoritative. It is
    // INCOHERENT rather than NONCANONICAL because these bytes are a perfectly
    // well-formed spelling — what they assert is what cannot be true.
    expect(decoded.upstream).toEqual({
      code: "RECOVERY_INVENTORY_RECORD_INCOHERENT",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("refuses bytes claiming a terminal disposition under an unknown-slot proof", () => {
    const record = reconciled({
      ...baseInput(),
      proofs: completeProofs().filter((proof) => proof.class !== "RESOURCE"),
    });
    const text = new TextDecoder().decode(encodeRecoveryReconciliationRecord(record));
    expect(text.split('"disposition":"UNKNOWN"')).toHaveLength(2);
    const tampered = text.replace('"disposition":"UNKNOWN"', '"disposition":"ABSENT"');
    const decoded = decodeRecoveryReconciliationRecord(new TextEncoder().encode(tampered));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("unreachable");
    expect(decoded.upstream).toEqual({
      code: "RECOVERY_INVENTORY_RECORD_INCOHERENT",
      layer: "RECOVERY_INVENTORY",
    });
  });

  it("still answers NONCANONICAL for a malformed spelling, not INCOHERENT", () => {
    // The separation is load-bearing: if every structural fault collapsed onto
    // one code, a test asserting it could not tell a shape reader from a
    // re-derived invariant. A duplicate key is pure spelling.
    const record = reconciled(baseInput());
    const text = new TextDecoder().decode(encodeRecoveryReconciliationRecord(record));
    const tampered = text.replace('{"schemaVersion"', '{"truth":"COMPLETE","schemaVersion"');
    const decoded = decodeRecoveryReconciliationRecord(new TextEncoder().encode(tampered));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("unreachable");
    expect(decoded.upstream).toEqual({
      code: "RECOVERY_INVENTORY_RECORD_NONCANONICAL",
      layer: "RECOVERY_INVENTORY",
    });
  });
});

/**
 * ADOPTED subjects at the text cap carry the two longest item fields (identity
 * and restored intent ref), so they are the densest bytes per item the builder
 * admits. Identities are unique by a zero-padded index so ordering is stable
 * and every item encodes to exactly the same width.
 */
const widestSubjects = (count: number): RecoveryReconciliationBuildInput["subjects"] => {
  const width = MAX_RECOVERY_RECONCILIATION_TEXT_CHARS;
  const population = "RESOURCE";
  return Array.from({ length: count }, (_, index) => {
    const identity = `${String(index).padStart(6, "0")}-`.padEnd(width, "i");
    return {
      class: recoveryPopulationClass(population) as string,
      evidence: {
        externalIdentity: identity,
        incarnationRef: SELECTED.incarnationRef,
        intentDigest: hex("d0e5"),
        intentRef: `intent-${String(index).padStart(6, "0")}-`.padEnd(width, "r"),
        keyEpochRef: SELECTED.keyEpochRef,
        kind: "RESTORED_INTENT" as const,
      },
      identity,
      population,
      sourceProofDigest: classDigest(population),
    };
  });
};

const encodedLength = (count: number): number =>
  encodeRecoveryReconciliationRecord(reconciled({ ...baseInput(), subjects: widestSubjects(count) }))
    .length;

/** The largest item count whose record still encodes at or under the byte cap. */
const countJustUnderCap = (): { readonly count: number; readonly perItem: number } => {
  const one = encodedLength(1);
  const perItem = encodedLength(2) - one;
  expect(perItem).toBeGreaterThan(2 * MAX_RECOVERY_RECONCILIATION_TEXT_CHARS);
  return { count: 1 + Math.floor((MAX_RECOVERY_RECONCILIATION_BYTES - one) / perItem), perItem };
};

describe("the byte cap is a builder refusal, not only a decoder one", () => {
  it("refuses the item cap at the text cap, which encodes past the byte cap", () => {
    // The per-field caps multiply to well over the byte cap: before this guard
    // the builder handed back a record the ledger would commit as RECORDED and
    // the decoder would then refuse under its own digest forever.
    expect(refused({
      ...baseInput(),
      subjects: widestSubjects(MAX_RECOVERY_RECONCILIATION_ITEMS),
    })).toEqual({ code: "RECOVERY_INVENTORY_RECORD_OVERSIZED", layer: "RECOVERY_INVENTORY" });
  });

  it("refuses at the first item that crosses the cap and builds the one before it", () => {
    const { count, perItem } = countJustUnderCap();
    expect(count).toBeLessThan(MAX_RECOVERY_RECONCILIATION_ITEMS);
    const fitting = reconciled({ ...baseInput(), subjects: widestSubjects(count) });
    const bytes = encodeRecoveryReconciliationRecord(fitting);
    // Near the ceiling on purpose: within one item of the cap, not merely under it.
    expect(bytes.length).toBeLessThanOrEqual(MAX_RECOVERY_RECONCILIATION_BYTES);
    expect(bytes.length).toBeGreaterThan(MAX_RECOVERY_RECONCILIATION_BYTES - perItem);
    expect(fitting.items).toHaveLength(count);
    expect(fitting.truth).toBe("COMPLETE");
    // What the builder admits, the decoder reads back: the cap is ONE number on
    // both sides of the durable boundary.
    const decoded = decodeRecoveryReconciliationRecord(bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("unreachable");
    expect(decoded.record.recordDigest).toBe(fitting.recordDigest);

    expect(refused({ ...baseInput(), subjects: widestSubjects(count + 1) })).toEqual({
      code: "RECOVERY_INVENTORY_RECORD_OVERSIZED",
      layer: "RECOVERY_INVENTORY",
    });
  });
});
