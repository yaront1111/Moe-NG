import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RECOVERY_BINDING_CODEC_VERSION, SqliteEventStore } from "@moe/store";
import { adapterConfirm, adapterFail, reserveAll } from "@moe/scheduler";
import type { AcquisitionState, ResourceRow } from "@moe/scheduler";
import { afterEach, describe, expect, it } from "vitest";

import { anchorIncarnation } from "./recovery-incarnation-anchor.js";
import { createNodeRecoveryCryptoPort } from "./recovery-incarnation.node.js";
import { createRecoveryIncarnationService } from "./recovery-incarnation.js";
import type { RestoreIncarnationBinding } from "./recovery-incarnation-contract.js";
import {
  RECOVERY_INVENTORY_POPULATIONS,
  RECOVERY_PROOF_CLASSES,
  recoveryPopulationClass,
} from "./recovery-inventory-contract.js";
import type { RecoveryProofClass } from "./recovery-inventory-contract.js";
import { recordRecoveryReconciliation } from "./recovery-inventory-ledger.js";
import {
  DURABLE_INVENTORY_ADAPTER_LAYER,
  DURABLE_INVENTORY_COMMAND_KIND,
  DURABLE_INVENTORY_CURSOR_DIGITS,
  DURABLE_INVENTORY_ROW_EVENT_TYPE,
  DURABLE_INVENTORY_SEAL_EVENT_TYPE,
  DURABLE_RECOVERY_INVENTORY_CLASSES,
  DURABLE_RECOVERY_INVENTORY_SCHEMA_VERSION,
  DURABLE_RESOURCE_FENCEABILITIES,
  DURABLE_RESOURCE_STATES,
  DURABLE_INVENTORY_CODES_ARE_ADMITTED,
  DURABLE_RESOURCE_STATES_MATCH_SCHEDULER,
  durableInventoryDigest,
  durableInventoryScopeDigest,
} from "./durable-recovery-inventory-contract.js";
import { durableResourceObservation } from "./durable-recovery-inventory-shape.js";
import type {
  DurableIntegrationObservation,
  DurableInventoryBasis,
  DurableInventoryClassCoverage,
  DurableInventorySeal,
  DurableInventorySelectedScope,
  DurableInventoryWindow,
  DurableResourceObservation,
} from "./durable-recovery-inventory-contract.js";
import {
  durableSealBody,
  encodeDurableRow,
  encodeDurableSeal,
  isDurableRefusal,
  readDurableRecoveryInventory,
  resolveDurableWindow,
  sameDurableBytes,
} from "./durable-recovery-inventory-reader.js";
import type {
  DurableInventoryRow,
  DurableResolvedWindow,
} from "./durable-recovery-inventory-reader.js";
import {
  appendDurableInventoryObservation,
  createDurableRecoveryInventoryRegistrations,
  sealDurableInventoryWindow,
} from "./durable-recovery-inventory.js";

const PROJECT_ID = "proj-durable-inventory";
const PROJECT_TAG = "moe-project:proj-durable-inventory";
const RESTORE_COMMAND_ID = "restore-cmd-durable";
const AT = "2026-08-15T00:00:00.000Z";
const EPOCH = 7;

const hex = (tag: string): string =>
  (tag.replace(/[^0-9a-f]/gu, "") + "0".repeat(64)).slice(0, 64);

/** Fixed width, so lexicographic cursor comparison IS numeric comparison. */
const pos = (value: number): string => String(value).padStart(DURABLE_INVENTORY_CURSOR_DIGITS, "0");

const BACKUP_CURSOR = pos(42);
const END_INCLUSIVE = pos(100);
const RESOURCE_PROOF = hex("a1");
const INTEGRATION_PROOF = hex("b2");
const NEGATIVE_PROOF = hex("c3");

const encoder = new TextEncoder();
const openHandles: SqliteEventStore[] = [];
const directories: string[] = [];

/** Windows holds the file open: every handle this suite opens is closed in teardown. */
const open = (path: string): SqliteEventStore => {
  const store = SqliteEventStore.openForProject(path, PROJECT_ID);
  openHandles.push(store);
  return store;
};

/**
 * Closes one handle mid-test and DEREGISTERS it, so teardown never closes the
 * same handle twice. A deliberate double close is not a harmless no-op here: it
 * can take the whole worker down and read as a native crash.
 */
const closeNow = (store: SqliteEventStore): void => {
  const at = openHandles.indexOf(store);
  if (at >= 0) openHandles.splice(at, 1);
  store.close();
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
  const directory = mkdtempSync(join(tmpdir(), "moe-durable-inv-"));
  directories.push(directory);
  return directory;
};

const writeRequest = Object.freeze({
  correlationId: "corr-durable-1",
  decidedAt: AT,
  principalId: "principal-durable-1",
  projectId: PROJECT_ID,
});

const mintBinding = async (
  backupGenerationDigest: string,
  restoreCommandId = RESTORE_COMMAND_ID,
): Promise<RestoreIncarnationBinding> => {
  const service = createRecoveryIncarnationService(createNodeRecoveryCryptoPort());
  const minted = await service.mint({ backupGenerationDigest, restoreCommandId });
  if (!minted.ok) throw new Error(`mint refused: ${minted.code}`);
  return minted.binding;
};

const install = (store: SqliteEventStore, binding: RestoreIncarnationBinding): boolean => {
  const installed = store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: binding.incarnationRef,
    installedAt: AT,
    keyEpochRef: binding.keyEpochRef,
    payload: encoder.encode("recovery-binding-payload"),
    slot: "ACTIVE",
  });
  return installed.ok;
};

interface Prepared {
  readonly binding: RestoreIncarnationBinding;
  readonly path: string;
  readonly store: SqliteEventStore;
}

/** A real store carrying a real anchored incarnation and a real ACTIVE binding. */
const prepare = async (backupGenerationDigest = hex("badc0ffe")): Promise<Prepared> => {
  const path = join(newDirectory(), "store.sqlite");
  const store = open(path);
  const binding = await mintBinding(backupGenerationDigest);
  expect(anchorIncarnation(store, writeRequest, binding)).toBe(true);
  expect(install(store, binding)).toBe(true);
  return { binding, path, store };
};

const basisFor = (binding: RestoreIncarnationBinding): DurableInventoryBasis =>
  Object.freeze({
    backupCursor: BACKUP_CURSOR,
    backupGenerationDigest: binding.backupGenerationDigest,
    projectTag: PROJECT_TAG,
  });

const WINDOW: DurableInventoryWindow = Object.freeze({
  endInclusive: END_INCLUSIVE,
  startExclusive: BACKUP_CURSOR,
});

// --------------------------------------------------------------------------
// Real scheduler transitions. Nothing below hand-builds a ResourceRow.
// --------------------------------------------------------------------------

const reserveFor = (requestId: string): unknown =>
  Object.freeze({
    callerObservation: "obs-1",
    capacitySnapshot: Object.freeze({ "res-ext": 4, "res-local": 4, "res-nofence": 4 }),
    continuouslyEligibleSinceRef: "since-1",
    declaredResources: Object.freeze([
      Object.freeze({
        capacityUnits: 1, external: false, fenceable: true, resourceId: "res-local",
      }),
      Object.freeze({ capacityUnits: 1, external: true, fenceable: true, resourceId: "res-ext" }),
      Object.freeze({
        capacityUnits: 1, external: false, fenceable: false, resourceId: "res-nofence",
      }),
    ]),
    eligibilityEventSequenceRef: "seq-1",
    epoch: EPOCH,
    requestId,
  });

function reserved(requestId: string): readonly ResourceRow[] {
  const outcome = reserveAll(reserveFor(requestId));
  if (!outcome.ok || outcome.value.outcome !== "RESERVED") {
    throw new Error("reserveAll did not reserve");
  }
  return outcome.value.rows;
}

/**
 * Every stored row comes out of these three public transitions, under three
 * distinct request ids so the `(resourceId, effectIntentRef)` identities stay
 * distinct. `adapterFail(FAILED)` is what puts QUARANTINED onto the
 * `fenceable: false` row, which is the pair DoD 1 names explicitly.
 */
function generatedResourceRows(): readonly ResourceRow[] {
  const confirmed = adapterConfirm(reserved("req-confirm"), "res-ext", EPOCH);
  if (!confirmed.ok) throw new Error("adapterConfirm refused");
  const failed = adapterFail(reserved("req-fail"), "res-ext", EPOCH, "FAILED");
  if (!failed.ok) throw new Error("adapterFail refused");
  return Object.freeze([...reserved("req-hold"), ...confirmed.value.rows, ...failed.value.rows]);
}

const observationsFrom = (rows: readonly ResourceRow[]): readonly DurableResourceObservation[] =>
  rows.map((row, index) => durableResourceObservation(row, RESOURCE_PROOF, pos(43 + index)));

const integration = (
  attempt: string,
  target: string,
  intent: string,
  observedPosition: string,
): DurableIntegrationObservation =>
  Object.freeze({
    attemptRef: attempt,
    class: "INTEGRATION_TARGET" as const,
    effectIntentRef: intent,
    intentDigest: hex(`d${attempt}`),
    observedPosition,
    sourceProofDigest: INTEGRATION_PROOF,
    targetRef: target,
  });

const INTEGRATIONS: readonly DurableIntegrationObservation[] = Object.freeze([
  integration("attempt-1", "target-a", "intent-a", pos(70)),
  integration("attempt-2", "target-a", "intent-a", pos(71)),
  integration("attempt-3", "target-b", "intent-b", pos(72)),
]);

const COVERAGE: readonly [DurableInventoryClassCoverage, DurableInventoryClassCoverage] =
  Object.freeze([
    Object.freeze({
      class: "RESOURCE" as const, negativeProofDigest: null, sourceProofDigest: RESOURCE_PROOF,
    }),
    Object.freeze({
      class: "INTEGRATION_TARGET" as const,
      negativeProofDigest: null,
      sourceProofDigest: INTEGRATION_PROOF,
    }),
  ]);

const appendAll = (
  store: SqliteEventStore,
  basis: DurableInventoryBasis,
  observations: readonly unknown[],
): void => {
  for (const observation of observations) {
    const appended = appendDurableInventoryObservation(
      store, writeRequest, basis, WINDOW, observation,
    );
    if (!appended.ok) throw new Error(`append refused: ${appended.upstream.code}`);
  }
};

/** A store carrying every generated resource row plus every integration attempt. */
const populated = async (): Promise<Prepared & { rows: readonly ResourceRow[] }> => {
  const prepared = await prepare();
  const rows = generatedResourceRows();
  const basis = basisFor(prepared.binding);
  appendAll(prepared.store, basis, observationsFrom(rows));
  appendAll(prepared.store, basis, INTEGRATIONS);
  return { ...prepared, rows };
};

// --------------------------------------------------------------------------
// Forged durable bytes. Every forgery below is committed into the window's OWN
// aggregate through the same public store call the production writer uses, and
// each test pairs its tamper with an honest forgery that MUST be accepted — so
// a refusal is attributable to the tamper, never to bytes the reader would have
// rejected as malformed regardless.
// --------------------------------------------------------------------------

const resolveFor = (
  store: SqliteEventStore,
  basis: DurableInventoryBasis,
): DurableResolvedWindow => {
  const resolved = resolveDurableWindow(store, PROJECT_ID, basis, WINDOW);
  if (isDurableRefusal(resolved)) throw new Error(`resolve refused: ${resolved.upstream.code}`);
  return resolved;
};

const forgeEvent = (
  store: SqliteEventStore,
  resolved: DurableResolvedWindow,
  eventType: string,
  bytes: Uint8Array,
  commandId: string,
): void => {
  const response = store.commitExpectedVersionDecision({
    commandKind: DURABLE_INVENTORY_COMMAND_KIND,
    committedResultBytes: bytes,
    correlationId: writeRequest.correlationId,
    decidedAt: writeRequest.decidedAt,
    events: [
      {
        domainSchemaVersion: DURABLE_RECOVERY_INVENTORY_SCHEMA_VERSION,
        eventId: `${commandId}:${eventType}`,
        eventType,
        payload: bytes,
      },
    ],
    expectedVersion: resolved.state.version,
    key: { commandId, principalId: writeRequest.principalId, projectId: PROJECT_ID },
    requestBytes: bytes,
    targetAggregateId: resolved.aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`forged commit not applied: ${response.decision.effectDisposition}`);
  }
};

/** The seal the production sealer would write, over rows the READER decoded. */
const honestSeal = (resolved: DurableResolvedWindow): DurableInventorySeal =>
  Object.freeze({
    classes: Object.freeze(
      DURABLE_RECOVERY_INVENTORY_CLASSES.map((named) => {
        const rowDigests = Object.freeze(
          resolved.state.rows
            .filter((row) => row.class === named)
            .map((row) => row.rowDigest)
            .sort(),
        );
        return Object.freeze({
          class: named,
          itemCount: rowDigests.length,
          negativeProofDigest: rowDigests.length === 0 ? NEGATIVE_PROOF : null,
          rowDigests,
          // Keyed by the class itself: a reordered class list must not silently
          // hand the resource population the integration source proof.
          sourceProofDigest: named === "RESOURCE" ? RESOURCE_PROOF : INTEGRATION_PROOF,
          truth: "COMPLETE" as const,
        });
      }),
    ),
    scopeDigest: resolved.scopeDigest,
    windowEndInclusive: WINDOW.endInclusive,
    windowStartExclusive: WINDOW.startExclusive,
  });

/** `digestOf` is the body the stored digest was taken over — the tamper vector. */
const sealBytes = (seal: DurableInventorySeal, digestOf: DurableInventorySeal = seal): Uint8Array =>
  encodeDurableSeal(seal, durableInventoryDigest(durableSealBody(digestOf)));

describe("durable recovery inventory - generated population", () => {
  it("covers every scheduler acquisition state from real public transitions", () => {
    const rows = generatedResourceRows();
    const states = new Set<AcquisitionState>(rows.map((row) => row.state));
    // The sweep is proven non-empty AND exhaustive: a generator that silently
    // produced nothing would otherwise pass every assertion that follows it.
    expect(rows.length).toBeGreaterThan(0);
    expect(states.size).toBe(DURABLE_RESOURCE_STATES.length);
    expect([...states].sort()).toStrictEqual([...DURABLE_RESOURCE_STATES].sort());
    expect(DURABLE_RESOURCE_STATES_MATCH_SCHEDULER).toBe(true);
    // Every refusal this area can emit is already in the daemon's closed
    // upstream vocabulary; nothing here invents a code a reader cannot classify.
    expect(DURABLE_INVENTORY_CODES_ARE_ADMITTED).toBe(true);
    expect(rows.some((row) => row.state === "QUARANTINED" && !row.fenceable)).toBe(true);
    expect(new Set(rows.map((row) => `${row.resourceId}|${row.effectIntentRef}`)).size).toBe(
      rows.length,
    );
  });

  it("projects every ResourceRow onto its exact fenceability and effect intent", () => {
    const rows = generatedResourceRows();
    const observations = observationsFrom(rows);
    expect(observations.length).toBe(rows.length);
    expect(observations.length).toBeGreaterThan(0);
    let nonFenceable = 0;
    observations.forEach((observation, index) => {
      const row = rows[index] as ResourceRow;
      expect(observation.class).toBe("RESOURCE");
      expect(observation.resourceId).toBe(row.resourceId);
      expect(observation.effectIntentRef).toBe(row.effectIntentRef);
      expect(observation.state).toBe(row.state);
      expect(observation.capacityUnits).toBe(row.capacityUnits);
      expect(observation.epoch).toBe(row.epoch);
      expect(observation.external).toBe(row.external);
      expect(observation.sourceProofDigest).toBe(RESOURCE_PROOF);
      expect(observation.fenceability).toBe(row.fenceable ? "FENCEABLE" : "NON_FENCEABLE");
      if (!row.fenceable) nonFenceable += 1;
    });
    expect(nonFenceable).toBeGreaterThan(0);
    expect([...DURABLE_RESOURCE_FENCEABILITIES]).toStrictEqual(["FENCEABLE", "NON_FENCEABLE"]);
  });
});

describe("durable recovery inventory - durable enumeration", () => {
  it("enumerates every stored resource row and integration attempt in the window", async () => {
    const { binding, rows, store } = await populated();
    const basis = basisFor(binding);
    expect(sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE).ok).toBe(true);

    const read = readDurableRecoveryInventory(store, PROJECT_ID, basis, WINDOW);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    expect(read.outcome).toBe("ENUMERATED");
    expect(read.authority).toBe("NONE");
    expect(read.truth).toBe("COMPLETE");
    const resources = read.observations.filter((row) => row.class === "RESOURCE");
    const integrations = read.observations.filter((row) => row.class === "INTEGRATION_TARGET");
    expect(resources).toHaveLength(rows.length);
    expect(integrations).toHaveLength(INTEGRATIONS.length);
    expect(new Set(integrations.map((row) => row.attemptRef)).size).toBe(INTEGRATIONS.length);
    expect(new Set(integrations.map((row) => row.targetRef))).toStrictEqual(
      new Set(["target-a", "target-b"]),
    );
    expect(read.classes.map((entry) => entry.class)).toStrictEqual([
      ...DURABLE_RECOVERY_INVENTORY_CLASSES,
    ]);
    expect(read.classes.map((entry) => entry.itemCount)).toStrictEqual([
      rows.length, INTEGRATIONS.length,
    ]);
    // Every stored resource row keeps its exact intent and source-proof binding.
    for (const observation of resources) {
      expect(observation.sourceProofDigest).toBe(RESOURCE_PROOF);
      expect(observation.effectIntentRef.startsWith("intent:")).toBe(true);
    }
  });

  it("survives process/store reopen with byte-identical seal and rows", async () => {
    const { binding, path, store } = await populated();
    const basis = basisFor(binding);
    const sealed = sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error("unreachable");
    const before = readDurableRecoveryInventory(store, PROJECT_ID, basis, WINDOW);
    closeNow(store);

    const reopened = open(path);
    const after = readDurableRecoveryInventory(reopened, PROJECT_ID, basis, WINDOW);
    expect(after.ok).toBe(true);
    if (!after.ok || !before.ok) throw new Error("unreachable");
    expect(after.sealDigest).toBe(sealed.sealDigest);
    expect(after.sealDigest).toBe(before.sealDigest);
    expect(after.observations).toStrictEqual(before.observations);
    expect(after.classes).toStrictEqual(before.classes);
  });

  it("replays an identical append and refuses a divergent one under one identity", async () => {
    const { binding, store } = await populated();
    const basis = basisFor(binding);
    const first = generatedResourceRows()[0] as ResourceRow;
    const replay = appendDurableInventoryObservation(
      store, writeRequest, basis, WINDOW,
      durableResourceObservation(first, RESOURCE_PROOF, pos(43)),
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("unreachable");
    expect(replay.disposition).toBe("REPLAYED");

    const divergent = appendDurableInventoryObservation(
      store, writeRequest, basis, WINDOW,
      { ...durableResourceObservation(first, RESOURCE_PROOF, pos(43)), capacityUnits: 99 },
    );
    expect(divergent.ok).toBe(false);
    if (divergent.ok) throw new Error("unreachable");
    expect(divergent.upstream.code).toBe("RECOVERY_INVENTORY_SUBJECT_DUPLICATE");
    expect(divergent.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });

  it("refuses every append after the window is sealed", async () => {
    const { binding, store } = await populated();
    const basis = basisFor(binding);
    expect(sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE).ok).toBe(true);
    const late = appendDurableInventoryObservation(
      store, writeRequest, basis, WINDOW,
      integration("attempt-late", "target-c", "intent-c", pos(80)),
    );
    expect(late.ok).toBe(false);
    if (late.ok) throw new Error("unreachable");
    expect(late.upstream.code).toBe("RECORD_CONFLICT");
    expect(late.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });
});

describe("durable recovery inventory - window and incarnation binding", () => {
  it("excludes the start cursor and includes the end cursor", async () => {
    const { binding, store } = await prepare();
    const basis = basisFor(binding);
    const atStart = appendDurableInventoryObservation(
      store, writeRequest, basis, WINDOW,
      integration("attempt-start", "target-s", "intent-s", BACKUP_CURSOR),
    );
    expect(atStart.ok).toBe(false);
    if (atStart.ok) throw new Error("unreachable");
    expect(atStart.upstream.code).toBe("RECOVERY_INVENTORY_COVERAGE_UNKNOWN");

    const past = appendDurableInventoryObservation(
      store, writeRequest, basis, WINDOW,
      integration("attempt-past", "target-p", "intent-p", pos(101)),
    );
    expect(past.ok).toBe(false);
    if (past.ok) throw new Error("unreachable");
    expect(past.upstream.code).toBe("RECOVERY_INVENTORY_COVERAGE_UNKNOWN");

    const atEnd = appendDurableInventoryObservation(
      store, writeRequest, basis, WINDOW,
      integration("attempt-end", "target-e", "intent-e", END_INCLUSIVE),
    );
    expect(atEnd.ok).toBe(true);
  });

  it("refuses a window whose start is not the basis backup cursor", async () => {
    const { binding, store } = await prepare();
    const drifted = appendDurableInventoryObservation(
      store, writeRequest, basisFor(binding),
      { endInclusive: END_INCLUSIVE, startExclusive: pos(41) },
      integration("attempt-1", "target-a", "intent-a", pos(70)),
    );
    expect(drifted.ok).toBe(false);
    if (drifted.ok) throw new Error("unreachable");
    expect(drifted.upstream.code).toBe("RECOVERY_INVENTORY_INPUT_INVALID");
    expect(drifted.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });

  it("refuses a backup generation the anchored incarnation does not carry", async () => {
    const { binding, store } = await prepare();
    const wrong = appendDurableInventoryObservation(
      store, writeRequest,
      { ...basisFor(binding), backupGenerationDigest: hex("f00d") }, WINDOW,
      integration("attempt-1", "target-a", "intent-a", pos(70)),
    );
    expect(wrong.ok).toBe(false);
    if (wrong.ok) throw new Error("unreachable");
    expect(wrong.upstream.code).toBe("RECOVERY_BINDING_MISMATCH");
    expect(wrong.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });

  it("hides a sealed window from a store whose current incarnation has rotated", async () => {
    const { binding, store } = await populated();
    const basis = basisFor(binding);
    expect(sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE).ok).toBe(true);
    expect(readDurableRecoveryInventory(store, PROJECT_ID, basis, WINDOW).ok).toBe(true);

    const rotated = await mintBinding(binding.backupGenerationDigest, "restore-cmd-durable-2");
    expect(rotated.incarnationRef).not.toBe(binding.incarnationRef);
    expect(anchorIncarnation(store, writeRequest, rotated)).toBe(true);
    expect(install(store, rotated)).toBe(true);
    const afterRotation = readDurableRecoveryInventory(store, PROJECT_ID, basis, WINDOW);
    expect(afterRotation.ok).toBe(false);
    if (afterRotation.ok) throw new Error("unreachable");
    expect(afterRotation.upstream.code).toBe("RECORD_NOT_FOUND");
    expect(afterRotation.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });

  it("refuses when no recovery binding or no anchor is readable", async () => {
    const path = join(newDirectory(), "store.sqlite");
    const store = open(path);
    const binding = await mintBinding(hex("badc0ffe"));
    const unbound = appendDurableInventoryObservation(
      store, writeRequest, basisFor(binding), WINDOW,
      integration("attempt-1", "target-a", "intent-a", pos(70)),
    );
    expect(unbound.ok).toBe(false);
    if (unbound.ok) throw new Error("unreachable");
    expect(unbound.upstream.code).toBe("RECOVERY_BINDING_UNAVAILABLE");

    expect(install(store, binding)).toBe(true);
    const unanchored = appendDurableInventoryObservation(
      store, writeRequest, basisFor(binding), WINDOW,
      integration("attempt-1", "target-a", "intent-a", pos(70)),
    );
    expect(unanchored.ok).toBe(false);
    if (unanchored.ok) throw new Error("unreachable");
    expect(unanchored.upstream.code).toBe("RECOVERY_ANCHOR_UNAVAILABLE");
    expect(unanchored.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });

  /**
   * Project identity is the STORE's, read from `getHealth`, and a caller naming
   * another project is refused on both the read and the write path. Without
   * this the caller's own project id would silently address a second window
   * inside a store that never belonged to it.
   */
  it("refuses a caller project the store's own health does not name", async () => {
    const { binding, store } = await populated();
    const basis = basisFor(binding);
    expect(sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE).ok).toBe(true);
    // Control: the store's own project reads exactly this window and window id.
    expect(readDurableRecoveryInventory(store, PROJECT_ID, basis, WINDOW).ok).toBe(true);

    const foreign = `${PROJECT_ID}-other`;
    const read = readDurableRecoveryInventory(store, foreign, basis, WINDOW);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.upstream.code).toBe("RECOVERY_INVENTORY_INPUT_INVALID");
    expect(read.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);

    const appended = appendDurableInventoryObservation(
      store, { ...writeRequest, projectId: foreign }, basis, WINDOW,
      integration("attempt-9", "target-c", "intent-c", pos(73)),
    );
    expect(appended.ok).toBe(false);
    if (appended.ok) throw new Error("unreachable");
    expect(appended.upstream.code).toBe("RECOVERY_INVENTORY_INPUT_INVALID");
    expect(appended.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });

  /**
   * The window's address must move when ANY scope field moves. A field dropped
   * from the digest body cannot be seen end to end — two stores never share one
   * file — so injectivity is asserted against the production digest itself.
   */
  it("addresses a window by every scope field, project identity included", () => {
    const scope: DurableInventorySelectedScope = Object.freeze({
      anchorBindingDigest: hex("a11"),
      incarnationRef: "recovery-incarnation-1",
      keyEpochRef: "recovery-key-epoch-1",
      projectId: PROJECT_ID,
    });
    const basis: DurableInventoryBasis = Object.freeze({
      backupCursor: BACKUP_CURSOR,
      backupGenerationDigest: hex("badc0ffe"),
      projectTag: PROJECT_TAG,
    });
    const digest = durableInventoryScopeDigest(scope, basis, WINDOW);
    const moved = (field: string, value: string): readonly [string, string] => [field, value];
    const perturbed: readonly (readonly [string, string])[] = Object.freeze([
      moved("projectId", durableInventoryScopeDigest(
        { ...scope, projectId: `${PROJECT_ID}-other` }, basis, WINDOW)),
      moved("anchorBindingDigest", durableInventoryScopeDigest(
        { ...scope, anchorBindingDigest: hex("b22") }, basis, WINDOW)),
      moved("incarnationRef", durableInventoryScopeDigest(
        { ...scope, incarnationRef: "recovery-incarnation-2" }, basis, WINDOW)),
      moved("keyEpochRef", durableInventoryScopeDigest(
        { ...scope, keyEpochRef: "recovery-key-epoch-2" }, basis, WINDOW)),
      moved("projectTag", durableInventoryScopeDigest(
        scope, { ...basis, projectTag: `${PROJECT_TAG}-other` }, WINDOW)),
      moved("backupCursor", durableInventoryScopeDigest(
        scope, { ...basis, backupCursor: pos(43) }, WINDOW)),
      moved("backupGenerationDigest", durableInventoryScopeDigest(
        scope, { ...basis, backupGenerationDigest: hex("f00d") }, WINDOW)),
      moved("windowStartExclusive", durableInventoryScopeDigest(
        scope, basis, { ...WINDOW, startExclusive: pos(43) })),
      moved("windowEndInclusive", durableInventoryScopeDigest(
        scope, basis, { ...WINDOW, endInclusive: pos(101) })),
    ]);
    expect(perturbed).toHaveLength(9);
    for (const [field, perturbedDigest] of perturbed) {
      // The field name travels with the value, so a survivor names itself.
      expect(`${field}:${perturbedDigest}`).not.toBe(`${field}:${digest}`);
    }
    expect(new Set([digest, ...perturbed.map(([, value]) => value)]).size).toBe(10);
  });

  it("hides a sealed window from the same basis under a different project tag", async () => {
    const { binding, store } = await populated();
    const basis = basisFor(binding);
    expect(sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE).ok).toBe(true);
    expect(readDurableRecoveryInventory(store, PROJECT_ID, basis, WINDOW).ok).toBe(true);

    const shadow = { ...basis, projectTag: `${PROJECT_TAG}-shadow` };
    const hidden = readDurableRecoveryInventory(store, PROJECT_ID, shadow, WINDOW);
    expect(hidden.ok).toBe(false);
    if (hidden.ok) throw new Error("unreachable");
    expect(hidden.upstream.code).toBe("RECORD_NOT_FOUND");
    expect(hidden.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });
});

describe("durable recovery inventory - seal completeness", () => {
  it("calls an empty class COMPLETE only when a negative proof is bound", async () => {
    const { binding, store } = await prepare();
    const basis = basisFor(binding);
    appendAll(store, basis, observationsFrom(generatedResourceRows()));

    const missing = sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE);
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.upstream.code).toBe("RECOVERY_INVENTORY_PROOF_MISSING");
    expect(missing.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);

    const proven = sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, [
      COVERAGE[0],
      { ...COVERAGE[1], negativeProofDigest: NEGATIVE_PROOF },
    ]);
    expect(proven.ok).toBe(true);
    if (!proven.ok) throw new Error("unreachable");
    const empty = proven.seal.classes.find((entry) => entry.class === "INTEGRATION_TARGET");
    expect(empty?.itemCount).toBe(0);
    expect(empty?.truth).toBe("COMPLETE");
    expect(empty?.negativeProofDigest).toBe(NEGATIVE_PROOF);
  });

  it("refuses a negative proof for a class whose window already stored rows", async () => {
    const { binding, store } = await populated();
    const basis = basisFor(binding);
    const contradicted = sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, [
      { ...COVERAGE[0], negativeProofDigest: NEGATIVE_PROOF },
      COVERAGE[1],
    ]);
    expect(contradicted.ok).toBe(false);
    if (contradicted.ok) throw new Error("unreachable");
    expect(contradicted.upstream.code).toBe("RECORD_CONFLICT");
    expect(contradicted.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });

  it("commits a seal whose per-class counts and row digests come from the store", async () => {
    const { binding, rows, store } = await populated();
    const basis = basisFor(binding);
    const sealed = sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error("unreachable");
    expect(sealed.seal.classes.map((entry) => entry.class)).toStrictEqual([
      ...DURABLE_RECOVERY_INVENTORY_CLASSES,
    ]);
    expect(sealed.seal.classes.map((entry) => entry.itemCount)).toStrictEqual([
      rows.length, INTEGRATIONS.length,
    ]);
    expect(sealed.seal.classes.every((entry) => entry.itemCount > 0)).toBe(true);
    expect(sealed.seal.classes.every((entry) => entry.truth === "COMPLETE")).toBe(true);
    for (const entry of sealed.seal.classes) {
      expect(entry.rowDigests).toHaveLength(entry.itemCount);
      expect(new Set(entry.rowDigests).size).toBe(entry.itemCount);
      expect([...entry.rowDigests]).toStrictEqual([...entry.rowDigests].sort());
    }
    expect(sealed.seal.windowEndInclusive).toBe(END_INCLUSIVE);
    expect(sealed.seal.windowStartExclusive).toBe(BACKUP_CURSOR);
  });

  it("isolates a narrower window as its own unsealed, unproven scope", async () => {
    const { binding, store } = await populated();
    const basis = basisFor(binding);
    const narrower: DurableInventoryWindow = {
      endInclusive: pos(60), startExclusive: BACKUP_CURSOR,
    };
    const refused = sealDurableInventoryWindow(store, writeRequest, basis, narrower, COVERAGE);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.upstream.code).toBe("RECOVERY_INVENTORY_PROOF_MISSING");
    const unread = readDurableRecoveryInventory(store, PROJECT_ID, basis, narrower);
    expect(unread.ok).toBe(false);
    if (unread.ok) throw new Error("unreachable");
    expect(unread.upstream.code).toBe("RECORD_NOT_FOUND");
  });

  it("refuses to read a window that was never sealed", async () => {
    const { binding, store } = await populated();
    const unsealed = readDurableRecoveryInventory(store, PROJECT_ID, basisFor(binding), WINDOW);
    expect(unsealed.ok).toBe(false);
    if (unsealed.ok) throw new Error("unreachable");
    expect(unsealed.upstream.code).toBe("RECORD_NOT_FOUND");
    expect(unsealed.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });

  it("refuses a second seal of the same window", async () => {
    const { binding, store } = await populated();
    const basis = basisFor(binding);
    expect(sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE).ok).toBe(true);
    const again = sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.upstream.code).toBe("RECORD_CONFLICT");
  });
});

describe("durable recovery inventory - tampered durable records", () => {
  it("refuses a seal whose class table moved after its digest was taken", async () => {
    const control = await populated();
    const controlBasis = basisFor(control.binding);
    const controlResolved = resolveFor(control.store, controlBasis);
    const truthfulControl = honestSeal(controlResolved);
    forgeEvent(
      control.store, controlResolved, DURABLE_INVENTORY_SEAL_EVENT_TYPE,
      sealBytes(truthfulControl), "durable-inventory-seal-forged-honest",
    );
    // Control: a seal forged this way, faithful to the stored rows, IS read —
    // and read as the whole population, so the control cannot pass on an empty
    // or partial answer.
    const accepted = readDurableRecoveryInventory(control.store, PROJECT_ID, controlBasis, WINDOW);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(`control refused: ${accepted.upstream.code}`);
    expect(accepted.observations).toHaveLength(control.rows.length + INTEGRATIONS.length);

    const { binding, store } = await populated();
    const basis = basisFor(binding);
    const resolved = resolveFor(store, basis);
    const truthful = honestSeal(resolved);
    const [resourceClass, integrationClass] = truthful.classes;
    if (resourceClass === undefined || integrationClass === undefined) {
      throw new Error("unreachable");
    }
    expect(resourceClass.itemCount).toBeGreaterThan(1);
    // Internally consistent — count still matches the list, order still sorted,
    // so only the digest over the ORIGINAL body can still refuse it.
    const altered: DurableInventorySeal = Object.freeze({
      ...truthful,
      classes: Object.freeze([
        Object.freeze({
          ...resourceClass,
          itemCount: resourceClass.itemCount - 1,
          rowDigests: Object.freeze(resourceClass.rowDigests.slice(1)),
        }),
        integrationClass,
      ]),
    });
    forgeEvent(
      store, resolved, DURABLE_INVENTORY_SEAL_EVENT_TYPE, sealBytes(altered, truthful),
      "durable-inventory-seal-forged-altered",
    );
    const refused = readDurableRecoveryInventory(store, PROJECT_ID, basis, WINDOW);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.upstream.code).toBe("RECOVERY_INVENTORY_RECORD_UNREADABLE");
    expect(refused.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });

  it("refuses seal bytes that are a second spelling of one canonical body", async () => {
    const { binding, store } = await populated();
    const basis = basisFor(binding);
    const resolved = resolveFor(store, basis);
    const canonicalBytes = sealBytes(honestSeal(resolved));
    const decoded = JSON.parse(new TextDecoder().decode(canonicalBytes)) as Record<string, unknown>;
    const respelled = encoder.encode(
      JSON.stringify(Object.fromEntries(Object.entries(decoded).reverse())),
    );
    // Same body, same length, same correct seal digest — only the order moved.
    expect(respelled.length).toBe(canonicalBytes.length);
    expect(sameDurableBytes(respelled, canonicalBytes)).toBe(false);
    forgeEvent(
      store, resolved, DURABLE_INVENTORY_SEAL_EVENT_TYPE, respelled,
      "durable-inventory-seal-forged-respelled",
    );
    const refused = readDurableRecoveryInventory(store, PROJECT_ID, basis, WINDOW);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.upstream.code).toBe("RECOVERY_INVENTORY_RECORD_UNREADABLE");
    expect(refused.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });

  it("refuses a row whose observation moved after its digest was taken", async () => {
    const control = await populated();
    const controlBasis = basisFor(control.binding);
    const controlResolved = resolveFor(control.store, controlBasis);
    const [replayed] = controlResolved.state.rows;
    if (replayed === undefined) throw new Error("unreachable");
    forgeEvent(
      control.store, controlResolved, DURABLE_INVENTORY_ROW_EVENT_TYPE,
      encodeDurableRow(replayed), "durable-inventory-row-forged-honest",
    );
    // Control: untouched bytes decode, and are caught by identity, not by shape.
    const duplicated = readDurableRecoveryInventory(
      control.store, PROJECT_ID, controlBasis, WINDOW,
    );
    expect(duplicated.ok).toBe(false);
    if (duplicated.ok) throw new Error("unreachable");
    expect(duplicated.upstream.code).toBe("RECOVERY_INVENTORY_SUBJECT_DUPLICATE");

    const { binding, store } = await populated();
    const basis = basisFor(binding);
    const resolved = resolveFor(store, basis);
    const [row] = resolved.state.rows;
    if (row === undefined) throw new Error("unreachable");
    // `observedPosition` is not part of the row identity and stays inside the
    // window, so nothing but the row digest can notice it moved.
    const altered: DurableInventoryRow = Object.freeze({
      ...row,
      observation: Object.freeze({ ...row.observation, observedPosition: pos(99) }),
    });
    expect(altered.observation.observedPosition).not.toBe(row.observation.observedPosition);
    forgeEvent(
      store, resolved, DURABLE_INVENTORY_ROW_EVENT_TYPE, encodeDurableRow(altered),
      "durable-inventory-row-forged-altered",
    );
    const refused = readDurableRecoveryInventory(store, PROJECT_ID, basis, WINDOW);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.upstream.code).toBe("RECOVERY_INVENTORY_RECORD_UNREADABLE");
    expect(refused.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });
});

describe("durable recovery inventory - hostile input", () => {
  const firstRow = (): ResourceRow => generatedResourceRows()[0] as ResourceRow;
  const withoutTarget = (): unknown => {
    const full = integration("attempt-1", "target-a", "intent-a", pos(70));
    return {
      attemptRef: full.attemptRef, class: full.class, effectIntentRef: full.effectIntentRef,
      intentDigest: full.intentDigest, observedPosition: full.observedPosition,
      sourceProofDigest: full.sourceProofDigest,
    };
  };

  const HOSTILE_CASES: readonly (readonly [string, () => unknown])[] = Object.freeze([
    ["a null observation", (): unknown => null],
    ["an array observation", (): unknown => []],
    ["an unknown class", (): unknown => ({
      ...integration("attempt-1", "target-a", "intent-a", pos(70)), class: "WORKSPACE",
    })],
    ["an extra key", (): unknown => ({
      ...integration("attempt-1", "target-a", "intent-a", pos(70)), incarnationRef: "smuggled",
    })],
    ["a missing key", withoutTarget],
    ["a non-canonical cursor width", (): unknown => ({
      ...integration("attempt-1", "target-a", "intent-a", "70"),
    })],
    ["a control character in a ref", (): unknown => ({
      ...integration("attempt-1", "target-a", "intent-a", pos(70)), targetRef: "tar	get",
    })],
    ["a non-hex source proof", (): unknown => ({
      ...integration("attempt-1", "target-a", "intent-a", pos(70)), sourceProofDigest: "nothex",
    })],
    ["an empty ref", (): unknown => ({
      ...integration("attempt-1", "target-a", "intent-a", pos(70)), targetRef: "",
    })],
    ["a negative capacity", (): unknown => ({
      ...durableResourceObservation(firstRow(), RESOURCE_PROOF, pos(43)), capacityUnits: -1,
    })],
    ["a fractional epoch", (): unknown => ({
      ...durableResourceObservation(firstRow(), RESOURCE_PROOF, pos(43)), epoch: 1.5,
    })],
    ["an unknown resource state", (): unknown => ({
      ...durableResourceObservation(firstRow(), RESOURCE_PROOF, pos(43)), state: "DISSOLVED",
    })],
    ["an unknown fenceability", (): unknown => ({
      ...durableResourceObservation(firstRow(), RESOURCE_PROOF, pos(43)), fenceability: "MAYBE",
    })],
    ["a non-boolean external flag", (): unknown => ({
      ...durableResourceObservation(firstRow(), RESOURCE_PROOF, pos(43)), external: "yes",
    })],
  ]);

  it("refuses every hostile observation with INPUT_INVALID at the adapter layer", async () => {
    const { binding, store } = await prepare();
    // A sweep that silently generated nothing would pass the loop below.
    expect(HOSTILE_CASES.length).toBeGreaterThan(0);
    for (const [label, build] of HOSTILE_CASES) {
      const refused = appendDurableInventoryObservation(
        store, writeRequest, basisFor(binding), WINDOW, build(),
      );
      expect(refused.ok, label).toBe(false);
      if (refused.ok) throw new Error("unreachable");
      expect(refused.upstream.code, label).toBe("RECOVERY_INVENTORY_INPUT_INVALID");
      expect(refused.upstream.layer, label).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
      expect(refused.truth, label).toBe("UNKNOWN");
      expect(refused.authority, label).toBe("NONE");
    }
  });

  it("refuses a basis carrying refs, counters or an item list", async () => {
    const { binding, store } = await prepare();
    const basis = basisFor(binding);
    const cases: readonly (readonly [string, unknown])[] = Object.freeze([
      ["a smuggled incarnation ref", { ...basis, incarnationRef: binding.incarnationRef }],
      ["a smuggled key epoch", { ...basis, keyEpochRef: binding.keyEpochRef }],
      ["a smuggled item list", { ...basis, items: [] }],
      ["a smuggled counter", { ...basis, itemCount: 3 }],
      ["a missing project tag", { backupCursor: BACKUP_CURSOR, backupGenerationDigest: hex("b") }],
      ["a null basis", null],
    ]);
    expect(cases.length).toBeGreaterThan(0);
    for (const [label, hostile] of cases) {
      const refused = appendDurableInventoryObservation(
        store, writeRequest, hostile, WINDOW,
        integration("attempt-1", "target-a", "intent-a", pos(70)),
      );
      expect(refused.ok, label).toBe(false);
      if (refused.ok) throw new Error("unreachable");
      expect(refused.upstream.code, label).toBe("RECOVERY_INVENTORY_INPUT_INVALID");
      expect(refused.upstream.layer, label).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
    }
  });

  it("never runs an accessor or a proxy trap on caller-supplied shapes", async () => {
    const { binding, store } = await prepare();
    let hits = 0;
    const accessorObservation = Object.defineProperties({}, {
      attemptRef: { enumerable: true, get: () => { hits += 1; return "attempt-1"; } },
      class: { enumerable: true, value: "INTEGRATION_TARGET" },
      effectIntentRef: { enumerable: true, value: "intent-a" },
      intentDigest: { enumerable: true, value: hex("d1") },
      observedPosition: { enumerable: true, value: pos(70) },
      sourceProofDigest: { enumerable: true, value: INTEGRATION_PROOF },
      targetRef: { enumerable: true, value: "target-a" },
    });
    const accessor = appendDurableInventoryObservation(
      store, writeRequest, basisFor(binding), WINDOW, accessorObservation,
    );
    expect(accessor.ok).toBe(false);
    if (accessor.ok) throw new Error("unreachable");
    expect(accessor.upstream.code).toBe("RECOVERY_INVENTORY_INPUT_INVALID");

    const trapped = new Proxy(integration("attempt-1", "target-a", "intent-a", pos(70)), {
      get: (target, key, receiver) => { hits += 1; return Reflect.get(target, key, receiver); },
      getOwnPropertyDescriptor: (target, key) => {
        hits += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys: (target) => { hits += 1; return Reflect.ownKeys(target); },
    });
    const proxied = appendDurableInventoryObservation(
      store, writeRequest, basisFor(binding), WINDOW, trapped,
    );
    expect(proxied.ok).toBe(false);
    if (proxied.ok) throw new Error("unreachable");
    expect(proxied.upstream.code).toBe("RECOVERY_INVENTORY_INPUT_INVALID");

    const proxiedBasis = appendDurableInventoryObservation(
      store, writeRequest,
      new Proxy(basisFor(binding), { ownKeys: (t) => { hits += 1; return Reflect.ownKeys(t); } }),
      WINDOW, integration("attempt-1", "target-a", "intent-a", pos(70)),
    );
    expect(proxiedBasis.ok).toBe(false);
    if (proxiedBasis.ok) throw new Error("unreachable");
    expect(proxiedBasis.upstream.code).toBe("RECOVERY_INVENTORY_INPUT_INVALID");
    expect(hits).toBe(0);
  });

  it("refuses coverage that is not exactly the two classes in canonical order", async () => {
    const { binding, store } = await populated();
    const basis = basisFor(binding);
    const cases: readonly (readonly [string, unknown])[] = Object.freeze([
      ["reversed order", [COVERAGE[1], COVERAGE[0]]],
      ["one class", [COVERAGE[0]]],
      ["duplicated class", [COVERAGE[0], COVERAGE[0]]],
      ["a runner class", [COVERAGE[0], { ...COVERAGE[1], class: "WORKSPACE" }]],
      ["a smuggled item list", [COVERAGE[0], { ...COVERAGE[1], items: [] }]],
      ["a non-hex negative proof", [
        COVERAGE[0], { ...COVERAGE[1], negativeProofDigest: "nothex" },
      ]],
      ["a null coverage", null],
    ]);
    expect(cases.length).toBeGreaterThan(0);
    for (const [label, coverage] of cases) {
      const refused = sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, coverage);
      expect(refused.ok, label).toBe(false);
      if (refused.ok) throw new Error("unreachable");
      expect(refused.upstream.code, label).toBe("RECOVERY_INVENTORY_INPUT_INVALID");
      expect(refused.upstream.layer, label).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
    }
  });
});

describe("durable recovery inventory - daemon registration bridge", () => {
  it("exposes exactly two immutable class fragments and no mutable global registry", async () => {
    const { binding, store } = await populated();
    const basis = basisFor(binding);
    expect(sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE).ok).toBe(true);

    const registrations = createDurableRecoveryInventoryRegistrations(store, PROJECT_ID);
    expect(Object.isFrozen(registrations)).toBe(true);
    expect(registrations).toHaveLength(2);
    expect(registrations.map((entry) => entry.class)).toStrictEqual([
      ...DURABLE_RECOVERY_INVENTORY_CLASSES,
    ]);
    for (const registration of registrations) {
      expect(Object.isFrozen(registration)).toBe(true);
      expect(typeof registration.enumerate).toBe("function");
      // Basis and window only: an enumerator that also took an item list would
      // let a caller hand the daemon its own answer.
      expect(registration.enumerate.length).toBe(2);
    }
    const other = createDurableRecoveryInventoryRegistrations(store, PROJECT_ID);
    expect(other).not.toBe(registrations);
    expect(other.map((entry) => entry.class)).toStrictEqual(
      registrations.map((entry) => entry.class),
    );
  });

  it("enumerates from the sealed store and returns frozen rows plus a proof fragment",
    async () => {
      const { binding, rows, store } = await populated();
      const basis = basisFor(binding);
      expect(sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE).ok)
        .toBe(true);
      const [resource, integrations] =
        createDurableRecoveryInventoryRegistrations(store, PROJECT_ID);

      const resourceResult = resource.enumerate(basis, WINDOW);
      expect(resourceResult.ok).toBe(true);
      if (!resourceResult.ok) throw new Error("unreachable");
      expect(resourceResult.class).toBe("RESOURCE");
      expect(resourceResult.itemCount).toBe(rows.length);
      expect(resourceResult.observations).toHaveLength(rows.length);
      expect(Object.isFrozen(resourceResult.observations)).toBe(true);
      expect(resourceResult.observations.every((row) => Object.isFrozen(row))).toBe(true);
      expect(resourceResult.observations.every((row) => row.class === "RESOURCE")).toBe(true);
      expect(resourceResult.proof).toStrictEqual({
        class: "RESOURCE",
        sourceProofDigest: RESOURCE_PROOF,
        truth: "COMPLETE",
        upstream: null,
      });

      const integrationResult = integrations.enumerate(basis, WINDOW);
      expect(integrationResult.ok).toBe(true);
      if (!integrationResult.ok) throw new Error("unreachable");
      expect(integrationResult.class).toBe("INTEGRATION_TARGET");
      expect(integrationResult.itemCount).toBe(INTEGRATIONS.length);
      expect(integrationResult.observations.every((row) =>
        row.class === "INTEGRATION_TARGET")).toBe(true);
      expect(integrationResult.proof.sourceProofDigest).toBe(INTEGRATION_PROOF);
    });

  it("refuses an enumerator asked for a window the store never sealed", async () => {
    const { binding, store } = await populated();
    const [resource] = createDurableRecoveryInventoryRegistrations(store, PROJECT_ID);
    const refused = resource.enumerate(basisFor(binding), WINDOW);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.upstream.code).toBe("RECORD_NOT_FOUND");
    expect(refused.upstream.layer).toBe(DURABLE_INVENTORY_ADAPTER_LAYER);
  });

  it("hands its proof fragments straight to the reconciliation record builder", async () => {
    const { binding, store } = await populated();
    const basis = basisFor(binding);
    expect(sealDurableInventoryWindow(store, writeRequest, basis, WINDOW, COVERAGE).ok).toBe(true);
    const fragments = createDurableRecoveryInventoryRegistrations(store, PROJECT_ID).map(
      (registration) => {
        const enumerated = registration.enumerate(basis, WINDOW);
        if (!enumerated.ok) throw new Error(`enumerate refused: ${enumerated.upstream.code}`);
        return enumerated.proof;
      },
    );
    expect(fragments).toHaveLength(2);
    const bridged = new Map(fragments.map((fragment) => [fragment.class as string, fragment]));

    const written = recordRecoveryReconciliation(store, writeRequest, {
      backupCursor: BACKUP_CURSOR,
      backupGenerationDigest: binding.backupGenerationDigest,
      configuredClasses: [...RECOVERY_PROOF_CLASSES],
      projectTag: PROJECT_TAG,
      proofs: RECOVERY_PROOF_CLASSES.map((proofClass, index) =>
        bridged.get(proofClass) ?? {
          class: proofClass,
          sourceProofDigest: hex(`e${index}`),
          truth: "COMPLETE" as const,
          upstream: null,
        }),
      subjects: RECOVERY_INVENTORY_POPULATIONS.map((population) => {
        const covering = recoveryPopulationClass(population) as RecoveryProofClass;
        return {
          class: covering as string,
          evidence: { kind: "NEGATIVE_COMPLETE" as const, proofDigest: hex("ab") },
          identity: `external-${population}`,
          population: population as string,
          sourceProofDigest:
            bridged.get(covering)?.sourceProofDigest ??
            hex(`e${RECOVERY_PROOF_CLASSES.indexOf(covering)}`),
        };
      }),
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error(`record refused: ${written.upstream.code}`);
    const resourceProof = written.record.proofs.find((proof) => proof.class === "RESOURCE");
    const integrationProof = written.record.proofs.find(
      (proof) => proof.class === "INTEGRATION_TARGET",
    );
    expect(resourceProof?.sourceProofDigest).toBe(RESOURCE_PROOF);
    expect(integrationProof?.sourceProofDigest).toBe(INTEGRATION_PROOF);
  });
});
