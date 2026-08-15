import {
  RECOVERY_INVENTORY_CLASSES,
  collectRecoveryInventory,
  createRecoveryInventoryRegistry,
  isRecoveryInventoryFailure,
  type RecoveryInventoryItem,
  type RecoveryInventoryReport,
} from "@moe/runner";
import { adapterFail, reserveAll } from "@moe/scheduler";
import { describe, expect, it } from "vitest";

import { durableResourceObservation } from "./durable-recovery-inventory-shape.js";
import {
  RECOVERY_PROOF_CLASSES,
  type RecoveryProofClass,
} from "./recovery-inventory-contract.js";
import {
  joinEffectInventoryItems,
  nodeProofDigestMap,
  type EffectInventoryJoinRequest,
  type RestoredEffectIntent,
} from "./effect-inventory-join.js";
import { buildRecoveryReconciliationRecord } from "./recovery-inventory-record.js";

const PROJECT_TAG = "moe-project:join-test";
const HEX = (seed: string): string =>
  (seed.replace(/[^0-9a-f]/gu, "") + "0".repeat(64)).slice(0, 64);
const CURRENT = Object.freeze({
  anchorBindingDigest: HEX("a1"),
  incarnationRef: HEX("b2"),
  keyEpochRef: HEX("c3"),
});
const WINDOW = Object.freeze({
  startInclusive: "2026-08-15T00:00:00Z",
  endInclusive: "2026-08-15T23:59:59Z",
});

const workspaceItem = (identity = "workspaces/alpha/output.txt"): RecoveryInventoryItem => ({
  class: "WORKSPACE",
  projectTag: PROJECT_TAG,
  identity: { kind: "PATH", path: identity },
  observedAt: "2026-08-15T12:00:00Z",
  facts: { origin: "RESULT" },
  sourceProofDigest: HEX("d4"),
});

const artifactItem = (identity = "staging/object-a"): RecoveryInventoryItem => ({
  class: "ARTIFACT_OBJECT_STAGING",
  projectTag: PROJECT_TAG,
  identity: { kind: "PATH", path: identity },
  observedAt: "2026-08-15T12:01:00Z",
  facts: { entry: "STAGING" },
  sourceProofDigest: HEX("e5"),
});

async function collect(items: readonly RecoveryInventoryItem[]): Promise<RecoveryInventoryReport> {
  const registry = createRecoveryInventoryRegistry(
    RECOVERY_INVENTORY_CLASSES.map((inventoryClass) => ({
      class: inventoryClass,
      enumerate: () => ({
        status: "ENUMERATED",
        items: items.filter((item) => item.class === inventoryClass),
        complete: true,
        negativeProofDigest: items.some((item) => item.class === inventoryClass)
          ? null
          : HEX(`f${RECOVERY_INVENTORY_CLASSES.indexOf(inventoryClass)}`),
      }),
    })),
  );
  const report = await collectRecoveryInventory({
    projectTag: PROJECT_TAG,
    backup: { kind: "BACKUP_CURSOR_GENERATION", ref: "cursor-42", digest: HEX("a6") },
    incarnation: { kind: "RECOVERY_INCARNATION", ref: "inc-current", digest: HEX("b7") },
    window: WINDOW,
    configuredClasses: [...RECOVERY_INVENTORY_CLASSES],
  }, registry);
  if (isRecoveryInventoryFailure(report)) throw new Error(`collector refused: ${report.code}`);
  expect(report.coverage).toBe("COMPLETE");
  return report;
}

function proofMap(report: RecoveryInventoryReport): ReadonlyMap<RecoveryProofClass, string> {
  const nodeDigests = nodeProofDigestMap(report);
  expect([...nodeDigests.values()]).toEqual(
    RECOVERY_INVENTORY_CLASSES.map(() => report.inventoryDigest),
  );
  return new Map([
    ...nodeDigests,
    ["RESOURCE", HEX("a8")],
    ["INTEGRATION_TARGET", HEX("b9")],
  ] as readonly (readonly [RecoveryProofClass, string])[]);
}

const verifiedIntent = (
  overrides: Partial<RestoredEffectIntent> = {},
): RestoredEffectIntent => ({
  class: "WORKSPACE",
  externalIdentity: "workspaces/alpha/output.txt",
  population: "PROJECT_TAGGED_WORKSPACE",
  proof: {
    status: "VERIFIED",
    incarnationRef: CURRENT.incarnationRef,
    intentDigest: HEX("ca"),
    intentRef: "intent-workspace-alpha",
    keyEpochRef: CURRENT.keyEpochRef,
  },
  ...overrides,
});

async function request(
  items: readonly RecoveryInventoryItem[],
  restoredIntents: readonly RestoredEffectIntent[],
  durableItems: EffectInventoryJoinRequest["durableItems"] = [],
): Promise<EffectInventoryJoinRequest> {
  const report = await collect(items);
  return {
    durableItems,
    nodeItems: report.items,
    proofDigests: proofMap(report),
    restoredIntents,
    selected: CURRENT,
  };
}

function joined(result: ReturnType<typeof joinEffectInventoryItems>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`join refused: ${result.upstream.code}`);
  return result;
}

describe("effect inventory join dispositions", () => {
  it("adopts only an exact restored intent under the current incarnation", async () => {
    const result = joined(joinEffectInventoryItems(
      await request([workspaceItem()], [verifiedIntent()]),
    ));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      class: "WORKSPACE",
      disposition: "ADOPTED",
      restoredIntentDigest: HEX("ca"),
      restoredIntentRef: "intent-workspace-alpha",
      upstream: null,
    });
  });

  it("quarantines a prior-incarnation match with the incarnation reason code", async () => {
    const prior = verifiedIntent({
      proof: {
        status: "VERIFIED",
        incarnationRef: HEX("dead"),
        intentDigest: HEX("ca"),
        intentRef: "intent-workspace-alpha",
        keyEpochRef: CURRENT.keyEpochRef,
      },
    });
    const result = joined(joinEffectInventoryItems(await request([workspaceItem()], [prior])));
    expect(result.items[0]).toMatchObject({
      disposition: "QUARANTINED",
      restoredIntentRef: null,
      upstream: {
        code: "RECOVERY_INVENTORY_ADOPTION_INCARNATION_STALE",
        layer: "RECOVERY_INVENTORY",
      },
    });
    expect(result.items[0]?.disposition).not.toBe("ADOPTED");
  });

  it("quarantines an orphan without history insertion or repeat", async () => {
    const result = joined(joinEffectInventoryItems(await request([workspaceItem()], [])));
    expect(result.items[0]).toMatchObject({
      disposition: "QUARANTINED",
      restoredIntentDigest: null,
      restoredIntentRef: null,
      upstream: null,
    });
    expect(result.items[0]?.quarantineRef).toMatch(/^recovery-quarantine:[0-9a-f]{64}$/u);
    expect(result.historyInsertions).toEqual([]);
    expect(result.repeatRequests).toEqual([]);
    expect(Object.hasOwn(result, "restoredIntents")).toBe(false);
    expect(Object.hasOwn(result.items[0] ?? {}, "repeat")).toBe(false);
  });

  it("keeps uncertain matching evidence UNKNOWN instead of quarantining it", async () => {
    const uncertain: RestoredEffectIntent = {
      class: "WORKSPACE",
      externalIdentity: "workspaces/alpha/output.txt",
      population: "PROJECT_TAGGED_WORKSPACE",
      proof: {
        status: "UNKNOWN",
        upstream: { code: "RECOVERY_BINDING_UNAVAILABLE", layer: "INVENTORY_ADAPTER" },
      },
    };
    const join = joined(joinEffectInventoryItems(await request([workspaceItem()], [uncertain])));
    expect(join.items[0]).toMatchObject({
      disposition: "UNKNOWN",
      quarantineRef: null,
      upstream: { code: "RECOVERY_BINDING_UNAVAILABLE", layer: "INVENTORY_ADAPTER" },
    });
    const proofs = RECOVERY_PROOF_CLASSES.map((proofClass) => ({
      class: proofClass,
      sourceProofDigest: join.subjects.find((entry) => entry.class === proofClass)?.sourceProofDigest
        ?? HEX(`d${RECOVERY_PROOF_CLASSES.indexOf(proofClass)}`),
      truth: "COMPLETE" as const,
      upstream: null,
    }));
    const record = buildRecoveryReconciliationRecord({
      backupCursor: "cursor-42",
      backupGenerationDigest: HEX("ef"),
      configuredClasses: [...RECOVERY_PROOF_CLASSES],
      projectId: "proj-join",
      projectTag: PROJECT_TAG,
      proofs,
      selected: CURRENT,
      subjects: join.subjects,
    });
    expect(record.ok).toBe(true);
    if (!record.ok) throw new Error(`record refused: ${record.upstream.code}`);
    expect(record.record.truth).toBe("UNKNOWN");
    expect(record.record.coordinator).toEqual({ code: "UNKNOWN_TRUTH", layer: "RECOVERY_INVENTORY" });
    expect(record.record.items[0]?.upstream).toEqual({
      code: "RECOVERY_BINDING_UNAVAILABLE",
      layer: "INVENTORY_ADAPTER",
    });
  });

  it("classifies a scheduler-produced released resource as proven absent", async () => {
    const reserved = reserveAll({
      callerObservation: "obs-join",
      capacitySnapshot: { "resource-a": 1 },
      continuouslyEligibleSinceRef: "since-join",
      declaredResources: [{ capacityUnits: 1, external: true, fenceable: true, resourceId: "resource-a" }],
      eligibilityEventSequenceRef: "sequence-join",
      epoch: 7,
      requestId: "request-join",
    });
    if (!reserved.ok || reserved.value.outcome !== "RESERVED") throw new Error("reserveAll refused");
    const failed = adapterFail(reserved.value.rows, "resource-a", 7, "FAILED");
    if (!failed.ok) throw new Error("adapterFail refused");
    const released = failed.value.rows.find((row) => row.state === "RELEASED");
    if (released === undefined) throw new Error("scheduler did not emit RELEASED");
    const durable = durableResourceObservation(released, HEX("a8"), "000000000000000000043");
    const result = joined(joinEffectInventoryItems(await request([], [], [durable])));
    expect(result.items[0]).toMatchObject({
      class: "RESOURCE",
      disposition: "ABSENT",
      terminalProofDigest: HEX("a8"),
    });
  });
});

describe("effect inventory join determinism", () => {
  it("is byte-identical across reruns and shuffled input", async () => {
    const items = [artifactItem(), workspaceItem()];
    const intents = [
      verifiedIntent(),
      {
        class: "ARTIFACT_OBJECT_STAGING" as const,
        externalIdentity: "staging/object-a",
        population: "ARTIFACT_STAGING" as const,
        proof: {
          status: "VERIFIED" as const,
          incarnationRef: CURRENT.incarnationRef,
          intentDigest: HEX("ab"),
          intentRef: "intent-artifact-a",
          keyEpochRef: CURRENT.keyEpochRef,
        },
      },
    ];
    const original = joined(joinEffectInventoryItems(await request(items, intents)));
    const rerun = joined(joinEffectInventoryItems(await request(items, intents)));
    const shuffled = joined(joinEffectInventoryItems(await request([...items].reverse(), [...intents].reverse())));
    expect(JSON.stringify(rerun.items)).toBe(JSON.stringify(original.items));
    expect(JSON.stringify(shuffled.items)).toBe(JSON.stringify(original.items));
    expect(original.items.map((entry) => entry.class)).toEqual([
      "WORKSPACE", "ARTIFACT_OBJECT_STAGING",
    ]);
  });
});
