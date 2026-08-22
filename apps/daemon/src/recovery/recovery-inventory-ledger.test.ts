import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RECOVERY_BINDING_CODEC_VERSION, SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeRecoveryCryptoPort } from "./recovery-incarnation.node.js";
import { createRecoveryIncarnationService } from "./recovery-incarnation.js";
import type { RestoreIncarnationBinding } from "./recovery-incarnation-contract.js";
import { anchorIncarnation } from "./recovery-incarnation-anchor.js";
import {
  MAX_RECOVERY_RECONCILIATION_BYTES,
  MAX_RECOVERY_RECONCILIATION_ITEMS,
  MAX_RECOVERY_RECONCILIATION_TEXT_CHARS,
  RECOVERY_INVENTORY_POPULATIONS,
  RECOVERY_PROOF_CLASSES,
  RECOVERY_RECONCILIATION_COMMAND_KIND,
  RECOVERY_RECONCILIATION_EVENT_TYPE,
  recoveryPopulationClass,
  recoveryReconciliationAggregateId,
} from "./recovery-inventory-contract.js";
import type { RecoveryProofClass } from "./recovery-inventory-contract.js";
import {
  encodeRecoveryReconciliationRecord,
  recoveryReconciliationDigest,
} from "./recovery-inventory-codec.js";
import {
  readRecoveryReconciliation,
  recordRecoveryReconciliation,
} from "./recovery-inventory-ledger.js";
import type { RecoveryReconciliationExternalFacts } from "./recovery-inventory-ledger.js";

const PROJECT_ID = "proj-reconcile";
const PROJECT_TAG = "moe-project:proj-reconcile";
const BACKUP_CURSOR = "000000000000000000042";
const RESTORE_COMMAND_ID = "restore-cmd-1";
const AT = "2026-08-14T00:00:00.000Z";

const hex = (tag: string): string =>
  (tag.replace(/[^0-9a-f]/gu, "") + "0".repeat(64)).slice(0, 64);

const encoder = new TextEncoder();
const openHandles: SqliteEventStore[] = [];
const directories: string[] = [];

/** Windows holds the file open: every handle this suite opens is closed in teardown. */
const open = (path: string): SqliteEventStore => {
  const store = SqliteEventStore.openForProject(path, PROJECT_ID);
  openHandles.push(store);
  return store;
};

afterEach(() => {
  while (openHandles.length > 0) {
    try {
      openHandles.pop()?.close();
    } catch {
      /* a suite that already closed a handle must still drain the rest */
    }
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) continue;
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      /* best effort: a leaked temp dir must not fail a real assertion */
    }
  }
});

const newDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "moe-reconcile-"));
  directories.push(directory);
  return directory;
};

const writeRequest = Object.freeze({
  correlationId: "corr-1",
  decidedAt: AT,
  principalId: "principal-1",
  projectId: PROJECT_ID,
});

const mintBinding = async (
  backupGenerationDigest: string,
): Promise<RestoreIncarnationBinding> => {
  const service = createRecoveryIncarnationService(createNodeRecoveryCryptoPort());
  const minted = await service.mint({
    backupGenerationDigest,
    restoreCommandId: RESTORE_COMMAND_ID,
  });
  if (!minted.ok) throw new Error(`mint refused: ${minted.code}`);
  return minted.binding;
};

interface Prepared {
  readonly binding: RestoreIncarnationBinding;
  readonly path: string;
  readonly store: SqliteEventStore;
}

const install = (
  store: SqliteEventStore,
  incarnationRef: string,
  keyEpochRef: string,
): void => {
  const installed = store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef,
    installedAt: AT,
    keyEpochRef,
    payload: encoder.encode("recovery-binding-payload"),
    slot: "ACTIVE",
  });
  expect(installed).toMatchObject({ ok: true, outcome: "INSTALLED" });
};

/** A real store carrying a real anchored incarnation and a real ACTIVE binding. */
const prepare = async (backupGenerationDigest = hex("badc0ffe")): Promise<Prepared> => {
  const path = join(newDirectory(), "store.sqlite");
  const store = open(path);
  const binding = await mintBinding(backupGenerationDigest);
  expect(anchorIncarnation(store, writeRequest, binding)).toBe(true);
  install(store, binding.incarnationRef, binding.keyEpochRef);
  return { binding, path, store };
};

const facts = (
  backupGenerationDigest: string,
  overrides: Partial<RecoveryReconciliationExternalFacts> = {},
): RecoveryReconciliationExternalFacts => ({
  backupCursor: BACKUP_CURSOR,
  backupGenerationDigest,
  configuredClasses: [...RECOVERY_PROOF_CLASSES],
  projectTag: PROJECT_TAG,
  proofs: RECOVERY_PROOF_CLASSES.map((proofClass, index) => ({
    class: proofClass,
    sourceProofDigest: hex(`c${index}`),
    truth: "COMPLETE" as const,
    upstream: null,
  })),
  subjects: RECOVERY_INVENTORY_POPULATIONS.map((population, index) => ({
    class: recoveryPopulationClass(population) as string,
    evidence: { kind: "NEGATIVE_COMPLETE" as const, proofDigest: hex(`ab${index}`) },
    identity: `external-${population}`,
    population: population as string,
    // The CLASS index, not the population index: a subject's source digest must
    // equal the digest of the one class proof that covers it, and seven
    // populations map onto six classes.
    sourceProofDigest: hex(
      `c${RECOVERY_PROOF_CLASSES.indexOf(recoveryPopulationClass(population) as RecoveryProofClass)}`,
    ),
  })),
  ...overrides,
});

describe("durable reconciliation record", () => {
  it("commits one canonical record bound to the store-selected recovery refs", async () => {
    const { binding, store } = await prepare();
    const written = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("unreachable");
    expect(written.outcome).toBe("RECORDED");
    expect(written.authority).toBe("NONE");
    expect(written.record.incarnationRef).toBe(binding.incarnationRef);
    expect(written.record.keyEpochRef).toBe(binding.keyEpochRef);
    expect(written.record.anchorBindingDigest).toBe(binding.bindingDigest);
    expect(written.record.projectId).toBe(PROJECT_ID);
    expect(written.record.items).toHaveLength(7);
    expect(written.recordDigest).toBe(written.record.recordDigest);
  });

  it("reads the record back byte-identically by its own digest", async () => {
    const { binding, store } = await prepare();
    const written = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    if (!written.ok) throw new Error("write must succeed");
    const read = readRecoveryReconciliation(store, PROJECT_ID, written.recordDigest);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    expect(read.record).toEqual(written.record);
    expect(encodeRecoveryReconciliationRecord(read.record))
      .toEqual(encodeRecoveryReconciliationRecord(written.record));
  });

  it("replays an exact retry onto the one committed event", async () => {
    const { binding, store } = await prepare();
    const first = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    const second = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    if (!first.ok || !second.ok) throw new Error("both writes must succeed");
    expect(second.recordDigest).toBe(first.recordDigest);
    expect(second.disposition).toBe("REPLAYED");
    const events = store.readAggregateEvents(
      recoveryReconciliationAggregateId(first.recordDigest),
    );
    expect(events.items).toHaveLength(1);
    expect(events.items[0]?.eventType).toBe(RECOVERY_RECONCILIATION_EVENT_TYPE);
    expect(events.items[0]?.aggregateSequence).toBe(1);
    expect(events.items[0]?.decisionTrace?.commandKind)
      .toBe(RECOVERY_RECONCILIATION_COMMAND_KIND);
  });

  it("survives close and reopen and is visible to a second handle", async () => {
    const { binding, path, store } = await prepare();
    const written = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    if (!written.ok) throw new Error("write must succeed");

    const contender = open(path);
    const contended = readRecoveryReconciliation(contender, PROJECT_ID, written.recordDigest);
    expect(contended.ok).toBe(true);
    if (!contended.ok) throw new Error("unreachable");
    expect(contended.record.recordDigest).toBe(written.recordDigest);

    contender.close();
    store.close();
    const reopened = open(path);
    const afterReopen = readRecoveryReconciliation(reopened, PROJECT_ID, written.recordDigest);
    expect(afterReopen.ok).toBe(true);
    if (!afterReopen.ok) throw new Error("unreachable");
    expect(afterReopen.record).toEqual(written.record);
  });
});

describe("ledger refusals", () => {
  it("answers an unknown digest with RECORD_NOT_FOUND at RECOVERY_INVENTORY_LEDGER", async () => {
    const { store } = await prepare();
    const read = readRecoveryReconciliation(store, PROJECT_ID, hex("f00d"));
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.code).toBe("UNKNOWN_TRUTH");
    expect(read.layer).toBe("RECOVERY_INVENTORY");
    expect(read.upstream).toEqual({
      code: "RECORD_NOT_FOUND",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });
  });

  it("refuses a self-consistent semantic forgery filed at its own digest", async () => {
    // The strongest durable attack available: the forger controls the bytes AND
    // the address. A legitimate record is mutated to claim COMPLETE over an
    // UNKNOWN proof, re-digested with the production digest surface, encoded
    // with the production encoder and filed under the digest it now hashes to.
    // Nothing is inconsistent, so only the decoder re-deriving truth can refuse.
    const { binding, store } = await prepare();
    const written = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    if (!written.ok) throw new Error("write must succeed");
    expect(written.record.truth).toBe("COMPLETE");
    const forged = {
      ...written.record,
      proofs: written.record.proofs.map((proof, index) =>
        index === 0
          ? {
              ...proof,
              truth: "UNKNOWN" as const,
              upstream: {
                code: "RECOVERY_INVENTORY_COVERAGE_UNKNOWN" as const,
                layer: "INVENTORY_ADAPTER" as const,
              },
            }
          : proof,
      ),
    };
    const digest = recoveryReconciliationDigest(forged);
    expect(digest).not.toBe(written.record.recordDigest);
    const bytes = encodeRecoveryReconciliationRecord({ ...forged, recordDigest: digest });
    const response = store.commitExpectedVersionDecision({
      commandKind: RECOVERY_RECONCILIATION_COMMAND_KIND,
      committedResultBytes: bytes,
      correlationId: writeRequest.correlationId,
      decidedAt: AT,
      events: [
        {
          eventId: `forged:${digest}`,
          eventType: RECOVERY_RECONCILIATION_EVENT_TYPE,
          payload: bytes,
        },
      ],
      expectedVersion: 0,
      key: {
        commandId: `recovery-reconcile:${digest}`,
        principalId: writeRequest.principalId,
        projectId: PROJECT_ID,
      },
      requestBytes: encoder.encode("{}"),
      targetAggregateId: recoveryReconciliationAggregateId(digest),
    });
    expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");

    const read = readRecoveryReconciliation(store, PROJECT_ID, digest);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.code).toBe("UNKNOWN_TRUTH");
    expect(read.layer).toBe("RECOVERY_INVENTORY");
    expect(read.upstream).toEqual({
      code: "RECORD_UNREADABLE",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });
    // The untouched record at its own digest still reads back, so the refusal
    // above is the forgery and not the durable path being broken.
    const control = readRecoveryReconciliation(store, PROJECT_ID, written.record.recordDigest);
    expect(control.ok).toBe(true);
  });

  it("refuses malformed and truncated stored bytes with RECORD_UNREADABLE", async () => {
    const { binding, store } = await prepare();
    const written = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    if (!written.ok) throw new Error("write must succeed");
    const canonical = new TextDecoder().decode(
      encodeRecoveryReconciliationRecord(written.record),
    );
    const corruptions: readonly (readonly [string, Uint8Array])[] = [
      ["malformed", encoder.encode("{not-json")],
      ["truncated", encoder.encode(canonical.slice(0, canonical.length - 20))],
    ];
    let swept = 0;
    for (const [name, bytes] of corruptions) {
      const digest = hex(`${"e".repeat(4)}${swept}`);
      const aggregateId = recoveryReconciliationAggregateId(digest);
      const response = store.commitExpectedVersionDecision({
        commandKind: RECOVERY_RECONCILIATION_COMMAND_KIND,
        committedResultBytes: bytes,
        correlationId: writeRequest.correlationId,
        decidedAt: AT,
        events: [
          {
            eventId: `${name}:corrupt`,
            eventType: RECOVERY_RECONCILIATION_EVENT_TYPE,
            payload: bytes,
          },
        ],
        expectedVersion: 0,
        key: {
          commandId: `recovery-reconcile:${digest}`,
          principalId: writeRequest.principalId,
          projectId: PROJECT_ID,
        },
        requestBytes: encoder.encode("{}"),
        targetAggregateId: aggregateId,
      });
      expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");

      const read = readRecoveryReconciliation(store, PROJECT_ID, digest);
      expect(`${name}:${read.ok}`).toBe(`${name}:false`);
      if (read.ok) throw new Error("unreachable");
      expect(read.upstream).toEqual({
        code: "RECORD_UNREADABLE",
        layer: "RECOVERY_INVENTORY_LEDGER",
      });
      swept += 1;
    }
    expect(swept).toBe(2);
  });

  it("refuses a second event under one record aggregate with RECORD_CONFLICT", async () => {
    const { binding, store } = await prepare();
    const written = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    if (!written.ok) throw new Error("write must succeed");
    const aggregateId = recoveryReconciliationAggregateId(written.recordDigest);
    const extra = store.commitExpectedVersionDecision({
      commandKind: RECOVERY_RECONCILIATION_COMMAND_KIND,
      committedResultBytes: encoder.encode("{}"),
      correlationId: writeRequest.correlationId,
      decidedAt: AT,
      events: [
        { eventId: "extra-event", eventType: RECOVERY_RECONCILIATION_EVENT_TYPE, payload: encoder.encode("{}") },
      ],
      expectedVersion: 1,
      key: {
        commandId: `recovery-reconcile-extra:${written.recordDigest}`,
        principalId: writeRequest.principalId,
        projectId: PROJECT_ID,
      },
      requestBytes: encoder.encode("{}"),
      targetAggregateId: aggregateId,
    });
    expect(extra.decision.effectDisposition).toBe("EFFECTS_COMMITTED");

    const read = readRecoveryReconciliation(store, PROJECT_ID, written.recordDigest);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.upstream).toEqual({
      code: "RECORD_CONFLICT",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });
  });

  it("refuses a record filed under another digest's aggregate with RECORD_CONFLICT", async () => {
    const { binding, store } = await prepare();
    const written = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    if (!written.ok) throw new Error("write must succeed");
    const foreignDigest = hex("beef");
    const bytes = encodeRecoveryReconciliationRecord(written.record);
    const response = store.commitExpectedVersionDecision({
      commandKind: RECOVERY_RECONCILIATION_COMMAND_KIND,
      committedResultBytes: bytes,
      correlationId: writeRequest.correlationId,
      decidedAt: AT,
      events: [
        { eventId: "misfiled", eventType: RECOVERY_RECONCILIATION_EVENT_TYPE, payload: bytes },
      ],
      expectedVersion: 0,
      key: {
        commandId: `recovery-reconcile:${foreignDigest}`,
        principalId: writeRequest.principalId,
        projectId: PROJECT_ID,
      },
      requestBytes: encoder.encode("{}"),
      targetAggregateId: recoveryReconciliationAggregateId(foreignDigest),
    });
    expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");

    const read = readRecoveryReconciliation(store, PROJECT_ID, foreignDigest);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.upstream).toEqual({
      code: "RECORD_CONFLICT",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });
  });
});

describe("selected-authority binding", () => {
  it("refuses to write when no ACTIVE recovery binding is installed", async () => {
    const path = join(newDirectory(), "store.sqlite");
    const store = open(path);
    const binding = await mintBinding(hex("badc0ffe"));
    expect(anchorIncarnation(store, writeRequest, binding)).toBe(true);
    const written = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.upstream).toEqual({
      code: "RECOVERY_BINDING_UNAVAILABLE",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });
  });

  it("refuses to write when the selected incarnation was never anchored", async () => {
    const path = join(newDirectory(), "store.sqlite");
    const store = open(path);
    const binding = await mintBinding(hex("badc0ffe"));
    install(store, binding.incarnationRef, binding.keyEpochRef);
    const written = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.upstream).toEqual({
      code: "RECOVERY_ANCHOR_UNAVAILABLE",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });
  });

  it("refuses when the ACTIVE key epoch disagrees with the anchored one", async () => {
    const path = join(newDirectory(), "store.sqlite");
    const store = open(path);
    const binding = await mintBinding(hex("badc0ffe"));
    expect(anchorIncarnation(store, writeRequest, binding)).toBe(true);
    install(store, binding.incarnationRef, hex("0dkey"));
    const written = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.upstream).toEqual({
      code: "RECOVERY_BINDING_MISMATCH",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });
  });

  it("refuses when the supplied backup generation is not the anchored one", async () => {
    const { store } = await prepare();
    const written = recordRecoveryReconciliation(store, writeRequest, facts(hex("dead")));
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.upstream).toEqual({
      code: "RECOVERY_BINDING_MISMATCH",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });
  });

  it("accepts no caller-selected current refs in the external facts", async () => {
    const { binding, store } = await prepare();
    const hostile = {
      ...facts(binding.backupGenerationDigest),
      incarnationRef: hex("0ther"),
      keyEpochRef: hex("0therkey"),
    } as unknown as RecoveryReconciliationExternalFacts;
    const written = recordRecoveryReconciliation(store, writeRequest, hostile);
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.upstream).toEqual({
      code: "RECOVERY_INVENTORY_INPUT_INVALID",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });
  });

  it("grants no recovery.complete authority on a successful record", async () => {
    const { binding, store } = await prepare();
    const written = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest),
    );
    if (!written.ok) throw new Error("write must succeed");
    expect(written.authority).toBe("NONE");
    expect(Object.keys(written)).toEqual([
      "authority",
      "disposition",
      "ok",
      "outcome",
      "record",
      "recordDigest",
    ]);
  });

  it("persists nothing when supplied provenance contradicts itself", async () => {
    const { binding, store } = await prepare();
    const valid = facts(binding.backupGenerationDigest);
    // Positive control first: these exact facts DO commit, so the refusals
    // below cannot be blamed on the binding, the anchor or the fixture.
    const control = recordRecoveryReconciliation(store, writeRequest, valid);
    expect(control.ok).toBe(true);
    const contradicting = facts(binding.backupGenerationDigest, {
      subjects: valid.subjects.map((subject, index) =>
        index === 0 ? { ...subject, sourceProofDigest: hex("deadbeef") } : subject,
      ),
    });
    const alien = facts(binding.backupGenerationDigest, {
      proofs: valid.proofs.map((proof, index) =>
        index === 1 ? { ...proof, class: "ALIEN" } : proof,
      ),
    });
    const expected: readonly (readonly [string, RecoveryReconciliationExternalFacts])[] = [
      ["RECOVERY_INVENTORY_ITEM_PROOF_MISMATCH", contradicting],
      ["RECOVERY_INVENTORY_PROOF_CLASS_UNKNOWN", alien],
    ];
    let swept = 0;
    for (const [code, supplied] of expected) {
      const refused = recordRecoveryReconciliation(store, writeRequest, supplied);
      expect(`${code}:${refused.ok}`).toBe(`${code}:false`);
      if (refused.ok) throw new Error("unreachable");
      expect(refused.upstream).toEqual({ code, layer: "RECOVERY_INVENTORY" });
      expect(refused.code).toBe("UNKNOWN_TRUTH");
      expect(refused.authority).toBe("NONE");
      swept += 1;
    }
    expect(swept).toBe(2);
  });
});

/**
 * ADOPTED subjects at the text cap are the widest items the builder admits:
 * identity AND restored intent ref both at full width, adopted under the
 * store-selected refs so nothing is quarantined or left UNKNOWN.
 */
const widestSubjects = (
  binding: RestoreIncarnationBinding,
  count: number,
): RecoveryReconciliationExternalFacts["subjects"] => {
  const width = MAX_RECOVERY_RECONCILIATION_TEXT_CHARS;
  const population = "RESOURCE";
  const proofClass = recoveryPopulationClass(population) as RecoveryProofClass;
  return Array.from({ length: count }, (_, index) => {
    const identity = `${String(index).padStart(6, "0")}-`.padEnd(width, "i");
    return {
      class: proofClass as string,
      evidence: {
        externalIdentity: identity,
        incarnationRef: binding.incarnationRef,
        intentDigest: hex("d0e5"),
        intentRef: `intent-${String(index).padStart(6, "0")}-`.padEnd(width, "r"),
        keyEpochRef: binding.keyEpochRef,
        kind: "RESTORED_INTENT" as const,
      },
      identity,
      population,
      sourceProofDigest: hex(`c${RECOVERY_PROOF_CLASSES.indexOf(proofClass)}`),
    };
  });
};

describe("byte cap at the writer", () => {
  it("refuses the item cap at the text cap before any write lands", async () => {
    const { binding, store } = await prepare();
    const horizon = store.readEventHorizon();
    const refused = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest, {
        subjects: widestSubjects(binding, MAX_RECOVERY_RECONCILIATION_ITEMS),
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.upstream).toEqual({
      code: "RECOVERY_INVENTORY_RECORD_OVERSIZED",
      layer: "RECOVERY_INVENTORY",
    });
    expect(refused.code).toBe("UNKNOWN_TRUTH");
    expect(refused.authority).toBe("NONE");
    // Nothing reached the store: the refusal is a decision BEFORE the commit,
    // not a commit that was later judged unreadable.
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("round-trips a record within one item of the cap through the durable read", async () => {
    const { binding, store } = await prepare();
    const measure = (count: number): number => {
      const built = recordRecoveryReconciliation(
        store,
        { ...writeRequest, correlationId: `measure-${count}` },
        facts(binding.backupGenerationDigest, { subjects: widestSubjects(binding, count) }),
      );
      if (!built.ok) throw new Error(`measurement write refused: ${built.upstream.code}`);
      return encodeRecoveryReconciliationRecord(built.record).length;
    };
    const one = measure(1);
    const perItem = measure(2) - one;
    const count = 1 + Math.floor((MAX_RECOVERY_RECONCILIATION_BYTES - one) / perItem);
    expect(count).toBeLessThan(MAX_RECOVERY_RECONCILIATION_ITEMS);

    const written = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest, { subjects: widestSubjects(binding, count) }),
    );
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("unreachable");
    const bytes = encodeRecoveryReconciliationRecord(written.record);
    expect(bytes.length).toBeLessThanOrEqual(MAX_RECOVERY_RECONCILIATION_BYTES);
    expect(bytes.length).toBeGreaterThan(MAX_RECOVERY_RECONCILIATION_BYTES - perItem);
    expect(written.record.items).toHaveLength(count);

    const read = readRecoveryReconciliation(store, PROJECT_ID, written.recordDigest);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    expect(read.record.recordDigest).toBe(written.recordDigest);
    expect(read.record.items).toHaveLength(count);
    // Byte identity through a native compare: a deep matcher walks 4 MiB of
    // elements one at a time and times the test out before it can answer.
    expect(Buffer.from(encodeRecoveryReconciliationRecord(read.record)).equals(bytes)).toBe(true);

    // One more item crosses the cap and is refused by the same writer.
    const over = recordRecoveryReconciliation(
      store,
      writeRequest,
      facts(binding.backupGenerationDigest, { subjects: widestSubjects(binding, count + 1) }),
    );
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error("unreachable");
    expect(over.upstream.code).toBe("RECOVERY_INVENTORY_RECORD_OVERSIZED");
  });
});
