/**
 * The recovery-window inventory seam, curated rather than blanket re-exported.
 *
 * A consumer holding only these names can compose all four node-side classes:
 * build one registration per class from its own ports, snapshot them into an
 * immutable registry, run a collection, and read the coverage proofs and the
 * refusals back. That is the whole seam — a daemon coordinator needs nothing
 * else from this package to schedule a recovery-window inventory.
 *
 * The four `*Registration` factories are the ONLY runtime values this file adds
 * over the aggregate. The per-class `enumerate*Inventory` readers stay internal
 * on purpose: an adapter returns a port result and `collectRecoveryInventory`
 * decides whether it is one, so a caller that could invoke an enumerator
 * directly would be able to obtain a reading no coverage proof ever saw. The
 * `*_INVENTORY_VERSION` constants stay internal for the same reason — they are
 * how an adapter stamps its own digests, not a fact a consumer branches on.
 *
 * Registration stays caller-injected. There is deliberately no default tuple
 * and no module-global registry here: a global would make IMPORT ORDER confer
 * inventory authority, would race across concurrent collections, and would let
 * any module that merely imports this file change another caller's coverage.
 *
 * The type block below is not scope creep — it is the construction closure of
 * those four factories. `ProviderLockInventoryInput` reaches both provider probe
 * inputs, and those reach their ports and full probe reports, so a consumer that
 * could see the factory but not name its argument could not call it. Four leaves
 * are deliberately ABSENT: `ObservationClock`, `PlatformIdentity`,
 * `RuntimeClosureEntry` and `RuntimePinningMethod` are already rooted by the
 * Claude observation seam, and Codex declares its own structurally identical
 * copies — re-exporting those would collide on the root namespace while adding
 * no capability.
 */
export {
  MAX_RECOVERY_INVENTORY_ITEMS,
  RECOVERY_INVENTORY_CLASSES,
  RECOVERY_INVENTORY_ERROR_CODES,
  RECOVERY_INVENTORY_LAYERS,
  RECOVERY_INVENTORY_REF_KINDS,
  RECOVERY_INVENTORY_TRUTH_CLASSES,
  RECOVERY_INVENTORY_UNKNOWN_REASONS,
  RECOVERY_INVENTORY_VERSION,
  isRecoveryInventoryFailure,
  recoveryInventoryFailure,
  type RecoveryInventoryClass,
  type RecoveryInventoryCoverageProof,
  type RecoveryInventoryEnumerationContext,
  type RecoveryInventoryEnumerator,
  type RecoveryInventoryErrorCode,
  type RecoveryInventoryFactValue,
  type RecoveryInventoryFailure,
  type RecoveryInventoryIdentity,
  type RecoveryInventoryItem,
  type RecoveryInventoryLayer,
  type RecoveryInventoryOpaqueRef,
  type RecoveryInventoryPortReading,
  type RecoveryInventoryRefKind,
  type RecoveryInventoryRegistration,
  type RecoveryInventoryRegistry,
  type RecoveryInventoryReport,
  type RecoveryInventoryResult,
  type RecoveryInventoryTruth,
  type RecoveryInventoryUnknownReason,
  type RecoveryInventoryWindow,
} from "../recovery-inventory/recovery-inventory-contract.js";
export {
  collectRecoveryInventory,
  createRecoveryInventoryRegistry,
} from "../recovery-inventory/recovery-inventory.js";

export {
  providerLockInventoryRegistration,
  type ProviderLockInventoryInput,
  type ProviderLockInventoryPort,
  type ProviderProcessRecord,
} from "../recovery-inventory/provider-lock-inventory.js";
export type { ProbeClaudeRuntimeInput } from "../providers/claude/claude-probe.js";
export type {
  ClaudeCancelObservation,
  ClaudeProbePort,
  ClaudeProbeReport,
  ClaudeProcessTreeObservation,
  ClaudeRunEnumerationObservation,
  ClaudeStructuredSample,
  ClaudeTokenizerObservation,
} from "../providers/claude/claude-capabilities.js";
export type { ProbeCodexRuntimeInput } from "../providers/codex/codex-probe.js";
export type {
  CodexCancelObservation,
  CodexContextLimit,
  CodexCwdObservation,
  CodexProbePort,
  CodexProbeReport,
  CodexProcessTreeObservation,
  CodexRunEnumerationObservation,
  CodexStructuredSample,
  CodexTokenizerObservation,
} from "../providers/codex/codex-capabilities.js";

export {
  workspaceInventoryRegistration,
  type WorkspaceInventoryInput,
  type WorkspaceInventoryListing,
  type WorkspaceInventoryPort,
  type WorkspaceInventoryResultAspect,
  type WorkspaceInventorySource,
} from "../recovery-inventory/workspace-inventory.js";

/**
 * `GitIntegrationInventoryReading` and `ArtifactObjectInventoryReading` are the
 * shapes their direct readers return, published so a consumer can NAME what an
 * adapter answered. Neither reader itself is published: through the registration
 * the aggregate reduces both to UNKNOWN coverage, and that reduction — not the
 * side-channel refusal — is the protocol.
 */
export {
  gitIntegrationInventoryRegistration,
  type GitIntegrationInventoryInput,
  type GitIntegrationInventoryReading,
  type GitIntegrationRefusal,
} from "../recovery-inventory/git-integration-inventory.js";
export {
  artifactObjectInventoryRegistration,
  type ArtifactObjectInventoryInput,
  type ArtifactObjectInventoryReading,
} from "../recovery-inventory/artifact-object-inventory.js";
