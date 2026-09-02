import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { reduceCutover } from "@moe/core";
import type { CutoverAttemptState, CutoverCommand } from "@moe/core";

import {
  RECOVERY_BINDING_CODEC_VERSION,
  SqliteEventStore,
} from "../../packages/store/src/index.js";
import { recoveryBindingDigest } from "../../packages/store/src/recovery-install-codec.js";
import {
  GA_ACTIVATION_WORK_REF,
  GO_ACTIVATE_GATE_ID,
} from "../../packages/benchmark/src/activation-binding.js";
import type { ActivationBinding } from "../../packages/benchmark/src/activation-binding.js";

import { compareRangePin } from "../../apps/daemon/src/recovery/doctor-version-contract.js";
import {
  PROJECT_CATALOG_LAYER,
  PROJECT_CATALOG_UNREADABLE,
  PROJECT_CATALOG_WRITE_FAILED,
} from "../../apps/daemon/src/projects/project-catalog.js";
import { appendDurableInventoryObservation } from "../../apps/daemon/src/recovery/durable-recovery-inventory.js";
import { storeUnavailable } from "../../apps/daemon/src/recovery/recovery-completion-evidence.js";
import { createNodeRecoveryCryptoPort } from "../../apps/daemon/src/recovery/recovery-incarnation.node.js";
import { createRecoveryIncarnationService } from "../../apps/daemon/src/recovery/recovery-incarnation.js";
import {
  RECOVERY_INVENTORY_LAYER,
  RECOVERY_INVENTORY_LEDGER_LAYER,
  recoveryInventoryRefusal,
} from "../../apps/daemon/src/recovery/recovery-inventory-contract.js";
import { readRecoveryReconciliation } from "../../apps/daemon/src/recovery/recovery-inventory-ledger.js";
import { createRecoverySuccessionService } from "../../apps/daemon/src/recovery/recovery-succession.js";
import { runRestoreQuiesce } from "../../apps/daemon/src/recovery/restore-controller.js";
import { restoreRefusal } from "../../apps/daemon/src/recovery/restore-controller-contract.js";
import {
  PRINCIPAL_ID as LOOKUP_PRINCIPAL_ID,
  PROJECT_ID as LOOKUP_PROJECT_ID,
  cleanupRestoreHarnesses,
} from "../../apps/daemon/src/recovery/restore-test-harness.js";
import {
  SAFE_BOUNDARY_LOOKUP_LAYER,
  readCurrentSafeBoundaryObservation,
} from "../../apps/daemon/src/work/attempt-safe-boundary-lookup.js";
import {
  SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE,
  recordSafeBoundaryObservation,
} from "../../apps/daemon/src/work/safe-boundary-observation.js";
import {
  FINAL_ATTEMPT_REF,
  finalizationWorld,
  withStoreOverride,
} from "../../apps/daemon/src/work/attempt-finalization-test-harness.js";
import { inspectRecoveryAnchor, prepareRecoveryAnchor } from "../../packages/store/src/recovery-anchor.js";
import { decodeRecoveryBinding } from "../../packages/store/src/recovery-install-codec.js";
import { admitCutoverActivateApproval } from "../../apps/daemon/src/cutover/cutover-attempt-commit.js";
import {
  CUTOVER_ATTEMPT_EVENT_TYPE,
  CUTOVER_ATTEMPT_LAYER,
  deriveCutoverAttemptAggregateId,
  encodeCutoverAttemptEvent,
} from "../../apps/daemon/src/cutover/cutover-attempt-contracts.js";
import type { CutoverAttemptStore } from "../../apps/daemon/src/cutover/cutover-attempt-contracts.js";
import { readCutoverAttemptState } from "../../apps/daemon/src/cutover/cutover-attempt-reader.js";
import {
  CUTOVER_GENERATION_SNAPSHOT_LAYER,
  LIVE_QUIESCE_EVIDENCE_FILENAME,
  readCutoverGenerationSnapshot,
} from "../../apps/daemon/src/cutover/cutover-generation-snapshot.js";
import type { CutoverGenerationPorts } from "../../apps/daemon/src/cutover/cutover-generation-snapshot.js";
import {
  IMPORT_GENERATION_READ_LAYER,
  readDurableImportGeneration,
} from "../../apps/daemon/src/projections/import-generation-reader.js";
import {
  DIGEST as CLOSURE_IMPORT_DIGEST,
  recordOf as closureImportRecord,
  seedImport as seedClosureImport,
} from "../../apps/daemon/src/projections/import-shadow-test-fixtures.js";
import { hostileRoot } from "./hostile-harness.js";
import { runProjectCatalogRefusal } from "./project-catalog-durable-scenarios.js";
import {
  SAFE_BOUNDARY_OBSERVATION_LAYER,
  safeBoundaryAfter,
  safeBoundaryBefore,
} from "./safe-boundary-observation-scenarios.js";
import {
  IMPORT_SHADOW_READ_LAYER,
  SEEDED_IMPORT_ROWS,
  importShadowClosedStore,
  importShadowMissingRow,
  importShadowRoot,
} from "./import-shadow-boundary-scenarios.js";
import type { RefusalExpectation } from "./hostile-harness.js";

export const DURABLE_BOUNDARY_NAMES = Object.freeze([
  "DOCTOR_VERSION_LAYERS",
  "IMPORT_SHADOW_READ_LAYER",
  "PROJECT_CATALOG_LAYER",
  "DURABLE_INVENTORY_ADAPTER_LAYER",
  "DURABLE_STORE_LAYER",
  "RECOVERY_INCARNATION_LAYER",
  "RECOVERY_INVENTORY_LAYER",
  "RECOVERY_INVENTORY_LEDGER_LAYER",
  "RECOVERY_INVENTORY_UPSTREAM_LAYERS",
  "RECOVERY_SUCCESSION_LAYER",
  "RESTORE_CONTROLLER_LAYER",
  "RESTORE_REFUSAL_LAYERS",
  "RECOVERY_ANCHOR_LAYER",
  "RECOVERY_BINDING_CODEC_LAYER",
  "RECOVERY_INSTALL_LAYERS",
  "RECOVERY_INSTALL_TRANSACTION_LAYER",
  "SAFE_BOUNDARY_LOOKUP_LAYER",
  "SAFE_BOUNDARY_OBSERVATION_LAYER",
] as const);

export type DurableBoundaryName = (typeof DURABLE_BOUNDARY_NAMES)[number];
export type HostilePhase = "AFTER" | "BEFORE";

export interface RefusalCase {
  readonly boundary: DurableBoundaryName;
  readonly expected: RefusalExpectation;
  readonly phase: HostilePhase;
  readonly preexistingRecords: number;
  readonly question: string;
  readonly upstream?: Readonly<{ code: string; layer: string }>;
}

export interface RefusalCaseResult {
  readonly authority: unknown;
  readonly durableComplete: boolean;
  readonly durableRecords: number;
  readonly primary?: Readonly<{ code: string; refusedBy: string }> | undefined;
  readonly refusal: unknown;
  readonly truth: unknown;
  readonly upstream?: Readonly<{ code: string; layer: string }> | undefined;
}

const INVENTORY = { code: "UNKNOWN_TRUTH", layer: RECOVERY_INVENTORY_LAYER } as const;
const LEDGER_UPSTREAM = { code: "RECORD_NOT_FOUND", layer: RECOVERY_INVENTORY_LEDGER_LAYER } as const;

const expectations = (boundary: DurableBoundaryName, phase: HostilePhase): RefusalExpectation => {
  switch (boundary) {
    case "DOCTOR_VERSION_LAYERS":
      return { code: "DOCTOR_PIN_RANGE_UNSUPPORTED", layer: "DOCTOR_VERSION" };
    // BEFORE closes the store, so the horizon read is the first branch that can answer and
    // nothing downstream is reachable. AFTER seeds a REAL import and then loses one row, so
    // every earlier layer passes and only the sequence hole can refuse. Two different codes
    // because two different branches answer -- a single code across both phases would be
    // green no matter which one ran.
    case "IMPORT_SHADOW_READ_LAYER":
      return {
        code: phase === "BEFORE" ? "IMPORT_SHADOW_STORE_UNREADABLE" : "IMPORT_SHADOW_EVIDENCE_MALFORMED",
        layer: IMPORT_SHADOW_READ_LAYER,
      };
    case "PROJECT_CATALOG_LAYER":
      return {
        code: phase === "BEFORE" ? PROJECT_CATALOG_UNREADABLE : PROJECT_CATALOG_WRITE_FAILED,
        layer: PROJECT_CATALOG_LAYER,
      };
    case "DURABLE_INVENTORY_ADAPTER_LAYER":
      return INVENTORY;
    case "DURABLE_STORE_LAYER":
      return { code: "STORE_CLOSED", layer: "DURABLE_STORE" };
    case "RECOVERY_INCARNATION_LAYER":
      return { code: "RECOVERY_INCARNATION_INPUT_INVALID", layer: "RECOVERY_INCARNATION" };
    case "RECOVERY_INVENTORY_LAYER":
    case "RECOVERY_INVENTORY_LEDGER_LAYER":
    case "RECOVERY_INVENTORY_UPSTREAM_LAYERS":
      return INVENTORY;
    case "RECOVERY_SUCCESSION_LAYER":
      return {
        code: phase === "BEFORE" ? "RECOVERY_SUCCESSION_INPUT_INVALID" : "RECOVERY_PREDECESSOR_NOT_FOUND",
        layer: "RECOVERY_SUCCESSION",
      };
    case "RESTORE_CONTROLLER_LAYER":
      return { code: "RESTORE_REQUEST_SHAPE_INVALID", layer: "DAEMON_RESTORE_CONTROLLER" };
    case "RESTORE_REFUSAL_LAYERS":
      return phase === "BEFORE"
        ? { code: "STORE_CLOSED", layer: "DURABLE_STORE" }
        : { code: "RECOVERY_PREDECESSOR_NOT_FOUND", layer: "RECOVERY_SUCCESSION" };
    case "RECOVERY_ANCHOR_LAYER":
      return {
        code: phase === "BEFORE" ? "RECOVERY_ANCHOR_REQUEST_INVALID" : "RECOVERY_ANCHOR_INCARNATION_REUSED",
        layer: "RECOVERY_ANCHOR",
      };
    case "RECOVERY_BINDING_CODEC_LAYER":
      return { code: "RECOVERY_BINDING_CODEC_VERSION_UNSUPPORTED", layer: "RECOVERY_BINDING_CODEC" };
    case "RECOVERY_INSTALL_LAYERS":
      return { code: "RECOVERY_BINDING_SHAPE_INVALID", layer: "RECOVERY_BINDING_CODEC" };
    case "RECOVERY_INSTALL_TRANSACTION_LAYER":
      return {
        code: phase === "BEFORE" ? "RECOVERY_INSTALL_SCOPE_REQUIRED" : "RECOVERY_INSTALL_INCARNATION_CONFLICT",
        layer: "RECOVERY_INSTALL_TRANSACTION",
      };
    case "SAFE_BOUNDARY_LOOKUP_LAYER":
      return {
        code: phase === "BEFORE"
          ? "SAFE_BOUNDARY_LOOKUP_QUERY_MALFORMED" : "SAFE_BOUNDARY_LOOKUP_UNRESOLVED",
        layer: SAFE_BOUNDARY_LOOKUP_LAYER,
      };
    // BEFORE refuses the caller's own boundary CLAIM before any durable authority is read;
    // AFTER reads back a real committed observation from a rival project, so every earlier
    // layer admitted and only the read-side project check can answer. Two branches, two
    // codes -- one code across both phases would be green whichever one ran. The layer comes
    // off the boundary's OWN exported constant rather than a literal nobody rechecks.
    case "SAFE_BOUNDARY_OBSERVATION_LAYER":
      return {
        code: phase === "BEFORE" ? "SAFE_BOUNDARY_INPUT_MALFORMED" : "SAFE_BOUNDARY_OBSERVATION_ABSENT",
        layer: SAFE_BOUNDARY_OBSERVATION_LAYER,
      };
  }
};

const questions: Readonly<Record<DurableBoundaryName, readonly [string, string]>> = Object.freeze({
  DOCTOR_VERSION_LAYERS: ["unsupported declared range stays unknown", "stale declared range gains no authority"],
  IMPORT_SHADOW_READ_LAYER: ["a closed durable reader yields no shadow projection", "an import missing a row cannot become evidence"],
  PROJECT_CATALOG_LAYER: ["an unreadable catalog cannot become an empty catalog", "a failed atomic replacement preserves the prior catalog"],
  DURABLE_INVENTORY_ADAPTER_LAYER: ["malformed observation preserves its upstream tuple", "late malformed observation cannot write"],
  DURABLE_STORE_LAYER: ["a closed durable reader fails closed", "a stale closed reader cannot invent evidence"],
  RECOVERY_INCARNATION_LAYER: ["malformed mint input is refused", "one restore command cannot change generation"],
  RECOVERY_INVENTORY_LAYER: ["fabricated upstream evidence stays unknown", "stale upstream evidence stays unknown"],
  RECOVERY_INVENTORY_LEDGER_LAYER: ["an absent digest is not evidence", "an old absent digest remains unknown"],
  RECOVERY_INVENTORY_UPSTREAM_LAYERS: ["the upstream tuple identifies the cause", "the tuple survives a stale read"],
  RECOVERY_SUCCESSION_LAYER: ["a malformed link is refused", "a missing predecessor cannot be claimed"],
  RESTORE_CONTROLLER_LAYER: ["a forged restore request is refused", "a stale malformed request cannot settle"],
  RESTORE_REFUSAL_LAYERS: ["store refusal is not collapsed", "succession refusal is not collapsed"],
  RECOVERY_ANCHOR_LAYER: ["a malformed anchor request is refused", "a command cannot reuse another anchor fence"],
  RECOVERY_BINDING_CODEC_LAYER: ["unknown codec bytes are refused", "stale codec bytes remain unreadable"],
  RECOVERY_INSTALL_LAYERS: ["malformed binding input is refused", "malformed replacement cannot overwrite"],
  RECOVERY_INSTALL_TRANSACTION_LAYER: ["unscoped install is refused", "one incarnation cannot occupy two slots"],
  SAFE_BOUNDARY_LOOKUP_LAYER: [
    "an empty attempt selector never reaches the store",
    "one project's observation is unresolved for another project",
  ],
  SAFE_BOUNDARY_OBSERVATION_LAYER: ["an agent cannot declare its own boundary observed", "a committed observation is not another project's evidence"],
});

/**
 * What the store legitimately holds when the AFTER arm runs. Written per boundary rather
 * than defaulted, because the runner asserts the durable count EXACTLY: a refusal that
 * created a fragment and a refusal that deleted a row both move this number.
 */
const preexistingAfter = (boundary: DurableBoundaryName): number => {
  if (boundary === "RECOVERY_INSTALL_TRANSACTION_LAYER" || boundary === "RECOVERY_ANCHOR_LAYER") return 1;
  // The observation production committed on the way in. It is still durable: the rival
  // project was refused the READ, and a refused read must not delete what it could not have.
  if (boundary === "SAFE_BOUNDARY_OBSERVATION_LAYER") return 1;
  if (boundary === "SAFE_BOUNDARY_LOOKUP_LAYER") return 1;
  // The two claims the import corpus seeds through `commitLegacyImport`, both still durable:
  // the row the reader never saw was hidden by the narrowing port, not removed from the store.
  if (boundary === "IMPORT_SHADOW_READ_LAYER") return SEEDED_IMPORT_ROWS;
  if (boundary === "PROJECT_CATALOG_LAYER") return 1;
  return 0;
};

const casesFor = (phase: HostilePhase): readonly RefusalCase[] =>
  Object.freeze(DURABLE_BOUNDARY_NAMES.map((boundary) => ({
    boundary,
    expected: expectations(boundary, phase),
    phase,
    preexistingRecords: phase === "AFTER"
      ? preexistingAfter(boundary)
      : 0,
    question: questions[boundary][phase === "BEFORE" ? 0 : 1],
    ...(boundary === "DURABLE_INVENTORY_ADAPTER_LAYER"
      ? { upstream: { code: "RECOVERY_INVENTORY_INPUT_INVALID", layer: "INVENTORY_ADAPTER" } }
      : boundary === "SAFE_BOUNDARY_LOOKUP_LAYER" && phase === "AFTER"
        ? { upstream: {
          code: "SAFE_BOUNDARY_OBSERVATION_ABSENT", layer: SAFE_BOUNDARY_OBSERVATION_LAYER,
        } }
      : boundary === "RECOVERY_INVENTORY_LAYER" || boundary === "RECOVERY_INVENTORY_LEDGER_LAYER"
        || boundary === "RECOVERY_INVENTORY_UPSTREAM_LAYERS"
        ? { upstream: LEDGER_UPSTREAM }
        : {}),
  })));

export const hostileBeforeCases = casesFor("BEFORE");
export const hostileAfterCases = casesFor("AFTER");

export interface RaceCase {
  readonly boundary: DurableBoundaryName;
  /** Exact refusal for races that must refuse. A convergent race admits both callers. */
  readonly expected?: RefusalExpectation;
  /** Rows the store must hold once the race settles. Pinned so a lost or duplicated
   *  write is a failure rather than an unnoticed change of subject. */
  readonly expectedDurableEvents: number;
  readonly question: string;
}

/**
 * Most boundaries race two hostile WRITERS for a single durable version; two do not, and
 * each says why out loud rather than letting a shared literal hide it.
 *
 * The import-shadow read owns no writer at all, so its race is the one a pure READER can
 * lose: a commit landing between the horizon it opened on and the horizon it closed on.
 *
 * The safe-boundary observation owns a writer and races two callers for one durable identity
 * like the majority — but its refusal is its OWN code, not the store's: it wraps the declined
 * commit as SAFE_BOUNDARY_COMMIT_CONFLICT and keeps EXPECTED_VERSION_CONFLICT upstream
 * (task-f8ea0a2f), so the shared literal below would grade the wrong layer.
 */
function raceFor(boundary: DurableBoundaryName): RaceCase {
  if (boundary === "IMPORT_SHADOW_READ_LAYER") {
    return {
      boundary,
      expected: { code: "IMPORT_SHADOW_HORIZON_DRIFT", layer: IMPORT_SHADOW_READ_LAYER },
      expectedDurableEvents: SEEDED_IMPORT_ROWS + 1,
      question: `a commit landing mid-read cannot be projected into one ${boundary} answer`,
    };
  }
  if (boundary === "SAFE_BOUNDARY_OBSERVATION_LAYER") {
    return {
      boundary,
      expected: {
        code: "SAFE_BOUNDARY_COMMIT_CONFLICT", layer: SAFE_BOUNDARY_OBSERVATION_LAYER,
      },
      expectedDurableEvents: 1,
      question: `two ${boundary} writers cannot both own one durable identity`,
    };
  }
  if (boundary === "SAFE_BOUNDARY_LOOKUP_LAYER") {
    return {
      boundary,
      expected: { code: "SAFE_BOUNDARY_LOOKUP_ABSENT", layer: SAFE_BOUNDARY_LOOKUP_LAYER },
      expectedDurableEvents: 1,
      question: `a mid-scan observation yields a bounded refusal, then the newest ${boundary} answer`,
    };
  }
  if (boundary === "PROJECT_CATALOG_LAYER") {
    return {
      boundary,
      expected: { code: PROJECT_CATALOG_WRITE_FAILED, layer: PROJECT_CATALOG_LAYER },
      expectedDurableEvents: 1,
      question: `two hostile ${boundary} writers preserve the one prior catalog`,
    };
  }
  return {
    boundary,
    expected: { code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE" },
    expectedDurableEvents: 1,
    question: `two ${boundary} callers cannot both claim one durable version`,
  };
}

export const hostileRaceCases: readonly RaceCase[] = Object.freeze(
  DURABLE_BOUNDARY_NAMES.map(raceFor),
);

const digest = (character: string): string => character.repeat(64);
const binding = (slot: "ACTIVE" | "PENDING", key: string) => ({
  bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
  incarnationRef: digest("a"),
  installedAt: "2026-08-16T00:00:00.000Z",
  keyEpochRef: digest(key),
  payload: new TextEncoder().encode(`binding-${slot}`),
  slot,
});

const anchorRequest = (root: string, command = "restore-anchor", incarnation = "incarnation-a") => ({
  anchorRoot: root,
  generationDigest: "generation-a",
  incarnationRef: incarnation,
  keyEpochRef: "key-epoch-a",
  preparedAt: "2026-08-16T00:00:00.000Z",
  projectId: "security-project",
  restoreCommandId: command,
  payload: { artifacts: [], databaseBytes: new Uint8Array([1]) },
});

const recordProperties = (value: unknown): Pick<RefusalCaseResult, "authority" | "truth"> => {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return { authority: record["authority"], truth: record["truth"] };
};

const lookupInput = (slug: string): Record<string, unknown> => ({
  attemptRef: FINAL_ATTEMPT_REF,
  correlationId: `corr-safe-boundary-lookup-${slug}`,
  key: {
    commandId: `cmd-safe-boundary-lookup-${slug}`,
    principalId: LOOKUP_PRINCIPAL_ID,
    projectId: LOOKUP_PROJECT_ID,
  },
  projectId: LOOKUP_PROJECT_ID,
  requestBytes: new TextEncoder().encode(`safe-boundary-lookup-${slug}`),
});

function lookupObservationCount(store: SqliteEventStore): number {
  return store.readEventsByTypeAfter(SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE, 0n, 100).items.length;
}

function lookupObservationsComplete(store: SqliteEventStore): boolean {
  return store.readEventsByTypeAfter(SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE, 0n, 100).items
    .every((event) => event.eventId.length > 0 && event.payload.byteLength > 0);
}

function safeBoundaryLookupBefore(): SafeBoundaryLookupScenarioOutcome {
  const root = hostileRoot("safe-boundary-lookup-before");
  const store = SqliteEventStore.openForProject(join(root, "project.db"), LOOKUP_PROJECT_ID);
  try {
    const refusal = readCurrentSafeBoundaryObservation(store, {
      attemptRef: "", projectId: LOOKUP_PROJECT_ID,
    });
    return {
      durableComplete: lookupObservationsComplete(store),
      durableRecords: lookupObservationCount(store),
      refusal,
    };
  } finally { store.close(); }
}

function safeBoundaryLookupAfter(): SafeBoundaryLookupScenarioOutcome {
  const world = finalizationWorld("safe-boundary-lookup-after");
  try {
    const written = recordSafeBoundaryObservation(world.store, lookupInput("after"));
    if (!written.ok) throw new Error(`lookup observation seed refused: ${written.code}`);
    const refusal = readCurrentSafeBoundaryObservation(world.store, {
      attemptRef: FINAL_ATTEMPT_REF, projectId: `${LOOKUP_PROJECT_ID}-rival`,
    });
    if (refusal.ok || refusal.source?.layer !== SAFE_BOUNDARY_OBSERVATION_LAYER) {
      throw new Error("lookup did not preserve the observation reader's refusal layer");
    }
    return {
      durableComplete: lookupObservationsComplete(world.store),
      durableRecords: lookupObservationCount(world.store),
      refusal,
      upstream: refusal.source,
    };
  } finally {
    world.store.close();
    cleanupRestoreHarnesses();
  }
}

export interface SafeBoundaryLookupScenarioOutcome {
  readonly durableComplete: boolean;
  readonly durableRecords: number;
  readonly refusal: unknown;
  readonly upstream?: Readonly<{ code: string; layer: string }>;
}

export interface SafeBoundaryLookupRaceOutcome extends SafeBoundaryLookupScenarioOutcome {
  readonly admittedSides: number;
  readonly newestObservationRef: string;
  readonly sides: readonly [unknown, unknown];
}

export function safeBoundaryLookupRace(): SafeBoundaryLookupRaceOutcome {
  const world = finalizationWorld("safe-boundary-lookup-race");
  const rival = SqliteEventStore.openForProject(world.storePath, LOOKUP_PROJECT_ID);
  let committed = false;
  try {
    const midScanStore = withStoreOverride(world.store, {
      readEventsByTypeAfter: (eventType: string, cursor: bigint, limit: number) => {
        if (eventType === SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE && !committed) {
          const written = recordSafeBoundaryObservation(rival, lookupInput("race"));
          if (!written.ok) throw new Error(`mid-scan observation refused: ${written.code}`);
          committed = true;
        }
        return world.store.readEventsByTypeAfter(eventType, cursor, limit);
      },
    });
    const bounded = readCurrentSafeBoundaryObservation(midScanStore, {
      attemptRef: FINAL_ATTEMPT_REF, projectId: LOOKUP_PROJECT_ID,
    });
    const newest = readCurrentSafeBoundaryObservation(rival, {
      attemptRef: FINAL_ATTEMPT_REF, projectId: LOOKUP_PROJECT_ID,
    });
    if (bounded.ok || bounded.code !== "SAFE_BOUNDARY_LOOKUP_ABSENT" || !newest.ok) {
      throw new Error("lookup race did not yield bounded-absent then newest observation");
    }
    return {
      admittedSides: 1,
      durableComplete: lookupObservationsComplete(world.store),
      durableRecords: lookupObservationCount(world.store),
      refusal: bounded,
      newestObservationRef: newest.observationRef,
      sides: [bounded, newest],
    };
  } finally {
    rival.close();
    world.store.close();
    cleanupRestoreHarnesses();
  }
}

type BoundaryOutcome = {
  readonly refusal: unknown;
  readonly primary?: RefusalCaseResult["primary"];
  readonly upstream?: RefusalCaseResult["upstream"];
};

function closedStoreRefusal(root: string, phase: HostilePhase): BoundaryOutcome {
  const closed = SqliteEventStore.openForProject(join(root, "closed.sqlite"), "security-project");
  try { closed.getAggregateVersion("pre-close-probe"); }
  finally { closed.close(); }
  let failure: unknown;
  try {
    closed.getAggregateVersion(`closed-reader-${phase.toLowerCase()}`);
    throw new Error("closed store unexpectedly answered");
  } catch (error) {
    failure = error;
  }
  const primary = storeUnavailable(failure);
  if (primary.upstream === null) throw new Error("closed store did not preserve its upstream refusal");
  return { refusal: primary.upstream, primary: { code: primary.code, refusedBy: primary.refusedBy } };
}

async function recoveryRefusal(
  hostileCase: RefusalCase,
  store: SqliteEventStore,
  root: string,
): Promise<BoundaryOutcome | null> {
  const { boundary, phase } = hostileCase;
  if (boundary === "DOCTOR_VERSION_LAYERS") {
    const value = phase === "BEFORE" ? "*" : "workspace:*";
    return { refusal: compareRangePin("ENGINES_NODE", { known: true, value }, { known: true, value: "22.0.0" }).declared };
  }
  if (boundary === "DURABLE_INVENTORY_ADAPTER_LAYER") {
    const record = phase === "BEFORE" ? {} : { observedAt: "sealed-window" };
    const refusal = appendDurableInventoryObservation(store, record, {}, {}, {});
    return { refusal, upstream: refusal.ok ? undefined : refusal.upstream };
  }
  if (boundary === "DURABLE_STORE_LAYER") return closedStoreRefusal(root, phase);
  if (boundary === "RECOVERY_INCARNATION_LAYER") {
    const service = createRecoveryIncarnationService(createNodeRecoveryCryptoPort());
    if (phase === "BEFORE") return { refusal: await service.mint({}) };
    const first = await service.mint({ backupGenerationDigest: digest("a"), restoreCommandId: "restore-incarnation" });
    if (!first.ok) throw new Error(`incarnation setup refused: ${first.code}`);
    return { refusal: await service.mint({ backupGenerationDigest: digest("b"), restoreCommandId: "restore-incarnation" }) };
  }
  if (boundary === "RECOVERY_INVENTORY_LAYER") {
    return { refusal: recoveryInventoryRefusal(LEDGER_UPSTREAM, "hostile upstream claim"), upstream: LEDGER_UPSTREAM };
  }
  if (boundary === "RECOVERY_INVENTORY_LEDGER_LAYER" || boundary === "RECOVERY_INVENTORY_UPSTREAM_LAYERS") {
    const refusal = readRecoveryReconciliation(store, "security-project", digest(phase === "BEFORE" ? "a" : "b"));
    return { refusal, upstream: refusal.ok ? undefined : refusal.upstream };
  }
  if (boundary === "RECOVERY_SUCCESSION_LAYER") {
    const service = createRecoverySuccessionService(createNodeRecoveryCryptoPort());
    const request = phase === "BEFORE" ? {} : {
      backupGenerationDigest: digest("b"), correlationId: "corr", decidedAt: "2026-08-16T00:00:00.000Z",
      predecessorIncarnationRef: digest("a"), principalId: "principal", projectId: "security-project",
      restoreCommandId: "restore-successor",
    };
    return { refusal: await service.succeed(store, request) };
  }
  return null;
}

async function remainingRefusal(
  hostileCase: RefusalCase,
  store: SqliteEventStore,
  root: string,
): Promise<BoundaryOutcome> {
  const { boundary, phase } = hostileCase;
  if (boundary === "RESTORE_CONTROLLER_LAYER") {
    const request = phase === "BEFORE" ? {} : { restoreCommandId: "stale-restore" };
    return { refusal: runRestoreQuiesce(store, request) };
  }
  if (boundary === "RESTORE_REFUSAL_LAYERS") {
    return { refusal: phase === "BEFORE"
      ? restoreRefusal("DURABLE_STORE", "STORE_CLOSED")
      : restoreRefusal("RECOVERY_SUCCESSION", "RECOVERY_PREDECESSOR_NOT_FOUND") };
  }
  if (boundary === "RECOVERY_ANCHOR_LAYER") {
    if (phase === "BEFORE") return { refusal: await inspectRecoveryAnchor({}) };
    const first = await prepareRecoveryAnchor(anchorRequest(root));
    if (!first.ok) throw new Error(`anchor setup refused: ${first.code}`);
    return { refusal: await prepareRecoveryAnchor(anchorRequest(root, "restore-other", "incarnation-a")) };
  }
  if (boundary === "RECOVERY_BINDING_CODEC_LAYER") {
    const bytes = new TextEncoder().encode(`hostile-unknown-codec-${phase.toLowerCase()}`);
    return { refusal: decodeRecoveryBinding(bytes, recoveryBindingDigest(bytes)) };
  }
  if (boundary === "RECOVERY_INSTALL_LAYERS") {
    return { refusal: store.installRecoveryBinding(phase === "BEFORE" ? {} : { slot: "ACTIVE" }) };
  }
  if (phase === "BEFORE") {
    const unscoped = SqliteEventStore.open(join(root, "unscoped.sqlite"));
    try { return { refusal: unscoped.installRecoveryBinding(binding("ACTIVE", "b")) }; }
    finally { unscoped.close(); }
  }
  const installed = store.installRecoveryBinding(binding("ACTIVE", "b"));
  if (!installed.ok) throw new Error(`install setup refused: ${installed.code}`);
  return { refusal: store.installRecoveryBinding(binding("PENDING", "c")) };
}

async function boundaryRefusal(
  hostileCase: RefusalCase,
  store: SqliteEventStore,
  root: string,
): Promise<BoundaryOutcome> {
  return await recoveryRefusal(hostileCase, store, root)
    ?? remainingRefusal(hostileCase, store, root);
}

export async function runRefusalCase(hostileCase: RefusalCase): Promise<RefusalCaseResult> {
  if (hostileCase.boundary === "PROJECT_CATALOG_LAYER") {
    return await runProjectCatalogRefusal(
      hostileCase.phase,
      hostileRoot(`${hostileCase.phase.toLowerCase()}-project-catalog`),
    );
  }
  if (hostileCase.boundary === "SAFE_BOUNDARY_LOOKUP_LAYER") {
    const outcome = hostileCase.phase === "BEFORE"
      ? safeBoundaryLookupBefore() : safeBoundaryLookupAfter();
    return {
      ...recordProperties(outcome.refusal),
      durableComplete: outcome.durableComplete,
      durableRecords: outcome.durableRecords,
      refusal: outcome.refusal,
      upstream: outcome.upstream,
    };
  }
  // Delegated whole, exactly as the import-shadow arms are: this boundary seeds a durable
  // provider-run through the real activation ingress and commits through production, so it
  // owns its store rather than borrowing the generic one opened below.
  if (hostileCase.boundary === "SAFE_BOUNDARY_OBSERVATION_LAYER") {
    const outcome = hostileCase.phase === "BEFORE" ? safeBoundaryBefore() : safeBoundaryAfter();
    return {
      ...recordProperties(outcome.refusal),
      durableComplete: outcome.durableComplete,
      durableRecords: outcome.durableRecords,
      refusal: outcome.refusal,
    };
  }
  if (hostileCase.boundary === "IMPORT_SHADOW_READ_LAYER") {
    const root = importShadowRoot(hostileCase.phase.toLowerCase());
    const outcome = hostileCase.phase === "BEFORE"
      ? importShadowClosedStore(root)
      : importShadowMissingRow(root);
    return {
      ...recordProperties(outcome.refusal),
      durableComplete: outcome.durableComplete,
      durableRecords: outcome.durableRecords,
      refusal: outcome.refusal,
    };
  }
  const root = hostileRoot(`${hostileCase.phase.toLowerCase()}-${hostileCase.boundary.toLowerCase()}`);
  const path = join(root, "events.sqlite");
  const store = SqliteEventStore.openForProject(path, "security-project");
  try {
    const outcome = await boundaryRefusal(hostileCase, store, root);
    const reader = store;
    let durableRecords: number;
    let durableComplete: boolean;
    if (hostileCase.boundary === "RECOVERY_ANCHOR_LAYER") {
      const inspected = await inspectRecoveryAnchor(root);
      if (!inspected.ok) throw new Error(`anchor readback refused: ${inspected.code}`);
      durableRecords = inspected.outcome === "ABSENT" ? 0 : 1;
      durableComplete = inspected.outcome === "ABSENT" || inspected.anchor.anchorDigest.length === 64;
    } else if (hostileCase.boundary.includes("RECOVERY_INSTALL")) {
      const bindings = [reader.readRecoveryBinding("ACTIVE"), reader.readRecoveryBinding("PENDING")]
        .filter((entry) => entry.outcome === "FOUND");
      durableRecords = bindings.length;
      durableComplete = bindings.every((entry) => entry.outcome === "FOUND"
        && entry.binding.payload.byteLength > 0 && entry.bindingDigest.length === 64);
    } else {
      const events = reader.readEventsAfter(0n, 100).items;
      durableRecords = events.length;
      durableComplete = events.every((event) => event.eventId.length > 0 && event.payload.byteLength > 0);
    }
    return { ...recordProperties(outcome.refusal), durableComplete, durableRecords, ...outcome };
  } finally {
    store.close();
  }
}

/* ---------------------------------------------------------------------------------------- *
 * task-f8ea0a2f — the durable-store CLOSURE subjects.
 *
 * These three layer constants are LIVE in production and were not covered by the generated
 * durable roster above. They are deliberately kept OUT of `DURABLE_BOUNDARY_NAMES`: that
 * tuple is the ADVERTISED roster task-45839f34 publishes against the committed boundary
 * scan, and bumping it here would announce a coverage claim before the consumer row that
 * owns the announcement has landed. This tuple carries the same subjects with their own
 * generated BEFORE/AFTER/RACE arms, so the arms exist first and the advertisement follows.
 *
 * Every driver below calls the REAL production reader or writer over a REAL file-backed
 * store. Each arm also runs a CONTROL through the same production call with the single
 * hostile input removed: the control must ADMIT. Without it a fail-closed-everything
 * regression — a reader that refused whatever it was handed — would satisfy all nine
 * refusal assertions while proving nothing about which fence answered.
 * ---------------------------------------------------------------------------------------- */

export const DURABLE_STORE_CLOSURE_NAMES = Object.freeze([
  "CUTOVER_ATTEMPT_LAYER",
  "CUTOVER_GENERATION_SNAPSHOT_LAYER",
  "IMPORT_GENERATION_READ_LAYER",
] as const);

export const DURABLE_CLOSURE_PHASES = Object.freeze(["BEFORE", "AFTER", "RACE"] as const);

export type DurableClosureName = (typeof DURABLE_STORE_CLOSURE_NAMES)[number];
export type DurableClosurePhase = (typeof DURABLE_CLOSURE_PHASES)[number];

export interface ClosureCase {
  readonly boundary: DurableClosureName;
  /** Rows the arm must ADD while it runs: 0 for a pure read, 1 for the interleaved writer. */
  readonly durableDelta: number;
  readonly expected: RefusalExpectation;
  /** The horizon moves only where a rival writer really lands inside the call. */
  readonly horizonMoved: boolean;
  /** Rows the subject must already be able to see; 0 only where absence IS the subject. */
  readonly minimumRecords: number;
  readonly phase: DurableClosurePhase;
  readonly question: string;
}

export interface ClosureCaseResult {
  /** The same production call with the one hostile input removed. Must be true. */
  readonly controlAdmitted: boolean;
  readonly durableComplete: boolean;
  readonly durableDelta: number;
  readonly durableRecords: number;
  readonly horizonMoved: boolean;
  readonly refusal: unknown;
  readonly upstream?: Readonly<{ code: string; layer: string }> | undefined;
}

const CLOSURE_PROJECT_ID = "security-closure-project";
const CLOSURE_MOMENT = "2026-09-03T00:00:00.000Z";
const CLOSURE_MANIFEST_HASH = "d1".repeat(32);
const CLOSURE_BACKUP_HASH = "b2".repeat(32);
const closureBytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const CLOSURE_EXPECTATIONS:
Readonly<Record<DurableClosureName, Readonly<Record<DurableClosurePhase, RefusalExpectation>>>> =
Object.freeze({
  // ABSENT and EVIDENCE_UNREADABLE are two different worlds for an operator, and the third
  // is a lost write. One code across the three phases would be green whichever one ran.
  CUTOVER_ATTEMPT_LAYER: Object.freeze({
    AFTER: { code: "CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE", layer: CUTOVER_ATTEMPT_LAYER },
    BEFORE: { code: "CUTOVER_ATTEMPT_STATE_ABSENT", layer: CUTOVER_ATTEMPT_LAYER },
    RACE: { code: "CUTOVER_ATTEMPT_EXPECTED_VERSION_CONFLICT", layer: CUTOVER_ATTEMPT_LAYER },
  }),
  CUTOVER_GENERATION_SNAPSHOT_LAYER: Object.freeze({
    AFTER: {
      code: "CUTOVER_GENERATION_EVIDENCE_UNREADABLE", layer: CUTOVER_GENERATION_SNAPSHOT_LAYER,
    },
    BEFORE: {
      code: "CUTOVER_GENERATION_QUIESCE_RECORD_ABSENT", layer: CUTOVER_GENERATION_SNAPSHOT_LAYER,
    },
    RACE: { code: "CUTOVER_GENERATION_HORIZON_DRIFT", layer: CUTOVER_GENERATION_SNAPSHOT_LAYER },
  }),
  IMPORT_GENERATION_READ_LAYER: Object.freeze({
    AFTER: { code: "IMPORT_GENERATION_RECEIPT_MISMATCH", layer: IMPORT_GENERATION_READ_LAYER },
    BEFORE: { code: "IMPORT_GENERATION_INPUT_INVALID", layer: IMPORT_GENERATION_READ_LAYER },
    RACE: { code: "IMPORT_GENERATION_HORIZON_DRIFT", layer: IMPORT_GENERATION_READ_LAYER },
  }),
});

const CLOSURE_QUESTIONS:
Readonly<Record<DurableClosureName, Readonly<Record<DurableClosurePhase, string>>>> =
Object.freeze({
  CUTOVER_ATTEMPT_LAYER: Object.freeze({
    AFTER: "an undecodable head row is corrupt evidence, not an attempt state",
    BEFORE: "an unwritten cutover attempt is absent rather than empty",
    RACE: "a second approval landing mid-flight cannot be overwritten",
  }),
  CUTOVER_GENERATION_SNAPSHOT_LAYER: Object.freeze({
    AFTER: "a ProjectActivated payload that does not decode is not a defaulted manifest",
    BEFORE: "a missing live-quiesce record names its own fact rather than defaulting",
    RACE: "a snapshot assembled across two horizons names neither of them",
  }),
  IMPORT_GENERATION_READ_LAYER: Object.freeze({
    AFTER: "a receipt that does not bind the durable rows is not this import's generation",
    BEFORE: "a caller-supplied generation is fabricated authority, not a hint",
    RACE: "a generation read across a moving horizon is refused rather than reported",
  }),
});

export const durableClosureCases: readonly ClosureCase[] = Object.freeze(
  DURABLE_STORE_CLOSURE_NAMES.flatMap((boundary) =>
    DURABLE_CLOSURE_PHASES.map((phase) => Object.freeze({
      boundary,
      durableDelta: phase === "RACE" ? 1 : 0,
      expected: CLOSURE_EXPECTATIONS[boundary][phase],
      horizonMoved: phase === "RACE",
      // Absence IS the subject of the cutover-attempt BEFORE arm; every other arm must be
      // reading real durable rows, or it is refusing an empty world by accident.
      minimumRecords: boundary === "CUTOVER_ATTEMPT_LAYER" && phase === "BEFORE" ? 0 : 1,
      phase,
      question: CLOSURE_QUESTIONS[boundary][phase],
    }))),
);

/**
 * A binding whose only varying fact is the principal. Two principals derive two DIFFERENT
 * decision ids, which is what makes the RACE arm a genuine expected-version conflict rather
 * than the store's own same-key replay answering in its place.
 */
function closureBinding(principalId: string): ActivationBinding {
  return Object.freeze({
    authority: Object.freeze({
      gateId: GO_ACTIVATE_GATE_ID,
      grant: Object.freeze({
        gateId: GO_ACTIVATE_GATE_ID,
        grantedAtEpochMs: 1_777_777_777_777,
        principalId,
        principalKind: "HUMAN" as const,
        workRef: GA_ACTIVATION_WORK_REF,
      }),
      workRef: GA_ACTIVATION_WORK_REF,
    }),
    decision: GO_ACTIVATE_GATE_ID,
    generations: Object.freeze({
      backupGenerationDigest: "a".repeat(64),
      distributionManifestSha256: "b".repeat(64),
      importGenerationSha256: "c".repeat(64),
      quiesceRecordSha256: "d".repeat(64),
    }),
    sourceCommit: "e".repeat(40),
  });
}

/** Drives the attempt to IMPORT_VERIFIED through the PRODUCTION reducer and codec. */
function seedCutoverAttempt(store: SqliteEventStore): void {
  const commands: readonly CutoverCommand[] = [
    { attemptId: "attempt-closure", commandId: "closure-preview", expectedVersion: 0,
      kind: "cutover.preview", sourceManifestRef: "manifest-closure",
      witness: { inventoryRef: "inventory-closure", truthClass: "DAEMON_VERIFIED" } },
    { commandId: "closure-quiesce-approval", expectedVersion: 1,
      kind: "cutover.admit_quiesce_approval",
      witness: { approvalRef: "quiesce-approval", truthClass: "HUMAN_APPROVED" } },
    { commandId: "closure-begin-quiesce", expectedVersion: 2, kind: "cutover.begin_quiesce" },
    { commandId: "closure-complete-quiesce", expectedVersion: 3, kind: "cutover.complete_quiesce",
      witness: { identicalManifestRef: "manifest-closure", truthClass: "DAEMON_VERIFIED",
        writeLockRef: "lock-closure" } },
    { commandId: "closure-verify-import", expectedVersion: 4, kind: "cutover.verify_import",
      witness: { importHeadRef: "import-closure", restoreDrillRef: "restore-closure",
        truthClass: "DAEMON_VERIFIED" } },
  ];
  const aggregateId = deriveCutoverAttemptAggregateId(CLOSURE_PROJECT_ID);
  let state: CutoverAttemptState | undefined;
  for (const [index, command] of commands.entries()) {
    const reduced = reduceCutover(state, command);
    if (!reduced.ok) throw new Error(`cutover closure seed refused: ${reduced.error.code}`);
    const payload = encodeCutoverAttemptEvent({ admitted: null, command });
    store.commit({
      aggregateId, commandBytes: payload, commandId: command.commandId,
      committedAt: CLOSURE_MOMENT,
      events: [{ eventId: `closure-seed-${String(index + 1)}`,
        eventType: CUTOVER_ATTEMPT_EVENT_TYPE, payload }],
      expectedVersion: index,
    });
    state = reduced.state;
  }
}

function cutoverAttemptRows(store: SqliteEventStore): readonly { readonly eventId: string;
  readonly payload: Uint8Array }[] {
  return store.readEvents(deriveCutoverAttemptAggregateId(CLOSURE_PROJECT_ID));
}

const rowsComplete = (
  rows: readonly { readonly eventId: string; readonly payload: Uint8Array }[],
): boolean => rows.every((row) => row.eventId.length > 0 && row.payload.byteLength > 0);

/** A genuinely separate handle on the same file, committing one real row through production. */
function commitClosureRival(databasePath: string, label: string): void {
  const writer = SqliteEventStore.openForProject(databasePath, CLOSURE_PROJECT_ID);
  try {
    const committed = writer.commitExpectedVersionDecision({
      commandKind: "SECURITY_CLOSURE_RACE",
      committedResultBytes: closureBytes(`closure-race-${label}`),
      correlationId: `closure-race-${label}`,
      decidedAt: CLOSURE_MOMENT,
      events: [{ eventId: `closure-race-${label}`, eventType: "ClosureRacingWrite",
        payload: closureBytes(`closure-race-${label}`) }],
      expectedVersion: 0,
      key: { commandId: `closure-race-${label}`, principalId: "principal",
        projectId: CLOSURE_PROJECT_ID },
      requestBytes: closureBytes(`closure-race-${label}-request`),
      targetAggregateId: `security-closure-race-${label}`,
    });
    if (committed.disposition !== "DECIDED") {
      throw new Error(`closure racing writer did not commit: ${committed.disposition}`);
    }
  } finally {
    writer.close();
  }
}

function storeCodeUpstream(refusal: unknown): Readonly<{ code: string; layer: string }> | undefined {
  const code = (refusal as { readonly storeCode?: unknown }).storeCode;
  return typeof code === "string" ? Object.freeze({ code, layer: "DURABLE_STORE" }) : undefined;
}

function cutoverAttemptRace(store: SqliteEventStore, databasePath: string): ClosureCaseResult {
  const rival = SqliteEventStore.openForProject(databasePath, CLOSURE_PROJECT_ID);
  const openedHorizon = store.readEventHorizon();
  const openedRows = cutoverAttemptRows(store).length;
  let winnerCommitted = false;
  try {
    // The interleaved approval writer: a REAL production approval for a DIFFERENT binding
    // lands on the same aggregate between the loser's fold and the loser's own commit, so
    // the loser's expected version is stale by exactly one when it reaches the store.
    const racing: CutoverAttemptStore = {
      commitExpectedVersionDecision: (input) => {
        if (!winnerCommitted) {
          const winner = admitCutoverActivateApproval(rival, {
            correlationId: "closure-cutover-race-winner", decidedAt: CLOSURE_MOMENT,
            projectId: CLOSURE_PROJECT_ID, record: closureBinding("human:closure-winner"),
          });
          if (!winner.ok || winner.disposition !== "COMMITTED") {
            throw new Error(`racing approval did not commit: ${JSON.stringify(winner)}`);
          }
          winnerCommitted = true;
        }
        return store.commitExpectedVersionDecision(input);
      },
      getCommandDecision: (key) => store.getCommandDecision(key),
      readEvents: (aggregateId) => store.readEvents(aggregateId),
    };
    const refusal = admitCutoverActivateApproval(racing, {
      correlationId: "closure-cutover-race-loser", decidedAt: CLOSURE_MOMENT,
      projectId: CLOSURE_PROJECT_ID, record: closureBinding("human:closure-loser"),
    });
    const rows = cutoverAttemptRows(store);
    return {
      // The winner's approval is the control: the same production writer ADMITTED over the
      // same durable state, so the loser's refusal is ownership of one version, not a
      // reader that refuses whatever it is handed.
      controlAdmitted: winnerCommitted,
      durableComplete: rowsComplete(rows),
      durableDelta: rows.length - openedRows,
      durableRecords: rows.length,
      horizonMoved: store.readEventHorizon() !== openedHorizon,
      refusal,
      upstream: storeCodeUpstream(refusal),
    };
  } finally {
    rival.close();
  }
}

function cutoverAttemptClosure(phase: DurableClosurePhase): ClosureCaseResult {
  const root = hostileRoot(`closure-cutover-attempt-${phase.toLowerCase()}`);
  const databasePath = join(root, "cutover-attempt.sqlite");
  const store = SqliteEventStore.openForProject(databasePath, CLOSURE_PROJECT_ID);
  try {
    if (phase === "BEFORE") {
      const openedHorizon = store.readEventHorizon();
      const openedRows = cutoverAttemptRows(store).length;
      const refusal = readCutoverAttemptState(store, { projectId: CLOSURE_PROJECT_ID });
      const rows = cutoverAttemptRows(store);
      const settled = {
        durableComplete: rowsComplete(rows),
        durableDelta: rows.length - openedRows,
        durableRecords: rows.length,
        horizonMoved: store.readEventHorizon() !== openedHorizon,
      };
      // The control runs the SAME reader once the durable rows exist. Every later fence in
      // the fold — sequence, aggregate, event type, decode, reducer — therefore admits, so
      // absence is the only thing the arm above can have been answering.
      seedCutoverAttempt(store);
      const control = readCutoverAttemptState(store, { projectId: CLOSURE_PROJECT_ID });
      return { ...settled, controlAdmitted: control.status === "PRESENT", refusal };
    }
    seedCutoverAttempt(store);
    if (phase === "AFTER") {
      // Everything upstream is proven valid FIRST, by the same production reader.
      const control = readCutoverAttemptState(store, { projectId: CLOSURE_PROJECT_ID });
      const tampered = closureBytes("{not-a-cutover-attempt-event");
      store.commit({
        aggregateId: deriveCutoverAttemptAggregateId(CLOSURE_PROJECT_ID),
        commandBytes: tampered, commandId: "closure-tamper", committedAt: CLOSURE_MOMENT,
        events: [{ eventId: "closure-tamper-6", eventType: CUTOVER_ATTEMPT_EVENT_TYPE,
          payload: tampered }],
        expectedVersion: 5,
      });
      const openedHorizon = store.readEventHorizon();
      const openedRows = cutoverAttemptRows(store).length;
      const refusal = readCutoverAttemptState(store, { projectId: CLOSURE_PROJECT_ID });
      const rows = cutoverAttemptRows(store);
      return {
        controlAdmitted: control.status === "PRESENT",
        durableComplete: rowsComplete(rows),
        durableDelta: rows.length - openedRows,
        durableRecords: rows.length,
        horizonMoved: store.readEventHorizon() !== openedHorizon,
        refusal,
      };
    }
    return cutoverAttemptRace(store, databasePath);
  } finally {
    store.close();
  }
}

/**
 * A minimal but SEMANTICALLY VALID live-quiesce evidence record: an EMPTY outcome with a
 * consistent inventory, so `@moe/core` derives a real canonical digest from it. Written
 * pretty-printed exactly as the live lane writes it, which forces the reader to derive the
 * CANONICAL digest rather than hash whatever bytes it happened to find.
 */
const CLOSURE_EVIDENCE = Object.freeze({
  authority: Object.freeze({
    commentId: "comment-closure-generation",
    moment: CLOSURE_MOMENT,
    principal: "operator/live",
  }),
  citationKey: "durable-store-closure",
  citedBy: "task-f8ea0a2f",
  hostFingerprint: "host-closure-1",
  inventory: Object.freeze({
    hostFingerprint: "host-closure-1",
    itemCount: 0,
    items: Object.freeze([]),
    runMode: "LIVE" as const,
    undiscoverableKinds: Object.freeze([]),
  }),
  manifestComparison: Object.freeze({
    comparedEntryCount: 0, differences: Object.freeze([]), matched: true, ok: true as const,
  }),
  outcome: "EMPTY" as const,
  resolvedCount: 0,
  results: Object.freeze([]),
  runMode: "LIVE" as const,
  stoppedAt: Object.freeze([]),
});

type ClosureGenerationStore = CutoverGenerationPorts["store"];

/** Delegates every member to the REAL store; `over` replaces exactly one of them. */
function closureGenerationStore(
  store: SqliteEventStore, over: Partial<ClosureGenerationStore> = {},
): ClosureGenerationStore {
  return {
    enumerateAggregateIdsByPrefix: (prefix) => store.enumerateAggregateIdsByPrefix(prefix),
    getCommandReceipt: (commandId) => store.getCommandReceipt(commandId),
    readAggregateEvents: (aggregateId, cursor, limit) =>
      store.readAggregateEvents(aggregateId, cursor, limit),
    readEventHorizon: () => store.readEventHorizon(),
    readEvents: (aggregateId) => store.readEvents(aggregateId),
    ...over,
  };
}

function closureGenerationPorts(
  store: ClosureGenerationStore, storeRoot: string,
): CutoverGenerationPorts {
  return {
    config: { storeRoot },
    // The zero-invocation fence: the unbounded compatibility member must never be reached.
    readFileText: (path: string): string => {
      throw new Error(`SENTINEL: the unbounded readFileText was invoked for ${path}`);
    },
    store,
  };
}

function commitClosureProjectEvent(
  store: SqliteEventStore, eventId: string, eventType: string, payload: Uint8Array,
): void {
  store.commit({
    aggregateId: CLOSURE_PROJECT_ID, commandBytes: payload, commandId: `cmd-${eventId}`,
    committedAt: CLOSURE_MOMENT, events: [{ eventId, eventType, payload }],
    expectedVersion: store.getAggregateVersion(CLOSURE_PROJECT_ID),
  });
}

/** All four facts, seeded real: activation witness, quiesce witness, committed import, file. */
function seedClosureGenerationFacts(store: SqliteEventStore, evidencePath: string): void {
  commitClosureProjectEvent(store, "closure-project-activated", "ProjectActivated",
    closureBytes(JSON.stringify({ witness: {
      artifactPathRef: "artifact/ref", backupPathRef: "backup/ref", credentialRef: "credential/ref",
      distributionManifestHash: CLOSURE_MANIFEST_HASH, policyRevisionHash: "p3".repeat(32),
      providerMinimumProfileRef: "profile/ref", signingKeyRef: "signing/ref",
      storeDriverRef: "driver/ref", truthClass: "DAEMON_VERIFIED",
    } })));
  commitClosureProjectEvent(store, "closure-project-quiesced", "ProjectQuiesced",
    closureBytes(JSON.stringify({ witness: {
      backupGenerationHash: CLOSURE_BACKUP_HASH, recoveryIncarnationRef: "incarnation/ref",
      truthClass: "DAEMON_VERIFIED",
    } })));
  seedClosureImport(store, CLOSURE_IMPORT_DIGEST, [closureImportRecord()]);
  writeFileSync(evidencePath, `${JSON.stringify(CLOSURE_EVIDENCE, null, 2)}\n`, "utf8");
}

function globalRows(store: SqliteEventStore): readonly { readonly eventId: string;
  readonly payload: Uint8Array }[] {
  return store.readEventsAfter(0n, 500).items;
}

function cutoverGenerationClosure(phase: DurableClosurePhase): ClosureCaseResult {
  const root = hostileRoot(`closure-cutover-generation-${phase.toLowerCase()}`);
  const storeRoot = join(root, "store-root");
  mkdirSync(storeRoot, { recursive: true });
  const databasePath = join(root, "cutover-generation.sqlite");
  const evidencePath = join(storeRoot, LIVE_QUIESCE_EVIDENCE_FILENAME);
  const store = SqliteEventStore.openForProject(databasePath, CLOSURE_PROJECT_ID);
  const read = (over: Partial<ClosureGenerationStore> = {}): unknown =>
    readCutoverGenerationSnapshot(
      closureGenerationPorts(closureGenerationStore(store, over), storeRoot),
      { projectId: CLOSURE_PROJECT_ID },
    );
  try {
    seedClosureGenerationFacts(store, evidencePath);
    if (phase === "BEFORE") {
      // Three of the four facts are durable and readable; the fourth's ARTIFACT is simply
      // not on disk yet. The control below writes it and the SAME reader admits, so no
      // other fact can be what the refusal is naming.
      rmSync(evidencePath, { force: true });
      const openedHorizon = store.readEventHorizon();
      const openedRows = globalRows(store).length;
      const refusal = read();
      const rows = globalRows(store);
      writeFileSync(evidencePath, `${JSON.stringify(CLOSURE_EVIDENCE, null, 2)}\n`, "utf8");
      const control = read();
      return {
        controlAdmitted: (control as { readonly ok: boolean }).ok,
        durableComplete: rowsComplete(rows),
        durableDelta: rows.length - openedRows,
        durableRecords: rows.length,
        horizonMoved: store.readEventHorizon() !== openedHorizon,
        refusal,
        upstream: (refusal as { readonly upstream?: Readonly<{ code: string; layer: string }> })
          .upstream ?? undefined,
      };
    }
    // Everything valid FIRST, proven by the production reader itself.
    const control = read();
    if (phase === "AFTER") {
      // A SECOND durable ProjectActivated whose payload does not decode. `latestPayload`
      // takes the newest, so this is corrupt evidence rather than absence — and the quiesce
      // witness, the committed import and the evidence file all stay valid and readable.
      commitClosureProjectEvent(store, "closure-activated-tampered", "ProjectActivated",
        closureBytes("{not-json"));
      const openedHorizon = store.readEventHorizon();
      const openedRows = globalRows(store).length;
      const refusal = read();
      const rows = globalRows(store);
      return {
        controlAdmitted: (control as { readonly ok: boolean }).ok,
        durableComplete: rowsComplete(rows),
        durableDelta: rows.length - openedRows,
        durableRecords: rows.length,
        horizonMoved: store.readEventHorizon() !== openedHorizon,
        refusal,
      };
    }
    // RACE: a real commit from a SECOND connection lands between the horizon this snapshot
    // opened on and the one it closes on. Every one of the four facts stays valid, so only
    // the snapshot's own two-state fence can answer.
    const openedHorizon = store.readEventHorizon();
    const openedRows = globalRows(store).length;
    let horizonReads = 0;
    const refusal = read({
      readEventHorizon: () => {
        horizonReads += 1;
        if (horizonReads === 2) commitClosureRival(databasePath, "cutover-generation");
        return store.readEventHorizon();
      },
    });
    const rows = globalRows(store);
    return {
      controlAdmitted: (control as { readonly ok: boolean }).ok,
      durableComplete: rowsComplete(rows),
      durableDelta: rows.length - openedRows,
      durableRecords: rows.length,
      horizonMoved: store.readEventHorizon() !== openedHorizon,
      refusal,
    };
  } finally {
    store.close();
  }
}

function importGenerationClosure(phase: DurableClosurePhase): ClosureCaseResult {
  const root = hostileRoot(`closure-import-generation-${phase.toLowerCase()}`);
  const databasePath = join(root, "import-generation.sqlite");
  const store = SqliteEventStore.openForProject(databasePath, CLOSURE_PROJECT_ID);
  try {
    seedClosureImport(store, CLOSURE_IMPORT_DIGEST, [closureImportRecord()]);
    // The control is the SAME production call with the hostile input removed: the committed
    // import really does yield a generation, so every refusal below is the named fence.
    const control = readDurableImportGeneration(closureGenerationStore(store), {});
    const openedHorizon = store.readEventHorizon();
    const openedRows = globalRows(store).length;
    let refusal: unknown;
    if (phase === "BEFORE") {
      // A caller-presented generation. The durable state is intact and would have answered.
      refusal = readDurableImportGeneration(
        closureGenerationStore(store), { importGenerationSha256: "0".repeat(64) },
      );
    } else if (phase === "AFTER") {
      // The real receipt with ONE field detached from the durable rows it claims to bind.
      refusal = readDurableImportGeneration(closureGenerationStore(store, {
        getCommandReceipt: (commandId) => {
          const receipt = store.getCommandReceipt(commandId);
          return receipt === null ? null : { ...receipt, currentVersion: receipt.currentVersion + 1 };
        },
      }), {});
    } else {
      let horizonReads = 0;
      refusal = readDurableImportGeneration(closureGenerationStore(store, {
        readEventHorizon: () => {
          horizonReads += 1;
          if (horizonReads === 2) commitClosureRival(databasePath, "import-generation");
          return store.readEventHorizon();
        },
      }), {});
    }
    const rows = globalRows(store);
    return {
      controlAdmitted: control.ok,
      durableComplete: rowsComplete(rows),
      durableDelta: rows.length - openedRows,
      durableRecords: rows.length,
      horizonMoved: store.readEventHorizon() !== openedHorizon,
      refusal,
    };
  } finally {
    store.close();
  }
}

/** Dispatches one generated closure case to its production driver. */
export function runClosureCase(hostileCase: ClosureCase): ClosureCaseResult {
  if (hostileCase.boundary === "CUTOVER_ATTEMPT_LAYER") {
    return cutoverAttemptClosure(hostileCase.phase);
  }
  if (hostileCase.boundary === "CUTOVER_GENERATION_SNAPSHOT_LAYER") {
    return cutoverGenerationClosure(hostileCase.phase);
  }
  return importGenerationClosure(hostileCase.phase);
}
