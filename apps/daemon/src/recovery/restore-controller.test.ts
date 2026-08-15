import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECOVERY_BINDING_CODEC_VERSION } from "@moe/store";

import { OBSERVATION } from "../bootstrap/bootstrap-test-fixtures.js";
import type {
  GenesisFenceRowFixture,
  GenesisFixture,
} from "./restore-test-harness.js";
import type { RestoreIncarnationBinding } from "./recovery-incarnation.js";
import { GENESIS_FENCE_REJECTIONS } from "./restore-genesis-classifier.js";
import type { GenesisFenceRejection } from "./restore-genesis-classifier.js";
import {
  DECIDED_AT,
  PROJECT_ID,
  SEEDED_EVENT_TYPES,
  anchorInto,
  anchoredIncarnation,
  cleanupRestoreHarnesses,
  committedEventTypes,
  genesisFixture,
  mintRestoreIncarnation,

  openHarnessStore,
  projectLifecycle,
  restoreHarness,
  restoreRequest,
} from "./restore-test-harness.js";
import { ensureGenesisRecoveryBinding } from "../identity/genesis-recovery-binding.js";
import { readCurrentRecoveryAuthenticationBinding } from "../identity/recovery-authentication-binding.js";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { envelope, hashOf, send } from "../identity/session-test-fixtures.js";
import { createRestorePort } from "./restore-controller-commands.js";
import { encodeBinding } from "./recovery-incarnation-binding-codec.js";
import { mintGenesisIncarnation } from "./recovery-incarnation-genesis.js";
import { classifyGenesisFence } from "./restore-genesis-classifier.js";
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
  it("surfaces the core's own ILLEGAL_TRANSITION once the project is quiesced", async () => {
    const h = await restoreHarness("version");
    const first = await anchoredIncarnation(h, "restore-cmd-1");
    expect(runRestoreQuiesce(h.store, restoreRequest(h, first)).ok).toBe(true);

    // A brand-new restore command with a wholly fresh fence. The first quiesce
    // is visible through the canonical fold, so only the real reducer owns the
    // refusal from QUIESCED.
    const second = await anchoredIncarnation(h, "restore-cmd-2");
    const result = runRestoreQuiesce(h.store, restoreRequest(h, second));

    expectRefusal(result, "PROJECT_REDUCER", "ILLEGAL_TRANSITION");
    if (result.ok) throw new Error("expected a refusal");
    // Only `createRuntimeError` produces this envelope. A local lifecycle check
    // admitting the same states could not carry the registry metadata, and would
    // never have refused a lifecycle that is still admissible.
    expect(result.error).toMatchObject({
      code: "ILLEGAL_TRANSITION",
      details: {
        aggregateKind: "PROJECT",
        commandKind: "recovery.restore_quiesce",
        sourceState: "QUIESCED",
      },
      recoveryCategory: "REFRESH",
      retryability: "AFTER_FACT_CHANGE",
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

/**
 * The genesis fence classifier. A never-restored store installs an ACTIVE
 * recovery binding so the operator can authenticate at all, and that row is NOT
 * a disaster restore. Recognising it demands POSITIVE EXACT PROOF of every
 * conjunct: an undecodable payload is unreadable corruption, never a genesis and
 * never an absence, which is the single defect this whole boundary exists to
 * prevent.
 */
describe("genesis fence classification — positive exact proof", () => {
  it("verifies the fence a production genesis install actually wrote", async () => {
    const g = genesisFixture("classify-ok");

    const verdict = classifyGenesisFence(g.store, PROJECT_ID, g.row);

    expect(verdict).toMatchObject({ verified: true });
    if (!verdict.verified) throw new Error("unreachable");
    expect(verdict.binding.origin).toBe("GENESIS");
    expect(verdict.binding.incarnationRef).toBe(g.row.incarnationRef);
    expect(verdict.binding.keyEpochRef).toBe(g.row.keyEpochRef);
  });

  it("refuses an undecodable payload as UNREADABLE, never as genesis or absence", async () => {
    const g = genesisFixture("classify-garbage");

    for (const payload of [
      new TextEncoder().encode("{not json"),
      g.row.payload.slice(0, 20),
      new Uint8Array([0, 1, 2, 3]),
    ]) {
      const verdict = classifyGenesisFence(g.store, PROJECT_ID, { ...g.row, payload });
      expect(verdict).toEqual({ reason: "PAYLOAD_UNDECODABLE", verified: false });
    }
  });

  it("refuses a payload the daemon never anchored, however well it proves itself", async () => {
    // The whole point of the anchor conjunct: a self-consistent binding is only
    // a caller's assertion until a row exists that the daemon durably observed.
    const g = genesisFixture("classify-unanchored");
    const forged = mintGenesisIncarnation(PROJECT_ID);
    if (!forged.ok) throw new Error("the shared mint must succeed");
    const payload = encodeBinding(forged.binding);

    const verdict = classifyGenesisFence(g.store, PROJECT_ID, {
      incarnationRef: forged.binding.incarnationRef,
      keyEpochRef: forged.binding.keyEpochRef,
      payload,
    });

    expect(verdict).toEqual({ reason: "ANCHOR_ABSENT", verified: false });
  });

  it("refuses a genesis binding asserted against a different project", async () => {
    const g = genesisFixture("classify-foreign-project");

    const verdict = classifyGenesisFence(g.store, "project-elsewhere", g.row);

    expect(verdict).toEqual({ reason: "PROJECT_CONTEXT_MISMATCH", verified: false });
  });
});

/**
 * DoD-2 and DoD-5: every hostile and near-miss ACTIVE payload, swept.
 *
 * Each case names the ONE conjunct it breaks and is well formed at every EARLIER
 * layer, so it actually reaches the guard it was written for — a malformed
 * near-miss is refused by the decoder and never exercises the check it claims to
 * test. Every case asserts the exact controller code AND the layer that
 * answered: two layers can refuse here, and a test asserting only `ok === false`
 * stays green once the new guard silently starts answering first.
 */
const GENESIS_CONJUNCTS = Object.freeze([
  "ANCHOR",
  "DECODES",
  "DERIVATION",
  "ORIGIN",
  "PROJECT_CONTEXT",
  "PROOF",
  "ROW_REFS",
] as const);
type GenesisConjunct = (typeof GENESIS_CONJUNCTS)[number];

interface FenceCaseContext {
  readonly fence: GenesisFixture;
  readonly restore: RestoreIncarnationBinding;
}

interface FenceCase {
  readonly conjunct: GenesisConjunct;
  readonly name: string;
  readonly reason: GenesisFenceRejection;
  readonly row: (context: FenceCaseContext) => GenesisFenceRowFixture;
}

const SESSION_CREDENTIAL = "client-credential-under-genesis-fence";

const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytesOf = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));
const fieldsOf = (bytes: Uint8Array): Record<string, unknown> =>
  JSON.parse(textOf(bytes)) as Record<string, unknown>;

/** Rewrites ONE field of the canonical payload, leaving every other byte alone. */
const withField = (
  fence: GenesisFixture,
  patch: Record<string, unknown>,
): GenesisFenceRowFixture => ({
  ...fence.row,
  payload: bytesOf({ ...fieldsOf(fence.row.payload), ...patch }),
});

const FENCE_CASES: readonly FenceCase[] = Object.freeze([
  {
    conjunct: "DECODES",
    name: "malformed bytes",
    reason: "PAYLOAD_UNDECODABLE",
    row: ({ fence }) => ({ ...fence.row, payload: new TextEncoder().encode("{not json") }),
  },
  {
    conjunct: "DECODES",
    name: "truncated bytes",
    reason: "PAYLOAD_UNDECODABLE",
    row: ({ fence }) => ({ ...fence.row, payload: fence.row.payload.slice(0, 40) }),
  },
  {
    conjunct: "DECODES",
    name: "an alternate schema version",
    reason: "PAYLOAD_UNDECODABLE",
    row: ({ fence }) => withField(fence, { schemaVersion: "moe-recovery-incarnation/2" }),
  },
  {
    conjunct: "ORIGIN",
    name: "a real RESTORE binding in the slot a genesis is expected in",
    reason: "ORIGIN_NOT_GENESIS",
    row: ({ restore }) => ({
      incarnationRef: restore.incarnationRef,
      keyEpochRef: restore.keyEpochRef,
      payload: encodeBinding(restore),
    }),
  },
  {
    conjunct: "ROW_REFS",
    name: "an incarnation ref that diverges from its row",
    reason: "ROW_REFS_DIVERGE",
    row: ({ fence }) => ({ ...fence.row, incarnationRef: "ab".repeat(32) }),
  },
  {
    conjunct: "ROW_REFS",
    name: "a key epoch ref that diverges from its row",
    reason: "ROW_REFS_DIVERGE",
    row: ({ fence }) => ({ ...fence.row, keyEpochRef: "cd".repeat(32) }),
  },
  {
    conjunct: "PROJECT_CONTEXT",
    name: "a store context digest that does not recompute",
    reason: "PROJECT_CONTEXT_MISMATCH",
    row: ({ fence }) => withField(fence, { storeContextDigest: "ef".repeat(32) }),
  },
  {
    conjunct: "PROJECT_CONTEXT",
    name: "a project the daemon did not assert",
    reason: "PROJECT_CONTEXT_MISMATCH",
    row: ({ fence }) => withField(fence, { projectId: "project-elsewhere" }),
  },
  {
    conjunct: "DERIVATION",
    name: "a verification key fingerprint unrelated to its own public key",
    reason: "DERIVATION_MISMATCH",
    row: ({ fence }) => withField(fence, { verificationKeyFingerprint: "19".repeat(32) }),
  },
  {
    conjunct: "PROOF",
    name: "a forged signature over a genuine challenge",
    reason: "PROOF_UNVERIFIED",
    row: ({ fence }) => {
      const proof = fieldsOf(fence.row.payload)["proof"] as Record<string, unknown>;
      const signatureHex = proof["signatureHex"] as string;
      // Same length and still hex, so the codec admits it and only the
      // signature check itself can tell the difference.
      return withField(fence, {
        proof: { ...proof, signatureHex: signatureHex.replace(/./, (c) => (c === "a" ? "b" : "a")) },
      });
    },
  },
  {
    conjunct: "ANCHOR",
    name: "a perfectly self-proving binding the daemon never anchored",
    reason: "ANCHOR_ABSENT",
    row: () => {
      const minted = mintGenesisIncarnation(PROJECT_ID);
      if (!minted.ok) throw new Error("the shared mint must succeed");
      return {
        incarnationRef: minted.binding.incarnationRef,
        keyEpochRef: minted.binding.keyEpochRef,
        payload: encodeBinding(minted.binding),
      };
    },
  },
  {
    conjunct: "ANCHOR",
    name: "non-canonical bytes that decode to the anchored binding",
    reason: "ANCHOR_BYTES_DIVERGE",
    row: ({ fence }) => ({
      ...fence.row,
      // Same fields, reversed key order: decodes identically, so every earlier
      // conjunct passes and only the byte-for-byte anchor comparison refuses.
      payload: bytesOf(
        Object.fromEntries(Object.entries(fieldsOf(fence.row.payload)).reverse()),
      ),
    }),
  },
]);

describe("genesis fence classification — hostile and near-miss ACTIVE payloads", () => {
  it("sweeps an exact, hand-counted set of cases", () => {
    // A generated sweep that silently produces ZERO cases passes while testing
    // nothing, and a count computed from the generator cannot police the
    // generator. Every number and name below is written by hand on purpose.
    expect(FENCE_CASES).toHaveLength(12);
    expect(GENESIS_CONJUNCTS).toHaveLength(7);

    // Each conjunct is named, so dropping a case fails this assertion rather
    // than quietly shrinking coverage to whatever happens to be left.
    expect([...new Set(FENCE_CASES.map((testCase) => testCase.conjunct))].sort()).toEqual([
      "ANCHOR",
      "DECODES",
      "DERIVATION",
      "ORIGIN",
      "PROJECT_CONTEXT",
      "PROOF",
      "ROW_REFS",
    ]);

    // Asserted against the PRODUCTION constant, not a copy: a new rejection
    // reason added to the classifier with no case here fails immediately.
    expect([...new Set(FENCE_CASES.map((testCase) => testCase.reason))].sort()).toEqual(
      [...GENESIS_FENCE_REJECTIONS].sort(),
    );
    expect(GENESIS_FENCE_REJECTIONS).toHaveLength(8);

    // Case names are distinct, so two entries cannot collapse into one report.
    expect(new Set(FENCE_CASES.map((testCase) => testCase.name)).size).toBe(12);
  });

  it.each(FENCE_CASES.map((testCase) => [testCase.name, testCase] as const))(
    "refuses %s at the controller, never as an absence",
    async (_name, testCase) => {
      // Indexed, not named: a command id may not contain whitespace, so a
      // human-readable case name would be refused by the mint itself.
      const index = FENCE_CASES.indexOf(testCase);
      expect(index).toBeGreaterThanOrEqual(0);
      const fence = genesisFixture(`fence-${index}`);
      const restore = await mintRestoreIncarnation(`restore-cmd-${index}`);
      const row = testCase.row({ fence, restore });

      const installed = fence.store.installRecoveryBinding({
        bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
        incarnationRef: row.incarnationRef,
        installedAt: DECIDED_AT,
        keyEpochRef: row.keyEpochRef,
        payload: row.payload,
        slot: "ACTIVE",
      });
      expect(installed.ok).toBe(true);

      // The controller boundary: exact code AND the layer that answered.
      const inspection = createRestorePort(fence.store, PROJECT_ID).inspect();
      expectRefusal(inspection, RESTORE_CONTROLLER_LAYER, "RESTORE_RECORD_UNREADABLE");
      expect(inspection).not.toMatchObject({ ok: true });
      expect(inspection).not.toMatchObject({ outcome: "ABSENT" });

      // And the conjunct that refused, so a case cannot drift onto another guard.
      expect(classifyGenesisFence(fence.store, PROJECT_ID, row)).toEqual({
        reason: testCase.reason,
        verified: false,
      });
    },
  );
});

describe("genesis fence classification — the layer that answers", () => {
  it("surfaces an UPSTREAM store refusal at its own layer, not as the controller's", () => {
    // This task adds a SECOND guard behind the store's own. A refusal test that
    // only asserted `ok === false` would stay green even if the controller
    // started swallowing store faults into RESTORE_RECORD_UNREADABLE, so the
    // discrimination itself is what is asserted here.
    const fence = genesisFixture("fence-upstream");
    fence.store.close();

    const inspection = createRestorePort(fence.store, PROJECT_ID).inspect();

    expectRefusal(inspection, "DURABLE_STORE", "STORE_CLOSED");
    expect(inspection).not.toMatchObject({ layer: RESTORE_CONTROLLER_LAYER });
    expect(inspection).not.toMatchObject({ code: "RESTORE_RECORD_UNREADABLE" });
  });

  it("reports a verified fence as GENESIS_FENCED through the operator port", () => {
    const fence = genesisFixture("fence-port");

    const inspection = createRestorePort(fence.store, PROJECT_ID).inspect();

    // Distinguishable from ABSENT by an exact literal: a caller that could not
    // tell them apart would be free to treat a fenced store as an empty one.
    expect(inspection).toEqual({
      incarnationRef: fence.row.incarnationRef,
      keyEpochRef: fence.row.keyEpochRef,
      ok: true,
      outcome: "GENESIS_FENCED",
    });
    expect(Object.isFrozen(inspection)).toBe(true);
  });
});

describe("restore over a genesis fence — the EXISTING flow, atomically", () => {
  it("replaces a verified fence and retires its refs from the authentication fence", async () => {
    // The store fences itself while pristine, exactly as a fresh daemon does
    // before any work lands; a second call must ADOPT that fence, not re-mint.
    const h = await restoreHarness("genesis-to-restore", { fenceGenesis: true });
    const fenced = ensureGenesisRecoveryBinding(h.store, {
      clock: () => DECIDED_AT,
      projectId: PROJECT_ID,
    });
    if (!fenced.ok || fenced.outcome !== "PRESENT") {
      throw new Error("the genesis fence must be present before a restore can replace it");
    }
    const genesisRef = fenced.binding.recoveryIncarnationRef;

    const port = createRestorePort(h.store, PROJECT_ID);
    expect(port.inspect()).toMatchObject({ ok: true, outcome: "GENESIS_FENCED" });

    // A session opened under the fence carries the GENESIS refs — stamped by
    // production code off the ACTIVE slot, never chosen by this test.
    const opened = send(
      h.store,
      envelope(
        "session.open",
        0,
        {
          capabilities: ["work.claim"],
          credentialSha256: hashOf(SESSION_CREDENTIAL),
          expiresAt: "2126-01-01T00:00:00.000Z",
          sessionId: "session-under-genesis",
        },
        "cmd-open-under-genesis",
        { projectId: PROJECT_ID },
      ),
    );
    if (!opened.ok) throw new Error(`session.open setup failed: ${opened.code}`);
    const authenticator = createSessionAuthenticator(h.store, {
      clock: () => Date.parse("2026-08-11T00:00:00.000Z"),
      operatorCapabilities: ["work.claim"],
      operatorCredential: "operator-secret-1",
      operatorPrincipalId: "operator-local",
      projectId: PROJECT_ID,
    });
    expect(authenticator.authenticate(SESSION_CREDENTIAL).verdict).toBe("AUTHENTICATED");

    // The EXISTING verified restore flow. This task adds no second installer.
    const binding = await anchoredIncarnation(h, "restore-cmd-1");
    const result = port.resume(restoreRequest(h, binding));
    if (!result.ok || result.disposition !== "QUIESCED") {
      throw new Error("the existing restore flow must quiesce over a genesis fence");
    }

    expect(port.inspect()).toMatchObject({
      ok: true,
      outcome: "INSTALLED",
      record: { incarnationRef: binding.incarnationRef, restoreCommandId: "restore-cmd-1" },
    });
    // Atomically replaced through the existing restore transaction: the ACTIVE
    // slot now names the restore incarnation and no longer the genesis one.
    const current = readCurrentRecoveryAuthenticationBinding(h.store);
    expect(current?.recoveryIncarnationRef).toBe(binding.incarnationRef);
    expect(current?.recoveryIncarnationRef).not.toBe(genesisRef);

    // And the retired genesis refs no longer satisfy the fence — exact code AND
    // the layer that answered, not merely that authentication stopped working.
    const replayed = authenticator.authenticate(SESSION_CREDENTIAL);
    expect(replayed.verdict).toBe("REFUSED");
    if (replayed.verdict !== "REFUSED") throw new Error("unreachable");
    expect(replayed.refusal).toMatchObject({
      code: "SESSION_REPLAYED",
      httpStatus: 401,
      layer: "IDENTITY",
    });
  });
});
