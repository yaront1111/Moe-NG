import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECOVERY_BINDING_CODEC_VERSION } from "@moe/store";

import { OBSERVATION } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  PROJECT_ID,
  SEEDED_EVENT_TYPES,
  anchorInto,
  anchoredIncarnation,
  cleanupRestoreHarnesses,
  committedEventTypes,

  openHarnessStore,
  projectLifecycle,
  restoreHarness,
  restoreRequest,
} from "./restore-test-harness.js";
import { createRestorePort } from "./restore-controller-commands.js";
import {
  RESTORE_CONTROLLER_FAULT_POINTS,
  RESTORE_CONTROLLER_LAYER,
  RESTORE_CONTROLLER_REASON_CODES,
  RESTORE_CONTROLLER_SCHEMA_VERSION,
  preparedRestoreIdentity,
} from "./restore-controller-contract.js";
import { runRestoreQuiesce } from "./restore-controller.js";

/**
 * The daemon restore controller against REAL composed authority: production
 * `createBackupGeneration`/`verifyBackupGeneration`, the production incarnation
 * mint and anchor, the real `@moe/core` reducer, and a real file-backed
 * `SqliteEventStore`. Every refusal pins its stable code AND the layer that
 * answered, because a test asserting only `ok === false` stays green once a
 * second layer starts refusing first.
 */

afterEach(cleanupRestoreHarnesses);

function expectRefusal(result: { readonly ok: boolean }, layer: string, code: string): void {
  expect(result).toMatchObject({
    authority: "NONE",
    code,
    layer,
    ok: false,
    outcome: "REFUSED",
    truth: "UNKNOWN",
  });
  expect(Object.isFrozen(result)).toBe(true);
}

describe("restore controller — composes the REAL core reducer", () => {
  it("surfaces the core's own EXPECTED_VERSION_CONFLICT once the project head moved", async () => {
    const h = await restoreHarness("version");
    const first = await anchoredIncarnation(h, "restore-cmd-1");
    expect(runRestoreQuiesce(h.store, restoreRequest(h, first)).ok).toBe(true);

    // A brand-new restore command with a wholly fresh fence. The first quiesce
    // advanced the event stream, so the reducer is asked at the store's real
    // head against a folded state one version behind — and refuses itself.
    const second = await anchoredIncarnation(h, "restore-cmd-2");
    const result = runRestoreQuiesce(h.store, restoreRequest(h, second));

    expectRefusal(result, "PROJECT_REDUCER", "EXPECTED_VERSION_CONFLICT");
    if (result.ok) throw new Error("expected a refusal");
    // Only `createRuntimeError` produces this envelope. A local lifecycle check
    // admitting the same states could not carry the registry metadata, and would
    // never have refused a lifecycle that is still admissible.
    expect(result.error).toMatchObject({
      code: "EXPECTED_VERSION_CONFLICT",
      details: { actualVersion: 3, expectedVersion: 4 },
      recoveryCategory: "REFRESH",
      retryability: "AFTER_REFRESH",
      truthClass: "DAEMON_VERIFIED",
    });
  });

  it("surfaces the core's own UNKNOWN_ERROR for a project the ledger never registered", async () => {
    const h = await restoreHarness("unregistered");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");
    // A second, empty store: the incarnation is anchored there, but no project
    // was ever registered, so the reducer has no prior state to reduce against.
    const empty = openHarnessStore(join(h.root, "empty.db"));
    anchorInto(empty, binding);

    const result = runRestoreQuiesce(empty, restoreRequest(h, binding));

    expectRefusal(result, "PROJECT_REDUCER", "UNKNOWN_ERROR");
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toMatchObject({ recoveryCategory: "NONE", truthClass: "UNKNOWN" });
  });

  it("commits the reducer's own ProjectQuiesced event and its own next state", async () => {
    const h = await restoreHarness("accept");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");

    const result = runRestoreQuiesce(h.store, restoreRequest(h, binding));

    if (!result.ok || result.disposition !== "QUIESCED") throw new Error("expected a quiesce");
    expect(result.event).toEqual({
      commandId: "restore-cmd-1",
      kind: "ProjectQuiesced",
      version: 4,
      witness: {
        backupGenerationHash: h.generationDigest,
        recoveryIncarnationRef: binding.incarnationRef,
        truthClass: "DAEMON_VERIFIED",
      },
    });
    // The reducer's own next state: QUIESCED, recovery required, version bumped,
    // and the observations carried across by its `clonedState`.
    expect(result.state).toMatchObject({
      lifecycle: "QUIESCED",
      owner: "owner-1",
      projectId: PROJECT_ID,
      recoveryRequired: true,
      repositoryObservations: [OBSERVATION],
      version: 4,
    });
    expect(committedEventTypes(h.store)).toEqual([...SEEDED_EVENT_TYPES, "ProjectQuiesced"]);
  });

  it("uses one durable head observation for both reducer and transaction", async () => {
    const h = await restoreHarness("single-head");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");
    let headReads = 0;
    const counted = new Proxy(h.store, {
      get(target, property): unknown {
        if (property === "getAggregateVersion") {
          return (aggregateId: string): number => {
            headReads += 1;
            return target.getAggregateVersion(aggregateId);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = runRestoreQuiesce(counted, restoreRequest(h, binding));

    expect(result.ok).toBe(true);
    expect(headReads).toBe(1);
  });
});

describe("restore controller — one transaction, never a mixed state", () => {
  it("generates every declared failure injection and leaves the prior state intact", async () => {
    const generated: string[] = [];
    for (const faultPoint of RESTORE_CONTROLLER_FAULT_POINTS) {
      const h = await restoreHarness(`fault-${generated.length}`);
      const binding = await anchoredIncarnation(h, "restore-cmd-1");
      const versionBefore = h.store.getAggregateVersion(PROJECT_ID);

      const result = runRestoreQuiesce(
        h.store,
        restoreRequest(h, binding, { faults: [faultPoint] }),
      );

      expectRefusal(result, RESTORE_CONTROLLER_LAYER, "RESTORE_INTERRUPTED");
      // BOTH halves. Asserting one alone would pass while the other committed,
      // which is exactly the mixed state this guarantee forbids.
      expect(h.store.getAggregateVersion(PROJECT_ID)).toBe(versionBefore);
      expect(committedEventTypes(h.store)).toEqual([...SEEDED_EVENT_TYPES]);
      expect(projectLifecycle(h.store)).toBe("READY");
      expect(h.store.readRecoveryBinding("ACTIVE")).toMatchObject({ ok: true, outcome: "ABSENT" });
      generated.push(faultPoint);
    }
    // A sweep that produced zero cases would otherwise pass while testing nothing.
    expect(generated.length).toBeGreaterThan(0);
    expect(generated).toEqual(["AFTER_REDUCER_BEFORE_COMMIT", "INSIDE_COMMIT_APPLY"]);
    expect(RESTORE_CONTROLLER_FAULT_POINTS).toHaveLength(2);
  });

  it("installs the binding and the lifecycle event together on success", async () => {
    const h = await restoreHarness("together");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");

    const result = runRestoreQuiesce(h.store, restoreRequest(h, binding));

    if (!result.ok) throw new Error("expected a quiesce");
    expect(committedEventTypes(h.store)).toContain("ProjectQuiesced");
    expect(h.store.readRecoveryBinding("ACTIVE")).toMatchObject({
      binding: {
        bindingCodecVersion: "moe-recovery-binding/1",
        incarnationRef: binding.incarnationRef,
        keyEpochRef: binding.keyEpochRef,
        slot: "ACTIVE",
      },
      bindingDigest: result.bindingDigest,
      ok: true,
      outcome: "FOUND",
    });
  });
});

describe("restore controller — refusals name their code and their layer", () => {
  it("refuses an unanchored signing key with the store's own backup reason", async () => {
    const h = await restoreHarness("untrusted");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");

    const result = runRestoreQuiesce(
      h.store,
      restoreRequest(h, binding, { trust: { anchoredKeys: [] } }),
    );

    expectRefusal(result, "BACKUP_GENERATION", "KEY_CHAIN_UNTRUSTED");
  });

  it("refuses an inventory the generation never declared, at the store's layer", async () => {
    const h = await restoreHarness("inventory");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");

    const result = runRestoreQuiesce(
      h.store,
      restoreRequest(h, binding, { logicalPaths: ["ghost/object.bin"] }),
    );

    expectRefusal(result, "BACKUP_GENERATION", "INVENTORY_MISMATCH");
  });

  it("maps throwing generation evidence to the backup layer for every command", async () => {
    const generated: string[] = [];
    for (const operation of ["resume", "discard"] as const) {
      const h = await restoreHarness(`throwing-trust-${operation}`);
      const binding = await anchoredIncarnation(h, "restore-cmd-1");
      const trust = new Proxy({}, { get: () => { throw new Error("hostile evidence"); } });
      const port = createRestorePort(h.store, PROJECT_ID);

      const result = port[operation](restoreRequest(h, binding, { trust }));

      expectRefusal(result, "BACKUP_GENERATION", "REQUEST_SHAPE_INVALID");
      generated.push(operation);
    }
    expect(generated.length).toBeGreaterThan(0);
    expect(generated).toEqual(["resume", "discard"]);
  });

  it("refuses an incarnation nothing anchored", async () => {
    const h = await restoreHarness("unanchored");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");

    const result = runRestoreQuiesce(
      h.store,
      restoreRequest(h, binding, { incarnationRef: "f".repeat(64) }),
    );

    expectRefusal(result, RESTORE_CONTROLLER_LAYER, "RESTORE_INCARNATION_UNANCHORED");
  });

  it("refuses a key epoch the anchored incarnation does not carry", async () => {
    const h = await restoreHarness("epoch");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");

    const result = runRestoreQuiesce(
      h.store,
      restoreRequest(h, binding, { keyEpochRef: "a".repeat(64) }),
    );

    expectRefusal(result, RESTORE_CONTROLLER_LAYER, "RESTORE_KEY_EPOCH_MISMATCH");
  });

  it("refuses a command id the anchored incarnation was not minted for", async () => {
    const h = await restoreHarness("command-binding");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");

    const result = runRestoreQuiesce(
      h.store,
      restoreRequest(h, binding, { restoreCommandId: "restore-cmd-2" }),
    );

    expectRefusal(result, RESTORE_CONTROLLER_LAYER, "RESTORE_COMMAND_NOT_BOUND");
  });

  it("refuses a generation the anchored incarnation is not bound to", async () => {
    const h = await restoreHarness("unbound");
    const other = await restoreHarness("unbound-other");
    // Minted for a DIFFERENT generation, then anchored in this store: the row
    // exists, so only the cross-check between the two can refuse it.
    const foreign = await h.mint(other.generationDigest, "restore-cmd-1");
    anchorInto(h.store, foreign);

    const result = runRestoreQuiesce(h.store, restoreRequest(h, foreign));

    expectRefusal(result, RESTORE_CONTROLLER_LAYER, "RESTORE_GENERATION_NOT_BOUND");
  });

  it("refuses a request that is not shaped like a restore command", async () => {
    const h = await restoreHarness("shape");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");

    const result = runRestoreQuiesce(
      h.store,
      restoreRequest(h, binding, { restoreCommandId: "" }),
    );

    expectRefusal(result, RESTORE_CONTROLLER_LAYER, "RESTORE_REQUEST_SHAPE_INVALID");
  });

  it("declares exactly the reason codes this layer can raise", () => {
    expect([...RESTORE_CONTROLLER_REASON_CODES]).toEqual([
      "RESTORE_ALREADY_SETTLED",
      "RESTORE_COMMAND_NOT_BOUND",
      "RESTORE_FENCE_REPLAYED",
      "RESTORE_GENERATION_NOT_BOUND",
      "RESTORE_INCARNATION_UNANCHORED",
      "RESTORE_INTERRUPTED",
      "RESTORE_KEY_EPOCH_MISMATCH",
      "RESTORE_RECORD_UNREADABLE",
      "RESTORE_REQUEST_SHAPE_INVALID",
    ]);
  });
});

describe("restore controller — prepared identity, resume and replay", () => {
  it("reuses the prepared identity when the same prepared command resumes", async () => {
    const h = await restoreHarness("resume");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");
    const port = createRestorePort(h.store, PROJECT_ID);
    const request = restoreRequest(h, binding);

    const first = port.resume(request);
    const second = port.resume(request);
    const third = port.resume(request);

    if (!first.ok || !second.ok || !third.ok) throw new Error("expected three settled results");
    expect(first.disposition).toBe("QUIESCED");
    expect(second.disposition).toBe("ALREADY_QUIESCED");
    expect(third.disposition).toBe("ALREADY_QUIESCED");
    expect(second.preparedIdentity).toBe(first.preparedIdentity);
    expect(third.preparedIdentity).toBe(first.preparedIdentity);
    // Derived, never minted: the same inputs reproduce it without the store.
    expect(first.preparedIdentity).toBe(
      preparedRestoreIdentity({
        generationDigest: h.generationDigest,
        incarnationRef: binding.incarnationRef,
        keyEpochRef: binding.keyEpochRef,
        restoreCommandId: binding.restoreCommandId,
      }),
    );
    // Re-resuming committed nothing further.
    expect(committedEventTypes(h.store)).toEqual([...SEEDED_EVENT_TYPES, "ProjectQuiesced"]);
  });

  it("binds the generation, incarnation, key epoch and command into the identity", () => {
    const parts = {
      generationDigest: "1".repeat(64),
      incarnationRef: "2".repeat(64),
      keyEpochRef: "3".repeat(64),
      restoreCommandId: "restore-cmd-1",
    };
    const identity = preparedRestoreIdentity(parts);

    expect(preparedRestoreIdentity({ ...parts, keyEpochRef: "4".repeat(64) })).not.toBe(identity);
    expect(preparedRestoreIdentity({ ...parts, incarnationRef: "5".repeat(64) })).not.toBe(identity);
    expect(preparedRestoreIdentity({ ...parts, restoreCommandId: "cmd-2" })).not.toBe(identity);
    expect(preparedRestoreIdentity({ ...parts, generationDigest: "6".repeat(64) })).not.toBe(identity);
    expect(identity).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses a new command that reuses the installed KEY EPOCH", async () => {
    const h = await restoreHarness("replay-epoch");
    const first = await anchoredIncarnation(h, "restore-cmd-1");
    expect(runRestoreQuiesce(h.store, restoreRequest(h, first)).ok).toBe(true);
    const fresh = await anchoredIncarnation(h, "restore-cmd-2");

    // A fresh incarnation carrying the PREDECESSOR's key epoch: the old signing
    // key would still fence, so this is a replay however new the incarnation is.
    const result = runRestoreQuiesce(
      h.store,
      restoreRequest(h, fresh, { keyEpochRef: first.keyEpochRef }),
    );

    expectRefusal(result, RESTORE_CONTROLLER_LAYER, "RESTORE_FENCE_REPLAYED");
  });

  it("refuses a new command that reuses the installed INCARNATION", async () => {
    const h = await restoreHarness("replay-incarnation");
    const first = await anchoredIncarnation(h, "restore-cmd-1");
    expect(runRestoreQuiesce(h.store, restoreRequest(h, first)).ok).toBe(true);
    const fresh = await anchoredIncarnation(h, "restore-cmd-2");

    const result = runRestoreQuiesce(
      h.store,
      restoreRequest(h, fresh, { incarnationRef: first.incarnationRef }),
    );

    expectRefusal(result, RESTORE_CONTROLLER_LAYER, "RESTORE_FENCE_REPLAYED");
  });
});

describe("restore controller — inspect and discard", () => {
  it("reports ABSENT before any restore and mutates nothing while reading", async () => {
    const h = await restoreHarness("inspect-absent");
    const port = createRestorePort(h.store, PROJECT_ID);
    const versionBefore = h.store.getAggregateVersion(PROJECT_ID);

    expect(port.inspect()).toEqual({ ok: true, outcome: "ABSENT" });
    expect(port.inspect()).toEqual({ ok: true, outcome: "ABSENT" });

    expect(h.store.getAggregateVersion(PROJECT_ID)).toBe(versionBefore);
    expect(committedEventTypes(h.store)).toEqual([...SEEDED_EVENT_TYPES]);
    expect(h.store.readRecoveryBinding("ACTIVE")).toMatchObject({ outcome: "ABSENT" });
  });

  it("surfaces a closed store with its durable code and layer", async () => {
    const h = await restoreHarness("inspect-closed");
    const port = createRestorePort(h.store, PROJECT_ID);
    h.store.close();

    const result = port.inspect();

    expectRefusal(result, "DURABLE_STORE", "STORE_CLOSED");
  });

  it("reports the installed record without advancing anything", async () => {
    const h = await restoreHarness("inspect-installed");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");
    const port = createRestorePort(h.store, PROJECT_ID);
    const settled = port.resume(restoreRequest(h, binding));
    if (!settled.ok) throw new Error("expected a quiesce");
    const versionBefore = h.store.getAggregateVersion(PROJECT_ID);
    const eventsBefore = committedEventTypes(h.store);

    const inspected = port.inspect();
    port.inspect();

    expect(inspected).toMatchObject({
      ok: true,
      outcome: "INSTALLED",
      record: {
        generationDigest: h.generationDigest,
        incarnationRef: binding.incarnationRef,
        keyEpochRef: binding.keyEpochRef,
        preparedIdentity: settled.preparedIdentity,
        restoreCommandId: "restore-cmd-1",
        schemaVersion: RESTORE_CONTROLLER_SCHEMA_VERSION,
      },
    });
    expect(h.store.getAggregateVersion(PROJECT_ID)).toBe(versionBefore);
    expect(committedEventTypes(h.store)).toEqual(eventsBefore);
  });

  it("refuses an installed record whose prepared identity does not bind its fields", async () => {
    const h = await restoreHarness("inspect-identity");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");
    const installed = h.store.installRecoveryBinding({
      bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
      incarnationRef: binding.incarnationRef,
      installedAt: "2026-08-11T00:00:00.000Z",
      keyEpochRef: binding.keyEpochRef,
      payload: new TextEncoder().encode(JSON.stringify({
        generationDigest: h.generationDigest,
        incarnationRef: binding.incarnationRef,
        keyEpochRef: binding.keyEpochRef,
        preparedIdentity: "f".repeat(64),
        restoreCommandId: binding.restoreCommandId,
        schemaVersion: RESTORE_CONTROLLER_SCHEMA_VERSION,
      })),
      slot: "ACTIVE",
    });
    expect(installed.ok).toBe(true);

    const result = createRestorePort(h.store, PROJECT_ID).inspect();

    expectRefusal(result, RESTORE_CONTROLLER_LAYER, "RESTORE_RECORD_UNREADABLE");
  });

  it("discards a restore that never installed, writing nothing", async () => {
    const h = await restoreHarness("discard-open");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");
    const port = createRestorePort(h.store, PROJECT_ID);
    const versionBefore = h.store.getAggregateVersion(PROJECT_ID);

    const discarded = port.discard(restoreRequest(h, binding));

    expect(discarded).toMatchObject({ ok: true, outcome: "DISCARDED" });
    if (!discarded.ok) throw new Error("expected a discard");
    expect(discarded.preparedIdentity).toBe(
      preparedRestoreIdentity({
        generationDigest: h.generationDigest,
        incarnationRef: binding.incarnationRef,
        keyEpochRef: binding.keyEpochRef,
        restoreCommandId: binding.restoreCommandId,
      }),
    );
    expect(h.store.getAggregateVersion(PROJECT_ID)).toBe(versionBefore);
    expect(h.store.readRecoveryBinding("ACTIVE")).toMatchObject({ outcome: "ABSENT" });
  });

  it("refuses to discard an epoch the anchored incarnation does not carry", async () => {
    const h = await restoreHarness("discard-epoch");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");
    const port = createRestorePort(h.store, PROJECT_ID);

    const result = port.discard(
      restoreRequest(h, binding, { keyEpochRef: "a".repeat(64) }),
    );

    expectRefusal(result, RESTORE_CONTROLLER_LAYER, "RESTORE_KEY_EPOCH_MISMATCH");
    expect(h.store.readRecoveryBinding("ACTIVE")).toMatchObject({ outcome: "ABSENT" });
  });

  it("refuses to discard a command the anchored incarnation was not minted for", async () => {
    const h = await restoreHarness("discard-command");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");

    const result = createRestorePort(h.store, PROJECT_ID).discard(
      restoreRequest(h, binding, { restoreCommandId: "restore-cmd-2" }),
    );

    expectRefusal(result, RESTORE_CONTROLLER_LAYER, "RESTORE_COMMAND_NOT_BOUND");
    expect(h.store.readRecoveryBinding("ACTIVE")).toMatchObject({ outcome: "ABSENT" });
  });

  it("refuses to discard a restore that already settled", async () => {
    const h = await restoreHarness("discard-settled");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");
    const port = createRestorePort(h.store, PROJECT_ID);
    expect(port.resume(restoreRequest(h, binding)).ok).toBe(true);

    const result = port.discard(restoreRequest(h, binding));

    expectRefusal(result, RESTORE_CONTROLLER_LAYER, "RESTORE_ALREADY_SETTLED");
    expect(h.store.readRecoveryBinding("ACTIVE")).toMatchObject({ outcome: "FOUND" });
  });

  it("refuses a request naming a project the port is not bound to", async () => {
    const h = await restoreHarness("port-scope");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");
    const port = createRestorePort(h.store, "project-2");

    expectRefusal(
      port.resume(restoreRequest(h, binding)),
      RESTORE_CONTROLLER_LAYER,
      "RESTORE_REQUEST_SHAPE_INVALID",
    );
    expectRefusal(
      port.discard(restoreRequest(h, binding)),
      RESTORE_CONTROLLER_LAYER,
      "RESTORE_REQUEST_SHAPE_INVALID",
    );
  });
});

describe("restore controller — the anchored incarnation is not a readiness authority", () => {
  it("refuses on the reducer's authority even with a perfectly anchored incarnation", async () => {
    const h = await restoreHarness("anchor-not-authority");
    const binding = await anchoredIncarnation(h, "restore-cmd-1");
    // Anchored, verified, bound to this exact generation — and still powerless
    // to advance a project the durable ledger never registered.
    const empty = openHarnessStore(join(h.root, "unregistered.db"));
    anchorInto(empty, binding);

    const result = runRestoreQuiesce(empty, restoreRequest(h, binding));

    expectRefusal(result, "PROJECT_REDUCER", "UNKNOWN_ERROR");
    expect(empty.readRecoveryBinding("ACTIVE")).toMatchObject({ outcome: "ABSENT" });
  });
});
