import { afterEach, describe, expect, it } from "vitest";

import {
  RECOVERY_BINDING_CODEC_VERSION,
} from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { createRestorePort } from "./restore-controller-commands.js";
import {
  RESTORE_CONTROLLER_LAYER,
  RESTORE_CONTROLLER_SCHEMA_VERSION,
  encodeRestoreRecord,
  preparedRestoreIdentity,
} from "./restore-controller-contract.js";
import type {
  InstalledRestoreRecord,
  RestoreControllerRequest,
  RestoreRefused,
} from "./restore-controller-contract.js";
import {
  PROJECT_ID,
  anchoredIncarnation,
  cleanupRestoreHarnesses,
  openHarnessStore,
  restoreHarness,
  restoreRequest,
} from "./restore-test-harness.js";

afterEach(cleanupRestoreHarnesses);

type RequestMutation = (request: RestoreControllerRequest) => void;

const HOSTILE_ARRAY_CASES: readonly [string, RequestMutation][] = [
  ["logicalPaths iterator", (request) => {
    Object.defineProperty(request.logicalPaths, Symbol.iterator, {
      value: function* smuggledPaths() { yield "ghost/object.bin"; },
    });
  }],
  ["faults iterator", (request) => {
    const faults = request.faults;
    if (faults === undefined) throw new Error("expected fault fixture");
    Object.defineProperty(faults, Symbol.iterator, {
      value: function* smuggledFaults() { /* omit the declared fault */ },
    });
  }],
];

function expectUnreadable(result: RestoreRefused | { readonly ok: true }): void {
  expect(result).toMatchObject({
    code: "RESTORE_RECORD_UNREADABLE",
    layer: RESTORE_CONTROLLER_LAYER,
    ok: false,
    outcome: "REFUSED",
  });
}

describe("restore controller QA regressions", () => {
  it("publishes quiesced recovery state through the canonical fold after reopen", async () => {
    const harness = await restoreHarness("canonical-fold");
    const binding = await anchoredIncarnation(harness, "restore-canonical-fold");

    const settled = createRestorePort(harness.store, PROJECT_ID)
      .resume(restoreRequest(harness, binding));

    expect(settled).toMatchObject({ ok: true, disposition: "QUIESCED" });
    harness.store.close();
    const reopened = openHarnessStore(harness.storePath);
    const state = stateOf(readDurableLedger(reopened, PROJECT_ID), PROJECT_ID);
    expect(state).toMatchObject({
      lifecycle: "QUIESCED",
      recoveryRequired: true,
      version: 4,
    });
    expect(reopened.readRecoveryBinding("ACTIVE")).toMatchObject({
      binding: {
        incarnationRef: binding.incarnationRef,
        keyEpochRef: binding.keyEpochRef,
      },
      ok: true,
      outcome: "FOUND",
    });
  });

  it("rejects a stateful project accessor before it can cross the scoped port", async () => {
    const harness = await restoreHarness("stateful-project");
    const binding = await anchoredIncarnation(harness, "restore-stateful-project");
    const request = { ...restoreRequest(harness, binding) };
    let reads = 0;
    Object.defineProperty(request, "projectId", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads <= 2 ? PROJECT_ID : "foreign-project";
      },
    });

    const result = createRestorePort(harness.store, PROJECT_ID).resume(request);

    expect(result).toMatchObject({
      code: "RESTORE_REQUEST_SHAPE_INVALID",
      layer: RESTORE_CONTROLLER_LAYER,
      ok: false,
      outcome: "REFUSED",
    });
    expect(reads).toBe(0);
  });

  it.each(HOSTILE_ARRAY_CASES)("rejects custom %s behavior at the shape layer", async (
    _name,
    mutate,
  ) => {
    const suffix = _name.startsWith("logical") ? "paths" : "faults";
    const harness = await restoreHarness(`hostile-array-${suffix}`);
    const binding = await anchoredIncarnation(harness, `restore-hostile-${suffix}`);
    const request = restoreRequest(harness, binding, {
      faults: ["AFTER_REDUCER_BEFORE_COMMIT"],
    });
    mutate(request);

    const result = createRestorePort(harness.store, PROJECT_ID).resume(request);

    expect(result).toMatchObject({
      code: "RESTORE_REQUEST_SHAPE_INVALID",
      layer: RESTORE_CONTROLLER_LAYER,
      ok: false,
      outcome: "REFUSED",
    });
  });

  it("generates exactly two hostile array cases", () => {
    expect(HOSTILE_ARRAY_CASES).toHaveLength(2);
  });

  it("rejects both ACTIVE envelope fences when they disagree with the payload", async () => {
    const harness = await restoreHarness("outer-fences");
    const binding = await anchoredIncarnation(harness, "restore-outer-fences");
    const record: InstalledRestoreRecord = Object.freeze({
      generationDigest: harness.generationDigest,
      incarnationRef: binding.incarnationRef,
      keyEpochRef: binding.keyEpochRef,
      preparedIdentity: preparedRestoreIdentity({
        generationDigest: harness.generationDigest,
        incarnationRef: binding.incarnationRef,
        keyEpochRef: binding.keyEpochRef,
        restoreCommandId: binding.restoreCommandId,
      }),
      restoreCommandId: binding.restoreCommandId,
      schemaVersion: RESTORE_CONTROLLER_SCHEMA_VERSION,
    });
    const cases = [
      { incarnationRef: "d".repeat(64), keyEpochRef: binding.keyEpochRef },
      { incarnationRef: binding.incarnationRef, keyEpochRef: "e".repeat(64) },
    ];

    for (const outer of cases) {
      expect(harness.store.installRecoveryBinding({
        bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
        incarnationRef: outer.incarnationRef,
        installedAt: "2026-08-12T00:00:00.000Z",
        keyEpochRef: outer.keyEpochRef,
        payload: encodeRestoreRecord(record),
        slot: "ACTIVE",
      })).toMatchObject({ ok: true, outcome: "INSTALLED" });
      expectUnreadable(createRestorePort(harness.store, PROJECT_ID).inspect());
    }
    expect(cases).toHaveLength(2);
  });
});
