import type { ArtifactRef } from "../artifacts/artifact-contract.js";
import type { ObservationClock } from "../providers/claude/claude-observation.js";
import type { ScopeObservation } from "../scope/scope-contract.js";
import type { WorkspaceProducer } from "../workspace/workspace-contract.js";
import type {
  RecoveryInventoryEnumerationContext,
  RecoveryInventoryPortReading,
  RecoveryInventoryRegistration,
} from "./recovery-inventory-contract.js";

export const WORKSPACE_INVENTORY_VERSION = "moe-workspace-inventory/1" as const;

const CLASS = "WORKSPACE" as const;

const UNAVAILABLE: RecoveryInventoryPortReading = Object.freeze({ status: "UNAVAILABLE" as const });

export interface WorkspaceInventoryResultAspect {
  readonly scopeObservation: ScopeObservation;
  readonly authoredPaths: readonly string[];
  readonly declaredArtifactRefs: readonly ArtifactRef[];
}

export interface WorkspaceInventorySource {
  readonly workspaceRef: string;
  readonly baseIdentity: string;
  readonly rootPath: string;
  readonly producer: WorkspaceProducer;
  readonly result: WorkspaceInventoryResultAspect | null;
}

export interface WorkspaceInventoryListing {
  readonly workspaces: readonly WorkspaceInventorySource[];
  readonly listingComplete: boolean;
}

export interface WorkspaceInventoryPort {
  readonly list: () => WorkspaceInventoryListing;
}

export interface WorkspaceInventoryInput {
  readonly port: WorkspaceInventoryPort;
  readonly clock: ObservationClock;
}

export async function enumerateWorkspaceInventory(
  _input: WorkspaceInventoryInput,
  _context: RecoveryInventoryEnumerationContext,
): Promise<RecoveryInventoryPortReading> {
  return Promise.resolve(UNAVAILABLE);
}

export function workspaceInventoryRegistration(
  input: WorkspaceInventoryInput,
): RecoveryInventoryRegistration {
  return Object.freeze({
    class: CLASS,
    enumerate: (context: RecoveryInventoryEnumerationContext) =>
      enumerateWorkspaceInventory(input, context),
  });
}
