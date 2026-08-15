import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RECOVERY_BINDING_CODEC_VERSION,
  SqliteEventStore,
} from "@moe/store";
import {
  RECOVERY_INVENTORY_CLASSES,
  type RecoveryInventoryClass,
  type RecoveryInventoryRegistration,
} from "@moe/runner";
import { afterEach, describe, expect, it } from "vitest";

import { anchorIncarnation } from "./recovery-incarnation-anchor.js";
import { createNodeRecoveryCryptoPort } from "./recovery-incarnation.node.js";
import { createRecoveryIncarnationService } from "./recovery-incarnation.js";
import type { RestoreIncarnationBinding } from "./recovery-incarnation-contract.js";
import {
  RECOVERY_CLASS_POPULATION_ROWS,
  RECOVERY_INVENTORY_POPULATIONS,
  RECOVERY_PROOF_CLASSES,
} from "./recovery-inventory-contract.js";
import { buildRecoveryReconciliationRecord } from "./recovery-inventory-record.js";
import {
  appendDurableInventoryObservation,
  sealDurableInventoryWindow,
} from "./durable-recovery-inventory.js";
import type {
  DurableInventoryBasis,
  DurableInventoryWindow,
} from "./durable-recovery-inventory-contract.js";
import {
  reconcileEffectInventory,
  type EffectInventoryConfiguration,
  type EffectInventoryRequest,
  type RestoredEffectIntent,
} from "./effect-inventory.js";

const PROJECT_ID = "proj-effect-inventory";
const PROJECT_TAG = "moe-project:proj-effect-inventory";
const AT = "2026-08-15T00:00:00.000Z";
const CURSOR = "000000000000000000042";
const END = "000000000000000000100";
const HEX = (seed: string): string =>
  (seed.replace(/[^0-9a-f]/gu, "") + "0".repeat(64)).slice(0, 64);

const stores: SqliteEventStore[] = [];
const directories: string[] = [];
const encoder = new TextEncoder();

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { force: true, recursive: true });
  }
});

async function prepare(): Promise<{
  binding: RestoreIncarnationBinding;
  store: SqliteEventStore;
}> {
  const directory = mkdtempSync(join(tmpdir(), "moe-effect-inventory-"));
  directories.push(directory);
  const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), PROJECT_ID);
  stores.push(store);
  const service = createRecoveryIncarnationService(createNodeRecoveryCryptoPort());
  const minted = await service.mint({
    backupGenerationDigest: HEX("badc0ffe"),
    restoreCommandId: "restore-effect-inventory",
  });
  if (!minted.ok) throw new Error(`mint refused: ${minted.code}`);
  expect(anchorIncarnation(store, writeRequest(), minted.binding)).toBe(true);
  const installed = store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: minted.binding.incarnationRef,
    installedAt: AT,
    keyEpochRef: minted.binding.keyEpochRef,
    payload: encoder.encode("recovery-binding-payload"),
    slot: "ACTIVE",
  });
  expect(installed.ok).toBe(true);
  return { binding: minted.binding, store };
}

const writeRequest = () => ({
  correlationId: "corr-effect-inventory",
  decidedAt: AT,
  principalId: "principal-effect-inventory",
  projectId: PROJECT_ID,
});

const basisFor = (binding: RestoreIncarnationBinding): DurableInventoryBasis => ({
  backupCursor: CURSOR,
  backupGenerationDigest: binding.backupGenerationDigest,
  projectTag: PROJECT_TAG,
});

const durableWindow: DurableInventoryWindow = {
  startExclusive: CURSOR,
  endInclusive: END,
};

function sealEmpty(store: SqliteEventStore, binding: RestoreIncarnationBinding): void {
  const sealed = sealDurableInventoryWindow(
    store,
    writeRequest(),
    basisFor(binding),
    durableWindow,
    [
      { class: "RESOURCE", negativeProofDigest: HEX("e1"), sourceProofDigest: HEX("a1") },
      { class: "INTEGRATION_TARGET", negativeProofDigest: HEX("e2"), sourceProofDigest: HEX("b2") },
    ],
  );
  if (!sealed.ok) throw new Error(`seal refused: ${sealed.upstream.code}`);
}

const completeRegistration = (
  inventoryClass: RecoveryInventoryClass,
  items: readonly unknown[] = [],
  negativeProofDigest: string | null = HEX(`f${RECOVERY_INVENTORY_CLASSES.indexOf(inventoryClass)}`),
): RecoveryInventoryRegistration => Object.freeze({
  class: inventoryClass,
  enumerate: () => ({ status: "ENUMERATED", items, complete: true, negativeProofDigest }),
});

const completeConfiguration = (): EffectInventoryConfiguration => ({
  nodeRegistrations: RECOVERY_INVENTORY_CLASSES.map((entry) => completeRegistration(entry)),
});

function request(
  binding: RestoreIncarnationBinding,
  restoredIntents: readonly RestoredEffectIntent[] = [],
): EffectInventoryRequest {
  return {
    ...writeRequest(),
    backupCursor: CURSOR,
    backupGenerationDigest: binding.backupGenerationDigest,
    durableWindow,
    nodeWindow: {
      startInclusive: "2026-08-15T00:00:00Z",
      endInclusive: "2026-08-15T23:59:59Z",
    },
    projectTag: PROJECT_TAG,
    restoredIntents,
  };
}

const expectUnknown = (
  result: Awaited<ReturnType<typeof reconcileEffectInventory>>,
  code: string,
  layer: string,
): void => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected recovery inventory hold");
  expect(result.code).toBe("UNKNOWN_TRUTH");
  expect(result.layer).toBe("RECOVERY_INVENTORY");
  expect(result.upstream).toEqual({ code, layer });
  expect(result.truth).toBe("UNKNOWN");
  expect(result.authority).toBe("NONE");
};

describe("effect inventory frozen cardinality", () => {
  it("pins six proof classes and seven populations by literal name", () => {
    expect(RECOVERY_PROOF_CLASSES).toHaveLength(6);
    expect([...RECOVERY_PROOF_CLASSES]).toEqual([
      "PROVIDER_PROCESS_LAUNCH_LOCK", "RESOURCE", "WORKSPACE",
      "INTEGRATION_TARGET", "GIT_INTEGRATION_ON_DISK", "ARTIFACT_OBJECT_STAGING",
    ]);
    expect(RECOVERY_INVENTORY_POPULATIONS).toHaveLength(7);
    expect([...RECOVERY_INVENTORY_POPULATIONS]).toEqual([
      "EFFECT_LOCK_WRAPPER_REGISTRATION", "PROVIDER_RUN", "RESOURCE",
      "PROJECT_TAGGED_WORKSPACE", "INTEGRATION_TARGET", "GIT_BRANCH_REF",
      "ARTIFACT_STAGING",
    ]);
  });

  it("maps every population exactly once across the six canonical rows", () => {
    expect(RECOVERY_CLASS_POPULATION_ROWS).toHaveLength(6);
    const generated = RECOVERY_CLASS_POPULATION_ROWS.flatMap((row) => row.populations);
    expect(generated).toHaveLength(7);
    expect(generated).toEqual(RECOVERY_INVENTORY_POPULATIONS);
    expect(new Set(generated).size).toBe(7);
  });
});

describe("effect inventory configured coverage", () => {
  const selected = {
    anchorBindingDigest: HEX("a0"),
    incarnationRef: HEX("b0"),
    keyEpochRef: HEX("c0"),
  };
  const base = {
    backupCursor: CURSOR,
    backupGenerationDigest: HEX("d0"),
    projectId: PROJECT_ID,
    projectTag: PROJECT_TAG,
    proofs: [],
    selected,
    subjects: [],
  };

  it("pins omitted, duplicate, unknown, and extra configuration codes", () => {
    const cases: readonly [string, readonly string[], string][] = [
      ["omitted", RECOVERY_PROOF_CLASSES.slice(0, -1), "RECOVERY_INVENTORY_CLASS_OMITTED"],
      ["duplicate", [...RECOVERY_PROOF_CLASSES.slice(0, -1), RECOVERY_PROOF_CLASSES[0]], "RECOVERY_INVENTORY_CLASS_DUPLICATE"],
      ["unknown", [...RECOVERY_PROOF_CLASSES.slice(0, -1), "NETWORK_SOCKET"], "RECOVERY_INVENTORY_CLASS_UNKNOWN"],
      ["extra", [...RECOVERY_PROOF_CLASSES, RECOVERY_PROOF_CLASSES[0]], "RECOVERY_INVENTORY_CLASS_EXTRA"],
    ];
    expect(cases).toHaveLength(4);
    for (const [label, configuredClasses, code] of cases) {
      const result = buildRecoveryReconciliationRecord({ ...base, configuredClasses });
      expect(result.ok, label).toBe(false);
      if (result.ok) throw new Error(`expected ${label} refusal`);
      expect(result.code, label).toBe("UNKNOWN_TRUTH");
      expect(result.layer, label).toBe("RECOVERY_INVENTORY");
      expect(result.upstream, label).toEqual({ code, layer: "RECOVERY_INVENTORY" });
    }
  });

  it("accepts exactly one complete cursor/incarnation-bound proof per class", async () => {
    const { binding, store } = await prepare();
    sealEmpty(store, binding);
    const result = await reconcileEffectInventory(store, request(binding), completeConfiguration());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected hold: ${result.upstream.code}`);
    expect(result.record.truth).toBe("COMPLETE");
    expect(result.record.configuredClasses).toEqual(RECOVERY_PROOF_CLASSES);
    expect(result.record.proofs).toHaveLength(6);
  });
});

describe("effect inventory fail-closed coverage", () => {
  it("does not treat a quiet empty enumerator as complete coverage", async () => {
    const { binding, store } = await prepare();
    sealEmpty(store, binding);
    const registrations = RECOVERY_INVENTORY_CLASSES.map((entry) =>
      completeRegistration(entry, [], entry === "WORKSPACE" ? null : HEX(`f${entry}`)),
    );
    const result = await reconcileEffectInventory(store, request(binding), { nodeRegistrations: registrations });
    expectUnknown(result, "RECOVERY_INVENTORY_COVERAGE_UNKNOWN", "INVENTORY_ADAPTER");
  });

  it("retains missing durable inventory as RECORD_NOT_FOUND from its adapter", async () => {
    const { binding, store } = await prepare();
    const result = await reconcileEffectInventory(store, request(binding), completeConfiguration());
    expectUnknown(result, "RECORD_NOT_FOUND", "INVENTORY_ADAPTER");
  });

  it("retains node adapter uncertainty instead of restamping it", async () => {
    const { binding, store } = await prepare();
    sealEmpty(store, binding);
    const registrations = RECOVERY_INVENTORY_CLASSES.map((entry) =>
      entry === "GIT_INTEGRATION_ON_DISK"
        ? Object.freeze({ class: entry, enumerate: () => ({ status: "UNAVAILABLE" }) })
        : completeRegistration(entry),
    );
    const result = await reconcileEffectInventory(store, request(binding), { nodeRegistrations: registrations });
    expectUnknown(result, "RECOVERY_INVENTORY_COVERAGE_UNKNOWN", "INVENTORY_ADAPTER");
  });

  it("holds a live non-fenceable resource as an unresolved item", async () => {
    const { binding, store } = await prepare();
    const appended = appendDurableInventoryObservation(
      store,
      writeRequest(),
      basisFor(binding),
      durableWindow,
      {
        capacityUnits: 1,
        class: "RESOURCE",
        effectIntentRef: "intent-resource",
        epoch: 3,
        external: true,
        fenceability: "NON_FENCEABLE",
        observedPosition: "000000000000000000043",
        resourceId: "resource-live",
        sourceProofDigest: HEX("a1"),
        state: "ACTIVE",
      },
    );
    if (!appended.ok) throw new Error(`append refused: ${appended.upstream.code}`);
    sealEmpty(store, binding);
    const result = await reconcileEffectInventory(store, request(binding), completeConfiguration());
    expectUnknown(result, "RECOVERY_INVENTORY_ITEM_UNRESOLVED", "INVENTORY_ADAPTER");
  });

  it("holds an artifact whose restored-intent key proof is unverifiable", async () => {
    const { binding, store } = await prepare();
    sealEmpty(store, binding);
    const artifact = {
      class: "ARTIFACT_OBJECT_STAGING",
      projectTag: PROJECT_TAG,
      identity: { kind: "PATH", path: "staging/object-a" },
      observedAt: "2026-08-15T12:00:00Z",
      facts: { entry: "STAGING" },
      sourceProofDigest: HEX("a7"),
    };
    const registrations = RECOVERY_INVENTORY_CLASSES.map((entry) =>
      entry === "ARTIFACT_OBJECT_STAGING"
        ? completeRegistration(entry, [artifact], null)
        : completeRegistration(entry),
    );
    const restored: RestoredEffectIntent = {
      class: "ARTIFACT_OBJECT_STAGING",
      externalIdentity: "staging/object-a",
      population: "ARTIFACT_STAGING",
      proof: {
        status: "UNKNOWN",
        upstream: { code: "RECOVERY_BINDING_UNAVAILABLE", layer: "INVENTORY_ADAPTER" },
      },
    };
    const result = await reconcileEffectInventory(
      store,
      request(binding, [restored]),
      { nodeRegistrations: registrations },
    );
    expectUnknown(result, "RECOVERY_BINDING_UNAVAILABLE", "INVENTORY_ADAPTER");
  });

  it("holds an item whose population cannot be established", async () => {
    const { binding, store } = await prepare();
    sealEmpty(store, binding);
    const ambiguous = {
      class: "PROVIDER_PROCESS_LAUNCH_LOCK",
      projectTag: PROJECT_TAG,
      identity: { kind: "OPAQUE", id: "mystery-provider-row" },
      observedAt: "2026-08-15T12:00:00Z",
      facts: { source: "UNVERIFIED" },
      sourceProofDigest: HEX("b7"),
    };
    const registrations = RECOVERY_INVENTORY_CLASSES.map((entry) =>
      entry === "PROVIDER_PROCESS_LAUNCH_LOCK"
        ? completeRegistration(entry, [ambiguous], null)
        : completeRegistration(entry),
    );
    const result = await reconcileEffectInventory(store, request(binding), { nodeRegistrations: registrations });
    expectUnknown(result, "RECOVERY_INVENTORY_ITEM_UNRESOLVED", "INVENTORY_ADAPTER");
  });
});
