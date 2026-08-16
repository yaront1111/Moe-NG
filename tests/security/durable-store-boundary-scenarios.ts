import { join } from "node:path";

import {
  RECOVERY_BINDING_CODEC_VERSION,
  SqliteEventStore,
} from "../../packages/store/src/index.js";
import { recoveryBindingDigest } from "../../packages/store/src/recovery-install-codec.js";

import { compareRangePin } from "../../apps/daemon/src/recovery/doctor-version-contract.js";
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
import { inspectRecoveryAnchor, prepareRecoveryAnchor } from "../../packages/store/src/recovery-anchor.js";
import { decodeRecoveryBinding } from "../../packages/store/src/recovery-install-codec.js";
import { hostileRoot } from "./hostile-harness.js";
import type { RefusalExpectation } from "./hostile-harness.js";

export const DURABLE_BOUNDARY_NAMES = Object.freeze([
  "DOCTOR_VERSION_LAYERS",
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
  }
};

const questions: Readonly<Record<DurableBoundaryName, readonly [string, string]>> = Object.freeze({
  DOCTOR_VERSION_LAYERS: ["unsupported declared range stays unknown", "stale declared range gains no authority"],
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
});

const casesFor = (phase: HostilePhase): readonly RefusalCase[] =>
  Object.freeze(DURABLE_BOUNDARY_NAMES.map((boundary) => ({
    boundary,
    expected: expectations(boundary, phase),
    phase,
    preexistingRecords: phase === "AFTER" && (
      boundary === "RECOVERY_INSTALL_TRANSACTION_LAYER" || boundary === "RECOVERY_ANCHOR_LAYER"
    ) ? 1 : 0,
    question: questions[boundary][phase === "BEFORE" ? 0 : 1],
    ...(boundary === "DURABLE_INVENTORY_ADAPTER_LAYER"
      ? { upstream: { code: "RECOVERY_INVENTORY_INPUT_INVALID", layer: "INVENTORY_ADAPTER" } }
      : boundary === "RECOVERY_INVENTORY_LAYER" || boundary === "RECOVERY_INVENTORY_LEDGER_LAYER"
        || boundary === "RECOVERY_INVENTORY_UPSTREAM_LAYERS"
        ? { upstream: LEDGER_UPSTREAM }
        : {}),
  })));

export const hostileBeforeCases = casesFor("BEFORE");
export const hostileAfterCases = casesFor("AFTER");

export interface RaceCase {
  readonly boundary: DurableBoundaryName;
  readonly expected: RefusalExpectation;
  readonly question: string;
}

export const hostileRaceCases: readonly RaceCase[] = Object.freeze(
  DURABLE_BOUNDARY_NAMES.map((boundary) => ({
    boundary,
    expected: { code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE" },
    question: `two ${boundary} callers cannot both claim one durable version`,
  })),
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
