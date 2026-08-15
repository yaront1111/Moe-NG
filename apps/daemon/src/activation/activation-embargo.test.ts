import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RECOVERY_BINDING_CODEC_VERSION } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { RECOVERY_INVENTORY_LAYER } from "../recovery/recovery-inventory-contract.js";
import {
  RESTORE_CONTROLLER_LAYER,
  RESTORE_CONTROLLER_SCHEMA_VERSION,
  preparedRestoreIdentity,
} from "../recovery/restore-controller-contract.js";
import { runRestoreQuiesce } from "../recovery/restore-controller.js";
import {
  DECIDED_AT,
  PRINCIPAL_ID,
  PROJECT_ID,
  anchoredIncarnation,
  cleanupRestoreHarnesses,
  genesisFixture,
  openHarnessStore,
  projectLifecycle,
  restoreHarness,
  restoreRequest,
  seedReadyProject,
} from "../recovery/restore-test-harness.js";
import {
  ACTIVATION_EMBARGO_CAUSES,
  ACTIVATION_EMBARGO_CODE,
  readActivationEmbargo,
} from "./activation-embargo.js";

/**
 * The persisted recovery embargo the activation ingress consults BEFORE it may
 * allocate any execution authority.
 *
 * Every state is seeded through production code: READY through the real
 * bootstrap sequence, QUIESCED through the real restore controller. Nothing
 * here hand-writes a lifecycle decision that the reducer would have refused,
 * because a fixture that invents the state under test proves only that the
 * reader agrees with the fixture.
 *
 * The two corruption causes are the exception and cannot be otherwise: no
 * production path produces an unreadable or self-contradicting project record —
 * that is precisely what makes them corruption — so they are committed through
 * the store's own decision API and nothing else.
 *
 * Every refusal pins the EXACT triple {code, layer, cause}. All five refusal
 * causes share one code and one layer, so a test asserting `!ok` — or even code
 * plus layer — would stay green once a different branch started answering first.
 */

const encoder = new TextEncoder();
const scratchRoots: string[] = [];

afterEach(cleanupRestoreHarnesses);
afterAll(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
});

/** Opened inside a case, never in a describe body: a held handle kills the worker. */
function scratchStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-embargo-${label}-`));
  scratchRoots.push(root);
  return openHarnessStore(join(root, "project.db"));
}

interface EmbargoRefusalShape {
  readonly cause: string;
  readonly upstream: { readonly code: string; readonly layer: string } | null;
}

function expectEmbargoed(
  result: ReturnType<typeof readActivationEmbargo>,
  expected: EmbargoRefusalShape,
): void {
  expect(result).toMatchObject({
    cause: expected.cause,
    code: ACTIVATION_EMBARGO_CODE,
    layer: RECOVERY_INVENTORY_LAYER,
    ok: false,
    upstream: expected.upstream,
  });
}

/**
 * Commits ONE decision carrying `state` as the project aggregate's result. Used
 * only for the corruption causes; every other state in this file comes out of a
 * production command.
 */
function commitProjectState(store: SqliteEventStore, state: unknown): void {
  const bytes = encoder.encode(JSON.stringify(state));
  const response = store.commitExpectedVersionDecision({
    commandKind: "project.register",
    committedResultBytes: bytes,
    correlationId: "corr-embargo",
    decidedAt: DECIDED_AT,
    events: [{ eventId: "embargo-seed-1", eventType: "ProjectRegistered", payload: bytes }],
    expectedVersion: 0,
    key: { commandId: "cmd-embargo-seed", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: bytes,
    targetAggregateId: PROJECT_ID,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`seeding the project state failed: ${response.decision.resultCode}`);
  }
}

interface RestoreRecordParts {
  readonly bindingIncarnationRef: string;
  readonly bindingKeyEpochRef: string;
  readonly recordIncarnationRef: string;
  readonly recordKeyEpochRef: string;
}

/**
 * Installs an ACTIVE restore binding through the store's own installer. The
 * record's `preparedIdentity` is DERIVED with the production derivation, so the
 * record decodes; whether the refs agree with the binding row is the variable
 * under test.
 */
function installRestoreBinding(store: SqliteEventStore, parts: RestoreRecordParts): void {
  const record = {
    backupCursor: "0",
    generationDigest: "3c".repeat(32),
    incarnationRef: parts.recordIncarnationRef,
    keyEpochRef: parts.recordKeyEpochRef,
    preparedIdentity: preparedRestoreIdentity({
      generationDigest: "3c".repeat(32),
      incarnationRef: parts.recordIncarnationRef,
      keyEpochRef: parts.recordKeyEpochRef,
      restoreCommandId: "restore-cmd-embargo",
    }),
    restoreCommandId: "restore-cmd-embargo",
    schemaVersion: RESTORE_CONTROLLER_SCHEMA_VERSION,
  };
  const installed = store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: parts.bindingIncarnationRef,
    installedAt: DECIDED_AT,
    keyEpochRef: parts.bindingKeyEpochRef,
    payload: encoder.encode(JSON.stringify(record)),
    slot: "ACTIVE",
  });
  expect(installed).toMatchObject({ ok: true });
}

const REF_A = "1a".repeat(32);
const EPOCH_A = "2b".repeat(32);
const REF_B = "4d".repeat(32);

describe("activation embargo — the reader clears only a reconciled project", () => {
  it("declares exactly the five refusal causes it can raise", () => {
    expect([...ACTIVATION_EMBARGO_CAUSES]).toEqual([
      "PROJECT_RECOVERY_REQUIRED",
      "PROJECT_STATE_ABSENT",
      "PROJECT_STATE_MISMATCHED",
      "PROJECT_STATE_UNREADABLE",
      "RESTORE_UNREADABLE",
    ]);
    expect(ACTIVATION_EMBARGO_CODE).toBe("RECOVERY_RECONCILIATION_REQUIRED");
  });

  it("clears when no restore is installed and the project is READY", () => {
    const store = scratchStore("clear-absent");
    seedReadyProject(store);

    expect(projectLifecycle(store)).toBe("READY");
    expect(store.readRecoveryBinding("ACTIVE")).toMatchObject({ outcome: "ABSENT" });
    expect(readActivationEmbargo(store, PROJECT_ID)).toEqual({ ok: true });
  });

  it("clears when a restore is INSTALLED and the project came back READY", () => {
    const store = scratchStore("clear-installed");
    seedReadyProject(store);
    installRestoreBinding(store, {
      bindingIncarnationRef: REF_A,
      bindingKeyEpochRef: EPOCH_A,
      recordIncarnationRef: REF_A,
      recordKeyEpochRef: EPOCH_A,
    });

    // An INSTALLED binding is reconciliation STARTED, never reconciliation
    // COMPLETE. What clears here is the project's own lifecycle.
    expect(projectLifecycle(store)).toBe("READY");
    expect(readActivationEmbargo(store, PROJECT_ID)).toEqual({ ok: true });
  });

  it("clears a GENESIS_FENCED slot exactly like an absent one", () => {
    const fixture = genesisFixture("embargo-clear");
    seedReadyProject(fixture.store);

    expect(projectLifecycle(fixture.store)).toBe("READY");
    expect(readActivationEmbargo(fixture.store, PROJECT_ID)).toEqual({ ok: true });
  });

  it("embargoes a QUIESCED project even with an INSTALLED restore binding", async () => {
    const harness = await restoreHarness("embargo-quiesced");
    const binding = await anchoredIncarnation(harness, "restore-cmd-1");

    const quiesced = runRestoreQuiesce(harness.store, restoreRequest(harness, binding));

    expect(quiesced).toMatchObject({ disposition: "QUIESCED", ok: true });
    expect(projectLifecycle(harness.store)).toBe("QUIESCED");
    expect(harness.store.readRecoveryBinding("ACTIVE")).toMatchObject({ outcome: "FOUND" });
    expectEmbargoed(readActivationEmbargo(harness.store, PROJECT_ID), {
      cause: "PROJECT_RECOVERY_REQUIRED",
      upstream: null,
    });
  });

  it("embargoes a project with no durable state at all", () => {
    const store = scratchStore("absent");

    expectEmbargoed(readActivationEmbargo(store, PROJECT_ID), {
      cause: "PROJECT_STATE_ABSENT",
      upstream: null,
    });
  });

  it("embargoes a lifecycle outside the closed project vocabulary", () => {
    const store = scratchStore("unreadable-lifecycle");
    commitProjectState(store, {
      lifecycle: "RUNNING",
      projectId: PROJECT_ID,
      recoveryRequired: false,
    });

    expectEmbargoed(readActivationEmbargo(store, PROJECT_ID), {
      cause: "PROJECT_STATE_UNREADABLE",
      upstream: null,
    });
  });

  it("embargoes a recoveryRequired flag that is not a boolean", () => {
    const store = scratchStore("unreadable-flag");
    commitProjectState(store, {
      lifecycle: "READY",
      projectId: PROJECT_ID,
      recoveryRequired: "false",
    });

    expectEmbargoed(readActivationEmbargo(store, PROJECT_ID), {
      cause: "PROJECT_STATE_UNREADABLE",
      upstream: null,
    });
  });

  it("embargoes state whose recovery flag contradicts its lifecycle", () => {
    const store = scratchStore("mismatch-flag");
    commitProjectState(store, {
      lifecycle: "READY",
      projectId: PROJECT_ID,
      recoveryRequired: true,
    });

    expectEmbargoed(readActivationEmbargo(store, PROJECT_ID), {
      cause: "PROJECT_STATE_MISMATCHED",
      upstream: null,
    });
  });

  it("embargoes state that names a different project than the one queried", () => {
    const store = scratchStore("mismatch-project");
    commitProjectState(store, {
      lifecycle: "READY",
      projectId: "project-other",
      recoveryRequired: false,
    });

    expectEmbargoed(readActivationEmbargo(store, PROJECT_ID), {
      cause: "PROJECT_STATE_MISMATCHED",
      upstream: null,
    });
  });

  it("carries the restore controller's own refusal verbatim, unflattened", () => {
    const store = scratchStore("restore-unreadable");
    seedReadyProject(store);
    // The record decodes and is self-consistent; the BINDING ROW disagrees with
    // it, which is the controller's own RESTORE_RECORD_UNREADABLE branch.
    installRestoreBinding(store, {
      bindingIncarnationRef: REF_B,
      bindingKeyEpochRef: EPOCH_A,
      recordIncarnationRef: REF_A,
      recordKeyEpochRef: EPOCH_A,
    });

    // The project is READY, so nothing downstream could have refused: only the
    // restore leg can answer here.
    expect(projectLifecycle(store)).toBe("READY");
    expectEmbargoed(readActivationEmbargo(store, PROJECT_ID), {
      cause: "RESTORE_UNREADABLE",
      upstream: { code: "RESTORE_RECORD_UNREADABLE", layer: RESTORE_CONTROLLER_LAYER },
    });
  });

  it("embargoes a closed store rather than reading it as clear", () => {
    const store = scratchStore("store-closed");
    seedReadyProject(store);
    store.close();

    const result = readActivationEmbargo(store, PROJECT_ID);

    expect(result).toMatchObject({
      cause: "RESTORE_UNREADABLE",
      code: ACTIVATION_EMBARGO_CODE,
      layer: RECOVERY_INVENTORY_LAYER,
      ok: false,
    });
    if (result.ok) throw new Error("a closed store must never read as clear");
    expect(result.upstream).not.toBeNull();
  });
});
