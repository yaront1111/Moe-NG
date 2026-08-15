import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RECOVERY_COMPLETION_CODES,
  RECOVERY_COMPLETION_DIGEST_DOMAIN,
  RECOVERY_COMPLETION_LAYER,
  RECOVERY_COVERAGE_PROOF_DIGEST_DOMAIN,
  recoveryCompletionPreimage,
  recoveryCompletionDigest,
  recoveryCoverageProofDigest,
} from "./recovery-completion-digest.js";
import type {
  RecoveryCompletionEvidence,
  RecoveryCompletionItemEvidence,
  RecoveryCompletionProofEvidence,
} from "./recovery-completion-digest.js";

const hex = (tag: string): string =>
  (tag.replace(/[^0-9a-f]/gu, "") + "0".repeat(64)).slice(0, 64);

const PROOFS: readonly RecoveryCompletionProofEvidence[] = Object.freeze([
  Object.freeze({
    class: "PROVIDER_PROCESS_LAUNCH_LOCK",
    itemCount: 2,
    sourceProofDigest: hex("c0"),
    truth: "COMPLETE",
  }),
  Object.freeze({
    class: "RESOURCE",
    itemCount: 1,
    sourceProofDigest: hex("c1"),
    truth: "COMPLETE",
  }),
]);

const ITEMS: readonly RecoveryCompletionItemEvidence[] = Object.freeze([
  Object.freeze({
    class: "PROVIDER_PROCESS_LAUNCH_LOCK",
    disposition: "ABSENT",
    identity: "external-EFFECT_LOCK_WRAPPER_REGISTRATION",
    population: "EFFECT_LOCK_WRAPPER_REGISTRATION",
    quarantineRef: null,
    sourceProofDigest: hex("c0"),
  }),
  Object.freeze({
    class: "RESOURCE",
    disposition: "ADOPTED",
    identity: "external-RESOURCE",
    population: "RESOURCE",
    quarantineRef: null,
    sourceProofDigest: hex("c1"),
  }),
]);

const EVIDENCE: RecoveryCompletionEvidence = Object.freeze({
  anchorBindingDigest: hex("a1"),
  backupCursor: "000000000000000000042",
  backupGenerationDigest: hex("b2"),
  configuredClasses: Object.freeze(["PROVIDER_PROCESS_LAUNCH_LOCK", "RESOURCE"]),
  incarnationRef: hex("c3"),
  items: ITEMS,
  keyEpochRef: hex("d4"),
  projectId: "project-1",
  projectTag: "moe-project:project-1",
  proofs: PROOFS,
  reconciliationRecordDigest: hex("e5"),
  restoreBindingSlot: "ACTIVE",
  restoreCommandId: "restore-cmd-1",
  restoreGenerationDigest: hex("f6"),
});

/**
 * The hand-written census of the evidence tuple. The sweep below is GENERATED
 * from the record's own key set so a later field cannot escape it, but a
 * generated table cannot police its own generator: this list and the case count
 * are written by hand, so adding a field to the evidence without extending the
 * sweep fails here rather than passing silently with one fewer case.
 */
const EVIDENCE_KEYS: readonly string[] = Object.freeze([
  "anchorBindingDigest",
  "backupCursor",
  "backupGenerationDigest",
  "configuredClasses",
  "incarnationRef",
  "items",
  "keyEpochRef",
  "projectId",
  "projectTag",
  "proofs",
  "reconciliationRecordDigest",
  "restoreBindingSlot",
  "restoreCommandId",
  "restoreGenerationDigest",
]);

/** 11 scalars + configuredClasses[0] + 4 proof fields + 6 item fields. */
const EXPECTED_SWEEP_CASES = 22;

const flip = (value: unknown): unknown => {
  if (value === null) return "quarantine-ref-1";
  if (typeof value === "string") return `${value}-mutated`;
  if (typeof value === "number") return value + 1;
  throw new Error(`the sweep cannot flip a ${typeof value} evidence field`);
};

interface SweepCase {
  readonly label: string;
  readonly topKey: string;
  readonly value: RecoveryCompletionEvidence;
}

/** One case per own key, descending into element 0 of every array field. */
function sweepCases(evidence: RecoveryCompletionEvidence): readonly SweepCase[] {
  const source = evidence as unknown as Record<string, unknown>;
  const cases: SweepCase[] = [];
  for (const topKey of Object.keys(source)) {
    const current = source[topKey];
    if (!Array.isArray(current)) {
      cases.push({
        label: topKey,
        topKey,
        value: { ...source, [topKey]: flip(current) } as unknown as RecoveryCompletionEvidence,
      });
      continue;
    }
    const [head, ...tail] = current as readonly unknown[];
    if (head === undefined) throw new Error(`evidence field ${topKey} has no element to flip`);
    if (typeof head !== "object" || head === null) {
      cases.push({
        label: `${topKey}[0]`,
        topKey,
        value: {
          ...source, [topKey]: [flip(head), ...tail],
        } as unknown as RecoveryCompletionEvidence,
      });
      continue;
    }
    const entry = head as Record<string, unknown>;
    for (const entryKey of Object.keys(entry)) {
      cases.push({
        label: `${topKey}[0].${entryKey}`,
        topKey,
        value: {
          ...source,
          [topKey]: [{ ...entry, [entryKey]: flip(entry[entryKey]) }, ...tail],
        } as unknown as RecoveryCompletionEvidence,
      });
    }
  }
  return cases;
}

describe("recovery completion digest", () => {
  it("publishes its own layer, domains and closed refusal vocabulary", () => {
    expect(RECOVERY_COMPLETION_LAYER).toBe("RECOVERY_COMPLETION");
    expect(RECOVERY_COMPLETION_DIGEST_DOMAIN).not.toBe(RECOVERY_COVERAGE_PROOF_DIGEST_DOMAIN);
    for (const code of [
      "RECOVERY_COMPLETION_APPROVAL_INVALID",
      "RECOVERY_COMPLETION_DIGEST_MISMATCH",
      "RECOVERY_COMPLETION_EVIDENCE_ABSENT",
      "RECOVERY_COMPLETION_EVIDENCE_MISMATCH",
      "RECOVERY_COMPLETION_REQUEST_MALFORMED",
      "RECOVERY_COMPLETION_STALE",
      "RECOVERY_COMPLETION_STORE_UNAVAILABLE",
      "RECOVERY_RECONCILIATION_REQUIRED",
    ]) {
      expect(RECOVERY_COMPLETION_CODES).toContain(code);
    }
    expect(Object.isFrozen(RECOVERY_COMPLETION_CODES)).toBe(true);
  });

  it("is a stable hex64 across two calls on equal input", () => {
    const first = recoveryCompletionDigest(EVIDENCE);
    const second = recoveryCompletionDigest({
      ...EVIDENCE,
      configuredClasses: [...EVIDENCE.configuredClasses],
      items: EVIDENCE.items.map((item) => ({ ...item })),
      proofs: EVIDENCE.proofs.map((proof) => ({ ...proof })),
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toBe(first);
  });

  it("is domain-separated from a bare hash of the same canonical preimage", () => {
    const preimage = recoveryCompletionPreimage(EVIDENCE);
    const bare = createHash("sha256").update(preimage).digest("hex");
    expect(bare).toMatch(/^[0-9a-f]{64}$/u);
    expect(recoveryCompletionDigest(EVIDENCE)).not.toBe(bare);
  });

  it("changes on every single-field flip the evidence key set can produce", () => {
    const baseline = recoveryCompletionDigest(EVIDENCE);
    const cases = sweepCases(EVIDENCE);
    // A sweep that silently produced zero cases would pass while testing
    // nothing, so the count and the key census are asserted before the loop.
    expect(cases.length).toBe(EXPECTED_SWEEP_CASES);
    expect([...new Set(cases.map((entry) => entry.topKey))].sort()).toEqual([...EVIDENCE_KEYS]);
    const digests = new Set<string>();
    for (const entry of cases) {
      const digest = recoveryCompletionDigest(entry.value);
      expect(digest, `flipping ${entry.label} must change the digest`).not.toBe(baseline);
      digests.add(digest);
    }
    // Distinct flips must also stay distinct from each other: a preimage that
    // collided two different tuples would be exactly the concatenation defect
    // length framing exists to prevent.
    expect(digests.size).toBe(EXPECTED_SWEEP_CASES);
  });

  it("treats configuredClasses, proof and item ORDER as significant, never normalized", () => {
    const baseline = recoveryCompletionDigest(EVIDENCE);
    expect(recoveryCompletionDigest({
      ...EVIDENCE, configuredClasses: [...EVIDENCE.configuredClasses].reverse(),
    })).not.toBe(baseline);
    expect(recoveryCompletionDigest({
      ...EVIDENCE, proofs: [...EVIDENCE.proofs].reverse(),
    })).not.toBe(baseline);
    expect(recoveryCompletionDigest({
      ...EVIDENCE, items: [...EVIDENCE.items].reverse(),
    })).not.toBe(baseline);
  });

  it("cannot be collided by moving bytes across the class/cursor boundary", () => {
    // Without per-component length framing "ab" + "c" and "a" + "bc" hash the
    // same. Both halves stay the same total length here, so only framing can
    // tell them apart.
    const left = recoveryCompletionDigest({
      ...EVIDENCE, backupCursor: "00", projectTag: "moe-project:project-1x",
    });
    const right = recoveryCompletionDigest({
      ...EVIDENCE, backupCursor: "x00", projectTag: "moe-project:project-1",
    });
    expect(left).not.toBe(right);
  });

  it("derives the coverage proof hash from classes and proofs under its own domain", () => {
    const coverage = recoveryCoverageProofDigest(EVIDENCE.configuredClasses, EVIDENCE.proofs);
    expect(coverage).toMatch(/^[0-9a-f]{64}$/u);
    expect(coverage).toBe(
      recoveryCoverageProofDigest([...EVIDENCE.configuredClasses], [...EVIDENCE.proofs]),
    );
    expect(coverage).not.toBe(recoveryCompletionDigest(EVIDENCE));
    expect(coverage).not.toBe(
      recoveryCoverageProofDigest([...EVIDENCE.configuredClasses].reverse(), EVIDENCE.proofs),
    );
    expect(coverage).not.toBe(
      recoveryCoverageProofDigest(EVIDENCE.configuredClasses, [...EVIDENCE.proofs].reverse()),
    );
  });
});
